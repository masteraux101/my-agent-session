/**
 * sub-agent.js — Explorer Sub-Agent (Subgraph of the main AgentGraph)
 *
 * A self-contained subgraph that handles tasks requiring dynamic code generation
 * or browser automation:
 *   1. Semantic Gap  — no existing tool can fulfill the request
 *   2. Execution Failure — a standard tool crashed, needs code-level fix
 *   3. Complex Reasoning — multi-step logic that can't be pre-defined in tools
 *
 * Two execution paths:
 *
 *   Browser tasks (ReAct loop — see browser-agent.js):
 *     Entry → Planner → BrowserAgentLoop (Observe → Think → Act → Verify)
 *     Uses atomic tools (click_element, input_text, scroll_page, etc.)
 *     instead of generating full Playwright scripts.
 *
 *   Non-browser tasks (code generation):
 *     Entry → Planner → Coder → Executor → Reflector
 *                         ↑                    ↓
 *                         └── retry (< max) ───┘
 *
 * Integration: Exposed as the `explore_task` tool within the parent AgentGraph's
 * ReAct executor. The parent agent's LLM routes to this tool when it detects
 * one of the three trigger conditions above.
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Constants ──────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_EXEC_TIMEOUT = 60_000; // 60 seconds
const MAX_OUTPUT_LEN = 8000;
const TEMP_DIR = os.tmpdir();
const MAX_HTML_CONTEXT_LEN = 6000;
const SCREENSHOT_ARTIFACT_DIR = '/tmp/loop-agent-artifacts';
const BROWSER_STATE_DIR = '/tmp/loop-agent-browser-state';

// Strip trailing punctuation that the \S+ regex may capture from prose.
function cleanExtractedUrl(raw) {
  return raw.replace(/[,;:'".)\]}>]+$/, '');
}

// Resolve project-level node_modules paths so generated scripts can require() them.
// runner.js runs from the repo root (cwd), modules are installed in loop-agent/node_modules.
function resolveNodePath() {
  const dirs = [
    path.join(process.cwd(), 'node_modules'),
    path.join(process.cwd(), 'loop-agent', 'node_modules'),
  ];
  const existing = dirs.filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  const envPath = process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [];
  return [...new Set([...existing, ...envPath])].join(path.delimiter);
}

// ─── Helper: extract text from LLM content ─────────────────────────

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'string' ? part : part.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return String(content);
}

function parseJSON(text) {
  if (!text) return null;
  try {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = jsonMatch ? jsonMatch[1].trim() : text.trim();
    return JSON.parse(raw);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return null;
  }
}

// ─── ExplorerSubAgent Class ─────────────────────────────────────────

class ExplorerSubAgent {
  /**
   * @param {Object} opts
   * @param {Object} opts.llm - LangChain LLM instance (shared with parent agent)
   * @param {Object} opts.repoStore - RepoStore for file I/O (optional)
   * @param {number} opts.maxRetries - Max retry attempts (default: 3)
   * @param {number} opts.executionTimeout - Subprocess timeout in ms (default: 60000)
   */
  constructor({ llm, repoStore = null, maxRetries = DEFAULT_MAX_RETRIES, executionTimeout = DEFAULT_EXEC_TIMEOUT, notifyFn = null }) {
    this.llm = llm;
    this.repoStore = repoStore;
    this.maxRetries = maxRetries;
    this.executionTimeout = executionTimeout;
    this.notifyFn = notifyFn;  // async (msg) => void — sends progress to user
  }

  // ── Browser Diagnostic Helpers ──────────────────────────────────

  /**
   * Detect whether this task likely involves browser/web page interaction.
   */
  _isBrowserTask(plan, task) {
    if (plan.language === 'javascript' && /https?:\/\/\S+/i.test(task)) return true;
    if (/playwright|browser|page\.|navigate|click|selector|dom|scrape|automat/i.test(task)) return true;
    if (/log\s*in|sign\s*in|登录|login/i.test(task) && /https?:\/\/\S+/i.test(task)) return true;
    return false;
  }

  /**
   * Detect whether this task involves login/authentication.
   */
  _isLoginTask(task) {
    return /log\s*in|sign\s*in|auth|登录|login|credential|password|username/i.test(task);
  }

  /**
   * Get the browser state file path (Playwright storageState JSON).
   * State is shared across retry attempts to persist cookies/localStorage.
   */
  _getBrowserStatePath() {
    if (!fs.existsSync(BROWSER_STATE_DIR)) {
      fs.mkdirSync(BROWSER_STATE_DIR, { recursive: true });
    }
    return path.join(BROWSER_STATE_DIR, 'storage-state.json');
  }

  /**
   * Take a verification screenshot using the saved browser state.
   * Opens a fresh browser with the saved cookies/localStorage and navigates
   * to the target URL to independently verify the claimed state.
   * Returns { screenshotPath, html, title } or partial results.
   */
  async _verifyBrowserState(url) {
    const result = { screenshotPath: '', html: '', title: '' };
    let browser;
    try {
      const { chromium } = require('playwright');
      const statePath = this._getBrowserStatePath();
      const hasState = fs.existsSync(statePath);

      browser = await chromium.launch({ headless: true });
      const contextOpts = { viewport: { width: 1280, height: 720 } };
      if (hasState) {
        contextOpts.storageState = statePath;
        console.log(`[Explorer] Verification: loading saved browser state`);
      }
      const context = await browser.newContext(contextOpts);
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

      result.title = await page.title();

      // Extract cleaned HTML
      result.html = await page.evaluate(() => {
        const clone = document.documentElement.cloneNode(true);
        clone.querySelectorAll('script, style, noscript, svg, link[rel=stylesheet]').forEach(el => el.remove());
        return clone.outerHTML;
      });
      if (result.html.length > MAX_HTML_CONTEXT_LEN) {
        result.html = result.html.slice(0, MAX_HTML_CONTEXT_LEN) + '\n... [HTML truncated]';
      }

      // Take verification screenshot
      if (!fs.existsSync(SCREENSHOT_ARTIFACT_DIR)) {
        fs.mkdirSync(SCREENSHOT_ARTIFACT_DIR, { recursive: true });
      }
      const ssPath = path.join(SCREENSHOT_ARTIFACT_DIR, `verify-${Date.now()}.png`);
      await page.screenshot({ path: ssPath, fullPage: false, type: 'png' });
      result.screenshotPath = ssPath;
      console.log(`[Explorer] Verification screenshot: ${ssPath}, title: "${result.title}"`);

      await browser.close();
      browser = null;
    } catch (e) {
      console.warn(`[Explorer] Verification failed: ${e.message}`);
      if (browser) try { await browser.close(); } catch { /* ignore */ }
    }
    return result;
  }

  /**
   * Capture page HTML + screenshot from a URL for diagnostic purposes.
   * Returns { html, screenshotPath } or partial results.
   */
  async _capturePageDiagnostics(url) {
    const result = { html: '', screenshotPath: '' };
    let browser;
    try {
      const { chromium } = require('playwright');
      browser = await chromium.launch({ headless: true });

      // Use saved browser state (cookies/localStorage) if available,
      // so diagnostics see the same page state as the generated script.
      const statePath = this._getBrowserStatePath();
      const contextOpts = { viewport: { width: 1280, height: 720 } };
      if (fs.existsSync(statePath)) {
        contextOpts.storageState = statePath;
        console.log(`[Explorer] Diagnostics: loading saved browser state`);
      }
      const context = await browser.newContext(contextOpts);
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

      // Extract cleaned HTML (remove scripts/styles to save tokens)
      result.html = await page.evaluate(() => {
        const clone = document.documentElement.cloneNode(true);
        clone.querySelectorAll('script, style, noscript, svg, link[rel=stylesheet]').forEach(el => el.remove());
        return clone.outerHTML;
      });
      if (result.html.length > MAX_HTML_CONTEXT_LEN) {
        result.html = result.html.slice(0, MAX_HTML_CONTEXT_LEN) + '\n... [HTML truncated]';
      }
      console.log(`[Explorer] Captured page HTML (${result.html.length} chars)`);

      // Take diagnostic screenshot
      try {
        if (!fs.existsSync(SCREENSHOT_ARTIFACT_DIR)) {
          fs.mkdirSync(SCREENSHOT_ARTIFACT_DIR, { recursive: true });
        }
        const ssPath = path.join(SCREENSHOT_ARTIFACT_DIR, `explorer-diag-${Date.now()}.png`);
        await page.screenshot({ path: ssPath, fullPage: true, type: 'png' });
        result.screenshotPath = ssPath;
        console.log(`[Explorer] Captured diagnostic screenshot: ${ssPath}`);
      } catch (ssErr) {
        console.warn(`[Explorer] Screenshot capture failed: ${ssErr.message}`);
      }

      await browser.close();
      browser = null;
    } catch (e) {
      console.warn(`[Explorer] Page diagnostics failed: ${e.message}`);
      if (browser) try { await browser.close(); } catch { /* ignore */ }
    }
    return result;
  }

  /**
   * Send a screenshot to the AI vision model and get visual feedback.
   * Returns a text description/analysis, or empty string on failure.
   */
  async _analyzeWithVision(screenshotPath, task) {
    try {
      const sharp = require('sharp');
      if (!fs.existsSync(screenshotPath)) return '';

      const metadata = await sharp(screenshotPath).metadata();
      const maxDim = 2048;
      let imageBuffer;
      if (metadata.width > maxDim || metadata.height > maxDim) {
        imageBuffer = await sharp(screenshotPath)
          .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
          .png().toBuffer();
      } else {
        imageBuffer = fs.readFileSync(screenshotPath);
      }
      const base64Data = imageBuffer.toString('base64');

      const provider = process.env.AI_PROVIDER || 'gemini';
      const apiKey = process.env.AI_API_KEY;
      const model = process.env.AI_MODEL || 'gemini-2.0-flash';

      const prompt = `You are a web automation debugging assistant. A Playwright script failed on this page.

Task the script was trying to do: ${task.slice(0, 500)}

Analyze this screenshot and provide:
1. What the page actually looks like (layout, key elements, modals/popups blocking content)
2. What selectors or interaction targets would be correct for the task
3. Any obstacles visible (cookie banners, login walls, CAPTCHAs, loading spinners)
4. Specific actionable advice for the code to succeed

Be concise and focus on what's relevant to the failed task.`;

      console.log(`[Explorer] Sending diagnostic screenshot to vision model...`);
      let responseText = '';

      if (provider === 'gemini') {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [
                { text: prompt },
                { inline_data: { mime_type: 'image/png', data: base64Data } },
              ]}],
            }),
          }
        );
        if (resp.ok) {
          const data = await resp.json();
          responseText = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
        }
      } else {
        const baseURLMap = {
          qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          kimi: 'https://api.moonshot.cn/v1',
        };
        const baseURL = baseURLMap[provider] || baseURLMap.qwen;
        const visionModel = provider === 'qwen' ? 'qwen-vl-max' : model;
        const resp = await fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: visionModel,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Data}` } },
              ],
            }],
          }),
        });
        if (resp.ok) {
          const data = await resp.json();
          responseText = data.choices?.[0]?.message?.content || '';
        }
      }

      if (responseText) {
        console.log(`[Explorer] Vision analysis: ${responseText.length} chars`);
      }
      return responseText;
    } catch (e) {
      console.warn(`[Explorer] Vision analysis failed: ${e.message}`);
      return '';
    }
  }

  /**
   * Main entry point — run the explorer subgraph.
   *
   * @param {string} task - Task description
   * @param {Object} context - Additional context
   * @param {string} context.errorLog - Previous error log (if triggered by failure)
   * @param {string} context.pageDescription - Description of a web page (if available)
   * @param {string} context.userHints - Additional hints from the user
   * @param {string[]} context.availableTools - Names of tools already tried
   * @returns {Object} { success, type, result, output?, errorHistory?, duration }
   */
  async run(task, context = {}) {
    const startTime = Date.now();
    console.log(`\n[Explorer] ═══ Starting exploration ═══`);
    console.log(`[Explorer] Task: ${task.slice(0, 200)}`);

    // ── Node A: Planner ──
    const plan = await this._plan(task, context);
    console.log(`[Explorer] Plan: ${plan.approach} (${plan.language || 'n/a'})`);

    if (plan.approach === 'tool_suggestion') {
      console.log(`[Explorer] → Routing to existing tools: ${plan.suggestion}`);
      await this._notify(`🔍 Explorer: Routing to existing tool — ${plan.suggestion.slice(0, 200)}`);
      return {
        success: true,
        type: 'suggestion',
        result: plan.suggestion,
        duration: Date.now() - startTime,
      };
    }

    // ── Route: Browser tasks use ReAct loop, others use Coder→Executor ──
    const isBrowser = this._isBrowserTask(plan, task);
    const isLogin = this._isLoginTask(task);

    if (isBrowser && plan.language === 'javascript') {
      // ── ReAct Browser Agent path ──
      // Instead of generating a full Playwright script, drive the browser
      // step-by-step with atomic actions in an Observe→Think→Act→Verify loop.
      console.log(`[Explorer] Browser task detected → delegating to ReAct BrowserAgentLoop`);
      if (isLogin) console.log(`[Explorer] Login task detected`);

      try {
        const { BrowserAgentLoop } = require('./browser-agent');
        const browserAgent = new BrowserAgentLoop({
          llm: this.llm,
          maxSteps: 25,
          notifyFn: this.notifyFn,
          sendPhotoFn: context._sendPhotoFn || null,
        });

        const browserResult = await browserAgent.run(task, context);

        if (browserResult.success) {
          console.log(`[Explorer] ✓ Browser agent completed (${browserResult.duration}ms, ${browserResult.actionHistory?.length || 0} steps)`);
          return {
            success: true,
            type: 'execution',
            result: browserResult.result,
            output: browserResult.actionHistory
              ? browserResult.actionHistory.map(h => `Step ${h.step}: ${h.description}`).join('\n')
              : '',
            screenshotPath: browserResult.screenshotPath,
            duration: browserResult.duration,
          };
        }

        // Browser agent failed — report back
        console.log(`[Explorer] ✗ Browser agent failed: ${browserResult.type}`);
        await this._notify(`❌ Browser agent failed (${browserResult.type}): ${(browserResult.result || '').slice(0, 300)}`);
        return {
          success: false,
          type: browserResult.type === 'max_steps' ? 'max_retries' : 'human_needed',
          result: browserResult.result,
          errorHistory: browserResult.actionHistory || [],
          duration: browserResult.duration,
        };
      } catch (e) {
        console.error(`[Explorer] BrowserAgentLoop error: ${e.message}`);
        // Fall through to code-generation path as last resort
        console.log(`[Explorer] Falling back to code-generation path`);
      }
    }

    // ── Code-generation path (non-browser tasks, or browser fallback) ──
    let retries = 0;
    const errorHistory = [];
    if (isBrowser) {
      console.log(`[Explorer] Browser task (fallback code-gen path)`);
      const statePath = this._getBrowserStatePath();
      context._browserStatePath = statePath;
    }

    while (retries < this.maxRetries) {
      const attempt = retries + 1;
      console.log(`[Explorer] ── Attempt ${attempt}/${this.maxRetries} ──`);

      // Node B: Coder — generate code
      const codeResult = await this._generateCode(plan, task, errorHistory, context);
      console.log(`[Explorer] Generated ${codeResult.language} code (${codeResult.code.length} chars)`);

      // Node C: Executor — run code in subprocess
      const execResult = await this._executeCode(codeResult);
      console.log(`[Explorer] Execution: exit=${execResult.exitCode}, stdout=${execResult.stdout.length}c, stderr=${execResult.stderr.length}c`);

      // ── Browser diagnostics on failure ──
      let screenshotDesc = '';
      let pageHtml = '';
      if (!execResult.success && isBrowser) {
        const urlMatch = task.match(/https?:\/\/\S+/i);
        if (urlMatch) {
          const diagUrl = cleanExtractedUrl(urlMatch[0]);
          try {
            console.log(`[Explorer] Running browser diagnostics for ${diagUrl}...`);
            const diag = await this._capturePageDiagnostics(diagUrl);
            pageHtml = diag.html || '';
            if (diag.screenshotPath) {
              screenshotDesc = await this._analyzeWithVision(diag.screenshotPath, task);
            }
          } catch (diagErr) {
            console.warn(`[Explorer] Browser diagnostics error: ${diagErr.message}`);
          }
          if (pageHtml) context._pageHtml = pageHtml;
          if (screenshotDesc) context._visionAdvice = screenshotDesc;
        }
      }

      // ── Post-execution verification for browser success claims ──
      let verificationOverride = null;
      if (execResult.success && isBrowser) {
        const urlMatch = task.match(/https?:\/\/\S+/i);
        if (urlMatch) {
          const verifyUrl = cleanExtractedUrl(urlMatch[0]);
          try {
            console.log(`[Explorer] Running post-execution verification for ${verifyUrl}...`);
            const verify = await this._verifyBrowserState(verifyUrl);
            if (verify.screenshotPath) {
              const verifyAnalysis = await this._analyzeWithVision(verify.screenshotPath,
                `Verify whether this task was ACTUALLY completed successfully: ${task.slice(0, 300)}\n` +
                `The script CLAIMED success. Look at the screenshot and determine:\n` +
                `1. Does the page show the expected post-task state?\n` +
                `2. For login tasks: Is the user actually logged in (dashboard/profile visible, not login form)?\n` +
                `3. Are there any error messages, login forms still showing, or CAPTCHA challenges?`
              );
              if (verifyAnalysis) {
                console.log(`[Explorer] Verification analysis: ${verifyAnalysis.slice(0, 200)}`);
                const failIndicators = /not\s*(actually\s*)?log(ged)?\s*in|login\s*(form|page)\s*(still|is)\s*(show|vis|display)|fail|unsuccess|error|captcha|not\s*complet/i;
                if (failIndicators.test(verifyAnalysis)) {
                  console.log(`[Explorer] ⚠ Verification FAILED — overriding success claim`);
                  verificationOverride = {
                    status: 'recoverable',
                    diagnosis: `Post-execution verification failed. The script claimed success but independent verification shows: ${verifyAnalysis.slice(0, 500)}`,
                    suggestion: 'The previous code falsely claimed success. Fix the script to properly complete the task and verify the result before claiming success.',
                    summary: `Verification failed: ${verifyAnalysis.slice(0, 200)}`,
                  };
                  context._visionAdvice = verifyAnalysis;
                  if (verify.html) context._pageHtml = verify.html;
                }
              }
            }
          } catch (verifyErr) {
            console.warn(`[Explorer] Verification error: ${verifyErr.message}`);
          }
        }
      }

      // Node D: Reflector — diagnose result
      const reflection = verificationOverride || await this._reflect(task, codeResult, execResult, screenshotDesc, pageHtml, isBrowser, isLogin);
      console.log(`[Explorer] Reflection: ${reflection.status} — ${reflection.diagnosis.slice(0, 100)}`);

      if (reflection.status === 'success') {
        console.log(`[Explorer] ✓ Completed (${Date.now() - startTime}ms)`);
        await this._notify(`✅ Explorer completed (attempt ${attempt}, ${Date.now() - startTime}ms): ${reflection.summary.slice(0, 300)}`);
        return {
          success: true,
          type: 'execution',
          result: reflection.summary,
          output: execResult.stdout,
          duration: Date.now() - startTime,
        };
      }

      if (reflection.status === 'unrecoverable') {
        console.log(`[Explorer] ✗ Unrecoverable — human intervention needed`);
        await this._notify(`❌ Explorer failed (unrecoverable): ${reflection.diagnosis.slice(0, 300)}`);
        return {
          success: false,
          type: 'human_needed',
          result: reflection.summary,
          diagnosis: reflection.diagnosis,
          errorHistory,
          duration: Date.now() - startTime,
        };
      }

      // Recoverable — record error and retry
      errorHistory.push({
        attempt,
        language: codeResult.language,
        code: codeResult.code.slice(0, 2000),
        error: (execResult.stderr || execResult.stdout).slice(0, 1000),
        diagnosis: reflection.diagnosis,
        suggestion: reflection.suggestion,
        visionAdvice: screenshotDesc ? screenshotDesc.slice(0, 500) : '',
        pageHtmlSnippet: pageHtml ? pageHtml.slice(0, 500) : '',
        verificationFailed: !!verificationOverride,
      });
      retries++;
      console.log(`[Explorer] Recoverable error, will retry... (${reflection.diagnosis.slice(0, 80)})`);
    }

    // Max retries exceeded
    const lastErr = errorHistory[errorHistory.length - 1];
    console.log(`[Explorer] ✗ Max retries (${this.maxRetries}) exceeded`);
    await this._notify(`❌ Explorer: Max retries (${this.maxRetries}) exceeded.\nLast error: ${lastErr?.diagnosis?.slice(0, 200) || 'unknown'}`);
    return {
      success: false,
      type: 'max_retries',
      result: [
        `Exploration failed after ${this.maxRetries} attempts.`,
        `Last diagnosis: ${lastErr?.diagnosis || 'unknown'}`,
        `Suggestion: Please provide more specific instructions or break the task into smaller steps.`,
      ].join('\n'),
      errorHistory,
      duration: Date.now() - startTime,
    };
  }

  /** Send a progress notification to the user (if notifyFn provided) */
  async _notify(msg) {
    if (this.notifyFn) {
      try { await this.notifyFn(msg); } catch { /* best effort */ }
    }
  }

  // ── Node A: Planner ─────────────────────────────────────────────

  async _plan(task, context) {
    const { SystemMessage, HumanMessage } = require('@langchain/core/messages');

    const systemPrompt = `You are a task planner for an AI agent running in GitHub Actions (Ubuntu, Node.js 20, Playwright pre-installed, Python 3 available).

Analyze the task and decide the best approach:

1. "tool_suggestion" — The task CAN be solved by the parent agent's built-in tools.
   Only use this if you are HIGHLY confident. Built-in tools include:
   fetch_url, web_search, run_js, run_shell, read_repo_file, write_repo_file,
   screenshot_page, save_memory, read_memory.

   CRITICAL: run_js is a BARE sandboxed VM with only console.log and a result variable.
   It has NO access to Playwright, no "page" object, no "browser" object, no require().
   NEVER suggest Playwright-style code (e.g. "async ({ page }) => ...") for run_js.
   For ANY browser automation task, ALWAYS choose "code_generation" instead.

2. "code_generation" — The task needs a custom, self-contained script. Choose language:
   - "javascript": Web automation (Playwright), complex API orchestration, DOM manipulation
   - "python": Data processing, scraping with BeautifulSoup/lxml, scientific computing
   - "shell": System operations, batch file processing, package management

If error history is provided, this is a RETRY — do NOT repeat the same failing approach.

Respond with ONLY valid JSON (no markdown fences):
{
  "approach": "tool_suggestion" | "code_generation",
  "language": "javascript" | "python" | "shell",
  "reasoning": "brief explanation",
  "steps": ["step 1", "step 2"],
  "suggestion": "which tool to use and how (only for tool_suggestion)"
}`;

    let userPrompt = `Task: ${task}`;
    if (context.errorLog) {
      userPrompt += `\n\nPrevious error (this task is triggered by a tool failure):\n${context.errorLog.slice(0, 2000)}`;
    }
    if (context.pageDescription) {
      userPrompt += `\n\nPage description:\n${context.pageDescription.slice(0, 1000)}`;
    }
    if (context.userHints) {
      userPrompt += `\n\nUser hints:\n${context.userHints}`;
    }
    if (context.availableTools?.length) {
      userPrompt += `\n\nTools already tried: ${context.availableTools.join(', ')}`;
    }

    const result = await this.llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    return parseJSON(extractText(result.content)) || {
      approach: 'code_generation',
      language: 'javascript',
      reasoning: 'Defaulting to code generation (failed to parse planner output)',
      steps: ['Generate and execute code for the task'],
    };
  }

  // ── Node B: Coder ───────────────────────────────────────────────

  async _generateCode(plan, task, errorHistory, context) {
    const { SystemMessage, HumanMessage } = require('@langchain/core/messages');

    const language = plan.language || 'javascript';
    const langGuide = {
      javascript: `Write a Node.js (CommonJS) script.
Key patterns:
- const { chromium } = require('playwright');
- const browser = await chromium.launch({ headless: true });
- Wrap the entire logic in an async IIFE: (async () => { ... })().catch(e => { ... });
- Use try/catch everywhere with detailed console.error() messages.
- Print results with console.log().
- For HTTP requests use the built-in fetch() (Node 20 has native fetch).

BROWSER STATE PERSISTENCE (CRITICAL for multi-step browser tasks):
- At the START of browser scripts, check for and load existing browser state:
    const statePath = '${BROWSER_STATE_DIR}/storage-state.json';
    const fs = require('fs');
    const contextOpts = { viewport: { width: 1280, height: 720 } };
    if (fs.existsSync(statePath)) {
      contextOpts.storageState = statePath;
      console.log('Loaded saved browser state');
    }
    const context = await browser.newContext(contextOpts);
    const page = await context.newPage();
- At the END of browser scripts (before closing), ALWAYS save browser state:
    const fs = require('fs');
    if (!fs.existsSync('${BROWSER_STATE_DIR}')) fs.mkdirSync('${BROWSER_STATE_DIR}', { recursive: true });
    await context.storageState({ path: '${BROWSER_STATE_DIR}/storage-state.json' });
    console.log('Browser state saved');

LOGIN/AUTH VERIFICATION (CRITICAL — do NOT skip):
- After performing login, you MUST verify success BEFORE printing [EXPLORER_SUCCESS]:
    1. Wait for navigation after form submission (waitForNavigation or waitForURL)
    2. Check the post-login page URL (should NOT still be /login or /signin)
    3. Check the page title or look for user-specific elements (username, avatar, dashboard)
    4. Print concrete evidence: "Post-login URL: ...", "Page title: ...", "Found user element: ..."
- If verification fails, print [EXPLORER_FAILURE] with details about what the page actually shows.
- NEVER print [EXPLORER_SUCCESS] for a login task without post-login verification.`,

      python: `Write a Python 3 script.
Key patterns:
- Install dependencies inline: import subprocess; subprocess.check_call(['pip', 'install', '-q', 'package'])
- Use try/except everywhere with detailed traceback printing.
- Print results with print().
- For HTTP requests use urllib.request (built-in) or install requests.`,

      shell: `Write a Bash script.
Key patterns:
- Start with: set -euo pipefail
- Install packages with: apt-get update && apt-get install -y package (or pip install)
- Use informative echo statements.
- Use curl for HTTP requests.`,
    };

    const systemPrompt = `You are an expert code generator for an AI agent in GitHub Actions.
Environment: Ubuntu, Node.js 20, Python 3, full internet access.
Container: mcr.microsoft.com/playwright:v1.50.0-noble (Playwright browsers pre-installed).

PRE-INSTALLED npm packages (available via require(), DO NOT reinstall):
  playwright, sharp, pushoo, telegraf, zod,
  @langchain/core, @langchain/langgraph, @langchain/google-genai, @langchain/openai

Generate a SELF-CONTAINED ${language} script that:
1. Uses require() for pre-installed packages (DO NOT use import/ESM syntax — scripts run as CommonJS)
2. Only installs dependencies via inline npm install if they are NOT in the pre-installed list above
3. Implements the task with comprehensive error handling
4. Prints structured output to stdout
5. Prints "[EXPLORER_SUCCESS]" as the LAST line if the task completed successfully
6. Prints "[EXPLORER_FAILURE]: <reason>" as the LAST line if the task failed
7. When taking screenshots, ALWAYS log the path in this exact format: console.log('Screenshot saved to: /path/to/file.png')

${langGuide[language] || langGuide.javascript}

CRITICAL RULES:
- The script must be completely self-contained — zero external config files
- For JavaScript: ALWAYS use require() (CommonJS), NEVER use import/ESM syntax
- For pre-installed packages: just require() them directly, no npm install needed
- Include timeouts for all network operations (30s max per request)
- Limit output to essential information (avoid dumping entire HTML pages)
- Handle edge cases: empty results, network errors, missing DOM elements
- For web pages: handle cookie banners, popups, lazy loading gracefully
- NEVER hardcode credentials — read from environment variables if needed

Respond with ONLY valid JSON (no markdown fences):
{
  "language": "${language}",
  "code": "the complete script code as a single string",
  "dependencies": ["list", "of", "external", "packages"],
  "description": "one-line summary of what this script does"
}`;

    let userPrompt = `Task: ${task}\n\nExecution plan:\n${JSON.stringify(plan.steps || [], null, 2)}`;

    if (errorHistory.length > 0) {
      userPrompt += `\n\n⚠ Previous failed attempts — DO NOT repeat these mistakes:`;
      for (const err of errorHistory.slice(-2)) {
        userPrompt += `\n--- Attempt ${err.attempt} (${err.language}) ---`;
        userPrompt += `\nError: ${err.error}`;
        userPrompt += `\nDiagnosis: ${err.diagnosis}`;
        userPrompt += `\nSuggested fix: ${err.suggestion}`;
        if (err.visionAdvice) {
          userPrompt += `\nVision analysis of the page: ${err.visionAdvice}`;
        }
        if (err.verificationFailed) {
          userPrompt += `\n⚠ IMPORTANT: This attempt CLAIMED success but FAILED post-execution verification. The [EXPLORER_SUCCESS] was false. You MUST properly verify the outcome before claiming success.`;
        }
      }
    }

    if (context.pageDescription) {
      userPrompt += `\n\nPage context:\n${context.pageDescription.slice(0, 1000)}`;
    }

    // Provide actual page HTML so the Coder can pick correct selectors
    if (context._pageHtml) {
      userPrompt += `\n\n📄 Actual page HTML (cleaned, truncated):\n${context._pageHtml.slice(0, MAX_HTML_CONTEXT_LEN)}`;
    }

    // Provide vision model advice from diagnostic screenshot
    if (context._visionAdvice) {
      userPrompt += `\n\n👁 Vision model advice from page screenshot:\n${context._visionAdvice.slice(0, 2000)}`;
    }

    // Tell the Coder about browser state persistence path
    if (context._browserStatePath) {
      userPrompt += `\n\n🔑 Browser state file: ${context._browserStatePath}`;
      userPrompt += `\nYou MUST load this state at start (if exists) and save it before closing the browser.`;
      userPrompt += `\nThis preserves cookies and localStorage across retry attempts.`;
    }

    const result = await this.llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    const parsed = parseJSON(extractText(result.content));
    if (parsed && parsed.code) {
      return {
        language: parsed.language || language,
        code: parsed.code,
        dependencies: parsed.dependencies || [],
        description: parsed.description || '',
      };
    }

    // Fallback: try to extract code from raw response
    const text = extractText(result.content);
    const codeMatch = text.match(/```(?:javascript|python|bash|sh|js)?\s*\n([\s\S]*?)```/);
    return {
      language,
      code: codeMatch ? codeMatch[1] : text,
      dependencies: [],
      description: 'Extracted from raw LLM response',
    };
  }

  // ── Node C: Executor ────────────────────────────────────────────

  async _executeCode(codeResult) {
    const { language, code } = codeResult;
    const ext = { javascript: '.js', python: '.py', shell: '.sh' }[language] || '.js';

    // Use a project-local temp directory so Node.js module resolution can
    // walk up the directory tree and find loop-agent/node_modules.
    const localTmpDir = path.join(process.cwd(), '.explorer-tmp');
    try { fs.mkdirSync(localTmpDir, { recursive: true }); } catch { /* exists */ }
    const tmpFile = path.join(localTmpDir, `explorer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);

    let finalCode = code;
    if (language === 'shell' && !code.startsWith('#!')) {
      finalCode = '#!/bin/bash\nset -euo pipefail\n' + code;
    }

    try {
      fs.writeFileSync(tmpFile, finalCode, 'utf-8');

      const commands = {
        javascript: `node "${tmpFile}"`,
        python: `python3 "${tmpFile}"`,
        shell: `bash "${tmpFile}"`,
      };
      const cmd = commands[language] || commands.javascript;

      // Set NODE_PATH so require() can find modules installed in loop-agent/
      const nodePath = resolveNodePath();
      console.log(`[Explorer] NODE_PATH=${nodePath}`);

      const output = execSync(cmd, {
        encoding: 'utf-8',
        timeout: this.executionTimeout,
        maxBuffer: 2 * 1024 * 1024, // 2MB
        cwd: process.cwd(),
        shell: '/bin/bash',
        env: { ...process.env, LANG: 'en_US.UTF-8', NODE_PATH: nodePath },
      });

      const stdout = (output || '').trim().slice(0, MAX_OUTPUT_LEN);
      return {
        exitCode: 0,
        stdout,
        stderr: '',
        success: stdout.includes('[EXPLORER_SUCCESS]'),
      };
    } catch (e) {
      const stderr = (e.stderr ? e.stderr.toString() : '').trim().slice(0, MAX_OUTPUT_LEN);
      const stdout = (e.stdout ? e.stdout.toString() : '').trim().slice(0, MAX_OUTPUT_LEN);
      return {
        exitCode: e.status || 1,
        stdout,
        stderr: stderr || e.message,
        success: false,
      };
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  // ── Node D: Reflector / Diagnoser ───────────────────────────────

  async _reflect(task, codeResult, execResult, screenshotDesc = '', pageHtml = '', isBrowser = false, isLogin = false) {
    const { SystemMessage, HumanMessage } = require('@langchain/core/messages');

    let systemPrompt = `You are a diagnostic agent analyzing code execution results.

Classify the execution into one of three categories:

1. "success" — The task completed and produced meaningful output.
   Indicators: exit code 0, "[EXPLORER_SUCCESS]" in stdout, relevant data present.

2. "recoverable" — The code failed but CAN be fixed by modifying the code:
   - ModuleNotFoundError / Cannot find module / ERR_MODULE_NOT_FOUND:
     * The module IS already installed in the project's node_modules (playwright, sharp, langchain, etc.).
     * NODE_PATH is set so require() WILL find them. This error usually means:
       (a) Wrong package name (e.g. 'playwright-core' vs 'playwright') — fix the import name
       (b) Typo in import — fix the typo
       (c) For ESM (import syntax): use require() instead (CommonJS) since scripts run with node in CJS mode
       (d) Sub-dependency not listed — add an inline npm install for that specific package
     * DO NOT suggest re-installing packages that are ALREADY installed (playwright, sharp, etc.)
     * Provide the EXACT corrected require/import statement in the suggestion.
   - Selector not found / ElementNotFound → use a different selector
   - Timeout → increase timeout or try different approach
   - SyntaxError → fix code syntax
   - Connection refused / ECONNRESET → add retry logic or different URL
   - Empty results → try different parsing strategy
   - Permission denied on LOCAL file → fix file path

3. "unrecoverable" — The code failed and CANNOT be auto-fixed:
   - CAPTCHA or anti-bot detection requiring human interaction
   - Rate limiting (HTTP 429) with long backoff
   - Resource genuinely does not exist (confirmed 404)
   - Paywall or subscription-only content
   - The exact same error persisting across 3+ different approaches

IMPORTANT: For "Cannot find module" errors, ALWAYS check if the module is one of the
pre-installed packages (playwright, sharp, pushoo, telegraf, zod, @langchain/core,
@langchain/langgraph, @langchain/google-genai, @langchain/openai).
If it is, the fix is to correct the import syntax, NOT to install the package.`;

    // Stricter criteria for browser tasks
    if (isBrowser) {
      systemPrompt += `

BROWSER TASK VALIDATION (STRICT):
- Do NOT blindly trust "[EXPLORER_SUCCESS]" markers in stdout.
- A script printing "[EXPLORER_SUCCESS]" does NOT mean the browser task actually succeeded.
- Look for CONCRETE EVIDENCE of success in stdout:
  * Specific page titles indicating post-action state (e.g. "Dashboard", "Welcome", "Account")
  * Extracted content that could only exist after the action succeeded
  * Saved browser state/cookies confirming the session
- If the stdout only contains generic messages like "Login successful" without concrete evidence,
  classify as "recoverable" and suggest the code should verify the actual page state.`;
    }

    if (isLogin) {
      systemPrompt += `

LOGIN TASK VALIDATION (EXTRA STRICT):
- Login tasks are HIGH-RISK for false success. Be VERY skeptical.
- A login is ONLY successful if:
  * The code explicitly verified the post-login page (e.g. checked for dashboard URL, username display)
  * The stdout shows the page title/URL changed to a logged-in state
  * Browser storage state was saved with authentication cookies
- If the code just filled in credentials and clicked submit WITHOUT verification, mark as "recoverable".
  Suggest: "The code must verify login success by checking the post-login page state (URL, page title,
  or presence of user-specific elements) before claiming success."
- Login requiring user credentials the agent doesn't have → "unrecoverable"`;
    }

    systemPrompt += `

Respond with ONLY valid JSON (no markdown fences):
{
  "status": "success" | "recoverable" | "unrecoverable",
  "diagnosis": "concise description of what happened and why",
  "suggestion": "specific fix recommendation (for recoverable only)",
  "summary": "human-readable summary of the result or error"
}`;

    let userPrompt = [
      `Task: ${task}`,
      ``,
      `Code (${codeResult.language}): ${codeResult.description}`,
      '```',
      codeResult.code.slice(0, 3000),
      '```',
      ``,
      `Exit code: ${execResult.exitCode}`,
      ``,
      `Stdout (${execResult.stdout.length} chars):`,
      execResult.stdout.slice(0, 3000),
      ``,
      `Stderr (${execResult.stderr.length} chars):`,
      execResult.stderr.slice(0, 2000),
    ].join('\n');

    if (screenshotDesc) {
      userPrompt += `\n\nDiagnostic screenshot analysis (from vision model):\n${screenshotDesc.slice(0, 1500)}`;
    }

    if (pageHtml) {
      userPrompt += `\n\nActual page HTML (cleaned, truncated):\n${pageHtml.slice(0, 3000)}`;
    }

    const result = await this.llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    const parsed = parseJSON(extractText(result.content));
    if (parsed && parsed.status) return parsed;

    // Fallback heuristic when LLM output can't be parsed
    // For browser/login tasks, do NOT auto-accept [EXPLORER_SUCCESS] — require LLM judgment
    if (!isBrowser && execResult.exitCode === 0 && execResult.stdout.includes('[EXPLORER_SUCCESS]')) {
      return {
        status: 'success',
        diagnosis: 'Execution completed with success marker',
        suggestion: '',
        summary: execResult.stdout.replace('[EXPLORER_SUCCESS]', '').trim().slice(0, 500),
      };
    }

    return {
      status: 'recoverable',
      diagnosis: `Exit code ${execResult.exitCode}: ${(execResult.stderr || execResult.stdout).slice(0, 200)}`,
      suggestion: 'Review error output and try a different approach',
      summary: `Execution failed with exit code ${execResult.exitCode}`,
    };
  }
}

// ─── Tool Factory ───────────────────────────────────────────────────

/**
 * Create the `explore_task` LangChain tool that wraps the ExplorerSubAgent.
 * Called from runner.js's createBuiltinTools().
 *
 * @param {Object} llm - LangChain LLM instance
 * @param {Object} repoStore - RepoStore instance (optional)
 * @returns {Object} LangChain tool
 */
function createExplorerTool(llm, repoStore, notifyFn, sendPhotoFn) {
  const { tool } = require('@langchain/core/tools');
  const { z } = require('zod');

  const explorer = new ExplorerSubAgent({ llm, repoStore, notifyFn });

  return tool(async ({ task, error_context, page_description, user_hints }) => {
    try {
      const context = {};
      if (error_context) context.errorLog = error_context;
      if (page_description) context.pageDescription = page_description;
      if (user_hints) context.userHints = user_hints;
      // Pass sendPhotoFn so BrowserAgentLoop can send screenshots to user
      if (sendPhotoFn) context._sendPhotoFn = sendPhotoFn;

      const result = await explorer.run(task, context);

      if (result.success) {
        if (result.type === 'suggestion') {
          return `[Explorer — Tool Suggestion]\n${result.result}`;
        }

        // After a successful task, send screenshots to user via Telegram.
        // BrowserAgentLoop returns screenshotPath directly; code-gen path
        // embeds paths in stdout text.
        const output = result.output || '';
        if (sendPhotoFn) {
          const allPaths = new Set();

          // Direct screenshotPath from BrowserAgentLoop
          if (result.screenshotPath && fs.existsSync(result.screenshotPath)) {
            allPaths.add(result.screenshotPath);
          }

          // Scan output for screenshot paths (code-gen path)
          const screenshotPaths = output.match(/(?:screenshot|image|photo|capture)\S*\s*(?:saved to|at|path)[:：]?\s*(\S+\.png)/gi) || [];
          const pathMatches = output.match(/\/\S+\.png/g) || [];
          for (const m of screenshotPaths) {
            const p = m.match(/(\S+\.png)/);
            if (p) allPaths.add(p[1]);
          }
          for (const p of pathMatches) allPaths.add(p);

          for (const imgPath of allPaths) {
            if (fs.existsSync(imgPath)) {
              console.log(`[Explorer] Sending screenshot to user: ${imgPath}`);
              try {
                const urlMatch = task.match(/https?:\/\/\S+/i);
                const domain = urlMatch ? cleanExtractedUrl(urlMatch[0]).replace(/^https?:\/\//, '').split('/')[0] : 'browser';
                await sendPhotoFn(imgPath, `📸 <b>${domain}</b> (via Explorer)`);
                console.log(`[Explorer] ✓ Screenshot sent to user`);
              } catch (photoErr) {
                console.warn(`[Explorer] Failed to send screenshot: ${photoErr.message}`);
              }
            }
          }
        }

        return [
          `[Explorer — Success] (${result.duration}ms)`,
          result.result,
          '',
          result.output ? `Output:\n${result.output.slice(0, 4000)}` : '',
        ].filter(Boolean).join('\n');
      }

      // Failure — format for the parent agent to relay to user
      const lines = [
        `[Explorer — Failed: ${result.type}] (${result.duration}ms)`,
        result.result,
      ];
      if (result.diagnosis) {
        lines.push(`\nDiagnosis: ${result.diagnosis}`);
      }
      if (result.errorHistory?.length) {
        lines.push(`\nAttempts made: ${result.errorHistory.length}`);
        const last = result.errorHistory[result.errorHistory.length - 1];
        lines.push(`Last error: ${last.error?.slice(0, 300)}`);
      }
      lines.push('\nPlease ask the user for clarification or additional information to proceed.');
      return lines.join('\n');
    } catch (e) {
      return `[Explorer — Internal Error] ${e.message}\nThe exploration sub-agent encountered an unexpected error. Please try a different approach or ask the user for help.`;
    }
  }, {
    name: 'explore_task',
    description: `Launch the Explorer sub-agent for complex tasks.

For BROWSER tasks (web automation, login, scraping SPAs) it uses a ReAct loop:
Observe page state (accessibility tree + annotated screenshot) → Think (LLM decides next step) → Act (atomic action: click, type, scroll, etc.) → Verify → repeat.

For NON-BROWSER tasks (data processing, shell ops) it generates and executes code in a sandbox with up to 3 retry attempts.

USE THIS TOOL WHEN:
1. SEMANTIC GAP — No existing tool can fully handle the task (e.g. "fill in a form and submit", "scrape a dynamically-rendered SPA").
2. TOOL FAILURE — A previous tool call failed with SelectorNotFoundError/TimeoutError. Pass the error in error_context.
3. COMPLEX REASONING — Multi-step cross-page interaction, conditional logic, or dynamic data processing.

DO NOT USE THIS TOOL FOR:
- Simple URL fetching (use fetch_url)
- Basic web searches (use web_search)
- Simple shell commands (use run_shell)
- Simple JS evaluation (use run_js)`,
    schema: z.object({
      task: z.string().describe('Detailed description of the exploration task. Include specific URLs, data to extract, actions to perform, and expected output format.'),
      error_context: z.string().optional().describe('Error log from a previously failed tool call. Provide this when the exploration is triggered by a tool failure.'),
      page_description: z.string().optional().describe('Description or AI vision summary of the target web page, if available from a prior screenshot.'),
      user_hints: z.string().optional().describe('Additional constraints or hints from the user about how to approach the task.'),
    }),
  });
}

// ─── Exports ────────────────────────────────────────────────────────

module.exports = { ExplorerSubAgent, createExplorerTool };

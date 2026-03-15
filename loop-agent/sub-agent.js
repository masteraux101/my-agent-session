/**
 * sub-agent.js — Explorer Sub-Agent (Code Generation & Execution)
 *
 * Handles tasks that require dynamic code generation and execution:
 *   1. Semantic Gap  — no existing tool can fulfill the request
 *   2. Execution Failure — a standard tool crashed, needs a code-level fix
 *   3. Complex Reasoning — multi-step logic that can't be pre-defined
 *
 * Execution flow (non-browser only):
 *   Entry → Planner → Coder → Executor → Reflector
 *                       ↑                    ↓
 *                       └── retry (< max) ───┘
 *
 * Browser tasks are handled by browser-agent.js (ReAct loop).
 * This file delegates browser tasks to BrowserAgentLoop automatically.
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Constants ──────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_EXEC_TIMEOUT = 60_000;
const MAX_OUTPUT_LEN = 8000;

// Resolve project-level node_modules so generated scripts can require() them.
function resolveNodePath() {
  const dirs = [
    path.join(process.cwd(), 'node_modules'),
    path.join(process.cwd(), 'loop-agent', 'node_modules'),
  ];
  const existing = dirs.filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  const envPath = process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [];
  return [...new Set([...existing, ...envPath])].join(path.delimiter);
}

// ─── Helpers ────────────────────────────────────────────────────────

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => (typeof p === 'string' ? p : p.text || '')).filter(Boolean).join('\n');
  }
  return String(content);
}

function parseJSON(text) {
  if (!text) return null;
  try {
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    return JSON.parse(m ? m[1].trim() : text.trim());
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
    return null;
  }
}

// ─── ExplorerSubAgent ───────────────────────────────────────────────

class ExplorerSubAgent {
  /**
   * @param {Object} opts
   * @param {Object} opts.llm             — LangChain LLM instance
   * @param {Object} opts.repoStore       — RepoStore for file I/O (optional)
   * @param {number} opts.maxRetries      — Max retry attempts (default: 3)
   * @param {number} opts.executionTimeout — Subprocess timeout in ms
   * @param {Function} opts.notifyFn      — Progress notification callback
   * @param {Function} opts.sendPhotoFn   — Screenshot delivery callback
   */
  constructor({ llm, repoStore = null, maxRetries = DEFAULT_MAX_RETRIES, executionTimeout = DEFAULT_EXEC_TIMEOUT, notifyFn = null, sendPhotoFn = null }) {
    this.llm = llm;
    this.repoStore = repoStore;
    this.maxRetries = maxRetries;
    this.executionTimeout = executionTimeout;
    this.notifyFn = notifyFn;
    this.sendPhotoFn = sendPhotoFn;
  }

  /** Detect browser/web tasks that should be routed to BrowserAgentLoop. */
  _isBrowserTask(plan, task) {
    if (plan.language === 'javascript' && /https?:\/\/\S+/i.test(task)) return true;
    if (/playwright|browser|page\.|navigate|click|selector|dom|scrape|automat/i.test(task)) return true;
    if (/log\s*in|sign\s*in|登录|login/i.test(task) && /https?:\/\/\S+/i.test(task)) return true;
    return false;
  }

  /**
   * Main entry point.
   * Routes browser tasks to BrowserAgentLoop, everything else to code-gen path.
   */
  async run(task, context = {}) {
    const startTime = Date.now();
    console.log(`\n[Explorer] ═══ Starting exploration ═══`);
    console.log(`[Explorer] Task: ${task.slice(0, 200)}`);

    // ── Planner ──
    const plan = await this._plan(task, context);
    console.log(`[Explorer] Plan: ${plan.approach} (${plan.language || 'n/a'})`);

    if (plan.approach === 'tool_suggestion') {
      console.log(`[Explorer] → Routing to existing tool: ${plan.suggestion}`);
      await this._notify(`🔍 Explorer: Routing to existing tool — ${plan.suggestion.slice(0, 200)}`);
      return { success: true, type: 'suggestion', result: plan.suggestion, duration: Date.now() - startTime };
    }

    // ── Browser tasks → delegate to BrowserAgentLoop ──
    if (this._isBrowserTask(plan, task)) {
      console.log('[Explorer] Browser task detected → delegating to BrowserAgentLoop');
      try {
        const { BrowserAgentLoop } = require('./browser-agent');
        const browserAgent = new BrowserAgentLoop({
          llm: this.llm,
          maxSteps: 30,
          notifyFn: this.notifyFn,
          sendPhotoFn: this.sendPhotoFn || context._sendPhotoFn || null,
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
        console.error(`[Explorer] BrowserAgentLoop failed: ${e.message}`);
        // fall through to code-gen path as last resort
        console.log('[Explorer] Falling back to code-generation path');
      }
    }

    // ── Code-generation path (non-browser tasks or browser fallback) ──
    let retries = 0;
    const errorHistory = [];

    while (retries < this.maxRetries) {
      const attempt = retries + 1;
      console.log(`[Explorer] ── Attempt ${attempt}/${this.maxRetries} ──`);

      const codeResult = await this._generateCode(plan, task, errorHistory, context);
      console.log(`[Explorer] Generated ${codeResult.language} code (${codeResult.code.length} chars)`);

      const execResult = await this._executeCode(codeResult);
      console.log(`[Explorer] Execution: exit=${execResult.exitCode}, stdout=${execResult.stdout.length}c, stderr=${execResult.stderr.length}c`);

      const reflection = await this._reflect(task, codeResult, execResult);
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
        console.log('[Explorer] ✗ Unrecoverable — human intervention needed');
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

      // Recoverable — record and retry
      errorHistory.push({
        attempt,
        language: codeResult.language,
        code: codeResult.code.slice(0, 2000),
        error: (execResult.stderr || execResult.stdout).slice(0, 1000),
        diagnosis: reflection.diagnosis,
        suggestion: reflection.suggestion,
      });
      retries++;
      console.log(`[Explorer] Recoverable error, retrying... (${reflection.diagnosis.slice(0, 80)})`);
    }

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

  async _notify(msg) {
    if (this.notifyFn) { try { await this.notifyFn(msg); } catch { /* best effort */ } }
  }

  // ── Planner ───────────────────────────────────────────────────

  async _plan(task, context) {
    const { SystemMessage, HumanMessage } = require('@langchain/core/messages');

    const systemPrompt = `You are a task planner for an AI agent running in GitHub Actions (Ubuntu, Node.js 20, Playwright pre-installed, Python 3 available).

Analyze the task and decide the best approach:

1. "tool_suggestion" — The task CAN be solved by the parent agent's built-in tools.
   Only use this if you are HIGHLY confident. Built-in tools include:
   fetch_url, web_search, run_js, run_shell, read_repo_file, write_repo_file,
   screenshot_page, save_memory, read_memory, browser_task.

   CRITICAL: run_js is a BARE sandboxed VM with only console.log and a result variable.
   It has NO access to Playwright, no "page" object, no require().
   For ANY browser automation, suggest "browser_task" tool or choose "code_generation".

2. "code_generation" — The task needs a custom, self-contained script. Choose language:
   - "javascript": API orchestration, data processing, file operations
   - "python": Data processing, scraping with BeautifulSoup, scientific computing
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
    if (context.errorLog) userPrompt += `\n\nPrevious error:\n${context.errorLog.slice(0, 2000)}`;
    if (context.pageDescription) userPrompt += `\n\nPage description:\n${context.pageDescription.slice(0, 1000)}`;
    if (context.userHints) userPrompt += `\n\nUser hints:\n${context.userHints}`;
    if (context.availableTools?.length) userPrompt += `\n\nTools already tried: ${context.availableTools.join(', ')}`;

    const result = await this.llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    return parseJSON(extractText(result.content)) || {
      approach: 'code_generation',
      language: 'javascript',
      reasoning: 'Default to code generation (failed to parse planner output)',
      steps: ['Generate and execute code for the task'],
    };
  }

  // ── Coder ─────────────────────────────────────────────────────

  async _generateCode(plan, task, errorHistory, context) {
    const { SystemMessage, HumanMessage } = require('@langchain/core/messages');

    const language = plan.language || 'javascript';
    const langGuide = {
      javascript: `Write a Node.js (CommonJS) script.
- Use require() (NOT import/ESM).
- Use try/catch with detailed console.error() messages.
- For HTTP requests use native fetch() (Node 20).
- Print results with console.log().
- Print "[EXPLORER_SUCCESS]" as the LAST line on success.
- Print "[EXPLORER_FAILURE]: <reason>" as the LAST line on failure.`,

      python: `Write a Python 3 script.
- Install deps inline: import subprocess; subprocess.check_call(['pip', 'install', '-q', 'package'])
- Use try/except with traceback printing.
- Print "[EXPLORER_SUCCESS]" or "[EXPLORER_FAILURE]: <reason>" as last line.`,

      shell: `Write a Bash script.
- Start with: set -euo pipefail
- Use informative echo statements.
- Print "[EXPLORER_SUCCESS]" or "[EXPLORER_FAILURE]: <reason>" as last line.`,
    };

    const systemPrompt = `You are an expert code generator for an AI agent in GitHub Actions.
Environment: Ubuntu, Node.js 20, Python 3, full internet access.
Container: mcr.microsoft.com/playwright:v1.50.0-noble

PRE-INSTALLED npm packages (use require() directly, do NOT reinstall):
  playwright, sharp, pushoo, telegraf, zod,
  @langchain/core, @langchain/langgraph, @langchain/google-genai, @langchain/openai

Generate a SELF-CONTAINED ${language} script:
${langGuide[language] || langGuide.javascript}

CRITICAL RULES:
- Script must be completely self-contained
- For JavaScript: ALWAYS use require() (CommonJS), NEVER use import/ESM
- Include timeouts for all network operations (30s max)
- Handle edge cases: empty results, network errors, missing elements
- NEVER hardcode credentials — read from environment variables

Respond with ONLY valid JSON:
{
  "language": "${language}",
  "code": "the complete script",
  "dependencies": ["external", "packages"],
  "description": "one-line summary"
}`;

    let userPrompt = `Task: ${task}\n\nPlan:\n${JSON.stringify(plan.steps || [], null, 2)}`;

    if (errorHistory.length > 0) {
      userPrompt += '\n\n⚠ Previous failed attempts — DO NOT repeat:';
      for (const err of errorHistory.slice(-2)) {
        userPrompt += `\n--- Attempt ${err.attempt} (${err.language}) ---`;
        userPrompt += `\nError: ${err.error}`;
        userPrompt += `\nDiagnosis: ${err.diagnosis}`;
        userPrompt += `\nSuggested fix: ${err.suggestion}`;
      }
    }

    if (context.pageDescription) userPrompt += `\n\nPage context:\n${context.pageDescription.slice(0, 1000)}`;

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

    // Fallback: extract code block
    const text = extractText(result.content);
    const codeMatch = text.match(/```(?:javascript|python|bash|sh|js)?\s*\n([\s\S]*?)```/);
    return { language, code: codeMatch ? codeMatch[1] : text, dependencies: [], description: 'Extracted from raw LLM response' };
  }

  // ── Executor ──────────────────────────────────────────────────

  async _executeCode(codeResult) {
    const { language, code } = codeResult;
    const ext = { javascript: '.js', python: '.py', shell: '.sh' }[language] || '.js';

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
      const nodePath = resolveNodePath();

      const output = execSync(cmd, {
        encoding: 'utf-8',
        timeout: this.executionTimeout,
        maxBuffer: 2 * 1024 * 1024,
        cwd: process.cwd(),
        shell: '/bin/bash',
        env: { ...process.env, LANG: 'en_US.UTF-8', NODE_PATH: nodePath },
      });

      const stdout = (output || '').trim().slice(0, MAX_OUTPUT_LEN);
      return { exitCode: 0, stdout, stderr: '', success: stdout.includes('[EXPLORER_SUCCESS]') };
    } catch (e) {
      const stderr = (e.stderr ? e.stderr.toString() : '').trim().slice(0, MAX_OUTPUT_LEN);
      const stdout = (e.stdout ? e.stdout.toString() : '').trim().slice(0, MAX_OUTPUT_LEN);
      return { exitCode: e.status || 1, stdout, stderr: stderr || e.message, success: false };
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  // ── Reflector ─────────────────────────────────────────────────

  async _reflect(task, codeResult, execResult) {
    const { SystemMessage, HumanMessage } = require('@langchain/core/messages');

    const systemPrompt = `You are a diagnostic agent analyzing code execution results.

Classify execution into one of three categories:

1. "success" — Task completed, meaningful output. Indicators: exit code 0, "[EXPLORER_SUCCESS]" in stdout.

2. "recoverable" — Code failed but CAN be fixed:
   - ModuleNotFoundError: fix import name or add inline install
   - Timeout: increase timeout or different approach
   - SyntaxError: fix code
   - Empty results: different parsing strategy
   Pre-installed packages (DO NOT suggest reinstalling): playwright, sharp, pushoo, telegraf, zod, @langchain/*

3. "unrecoverable" — Cannot be auto-fixed:
   - CAPTCHA / anti-bot detection
   - Rate limiting (429) with long backoff
   - Resource genuinely 404
   - Same error persisting across 3+ different approaches

Respond with ONLY valid JSON:
{
  "status": "success" | "recoverable" | "unrecoverable",
  "diagnosis": "what happened and why",
  "suggestion": "specific fix (for recoverable)",
  "summary": "human-readable summary"
}`;

    const userPrompt = [
      `Task: ${task}`,
      `Code (${codeResult.language}): ${codeResult.description}`,
      '```', codeResult.code.slice(0, 3000), '```',
      `Exit code: ${execResult.exitCode}`,
      `Stdout: ${execResult.stdout.slice(0, 3000)}`,
      `Stderr: ${execResult.stderr.slice(0, 2000)}`,
    ].join('\n');

    const result = await this.llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    const parsed = parseJSON(extractText(result.content));
    if (parsed && parsed.status) return parsed;

    // Fallback heuristic
    if (execResult.exitCode === 0 && execResult.stdout.includes('[EXPLORER_SUCCESS]')) {
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
 */
function createExplorerTool(llm, repoStore, notifyFn, sendPhotoFn) {
  const { tool } = require('@langchain/core/tools');
  const { z } = require('zod');

  const explorer = new ExplorerSubAgent({ llm, repoStore, notifyFn, sendPhotoFn });

  return tool(async ({ task, error_context, page_description, user_hints }) => {
    try {
      const context = {};
      if (error_context) context.errorLog = error_context;
      if (page_description) context.pageDescription = page_description;
      if (user_hints) context.userHints = user_hints;
      if (sendPhotoFn) context._sendPhotoFn = sendPhotoFn;

      const result = await explorer.run(task, context);

      if (result.success) {
        if (result.type === 'suggestion') {
          return `[Explorer — Tool Suggestion]\n${result.result}`;
        }

        // Send screenshots from output
        const output = result.output || '';
        if (sendPhotoFn) {
          const allPaths = new Set();
          if (result.screenshotPath && fs.existsSync(result.screenshotPath)) allPaths.add(result.screenshotPath);
          const pathMatches = output.match(/\/\S+\.png/g) || [];
          for (const p of pathMatches) allPaths.add(p);

          for (const imgPath of allPaths) {
            if (fs.existsSync(imgPath)) {
              try { await sendPhotoFn(imgPath, `📸 Explorer result`); } catch { /* best effort */ }
            }
          }
        }

        return [
          `[Explorer — Success] (${result.duration}ms)`,
          result.result,
          result.output ? `\nOutput:\n${result.output.slice(0, 4000)}` : '',
        ].filter(Boolean).join('\n');
      }

      const lines = [
        `[Explorer — Failed: ${result.type}] (${result.duration}ms)`,
        result.result,
      ];
      if (result.diagnosis) lines.push(`\nDiagnosis: ${result.diagnosis}`);
      if (result.errorHistory?.length) {
        lines.push(`\nAttempts: ${result.errorHistory.length}`);
        const last = result.errorHistory[result.errorHistory.length - 1];
        lines.push(`Last error: ${last.error?.slice(0, 300)}`);
      }
      lines.push('\nPlease ask the user for clarification or try a different approach.');
      return lines.join('\n');
    } catch (e) {
      return `[Explorer — Internal Error] ${e.message}`;
    }
  }, {
    name: 'explore_task',
    description: `Launch the Explorer sub-agent for complex non-browser tasks.

Generates and executes code in a sandbox with up to 3 retry attempts.
For data processing, API orchestration, shell operations, file manipulation, etc.

Browser tasks are automatically delegated to the ReAct Browser Agent internally.

USE THIS TOOL WHEN:
1. SEMANTIC GAP — No existing tool can handle the task
2. TOOL FAILURE — A previous tool call failed. Pass error in error_context.
3. COMPLEX REASONING — Multi-step logic, data transformation, API chaining

DO NOT USE FOR:
- Simple URL fetching (use fetch_url)
- Basic search (use web_search)
- Simple shell commands (use run_shell)
- Browser automation (prefer browser_task for direct browser control)`,
    schema: z.object({
      task: z.string().describe('Detailed task description. Include specific URLs, data formats, actions to perform, and expected output.'),
      error_context: z.string().optional().describe('Error log from a previously failed tool call.'),
      page_description: z.string().optional().describe('Description of target web page, if available.'),
      user_hints: z.string().optional().describe('Additional constraints or hints from the user.'),
    }),
  });
}

// ─── Exports ────────────────────────────────────────────────────────

module.exports = { ExplorerSubAgent, createExplorerTool };

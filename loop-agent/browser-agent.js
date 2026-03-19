/**
 * browser-agent.js — Self-contained ReAct Browser Automation Agent
 *
 * Implements the full "Observe → Think → Act → Verify" cycle per instructions.md.
 * This is the ONLY file responsible for browser automation in loop-agent.
 *
 * Modules:
 *   A. BrowserManager  — Playwright lifecycle & session persistence (storageState)
 *   B. ElementParser    — Accessibility Tree extraction + Set-of-Mark annotations
 *   C. ActionExecutor   — Atomic browser operations with auto-wait & error pass-back
 *   D. VisionAnalyzer   — Screenshot analysis via multimodal LLM
 *   E. BrowserAgentLoop — ReAct coordination loop
 *   F. createBrowserTool — LangChain tool factory for runner.js integration
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Constants ──────────────────────────────────────────────────────

const BROWSER_STATE_DIR = '/tmp/loop-agent-browser-state';
const SCREENSHOT_DIR = '/tmp/loop-agent-artifacts';
const MAX_STEPS = 30;
const ACTION_TIMEOUT = 15_000;
const NAV_TIMEOUT = 30_000;
const MAX_A11Y_DEPTH = 5;
const MAX_MARKS = 80;
const MAX_VISION_DIM = 2048;

function cleanUrl(raw) {
  return raw.replace(/[,;:'".)\]}>]+$/, '');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => (typeof p === 'string' ? p : p.text || '')).filter(Boolean).join('\n');
  }
  return String(content);
}

// ═══════════════════════════════════════════════════════════════════
// Module A: BrowserManager
// ═══════════════════════════════════════════════════════════════════

class BrowserManager {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this._statePath = path.join(BROWSER_STATE_DIR, 'storage-state.json');
  }

  /** Launch Playwright browser with optional saved storageState. */
  async launch() {
    const { chromium } = require('playwright');
    this.browser = await chromium.launch({ headless: true });

    const opts = { viewport: { width: 1280, height: 720 } };
    if (fs.existsSync(this._statePath)) {
      opts.storageState = this._statePath;
      console.log('[BrowserManager] Restored saved session state');
    }

    this.context = await this.browser.newContext(opts);
    this.page = await this.context.newPage();
    return this.page;
  }

  async navigate(url) {
    await this.page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
  }

  /** Persist cookies + localStorage to disk for GHA session continuity. */
  async saveState() {
    try {
      ensureDir(BROWSER_STATE_DIR);
      await this.context.storageState({ path: this._statePath });
      console.log('[BrowserManager] Session state saved');
    } catch (e) {
      console.warn(`[BrowserManager] Save state failed: ${e.message}`);
    }
  }

  async close() {
    try { await this.saveState(); } catch { /* best effort */ }
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
    }
  }

  getPage() { return this.page; }
}

// ═══════════════════════════════════════════════════════════════════
// Module B: ElementParser
// ═══════════════════════════════════════════════════════════════════

class ElementParser {

  /**
   * Extract simplified Accessibility Tree from the page.
   * Each node gets a unique mm_id. Only essential attributes kept.
   */
  async getAccessibilityTree(page) {
    const snapshot = await page.accessibility.snapshot();
    if (!snapshot) return { tree: null, flat: [] };

    let nextId = 1;
    const flat = [];

    function cleanNode(node, depth) {
      if (!node || depth > MAX_A11Y_DEPTH) return null;
      const cleaned = { mm_id: nextId++, role: node.role, name: (node.name || '').trim() };
      if (node.description) cleaned.description = node.description;
      if (node.value !== undefined && node.value !== '') cleaned.value = node.value;
      if (node.focused) cleaned.focused = true;
      if (node.checked !== undefined) cleaned.checked = node.checked;
      if (node.disabled) cleaned.disabled = true;
      if (node.selected) cleaned.selected = true;
      flat.push(cleaned);
      if (node.children && node.children.length > 0) {
        cleaned.children = node.children.map(c => cleanNode(c, depth + 1)).filter(Boolean);
      }
      return cleaned;
    }

    const tree = cleanNode(snapshot, 0);
    return { tree, flat };
  }

  /**
   * Inject Set-of-Mark visual anchors: numbered labels on interactive elements
   * within the current viewport. Returns mark descriptors for the LLM.
   */
  async injectSetOfMarks(page) {
    return await page.evaluate((maxMarks) => {
      // Remove previous marks
      document.querySelectorAll('[data-som-mark]').forEach(el => el.remove());

      const selectors = [
        'a[href]', 'button', 'input', 'textarea', 'select',
        '[role="button"]', '[role="link"]', '[role="tab"]',
        '[role="menuitem"]', '[role="checkbox"]', '[role="radio"]',
        '[role="switch"]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
      ];

      const seen = new Set();
      const candidates = [];
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (seen.has(el)) continue;
          seen.add(el);
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.bottom < -100 || rect.top > window.innerHeight + 100) continue;
          candidates.push({ el, rect });
        }
      }

      const elements = candidates.slice(0, maxMarks);
      const marks = [];

      elements.forEach(({ el, rect }, idx) => {
        const markId = idx + 1;

        // Floating label
        const label = document.createElement('div');
        label.setAttribute('data-som-mark', String(markId));
        label.style.cssText = [
          'position:fixed',
          `left:${Math.max(0, rect.left - 2)}px`,
          `top:${Math.max(0, rect.top - 18)}px`,
          'background:#ff0000', 'color:#fff',
          'font-size:11px', 'font-weight:bold',
          'padding:1px 4px', 'border-radius:3px',
          'z-index:999999', 'pointer-events:none',
          'line-height:14px', 'font-family:monospace',
        ].join(';');
        label.textContent = String(markId);
        document.body.appendChild(label);

        // Build CSS selector
        let selector = '';
        if (el.id) {
          selector = '#' + CSS.escape(el.id);
        } else {
          const tag = el.tagName.toLowerCase();
          const type = el.getAttribute('type') || '';
          const name = el.getAttribute('name') || '';
          const aria = el.getAttribute('aria-label') || '';
          selector = tag;
          if (type) selector += `[type="${type}"]`;
          if (name) selector += `[name="${name}"]`;
          if (aria) selector += `[aria-label="${aria}"]`;
        }

        marks.push({
          markId,
          selector,
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 50),
          type: el.getAttribute('type') || '',
          name: el.getAttribute('name') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          placeholder: el.getAttribute('placeholder') || '',
          href: (el.getAttribute('href') || '').slice(0, 120),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y),
                  w: Math.round(rect.width), h: Math.round(rect.height) },
        });
      });

      return marks;
    }, MAX_MARKS);
  }

  async removeSetOfMarks(page) {
    await page.evaluate(() => {
      document.querySelectorAll('[data-som-mark]').forEach(el => el.remove());
    });
  }

  /** Take a viewport screenshot. */
  async takeScreenshot(page, label) {
    ensureDir(SCREENSHOT_DIR);
    const ssPath = path.join(SCREENSHOT_DIR, `som-${label || Date.now()}.png`);
    await page.screenshot({ path: ssPath, fullPage: false, type: 'png' });
    return ssPath;
  }

  /**
   * Full page snapshot: a11y tree + SoM marks + annotated screenshot.
   * Marks removed after screenshot capture.
   */
  async getPageSnapshot(page) {
    const [{ tree, flat }, marks] = await Promise.all([
      this.getAccessibilityTree(page),
      this.injectSetOfMarks(page),
    ]);
    const screenshotPath = await this.takeScreenshot(page, `step-${Date.now()}`);
    await this.removeSetOfMarks(page);

    return {
      url: page.url(),
      title: await page.title(),
      accessibilityTree: tree,
      flatElements: flat,
      interactiveMarks: marks,
      screenshotPath,
    };
  }

  /** Format snapshot into concise text for LLM context (viewport-only). */
  formatSnapshotForLLM(snapshot) {
    const lines = [];
    lines.push(`URL: ${snapshot.url}`);
    lines.push(`Title: ${snapshot.title}`);
    lines.push('');

    if (snapshot.interactiveMarks.length > 0) {
      lines.push('Interactive Elements (mark_id | tag | info):');
      for (const m of snapshot.interactiveMarks) {
        const parts = [];
        if (m.text) parts.push(`"${m.text}"`);
        if (m.type) parts.push(`type=${m.type}`);
        if (m.name) parts.push(`name=${m.name}`);
        if (m.placeholder) parts.push(`placeholder="${m.placeholder}"`);
        if (m.ariaLabel) parts.push(`aria="${m.ariaLabel}"`);
        if (m.href) parts.push(`href=${m.href.slice(0, 60)}`);
        lines.push(`  [${m.markId}] <${m.tag}> ${parts.join(' | ')}`);
      }
    } else {
      lines.push('(No interactive elements found in viewport)');
    }

    lines.push('');
    lines.push('Accessibility Tree (viewport):');
    const printTree = (node, depth) => {
      if (!node || depth > 3) return;
      const indent = '  '.repeat(depth);
      const nameStr = node.name ? ` "${node.name.slice(0, 40)}"` : '';
      const extras = [];
      if (node.value) extras.push(`val="${node.value}"`);
      if (node.focused) extras.push('FOCUSED');
      if (node.checked !== undefined) extras.push(`checked=${node.checked}`);
      lines.push(`${indent}[${node.mm_id}] ${node.role}${nameStr}${extras.length ? ' (' + extras.join(', ') + ')' : ''}`);
      if (node.children) node.children.forEach(c => printTree(c, depth + 1));
    };
    if (snapshot.accessibilityTree) printTree(snapshot.accessibilityTree, 0);

    return lines.join('\n');
  }
}

// ═══════════════════════════════════════════════════════════════════
// Module C: ActionExecutor
// ═══════════════════════════════════════════════════════════════════

class ActionExecutor {

  /**
   * Execute a single atomic browser action.
   * On failure, returns structured error for LLM feedback (§4 error pass-back).
   */
  async execute(page, action, marks) {
    const { type, params } = action;
    try {
      switch (type) {
        case 'click_element':       return await this._click(page, params, marks);
        case 'input_text':          return await this._input(page, params, marks);
        case 'scroll_page':         return await this._scroll(page, params);
        case 'wait_for_navigation': return await this._waitNav(page, params);
        case 'get_page_source':     return await this._source(page, params);
        case 'navigate':            return await this._navigate(page, params);
        case 'press_key':           return await this._pressKey(page, params);
        case 'select_option':       return await this._select(page, params, marks);
        case 'hover_element':       return await this._hover(page, params, marks);
        case 'done':  return { success: true,  description: `Task completed: ${params.reason || 'done'}`, done: true };
        case 'fail':  return { success: false, description: `Task failed: ${params.reason || 'unknown'}`, done: true, failed: true };
        default:      return { success: false, description: `Unknown action: ${type}`, error: `Unknown action "${type}". Available: click_element, input_text, scroll_page, wait_for_navigation, navigate, press_key, select_option, hover_element, get_page_source, done, fail` };
      }
    } catch (e) {
      // §4: Error pass-back — feed raw Playwright error to LLM on next step
      return { success: false, description: `Action ${type} threw: ${e.message}`, error: e.message };
    }
  }

  // ── Element lookup with 3-strategy fallback ───────────────────

  async _findElement(page, markId, marks) {
    const mark = marks.find(m => m.markId === markId);
    if (!mark) {
      throw new Error(`Mark ID ${markId} not found. Available IDs: ${marks.map(m => m.markId).join(', ')}`);
    }

    // Strategy 1: CSS selector
    if (mark.selector && !mark.selector.includes(':text(')) {
      try {
        const el = await page.$(mark.selector);
        if (el) return { element: el, mark };
      } catch { /* next strategy */ }
    }

    // Strategy 2: coordinate hit-test
    if (mark.rect && mark.rect.w > 0 && mark.rect.h > 0) {
      try {
        const x = mark.rect.x + mark.rect.w / 2;
        const y = mark.rect.y + mark.rect.h / 2;
        const handle = await page.evaluateHandle(
          ([px, py]) => document.elementFromPoint(px, py), [x, y],
        );
        const tag = await handle.evaluate(el => el?.tagName || '');
        if (tag) return { element: handle, mark };
      } catch { /* next strategy */ }
    }

    // Strategy 3: text matching
    if (mark.text) {
      try {
        const el = await page
          .locator(`${mark.tag}:has-text("${mark.text.slice(0, 20)}")`)
          .first().elementHandle();
        if (el) return { element: el, mark };
      } catch { /* fall through */ }
    }

    throw new Error(
      `Could not locate element for mark ${markId} (${mark.tag} "${mark.text}"). ` +
      `The element may have been removed or changed. Try re-observing the page.`,
    );
  }

  // ── Atomic actions ────────────────────────────────────────────

  async _click(page, params, marks) {
    const { id } = params;
    const { element, mark } = await this._findElement(page, id, marks);
    await element.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);

    const visible = await element.isVisible();
    if (!visible) {
      return {
        success: false,
        description: `Element [${id}] is not visible`,
        error: `Element [${id}] ("${mark.text || ''}") is hidden or obscured by an overlay. Try scrolling, dismissing popups, or clicking a blank area first.`,
      };
    }

    await element.click({ timeout: ACTION_TIMEOUT });
    return { success: true, description: `Clicked [${id}] <${mark.tag}> "${mark.text || ''}"` };
  }

  async _input(page, params, marks) {
    const { id, text, press_enter = false } = params;
    const { element, mark } = await this._findElement(page, id, marks);
    await element.scrollIntoViewIfNeeded();

    // Clear then type realistically
    await element.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await element.type(text, { delay: 30 });

    if (press_enter) await page.keyboard.press('Enter');

    const preview = text.length > 30 ? text.slice(0, 30) + '...' : text;
    return { success: true, description: `Typed "${preview}" into [${id}] <${mark.tag}>${press_enter ? ' + Enter' : ''}` };
  }

  async _scroll(page, params) {
    const { direction = 'down', amount = 500 } = params;
    const delta = direction === 'up' ? -amount : amount;
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(500);
    return { success: true, description: `Scrolled ${direction} by ${amount}px` };
  }

  async _waitNav(page, params) {
    const timeout = (params && params.timeout) || NAV_TIMEOUT;
    try {
      await page.waitForLoadState('networkidle', { timeout });
      return { success: true, description: `Page loaded. URL: ${page.url()}` };
    } catch (e) {
      return { success: false, description: 'Navigation wait timed out', error: e.message };
    }
  }

  async _source(page, params) {
    const selector = params && params.selector;
    let html;
    if (selector) {
      html = await page.$eval(selector, el => el.outerHTML).catch(() => null);
      if (!html) return { success: false, description: `Selector "${selector}" not found`, error: 'Selector not found on page' };
    } else {
      html = await page.evaluate(() => {
        const clone = document.documentElement.cloneNode(true);
        clone.querySelectorAll('script, style, noscript, svg, link[rel=stylesheet]').forEach(el => el.remove());
        return clone.outerHTML;
      });
    }
    if (html.length > 6000) html = html.slice(0, 6000) + '\n... [truncated]';
    return { success: true, description: `Source retrieved (${html.length} chars)`, html };
  }

  async _navigate(page, params) {
    const { url } = params;
    await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
    return { success: true, description: `Navigated to ${url}. Title: "${await page.title()}"` };
  }

  async _pressKey(page, params) {
    const { key } = params;
    await page.keyboard.press(key);
    return { success: true, description: `Pressed key: ${key}` };
  }

  async _select(page, params, marks) {
    const { id, value } = params;
    const { element, mark } = await this._findElement(page, id, marks);
    await element.selectOption(value);
    return { success: true, description: `Selected "${value}" in [${id}] <${mark.tag}>` };
  }

  async _hover(page, params, marks) {
    const { id } = params;
    const { element, mark } = await this._findElement(page, id, marks);
    await element.scrollIntoViewIfNeeded();
    await element.hover();
    return { success: true, description: `Hovered over [${id}] <${mark.tag}> "${mark.text || ''}"` };
  }
}

// ═══════════════════════════════════════════════════════════════════
// Module D: VisionAnalyzer
// ═══════════════════════════════════════════════════════════════════

class VisionAnalyzer {

  /**
   * Analyze a screenshot using a multimodal LLM (Gemini / qwen-vl / etc).
   * Returns text analysis or empty string on failure.
   */
  async analyze(screenshotPath, prompt) {
    try {
      const sharp = require('sharp');
      if (!fs.existsSync(screenshotPath)) return '';

      const metadata = await sharp(screenshotPath).metadata();
      let imageBuffer;
      if (metadata.width > MAX_VISION_DIM || metadata.height > MAX_VISION_DIM) {
        imageBuffer = await sharp(screenshotPath)
          .resize(MAX_VISION_DIM, MAX_VISION_DIM, { fit: 'inside', withoutEnlargement: true })
          .png().toBuffer();
      } else {
        imageBuffer = fs.readFileSync(screenshotPath);
      }
      const base64Data = imageBuffer.toString('base64');

      const provider = process.env.AI_PROVIDER || 'gemini';
      const apiKey = process.env.AI_API_KEY;
      const model = process.env.AI_MODEL || 'gemini-2.0-flash';

      console.log('[VisionAnalyzer] Sending screenshot to vision model...');
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
          },
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
            messages: [{ role: 'user', content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Data}` } },
            ]}],
          }),
        });
        if (resp.ok) {
          const data = await resp.json();
          responseText = data.choices?.[0]?.message?.content || '';
        }
      }

      if (responseText) console.log(`[VisionAnalyzer] Analysis: ${responseText.length} chars`);
      return responseText;
    } catch (e) {
      console.warn(`[VisionAnalyzer] Failed: ${e.message}`);
      return '';
    }
  }

  /** Build a diagnostic prompt for a failed action. */
  diagnosticPrompt(task) {
    return `You are a web automation debugging assistant analyzing a browser screenshot.

Task: ${task.slice(0, 500)}

Analyze this screenshot and provide:
1. Current page state (layout, visible content, any modals/popups/overlays)
2. Correct selectors or interaction targets for the task
3. Obstacles (cookie banners, CAPTCHA, login walls, loading spinners)
4. Specific actionable advice to succeed

Be concise. Focus on what's relevant to the task.`;
  }

  /** Build a verification prompt to check if task was actually completed. */
  verificationPrompt(task) {
    return `Verify whether this browser task was completed successfully.

Task: ${task.slice(0, 300)}

Look at the screenshot and determine:
1. Does the page show the expected post-task state?
2. For login tasks: Is the user actually logged in? (dashboard/profile visible, not login form)
3. Are there error messages, forms still showing, or CAPTCHA challenges?

Answer: SUCCESS or FAIL, with brief explanation.`;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Module E: BrowserAgentLoop — ReAct coordination
// ═══════════════════════════════════════════════════════════════════

const REACT_SYSTEM_PROMPT = `You are a browser automation agent operating in a ReAct (Observe → Think → Act → Verify) loop.
You control a real Playwright browser to complete the user's task by issuing ONE atomic action at a time.

## Available Actions

| action              | params                                                    | description                          |
|---------------------|-----------------------------------------------------------|--------------------------------------|
| click_element       | { "id": <mark_id> }                                      | Click an interactive element         |
| input_text          | { "id": <mark_id>, "text": "...", "press_enter": bool }  | Type text into an input field        |
| scroll_page         | { "direction": "up"|"down", "amount": 300-1000 }         | Scroll to reveal more content        |
| wait_for_navigation | {} or { "timeout": ms }                                  | Wait for page load / AJAX            |
| navigate            | { "url": "https://..." }                                 | Go to a URL                          |
| press_key           | { "key": "Enter"|"Escape"|"Tab"|... }                    | Press a keyboard key                 |
| select_option       | { "id": <mark_id>, "value": "..." }                      | Select a dropdown option             |
| hover_element       | { "id": <mark_id> }                                      | Hover over an element                |
| get_page_source     | {} or { "selector": "css" }                               | Get HTML source (for debugging)      |
| done                | { "reason": "what was accomplished" }                     | Task completed successfully          |
| fail                | { "reason": "why it's impossible" }                       | Task cannot be completed             |

## Rules

1. Return EXACTLY one action per step as JSON. No markdown fences.
2. "id" refers to [mark_id] numbers shown in the Interactive Elements list.
3. If an element is obscured, try: scroll to it, dismiss overlays (press Escape, click blank area), or refresh.
4. If an action fails, try an alternative approach — do NOT repeat the same failed action.
5. Use "done" ONLY when you have CONCRETE evidence the task succeeded (URL changed, expected content visible, data extracted).
6. Use "fail" ONLY for genuinely impossible situations (CAPTCHA, paywall, missing credentials).
7. Think step-by-step. Explain your reasoning briefly before choosing an action.

## Response Format

{
  "reasoning": "I observe [X] on the page. To accomplish the task I need to [Y]. I'll [Z] because...",
  "type": "action_name",
  "params": { ... }
}`;

class BrowserAgentLoop {
  /**
   * @param {Object} opts
   * @param {Object} opts.llm          — LangChain LLM instance
   * @param {number} opts.maxSteps     — Max ReAct steps (default 30)
   * @param {Function} opts.notifyFn   — Progress callback
   * @param {Function} opts.sendPhotoFn — Send screenshot to user (Telegram etc)
   */
  constructor({ llm, maxSteps = MAX_STEPS, notifyFn = null, sendPhotoFn = null }) {
    this.llm = llm;
    this.maxSteps = maxSteps;
    this.notifyFn = notifyFn;
    this.sendPhotoFn = sendPhotoFn;
    this.browserManager = new BrowserManager();
    this.elementParser = new ElementParser();
    this.actionExecutor = new ActionExecutor();
    this.vision = new VisionAnalyzer();
  }

  /**
   * Main entry — run the ReAct browser automation loop.
   *
   * @param {string} task     — Natural-language task description
   * @param {Object} context  — Extra context (errorLog, userHints, etc.)
   * @returns {{ success, type, result, actionHistory, screenshotPath?, duration }}
   */
  async run(task, context = {}) {
    const startTime = Date.now();
    console.log(`\n[BrowserAgent] ═══ Starting ReAct loop ═══`);
    console.log(`[BrowserAgent] Task length: ${typeof task === 'string' ? task.length : 0}`);

    // ── Launch browser ──
    let page;
    try {
      page = await this.browserManager.launch();
    } catch (e) {
      return { success: false, type: 'launch_error', result: `Failed to launch browser: ${e.message}`, actionHistory: [], duration: Date.now() - startTime };
    }

    // ── Navigate to initial URL if present in task ──
    const urlMatch = task.match(/https?:\/\/\S+/i);
    if (urlMatch) {
      const url = cleanUrl(urlMatch[0]);
      try {
        await this.browserManager.navigate(url);
        console.log(`[BrowserAgent] Navigated to ${url}`);
      } catch (e) {
        console.warn(`[BrowserAgent] Initial navigation failed: ${e.message}`);
      }
    }

    const actionHistory = [];
    let lastSnapshot = null;
    let stepCount = 0;
    let finalResult = null;

    try {
      while (stepCount < this.maxSteps) {
        stepCount++;
        console.log(`[BrowserAgent] ── Step ${stepCount}/${this.maxSteps} ──`);

        // ── Step 1: OBSERVE — get page snapshot ──
        lastSnapshot = await this.elementParser.getPageSnapshot(page);
        const snapshotText = this.elementParser.formatSnapshotForLLM(lastSnapshot);
        console.log(`[BrowserAgent] Snapshot: ${lastSnapshot.interactiveMarks.length} elements, URL: ${lastSnapshot.url}`);

        // ── Step 2: THINK — LLM decides next action ──
        const action = await this._decideAction(task, snapshotText, actionHistory, lastSnapshot.screenshotPath);
        if (!action) {
          console.warn('[BrowserAgent] LLM returned invalid action, ending loop');
          break;
        }

        const actionParamsText = JSON.stringify(action.params || {});
        console.log(`[BrowserAgent] Action: ${action.type} (params chars: ${actionParamsText.length})`);
        if (action.reasoning) console.log(`[BrowserAgent] Reasoning length: ${action.reasoning.length}`);

        // ── Step 3: ACT — execute atomic action ──
        const result = await this.actionExecutor.execute(page, action, lastSnapshot.interactiveMarks);
        console.log(`[BrowserAgent] Result: ${result.success ? '✓' : '✗'} ${result.description.slice(0, 120)}`);

        actionHistory.push({
          step: stepCount,
          action: action.type,
          params: action.params,
          reasoning: action.reasoning,
          success: result.success,
          description: result.description,
          error: result.error || null,
        });

        // ── Step 4: VERIFY — check if done/failed ──
        if (result.done) {
          // For "done" claims, run vision verification if screenshot is available
          if (!result.failed && lastSnapshot.screenshotPath) {
            const verifyResult = await this._verifyCompletion(task, lastSnapshot.screenshotPath);
            if (verifyResult === 'FAIL') {
              console.log('[BrowserAgent] Vision verification rejected done claim — continuing');
              actionHistory[actionHistory.length - 1].description += ' [VERIFICATION REJECTED — continuing]';
              actionHistory[actionHistory.length - 1].error = 'Vision verification shows task not actually completed';
              continue; // Don't break, let the loop continue
            }
          }

          finalResult = {
            success: !result.failed,
            type: result.failed ? 'task_failed' : 'completed',
            result: result.description,
            actionHistory,
            duration: Date.now() - startTime,
          };
          break;
        }

        // Brief pause for page to settle
        if (result.success) await page.waitForTimeout(300);
      }

      if (!finalResult) {
        finalResult = {
          success: false,
          type: 'max_steps',
          result: `Reached maximum steps (${this.maxSteps}) without completing the task.`,
          actionHistory,
          duration: Date.now() - startTime,
        };
      }
    } catch (e) {
      finalResult = {
        success: false,
        type: 'error',
        result: `Browser agent error: ${e.message}`,
        actionHistory,
        duration: Date.now() - startTime,
      };
    } finally {
      // Final screenshot & cleanup
      try {
        ensureDir(SCREENSHOT_DIR);
        const finalSS = path.join(SCREENSHOT_DIR, `final-${Date.now()}.png`);
        await page.screenshot({ path: finalSS, fullPage: false, type: 'png' });
        if (finalResult) finalResult.screenshotPath = finalSS;

        if (this.sendPhotoFn && finalSS) {
          try {
            const domain = lastSnapshot?.url ? new URL(lastSnapshot.url).hostname : 'browser';
            await this.sendPhotoFn(finalSS, `📸 <b>${domain}</b> (Browser Agent — ${finalResult?.success ? 'success' : 'failed'})`);
          } catch { /* best effort */ }
        }
      } catch { /* ignore */ }

      await this.browserManager.close();
    }

    const dur = Date.now() - startTime;
    console.log(`[BrowserAgent] ${finalResult?.success ? '✓' : '✗'} Finished in ${dur}ms (${actionHistory.length} steps)`);

    if (this.notifyFn) {
      const status = finalResult?.success ? '✅' : '❌';
      try { await this.notifyFn(`${status} Browser Agent (${actionHistory.length} steps, ${dur}ms): ${(finalResult?.result || '').slice(0, 300)}`); } catch { /* best effort */ }
    }

    return finalResult;
  }

  // ── LLM decision step ───────────────────────────────────────────

  async _decideAction(task, snapshotText, actionHistory, screenshotPath) {
    const { SystemMessage, HumanMessage } = require('@langchain/core/messages');

    let userPrompt = `TASK: ${task}\n\nCURRENT PAGE STATE:\n${snapshotText}\n`;

    if (actionHistory.length > 0) {
      userPrompt += '\nACTION HISTORY (recent):\n';
      const recent = actionHistory.slice(-10);
      for (const h of recent) {
        const flag = h.success ? '✓' : '✗';
        userPrompt += `  Step ${h.step}: ${flag} ${h.action}(${JSON.stringify(h.params || {}).slice(0, 80)})`;
        userPrompt += ` → ${h.description.slice(0, 80)}`;
        if (h.error) userPrompt += ` [ERROR: ${h.error.slice(0, 80)}]`;
        userPrompt += '\n';
      }
    }

    // §4 retry guidance
    const failCount = actionHistory.filter(h => !h.success).length;
    if (failCount >= 2) {
      userPrompt += '\n⚠ Multiple actions have failed. Consider: refreshing the page, pressing Escape to close popups, scrolling to reveal hidden elements, or trying a completely different approach.\n';
    }

    // Build messages with optional screenshot for vision models
    const messages = [new SystemMessage(REACT_SYSTEM_PROMPT)];

    if (screenshotPath && fs.existsSync(screenshotPath)) {
      try {
        const b64 = fs.readFileSync(screenshotPath).toString('base64');
        messages.push(new HumanMessage({
          content: [
            { type: 'text', text: userPrompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
          ],
        }));
      } catch {
        messages.push(new HumanMessage(userPrompt));
      }
    } else {
      messages.push(new HumanMessage(userPrompt));
    }

    const result = await this.llm.invoke(messages);
    const text = extractText(result.content);
    return this._parseAction(text);
  }

  /** Verify task completion using vision analysis. Returns 'SUCCESS' or 'FAIL'. */
  async _verifyCompletion(task, screenshotPath) {
    try {
      const analysis = await this.vision.analyze(screenshotPath, this.vision.verificationPrompt(task));
      if (!analysis) return 'SUCCESS'; // No vision available, trust the agent
      console.log(`[BrowserAgent] Verification: ${analysis.slice(0, 150)}`);
      return /\bFAIL\b/i.test(analysis) ? 'FAIL' : 'SUCCESS';
    } catch {
      return 'SUCCESS'; // On error, don't block
    }
  }

  /** Robustly parse JSON action from LLM output. */
  _parseAction(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fenced ? fenced[1].trim() : text.trim();

    try {
      const obj = JSON.parse(raw);
      return { type: obj.type || obj.action, params: obj.params || {}, reasoning: obj.reasoning || '' };
    } catch { /* try brace extraction */ }

    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        const obj = JSON.parse(braceMatch[0]);
        return { type: obj.type || obj.action, params: obj.params || {}, reasoning: obj.reasoning || '' };
      } catch { /* give up */ }
    }

    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Module F: createBrowserTool — LangChain tool factory
// ═══════════════════════════════════════════════════════════════════

/**
 * Create the `browser_task` LangChain tool for runner.js integration.
 *
 * @param {Object} llm          — LangChain LLM instance
 * @param {Function} notifyFn   — Progress notification callback
 * @param {Function} sendPhotoFn — Send screenshot to user (Telegram etc)
 * @returns {Object} LangChain tool
 */
function createBrowserTool(llm, notifyFn, sendPhotoFn) {
  const { tool } = require('@langchain/core/tools');
  const { z } = require('zod');

  return tool(async ({ task, user_hints }) => {
    try {
      const browserAgent = new BrowserAgentLoop({
        llm,
        maxSteps: MAX_STEPS,
        notifyFn,
        sendPhotoFn,
      });

      const context = {};
      if (user_hints) context.userHints = user_hints;

      const result = await browserAgent.run(task, context);

      if (result.success) {
        const stepsLog = result.actionHistory
          ? result.actionHistory.map(h => `Step ${h.step}: ${h.success ? '✓' : '✗'} ${h.description}`).join('\n')
          : '';

        return [
          `[Browser Agent — Success] (${result.duration}ms, ${result.actionHistory?.length || 0} steps)`,
          result.result,
          '',
          stepsLog ? `Steps:\n${stepsLog}` : '',
        ].filter(Boolean).join('\n');
      }

      // Failure
      const lines = [
        `[Browser Agent — Failed: ${result.type}] (${result.duration}ms)`,
        result.result,
      ];
      if (result.actionHistory?.length) {
        lines.push(`\nSteps attempted: ${result.actionHistory.length}`);
        const last = result.actionHistory[result.actionHistory.length - 1];
        if (last.error) lines.push(`Last error: ${last.error.slice(0, 300)}`);
      }
      lines.push('\nPlease ask the user for clarification or try a different approach.');
      return lines.join('\n');
    } catch (e) {
      return `[Browser Agent — Internal Error] ${e.message}`;
    }
  }, {
    name: 'browser_task',
    description: `Launch the ReAct Browser Agent for web automation tasks.

Uses the Observe→Think→Act→Verify loop with Playwright to interact with web pages step by step:
- Observes page state via Accessibility Tree + annotated screenshot (Set-of-Mark)
- LLM decides the next atomic action (click, type, scroll, navigate, etc.)
- Executes the action and verifies the result
- Repeats until task is done or max steps reached

USE THIS TOOL FOR:
- Web page interaction (clicking buttons, filling forms, navigating)
- Login / authentication flows
- Scraping dynamic SPAs that need interaction
- Multi-step web workflows

DO NOT USE FOR:
- Simple URL fetching (use fetch_url)
- Basic search (use web_search)
- Non-browser tasks (use explore_task)`,
    schema: z.object({
      task: z.string().describe('Detailed task description. MUST include the target URL. Describe exactly what to do on the page, what data to extract, or what state to achieve.'),
      user_hints: z.string().optional().describe('Additional hints: credentials env var names, expected page layout, known obstacles.'),
    }),
  });
}

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  BrowserManager,
  ElementParser,
  ActionExecutor,
  VisionAnalyzer,
  BrowserAgentLoop,
  createBrowserTool,
};

/**
 * loop-agent/runner.js — Long-running GitHub Action agent
 *
 * Architecture: OpenClaw-inspired 4-node stateful graph
 *   Start → Analyze → Validate → Ask_User (params missing) ↔ Validate
 *                               → Execute  (params complete)
 *
 * Two input modes:
 *   1. Telegram mode — When PUSHOO_CHANNELS contains a "telegram" channel,
 *      uses Telegraf long-polling to receive user messages directly from
 *      Telegram and replies via Telegram. Upstash is optional (status tracking only).
 *   2. WeCom mode — When PUSHOO_CHANNELS contains a "wecombot" channel,
 *      uses @wecom/aibot-node-sdk WebSocket long-connection for bidirectional
 *      messaging with Enterprise WeChat (企业微信).
 *   3. Upstash mode  — Polls Upstash for user messages, sends results via
 *      multi-channel notifications, and persists conversation history to the repo.
 *
 * Environment variables (set as repo secrets/vars):
 *   UPSTASH_URL       — Upstash Redis REST URL (required in Upstash mode)
 *   UPSTASH_TOKEN     — Upstash Redis REST token (required in Upstash mode)
 *   LOOP_KEY          — Unique conversation key
 *   AI_PROVIDER       — gemini | qwen | kimi | openai
 *   AI_MODEL          — Model ID
 *   AI_API_KEY        — Provider API key
 *   AI_BASE_URL       — OpenAI-compatible base URL (used when provider=openai or as override)
 *   PUSHOO_CHANNELS   — JSON array of {platform, token} for multi-channel notifications
 *                        (legacy: PUSHOO_PLATFORM + PUSHOO_TOKEN still supported as fallback)
 *   GITHUB_TOKEN      — GitHub PAT for repo operations
 *   GITHUB_REPOSITORY — owner/repo of the session repo where GHA runs
 *   LOOP_DATA_REPOSITORY — owner/repo of private loop data repo (history/state/memory/artifacts)
 *   LOOP_HISTORY_PATH — Path in repo for history file (default: loop-agent/history)
 *   LOOP_POLL_INTERVAL— Polling interval in seconds (default: 5)
 *   LOOP_SYSTEM_PROMPT— Optional system prompt for the agent
 *   LOOP_MAX_RUNTIME  — Max runtime in seconds (default: 18000 = 5h)
 */

// ─── Upstash Redis REST client ──────────────────────────────────────

class UpstashClient {
  constructor(url, token) {
    this.baseUrl = url.replace(/\/+$/, '');
    this.token = token;
  }

  async _cmd(args) {
    const resp = await fetch(`${this.baseUrl}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Upstash error ${resp.status}: ${text}`);
    }
    return resp.json();
  }

  async get(key) {
    const res = await this._cmd(['GET', key]);
    return res.result;
  }

  async set(key, value) {
    const res = await this._cmd(['SET', key, value]);
    return res.result;
  }

  async del(key) {
    const res = await this._cmd(['DEL', key]);
    return res.result;
  }

  /**
   * Verify Upstash connectivity by issuing a PING command.
   * Returns true if connected, throws on failure.
   */
  async ping() {
    const res = await this._cmd(['PING']);
    return res.result === 'PONG';
  }
}

// ─── File Encoding Helpers (legacy-compatible) ─────────────────────

const nodeCrypto = require('crypto');

const ENC_PBKDF2_ITERATIONS = 310000;
const ENC_SALT_LEN = 16;
const ENC_IV_LEN = 12;
const ENC_KEY_LEN = 32;
const ENC_TAG_LEN = 16;
const ENC_PREFIX = 'ENCRYPTED:';

function encryptContent(passphrase, plaintext) {
  const salt = nodeCrypto.randomBytes(ENC_SALT_LEN);
  const iv = nodeCrypto.randomBytes(ENC_IV_LEN);
  const key = nodeCrypto.pbkdf2Sync(passphrase, salt, ENC_PBKDF2_ITERATIONS, ENC_KEY_LEN, 'sha256');
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Pack: salt + iv + ciphertext + authTag  (matches Web Crypto output)
  const packed = Buffer.concat([salt, iv, encrypted, authTag]);
  return ENC_PREFIX + packed.toString('base64');
}

function decryptContent(passphrase, blob) {
  if (!blob || !blob.startsWith(ENC_PREFIX)) return blob;
  const packed = Buffer.from(blob.slice(ENC_PREFIX.length), 'base64');
  const salt = packed.subarray(0, ENC_SALT_LEN);
  const iv = packed.subarray(ENC_SALT_LEN, ENC_SALT_LEN + ENC_IV_LEN);
  const remainder = packed.subarray(ENC_SALT_LEN + ENC_IV_LEN);
  const authTag = remainder.subarray(remainder.length - ENC_TAG_LEN);
  const ciphertext = remainder.subarray(0, remainder.length - ENC_TAG_LEN);
  const key = nodeCrypto.pbkdf2Sync(passphrase, salt, ENC_PBKDF2_ITERATIONS, ENC_KEY_LEN, 'sha256');
  const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
}

// ─── GitHub Repo Operations ─────────────────────────────────────────

class RepoStore {
  constructor(token, repository) {
    this.token = token;
    const [owner, repo] = repository.split('/');
    this.owner = owner;
    this.repo = repo;
    this.api = 'https://api.github.com';
  }

  _headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
  }

  async readFile(path, branch = 'main') {
    const resp = await fetch(
      `${this.api}/repos/${this.owner}/${this.repo}/contents/${path}?ref=${branch}`,
      { headers: this._headers() }
    );
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`GitHub read error: ${resp.status}`);
    const data = await resp.json();
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return { content, sha: data.sha };
  }

  async writeFile(path, content, message, branch = 'main') {
    // Get existing file SHA if it exists (for updates)
    const existing = await this.readFile(path, branch);
    const body = {
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
    };
    if (existing) body.sha = existing.sha;

    const resp = await fetch(
      `${this.api}/repos/${this.owner}/${this.repo}/contents/${path}`,
      { method: 'PUT', headers: this._headers(), body: JSON.stringify(body) }
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`GitHub write error: ${resp.status} ${err.message || ''}`);
    }
    return resp.json();
  }

  /**
  * Write a file as plain text.
   */
  async writeFileRaw(path, content, message, branch = 'main') {
    const existing = await this.readFile(path, branch);
    const body = {
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
    };
    if (existing) body.sha = existing.sha;

    const resp = await fetch(
      `${this.api}/repos/${this.owner}/${this.repo}/contents/${path}`,
      { method: 'PUT', headers: this._headers(), body: JSON.stringify(body) }
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`GitHub write error: ${resp.status} ${err.message || ''}`);
    }
    return resp.json();
  }

  async deleteFile(path, message, branch = 'main') {
    const existing = await this.readFile(path, branch);
    if (!existing) return { deleted: false, reason: 'not_found' };

    const body = {
      message,
      sha: existing.sha,
      branch,
    };

    const resp = await fetch(
      `${this.api}/repos/${this.owner}/${this.repo}/contents/${path}`,
      { method: 'DELETE', headers: this._headers(), body: JSON.stringify(body) }
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`GitHub delete error: ${resp.status} ${err.message || ''}`);
    }
    return { deleted: true };
  }
}

// ─── Pushoo Notification ────────────────────────────────────────────

async function sendPushoo(platform, token, title, content) {
  if (!platform || !token) return;

  try {
    // In CommonJS: require('pushoo').default returns a callable function directly
    // Signature: pushoo(platform, { token, title, content })
    const pushoo = require('pushoo').default;
    await pushoo(platform, { token, title, content });
    console.log(`[Pushoo] Notification sent via ${platform}`);
  } catch (e) {
    console.warn(`[Pushoo] Failed: ${e.message}`);
  }
}

/**
 * Parse PUSHOO_CHANNELS env var (JSON array of { platform, token }).
 * Falls back to legacy PUSHOO_PLATFORM + PUSHOO_TOKEN if PUSHOO_CHANNELS is not set.
 */
function parsePushooChannels() {
  const channelsJson = process.env.PUSHOO_CHANNELS;
  if (channelsJson) {
    try {
      const channels = JSON.parse(channelsJson);
      if (Array.isArray(channels) && channels.length > 0) return channels;
    } catch (e) {
      console.warn(`[Pushoo] Failed to parse PUSHOO_CHANNELS: ${e.message}`);
    }
  }
  // Legacy fallback
  const platform = process.env.PUSHOO_PLATFORM;
  const token = process.env.PUSHOO_TOKEN;
  if (platform && token) return [{ platform, token }];
  return [];
}

/**
 * Send notification to all configured pushoo channels.
 * Telegram channels use direct Bot API; wecombot is skipped (bidirectional only);
 * all other platforms use the pushoo library.
 */
async function sendNotifications(channels, title, content) {
  if (!channels || channels.length === 0) return;
  for (const ch of channels) {
    try {
      if (ch.platform === 'telegram') {
        const { botToken, chatId } = parseTelegramToken(ch.token);
        if (botToken && chatId) {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: `${title}\n\n${content}`.slice(0, 4000) }),
          });
          console.log(`[Notify] Telegram notification sent`);
        }
      } else if (ch.platform === 'wecombot') {
        // WeCom Bot is bidirectional — skip one-way notifications
        console.log(`[Notify] WeCom Bot: skipped (bidirectional only)`);
      } else {
        await sendPushoo(ch.platform, ch.token, title, content);
      }
    } catch (e) {
      console.warn(`[Notify] ${ch.platform} failed: ${e.message}`);
    }
  }
}

const SUPPORTED_CHANNEL_PLATFORMS = new Set([
  'telegram', 'wecombot', 'discord', 'dingtalk', 'feishu',
  'serverchan', 'pushplus', 'wecom', 'bark', 'webhook',
]);

function normalizePlatformName(name) {
  const raw = String(name || '').trim().toLowerCase();
  const alias = {
    tg: 'telegram',
    wx: 'wecombot',
    wecom: 'wecombot',
    wxwork: 'wecombot',
    '企业微信': 'wecombot',
  };
  return alias[raw] || raw;
}

function isBidirectionalPlatform(platform) {
  return platform === 'telegram' || platform === 'wecombot';
}

function maskToken(token) {
  const s = String(token || '');
  if (s.length <= 8) return s ? `${s.slice(0, 2)}***` : '(empty)';
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

function findChannel(channels, platform) {
  if (!Array.isArray(channels)) return null;
  return channels.find(ch => normalizePlatformName(ch.platform) === platform) || null;
}

function upsertChannel(channels, platform, token) {
  const normalized = normalizePlatformName(platform);
  if (!SUPPORTED_CHANNEL_PLATFORMS.has(normalized)) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  const idx = channels.findIndex(ch => normalizePlatformName(ch.platform) === normalized);
  const next = { platform: normalized, token: String(token || '').trim() };
  if (!next.token) throw new Error(`Empty token for ${normalized}`);
  if (idx >= 0) {
    channels[idx] = next;
  } else {
    channels.push(next);
  }
  return next;
}

function parseDeliveryDirective(text) {
  const raw = String(text || '');
  const patterns = [
    /(?:通过|经由|用|via|using)\s*([a-zA-Z\u4e00-\u9fa5]+)\s*(?:渠道|channel)?(?:下发|发送|通知|deliver|send)?/i,
    /(?:把结果|结果)(?:.{0,16}?)(?:通过|via|using)\s*([a-zA-Z\u4e00-\u9fa5]+)\s*(?:渠道|channel)?/i,
    /(?:send|deliver)(?:.{0,20}?)(?:via|through)\s+([a-zA-Z\u4e00-\u9fa5]+)/i,
  ];

  let matched = null;
  for (const p of patterns) {
    const m = raw.match(p);
    if (m) {
      matched = { platform: normalizePlatformName(m[1]), phrase: m[0] };
      break;
    }
  }
  if (!matched || !SUPPORTED_CHANNEL_PLATFORMS.has(matched.platform)) return null;

  const tokenRegex = new RegExp(
    `${matched.platform}\\s*(?:token|key|密钥|令牌)?\\s*[:：=]\\s*([^\\s]+)`,
    'i'
  );
  const genericTokenRegex = /(?:token|key|密钥|令牌)\s*[:：=]\s*([^\s]+)/i;
  const tokenMatch = raw.match(tokenRegex) || raw.match(genericTokenRegex);

  const cleaned = raw
    .replace(matched.phrase, ' ')
    .replace(tokenRegex, ' ')
    .replace(genericTokenRegex, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    platform: matched.platform,
    token: tokenMatch ? tokenMatch[1].trim() : '',
    cleanedText: cleaned,
  };
}

async function loadRuntimeChannels(repoStore, loopKey) {
  if (!repoStore || !loopKey) return [];
  const path = `loop-agent/channel/${loopKey}.channels.json`;
  try {
    const file = await repoStore.readFile(path);
    if (!file) return [];
    const parsed = JSON.parse(file.content);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(ch => ({
        platform: normalizePlatformName(ch.platform),
        token: String(ch.token || '').trim(),
      }))
      .filter(ch => SUPPORTED_CHANNEL_PLATFORMS.has(ch.platform) && ch.token);
  } catch (e) {
    console.warn(`[Channel] Failed to load runtime channels: ${e.message}`);
    return [];
  }
}

async function persistRuntimeChannels(repoStore, loopKey, channels) {
  if (!repoStore || !loopKey || !Array.isArray(channels)) return;
  const path = `loop-agent/channel/${loopKey}.channels.json`;
  const content = JSON.stringify(channels, null, 2);
  try {
    await repoStore.writeFileRaw(path, content, '[loop-agent] Update runtime channels');
  } catch (e) {
    console.warn(`[Channel] Failed to persist runtime channels: ${e.message}`);
  }
}

// ─── Telegram Helpers ───────────────────────────────────────────────

/**
 * Parse the PUSHOO_TOKEN for Telegram.
 * Format: "botToken#chatId" or "botToken/chatId"
 */
function parseTelegramToken(pushooToken) {
  if (!pushooToken) return { botToken: '', chatId: '' };
  const sep = pushooToken.includes('#') ? '#' : '/';
  const parts = pushooToken.split(sep);
  return { botToken: parts[0] || '', chatId: parts[1] || '' };
}

/**
 * Split a long message into chunks for Telegram's 4096-char limit.
 */
function splitTelegramMessage(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

/**
 * Split a WeCom message into chunks (max 2000 chars per message).
 */
function splitWecomMessage(text, maxLen = 2000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

/**
 * Check if the platform string refers to Telegram.
 */
function isTelegramPlatform(platform) {
  return platform && platform.toLowerCase() === 'telegram';
}

/**
 * Send a photo to Telegram via Bot API.
 * Reads PUSHOO_CHANNELS from env to find the telegram channel.
 * Validates image integrity and optimizes dimensions before sending.
 */
async function sendTelegramPhoto(imagePath, caption) {
  const channels = parsePushooChannels();
  const telegramCh = channels.find(ch => ch.platform === 'telegram');
  if (!telegramCh) return null;

  const { botToken, chatId } = parseTelegramToken(telegramCh.token);
  if (!botToken || !chatId) return null;

  const fs = require('fs');
  const path = require('path');
  const sharp = require('sharp');

  try {
    // 1. Validate image exists and read metadata
    if (!fs.existsSync(imagePath)) {
      console.error(`[Telegram] Image file not found: ${imagePath}`);
      return null;
    }

    const imageData = fs.readFileSync(imagePath);
    console.log(`[Telegram] Read image (${(imageData.length / 1024).toFixed(1)}KB): ${imagePath}`);

    // 2. Validate image using Sharp and get metadata
    let metadata;
    try {
      metadata = await sharp(imagePath).metadata();
      console.log(`[Telegram] Image metadata - size: ${metadata.width}x${metadata.height}px, format: ${metadata.format}`);
    } catch (e) {
      console.error(`[Telegram] Failed to read image metadata: ${e.message}`);
      return null;
    }

    // 3. Validate dimensions (Telegram requires valid dimensions)
    if (!metadata.width || !metadata.height || metadata.width < 1 || metadata.height < 1) {
      console.error(`[Telegram] Invalid image dimensions: ${metadata.width}x${metadata.height}`);
      return null;
    }

    // 4. Optimize image if too large (Telegram sendPhoto has size limits)
    let processedBuffer = imageData;
    const MAX_DIMENSION = 2560; // Telegram recommended max
    const MIN_DIMENSION = 50;   // Ensure minimum viable size

    if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION) {
      console.log(`[Telegram] Image too large (${metadata.width}x${metadata.height}), resizing to max ${MAX_DIMENSION}px...`);
      processedBuffer = await sharp(imagePath)
        .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
        .png({ quality: 80, progressive: true })
        .toBuffer();
      console.log(`[Telegram] Resized image (${(processedBuffer.length / 1024).toFixed(1)}KB)`);
    }

    // 5. Validate file size for endpoint choice
    const sizeMB = processedBuffer.length / (1024 * 1024);
    const endpoint = sizeMB > 10 ? 'sendDocument' : 'sendPhoto';
    const fieldName = sizeMB > 10 ? 'document' : 'photo';

    // 6. Prepare form data
    const filename = path.basename(imagePath);
    const form = new FormData();
    form.append('chat_id', String(chatId));
    
    // Prepare caption - Telegram sendPhoto caption limit is 1024, sendDocument is 1024 too
    if (caption) {
      form.append('caption', caption.slice(0, 1024));
      form.append('parse_mode', 'HTML'); // Allow basic HTML formatting in caption
    }

    // 7. Send as Blob with correct MIME type
    const mimeType = 'image/png';
    form.append(fieldName, new Blob([processedBuffer], { type: mimeType }), filename);

    // 8. Make API request
    const url = `https://api.telegram.org/bot${botToken}/${endpoint}`;
    console.log(`[Telegram] Sending ${endpoint} to chat ${chatId} (${sizeMB.toFixed(2)}MB)...`);
    
    const resp = await fetch(url, {
      method: 'POST',
      body: form,
    });

    // 9. Handle response
    const responseText = await resp.text();
    if (!resp.ok) {
      console.error(`[Telegram] ${endpoint} failed (HTTP ${resp.status})`);
      console.error(`[Telegram] Response: ${responseText}`);
      return null;
    }

    // 10. Parse and return success
    const result = JSON.parse(responseText);
    if (result.ok) {
      console.log(`[Telegram] ✓ Photo sent via ${endpoint} (${sizeMB.toFixed(2)}MB) - Message ID: ${result.result.message_id}`);
      return result.result;
    } else {
      console.error(`[Telegram] API returned error: ${result.description}`);
      return null;
    }
  } catch (e) {
    console.error(`[Telegram] Exception during photo send: ${e.message}`);
    console.error(`[Telegram] Stack: ${e.stack}`);
    return null;
  }
}

/**
 * Send an image to WeCom using replyStream + msg_item(image).
 * Requires an active incoming frame context from the current conversation.
 */
async function sendWecomPhoto(wsClient, frame, imagePath, caption, generateReqIdFn) {
  if (!wsClient || !frame) {
    console.warn('[WeCom] Cannot send image: missing wsClient or active frame context');
    return null;
  }

  const fs = require('fs');
  const sharp = require('sharp');

  try {
    if (!fs.existsSync(imagePath)) {
      console.error(`[WeCom] Image file not found: ${imagePath}`);
      return null;
    }

    let imageBuffer = fs.readFileSync(imagePath);
    const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // WeCom docs: raw image max 10MB before base64

    // Try to normalize oversized images to stay within WeCom limits.
    if (imageBuffer.length > MAX_IMAGE_BYTES) {
      const metadata = await sharp(imageBuffer).metadata();
      const maxDim = 2048;
      imageBuffer = await sharp(imageBuffer)
        .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toBuffer();
      console.log(`[WeCom] Image resized ${metadata.width}x${metadata.height} -> <=${maxDim}px (${Math.round(imageBuffer.length / 1024)}KB)`);
    }

    if (imageBuffer.length > MAX_IMAGE_BYTES) {
      console.error(`[WeCom] Image still too large after resize: ${Math.round(imageBuffer.length / 1024)}KB`);
      return null;
    }

    const md5 = nodeCrypto.createHash('md5').update(imageBuffer).digest('hex');
    const base64 = imageBuffer.toString('base64');
    const streamId = generateReqIdFn ? generateReqIdFn('stream') : `stream-${Date.now()}`;
    const text = caption || '🖼 Image';

    await wsClient.replyStream(
      frame,
      streamId,
      text,
      true,
      [{ msgtype: 'image', image: { base64, md5 } }]
    );

    console.log(`[WeCom] ✓ Image sent (${Math.round(imageBuffer.length / 1024)}KB)`);
    return { ok: true, size: imageBuffer.length };
  } catch (e) {
    console.error(`[WeCom] Failed to send image: ${e.message}`);
    return null;
  }
}

/**
 * Route image delivery to the currently active bidirectional channel.
 * When WeCom is active, NEVER fallback to Telegram.
 */
async function sendImageToActiveChannel(imagePath, caption) {
  const listener = _runtime && _runtime.listener;
  const activeType = listener ? listener.type : '';

  if (activeType === 'wecom') {
    if (listener.sendImage) return listener.sendImage(imagePath, caption);
    console.warn('[Image] WeCom is active but sendImage is unavailable');
    return null;
  }

  if (activeType === 'telegram') {
    if (listener.sendImage) return listener.sendImage(imagePath, caption);
    return sendTelegramPhoto(imagePath, caption);
  }

  // Fallback only when no active bidirectional listener is present.
  return sendTelegramPhoto(imagePath, caption);
}

function resolveModelProvider(provider, model) {
  const normalizedProvider = String(provider || '').toLowerCase();
  const normalizedModel = String(model || '').toLowerCase();
  // GLM is consumed via OpenAI-compatible endpoint with AI_BASE_URL.
  if (normalizedModel.startsWith('glm') || normalizedModel.startsWith('chatglm')) return 'openai';
  if (normalizedProvider === 'openai') {
    if (normalizedModel.startsWith('kimi') || normalizedModel.startsWith('moonshot')) return 'kimi';
    if (normalizedModel.startsWith('qwen') || normalizedModel.startsWith('qwq')) return 'qwen';
  }
  return normalizedProvider;
}

function isGlmModel(model) {
  return String(model || '').toLowerCase().startsWith('glm-');
}

function getImageMimeType(format) {
  const normalized = String(format || '').toLowerCase();
  if (normalized === 'jpg' || normalized === 'jpeg') return 'image/jpeg';
  if (normalized === 'webp') return 'image/webp';
  if (normalized === 'gif') return 'image/gif';
  return 'image/png';
}

function extractAssistantText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        return part?.text || '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content);
}

function buildVisionDataUrl(base64Data, mimeType) {
  return `data:${mimeType};base64,${base64Data}`;
}

function buildVisionRequest(provider, model, promptText, mimeType, base64Data) {
  const resolvedProvider = resolveModelProvider(provider, model);
  const dataUrl = buildVisionDataUrl(base64Data, mimeType);
  const userContent = [
    {
      type: 'image_url',
      image_url: { url: dataUrl },
    },
    {
      type: 'text',
      text: promptText,
    },
  ];

  if (resolvedProvider === 'gemini') {
    return {
      provider: resolvedProvider,
      endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      body: {
        contents: [{ parts: [
          { text: promptText },
          { inline_data: { mime_type: mimeType, data: base64Data } },
        ] }],
      },
      headers: { 'Content-Type': 'application/json' },
      queryKey: 'key',
      responseParser(data) {
        return data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      },
    };
  }

  const baseURLMap = {
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    kimi: 'https://api.moonshot.cn/v1',
    openai: 'https://api.openai.com/v1',
  };
  const baseUrl = process.env.AI_BASE_URL || baseURLMap[resolvedProvider] || baseURLMap.openai;

  const body = {
    model,
    messages: [{ role: 'user', content: userContent }],
  };

  return {
    provider: resolvedProvider,
    endpoint: `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
    body,
    headers: {
      Authorization: `Bearer ${process.env.AI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    responseParser(data) {
      return extractAssistantText(data.choices?.[0]?.message?.content) || '';
    },
  };
}

async function requestVisionCompletion({ provider, model, apiKey, promptText, mimeType, base64Data }) {
  const request = buildVisionRequest(provider, model, promptText, mimeType, base64Data);
  const url = request.queryKey
    ? `${request.endpoint}?${request.queryKey}=${encodeURIComponent(apiKey)}`
    : request.endpoint;
  const headers = request.queryKey
    ? request.headers
    : { ...request.headers, Authorization: `Bearer ${apiKey}` };

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(request.body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Vision API error (${resp.status}): ${err.slice(0, 500)}`);
  }

  const data = await resp.json();
  return request.responseParser(data);
}

// ─── Self-Restart (Workflow Re-dispatch) ────────────────────────────

/**
 * Attempt to re-dispatch the current workflow to continue the loop agent.
 * Uses the GitHub Actions REST API with GH_PAT.
 */
async function selfRestart() {
  const pat = process.env.GH_PAT;
  const repo = process.env.GITHUB_REPOSITORY;
  const workflowFile = process.env.LOOP_WORKFLOW_FILE;
  if (!pat || !repo || !workflowFile) {
    console.log('[Restart] Cannot self-restart: missing GH_PAT, GITHUB_REPOSITORY, or LOOP_WORKFLOW_FILE');
    return false;
  }

  const [owner, repoName] = repo.split('/');
  const url = `https://api.github.com/repos/${owner}/${repoName}/actions/workflows/${workflowFile}/dispatches`;
  try {
    console.log(`[Restart] Dispatching new workflow run: ${workflowFile}`);
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.error(`[Restart] Dispatch failed (${resp.status}): ${body}`);
      return false;
    }
    console.log('[Restart] Successfully dispatched new workflow run');
    return true;
  } catch (e) {
    console.error(`[Restart] Failed: ${e.message}`);
    return false;
  }
}

// ─── Built-in Tools ─────────────────────────────────────────────────

function createBuiltinTools(repoStore, llm, notifyFn, memoryStore = null) {
  const { tool } = require('@langchain/core/tools');
  const { z } = require('zod');

  const tools = [];

  // 1. Web Search — uses fetch to query a search API (no API key needed)
  tools.push(tool(async ({ query }) => {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LoopAgent/1.0)' },
      });
      const html = await resp.text();
      // Extract text snippets from DuckDuckGo HTML results
      const snippets = [];
      const regex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = regex.exec(html)) !== null && snippets.length < 5) {
        snippets.push(match[1].replace(/<\/?b>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").trim());
      }
      if (snippets.length === 0) return 'No search results found.';
      return snippets.map((s, i) => `${i + 1}. ${s}`).join('\n');
    } catch (e) {
      return `Search failed: ${e.message}`;
    }
  }, {
    name: 'web_search',
    description: 'Search the internet for information using DuckDuckGo. Returns top 5 text snippets.',
    schema: z.object({ query: z.string().describe('The search query') }),
  }));

  // 2. Fetch URL — retrieve content from a web page or API endpoint
  tools.push(tool(async ({ url, method, headers: customHeaders, body }) => {
    try {
      const fetchOpts = {
        method: method || 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LoopAgent/1.0)' },
        signal: AbortSignal.timeout(30000),
      };
      if (customHeaders) {
        try {
          const parsed = typeof customHeaders === 'string' ? JSON.parse(customHeaders) : customHeaders;
          Object.assign(fetchOpts.headers, parsed);
        } catch { /* ignore parse errors */ }
      }
      if (body && method && method !== 'GET') {
        fetchOpts.body = body;
        if (!fetchOpts.headers['Content-Type'] && !fetchOpts.headers['content-type']) {
          fetchOpts.headers['Content-Type'] = 'application/json';
        }
      }
      const resp = await fetch(url, fetchOpts);
      const statusLine = `HTTP ${resp.status} ${resp.statusText}`;
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        return `${statusLine}\n${errBody.slice(0, 2000)}`;
      }
      const contentType = resp.headers.get('content-type') || '';
      const text = await resp.text();
      // If JSON or API response, return raw text preserving structure
      if (contentType.includes('json') || contentType.includes('text/plain') || url.includes('/api/')) {
        return text.slice(0, 8000) + (text.length > 8000 ? '\n...(truncated)' : '');
      }
      // For HTML, strip tags
      const clean = text.replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return clean.slice(0, 8000) + (clean.length > 8000 ? '\n...(truncated)' : '');
    } catch (e) {
      return `Fetch failed: ${e.message}`;
    }
  }, {
    name: 'fetch_url',
    description: 'Fetch a URL or call an API endpoint. This is the PREFERRED tool for all HTTP API calls. Supports custom HTTP methods, headers (Authorization, etc.), and request body. Returns raw text for JSON/API responses, cleaned text for HTML pages, max 8000 chars. Use this instead of curl or Python requests.',
    schema: z.object({
      url: z.string().url().describe('The URL to fetch'),
      method: z.string().optional().describe('HTTP method: GET, POST, PUT, DELETE, PATCH. Defaults to GET.'),
      headers: z.string().optional().describe('Custom HTTP headers as a JSON string, e.g. {"Authorization": "Bearer token123"}'),
      body: z.string().optional().describe('Request body string (for POST/PUT/PATCH). Send JSON as a string.'),
    }),
  }));

  // 3. Run JavaScript — execute a JS snippet in a sandboxed VM
  tools.push(tool(async ({ code }) => {
    // Guard: detect Playwright test-style code that expects a browser context.
    // The run_js VM sandbox has NO Playwright, no "page", no "browser", no require().
    if (/\(\s*\{\s*page\s*\}\s*\)\s*=>|\brequire\s*\(\s*['"]playwright/.test(code)) {
      return 'Error: run_js is a bare sandboxed VM with no Playwright/browser access. Use the explore_task tool for browser automation, or screenshot_page for taking screenshots.';
    }
    try {
      const vm = require('vm');
      const sandbox = { console: { log: (...args) => { output.push(args.map(String).join(' ')); } }, result: undefined };
      const output = [];
      const script = new vm.Script(code);
      const context = vm.createContext(sandbox);
      const returnValue = script.runInContext(context, { timeout: 10000 });
      // If the script returns a Promise (e.g. async IIFE), await it to catch
      // async errors like destructuring failures that would otherwise become
      // unhandled rejections and crash the process.
      if (returnValue && typeof returnValue.then === 'function') {
        await returnValue.catch(e => { output.push(`Async error: ${e.message}`); });
      }
      const logs = output.join('\n');
      const result = sandbox.result !== undefined ? String(sandbox.result) : '';
      return [logs, result ? `Result: ${result}` : ''].filter(Boolean).join('\n') || '(no output)';
    } catch (e) {
      return `Execution error: ${e.message}`;
    }
  }, {
    name: 'run_js',
    description: 'Execute a JavaScript code snippet in a sandboxed VM. Set `result` variable to return a value, or use console.log(). Timeout: 10s.',
    schema: z.object({ code: z.string().describe('JavaScript code to execute') }),
  }));

  // 3b. Run Shell — execute a shell command (bash)
  tools.push(tool(async ({ command }) => {
    try {
      const { execSync } = require('child_process');
      const output = execSync(command, {
        encoding: 'utf-8',
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        shell: '/bin/bash',
        env: { ...process.env, LANG: 'en_US.UTF-8' },
      });
      const trimmed = output.trim();
      return trimmed.slice(0, 8000) + (trimmed.length > 8000 ? '\n...(truncated)' : '') || '(no output)';
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString().trim() : '';
      const stdout = e.stdout ? e.stdout.toString().trim() : '';
      return `Exit code: ${e.status || 1}\n${stderr || stdout || e.message}`.slice(0, 4000);
    }
  }, {
    name: 'run_shell',
    description: 'Execute a BASH shell command (/bin/bash). Supports any command including Python, Node.js, curl, git, file operations, package managers, etc. For HTTP API calls, fetch_url is preferred. Timeout: 30s, max output: 8000 chars.',
    schema: z.object({ command: z.string().describe('A bash command, e.g. "curl -s -H \'Authorization: Bearer token\' https://api.example.com/data" or "python3 script.py"') }),
  }));

  // 4. Current DateTime — returns current date and time
  tools.push(tool(async ({ timezone }) => {
    try {
      return new Date().toLocaleString('en-US', { timeZone: timezone || 'UTC', dateStyle: 'full', timeStyle: 'long' });
    } catch {
      return new Date().toISOString();
    }
  }, {
    name: 'current_datetime',
    description: 'Get the current date and time.',
    schema: z.object({ timezone: z.string().optional().describe('IANA timezone, e.g. Asia/Shanghai. Defaults to UTC.') }),
  }));

  // 5. Read Repo File — read a file from the GitHub repository
  if (repoStore) {
    tools.push(tool(async ({ path }) => {
      try {
        const file = await repoStore.readFile(path);
        if (!file) return `File not found: ${path}`;
        return file.content.slice(0, 8000) + (file.content.length > 8000 ? '\n...(truncated)' : '');
      } catch (e) {
        return `Read failed: ${e.message}`;
      }
    }, {
      name: 'read_repo_file',
      description: 'Read a file from the GitHub repository. Returns file content, max 8000 chars.',
      schema: z.object({ path: z.string().describe('File path relative to repo root, e.g. README.md') }),
    }));

    // 6. Write Repo File — write/update a file in the GitHub repository
    // Files are always stored as plain text in the loop data repository.
    function normalizeRepoWritePath(filePath) {
      const normalized = String(filePath || '').replace(/^\/+/, '');
      if (!normalized) return '';
      if (normalized.startsWith('.github/')) return normalized;
      if (normalized.startsWith('artifact/')) return normalized;
      return `artifact/${normalized}`;
    }
    tools.push(tool(async ({ path, content, message }) => {
      try {
        const finalPath = normalizeRepoWritePath(path);
        if (!finalPath) return 'Write failed: path must not be empty';
        await repoStore.writeFileRaw(finalPath, content, message || `[loop-agent] Update ${finalPath}`);
        const artifactUrl = registerArtifactPath(finalPath);
        return artifactUrl
          ? `Successfully wrote ${content.length} chars to ${finalPath}\nArtifact URL: ${artifactUrl}`
          : `Successfully wrote ${content.length} chars to ${finalPath}`;
      } catch (e) {
        return `Write failed: ${e.message}`;
      }
    }, {
      name: 'write_repo_file',
      description: 'Write or update a file in the private loop data repository. Non-.github paths are automatically normalized under artifact/. Files in artifact/ and workflow YAML files are always stored as plain text.',
      schema: z.object({
        path: z.string().describe('File path relative to repo root'),
        content: z.string().describe('File content to write'),
        message: z.string().optional().describe('Commit message'),
      }),
    }));

    // 7. remember — JSON memory persistence (key/value with upsert)
    tools.push(tool(async ({ key, value }) => {
      if (!memoryStore) return 'Memory backend unavailable.';
      try {
        await memoryStore.remember(key, value);
        return `Remembered: ${key} = ${value}`;
      } catch (e) {
        return `Failed to remember: ${e.message}`;
      }
    }, {
      name: 'remember',
      description: 'Save a memory entry into persistent JSON memory. Upserts by key and stores timestamp.',
      schema: z.object({
        key: z.string().describe('Memory key, e.g. user_name or preferred_language'),
        value: z.string().describe('Memory value to store for this key'),
      }),
    }));

    // 8. recall — case-insensitive substring search on key/value
    tools.push(tool(async ({ query }) => {
      if (!memoryStore) return 'Memory backend unavailable.';
      try {
        const matches = await memoryStore.recall(query);
        if (matches.length === 0) return 'No related memory found.';
        return matches
          .map((m, idx) => `${idx + 1}. ${m.key}: ${m.value}`)
          .join('\n');
      } catch (e) {
        return `Failed to recall: ${e.message}`;
      }
    }, {
      name: 'recall',
      description: 'Search persistent JSON memory by keyword. Matches both key and value, case-insensitive.',
      schema: z.object({
        query: z.string().describe('Keyword to search in memory key/value'),
      }),
    }));

    // Backward-compatible aliases for existing prompts/flows.
    tools.push(tool(async ({ key, value }) => {
      if (!memoryStore) return 'Memory backend unavailable.';
      try {
        await memoryStore.remember(key, value);
        return `Memory saved: ${key}`;
      } catch (e) {
        return `Failed to save memory: ${e.message}`;
      }
    }, {
      name: 'save_memory',
      description: 'Alias of remember. Save information to persistent JSON memory.',
      schema: z.object({
        key: z.string().describe('Memory key'),
        value: z.string().describe('Memory value'),
      }),
    }));

    tools.push(tool(async ({ section }) => {
      if (!memoryStore) return 'Memory backend unavailable.';
      try {
        const query = section || '';
        if (!query) {
          const all = memoryStore.entries.slice(0, 50);
          if (all.length === 0) return 'No memory file found. Memory is empty.';
          return all.map((m, idx) => `${idx + 1}. ${m.key}: ${m.value}`).join('\n');
        }
        const matches = await memoryStore.recall(query);
        if (matches.length === 0) return `Section "${section}" not found in memory.`;
        return matches.map(m => `${m.key}: ${m.value}`).join('\n');
      } catch (e) {
        return `Failed to read memory: ${e.message}`;
      }
    }, {
      name: 'read_memory',
      description: 'Alias of recall. Read persistent JSON memory by keyword, or all entries when section is omitted.',
      schema: z.object({
        section: z.string().optional().describe('Keyword to query memory entries, or omit to read all'),
      }),
    }));
  }

  // 9. Unified Skill Search — searches both built-in catalog AND ClawHub
  tools.push(tool(async ({ query }) => {
    try {
      const terms = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
      const results = [];

      // Search built-in catalog
      for (const skill of BUILTIN_SKILLS) {
        const haystack = [skill.name, skill.description, ...skill.keywords].join(' ').toLowerCase();
        if (terms.some(t => haystack.includes(t))) {
          results.push({
            name: skill.name,
            icon: skill.icon,
            description: skill.description,
            loaded: _skillRouter.has(skill.name),
            source: 'builtin',
          });
        }
      }

      // Search ClawHub (non-blocking: if it fails, we still return builtin results)
      try {
        const chUrl = `https://clawhub.ai/api/v1/search?q=${encodeURIComponent(query)}&type=skill`;
        const resp = await fetch(chUrl, {
          headers: { 'User-Agent': 'LittleShrimp-LoopAgent/1.0' },
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          const body = await resp.json();
          for (const r of (body.results || []).slice(0, 5)) {
            results.push({
              name: r.displayName || r.slug,
              slug: r.slug,
              icon: '🔌',
              description: (r.summary || '').slice(0, 150),
              loaded: _skillRouter.has(r.displayName || r.slug),
              source: 'clawhub',
              score: r.score,
            });
          }
        }
      } catch { /* ClawHub unreachable — continue with builtin results */ }

      if (results.length === 0) {
        return `No skills found matching "${query}".\nBuilt-in skills: ${BUILTIN_SKILLS.map(s => `${s.icon} ${s.name}`).join(', ')}`;
      }

      const lines = results.map(r => {
        const status = r.loaded ? '✅ loaded' : '📦 available';
        const src = r.source === 'clawhub' ? `[clawhub: ${r.slug}]` : '[builtin]';
        return `${r.icon} ${r.name} ${src} [${status}] — ${r.description}`;
      });
      return `Found ${results.length} skill(s):\n${lines.join('\n')}\n\nTo load a skill, call load_skill with the skill name (for builtin), a ClawHub slug, or a direct URL.`;
    } catch (e) {
      return `Skill search failed: ${e.message}`;
    }
  }, {
    name: 'search_skills',
    description: 'Search for skills across built-in catalog AND ClawHub community registry. Returns matching skills with load status. Use this when current tools cannot complete a task.',
    schema: z.object({ query: z.string().describe('Search keywords, e.g. "email send" or "translate language"') }),
  }));

  // 10. Unified Skill Loader — loads a skill from URL, builtin name, or ClawHub slug
  tools.push(tool(async ({ source }) => {
    try {
      let url, name, skillSource;

      // 1. Direct URL
      if (source.startsWith('http://') || source.startsWith('https://')) {
        url = source;
        name = source.split('/').pop().replace(/\.[^.]+$/, '') || 'custom-skill';
        skillSource = 'url';
      }
      // 2. Built-in skill name
      else {
        const builtin = BUILTIN_SKILLS.find(s =>
          s.name.toLowerCase() === source.toLowerCase()
        );
        if (builtin) {
          url = SKILLS_BASE_URL + builtin.file;
          name = builtin.name;
          skillSource = 'builtin';
        } else {
          // 3. Try as ClawHub slug — fetch content from ClawHub API
          const chUrl = `https://clawhub.ai/api/v1/skills/${encodeURIComponent(source)}/content`;
          try {
            const resp = await fetch(chUrl, {
              headers: { 'User-Agent': 'LittleShrimp-LoopAgent/1.0' },
              signal: AbortSignal.timeout(15000),
            });
            if (resp.ok) {
              const content = await resp.text();
              const nameMatch = content.match(/^#\s*(.+)/m) || content.match(/name:\s*(.+)/im);
              name = nameMatch ? nameMatch[1].trim() : source;
              if (_skillRouter.has(name)) return `ℹ️ Skill "${name}" is already loaded.`;
              const entry = _skillRouter.register({
                name, source: 'clawhub', url: chUrl, content: content.slice(0, 6000),
              });
              return `✅ Skill "${name}" loaded from ClawHub.\nTriggers: ${entry.triggers.join(', ')}\nThe skill will be active for matching tasks.`;
            }
          } catch { /* fall through */ }

          return `❌ Skill "${source}" not found. Provide a full URL, a built-in skill name, or a ClawHub slug.\nBuilt-in skills: ${BUILTIN_SKILLS.map(s => s.name).join(', ')}`;
        }
      }

      // Check if already loaded
      if (_skillRouter.has(name)) return `ℹ️ Skill "${name}" is already loaded.`;

      // Fetch and register
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const content = await resp.text();

      // Try to extract a better name from content
      const nameMatch = content.match(/^#\s*(.+)/m) || content.match(/name:\s*(.+)/im);
      if (nameMatch) name = nameMatch[1].trim();

      if (_skillRouter.has(name)) return `ℹ️ Skill "${name}" is already loaded.`;

      const entry = _skillRouter.register({
        name, source: skillSource, url, content: content.slice(0, 6000),
      });
      return `✅ Skill "${name}" loaded from ${skillSource}.\nTriggers: ${entry.triggers.join(', ')}\nThe skill will be active for matching tasks.`;
    } catch (e) {
      return `❌ Failed to load skill: ${e.message}`;
    }
  }, {
    name: 'load_skill',
    description: 'Load a skill by URL, built-in name, or ClawHub slug. The skill will be automatically activated for matching tasks via the skill router. Sources: direct URL (any .txt/.md skill file), built-in name (e.g. "Code Review"), or ClawHub slug (e.g. "email-daily-summary").',
    schema: z.object({
      source: z.string().describe('URL, built-in skill name, or ClawHub slug'),
    }),
  }));

  // 11. ClawHub Skill Detail — inspect a skill before loading
  tools.push(tool(async ({ slug }) => {
    try {
      const url = `https://clawhub.ai/api/v1/skills/${encodeURIComponent(slug)}`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'LittleShrimp-LoopAgent/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (resp.status === 404) return `Skill "${slug}" not found on ClawHub.`;
      if (!resp.ok) return `ClawHub detail failed: HTTP ${resp.status}`;
      const body = await resp.json();
      const s = body.skill || {};
      const v = body.latestVersion || {};
      const owner = body.owner || {};
      const mod = body.moderation || {};
      const loaded = _skillRouter.has(s.displayName || s.slug);
      const lines = [
        `**${s.displayName || s.slug}** (${s.slug}) ${loaded ? '✅ loaded' : '📦 available'}`,
        `Summary: ${s.summary || 'N/A'}`,
        `Version: ${v.version || 'N/A'}`,
        `Author: ${owner.handle || 'unknown'}`,
        `Downloads: ${s.stats?.downloads || 0} | Stars: ${s.stats?.stars || 0}`,
        `Safety: ${mod.verdict || 'unknown'}${mod.summary ? ' — ' + mod.summary : ''}`,
        v.changelog ? `Changelog: ${v.changelog.slice(0, 300)}` : '',
        `URL: https://clawhub.ai/skills/${s.slug}`,
        loaded ? '' : `\nTo load: call load_skill with slug "${s.slug}"`,
      ].filter(Boolean);
      return lines.join('\n');
    } catch (e) {
      return `ClawHub detail failed: ${e.message}`;
    }
  }, {
    name: 'clawhub_skill_detail',
    description: 'Get detailed information about a specific ClawHub skill by slug. Inspect safety, author, stats before loading. Use load_skill to actually load a skill.',
    schema: z.object({ slug: z.string().describe('The skill slug, e.g. "email-daily-summary"') }),
  }));

  // 12. Screenshot Page — full-page screenshot using Playwright
  tools.push(tool(async ({ url, waitFor }) => {
    let browser;
    try {
      const { chromium } = require('playwright');
      const path = require('path');
      const fs = require('fs');

      console.log(`[Screenshot] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`[Screenshot] URL: ${url}`);
      console.log(`[Screenshot] Chromium available: ${chromium ? 'YES' : 'NO'}`);

      const artifactDir = '/tmp/loop-agent-artifacts';
      if (!fs.existsSync(artifactDir)) {
        fs.mkdirSync(artifactDir, { recursive: true });
        console.log(`[Screenshot] Created artifact dir`);
      }

      let chromiumPath;
      try {
        chromiumPath = chromium.executablePath();
        console.log(`[Screenshot] Chromium executable: ${chromiumPath}`);
        console.log(`[Screenshot] File exists: ${fs.existsSync(chromiumPath) ? 'YES' : 'NO'}`);
      } catch (pathErr) {
        console.warn(`[Screenshot] Warning: Could not determine chromium path - ${pathErr.message}`);
      }

      console.log(`[Screenshot] Launching browser...`);
      const launchStart = Date.now();
      browser = await chromium.launch({ headless: true });
      console.log(`[Screenshot] Browser launched in ${Date.now() - launchStart}ms`);

      // Use saved browser state (cookies/localStorage) if available from sub-agent.
      // This ensures screenshots reflect the actual authenticated state.
      const browserStatePath = '/tmp/loop-agent-browser-state/storage-state.json';
      const contextOpts = { viewport: { width: 1280, height: 720 } };
      if (fs.existsSync(browserStatePath)) {
        contextOpts.storageState = browserStatePath;
        console.log(`[Screenshot] Loaded saved browser state for auth context`);
      }
      const browserContext = await browser.newContext(contextOpts);

      console.log(`[Screenshot] Creating page (viewport: 1280x720)...`);
      const page = await browserContext.newPage();

      console.log(`[Screenshot] Navigating to ${url}...`);
      const navStart = Date.now();
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      console.log(`[Screenshot] Page loaded in ${Date.now() - navStart}ms`);

      if (waitFor) {
        const waitMs = Math.min(waitFor, 30000);
        console.log(`[Screenshot] Waiting ${waitMs}ms for dynamic content...`);
        await page.waitForTimeout(waitMs);
      }

      console.log(`[Screenshot] Measuring page dimensions...`);
      const dimensions = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      }));
      console.log(`[Screenshot] Page size: ${dimensions.width}x${dimensions.height}px`);

      // Validate dimensions for Telegram compatibility
      if (dimensions.width < 1 || dimensions.height < 1) {
        throw new Error(`Invalid page dimensions: ${dimensions.width}x${dimensions.height}`);
      }

      const timestamp = Date.now();
      const domain = new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, '_');
      const filename = `screenshot-${domain}-${timestamp}.png`;
      const filepath = path.join(artifactDir, filename);

      console.log(`[Screenshot] Taking full-page screenshot...`);
      const shotStart = Date.now();
      // fullPage: true captures entire scrollable content
      // optimizeForSpeed: false for better quality
      await page.screenshot({ 
        path: filepath, 
        fullPage: true,
        type: 'png',
        omitBackground: false,
      });
      console.log(`[Screenshot] Screenshot captured in ${Date.now() - shotStart}ms`);

      await browser.close();
      browser = null;

      // Validate screenshot file
      if (!fs.existsSync(filepath)) {
        throw new Error(`Screenshot file not created: ${filepath}`);
      }

      const stats = fs.statSync(filepath);
      const fileSize = Math.round(stats.size / 1024);
      console.log(`[Screenshot] Saved: ${filename} (${fileSize}KB)`);

      // Verify image integrity with Sharp before sending
      const sharp = require('sharp');
      let metadata;
      try {
        metadata = await sharp(filepath).metadata();
        console.log(`[Screenshot] Image verified: ${metadata.width}x${metadata.height}px, format: ${metadata.format}`);
        if (!metadata.width || !metadata.height || metadata.width < 1 || metadata.height < 1) {
          throw new Error(`Invalid image dimensions: ${metadata.width}x${metadata.height}`);
        }
      } catch (metaErr) {
        console.error(`[Screenshot] Image integrity check failed: ${metaErr.message}`);
        throw new Error(`Screenshot validation failed: ${metaErr.message}`);
      }

      // Send screenshot to user via active channel (Telegram/WeCom)
      const imageSendResult = await sendImageToActiveChannel(filepath, `📸 ${domain}\n${url.slice(0, 80)}${url.length > 80 ? '...' : ''}`);
      console.log(`[Screenshot] Image delivery: ${imageSendResult ? '✓ sent' : '✗ skipped'}`);

      // Get brief AI summary using vision API
      let summary = '';
      try {
        const sharp = require('sharp');
        const provider = process.env.AI_PROVIDER || 'gemini';
        const apiKey = process.env.AI_API_KEY;
        const model = process.env.AI_MODEL || 'gemini-2.0-flash';
        const glmVision = isGlmModel(model);
        const metadata = await sharp(filepath).metadata();
        const maxDim = 2048;
        let imageBuffer;
        let mimeType;
        if (glmVision) {
          let pipeline = sharp(filepath);
          if (metadata.width > maxDim || metadata.height > maxDim) {
            pipeline = pipeline.resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true });
          }
          imageBuffer = await pipeline
            .jpeg({ quality: 85, mozjpeg: true })
            .toBuffer();
          mimeType = 'image/jpeg';
        } else if (metadata.width > maxDim || metadata.height > maxDim) {
          imageBuffer = await sharp(filepath)
            .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
            .png()
            .toBuffer();
          mimeType = 'image/png';
        } else {
          imageBuffer = fs.readFileSync(filepath);
          mimeType = getImageMimeType(metadata.format);
        }
        const base64Data = imageBuffer.toString('base64');
        const summaryPrompt = 'Briefly describe the main content and layout of this web page screenshot in 2-3 sentences. Focus on what information the page presents and its key elements.';

        console.log(`[Screenshot] Requesting AI summary from ${provider}/${model}...`);
        summary = await requestVisionCompletion({
          provider,
          model,
          apiKey,
          promptText: summaryPrompt,
          mimeType,
          base64Data,
        });
        if (summary) console.log(`[Screenshot] Summary obtained (${summary.length} chars)`);
      } catch (sumErr) {
        console.warn(`[Screenshot] Summary failed: ${sumErr.message}`);
      }

      console.log(`[Screenshot] ✓ SUCCESS`);
      console.log(`[Screenshot] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

      const parts = [`Screenshot of ${url} captured and sent to user via active channel.`];
      if (summary) parts.push(`\nPage summary:\n${summary}`);
      parts.push(`\n[File: ${filepath}, ${fileSize}KB]`);
      return parts.join('');
    } catch (e) {
      console.error(`[Screenshot] ❌ FAILED: ${e.message}`);
      if (e.stack) console.error(`[Screenshot] ${e.stack.split('\n').slice(0, 3).join('\n')}`);
      if (browser) try { await browser.close(); } catch { /* ignore */ }
      return `Screenshot failed: ${e.message}`;
    }
  }, {
    name: 'screenshot_page',
    description: 'Take a full-page screenshot of a URL using Playwright. The image is automatically sent to the user via the active channel (Telegram or WeCom) and a brief AI-generated summary is returned. Use when the user wants to see or check a web page.',
    schema: z.object({
      url: z.string().url().describe('The URL to screenshot'),
      waitFor: z.number().optional().describe('Extra wait time in ms after page load for dynamic content (max 30000)'),
    }),
  }));

  // 13. Analyze Page Visual — send screenshot to AI vision for analysis
  tools.push(tool(async ({ imagePath, prompt: userPrompt }) => {
    try {
      const fs = require('fs');
      const sharp = require('sharp');
      if (!fs.existsSync(imagePath)) return `Image not found: ${imagePath}`;

      // Read image and get original dimensions
      const metadata = await sharp(imagePath).metadata();
      const origW = metadata.width;
      const origH = metadata.height;
      const provider = process.env.AI_PROVIDER || 'gemini';
      const apiKey = process.env.AI_API_KEY;
      const model = process.env.AI_MODEL || 'gemini-2.0-flash';
      const glmVision = isGlmModel(model);

      // Resize for API if image is very large (max 4096px longest side)
      const maxDim = 4096;
      let imageBuffer;
      let scale = 1;
      let mimeType;
      if (glmVision) {
        let pipeline = sharp(imagePath);
        if (origW > maxDim || origH > maxDim) {
          pipeline = pipeline.resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true });
          const longerSide = Math.max(origW, origH);
          scale = longerSide / maxDim;
          console.log(`[Vision] Resized from ${origW}x${origH} → scale factor ${scale.toFixed(2)}`);
        }
        imageBuffer = await pipeline
          .jpeg({ quality: 85, mozjpeg: true })
          .toBuffer();
        mimeType = 'image/jpeg';
      } else if (origW > maxDim || origH > maxDim) {
        imageBuffer = await sharp(imagePath)
          .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer();
        mimeType = 'image/png';
        const longerSide = Math.max(origW, origH);
        scale = longerSide / maxDim;
        console.log(`[Vision] Resized from ${origW}x${origH} → scale factor ${scale.toFixed(2)}`);
      } else {
        imageBuffer = fs.readFileSync(imagePath);
        mimeType = getImageMimeType(metadata.format);
      }

      const base64Data = imageBuffer.toString('base64');
      const fileSizeKB = Math.round(imageBuffer.length / 1024);

      const scaleNote = scale > 1
        ? `\nIMPORTANT: The image was resized by a factor of ${scale.toFixed(2)} for analysis. The ORIGINAL image dimensions are ${origW}x${origH} pixels. All coordinates in your response MUST be in the ORIGINAL image coordinate space (multiply your visual coordinates by ${scale.toFixed(2)}).`
        : `\nThe image dimensions are ${origW}x${origH} pixels. Provide coordinates in these dimensions.`;

      const analysisPrompt = userPrompt || `Analyze this full-page screenshot of a web page. Your task:
1. Describe the overall layout and structure of the page.
2. Identify the MOST IMPORTANT content or element on the page (e.g. notifications, alerts, key headlines, call-to-action, critical data).
3. Explain WHY this element is the most important.
4. Provide the approximate bounding box coordinates of the important region in the ORIGINAL image pixel space.
5. Summarize what the important content says or shows.
${scaleNote}

You MUST include the bounding box on its own line in this exact format:
CROP_REGION: {"x": <left>, "y": <top>, "width": <width>, "height": <height>}`;

      console.log(`[Vision] Sending ${fileSizeKB}KB image to ${provider}/${model}...`);
      let responseText = '';

      responseText = await requestVisionCompletion({
        provider,
        model,
        apiKey,
        promptText: analysisPrompt,
        mimeType,
        base64Data,
      });
      if (!responseText) responseText = '(no response)';

      console.log(`[Vision] Analysis complete (${responseText.length} chars)`);
      return `[Image: ${origW}x${origH}px, ${fileSizeKB}KB, scale=${scale.toFixed(2)}]\n\n${responseText}`;
    } catch (e) {
      return `Visual analysis failed: ${e.message}`;
    }
  }, {
    name: 'analyze_page_visual',
    description: 'Send a screenshot to the AI vision model for visual layout analysis. The AI identifies the most important content on the page and returns crop coordinates (CROP_REGION) for the key region. Use after screenshot_page. Returns analysis text with bounding box coordinates.',
    schema: z.object({
      imagePath: z.string().describe('Absolute path to the screenshot image file (from screenshot_page output)'),
      prompt: z.string().optional().describe('Custom analysis prompt (default: identify most important region with crop coordinates)'),
    }),
  }));

  // 14. Crop Image — crop a region from an image using sharp
  tools.push(tool(async ({ imagePath, x, y, width, height }) => {
    try {
      const sharp = require('sharp');
      const path = require('path');
      const fs = require('fs');

      if (!fs.existsSync(imagePath)) return `Image not found: ${imagePath}`;

      const imgMeta = await sharp(imagePath).metadata();

      // Clamp coordinates to image bounds
      const cropX = Math.max(0, Math.round(Math.min(x, imgMeta.width - 1)));
      const cropY = Math.max(0, Math.round(Math.min(y, imgMeta.height - 1)));
      const cropW = Math.max(1, Math.round(Math.min(width, imgMeta.width - cropX)));
      const cropH = Math.max(1, Math.round(Math.min(height, imgMeta.height - cropY)));

      const artifactDir = '/tmp/loop-agent-artifacts';
      if (!fs.existsSync(artifactDir)) fs.mkdirSync(artifactDir, { recursive: true });

      const basename = path.basename(imagePath, path.extname(imagePath));
      const outputFilename = `${basename}-crop-${cropX}_${cropY}_${cropW}x${cropH}.png`;
      const outputPath = path.join(artifactDir, outputFilename);

      await sharp(imagePath)
        .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
        .toFile(outputPath);

      const stats = fs.statSync(outputPath);
      console.log(`[Crop] Saved ${outputFilename} (${Math.round(stats.size / 1024)}KB, ${cropW}x${cropH})`);

      // Send cropped image to user via active channel (Telegram/WeCom)
      await sendImageToActiveChannel(outputPath, `🔍 Cropped region (${cropW}x${cropH})`);

      return JSON.stringify({
        success: true,
        path: outputPath,
        filename: outputFilename,
        region: { x: cropX, y: cropY, width: cropW, height: cropH },
        fileSize: stats.size,
      });
    } catch (e) {
      return `Crop failed: ${e.message}`;
    }
  }, {
    name: 'crop_image',
    description: 'Crop a rectangular region from an image and send it to the user via the active channel (Telegram or WeCom). Use coordinates from analyze_page_visual CROP_REGION output. Coordinates are clamped to image bounds.',
    schema: z.object({
      imagePath: z.string().describe('Absolute path to the source image'),
      x: z.number().describe('Left edge X coordinate in pixels'),
      y: z.number().describe('Top edge Y coordinate in pixels'),
      width: z.number().describe('Width of the crop region in pixels'),
      height: z.number().describe('Height of the crop region in pixels'),
    }),
  }));

  // ── create_scheduled_task: Register a cron task in the loop agent ──
  tools.push(tool(async ({ name, description, cron, prompt }) => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
    const taskRecordPath = `loop-agent/schedules/${slug}.json`;

    // Validate basic cron format (5 fields)
    const cronFields = cron.trim().split(/\s+/);
    if (cronFields.length !== 5) {
      return `Error: cron expression must have exactly 5 fields (min hour dom month dow). Got: "${cron}"`;
    }

    const record = {
      name, slug, description, cron, prompt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastRunAt: null,
      executions: [],
    };

    // Persist task record to repo (so it survives restarts)
    if (repoStore) {
      try {
        await repoStore.writeFile(taskRecordPath, JSON.stringify(record, null, 2), `[scheduled] Create task ${name}`);
      } catch (e) {
        return `Failed to save task record: ${e.message}`;
      }
    }

    // Register in the in-process scheduler so it fires immediately
    _scheduleManager.register(record);

    return `Scheduled task "${name}" created.\n- Cron: ${cron}\n- Record: ${taskRecordPath}\n\nThe loop agent will execute this task on schedule and notify you via configured channels.`;
  }, {
    name: 'create_scheduled_task',
    description: 'Create a scheduled task that the loop agent executes internally on a cron schedule. When the time comes, the agent processes the given prompt as if a user sent it and delivers the result to configured notification channels (Telegram, email, etc.). No GitHub Actions involved.',
    schema: z.object({
      name: z.string().describe('Human-readable task name (e.g. "Daily Weather Report")'),
      description: z.string().describe('Brief description of what this task does'),
      cron: z.string().describe('Cron expression in 5-field UTC format (e.g. "0 9 * * *" for daily at 09:00 UTC)'),
      prompt: z.string().describe('The prompt the agent should process on each execution (e.g. "Summarize the top 3 AI news stories today")'),
    }),
  }));

  // ── list_scheduled_tasks: List all registered scheduled tasks ──────
  tools.push(tool(async () => {
    // First show in-memory tasks (fastest, always up-to-date)
    const memTasks = _scheduleManager.getAll();

    // Also scan repo for any tasks not yet loaded into memory
    if (repoStore) {
      try {
        const resp = await fetch(
          `${repoStore.api}/repos/${repoStore.owner}/${repoStore.repo}/contents/loop-agent/schedules?ref=main`,
          { headers: repoStore._headers() }
        );
        if (resp.ok) {
          const files = await resp.json();
          for (const f of files.filter(f => f.name.endsWith('.json'))) {
            const slug = f.name.replace('.json', '');
            if (!_scheduleManager.get(slug)) {
              try {
                const data = await repoStore.readFile(`loop-agent/schedules/${f.name}`);
                if (data) {
                  const rec = JSON.parse(data.content);
                  if (rec.deleted === true) continue;
                  if (rec.slug && rec.cron && rec.prompt) {
                    _scheduleManager.register(rec);
                  }
                }
              } catch { /* skip corrupted */ }
            }
          }
        }
      } catch { /* non-fatal */ }
    }

    const all = _scheduleManager.getAll();
    if (all.length === 0) return 'No scheduled tasks. Use create_scheduled_task to add one.';

    const lines = all.map(t => {
      const last = t.lastRunAt ? new Date(t.lastRunAt).toISOString() : 'never';
      return `- **${t.name}** (slug: \`${t.slug}\`)\n  Cron: \`${t.cron}\`\n  ${t.description || ''}\n  Prompt: ${t.prompt.slice(0, 120)}${t.prompt.length > 120 ? '...' : ''}\n  Last run: ${last}`;
    });
    return `## Scheduled Tasks (${all.length})\n\n${lines.join('\n\n')}`;
  }, {
    name: 'list_scheduled_tasks',
    description: 'List all scheduled tasks registered with the loop agent, showing their cron schedule, prompt, and last execution time.',
    schema: z.object({}),
  }));

  // ── delete_scheduled_task: Remove a scheduled task ────────────────
  tools.push(tool(async ({ slug }) => {
    const removedFromMemory = _scheduleManager.unregister(slug);
    let removedFromRepo = false;

    // Always attempt repo deletion; the task might not be loaded in memory yet.
    if (repoStore) {
      try {
        const path = `loop-agent/schedules/${slug}.json`;
        const del = await repoStore.deleteFile(path, `[scheduled] Delete task ${slug}`);
        removedFromRepo = !!(del && del.deleted);
      } catch (e) {
        // Fallback tombstone to prevent resurrection on reboot if hard delete failed.
        try {
          const path = `loop-agent/schedules/${slug}.json`;
          const tombstone = {
            slug,
            deleted: true,
            deletedAt: new Date().toISOString(),
          };
          await repoStore.writeFile(path, JSON.stringify(tombstone, null, 2), `[scheduled] Tombstone task ${slug}`);
          removedFromRepo = true;
        } catch {
          return `Failed to delete task "${slug}": ${e.message}`;
        }
      }
    }

    if (!removedFromMemory && !removedFromRepo) {
      return `No task found with slug "${slug}". Use list_scheduled_tasks to see available tasks.`;
    }

    return `Scheduled task "${slug}" has been removed and will no longer run.`;
  }, {
    name: 'delete_scheduled_task',
    description: 'Delete a scheduled task so it no longer runs. Use list_scheduled_tasks first to get the slug.',
    schema: z.object({
      slug: z.string().describe('The task slug to delete (shown in list_scheduled_tasks output)'),
    }),
  }));

  // ── GitHub API Tools ──────────────────────────────────────────────
  // Dedicated GitHub REST API tools that use GH_PAT directly.
  // These MUST be used for all GitHub operations instead of browser/fetch_url
  // to avoid conflicts with browser-based tools.

  const ghPat = process.env.GH_PAT;
  const ghRepo = process.env.GITHUB_REPOSITORY; // owner/repo
  if (ghPat) {
    const ghHeaders = (pat) => ({
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    });

    // Helper: resolve owner/repo — uses provided target_repo or falls back to session repo
    const resolveRepo = (targetRepo) => {
      const repo = targetRepo || ghRepo;
      if (!repo || !repo.includes('/')) return null;
      const [owner, name] = repo.split('/');
      return { owner, name, full: repo };
    };

    // gh.1 List Issues
    tools.push(tool(async ({ target_repo, state, labels, per_page }) => {
      const r = resolveRepo(target_repo);
      if (!r) return 'Error: No target repo specified and no default GITHUB_REPOSITORY.';
      try {
        const params = new URLSearchParams();
        if (state) params.set('state', state);
        if (labels) params.set('labels', labels);
        params.set('per_page', String(per_page || 10));
        const resp = await fetch(
          `https://api.github.com/repos/${r.full}/issues?${params}`,
          { headers: ghHeaders(ghPat) }
        );
        if (!resp.ok) return `GitHub API error ${resp.status}: ${await resp.text()}`;
        const issues = await resp.json();
        if (issues.length === 0) return `No issues found in ${r.full} (state: ${state || 'open'}).`;
        return issues.map(i =>
          `#${i.number} [${i.state}] ${i.title}${i.labels.length ? ' (' + i.labels.map(l => l.name).join(', ') + ')' : ''} — ${i.user.login}`
        ).join('\n');
      } catch (e) { return `Failed: ${e.message}`; }
    }, {
      name: 'github_list_issues',
      description: 'List issues in a GitHub repository. Defaults to the session repo if target_repo is omitted.',
      schema: z.object({
        target_repo: z.string().optional().describe('owner/repo (e.g. "octocat/Hello-World"). Defaults to session repo.'),
        state: z.enum(['open', 'closed', 'all']).optional().describe('Filter by state (default: open)'),
        labels: z.string().optional().describe('Comma-separated label names to filter by'),
        per_page: z.number().optional().describe('Results per page (default: 10, max: 100)'),
      }),
    }));

    // gh.2 Create Issue
    tools.push(tool(async ({ target_repo, title, body, labels, assignees }) => {
      const r = resolveRepo(target_repo);
      if (!r) return 'Error: No target repo specified and no default GITHUB_REPOSITORY.';
      try {
        const payload = { title };
        if (body) payload.body = body;
        if (labels) payload.labels = labels.split(',').map(l => l.trim());
        if (assignees) payload.assignees = assignees.split(',').map(a => a.trim());
        const resp = await fetch(
          `https://api.github.com/repos/${r.full}/issues`,
          { method: 'POST', headers: ghHeaders(ghPat), body: JSON.stringify(payload) }
        );
        if (!resp.ok) return `GitHub API error ${resp.status}: ${await resp.text()}`;
        const issue = await resp.json();
        return `Issue #${issue.number} created: ${issue.html_url}`;
      } catch (e) { return `Failed: ${e.message}`; }
    }, {
      name: 'github_create_issue',
      description: 'Create a new issue in a GitHub repository.',
      schema: z.object({
        target_repo: z.string().optional().describe('owner/repo. Defaults to session repo.'),
        title: z.string().describe('Issue title'),
        body: z.string().optional().describe('Issue body (Markdown supported)'),
        labels: z.string().optional().describe('Comma-separated label names'),
        assignees: z.string().optional().describe('Comma-separated GitHub usernames to assign'),
      }),
    }));

    // gh.3 Update Issue (edit title/body/state/labels)
    tools.push(tool(async ({ target_repo, issue_number, title, body, state, labels }) => {
      const r = resolveRepo(target_repo);
      if (!r) return 'Error: No target repo specified.';
      try {
        const payload = {};
        if (title) payload.title = title;
        if (body) payload.body = body;
        if (state) payload.state = state;
        if (labels) payload.labels = labels.split(',').map(l => l.trim());
        const resp = await fetch(
          `https://api.github.com/repos/${r.full}/issues/${issue_number}`,
          { method: 'PATCH', headers: ghHeaders(ghPat), body: JSON.stringify(payload) }
        );
        if (!resp.ok) return `GitHub API error ${resp.status}: ${await resp.text()}`;
        const issue = await resp.json();
        return `Issue #${issue.number} updated (state: ${issue.state}): ${issue.html_url}`;
      } catch (e) { return `Failed: ${e.message}`; }
    }, {
      name: 'github_update_issue',
      description: 'Update an existing issue — change title, body, state (open/closed), or labels.',
      schema: z.object({
        target_repo: z.string().optional().describe('owner/repo'),
        issue_number: z.number().describe('Issue number'),
        title: z.string().optional().describe('New title'),
        body: z.string().optional().describe('New body'),
        state: z.enum(['open', 'closed']).optional().describe('Set issue state'),
        labels: z.string().optional().describe('Replace labels (comma-separated)'),
      }),
    }));

    // gh.4 Comment on Issue/PR
    tools.push(tool(async ({ target_repo, issue_number, body }) => {
      const r = resolveRepo(target_repo);
      if (!r) return 'Error: No target repo specified.';
      try {
        const resp = await fetch(
          `https://api.github.com/repos/${r.full}/issues/${issue_number}/comments`,
          { method: 'POST', headers: ghHeaders(ghPat), body: JSON.stringify({ body }) }
        );
        if (!resp.ok) return `GitHub API error ${resp.status}: ${await resp.text()}`;
        const comment = await resp.json();
        return `Comment added to #${issue_number}: ${comment.html_url}`;
      } catch (e) { return `Failed: ${e.message}`; }
    }, {
      name: 'github_comment_issue',
      description: 'Add a comment to an issue or pull request.',
      schema: z.object({
        target_repo: z.string().optional().describe('owner/repo'),
        issue_number: z.number().describe('Issue or PR number'),
        body: z.string().describe('Comment body (Markdown supported)'),
      }),
    }));

    // gh.5 List Pull Requests
    tools.push(tool(async ({ target_repo, state, per_page }) => {
      const r = resolveRepo(target_repo);
      if (!r) return 'Error: No target repo specified.';
      try {
        const params = new URLSearchParams();
        if (state) params.set('state', state);
        params.set('per_page', String(per_page || 10));
        const resp = await fetch(
          `https://api.github.com/repos/${r.full}/pulls?${params}`,
          { headers: ghHeaders(ghPat) }
        );
        if (!resp.ok) return `GitHub API error ${resp.status}: ${await resp.text()}`;
        const prs = await resp.json();
        if (prs.length === 0) return `No pull requests found in ${r.full} (state: ${state || 'open'}).`;
        return prs.map(p =>
          `#${p.number} [${p.state}${p.merged_at ? '/merged' : ''}] ${p.title} (${p.head.ref} → ${p.base.ref}) — ${p.user.login}`
        ).join('\n');
      } catch (e) { return `Failed: ${e.message}`; }
    }, {
      name: 'github_list_pulls',
      description: 'List pull requests in a GitHub repository.',
      schema: z.object({
        target_repo: z.string().optional().describe('owner/repo'),
        state: z.enum(['open', 'closed', 'all']).optional().describe('Filter by state (default: open)'),
        per_page: z.number().optional().describe('Results per page (default: 10, max: 100)'),
      }),
    }));

    // gh.6 Create Pull Request
    tools.push(tool(async ({ target_repo, title, body, head, base }) => {
      const r = resolveRepo(target_repo);
      if (!r) return 'Error: No target repo specified.';
      try {
        const resp = await fetch(
          `https://api.github.com/repos/${r.full}/pulls`,
          { method: 'POST', headers: ghHeaders(ghPat), body: JSON.stringify({ title, body: body || '', head, base }) }
        );
        if (!resp.ok) return `GitHub API error ${resp.status}: ${await resp.text()}`;
        const pr = await resp.json();
        return `PR #${pr.number} created: ${pr.html_url}`;
      } catch (e) { return `Failed: ${e.message}`; }
    }, {
      name: 'github_create_pull',
      description: 'Create a new pull request.',
      schema: z.object({
        target_repo: z.string().optional().describe('owner/repo'),
        title: z.string().describe('PR title'),
        body: z.string().optional().describe('PR description (Markdown)'),
        head: z.string().describe('Head branch name (the branch with changes)'),
        base: z.string().describe('Base branch name (target, e.g. "main")'),
      }),
    }));

    // gh.7 Merge Pull Request
    tools.push(tool(async ({ target_repo, pull_number, merge_method, commit_title }) => {
      const r = resolveRepo(target_repo);
      if (!r) return 'Error: No target repo specified.';
      try {
        const payload = {};
        if (merge_method) payload.merge_method = merge_method;
        if (commit_title) payload.commit_title = commit_title;
        const resp = await fetch(
          `https://api.github.com/repos/${r.full}/pulls/${pull_number}/merge`,
          { method: 'PUT', headers: ghHeaders(ghPat), body: JSON.stringify(payload) }
        );
        if (!resp.ok) return `GitHub API error ${resp.status}: ${await resp.text()}`;
        const result = await resp.json();
        return `PR #${pull_number} merged: ${result.message}`;
      } catch (e) { return `Failed: ${e.message}`; }
    }, {
      name: 'github_merge_pull',
      description: 'Merge a pull request.',
      schema: z.object({
        target_repo: z.string().optional().describe('owner/repo'),
        pull_number: z.number().describe('PR number'),
        merge_method: z.enum(['merge', 'squash', 'rebase']).optional().describe('Merge strategy (default: merge)'),
        commit_title: z.string().optional().describe('Custom merge commit title'),
      }),
    }));

    // gh.8 List Branches
    tools.push(tool(async ({ target_repo, per_page }) => {
      const r = resolveRepo(target_repo);
      if (!r) return 'Error: No target repo specified.';
      try {
        const resp = await fetch(
          `https://api.github.com/repos/${r.full}/branches?per_page=${per_page || 30}`,
          { headers: ghHeaders(ghPat) }
        );
        if (!resp.ok) return `GitHub API error ${resp.status}: ${await resp.text()}`;
        const branches = await resp.json();
        return branches.map(b => `${b.name}${b.protected ? ' 🔒' : ''}`).join('\n');
      } catch (e) { return `Failed: ${e.message}`; }
    }, {
      name: 'github_list_branches',
      description: 'List branches in a GitHub repository.',
      schema: z.object({
        target_repo: z.string().optional().describe('owner/repo'),
        per_page: z.number().optional().describe('Results per page (default: 30)'),
      }),
    }));

    // gh.9 Create Branch
    tools.push(tool(async ({ target_repo, branch_name, from_branch }) => {
      const r = resolveRepo(target_repo);
      if (!r) return 'Error: No target repo specified.';
      try {
        // Get SHA of source branch
        const refResp = await fetch(
          `https://api.github.com/repos/${r.full}/git/ref/heads/${from_branch || 'main'}`,
          { headers: ghHeaders(ghPat) }
        );
        if (!refResp.ok) return `Source branch not found: ${await refResp.text()}`;
        const sha = (await refResp.json()).object.sha;
        // Create new ref
        const resp = await fetch(
          `https://api.github.com/repos/${r.full}/git/refs`,
          { method: 'POST', headers: ghHeaders(ghPat), body: JSON.stringify({ ref: `refs/heads/${branch_name}`, sha }) }
        );
        if (!resp.ok) return `GitHub API error ${resp.status}: ${await resp.text()}`;
        return `Branch "${branch_name}" created from ${from_branch || 'main'} (SHA: ${sha.slice(0, 7)})`;
      } catch (e) { return `Failed: ${e.message}`; }
    }, {
      name: 'github_create_branch',
      description: 'Create a new branch from an existing branch.',
      schema: z.object({
        target_repo: z.string().optional().describe('owner/repo'),
        branch_name: z.string().describe('New branch name'),
        from_branch: z.string().optional().describe('Source branch (default: main)'),
      }),
    }));

    // gh.10 List Repos (for the authenticated user)
    tools.push(tool(async ({ type, sort, per_page }) => {
      try {
        const params = new URLSearchParams();
        if (type) params.set('type', type);
        if (sort) params.set('sort', sort);
        params.set('per_page', String(per_page || 10));
        const resp = await fetch(
          `https://api.github.com/user/repos?${params}`,
          { headers: ghHeaders(ghPat) }
        );
        if (!resp.ok) return `GitHub API error ${resp.status}: ${await resp.text()}`;
        const repos = await resp.json();
        if (repos.length === 0) return 'No repositories found.';
        return repos.map(r =>
          `${r.full_name}${r.private ? ' 🔒' : ''} — ${r.description || '(no description)'}  ⭐${r.stargazers_count}`
        ).join('\n');
      } catch (e) { return `Failed: ${e.message}`; }
    }, {
      name: 'github_list_repos',
      description: 'List GitHub repositories for the authenticated user.',
      schema: z.object({
        type: z.enum(['all', 'owner', 'public', 'private', 'member']).optional().describe('Repo type filter'),
        sort: z.enum(['created', 'updated', 'pushed', 'full_name']).optional().describe('Sort order'),
        per_page: z.number().optional().describe('Results per page (default: 10)'),
      }),
    }));

    // gh.11 Create Repository
    tools.push(tool(async ({ name, description, is_private, auto_init }) => {
      try {
        const payload = { name, private: is_private || false, auto_init: auto_init !== false };
        if (description) payload.description = description;
        const resp = await fetch(
          'https://api.github.com/user/repos',
          { method: 'POST', headers: ghHeaders(ghPat), body: JSON.stringify(payload) }
        );
        if (!resp.ok) return `GitHub API error ${resp.status}: ${await resp.text()}`;
        const repo = await resp.json();
        return `Repository created: ${repo.html_url}`;
      } catch (e) { return `Failed: ${e.message}`; }
    }, {
      name: 'github_create_repo',
      description: 'Create a new GitHub repository for the authenticated user.',
      schema: z.object({
        name: z.string().describe('Repository name'),
        description: z.string().optional().describe('Repository description'),
        is_private: z.boolean().optional().describe('Create as private repo (default: false)'),
        auto_init: z.boolean().optional().describe('Initialize with README (default: true)'),
      }),
    }));

    // gh.12 Get File Content (from any repo)
    tools.push(tool(async ({ target_repo, path, ref }) => {
      const r = resolveRepo(target_repo);
      if (!r) return 'Error: No target repo specified.';
      try {
        const url = `https://api.github.com/repos/${r.full}/contents/${path}${ref ? '?ref=' + ref : ''}`;
        const resp = await fetch(url, { headers: ghHeaders(ghPat) });
        if (resp.status === 404) return `File not found: ${path} in ${r.full}`;
        if (!resp.ok) return `GitHub API error ${resp.status}: ${await resp.text()}`;
        const data = await resp.json();
        if (Array.isArray(data)) {
          // It's a directory
          return data.map(f => `${f.type === 'dir' ? '📁' : '📄'} ${f.name} (${f.type})`).join('\n');
        }
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        return content.slice(0, 8000) + (content.length > 8000 ? '\n...(truncated)' : '');
      } catch (e) { return `Failed: ${e.message}`; }
    }, {
      name: 'github_get_content',
      description: 'Get file content or list directory from any accessible GitHub repository. For the session repo, prefer read_repo_file instead.',
      schema: z.object({
        target_repo: z.string().optional().describe('owner/repo'),
        path: z.string().describe('File or directory path'),
        ref: z.string().optional().describe('Branch/tag/SHA (default: default branch)'),
      }),
    }));

    // gh.13 List Workflow Runs
    tools.push(tool(async ({ target_repo, status, per_page }) => {
      const r = resolveRepo(target_repo);
      if (!r) return 'Error: No target repo specified.';
      try {
        const params = new URLSearchParams();
        if (status) params.set('status', status);
        params.set('per_page', String(per_page || 10));
        const resp = await fetch(
          `https://api.github.com/repos/${r.full}/actions/runs?${params}`,
          { headers: ghHeaders(ghPat) }
        );
        if (!resp.ok) return `GitHub API error ${resp.status}: ${await resp.text()}`;
        const data = await resp.json();
        if (!data.workflow_runs || data.workflow_runs.length === 0) return `No workflow runs found.`;
        return data.workflow_runs.map(run =>
          `#${run.id} [${run.status}/${run.conclusion || 'pending'}] ${run.name} — ${run.head_branch} (${new Date(run.created_at).toISOString()})`
        ).join('\n');
      } catch (e) { return `Failed: ${e.message}`; }
    }, {
      name: 'github_list_runs',
      description: 'List GitHub Actions workflow runs for a repository.',
      schema: z.object({
        target_repo: z.string().optional().describe('owner/repo'),
        status: z.enum(['completed', 'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'success', 'timed_out', 'in_progress', 'queued', 'requested', 'waiting', 'pending']).optional().describe('Filter by run status'),
        per_page: z.number().optional().describe('Results per page (default: 10)'),
      }),
    }));

    // gh.14 Dispatch Workflow
    tools.push(tool(async ({ target_repo, workflow_id, ref, inputs }) => {
      const r = resolveRepo(target_repo);
      if (!r) return 'Error: No target repo specified.';
      try {
        const payload = { ref: ref || 'main' };
        if (inputs) {
          try { payload.inputs = typeof inputs === 'string' ? JSON.parse(inputs) : inputs; } catch { /* ignore */ }
        }
        const resp = await fetch(
          `https://api.github.com/repos/${r.full}/actions/workflows/${workflow_id}/dispatches`,
          { method: 'POST', headers: ghHeaders(ghPat), body: JSON.stringify(payload) }
        );
        if (!resp.ok) return `GitHub API error ${resp.status}: ${await resp.text()}`;
        return `Workflow "${workflow_id}" dispatched on ${ref || 'main'}.`;
      } catch (e) { return `Failed: ${e.message}`; }
    }, {
      name: 'github_dispatch_workflow',
      description: 'Trigger a GitHub Actions workflow via workflow_dispatch event.',
      schema: z.object({
        target_repo: z.string().optional().describe('owner/repo'),
        workflow_id: z.string().describe('Workflow file name (e.g. "ci.yml") or numeric ID'),
        ref: z.string().optional().describe('Git ref to run on (default: main)'),
        inputs: z.string().optional().describe('Workflow inputs as JSON string'),
      }),
    }));

    // gh.15 Add Labels to Issue/PR
    tools.push(tool(async ({ target_repo, issue_number, labels }) => {
      const r = resolveRepo(target_repo);
      if (!r) return 'Error: No target repo specified.';
      try {
        const resp = await fetch(
          `https://api.github.com/repos/${r.full}/issues/${issue_number}/labels`,
          { method: 'POST', headers: ghHeaders(ghPat), body: JSON.stringify({ labels: labels.split(',').map(l => l.trim()) }) }
        );
        if (!resp.ok) return `GitHub API error ${resp.status}: ${await resp.text()}`;
        const result = await resp.json();
        return `Labels updated on #${issue_number}: ${result.map(l => l.name).join(', ')}`;
      } catch (e) { return `Failed: ${e.message}`; }
    }, {
      name: 'github_add_labels',
      description: 'Add labels to a GitHub issue or pull request.',
      schema: z.object({
        target_repo: z.string().optional().describe('owner/repo'),
        issue_number: z.number().describe('Issue or PR number'),
        labels: z.string().describe('Comma-separated label names to add'),
      }),
    }));

    console.log(`[Tools] GitHub API tools registered (PAT: ${ghPat.slice(0, 4)}***${ghPat.slice(-4)})`);
  }

  // ── Browser Agent tool (ReAct browser automation) ──
  if (llm) {
    try {
      const { createBrowserTool } = require('./browser-agent');
      tools.push(createBrowserTool(llm, notifyFn, sendImageToActiveChannel));
    } catch (e) {
      console.warn(`[Tools] browser-agent not available: ${e.message}`);
    }
  }

  // ── Explorer Sub-Agent tool (code generation & execution) ──
  if (llm) {
    try {
      const { createExplorerTool } = require('./sub-agent');
      tools.push(createExplorerTool(llm, repoStore, notifyFn, sendImageToActiveChannel));
    } catch (e) {
      console.warn(`[Tools] sub-agent not available: ${e.message}`);
    }
  }

  return tools;
}

// ─── Content Extraction Helper ────────────────────────────────────

/**
 * Extract text string from LLM response content.
 * Gemini may return content as an array of {type:'text',text:'...'} objects.
 */
function extractTextContent(content) {
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

function normalizeMemoryText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function buildTaskCacheKey(taskText) {
  const normalized = normalizeMemoryText(taskText);
  const digest = nodeCrypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
  return { key: `task_cache:${digest}`, normalized };
}

function isTaskCacheable(taskText, responseText) {
  const query = normalizeMemoryText(taskText);
  if (!query || query.length < 6) return false;
  if (!responseText || String(responseText).startsWith('[Error]')) return false;
  if (String(responseText).length > 12000) return false;
  const volatilePattern = /\b(now|current|latest|today|yesterday|status|runtime|remaining|time|date|weather|stock|price)\b|现在|当前|今天|时间|状态|天气/i;
  if (volatilePattern.test(query)) return false;
  return true;
}

class AgentMemoryStore {
  constructor(repoStore, memoryPath) {
    this.repoStore = repoStore;
    this.memoryPath = memoryPath;
    this.entries = [];
    this._loaded = false;
  }

  _sanitizeEntries(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(e => e && typeof e.key === 'string' && typeof e.value === 'string')
      .map(e => ({
        key: e.key,
        value: e.value,
        timestamp: e.timestamp || new Date().toISOString(),
      }));
  }

  async load() {
    if (this._loaded) return;
    if (!this.repoStore) {
      this.entries = [];
      this._loaded = true;
      return;
    }
    try {
      const file = await this.repoStore.readFile(this.memoryPath);
      if (!file) {
        this.entries = [];
      } else {
        this.entries = this._sanitizeEntries(JSON.parse(file.content));
      }
    } catch (e) {
      console.warn(`[Memory] Failed to load ${this.memoryPath}: ${e.message}`);
      this.entries = [];
    }
    this._loaded = true;
  }

  async save(message = '[loop-agent] Update memory.json') {
    if (!this.repoStore) return;
    await this.repoStore.writeFileRaw(
      this.memoryPath,
      JSON.stringify(this.entries, null, 2),
      message
    );
  }

  async remember(key, value) {
    await this.load();
    const ts = new Date().toISOString();
    const idx = this.entries.findIndex(e => e.key === key);
    if (idx >= 0) {
      this.entries[idx] = { key, value, timestamp: ts };
    } else {
      this.entries.push({ key, value, timestamp: ts });
    }
    await this.save(`[loop-agent] remember ${key}`);
    return { key, value, timestamp: ts };
  }

  async recall(query) {
    await this.load();
    const q = normalizeMemoryText(query);
    if (!q) return this.entries.slice(0, 50);
    return this.entries.filter(e => {
      const k = normalizeMemoryText(e.key);
      const v = normalizeMemoryText(e.value);
      return k.includes(q) || v.includes(q);
    });
  }

  async clear() {
    await this.load();
    this.entries = [];
    await this.save('[loop-agent] Clear memory');
  }

  async getTaskCache(taskText) {
    await this.load();
    const { key, normalized } = buildTaskCacheKey(taskText);
    const entry = this.entries.find(e => e.key === key);
    if (!entry) return null;
    try {
      const payload = JSON.parse(entry.value);
      if (normalizeMemoryText(payload.task) !== normalized) return null;
      return payload;
    } catch {
      return null;
    }
  }

  async rememberTaskResult(taskText, responseText) {
    if (!isTaskCacheable(taskText, responseText)) return;
    const { key, normalized } = buildTaskCacheKey(taskText);
    const payload = {
      task: normalized,
      response: String(responseText),
      savedAt: new Date().toISOString(),
    };
    await this.remember(key, JSON.stringify(payload));
  }

  async getPromptSnapshot(maxChars = 2000) {
    await this.load();
    if (this.entries.length === 0) return '';
    const text = this.entries
      .slice(-30)
      .map(e => `${e.key}: ${e.value}`)
      .join('\n');
    return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
  }
}

// ─── LLM Factory ────────────────────────────────────────────────────

function createLLM(provider, model, apiKey) {
  if (provider === 'gemini') {
    const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
    const resolvedGeminiKey = apiKey || process.env.AI_API_KEY || process.env.GEMINI_API_KEY || '';
    if (!resolvedGeminiKey) {
      throw new Error('Missing API key for gemini. Set AI_API_KEY (or GEMINI_API_KEY).');
    }
    return new ChatGoogleGenerativeAI({ model, apiKey: resolvedGeminiKey, maxRetries: 2 });
  }
  // For qwen/kimi/openai/other OpenAI-compatible providers
  const { ChatOpenAI } = require('@langchain/openai');
  const resolvedProvider = resolveModelProvider(provider, model);
  const baseURLMap = {
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    kimi: 'https://api.moonshot.cn/v1',
    openai: 'https://api.openai.com/v1',
  };
  const resolvedApiKey = (
    apiKey ||
    process.env.AI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.QWEN_API_KEY ||
    process.env.KIMI_API_KEY ||
    ''
  );
  if (!resolvedApiKey) {
    throw new Error(`Missing API key for ${resolvedProvider}. Set AI_API_KEY (or OPENAI_API_KEY).`);
  }

  const baseURL = process.env.AI_BASE_URL || baseURLMap[resolvedProvider] || baseURLMap.openai;
  return new ChatOpenAI({
    model,
    apiKey: resolvedApiKey,
    openAIApiKey: resolvedApiKey,
    configuration: { baseURL },
    maxRetries: 2,
  });
}

// ─── State: The "blood" flowing through the graph ──────────────────
//
// State is the single source of truth for the entire graph.
// Every node receives State as input and returns a mutated State.
// It persists across node transitions via the Checkpointer.

function createInitialState() {
  return {
    // Core graph phase
    phase: 'analyze',
    intent: '',
    requiredParams: {},
    collectedParams: {},
    missingParams: {},
    _waitRounds: 0,

    // Extensions (skills/soul)
    _skills: [],           // SkillRouter serialized data
    _loadedSoul: null,

    // Node execution history — records every node transition
    nodeHistory: [],
    // Per-node timing statistics (accumulated)
    timing: {
      analyze: { calls: 0, totalMs: 0, lastMs: 0 },
      validate: { calls: 0, totalMs: 0, lastMs: 0 },
      askUser: { calls: 0, totalMs: 0, lastMs: 0 },
      onUserReply: { calls: 0, totalMs: 0, lastMs: 0 },
      execute: { calls: 0, totalMs: 0, lastMs: 0 },
    },
    // Turn counter — increments per user message
    turnCount: 0,
    // Last error info for recovery/debugging
    lastError: null,
    // Thread identifier
    threadId: '',
  };
}

/**
 * Merge a partial update into an existing state, preserving structure.
 * Only updates fields present in the patch.
 */
function mergeState(state, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'timing' && typeof value === 'object') {
      state.timing = { ...state.timing, ...value };
    } else if (key === 'nodeHistory' && Array.isArray(value)) {
      state.nodeHistory = value;
    } else {
      state[key] = value;
    }
  }
  return state;
}

// ─── Checkpointer: External "recorder" at node boundaries ─────────
//
// The Checkpointer sits at the graph boundary. After EVERY node
// finishes and returns a new State, the Checkpointer intercepts it
// and persists a snapshot to the repo. It uses threadId (loopKey)
// to distinguish different conversations.
//
// This ensures that even if the process crashes mid-execution,
// the last completed node's state is recoverable.

class Checkpointer {
  constructor(repoStore, historyPath) {
    this._repoStore = repoStore;
    this._historyPath = historyPath;
    this._checkpointCount = 0;
  }

  /**
   * Save a checkpoint after a node completes.
   * @param {string} threadId — The conversation/loop key
   * @param {string} nodeName — Which node just completed
   * @param {object} state — The full state to persist
   */
  async save(threadId, nodeName, state) {
    if (!this._repoStore) return;
    this._checkpointCount++;
    const checkpoint = {
      threadId,
      nodeName,
      checkpointIndex: this._checkpointCount,
      savedAt: Date.now(),
      state,
    };
    try {
      const path = `${this._historyPath}/${threadId}.state.json`;
      await this._repoStore.writeFile(
        path,
        JSON.stringify(checkpoint, null, 2),
        `[loop-agent] Checkpoint #${this._checkpointCount} after ${nodeName}`
      );
      console.log(`[Checkpointer] ✓ Saved checkpoint #${this._checkpointCount} after [${nodeName}] (thread: ${threadId})`);
    } catch (e) {
      console.warn(`[Checkpointer] Failed to save after ${nodeName}: ${e.message}`);
    }
  }

  /**
   * Load the latest checkpoint for a thread.
   * Returns the state or a fresh initial state if none found.
   */
  async load(threadId) {
    if (!this._repoStore) return createInitialState();
    try {
      const path = `${this._historyPath}/${threadId}.state.json`;
      const file = await this._repoStore.readFile(path);
      if (file) {
        const checkpoint = JSON.parse(file.content);
        const state = checkpoint.state || checkpoint;
        // Ensure all fields exist (forward-compatible with new fields)
        const full = createInitialState();
        mergeState(full, state);
        full.threadId = threadId;
        console.log(`[Checkpointer] Loaded checkpoint (node: ${checkpoint.nodeName || 'unknown'}, #${checkpoint.checkpointIndex || '?'}, phase: ${full.phase})`);
        return full;
      }
    } catch (e) {
      console.warn(`[Checkpointer] Failed to load: ${e.message}`);
    }
    const fresh = createInitialState();
    fresh.threadId = threadId;
    return fresh;
  }
}

// ─── Node Timing Helper ────────────────────────────────────────────

/**
 * Record timing for a node execution and print it.
 * @param {object} state — The State object
 * @param {string} nodeName — Node identifier (analyze, validate, etc.)
 * @param {number} startMs — performance.now() or Date.now() at start
 * @param {number} endMs — performance.now() or Date.now() at end
 */
function recordNodeTiming(state, nodeName, startMs, endMs) {
  const elapsed = Math.round(endMs - startMs);
  if (!state.timing) state.timing = {};
  if (!state.timing[nodeName]) {
    state.timing[nodeName] = { calls: 0, totalMs: 0, lastMs: 0 };
  }
  const t = state.timing[nodeName];
  t.calls++;
  t.totalMs += elapsed;
  t.lastMs = elapsed;

  // Record in node history
  if (!state.nodeHistory) state.nodeHistory = [];
  state.nodeHistory.push({
    node: nodeName,
    phase: state.phase,
    ts: Date.now(),
    durationMs: elapsed,
  });
  // Keep history bounded
  if (state.nodeHistory.length > 200) {
    state.nodeHistory = state.nodeHistory.slice(-100);
  }

  console.log(`[Timing] Node [${nodeName}] completed in ${elapsed}ms (calls: ${t.calls}, avg: ${Math.round(t.totalMs / t.calls)}ms, total: ${t.totalMs}ms)`);
}

/**
 * Print a summary of all node timing statistics.
 */
function printTimingSummary(state) {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║           Node Timing Summary                    ║');
  console.log('╠══════════════════════════════════════════════════╣');
  const timing = state.timing || {};
  let totalMs = 0;
  for (const [node, t] of Object.entries(timing)) {
    if (t.calls > 0) {
      const avg = Math.round(t.totalMs / t.calls);
      console.log(`║  ${node.padEnd(14)} │ calls: ${String(t.calls).padStart(3)} │ last: ${String(t.lastMs).padStart(6)}ms │ avg: ${String(avg).padStart(6)}ms │ total: ${String(t.totalMs).padStart(8)}ms ║`);
      totalMs += t.totalMs;
    }
  }
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  TOTAL: ${String(totalMs).padStart(8)}ms across ${state.turnCount || 0} turns${' '.repeat(16)}║`);
  console.log('╚══════════════════════════════════════════════════╝\n');
}

// ─── 4-Node Agent Graph ─────────────────────────────────────────────
//
// Implements the OpenClaw-inspired stateful graph:
//   Start → Analyze → Validate → Ask_User (missing) ↔ Validate
//                               → Execute  (complete)
//
// State flows through every node. The Checkpointer saves state
// after each node completes. This ensures crash-resilient,
// long-memory operation.

class AgentGraph {
  constructor({ llm, tools, systemPrompt, repoStore, memoryStore, checkpointer, threadId }) {
    this.llm = llm;
    this.systemPrompt = systemPrompt;
    this._repoStore = repoStore || null;
    this._memoryStore = memoryStore || null;
    this._tools = tools;
    this._loadedSoul = null;   // { name, url, content } or null
    this._checkpointer = checkpointer || null;
    this._threadId = threadId || '';

    this._rebuildExecutor();
  }

  /**
   * Rebuild the ReAct executor. Only called when soul changes.
   * Skills are NOT baked into the base prompt — they are injected
   * per-message in _execute() via the SkillRouter for isolation.
   */
  _rebuildExecutor() {
    const { createReactAgent } = require('@langchain/langgraph/prebuilt');
    const defaultPrompt = `You are a helpful AI assistant running as a persistent loop agent in GitHub Actions.

Available tools:
- fetch_url: Fetch any URL or call non-GitHub API endpoints. Supports custom HTTP methods, headers, and JSON body.
- web_search: Search the internet for information.
- run_shell: Execute BASH commands only (curl, git, apt-get, file ops). NOT for Python/JS code.
- run_js: Execute JavaScript in a sandboxed VM.
- current_datetime: Get current time.
- read_repo_file / write_repo_file: Read/write files in the private LOOP_DATA_REPOSITORY.
- remember / recall: Persistent key-value memory across conversations (JSON memory).
- search_skills: Unified search across built-in skill catalog AND ClawHub community registry.
- load_skill: Load a skill by URL, built-in name, or ClawHub slug.
- clawhub_skill_detail: Inspect a ClawHub skill before loading.
- screenshot_page: Take a full-page screenshot of a URL, send it to user via active channel (Telegram/WeCom).
- analyze_page_visual: Detailed visual analysis of a screenshot.
- crop_image: Crop a region from an image and send it via active channel (Telegram/WeCom).
- explore_task: Explorer sub-agent for complex tasks. Browser automation (ReAct loop) or code generation.

GITHUB API TOOLS (use these for ALL GitHub operations):
- github_list_issues: List issues in any repo
- github_create_issue: Create a new issue
- github_update_issue: Update/close an issue
- github_comment_issue: Comment on an issue or PR
- github_list_pulls: List pull requests
- github_create_pull: Create a pull request
- github_merge_pull: Merge a pull request
- github_list_branches: List branches
- github_create_branch: Create a new branch
- github_list_repos: List your repositories
- github_create_repo: Create a new repository
- github_get_content: Get file/directory from any repo
- github_list_runs: List GitHub Actions workflow runs
- github_dispatch_workflow: Trigger a workflow
- github_add_labels: Add labels to issues/PRs

PAGE SCREENSHOT (when user asks to screenshot or view a URL):
1. screenshot_page — captures the full page, sends image to user via active channel, returns a brief summary
Include the summary in your response. The image is already delivered.

DEEP VISUAL ANALYSIS (when user asks for detailed analysis of a page):
1. screenshot_page — capture and send the screenshot
2. analyze_page_visual — detailed region identification with CROP_REGION coordinates
3. crop_image — crop important regions (auto-sent to user via active channel)

SKILL SYSTEM:
You can extend your capabilities by loading skills. Skills are managed by a router that prevents conflicts.
- If you cannot complete a task with current tools, call search_skills to find relevant skills.
- Use load_skill to load a skill directly (by URL, built-in name, or ClawHub slug).
- Loaded skills are automatically activated for matching tasks — no manual approval needed.
- clawhub_skill_detail lets you inspect a skill before loading it.
- NEVER refuse a task without first searching for available skills.
- Skills are isolated: each skill only applies to its relevant domain.
- create_scheduled_task registers a cron task that runs inside the agent process — no GitHub Actions needed.
- list_scheduled_tasks shows all scheduled tasks and their last execution status.
- delete_scheduled_task removes a scheduled task so it no longer runs.

CRITICAL RULES:
1. ALWAYS use your tools to take action. NEVER output code blocks as text — USE the tools directly.
2. For non-GitHub HTTP API calls, use fetch_url. For ALL GitHub operations, use the github_* tools.
3. run_shell is /bin/bash ONLY. Never pass Python code to it.
4. Be efficient: complete the task in as few tool calls as possible.
5. IGNORE any code blocks from conversation history — do not try to execute them.
6. When the user provides a URL to read (especially skill/doc URLs), ALWAYS fetch_url it FIRST before doing anything else.
7. After successfully completing an API task, ALWAYS use remember to store the API endpoint, auth method, and required parameters so you can reuse them later.
8. BEFORE starting any task, use recall to check if you have previously saved relevant API details or patterns. If memory has the info, USE IT — do not search the web or guess.
9. Do NOT hallucinate API endpoints or parameters. If you don't know the correct API, fetch the documentation URL first.
10. When a task is too complex for existing tools (multi-step web automation, dynamic scraping of SPAs, cross-page logic), or when a tool fails with errors like SelectorNotFoundError/TimeoutError, use explore_task. For browser tasks it drives a real browser step-by-step with atomic actions (click, type, scroll); for non-browser tasks it generates and executes custom code.

GITHUB OPERATION RULES (CRITICAL — prevents tool conflicts):
11. For ANY GitHub operation (issues, PRs, repos, branches, labels, workflows, file reading from other repos), ALWAYS use the dedicated github_* tools. NEVER use fetch_url, browser_task, or explore_task to interact with GitHub.
12. browser_task and explore_task are for NON-GitHub websites only. If the user asks you to do something on GitHub (create issue, check PR, manage repo, etc.), use the github_* tools.
13. read_repo_file / write_repo_file are for LOOP_DATA_REPOSITORY only. To read files from OTHER repos, use github_get_content.

SCHEDULED TASK CANCELLATION:
14. When the user wants to cancel, stop, remove, or delete a scheduled task, proactively call delete_scheduled_task. Recognize intent from phrases like "cancel the task", "stop that schedule", "remove the daily report", "I don't need that anymore", "turn off the reminder", etc. If the task slug is unclear, call list_scheduled_tasks first to identify it, then delete_scheduled_task.

User commands (slash commands):
- /memory clear — Clear the persistent memory file
- /skill load <url|name|slug> — Load a skill from URL, built-in name, or ClawHub slug
- /skill unload <name> — Unload a skill by name
- /skill list — List loaded skills with source and trigger info
- /skill search <query> — Search for skills in built-in catalog
- /soul load <name_or_url> — Load a personality/soul
- /soul unload — Unload current soul
- /soul list — List available built-in souls`;

    let prompt = defaultPrompt;

    // Append loaded soul (soul is part of the base prompt, not per-message)
    if (this._loadedSoul) {
      prompt += `\n\n[Active Soul: ${this._loadedSoul.name}]\n${this._loadedSoul.content}`;
    }

    // NOTE: Skills are NOT injected here. They are injected per-message
    // in _execute() via the SkillRouter for proper isolation.

    if (this.systemPrompt) {
      prompt += `\n\nAdditional instructions:\n${this.systemPrompt}`;
    }

    this.executor = createReactAgent({ llm: this.llm, tools: this._tools, messageModifier: prompt });
    const skillCount = _skillRouter.listAll().length;
    console.log(`[Graph] Executor rebuilt. Soul: ${this._loadedSoul?.name || 'none'}, Skills in router: ${skillCount}`);
  }

  /** Restore skills/soul state from persisted State */
  restoreExtensions(state) {
    // Restore skills into SkillRouter (new format)
    if (state._skills?.length > 0) {
      _skillRouter.fromJSON(state._skills);
      console.log(`[Graph] Restored ${_skillRouter.listAll().length} skills from state`);
    }
    // Backward compatibility: old _loadedSkills format → migrate to router
    else if (state._loadedSkills?.length > 0) {
      for (const s of state._loadedSkills) {
        _skillRouter.register({
          name: s.name, source: 'url', url: s.url, content: s.content,
        });
      }
      console.log(`[Graph] Migrated ${state._loadedSkills.length} skills from legacy format`);
    }

    if (state._loadedSoul) {
      this._loadedSoul = state._loadedSoul;
      console.log(`[Graph] Restored soul: ${this._loadedSoul.name}`);
    }

    // Rebuild only if soul changed (skills don't need rebuild)
    if (this._loadedSoul) {
      this._rebuildExecutor();
    }
  }

  /** Save current skill/soul state into State for persistence */
  _syncExtensionsToState(state) {
    state._skills = _skillRouter.toJSON();
    state._loadedSoul = this._loadedSoul;
  }

  /** Checkpoint helper: save state after a node completes */
  async _checkpoint(nodeName, state) {
    if (this._checkpointer) {
      await this._checkpointer.save(this._threadId, nodeName, state);
    }
  }

  /**
   * Process a user message through the 4-node graph.
   * State flows through every node. Checkpointer saves after each node.
   * Returns { response }.
   */
  async process(userText, state, conversationMessages) {
    state.turnCount = (state.turnCount || 0) + 1;
    state.lastError = null;
    // Store current user text for per-message skill routing in _execute()
    state._currentUserText = userText;
    const phase = state.phase || 'analyze';
    console.log(`\n[Graph] ═══ Turn #${state.turnCount} ═══ Phase: ${phase}, input: ${userText.length} chars`);

    if (phase === 'waiting_for_params') {
      return this._onUserReply(userText, state, conversationMessages);
    }
    return this._analyze(userText, state, conversationMessages);
  }

  // ── Analyze Node ──────────────────────────────────────────────────
  async _analyze(userText, state, conversationMessages) {
    const startMs = Date.now();
    const { SystemMessage, HumanMessage } = require('@langchain/core/messages');
    updateTaskProgress({ node: 'analyze', stage: 'classifying_intent' });
    appendTaskThought('Analyzing user intent and deciding direct execution vs multi-step flow.');

    // CODE-LEVEL OVERRIDE: If user message contains a URL, always classify as "direct".
    const hasUrl = /https?:\/\/\S+/i.test(userText);
    if (hasUrl) {
      console.log(`[Graph] Analyze → direct (URL detected in message, skipping LLM classification)`);
      state.phase = 'analyze';
      state.intent = 'Read URL and follow instructions';
      state.requiredParams = {};
      state.collectedParams = {};
      appendTaskThought('Detected URL in request, routing directly to execution.');
      recordNodeTiming(state, 'analyze', startMs, Date.now());
      await this._checkpoint('analyze', state);
      return this._execute(state, conversationMessages);
    }

    // CODE-LEVEL OVERRIDE: If user wants to cancel/stop/remove a scheduled task, go direct.
    const cancelSchedulePattern = /\b(cancel|stop|remove|delete|取消|停止|关闭|删除|turn\s*off|不[要需]了)\b.*\b(schedule|task|定时|任务|提醒|cron|daily|weekly|hourly|report|reminder)\b|\b(schedule|task|定时|任务|cron)\b.*\b(cancel|stop|remove|delete|取消|停止|关闭|删除|turn\s*off|不[要需]了)\b/i;
    if (cancelSchedulePattern.test(userText)) {
      console.log(`[Graph] Analyze → direct (schedule cancellation intent detected)`);
      state.phase = 'analyze';
      state.intent = 'Cancel/delete a scheduled task';
      state.requiredParams = {};
      state.collectedParams = {};
      appendTaskThought('Detected schedule cancellation intent, routing directly to execution tools.');
      recordNodeTiming(state, 'analyze', startMs, Date.now());
      await this._checkpoint('analyze', state);
      return this._execute(state, conversationMessages);
    }

    // CODE-LEVEL OVERRIDE: If message references GitHub operations, go direct.
    const githubOpPattern = /\b(issue|pull\s*request|PR|merge|branch|repo|workflow|label)\b.*\b(create|list|close|open|update|delete|check|add|remove|view|get|show)\b|\b(create|list|close|open|update|delete|check|add|remove|view|get|show)\b.*\b(issue|pull\s*request|PR|merge|branch|repo|workflow|label)\b|\bgithub\b/i;
    if (githubOpPattern.test(userText)) {
      console.log(`[Graph] Analyze → direct (GitHub operation detected, using github_* tools)`);
      state.phase = 'analyze';
      state.intent = userText;
      state.requiredParams = {};
      state.collectedParams = {};
      appendTaskThought('Detected GitHub operation intent, routing directly to github tools.');
      recordNodeTiming(state, 'analyze', startMs, Date.now());
      await this._checkpoint('analyze', state);
      return this._execute(state, conversationMessages);
    }

    // CODE-LEVEL OVERRIDE: If this is a follow-up request for a similar task
    const shortMessage = userText.length < 200;
    const recentHistory = conversationMessages.slice(-4);
    const hadRecentSuccess = recentHistory.some(m => {
      const text = extractTextContent(m.content);
      return text && /成功|successfully|completed|done/i.test(text);
    });
    if (shortMessage && hadRecentSuccess) {
      console.log(`[Graph] Analyze → direct (follow-up after recent success)`);
      state.phase = 'analyze';
      state.intent = userText;
      state.requiredParams = {};
      state.collectedParams = {};
      appendTaskThought('Detected likely follow-up request after recent success, routing directly to execution.');
      recordNodeTiming(state, 'analyze', startMs, Date.now());
      await this._checkpoint('analyze', state);
      return this._execute(state, conversationMessages);
    }

    const analyzePrompt = `You are an analysis agent. Examine the user's latest message and determine how to proceed.

Available tools (these are REAL tools you can call in the execution phase):
- web_search: Search the internet via DuckDuckGo
- fetch_url: Fetch and read ANY URL's content (NON-GitHub pages, external APIs). Supports custom HTTP methods, headers, and request body.
- run_js: Execute JavaScript code in a sandboxed VM
- run_shell: Execute shell commands (bash) — curl, git, apt-get, jq, etc.
- current_datetime: Get current date and time
- read_repo_file / write_repo_file: Read/write files in LOOP_DATA_REPOSITORY
- remember / recall: Persistent memory storage
- search_skills: Unified search across built-in skills and ClawHub community registry
- load_skill: Load a skill by URL, built-in name, or ClawHub slug
- clawhub_skill_detail: Get full details for a ClawHub skill by slug
- explore_task: Explorer sub-agent for complex tasks — uses a ReAct browser loop for non-GitHub web automation or code generation
- github_list_issues / github_create_issue / github_update_issue / github_comment_issue: Issue operations
- github_list_pulls / github_create_pull / github_merge_pull: PR operations
- github_list_branches / github_create_branch: Branch operations
- github_list_repos / github_create_repo / github_get_content: Repo operations
- github_list_runs / github_dispatch_workflow: Actions/workflow operations
- github_add_labels: Label management
- create_scheduled_task / list_scheduled_tasks / delete_scheduled_task: Scheduled task management

Classify the request:
1. "direct" — Can be handled with the available tools above. This includes:
   - Reading ANY URL or web page (use fetch_url for non-GitHub, github_get_content for GitHub)
   - ALL GitHub operations: issues, PRs, branches, repos, workflows (use github_* tools)
   - Making API calls with authentication (use fetch_url for non-GitHub APIs, run_shell with curl)
   - Running shell/CLI commands (use run_shell)
   - Web searches, code tasks, file operations, general conversation
   - Tasks described in external skill/tool documents
   - ANY follow-up request to repeat or modify a previously successful task
   - Cancelling, stopping, or removing a scheduled task (use delete_scheduled_task)
2. "multi_step" — ONLY use this when the user's request genuinely requires credentials or configuration that:
   a) The user has NOT provided in any previous message, AND
   b) Cannot be obtained via the available tools above, AND
   c) Cannot be found in the agent's persistent memory

Respond with ONLY valid JSON (no markdown code blocks):
{
  "type": "direct" or "multi_step",
  "intent": "brief description of what the user wants",
  "required_params": {"param_name": "why it's needed"},
  "collected_params": {"param_name": "extracted value from message"}
}

CRITICAL rules:
- Default to "direct". 99% of requests should be "direct".
- If a previous task succeeded recently, a similar follow-up is ALWAYS "direct".
- Only classify as "multi_step" if the user explicitly needs to provide a password, API key, or account credential that they haven't mentioned yet AND cannot be in memory.
- NEVER invent tool names that are not in the list above.
- Cancelling/stopping/removing a scheduled task is ALWAYS "direct".`;

    const recentMessages = conversationMessages.slice(-6);
    const result = await this.llm.invoke([
      new SystemMessage(analyzePrompt),
      ...recentMessages,
      new HumanMessage(userText),
    ]);

    const analysis = this._parseJSON(extractTextContent(result.content));

    if (!analysis || analysis.type === 'direct') {
      console.log(`[Graph] Analyze → direct (intent classified)`);
      state.phase = 'analyze';
      state.intent = analysis?.intent || '';
      state.requiredParams = {};
      state.collectedParams = {};
      appendTaskThought(`Intent classified as direct. Intent summary: ${analysis?.intent || 'not provided by classifier'}`);
      recordNodeTiming(state, 'analyze', startMs, Date.now());
      await this._checkpoint('analyze', state);
      return this._execute(state, conversationMessages);
    }

    console.log(`[Graph] Analyze → multi_step`);
    state.intent = analysis.intent;
    state.requiredParams = analysis.required_params || {};
    state.collectedParams = analysis.collected_params || {};
    appendTaskThought(`Intent classified as multi-step. Required params: ${Object.keys(analysis.required_params || {}).join(', ') || 'none'}`);
    recordNodeTiming(state, 'analyze', startMs, Date.now());
    await this._checkpoint('analyze', state);
    return this._validate(state, conversationMessages);
  }

  // ── Validation Node (pure logic) ─────────────────────────────────
  _validate(state, conversationMessages) {
    const startMs = Date.now();
    updateTaskProgress({ node: 'validate', stage: 'checking_required_params' });
    const required = state.requiredParams || {};
    const collected = state.collectedParams || {};

    const missing = {};
    for (const [param, desc] of Object.entries(required)) {
      if (!collected[param] || collected[param] === '') {
        missing[param] = desc;
      }
    }

    const missCount = Object.keys(missing).length;
    console.log(`[Graph] Validate: ${Object.keys(required).length} required, ${Object.keys(collected).length} collected, ${missCount} missing`);

    if (missCount === 0) {
      appendTaskThought('All required parameters are available. Proceeding to execution.');
      state.phase = 'execute';
      state._waitRounds = 0;
      recordNodeTiming(state, 'validate', startMs, Date.now());
      // No async checkpoint here — execute will checkpoint after itself
      return this._execute(state, conversationMessages);
    }

    state.phase = 'waiting_for_params';
    state.missingParams = missing;
    appendTaskThought(`Missing parameters detected (${missCount}). Asking user for additional input.`);
    recordNodeTiming(state, 'validate', startMs, Date.now());
    return this._askUser(state, conversationMessages);
  }

  // ── Ask_User Node ─────────────────────────────────────────────────
  async _askUser(state, conversationMessages) {
    const startMs = Date.now();
    const { SystemMessage } = require('@langchain/core/messages');
    updateTaskProgress({ node: 'ask_user', stage: 'waiting_for_user_input' });

    const missingList = Object.entries(state.missingParams || {})
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');
    const collectedStr = JSON.stringify(state.collectedParams || {}, null, 2);

    const askPrompt = `You are helping the user complete a task: "${state.intent}".

The following information is still needed:
${missingList}

Already collected:
${collectedStr}

Ask the user for the missing information in a natural, friendly way. Be concise.`;

    const result = await this.llm.invoke([
      new SystemMessage(askPrompt),
      ...conversationMessages.slice(-4),
    ]);

    console.log(`[Graph] Ask_User → waiting for params`);
    recordNodeTiming(state, 'askUser', startMs, Date.now());
    await this._checkpoint('askUser', state);
    return { response: extractTextContent(result.content) };
  }

  // ── Handle user reply (resume from Ask_User) ─────────────────────
  async _onUserReply(userText, state, conversationMessages) {
    const startMs = Date.now();
    const { SystemMessage, HumanMessage } = require('@langchain/core/messages');
    updateTaskProgress({ node: 'on_user_reply', stage: 'extracting_user_parameters' });
    appendTaskThought('Received follow-up input while collecting parameters. Extracting candidate values.');

    // Escape valve: if stuck in waiting_for_params for too many rounds,
    // or user message seems unrelated to parameter collection, reset to analyze.
    const waitRounds = (state._waitRounds || 0) + 1;
    state._waitRounds = waitRounds;
    if (waitRounds > 3) {
      console.log(`[Graph] Escape valve: stuck in waiting_for_params for ${waitRounds} rounds, resetting to analyze`);
      state.phase = 'analyze';
      state.intent = '';
      state.requiredParams = {};
      state.collectedParams = {};
      state.missingParams = {};
      state._waitRounds = 0;
      appendTaskIssue('Parameter collection exceeded safe retry rounds; resetting flow to analyze to avoid deadlock.');
      recordNodeTiming(state, 'onUserReply', startMs, Date.now());
      await this._checkpoint('onUserReply', state);
      return this._analyze(userText, state, conversationMessages);
    }

    const missingList = Object.entries(state.missingParams || {})
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    const collectedStr = JSON.stringify(state.collectedParams || {});

    const extractPrompt = `Extract parameter values from the user's message.

We need: ${missingList}
Already have: ${collectedStr}

If the user provides any requested values, extract them.
If the user wants to cancel, change the task, asks a different question, or seems confused about capabilities, set "cancel": true.

Respond with ONLY valid JSON (no markdown):
{
  "extracted": {"param_name": "extracted_value"},
  "cancel": false
}`;

    const result = await this.llm.invoke([
      new SystemMessage(extractPrompt),
      new HumanMessage(userText),
    ]);

    const parsed = this._parseJSON(extractTextContent(result.content));

    if (parsed?.cancel) {
      console.log(`[Graph] User cancelled task`);
      state.phase = 'analyze';
      state.intent = '';
      state.requiredParams = {};
      state.collectedParams = {};
      state.missingParams = {};
      state._waitRounds = 0;
      appendTaskThought('User indicated cancellation or context switch; returning to analyze node.');
      recordNodeTiming(state, 'onUserReply', startMs, Date.now());
      await this._checkpoint('onUserReply', state);
      return this._analyze(userText, state, conversationMessages);
    }

    if (parsed?.extracted) {
      state.collectedParams = { ...state.collectedParams, ...parsed.extracted };
      appendTaskThought(`Extracted parameters: ${Object.keys(parsed.extracted).join(', ')}`);
      console.log(`[Graph] Extracted params: ${Object.keys(parsed.extracted).join(', ')}`);
    }

    recordNodeTiming(state, 'onUserReply', startMs, Date.now());
    await this._checkpoint('onUserReply', state);
    return this._validate(state, conversationMessages);
  }

  // ── Execution Node (ReAct agent with tools) ──────────────────────
  async _execute(state, conversationMessages) {
    const startMs = Date.now();
    const { HumanMessage, AIMessage } = require('@langchain/core/messages');
    updateTaskProgress({ node: 'execute', stage: 'running_tools_and_reasoning' });
    appendTaskThought('Invoking execution agent with recent conversation context and tools.');

    // Pre-load persistent memory so the executor has context from previous successes
    let memoryContext = '';
    try {
      if (this._memoryStore) {
        memoryContext = await this._memoryStore.getPromptSnapshot(2000);
      }
    } catch { /* ignore - memory is optional */ }

    // Pass enough recent messages for context but strip hallucinated code blocks.
    // Use last 10 messages to preserve multi-step task context.
    let execMessages = conversationMessages.slice(-10).map(m => {
      // Strip code blocks from assistant messages to prevent the ReAct agent
      // from trying to "execute" previously hallucinated code
      if (m._getType?.() === 'ai' || m.constructor?.name === 'AIMessage') {
        const text = extractTextContent(m.content);
        if (text && /```(?:python|bash|javascript|js|sh)?\s*\n/i.test(text)) {
          const cleaned = text.replace(/```(?:python|bash|javascript|js|sh)?\s*\n[\s\S]*?```/gi,
            '[code block removed — use tools directly instead]');
          return new AIMessage(cleaned);
        }
      }
      return m;
    });
    const params = state.collectedParams || {};

    if (Object.keys(params).length > 0) {
      execMessages = [
        new HumanMessage(`[Task Parameters]\n${JSON.stringify(params, null, 2)}\nPlease use these parameters when executing the task.`),
        new AIMessage('Understood. I will use these collected parameters.'),
        ...execMessages,
      ];
    }

    // Inject memory context so executor knows about previously successful patterns
    if (memoryContext) {
      execMessages = [
        new HumanMessage(`[Persistent Memory — previously saved API details and patterns]\n${memoryContext}\nUse this information if relevant to the current task. Do NOT search the web for info already in memory.`),
        new AIMessage('Understood. I will refer to saved memory for known API details and patterns.'),
        ...execMessages,
      ];
    }

    // Per-message skill routing: inject only relevant skills for the current task.
    // This prevents unrelated skills from interfering with each other.
    const currentUserText = state._currentUserText || '';
    const matchedSkills = _skillRouter.match(currentUserText);
    if (matchedSkills.length > 0) {
      const skillSection = _skillRouter.buildPromptSection(matchedSkills);
      execMessages = [
        new HumanMessage(`${skillSection}\nApply the relevant skill instructions for the current task. Each <skill> section is independent — do not mix instructions from different skills.`),
        new AIMessage('Understood. I will apply the matching skill instructions for the current task.'),
        ...execMessages,
      ];
      console.log(`[Graph] Skill Router: injected ${matchedSkills.length} skill(s): ${matchedSkills.map(s => s.name).join(', ')}`);
    }

    let result;
    try {
      result = await this.executor.invoke(
        { messages: execMessages },
        { recursionLimit: 60 }
      );
    } catch (execErr) {
      // If recursion limit hit, try to extract partial response
      if (execErr.message && execErr.message.includes('Recursion limit')) {
        console.warn(`[Graph] Recursion limit hit, returning partial result`);
        appendTaskIssue(`Execution recursion limit reached: ${execErr.message}`);
        state.lastError = { node: 'execute', message: execErr.message, ts: Date.now() };
        recordNodeTiming(state, 'execute', startMs, Date.now());
        await this._checkpoint('execute', state);
        return { response: `I attempted to complete the task but it required too many steps. Please break it down into smaller requests, or provide specific information I'm missing.` };
      }
      appendTaskIssue(`Execution error: ${execErr.message}`);
      state.lastError = { node: 'execute', message: execErr.message, ts: Date.now() };
      recordNodeTiming(state, 'execute', startMs, Date.now());
      await this._checkpoint('execute', state);
      throw execErr;
    }

    const toolMsgs = result.messages.filter(
      m => m._getType?.() === 'tool' || m.constructor?.name === 'ToolMessage'
    );
    if (toolMsgs.length > 0) {
      console.log(`[Graph] Execute used ${toolMsgs.length} tool(s): ${toolMsgs.map(m => m.name || 'unknown').join(', ')}`);
      appendTaskThought(`Tools used: ${toolMsgs.map(m => m.name || 'unknown').join(', ')}`);
    }

    const lastMsg = result.messages[result.messages.length - 1];
    const responseText = extractTextContent(lastMsg.content) || '(empty response)';
    console.log(`[Graph] Execute response: ${responseText.length} chars`);

    state.phase = 'analyze';
    state.intent = '';
    state.requiredParams = {};
    state.collectedParams = {};
    state.missingParams = {};

    recordNodeTiming(state, 'execute', startMs, Date.now());
    await this._checkpoint('execute', state);
    printTimingSummary(state);

    return { response: responseText };
  }

  /** Parse JSON tolerantly from LLM output */
  _parseJSON(text) {
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
}

// ─── Message Protocol ───────────────────────────────────────────────

/**
 * Upstash message format:
 * {
 *   "ts": 1234567890,
 *   "from": "user",
 *   "text": "Hello world",
 *   "extra": {},
 *   "read": false
 * }
 */

function parseMessage(raw) {
  if (!raw) return null;
  try {
    const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!msg.text || msg.read) return null;
    return msg;
  } catch {
    return null;
  }
}

function markAsRead(msg) {
  return JSON.stringify({ ...msg, read: true });
}

function createResponse(text) {
  return JSON.stringify({
    ts: Date.now(),
    from: 'agent',
    text,
    extra: {},
    read: false,
  });
}

// ─── Conversation History ───────────────────────────────────────────

class ConversationHistory {
  constructor(repoStore, historyPath) {
    this.repoStore = repoStore;
    this.historyPath = historyPath;
    this.messages = []; // { role, content, ts }
  }

  async load() {
    try {
      const file = await this.repoStore.readFile(`${this.historyPath}.json`);
      if (file) {
        this.messages = JSON.parse(file.content);
        console.log(`[History] Loaded ${this.messages.length} messages`);
      }
    } catch (e) {
      console.warn(`[History] Failed to load: ${e.message}`);
      this.messages = [];
    }
  }

  addUser(text) {
    this.messages.push({ role: 'user', content: text, ts: Date.now() });
  }

  addAssistant(text) {
    // Ensure text is always a string (Gemini may return multi-part arrays)
    const content = typeof text === 'string' ? text : extractTextContent(text);
    this.messages.push({ role: 'assistant', content, ts: Date.now() });
  }

  /** Get messages suitable for LangGraph input */
  async toLangChainMessages() {
    const { HumanMessage, AIMessage } = require('@langchain/core/messages');
    return this.messages.map(m =>
      m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)
    );
  }

  async save() {
    try {
      await this.repoStore.writeFile(
        `${this.historyPath}.json`,
        JSON.stringify(this.messages, null, 2),
        `[loop-agent] Update conversation history (${this.messages.length} messages)`
      );
      console.log(`[History] Saved ${this.messages.length} messages`);
    } catch (e) {
      console.warn(`[History] Failed to save: ${e.message}`);
    }
  }

  /** Trim old messages to avoid token overflow (keep last N pairs) */
  trim(maxPairs = 50) {
    if (this.messages.length > maxPairs * 2) {
      this.messages = this.messages.slice(-maxPairs * 2);
    }
  }
}

// ── Graph State Persistence (replaced by Checkpointer) ─────────────
// loadGraphState and saveGraphState are now handled by the Checkpointer class.
// These thin wrappers exist for backward compatibility with processUserMessage.

// ─── Main Loop ──────────────────────────────────────────────────────

/**
 * Process a user message through the 4-node agent graph.
 * Shared by both Telegram and Upstash modes.
 * graphState is mutated in-place by agentGraph.process().
 *
 * @returns {{ responseText: string }}
 */
// ─── Built-in Souls Catalog (matches examples/souls/) ────────────────

const BUILTIN_SOULS = [
  { name: 'Default', file: 'DEFAULT_SOUL.txt' },
  { name: 'Guide', file: 'GUIDE_SOUL.txt' },
  { name: 'Coder', file: 'CODER_SOUL.txt' },
  { name: 'Writer', file: 'WRITER_SOUL.txt' },
  { name: 'Data', file: 'DATA_SOUL.txt' },
  { name: 'Tutor', file: 'TUTOR_SOUL.txt' },
];
const SOULS_BASE_URL = 'https://raw.githubusercontent.com/masteraux101/little_shrimp/main/examples/souls/';

// ─── Built-in Skills Catalog (matches examples/skills/) ────────────────

const BUILTIN_SKILLS = [
  { name: 'Code Review', file: 'code-review.txt', icon: '🔍', description: 'Systematic code review with actionable feedback', keywords: ['code', 'review', 'lint', 'quality'] },
  { name: 'Translator', file: 'translator.txt', icon: '🌐', description: 'Multi-language translation with cultural context', keywords: ['translate', 'language', 'i18n', 'localize'] },
  { name: 'Email via Resend', file: 'email-resend.txt', icon: '📧', description: 'Send transactional emails using the Resend API', keywords: ['email', 'mail', 'send', 'resend', 'notification'] },
  { name: 'Web Scraper', file: 'web-scraper.txt', icon: '🕷️', description: 'Generate Python scripts to scrape and extract web data', keywords: ['scrape', 'crawl', 'extract', 'web', 'html', 'parse'] },
  { name: 'Data Visualization', file: 'data-visualization.txt', icon: '📈', description: 'Create charts and visualizations with matplotlib', keywords: ['chart', 'graph', 'plot', 'visualize', 'data', 'matplotlib'] },
  { name: 'Summary & Digest', file: 'summary-digest.txt', icon: '📋', description: 'Summarize texts, articles, and documents into concise digests', keywords: ['summary', 'summarize', 'digest', 'tldr', 'brief'] },
  { name: 'Writing Polish', file: 'writing-polish.txt', icon: '✏️', description: 'Improve writing quality — grammar, clarity, tone, style', keywords: ['write', 'grammar', 'polish', 'edit', 'proofread', 'style'] },
  { name: 'JSON/API Helper', file: 'json-api-helper.txt', icon: '🔧', description: 'Parse, transform JSON and design REST APIs', keywords: ['json', 'api', 'rest', 'parse', 'transform'] },
  { name: 'AI Prompt Scheduler', file: 'ai-prompt-scheduler.txt', icon: '⏰', description: 'Schedule AI prompts to run at specified times', keywords: ['schedule', 'cron', 'timer', 'automate', 'prompt'] },
  { name: 'GitHub Scheduler', file: 'github-scheduler.txt', icon: '📅', description: 'Schedule GitHub Actions workflows', keywords: ['github', 'action', 'schedule', 'workflow', 'cron'] },
];
const SKILLS_BASE_URL = 'https://raw.githubusercontent.com/masteraux101/little_shrimp/main/examples/skills/';

// ─── Skill Router ─────────────────────────────────────────────────
//
// Central registry that manages all loaded skills with isolation.
// Skills from different sources (URL, built-in catalog, ClawHub)
// go through a unified pipeline. The router selects only relevant
// skills per-message to prevent interference between unrelated skills.

class SkillRouter {
  constructor() {
    this._skills = new Map(); // lowercase name → SkillEntry
  }

  /**
   * Register a skill.
   * @param {{ name, source, url, content, triggers?: string[] }} skill
   * @returns {object} The registered entry
   */
  register(skill) {
    const entry = {
      name: skill.name,
      source: skill.source || 'url',       // 'url' | 'builtin' | 'clawhub'
      url: skill.url || '',
      content: skill.content || '',
      triggers: skill.triggers || this._extractTriggers(skill.name, skill.content),
      loadedAt: Date.now(),
    };
    this._skills.set(skill.name.toLowerCase(), entry);
    return entry;
  }

  /** Unregister a skill by name. Returns true if removed. */
  unregister(name) {
    return this._skills.delete(name.toLowerCase());
  }

  /** Check if a skill is loaded. */
  has(name) {
    return this._skills.has(name.toLowerCase());
  }

  /** Get a skill entry by name. */
  get(name) {
    return this._skills.get(name.toLowerCase());
  }

  /** Get all registered skills as an array. */
  listAll() {
    return Array.from(this._skills.values());
  }

  /** Get loaded skill names as a Set. */
  getLoadedNames() {
    return new Set(Array.from(this._skills.keys()));
  }

  /**
   * Match relevant skills for a given user message.
   * Returns skills ordered by relevance (highest trigger matches first).
   * Skills with no triggers are always included (catch-all).
   */
  match(userText) {
    if (this._skills.size === 0) return [];
    if (!userText) return this.listAll(); // no context → include all

    const text = userText.toLowerCase();
    const matched = [];

    for (const skill of this._skills.values()) {
      if (!skill.triggers || skill.triggers.length === 0) {
        // Catch-all skill: always included with lowest priority
        matched.push({ ...skill, _matchScore: 0 });
        continue;
      }
      const score = skill.triggers.reduce((acc, trigger) => {
        return acc + (text.includes(trigger) ? 1 : 0);
      }, 0);
      if (score > 0) {
        matched.push({ ...skill, _matchScore: score });
      }
    }

    // If no specific matches, include all skills (user might not mention keywords)
    if (matched.length === 0) return this.listAll();

    // Sort by match score descending
    matched.sort((a, b) => b._matchScore - a._matchScore);
    return matched;
  }

  /**
   * Build the skill prompt section for matched skills.
   * Each skill is clearly delimited with XML-style tags for isolation.
   */
  buildPromptSection(matchedSkills) {
    if (!matchedSkills || matchedSkills.length === 0) return '';
    const sections = matchedSkills.map(skill => {
      return `<skill name="${skill.name}" source="${skill.source}">\n${skill.content}\n</skill>`;
    });
    return `[Active Skills — ${matchedSkills.length} skill(s) matched]\n` +
      `IMPORTANT: Each <skill> section below is independent. Only follow a skill's instructions when the current task matches that skill's domain. Do NOT mix instructions from different skills.\n\n` +
      sections.join('\n\n');
  }

  /**
   * Extract trigger keywords from skill name and content.
   * Looks for explicit @triggers annotation first, then falls back
   * to extracting meaningful words from the name and heading.
   */
  _extractTriggers(name, content) {
    // Check for explicit @triggers annotation
    if (content) {
      const triggerMatch = content.match(/@triggers?:\s*(.+)/i);
      if (triggerMatch) {
        return triggerMatch[1].split(/[,;]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
      }
    }
    // Fall back: extract from name
    const stopWords = new Set(['the', 'and', 'for', 'with', 'via', 'from', 'into', 'using']);
    const triggers = name.toLowerCase()
      .split(/[\s\-_]+/)
      .filter(t => t.length > 2 && !stopWords.has(t));
    // Also extract from first heading in content
    if (content) {
      const headingMatch = content.match(/^#\s*(.+)/m);
      if (headingMatch) {
        const headingWords = headingMatch[1].toLowerCase()
          .split(/[\s\-_:]+/)
          .filter(t => t.length > 2 && !stopWords.has(t));
        triggers.push(...headingWords);
      }
    }
    return [...new Set(triggers)];
  }

  /** Serialize for state persistence. */
  toJSON() {
    return this.listAll().map(({ name, source, url, content, triggers }) => ({
      name, source, url, content, triggers,
    }));
  }

  /** Restore from persisted state. */
  fromJSON(arr) {
    this._skills.clear();
    if (Array.isArray(arr)) {
      for (const item of arr) {
        this.register(item);
      }
    }
  }
}

// Module-level router instance (shared by tools & AgentGraph)
const _skillRouter = new SkillRouter();

/**
 * Handle slash commands from the user.
 * Returns { handled: true, responseText } if it was a command, or { handled: false } otherwise.
 */
async function handleSlashCommand(text, { agentGraph, graphState, repoStore, memoryStore, loopKey, pushooChannels, runtimeCtx }) {
  const cmd = text.trim();
  const lower = cmd.toLowerCase();

  // ── /channel* runtime channel management ──
  if (lower === '/channel' || lower === '/channel help') {
    return {
      handled: true,
      responseText: [
        '**Channel Commands**',
        '- `/channel list` — list configured channels',
        '- `/channel add <platform> <token>` — add/update a channel',
        '- `/channel switch <platform>` — switch active communication mode',
        '- `/channel remove <platform>` — remove a configured channel',
        '',
        'Examples:',
        '- `/channel add bark https://api.day.app/xxxx/yyyy`',
        '- `/channel switch telegram`',
      ].join('\n'),
    };
  }

  if (lower === '/channel list') {
    if (!Array.isArray(pushooChannels) || pushooChannels.length === 0) {
      return { handled: true, responseText: 'No channels configured. Use `/channel add <platform> <token>`.' };
    }
    const lines = ['**Configured Channels:**'];
    for (const ch of pushooChannels) {
      lines.push(`- ${normalizePlatformName(ch.platform)} (${maskToken(ch.token)})`);
    }
    lines.push(`\nActive listener: ${_runtime.listener ? _runtime.listener.type : 'notification-only'}`);
    return { handled: true, responseText: lines.join('\n') };
  }

  if (lower.startsWith('/channel add ')) {
    const m = cmd.match(/^\/channel\s+add\s+(\S+)\s+([\s\S]+)$/i);
    if (!m) {
      return { handled: true, responseText: '⚠️ Usage: `/channel add <platform> <token>`' };
    }
    const platform = normalizePlatformName(m[1]);
    const token = m[2].trim();
    if (!SUPPORTED_CHANNEL_PLATFORMS.has(platform)) {
      return {
        handled: true,
        responseText: `⚠️ Unsupported platform: ${platform}. Supported: ${Array.from(SUPPORTED_CHANNEL_PLATFORMS).join(', ')}`,
      };
    }

    try {
      upsertChannel(pushooChannels, platform, token);
      await persistRuntimeChannels(repoStore, loopKey, pushooChannels);

      let switched = false;
      if (runtimeCtx && isBidirectionalPlatform(platform)) {
        await switchActiveListener([...pushooChannels], runtimeCtx);
        switched = true;
      }

      return {
        handled: true,
        responseText: switched
          ? `✅ Channel ${platform} updated and active listener switched.`
          : `✅ Channel ${platform} updated.`,
      };
    } catch (e) {
      return { handled: true, responseText: `❌ Failed to add channel: ${e.message}` };
    }
  }

  if (lower.startsWith('/channel switch ')) {
    const platform = normalizePlatformName(cmd.slice('/channel switch '.length).trim());
    if (!SUPPORTED_CHANNEL_PLATFORMS.has(platform)) {
      return {
        handled: true,
        responseText: `⚠️ Unsupported platform: ${platform}. Supported: ${Array.from(SUPPORTED_CHANNEL_PLATFORMS).join(', ')}`,
      };
    }

    const target = findChannel(pushooChannels, platform);
    if (!target) {
      return {
        handled: true,
        responseText: `⚠️ Channel ${platform} is not configured. Use: /channel add ${platform} <token>`,
      };
    }

    const nonBidirectional = pushooChannels.filter(ch => !isBidirectionalPlatform(normalizePlatformName(ch.platform)));
    const nextChannels = isBidirectionalPlatform(platform)
      ? [target, ...nonBidirectional]
      : [target, ...nonBidirectional.filter(ch => normalizePlatformName(ch.platform) !== platform)];

    pushooChannels.length = 0;
    pushooChannels.push(...nextChannels);
    await persistRuntimeChannels(repoStore, loopKey, pushooChannels);

    if (runtimeCtx) {
      await switchActiveListener([...pushooChannels], runtimeCtx);
    }
    return {
      handled: true,
      responseText: `✅ Active communication channel switched to ${platform}.`,
    };
  }

  if (lower.startsWith('/channel remove ')) {
    const platform = normalizePlatformName(cmd.slice('/channel remove '.length).trim());
    const before = pushooChannels.length;
    const nextChannels = pushooChannels.filter(ch => normalizePlatformName(ch.platform) !== platform);
    if (nextChannels.length === before) {
      return { handled: true, responseText: `⚠️ Channel ${platform} not found.` };
    }

    pushooChannels.length = 0;
    pushooChannels.push(...nextChannels);
    await persistRuntimeChannels(repoStore, loopKey, pushooChannels);
    if (runtimeCtx) {
      await switchActiveListener([...pushooChannels], runtimeCtx);
    }
    return { handled: true, responseText: `✅ Channel ${platform} removed.` };
  }

  // ── /memory clear ──
  if (lower === '/memory clear') {
    if (!memoryStore) return { handled: true, responseText: '⚠️ No memory backend — cannot clear memory.' };
    try {
      await memoryStore.clear();
      return { handled: true, responseText: '✅ Memory cleared.' };
    } catch (e) {
      return { handled: true, responseText: `❌ Failed to clear memory: ${e.message}` };
    }
  }

  // ── /skill list ──
  if (lower === '/skill list') {
    const skills = _skillRouter.listAll();
    if (skills.length === 0) {
      return { handled: true, responseText: 'No skills loaded.\n\nUse `/skill load <url | name | slug>` to load a skill.' };
    }
    const lines = ['**Loaded Skills:**\n'];
    for (const s of skills) {
      lines.push(`- **${s.name}** [${s.source}] — triggers: ${s.triggers.join(', ')}`);
    }
    lines.push(`\nUse \`/skill unload <name>\` to remove a skill.`);
    return { handled: true, responseText: lines.join('\n') };
  }

  // ── /skill search <query> ──
  if (lower.startsWith('/skill search ')) {
    const query = cmd.slice('/skill search '.length).trim();
    if (!query) return { handled: true, responseText: '⚠️ Usage: `/skill search <keywords>`' };
    const terms = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
    const results = [];
    for (const skill of BUILTIN_SKILLS) {
      const haystack = [skill.name, skill.description, ...skill.keywords].join(' ').toLowerCase();
      if (terms.some(t => haystack.includes(t))) {
        const loaded = _skillRouter.has(skill.name);
        results.push(`${skill.icon} **${skill.name}** [builtin] ${loaded ? '✅' : '📦'} — ${skill.description}`);
      }
    }
    if (results.length === 0) {
      return { handled: true, responseText: `No built-in skills match "${query}". Available: ${BUILTIN_SKILLS.map(s => `${s.icon} ${s.name}`).join(', ')}` };
    }
    return { handled: true, responseText: `**Skill Search: "${query}"**\n\n${results.join('\n')}\n\nUse \`/skill load <name>\` to load.` };
  }

  // ── /skill load <url | builtin_name | clawhub_slug> ──
  if (lower.startsWith('/skill load ')) {
    const arg = cmd.slice('/skill load '.length).trim();
    if (!arg) {
      return { handled: true, responseText: '⚠️ Usage: `/skill load <url | builtin_name | clawhub_slug>`' };
    }

    let url, name, source;

    if (arg.startsWith('http://') || arg.startsWith('https://')) {
      // Direct URL
      url = arg;
      name = arg.split('/').pop().replace(/\.[^.]+$/, '') || 'custom-skill';
      source = 'url';
    } else {
      // Check builtin catalog first
      const builtin = BUILTIN_SKILLS.find(s => s.name.toLowerCase() === arg.toLowerCase());
      if (builtin) {
        url = SKILLS_BASE_URL + builtin.file;
        name = builtin.name;
        source = 'builtin';
      } else {
        // Try as ClawHub slug
        url = `https://clawhub.ai/api/v1/skills/${encodeURIComponent(arg)}/content`;
        name = arg;
        source = 'clawhub';
      }
    }

    if (_skillRouter.has(name)) {
      return { handled: true, responseText: `ℹ️ Skill "${name}" is already loaded.` };
    }

    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const content = await resp.text();
      const nameMatch = content.match(/^#\s*(.+)/m) || content.match(/name:\s*(.+)/im);
      if (nameMatch) name = nameMatch[1].trim();

      if (_skillRouter.has(name)) {
        return { handled: true, responseText: `ℹ️ Skill "${name}" is already loaded.` };
      }

      const entry = _skillRouter.register({
        name, source, url, content: content.slice(0, 6000),
      });
      agentGraph._syncExtensionsToState(graphState);
      return { handled: true, responseText: `✅ Skill **${name}** loaded from ${source}.\nTriggers: ${entry.triggers.join(', ')}` };
    } catch (e) {
      return { handled: true, responseText: `❌ Failed to load skill: ${e.message}` };
    }
  }

  // ── /skill unload <name> ──
  if (lower.startsWith('/skill unload ')) {
    const name = cmd.slice('/skill unload '.length).trim();
    const skill = _skillRouter.get(name);
    if (!skill) {
      const available = _skillRouter.listAll().map(s => s.name).join(', ') || 'none';
      return { handled: true, responseText: `⚠️ Skill "${name}" not found. Loaded: ${available}` };
    }
    _skillRouter.unregister(name);
    agentGraph._syncExtensionsToState(graphState);
    return { handled: true, responseText: `✅ Skill **${skill.name}** unloaded.` };
  }

  // ── /soul list ──
  if (lower === '/soul list') {
    const lines = ['**Available Souls:**\n'];
    for (const s of BUILTIN_SOULS) {
      const active = agentGraph._loadedSoul?.name === s.name ? ' ✅ (active)' : '';
      lines.push(`- **${s.name}**${active}`);
    }
    lines.push(`\nCurrent: ${agentGraph._loadedSoul ? `**${agentGraph._loadedSoul.name}**` : 'none (default)'}`);
    lines.push(`\nUse \`/soul load <name>\` or \`/soul load <url>\` to switch.`);
    return { handled: true, responseText: lines.join('\n') };
  }

  // ── /soul load <name_or_url> ──
  if (lower.startsWith('/soul load ')) {
    const arg = cmd.slice('/soul load '.length).trim();
    if (!arg) return { handled: true, responseText: '⚠️ Usage: `/soul load <name>` or `/soul load <url>`' };

    let url, name;
    const builtin = BUILTIN_SOULS.find(s => s.name.toLowerCase() === arg.toLowerCase());
    if (builtin) {
      url = SOULS_BASE_URL + builtin.file;
      name = builtin.name;
    } else if (arg.startsWith('http')) {
      url = arg;
      name = arg.split('/').pop().replace(/\.[^.]+$/, '');
    } else {
      const names = BUILTIN_SOULS.map(s => s.name).join(', ');
      return { handled: true, responseText: `⚠️ Unknown soul "${arg}". Available: ${names}\n\nOr provide a URL.` };
    }

    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const content = await resp.text();
      agentGraph._loadedSoul = { name, url, content: content.slice(0, 4000) };
      agentGraph._syncExtensionsToState(graphState);
      agentGraph._rebuildExecutor();
      return { handled: true, responseText: `✅ Soul switched to **${name}**.` };
    } catch (e) {
      return { handled: true, responseText: `❌ Failed to load soul: ${e.message}` };
    }
  }

  // ── /soul unload ──
  if (lower === '/soul unload') {
    if (!agentGraph._loadedSoul) {
      return { handled: true, responseText: 'ℹ️ No soul is currently loaded.' };
    }
    const name = agentGraph._loadedSoul.name;
    agentGraph._loadedSoul = null;
    agentGraph._syncExtensionsToState(graphState);
    agentGraph._rebuildExecutor();
    return { handled: true, responseText: `✅ Soul **${name}** unloaded. Reverted to default.` };
  }

  // Not a command
  return { handled: false };
}

async function processUserMessage(text, { agentGraph, graphState, history, repoStore, memoryStore, loopKey, historyPath, pushooChannels = [], sourcePlatform = '', runtimeCtx = null }) {
  let workingText = String(text || '');

  // Natural-language channel switch command (Chinese/English)
  const switchMatch = workingText.match(/(?:切换|switch)(?:\s*到|\s+to)?\s*([a-zA-Z\u4e00-\u9fa5]+)\s*(?:渠道|channel)?/i);
  if (switchMatch) {
    const candidate = normalizePlatformName(switchMatch[1]);
    if (SUPPORTED_CHANNEL_PLATFORMS.has(candidate)) {
      workingText = `/channel switch ${candidate}`;
    }
  }

  const addMatch = workingText.match(/(?:配置|添加|新增|add|configure)\s*([a-zA-Z\u4e00-\u9fa5]+)\s*(?:渠道|channel)?\s*(?:token|key|密钥|令牌)?\s*[:：=]\s*([^\s]+)/i);
  if (addMatch) {
    const platform = normalizePlatformName(addMatch[1]);
    const token = addMatch[2].trim();
    if (SUPPORTED_CHANNEL_PLATFORMS.has(platform) && token) {
      workingText = `/channel add ${platform} ${token}`;
    }
  }

  // ── Check for slash commands first ──
  if (workingText.trim().startsWith('/')) {
    const cmdResult = await handleSlashCommand(workingText, {
      agentGraph,
      graphState,
      repoStore,
      memoryStore,
      loopKey,
      pushooChannels,
      runtimeCtx,
    });
    if (cmdResult.handled) {
      console.log(`[Command] Handled: ${workingText.trim().split(' ').slice(0, 3).join(' ')}`);
      history.addUser(text);
      history.addAssistant(cmdResult.responseText);
      if (repoStore) {
        await history.save();
        // Checkpointer handles state persistence automatically
      }
      return { responseText: cmdResult.responseText };
    }
  }

  // Task-level delivery preference (e.g. "send result via bark")
  const deliveryDirective = parseDeliveryDirective(workingText);
  let deliveryChannel = null;
  if (deliveryDirective) {
    workingText = deliveryDirective.cleanedText || workingText;
    deliveryChannel = findChannel(pushooChannels, deliveryDirective.platform);

    if (!deliveryChannel) {
      if (deliveryDirective.token) {
        try {
          deliveryChannel = upsertChannel(pushooChannels, deliveryDirective.platform, deliveryDirective.token);
          await persistRuntimeChannels(repoStore, loopKey, pushooChannels);
        } catch (e) {
          return { responseText: `⚠️ Failed to configure ${deliveryDirective.platform}: ${e.message}` };
        }
      } else {
        return {
          responseText: `⚠️ Channel ${deliveryDirective.platform} is not configured. Use /channel add ${deliveryDirective.platform} <token>, then retry.`,
          delivery: { platform: deliveryDirective.platform, routedExternally: false },
        };
      }
    }
  }

  // Fast path: exact repeated task cache hit
  if (memoryStore) {
    try {
      const cached = await memoryStore.getTaskCache(workingText);
      if (cached && cached.response) {
        const responseText = `${cached.response}\n\n(Served from memory cache for repeated task.)`;
        history.addUser(text);
        history.addAssistant(responseText);
        if (repoStore) await history.save();
        updateTaskProgress({
          active: false,
          node: 'memory_cache',
          stage: 'cache_hit',
          lastResultPreview: _trimPreview(cached.response, 240),
        });
        appendTaskThought('Returned cached result from JSON memory for repeated task.');
        return { responseText };
      }
    } catch (cacheErr) {
      console.warn(`[Memory] Task cache lookup failed: ${cacheErr.message}`);
    }
  }

  history.addUser(text);
  history.trim(50);
  beginTaskProgress(workingText);

  let responseText;
  try {
    const langchainMessages = await history.toLangChainMessages();
    console.log(`[Agent] Processing: ${workingText.length} chars, phase: ${graphState.phase || 'analyze'}, ${langchainMessages.length} history msgs`);

    const result = await agentGraph.process(workingText, graphState, langchainMessages);
    responseText = result.response;

    const artifactUrls = (_runtime.taskProgress?.artifactUrls || []).slice(-5);
    if (artifactUrls.length > 0) {
      responseText += `\n\nArtifact URLs:\n${artifactUrls.map(u => `- ${u}`).join('\n')}`;
    }

    finishTaskProgress(responseText, true);

    console.log(`[Agent] Done. Response: ${responseText.length} chars, next phase: ${graphState.phase}`);
  } catch (agentErr) {
    console.error(`[Agent] Error: ${agentErr.message}`);
    // Stack logged without cause to avoid leaking API payloads / message content
    const safeStack = (agentErr.stack || '').split('\n').slice(0, 5).join('\n');
    console.error(`[Agent] Stack (truncated):\n${safeStack}`);
    responseText = `[Error] Agent failed: ${agentErr.message}`;
    appendTaskIssue(`Agent process error: ${agentErr.message}`);
    finishTaskProgress(responseText, false);
    graphState.phase = 'analyze';
    graphState.lastError = { node: 'process', message: agentErr.message, ts: Date.now() };
  }

  history.addAssistant(responseText);
  if (memoryStore) {
    try {
      await memoryStore.rememberTaskResult(workingText, responseText);
    } catch (e) {
      console.warn(`[Memory] Failed to cache task result: ${e.message}`);
    }
  }
  if (repoStore) {
    await history.save();
    // State is already checkpointed inside nodes — no extra save needed
  }

  if (deliveryChannel) {
    await sendNotifications([
      { platform: normalizePlatformName(deliveryChannel.platform), token: deliveryChannel.token },
    ], `[Task Result] ${loopKey}`, responseText);

    const requestedPlatform = normalizePlatformName(deliveryChannel.platform);
    const currentSource = normalizePlatformName(sourcePlatform);
    const routedExternally = requestedPlatform !== currentSource;
    return {
      responseText,
      delivery: {
        platform: requestedPlatform,
        routedExternally,
      },
    };
  }

  return { responseText, delivery: null };
}

// ─── Schedule Manager ───────────────────────────────────────────────
//
// Manages cron-scheduled tasks that run inside the loop agent process.
// No GitHub Actions involved — the agent itself fires tasks on time.

class ScheduleManager {
  constructor() {
    this._tasks = new Map(); // slug → task record
  }

  register(task) {
    const entry = {
      name: task.name,
      slug: task.slug,
      description: task.description || '',
      cron: task.cron,
      prompt: task.prompt || '',
      lastRunAt: task.lastRunAt || null,
      createdAt: task.createdAt || new Date().toISOString(),
    };
    this._tasks.set(task.slug, entry);
    return entry;
  }

  unregister(slug) {
    return this._tasks.delete(slug);
  }

  get(slug) { return this._tasks.get(slug); }

  getAll() { return Array.from(this._tasks.values()); }

  markRan(slug, now) {
    const task = this._tasks.get(slug);
    if (task) task.lastRunAt = now.toISOString();
  }

  /** Return all tasks whose cron fires at `now` and haven't run this minute. */
  getDueTasks(now = new Date()) {
    return this.getAll().filter(t => this._shouldFire(t.cron, t.lastRunAt, now));
  }

  _shouldFire(cron, lastRunAt, now) {
    if (!this._matchesCron(cron, now)) return false;
    if (!lastRunAt) return true;
    const last = new Date(lastRunAt);
    // Prevent double-firing within the same minute
    return !(
      last.getFullYear() === now.getFullYear() &&
      last.getMonth()    === now.getMonth()    &&
      last.getDate()     === now.getDate()     &&
      last.getHours()    === now.getHours()    &&
      last.getMinutes()  === now.getMinutes()
    );
  }

  /**
   * Minimal 5-field cron matcher: "min hour dom month dow"
   * Supports: * (any), numbers, comma lists, ranges (1-5), steps (*\/5, 1-10\/2)
   */
  _matchesCron(expr, now) {
    const fields = (expr || '').trim().split(/\s+/);
    if (fields.length !== 5) return false;
    const [minE, hourE, domE, monE, dowE] = fields;
    return (
      this._matchField(minE,  now.getMinutes(),     0, 59) &&
      this._matchField(hourE, now.getHours(),        0, 23) &&
      this._matchField(domE,  now.getDate(),         1, 31) &&
      this._matchField(monE,  now.getMonth() + 1,   1, 12) &&
      this._matchField(dowE,  now.getDay(),          0,  6)
    );
  }

  _matchField(expr, value, min, max) {
    if (expr === '*') return true;
    for (const part of expr.split(',')) {
      if (this._matchPart(part.trim(), value, min, max)) return true;
    }
    return false;
  }

  _matchPart(part, value, min, max) {
    if (part.includes('/')) {
      const [rangeStr, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step < 1) return false;
      let start = min, end = max;
      if (rangeStr !== '*') {
        if (rangeStr.includes('-')) {
          const [a, b] = rangeStr.split('-').map(Number);
          start = a; end = b;
        } else {
          start = parseInt(rangeStr, 10);
        }
      }
      for (let v = start; v <= end; v += step) {
        if (v === value) return true;
      }
      return false;
    }
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      return value >= a && value <= b;
    }
    return parseInt(part, 10) === value;
  }
}

const _scheduleManager = new ScheduleManager();

// ─── Unified Mode Lifecycle Management ──────────────────────────────
//
// Architecture: One always-running browser polling loop + optional
// stoppable bidirectional listener (Telegram OR WeCom).
//
// When __SWITCH_CHANNEL__ is received:
// 1. Stop current listener (kill Telegram bot / disconnect WeCom WebSocket)
// 2. Update pushooChannels
// 3. Start new listener for the target channel (if bidirectional)
// 4. Browser polling continues uninterrupted throughout
//
// This enables true runtime switching between communication modes.

const _runtime = {
  listener: null,        // { type: 'telegram'|'wecom', stop(), sendMsg(text) } or null
  pollTimer: null,       // browser polling setTimeout handle
  schedulerTimer: null,  // scheduled task ticker setTimeout handle
  wecomActiveFrame: null,// active WeCom inbound frame used for image replies
  processing: false,     // global mutex for concurrent message processing
  processedCount: 0,     // total messages processed
  startTime: 0,          // process start timestamp
  dormant: false,        // dormant mode (Upstash-inherited, ignores regular messages)
  taskProgress: {
    active: false,
    startedAt: 0,
    updatedAt: 0,
    node: 'idle',
    stage: 'idle',
    inputPreview: '',
    thoughts: [],
    issues: [],
    lastResultPreview: '',
    artifactUrls: [],
  },
  currentDataRepo: '',
};

function _trimPreview(text, maxLen = 180) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
}

function beginTaskProgress(inputText) {
  _runtime.taskProgress = {
    active: true,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    node: 'analyze',
    stage: 'received_message',
    inputPreview: _trimPreview(inputText, 220),
    thoughts: ['Received user message and started task orchestration.'],
    issues: [],
    lastResultPreview: '',
    artifactUrls: [],
  };
}

function registerArtifactPath(path) {
  const repo = _runtime.currentDataRepo;
  if (!repo || !path) return null;
  const cleanPath = String(path).replace(/^\/+/, '');
  const url = `https://github.com/${repo}/blob/main/${cleanPath}`;
  const cur = _runtime.taskProgress || {};
  const urls = Array.isArray(cur.artifactUrls) ? [...cur.artifactUrls] : [];
  if (!urls.includes(url)) urls.push(url);
  _runtime.taskProgress = {
    ...cur,
    artifactUrls: urls.slice(-10),
    updatedAt: Date.now(),
  };
  return url;
}

function updateTaskProgress(patch = {}) {
  const cur = _runtime.taskProgress || {};
  _runtime.taskProgress = {
    ...cur,
    ...patch,
    updatedAt: Date.now(),
  };
}

function appendTaskThought(thought) {
  if (!thought) return;
  const cur = _runtime.taskProgress || { thoughts: [] };
  const thoughts = Array.isArray(cur.thoughts) ? [...cur.thoughts] : [];
  thoughts.push(_trimPreview(thought, 260));
  _runtime.taskProgress = {
    ...cur,
    thoughts: thoughts.slice(-8),
    updatedAt: Date.now(),
  };
}

function appendTaskIssue(issue) {
  if (!issue) return;
  const cur = _runtime.taskProgress || { issues: [] };
  const issues = Array.isArray(cur.issues) ? [...cur.issues] : [];
  issues.push(_trimPreview(issue, 260));
  _runtime.taskProgress = {
    ...cur,
    issues: issues.slice(-8),
    updatedAt: Date.now(),
  };
}

function finishTaskProgress(responseText, success = true) {
  const cur = _runtime.taskProgress || {};
  _runtime.taskProgress = {
    ...cur,
    active: false,
    node: success ? 'done' : (cur.node || 'error'),
    stage: success ? 'completed' : 'failed',
    lastResultPreview: _trimPreview(responseText, 240),
    updatedAt: Date.now(),
  };
}

function formatTaskProgressText() {
  const p = _runtime.taskProgress;
  if (!p || !p.active) {
    return 'No active task. Agent is idle.';
  }
  const elapsedSec = Math.max(0, Math.round((Date.now() - (p.startedAt || Date.now())) / 1000));
  const lines = [
    'Task is currently running.',
    `Node: ${p.node || 'unknown'}`,
    `Stage: ${p.stage || 'working'}`,
    `Elapsed: ${elapsedSec}s`,
  ];
  if (p.inputPreview) lines.push(`Task: ${p.inputPreview}`);
  if (Array.isArray(p.thoughts) && p.thoughts.length > 0) {
    lines.push('Thinking:');
    for (const t of p.thoughts.slice(-4)) lines.push(`- ${t}`);
  }
  if (Array.isArray(p.issues) && p.issues.length > 0) {
    lines.push('Issues:');
    for (const it of p.issues.slice(-4)) lines.push(`- ${it}`);
  } else {
    lines.push('Issues: none reported yet');
  }
  if (Array.isArray(p.artifactUrls) && p.artifactUrls.length > 0) {
    lines.push('Artifacts:');
    for (const url of p.artifactUrls.slice(-5)) lines.push(`- ${url}`);
  }
  return lines.join('\n');
}

// ─── Stoppable Telegram Listener ────────────────────────────────────

/**
 * Create and start a Telegram bot listener.
 * The bot runs as a background polling process (Telegraf).
 * Returns { type, stop(), sendMsg(text) } — call stop() to kill the bot.
 */
async function createTelegramListener(ctx) {
  console.log(`[Telegram] createTelegramListener() called`);
  console.log(`[Telegram] pushooChannels: ${JSON.stringify(ctx.pushooChannels.map(c => ({ platform: c.platform, hasToken: !!c.token })))}`);
  const channel = ctx.pushooChannels.find(ch => ch.platform === 'telegram');
  if (!channel) {
    console.warn(`[Telegram] No telegram channel found in pushooChannels — returning null`);
    return null;
  }
  console.log(`[Telegram] Found telegram channel, token length: ${channel.token ? channel.token.length : 0}`);

  const { botToken, chatId } = parseTelegramToken(channel.token);
  if (!botToken) {
    console.warn(`[Telegram] parseTelegramToken returned empty botToken — returning null`);
    console.warn(`[Telegram] Raw token (first 20 chars): ${channel.token ? channel.token.slice(0, 20) + '...' : '(empty)'}`);
    return null;
  }
  console.log(`[Telegram] botToken length: ${botToken.length}, chatId configured: ${chatId ? 'yes' : 'no'}`);

  const { Telegraf } = require('telegraf');
  const bot = new Telegraf(botToken);
  let stopped = false;

  console.log(`[Telegram] Starting listener...`);
  console.log(`[Telegram] Chat ID filter: ${chatId ? 'set' : '(any)'}`);

  // /start
  bot.command('start', async (bctx) => {
    await bctx.reply(
      `🤖 Loop Agent active.\nModel: ${ctx.aiProvider}/${ctx.aiModel}\nSend a message to start.`
    );
  });

  // /status
  bot.command('status', async (bctx) => {
    const elapsed = Math.round((Date.now() - _runtime.startTime) / 60000);
    const remaining = Math.max(0, Math.round((ctx.maxRuntime - (Date.now() - _runtime.startTime)) / 60000));
    await bctx.reply(
      `📊 Loop Agent Status\n` +
      `Runtime: ${elapsed} min\n` +
      `Processed: ${_runtime.processedCount} messages\n` +
      `Remaining: ~${remaining} min\n` +
      `Model: ${ctx.aiProvider}/${ctx.aiModel}\n` +
      `Processing: ${_runtime.processing ? 'yes' : 'idle'}\n\n` +
      formatTaskProgressText()
    );
  });

  // /stop
  bot.command('stop', async (bctx) => {
    await bctx.reply('👋 Loop Agent stopping...');
    process.exit(0);
  });

  // Text messages → process with agent graph
  bot.on('text', async (bctx) => {
    const msg = bctx.message;
    if (chatId && String(msg.chat.id) !== String(chatId)) return;
    const text = msg.text;
    if (!text || /^\/(start|status|stop)\b/i.test(text)) return;

    if (_runtime.processing) {
      await bctx.reply(`⏳ Still processing.\n\n${formatTaskProgressText()}`);
      return;
    }

    _runtime.processing = true;
    console.log(`[Telegram] Received message (${text.length} chars)`);

    try {
      await bctx.sendChatAction('typing');
      const result = await processUserMessage(text, {
        agentGraph: ctx.agentGraph, graphState: ctx.graphState,
        history: ctx.history, repoStore: ctx.repoStore, memoryStore: ctx.memoryStore,
        loopKey: ctx.loopKey, historyPath: ctx.historyPath,
        pushooChannels: ctx.pushooChannels,
        sourcePlatform: 'telegram',
        runtimeCtx: ctx,
      });
      const responseText = result.responseText;

      const routedExternally = !!(result.delivery && result.delivery.routedExternally);
      const telegramReply = routedExternally
        ? `✅ Task completed. Result sent via ${result.delivery.platform}.`
        : responseText;

      const chunks = splitTelegramMessage(telegramReply);
      for (const chunk of chunks) {
        await bctx.reply(chunk);
      }
      _runtime.processedCount++;
      console.log(`[Telegram] Replied (${responseText.length} chars), total: ${_runtime.processedCount}`);
    } catch (err) {
      console.error(`[Telegram] Processing error: ${err.message}`);
      try { await bctx.reply(`❌ Error: ${err.message}`); } catch { /* best effort */ }
    } finally {
      _runtime.processing = false;
    }
  });

  bot.catch((err) => console.error(`[Telegram] Bot error: ${err.message}`));

  // Clear any existing webhook/polling state before launching
  try {
    console.log(`[Telegram] Clearing webhook and pending updates...`);
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log(`[Telegram] Webhook cleared.`);
  } catch (e) {
    console.warn(`[Telegram] Webhook clear failed (non-fatal): ${e.message}`);
  }

  // Launch polling — IMPORTANT: bot.launch() returns a promise that resolves when
  // polling STOPS (not starts). Telegraf's Polling.loop() is an infinite for-await
  // loop. We must NOT await it, or createTelegramListener() would block forever
  // and browser polling would never start (preventing __SWITCH_CHANNEL__ etc).
  console.log(`[Telegram] Launching polling (fire-and-forget)...`);
  const launchStart = Date.now();
  bot.launch({
    dropPendingUpdates: true,
    allowedUpdates: ['message'],
  }).then(() => {
    // This resolves when bot.stop() is called
    console.log(`[Telegram] Polling loop ended normally.`);
  }).catch((launchErr) => {
    if (stopped) {
      console.log(`[Telegram] Polling ended after stop: ${launchErr.message}`);
    } else {
      console.error(`[Telegram] ❌ Bot polling error: ${launchErr.message}`);
      console.error(`[Telegram] This usually means another bot instance is already polling.`);
      console.error(`[Telegram] Stack: ${launchErr.stack}`);
    }
  });

  // Wait for bot.botInfo to be set (getMe completes) and first getUpdates to fire
  // This confirms the bot is actually polling, without blocking forever
  const readyTimeout = 15000;
  const readyStart = Date.now();
  while (!bot.botInfo && Date.now() - readyStart < readyTimeout) {
    await new Promise(r => setTimeout(r, 200));
  }
  if (bot.botInfo) {
    console.log(`[Telegram] ✅ Bot polling started (@${bot.botInfo.username}, ${Date.now() - launchStart}ms).`);
  } else {
    console.error(`[Telegram] ⚠ Bot info not available after ${readyTimeout}ms — polling may have failed`);
    return null;
  }

  return {
    type: 'telegram',
    async stop() {
      if (stopped) return;
      stopped = true;
      console.log(`[Telegram] Stopping bot (reason: SWITCH_CHANNEL)...`);
      try {
        bot.stop('SWITCH_CHANNEL');
        // Wait for Telegraf to complete in-flight getUpdates abort
        await new Promise(r => setTimeout(r, 500));
        console.log(`[Telegram] Bot polling abort completed.`);
      } catch (e) {
        console.warn(`[Telegram] Error during stop: ${e.message}`);
      }
      console.log(`[Telegram] Bot stopped.`);
    },
    async sendMsg(text) {
      if (!chatId || stopped) return;
      try {
        const chunks = splitTelegramMessage(`📩 [Browser]\n${text}`);
        for (const chunk of chunks) {
          await bot.telegram.sendMessage(chatId, chunk);
        }
      } catch (e) { console.warn(`[Telegram] Forward failed: ${e.message}`); }
    },
    async sendImage(imagePath, caption) {
      if (stopped) return null;
      return sendTelegramPhoto(imagePath, caption);
    },
  };
}

// ─── Stoppable WeCom Listener ───────────────────────────────────────

/**
 * Create and start a WeCom bot listener via WebSocket.
 * Returns { type, stop(), sendMsg(text) } — call stop() to disconnect.
 */
async function createWecomListener(ctx) {
  console.log(`[WeCom] createWecomListener() called`);
  console.log(`[WeCom] pushooChannels: ${JSON.stringify(ctx.pushooChannels.map(c => ({ platform: c.platform, hasToken: !!c.token })))}`);
  const channel = ctx.pushooChannels.find(ch => ch.platform === 'wecombot');
  if (!channel) {
    console.warn(`[WeCom] No wecombot channel found in pushooChannels — returning null`);
    return null;
  }
  console.log(`[WeCom] Found wecombot channel, token length: ${channel.token ? channel.token.length : 0}`);

  const rawToken = channel.token || '';
  const [wecomBotId, wecomSecret] = rawToken.split('#');
  if (!wecomBotId || !wecomSecret) {
    console.warn(`[WeCom] Token parse failed — expected 'botId#secret' format`);
    console.warn(`[WeCom] Raw token (first 30 chars): ${rawToken.slice(0, 30)}...`);
    console.warn(`[WeCom] Parsed botId: '${wecomBotId || ''}' (${wecomBotId ? wecomBotId.length : 0} chars)`);
    console.warn(`[WeCom] Parsed secret: '${wecomSecret ? wecomSecret.slice(0, 5) + '...' : ''}' (${wecomSecret ? wecomSecret.length : 0} chars)`);
    return null;
  }

  console.log(`[WeCom] Token parsed: botId=${wecomBotId.slice(0, 12)}** (${wecomBotId.length} chars), secret=${wecomSecret.slice(0, 5)}** (${wecomSecret.length} chars)`);

  let AiBot, generateReqId;
  try {
    AiBot = require('@wecom/aibot-node-sdk').default;
    generateReqId = require('@wecom/aibot-node-sdk').generateReqId;
    console.log(`[WeCom] @wecom/aibot-node-sdk loaded successfully`);
  } catch (loadErr) {
    console.error(`[WeCom] ❌ Failed to load @wecom/aibot-node-sdk: ${loadErr.message}`);
    return null;
  }
  let stopped = false;

  console.log(`[WeCom] Starting WebSocket listener...`);
  console.log(`[WeCom] Bot ID: ${wecomBotId.slice(0, 8)}...`);

  const wsClient = new AiBot.WSClient({
    botId: wecomBotId,
    secret: wecomSecret,
    maxReconnectAttempts: -1, // infinite reconnect in GHA
  });

  // Connect and wait for initial connection
  const connectPromise = new Promise((resolve, reject) => {
    const connectTimeout = setTimeout(() => {
      console.warn(`[WeCom] Connection timeout (10s) — proceeding anyway`);
      resolve('timeout');
    }, 10000);

    wsClient.on('connected', () => {
      clearTimeout(connectTimeout);
      console.log(`[WeCom] WebSocket connected`);
    });

    wsClient.on('authenticated', () => {
      clearTimeout(connectTimeout);
      console.log(`[WeCom] Authenticated — listener ready`);
      resolve('authenticated');
    });

    wsClient.on('error', (err) => {
      console.error(`[WeCom] Connection error: ${err.message}`);
      // Don't reject — let it retry
    });
  });

  wsClient.on('disconnected', (reason) => console.log(`[WeCom] Disconnected: ${reason}`));
  wsClient.on('reconnecting', (attempt) => console.log(`[WeCom] Reconnecting (attempt ${attempt})...`));

  // Welcome on chat enter
  wsClient.on('event.enter_chat', async (frame) => {
    try {
      wsClient.sendReply(frame, {
        msgtype: 'text',
        text: { content: `🤖 Loop Agent active. Model: ${ctx.aiProvider}/${ctx.aiModel}\nSend a message to start.` },
        reqid: generateReqId(),
      });
    } catch { /* best effort */ }
  });

  // Text messages → process with agent graph
  wsClient.on('message.text', async (frame) => {
    const body = frame.body;
    const content = body.text?.content || '';
    const from = body.from?.userid || 'unknown';
    if (!content) return;

    console.log(`[WeCom] Received message (${content.length} chars)`);

    // /status
    if (/^\/status\b/i.test(content)) {
      const elapsed = Math.round((Date.now() - _runtime.startTime) / 60000);
      const remaining = Math.round((ctx.maxRuntime - (Date.now() - _runtime.startTime)) / 60000);
      const statusText = `📊 Agent Status\nProcessed: ${_runtime.processedCount} messages\nRunning: ${elapsed} min\nRemaining: ~${remaining} min\nModel: ${ctx.aiProvider}/${ctx.aiModel}\nProcessing: ${_runtime.processing ? 'yes' : 'idle'}\n\n${formatTaskProgressText()}`;
      try {
        const streamId = generateReqId('stream');
        await wsClient.replyStream(frame, streamId, statusText, true);
      } catch (e) { console.warn(`[WeCom] Status reply failed: ${e.message}`); }
      return;
    }

    // /stop
    if (/^\/stop\b/i.test(content)) {
      try {
        const streamId = generateReqId('stream');
        await wsClient.replyStream(frame, streamId, '👋 Loop Agent stopping...', true);
      } catch { /* best effort */ }
      process.exit(0);
    }

    if (_runtime.processing) {
      try {
        const streamId = generateReqId('stream');
        await wsClient.replyStream(frame, streamId, `⏳ Still processing.\n\n${formatTaskProgressText()}`, true);
      } catch { /* best effort */ }
      return;
    }

    _runtime.processing = true;
    _runtime.wecomActiveFrame = frame;
    try {
      const result = await processUserMessage(content, {
        agentGraph: ctx.agentGraph, graphState: ctx.graphState,
        history: ctx.history, repoStore: ctx.repoStore, memoryStore: ctx.memoryStore,
        loopKey: ctx.loopKey, historyPath: ctx.historyPath,
        pushooChannels: ctx.pushooChannels,
        sourcePlatform: 'wecombot',
        runtimeCtx: ctx,
      });
      const responseText = result.responseText;

      const routedExternally = !!(result.delivery && result.delivery.routedExternally);
      const wecomReply = routedExternally
        ? `✅ Task completed. Result sent via ${result.delivery.platform}.`
        : responseText;

      const chunks = splitWecomMessage(wecomReply);
      for (const chunk of chunks) {
        const streamId = generateReqId('stream');
        await wsClient.replyStream(frame, streamId, chunk, true);
      }
      _runtime.processedCount++;
      console.log(`[WeCom] Replied (${responseText.length} chars), total: ${_runtime.processedCount}`);
    } catch (err) {
      console.error(`[WeCom] Processing error: ${err.message}`);
      try {
        const streamId = generateReqId('stream');
        await wsClient.replyStream(frame, streamId, `❌ Error: ${err.message}`, true);
      } catch { /* best effort */ }
    } finally {
      _runtime.wecomActiveFrame = null;
      _runtime.processing = false;
    }
  });

  // Connect and wait for initial authentication
  wsClient.connect();
  console.log(`[WeCom] WebSocket connect() called, waiting for authentication...`);

  const connectResult = await connectPromise;
  console.log(`[WeCom] ✅ Connection result: ${connectResult}`);

  return {
    type: 'wecom',
    async stop() {
      if (stopped) return;
      stopped = true;
      console.log(`[WeCom] Stopping WebSocket...`);
      try {
        wsClient.disconnect();
        // Wait for WebSocket to fully close
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.warn(`[WeCom] Error during disconnect: ${e.message}`);
      }
      console.log(`[WeCom] WebSocket stopped.`);
    },
    async sendMsg(text) {
      // WeCom doesn't support server-initiated broadcast; skip
      console.log(`[WeCom] (Browser message not forwarded — WeCom does not support server push)`);
    },
    async sendImage(imagePath, caption) {
      if (stopped) return null;
      return sendWecomPhoto(wsClient, _runtime.wecomActiveFrame, imagePath, caption, generateReqId);
    },
  };
}

// ─── Mode Switching ─────────────────────────────────────────────────

/**
 * Switch the active bidirectional listener at runtime.
 * 1. Stop the current listener (Telegram bot / WeCom WebSocket)
 * 2. Update pushoo channels
 * 3. Start the new listener if the target is a bidirectional channel
 */
async function switchActiveListener(newChannels, ctx) {
  console.log(`[Switch] ═══════════════════════════════════════════════════`);
  console.log(`[Switch] Channel switch initiated at ${new Date().toISOString()}`);
  console.log(`[Switch] New channels config: ${JSON.stringify(newChannels.map(c => ({ platform: c.platform, hasToken: !!c.token, tokenLen: c.token ? c.token.length : 0 })))}`);
  console.log(`[Switch] Current listener: ${_runtime.listener ? _runtime.listener.type : 'none'}`);
  console.log(`[Switch] Current pushooChannels: ${JSON.stringify(ctx.pushooChannels.map(c => c.platform))}`);

  // Step 1: stop current listener
  if (_runtime.listener) {
    const oldType = _runtime.listener.type;
    console.log(`[Switch] Step 1: Stopping ${oldType} listener...`);
    try {
      await _runtime.listener.stop();
      console.log(`[Switch] Step 1: ✅ ${oldType} listener stopped successfully.`);
    } catch (stopErr) {
      console.error(`[Switch] Step 1: ⚠️ Error stopping ${oldType} listener: ${stopErr.message}`);
      console.error(`[Switch] Step 1: Stack: ${stopErr.stack}`);
    }
    _runtime.listener = null;
    // Grace period: allow the old connection (Telegram long-poll / WeCom WebSocket)
    // to fully close before starting a new listener. This prevents 409 Conflict
    // errors with Telegram or lingering WebSocket states.
    const gracePeriodMs = 2500;
    console.log(`[Switch] Step 1: Waiting ${gracePeriodMs}ms grace period for clean connection release...`);
    await new Promise(r => setTimeout(r, gracePeriodMs));
    console.log(`[Switch] Step 1: Grace period complete.`);
  } else {
    console.log(`[Switch] Step 1: No existing listener to stop.`);
  }

  // Step 2: update channels
  const oldChannels = [...ctx.pushooChannels];
  ctx.pushooChannels.length = 0;
  ctx.pushooChannels.push(...newChannels);
  console.log(`[Switch] Step 2: Channels updated. Old: [${oldChannels.map(c => c.platform)}] → New: [${ctx.pushooChannels.map(c => c.platform)}]`);

  // Step 3: determine and start new listener
  const tgChannel = newChannels.find(ch => ch.platform === 'telegram');
  const wecomChannel = newChannels.find(ch => ch.platform === 'wecombot');
  console.log(`[Switch] Step 3: Detecting target listener...`);
  console.log(`[Switch]   Telegram channel found: ${!!tgChannel} (hasToken: ${!!(tgChannel && tgChannel.token)})`);
  console.log(`[Switch]   WeCom channel found: ${!!wecomChannel} (hasToken: ${!!(wecomChannel && wecomChannel.token)})`);

  let newListener = null;
  if (tgChannel && tgChannel.token) {
    console.log(`[Switch] Step 3: Creating Telegram listener...`);
    try {
      newListener = await createTelegramListener(ctx);
      console.log(`[Switch] Step 3: ✅ Telegram listener created: ${newListener ? 'success' : 'returned null'}`);
    } catch (createErr) {
      console.error(`[Switch] Step 3: ❌ Failed to create Telegram listener: ${createErr.message}`);
      console.error(`[Switch] Step 3: Stack: ${createErr.stack}`);
    }
  } else if (wecomChannel && wecomChannel.token) {
    console.log(`[Switch] Step 3: Creating WeCom listener...`);
    try {
      newListener = await createWecomListener(ctx);
      console.log(`[Switch] Step 3: ✅ WeCom listener created: ${newListener ? 'success' : 'returned null'}`);
    } catch (createErr) {
      console.error(`[Switch] Step 3: ❌ Failed to create WeCom listener: ${createErr.message}`);
      console.error(`[Switch] Step 3: Stack: ${createErr.stack}`);
    }
  } else {
    console.log(`[Switch] Step 3: No bidirectional channel detected — notification-only mode.`);
  }

  _runtime.listener = newListener;
  const newType = newListener ? newListener.type : 'notification-only';
  console.log(`[Switch] ✅ Switch complete. Active mode: ${newType}`);
  console.log(`[Switch]   Channels: ${newChannels.map(c => c.platform).join(', ')}`);
  console.log(`[Switch]   _runtime.listener type: ${_runtime.listener ? _runtime.listener.type : 'null'}`);
  console.log(`[Switch] ═══════════════════════════════════════════════════`);

  return newType;
}

// ─── Unified Browser Polling ────────────────────────────────────────
//
// Always-running polling loop that handles:
// 1. Control commands (__SWITCH_CHANNEL__, __STATUS__, __WAKE__, etc.)
// 2. Regular messages (processed through agent graph)
//
// When a bidirectional listener (Telegram/WeCom) is active, regular
// messages from the browser are processed AND forwarded to the listener.
// When no listener is active, responses go through pushoo notifications.

// ─── Scheduler ──────────────────────────────────────────────────────
//
// Ticks every 30 seconds, checks _scheduleManager for due tasks, and
// processes them like user messages — no GitHub Actions involved.

function startScheduler(ctx) {
  const { repoStore, pushooChannels, agentGraph, graphState, history, loopKey, historyPath } = ctx;
  const TICK_MS = 30 * 1000; // check every 30 seconds

  const tick = async () => {
    const now = new Date();
    const due = _scheduleManager.getDueTasks(now);
    for (const task of due) {
      console.log(`[Scheduler] Firing task "${task.name}" (cron: ${task.cron})`);
      // Mark ran immediately to avoid double-firing if processing takes time
      _scheduleManager.markRan(task.slug, now);

      // Persist lastRunAt to repo so it survives restarts
      if (repoStore) {
        try {
          const recPath = `loop-agent/schedules/${task.slug}.json`;
          let record = { ...task };
          try {
            const existing = await repoStore.readFile(recPath);
            if (existing) record = { ...JSON.parse(existing.content), lastRunAt: now.toISOString() };
          } catch { /* new record */ }
          record.lastRunAt = now.toISOString();
          if (!record.executions) record.executions = [];
          record.executions.push({ timestamp: now.toISOString() });
          if (record.executions.length > 20) record.executions = record.executions.slice(-20);
          await repoStore.writeFile(recPath, JSON.stringify(record, null, 2), `[scheduled] Record run for ${task.slug}`);
        } catch (e) {
          console.warn(`[Scheduler] Failed to persist record for ${task.slug}: ${e.message}`);
        }
      }

      // Build the message delivered to the agent
      const msgText = [
        `[Scheduled Task: ${task.name}]`,
        task.description ? task.description : '',
        task.prompt,
      ].filter(Boolean).join('\n');

      try {
        const { responseText } = await processUserMessage(msgText, {
          agentGraph, graphState, history, repoStore, memoryStore: ctx.memoryStore, loopKey, historyPath,
          pushooChannels,
          sourcePlatform: 'scheduler',
          runtimeCtx: ctx,
        });

        // Send result to all configured notification channels
        await sendNotifications(pushooChannels, `[Scheduled] ${task.name}`, responseText);

        // Persist execution summary
        if (repoStore) {
          try {
            const recPath = `loop-agent/schedules/${task.slug}.json`;
            const existing = await repoStore.readFile(recPath);
            if (existing) {
              const record = JSON.parse(existing.content);
              if (record.executions && record.executions.length > 0) {
                record.executions[record.executions.length - 1].summary = responseText.slice(0, 300);
                await repoStore.writeFile(recPath, JSON.stringify(record, null, 2), `[scheduled] Save summary for ${task.slug}`);
              }
            }
          } catch { /* non-fatal */ }
        }

        console.log(`[Scheduler] Task "${task.name}" completed.`);
      } catch (e) {
        console.error(`[Scheduler] Task "${task.name}" failed: ${e.message}`);
        await sendNotifications(pushooChannels, `[Scheduled] ❌ ${task.name} failed`, e.message).catch(() => {});
      }
    }

    _runtime.schedulerTimer = setTimeout(tick, TICK_MS);
  };

  _runtime.schedulerTimer = setTimeout(tick, TICK_MS);
  console.log(`[Scheduler] Started — ticking every ${TICK_MS / 1000}s, ${_scheduleManager.getAll().length} task(s) loaded`);
}

function startBrowserPolling(ctx) {
  const { upstash, repoStore, loopKey } = ctx;
  if (!upstash && !repoStore) {
    console.log(`[Browser Poll] DISABLED (no Upstash or RepoStore)`);
    return;
  }

  const inboxKey = `loop:${loopKey}:inbox`;
  const outboxKey = `loop:${loopKey}:outbox`;
  const repoInboxPath = `loop-agent/channel/${loopKey}.inbox.json`;
  const repoOutboxPath = `loop-agent/channel/${loopKey}.outbox.json`;
  const basePollMs = ctx.pollInterval || 5000;

  let currentInterval = basePollMs;
  const maxInterval = basePollMs * 6;
  let emptyPolls = 0;
  const SLOW_THRESHOLD = 5;
  let pollCount = 0;
  let lastLogTime = Date.now();
  const logIntervalMs = 30000;

  console.log(`[Browser Poll] Starting (via ${upstash ? 'Upstash' : 'Repo'}, interval: ${basePollMs / 1000}s)`);

  // Helpers
  async function sendResponse(text) {
    if (upstash) await upstash.set(outboxKey, createResponse(text));
    else if (repoStore) await repoStore.writeFile(repoOutboxPath, createResponse(text), '[loop-agent] Response');
  }

  async function updateStatus(state, extra = {}) {
    if (!upstash) return;
    try {
      await upstash.set(`loop:${loopKey}:status`, JSON.stringify({
        state,
        startedAt: _runtime.startTime,
        model: `${ctx.aiProvider}/${ctx.aiModel}`,
        processedCount: _runtime.processedCount,
        lastActive: Date.now(),
        inputMode: _runtime.listener ? _runtime.listener.type : 'polling',
        dormant: _runtime.dormant,
        channels: ctx.pushooChannels.map(ch => ch.platform).join(', '),
        ...extra,
      }));
    } catch { /* non-critical */ }
  }

  // ── Control message handler ──
  async function handleControlMessage(text) {
    // __ROLL_CALL__
    if (text === '__ROLL_CALL__') {
      const lastMsg = ctx.history.messages.length > 0
        ? ctx.history.messages[ctx.history.messages.length - 1]
        : null;
      const lastContent = lastMsg
        ? `[${lastMsg.role}] ${lastMsg.content.length > 200 ? lastMsg.content.slice(0, 200) + '…' : lastMsg.content}`
        : '(no conversation yet)';
      const statusLabel = _runtime.dormant ? '💤 dormant' : '🟢 active';
      const listenerLabel = _runtime.listener ? _runtime.listener.type : 'polling';
      const response = `📋 **${loopKey}** (${statusLabel}, ${listenerLabel})\nModel: ${ctx.aiProvider}/${ctx.aiModel}\nProcessed: ${_runtime.processedCount} msgs\nLast: ${lastContent}`;
      await sendResponse(response);
      console.log(`[Control] ROLL_CALL responded`);
      return { handled: true };
    }

    // __FOCUS__:<name>
    if (text.startsWith('__FOCUS__:')) {
      const targetName = text.slice('__FOCUS__:'.length).trim();
      if (targetName === loopKey) {
        _runtime.dormant = false;
        await sendResponse(`🎯 **${loopKey}** is now the active agent. Ready for messages.`);
        console.log(`[Control] FOCUS — I am the target, staying active`);
      } else {
        _runtime.dormant = true;
        await sendResponse(`💤 **${loopKey}** entering dormant mode. Focus is on **${targetName}**.`);
        console.log(`[Control] FOCUS — target is ${targetName}, going dormant`);
      }
      await updateStatus(_runtime.dormant ? 'dormant' : 'running');
      return { handled: true };
    }

    // __WAKE__
    if (text === '__WAKE__') {
      _runtime.dormant = false;
      await sendResponse(`🟢 **${loopKey}** is now awake and active.`);
      await updateStatus('running');
      console.log(`[Control] WAKE — resuming active mode`);
      return { handled: true };
    }

    // __SWITCH_CHANNEL__:<json> — the key command: stop old listener, start new
    if (text.startsWith('__SWITCH_CHANNEL__:')) {
      const channelJson = text.slice('__SWITCH_CHANNEL__:'.length).trim();
      console.log(`[Control] ────────────────────────────────────────────`);
      console.log(`[Control] SWITCH_CHANNEL received at ${new Date().toISOString()}`);
      console.log(`[Control] Payload length: ${channelJson.length} chars`);
      try {
        const newChannels = JSON.parse(channelJson);
        console.log(`[Control] Channel count: ${newChannels.length}`);
        console.log(`[Control] Channel platforms: ${newChannels.map(ch => ch.platform).join(', ')}`);
        console.log(`[Control] Channel token lengths: ${newChannels.map(ch => `${ch.platform}=${ch.token ? ch.token.length : 0}`).join(', ')}`);
        if (Array.isArray(newChannels) && newChannels.length > 0) {
          console.log(`[Control] Validation passed. Calling switchActiveListener()...`);
          const switchStart = Date.now();
          const newType = await switchActiveListener(newChannels, ctx);
          const switchDuration = Date.now() - switchStart;
          const summary = newChannels.map(ch => ch.platform).join(', ');
          console.log(`[Control] switchActiveListener() returned: ${newType} (took ${switchDuration}ms)`);
          const responseMsg = `📡 **${loopKey}** switched to **${newType}** (channels: ${summary})`;
          await sendResponse(responseMsg);
          await updateStatus('running');
          console.log(`[Control] ✅ SWITCH_CHANNEL complete → ${newType} (${summary})`);
        } else {
          console.warn(`[Control] ⚠️ Validation failed: array is empty or not an array. isArray=${Array.isArray(newChannels)}, length=${newChannels.length}`);
          await sendResponse(`⚠️ Invalid channel config: expected non-empty array.`);
        }
      } catch (e) {
        console.error(`[Control] ❌ SWITCH_CHANNEL error: ${e.message}`);
        console.error(`[Control] Error stack: ${e.stack}`);
        console.error(`[Control] Raw channelJson that failed: ${channelJson}`);
        await sendResponse(`⚠️ Channel switch failed: ${e.message}`);
      }
      console.log(`[Control] ────────────────────────────────────────────`);
      return { handled: true };
    }

    // __STATUS__
    if (text === '__STATUS__') {
      const elapsedMin = Math.round((Date.now() - _runtime.startTime) / 60000);
      const channelList = ctx.pushooChannels.map(ch => ch.platform).join(', ') || 'none';
      const listenerType = _runtime.listener ? _runtime.listener.type : 'none';
      const memUsage = process.memoryUsage();
      const status = [
        `📊 **${loopKey}** Status`,
        `State: ${_runtime.dormant ? '💤 dormant' : '🟢 active'}`,
        `Listener: ${listenerType}`,
        `Runtime: ${elapsedMin} min`,
        `Messages processed: ${_runtime.processedCount}`,
        `Model: ${ctx.aiProvider}/${ctx.aiModel}`,
        `Channels: ${channelList}`,
        `Upstash: ${upstash ? '✓' : '✗'}`,
        `Memory: ${Math.round(memUsage.heapUsed / 1048576)}MB / ${Math.round(memUsage.heapTotal / 1048576)}MB`,
        '',
        formatTaskProgressText(),
      ].join('\n');
      await sendResponse(status);
      console.log(`[Control] STATUS responded`);
      return { handled: true };
    }

    return { handled: false };
  }

  // ── Polling loop ──
  const pollOnce = async () => {
    try {
      pollCount++;
      const now = Date.now();

      // Periodic alive log
      if (now - lastLogTime >= logIntervalMs) {
        const elapsedMin = Math.round((now - _runtime.startTime) / 60000);
        const listenerLabel = _runtime.listener ? _runtime.listener.type : 'none';
        console.log(`[Browser Poll] ✓ Active (${elapsedMin}min, ${pollCount} polls, ${_runtime.processedCount} msgs, listener=${listenerLabel}, dormant=${_runtime.dormant})`);
        lastLogTime = now;
      }

      // Check runtime limit
      if (now - _runtime.startTime >= ctx.maxRuntime) {
        console.log(`[Browser Poll] Max runtime reached (${ctx.maxRuntime / 1000}s). Attempting restart...`);
        if (_runtime.listener) await _runtime.listener.stop();
        const restarted = await selfRestart();
        const msg = restarted
          ? `♻️ Loop Agent restarting (max runtime). Processed ${_runtime.processedCount} messages.`
          : `⏱ Loop Agent shutting down (max runtime). Processed ${_runtime.processedCount} messages.`;
        await sendNotifications(ctx.pushooChannels, `[Loop Agent] ${restarted ? 'Restarting' : 'Shutting Down'}`, msg);
        await updateStatus('restarting', { stoppedAt: Date.now() });
        process.exit(0);
      }

      // Poll for message
      let msg = null;
      if (upstash) {
        const raw = await upstash.get(inboxKey);
        msg = parseMessage(raw);
        if (msg) await upstash.set(inboxKey, markAsRead(msg));
      } else if (repoStore) {
        const file = await repoStore.readFile(repoInboxPath);
        if (file) {
          msg = parseMessage(file.content);
          if (msg) {
            try { await repoStore.writeFile(repoInboxPath, markAsRead(msg), '[loop-agent] Mark read'); }
            catch (e) { console.warn(`[Browser Poll] Mark read failed: ${e.message}`); }
          }
        }
      }

      if (!msg) {
        emptyPolls++;
        if (emptyPolls === SLOW_THRESHOLD) {
          currentInterval = maxInterval;
          console.log(`[Browser Poll] Idle, slowing to ${currentInterval / 1000}s`);
        }
        _runtime.pollTimer = setTimeout(pollOnce, currentInterval);
        return;
      }

      // Got a message — reset to fast polling
      if (emptyPolls >= SLOW_THRESHOLD) {
        console.log(`[Browser Poll] Message received, restoring ${basePollMs / 1000}s interval`);
      }
      emptyPolls = 0;
      currentInterval = basePollMs;

      // ── Control messages (always processed, even when dormant) ──
      if (msg.text.startsWith('__')) {
        const ctrl = await handleControlMessage(msg.text);
        if (ctrl.handled) {
          _runtime.pollTimer = setTimeout(pollOnce, currentInterval);
          return;
        }
      }

      // If a task is already running, return live progress immediately.
      if (_runtime.processing) {
        await sendResponse(`⏳ Still processing.\n\n${formatTaskProgressText()}`);
        _runtime.pollTimer = setTimeout(pollOnce, currentInterval);
        return;
      }

      // ── Dormant mode — ignore regular messages ──
      if (_runtime.dormant) {
        console.log(`[Browser Poll] Dormant — ignoring message (${msg.text.length} chars)`);
        _runtime.pollTimer = setTimeout(pollOnce, currentInterval);
        return;
      }

      // ── Regular message — process through agent graph ──
      _runtime.processing = true;
      console.log(`[Browser Poll] Processing message (${msg.text.length} chars)`);

      try {
        const result = await processUserMessage(msg.text, {
          agentGraph: ctx.agentGraph, graphState: ctx.graphState,
          history: ctx.history, repoStore: ctx.repoStore,
          loopKey: ctx.loopKey, historyPath: ctx.historyPath,
          memoryStore: ctx.memoryStore,
          pushooChannels: ctx.pushooChannels,
          sourcePlatform: _runtime.listener ? _runtime.listener.type : 'polling',
          runtimeCtx: ctx,
        });
        const responseText = result.responseText;
        const hasDeliveryOverride = !!(result.delivery && result.delivery.platform);

        console.log(`[Browser Poll] Response (${responseText.length} chars)`);

        // Send response to browser (Upstash outbox)
        await sendResponse(responseText);

        // Forward to active listener if available
        if (_runtime.listener && _runtime.listener.sendMsg) {
          try { await _runtime.listener.sendMsg(responseText); } catch { /* best effort */ }
        }

        // Send pushoo notifications (for non-bidirectional channels)
        // In notification-only mode, this is the only way the user gets responses
        if (!_runtime.listener && !hasDeliveryOverride) {
          const truncated = responseText.length > 500 ? responseText.slice(0, 500) + '...' : responseText;
          await sendNotifications(ctx.pushooChannels, `[Reply] [Loop Agent] Reply`, truncated);
        }

        _runtime.processedCount++;
        await updateStatus('running', { lastActive: Date.now() });
      } catch (e) {
        console.error(`[Browser Poll] Processing error: ${e.message}`);
        await sendResponse(`❌ Error: ${e.message}`);
      } finally {
        _runtime.processing = false;
      }
    } catch (e) {
      console.error(`[Browser Poll] Poll error: ${e.message}`);
    }

    _runtime.pollTimer = setTimeout(pollOnce, currentInterval);
  };

  // Write initial status
  updateStatus('running').catch(() => {});

  _runtime.pollTimer = setTimeout(pollOnce, basePollMs);
}

// ─── Main Entry Point ───────────────────────────────────────────────

async function main() {
  const UPSTASH_URL = process.env.UPSTASH_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN;
  const LOOP_KEY = process.env.LOOP_KEY;
  const AI_PROVIDER = process.env.AI_PROVIDER || 'gemini';
  const AI_MODEL = process.env.AI_MODEL || 'gemini-2.0-flash';
  const AI_API_KEY = process.env.AI_API_KEY;
  let PUSHOO_CHANNELS = parsePushooChannels();
  const GH_PAT = process.env.GH_PAT;
  const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
  const LOOP_DATA_REPOSITORY = process.env.LOOP_DATA_REPOSITORY || GITHUB_REPOSITORY;
  const LOOP_WORKFLOW_FILE = process.env.LOOP_WORKFLOW_FILE || '';
  const LOOP_HISTORY_PATH = process.env.LOOP_HISTORY_PATH || 'loop-agent/history';
  const POLL_INTERVAL = parseInt(process.env.LOOP_POLL_INTERVAL || '5', 10) * 1000;
  const MAX_RUNTIME = parseInt(process.env.LOOP_MAX_RUNTIME || '18000', 10) * 1000;
  const SYSTEM_PROMPT = process.env.LOOP_SYSTEM_PROMPT || '';

  // Extract channel configs
  const telegramChannel = PUSHOO_CHANNELS.find(ch => normalizePlatformName(ch.platform) === 'telegram');
  const wecomChannel = PUSHOO_CHANNELS.find(ch => normalizePlatformName(ch.platform) === 'wecombot');
  const useTelegram = !!(telegramChannel && telegramChannel.token);
  const useWecom = !!(wecomChannel && wecomChannel.token);
  const hasUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);
  const hasRepoStore = !!(GH_PAT && LOOP_DATA_REPOSITORY);

  // Validate required env
  if (!useTelegram && !useWecom && !hasUpstash && !hasRepoStore) {
    console.error('[FATAL] Either Telegram, WeCom Bot, Upstash, or GitHub repo access (GH_PAT) is required for messaging');
    process.exit(1);
  }
  if (!LOOP_KEY) {
    console.error('[FATAL] LOOP_KEY is required');
    process.exit(1);
  }
  if (!AI_API_KEY) {
    console.error('[FATAL] AI_API_KEY is required');
    process.exit(1);
  }

  const inputMode = useTelegram ? 'Telegram' : useWecom ? 'WeCom' : hasUpstash ? 'Upstash' : 'Repo';
  console.log(`[Loop Agent] Starting...`);
  console.log(`  Key: ${LOOP_KEY}`);
  console.log(`  Provider: ${AI_PROVIDER}, Model: ${AI_MODEL}`);
  console.log(`  Input mode: ${inputMode}`);
  console.log(`  Max runtime: ${MAX_RUNTIME / 1000}s`);

  // Upstash client (optional — used for browser polling in all modes)
  const upstash = (UPSTASH_URL && UPSTASH_TOKEN)
    ? new UpstashClient(UPSTASH_URL, UPSTASH_TOKEN)
    : null;

  console.log(`[Main] Upstash: ${upstash ? '✓ created' : '❌ null (missing env variables)'}`);

  // ── Upstash connectivity test ──
  if (upstash) {
    const inboxKey = `loop:${LOOP_KEY}:inbox`;
    const outboxKey = `loop:${LOOP_KEY}:outbox`;
    const statusKey = `loop:${LOOP_KEY}:status`;
    console.log(`[Upstash] URL: ${UPSTASH_URL.slice(0, 30)}...`);
    console.log(`[Upstash] Keys — inbox: ${inboxKey}, outbox: ${outboxKey}, status: ${statusKey}`);
    try {
      await upstash.ping();
      console.log(`[Upstash] ✅ Connection verified (PING → PONG)`);
      const pending = await upstash.get(inboxKey);
      if (pending) {
        const msg = parseMessage(pending);
        console.log(`[Upstash] Inbox has ${msg ? 'an UNREAD' : 'a read/empty'} message waiting`);
      } else {
        console.log(`[Upstash] Inbox is empty`);
      }
    } catch (e) {
      console.error(`[Upstash] ❌ Connection FAILED: ${e.message}`);
      if (!useTelegram && !useWecom && hasUpstash && !hasRepoStore) {
        console.error(`[FATAL] Upstash is the only messaging channel but connection failed`);
        process.exit(1);
      }
    }
  } else {
    console.log(`[Upstash] Not configured — ${hasRepoStore ? 'using repo-based polling' : 'N/A'}`);
  }

  const repoStore = GH_PAT && LOOP_DATA_REPOSITORY
    ? new RepoStore(GH_PAT, LOOP_DATA_REPOSITORY)
    : null;

  // Load persisted runtime channel configuration (if any) and override env defaults.
  if (repoStore) {
    const persistedChannels = await loadRuntimeChannels(repoStore, LOOP_KEY);
    if (persistedChannels.length > 0) {
      PUSHOO_CHANNELS = persistedChannels;
      console.log(`[Channel] Loaded runtime channel override (${persistedChannels.map(c => c.platform).join(', ')})`);
    }
  }

  console.log(`[Loop Agent] Data repository: ${LOOP_DATA_REPOSITORY || '(disabled)'}`);
  _runtime.currentDataRepo = LOOP_DATA_REPOSITORY || '';

  // Load conversation history
  const history = new ConversationHistory(
    repoStore,
    `${LOOP_HISTORY_PATH}/${LOOP_KEY}`
  );
  if (repoStore) await history.load();

  // Load persistent JSON memory for remember/recall and repeated-task cache
  const memoryStore = new AgentMemoryStore(
    repoStore,
    `${LOOP_HISTORY_PATH}/${LOOP_KEY}.memory.json`
  );
  if (repoStore) await memoryStore.load();

  // Create LLM and agent graph
  let agentGraph;
  let graphState;
  try {
    const llm = createLLM(AI_PROVIDER, AI_MODEL, AI_API_KEY);
    // Create a notification callback for the Explorer sub-agent to send
    // intermediate progress updates so users don't experience long silences.
    const explorerNotifyFn = async (msg) => {
      try {
        if (_runtime.listener && _runtime.listener.sendMsg) {
          await _runtime.listener.sendMsg(msg);
        } else {
          await sendNotifications(PUSHOO_CHANNELS, '[Explorer Progress]', msg);
        }
      } catch (e) {
        console.error(`[Explorer Notify] Failed: ${e.message}`);
      }
    };
    const tools = createBuiltinTools(repoStore, llm, explorerNotifyFn, memoryStore);
    console.log(`[Tools] Registered ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);

    const checkpointer = new Checkpointer(repoStore, LOOP_HISTORY_PATH);
    graphState = await checkpointer.load(LOOP_KEY);

    agentGraph = new AgentGraph({
      llm, tools, systemPrompt: SYSTEM_PROMPT, repoStore, memoryStore,
      checkpointer, threadId: LOOP_KEY,
    });

    agentGraph.restoreExtensions(graphState);

    console.log(`[Loop Agent] Agent graph created (phase: ${graphState.phase}, turn: ${graphState.turnCount || 0})`);
    if (graphState.timing) {
      printTimingSummary(graphState);
    }
  } catch (e) {
    console.error(`[FATAL] Failed to create agent graph: ${e.message}`);
    await sendNotifications(PUSHOO_CHANNELS,
      `[Reply] [Loop Agent] Startup Failed`,
      `Failed to create AI agent: ${e.message}`);
    process.exit(1);
  }

  // ── Shared context (passed to listeners and browser polling) ──
  const ctx = {
    agentGraph, graphState, history, repoStore, memoryStore, upstash,
    loopKey: LOOP_KEY, historyPath: LOOP_HISTORY_PATH,
    pushooChannels: PUSHOO_CHANNELS,
    maxRuntime: MAX_RUNTIME, pollInterval: POLL_INTERVAL,
    aiProvider: AI_PROVIDER, aiModel: AI_MODEL,
  };

  _runtime.startTime = Date.now();

  // ── Startup notification ──
  const activeTelegramChannel = PUSHOO_CHANNELS.find(ch => normalizePlatformName(ch.platform) === 'telegram' && ch.token);
  const activeWecomChannel = PUSHOO_CHANNELS.find(ch => normalizePlatformName(ch.platform) === 'wecombot' && ch.token);
  const activeInputMode = activeTelegramChannel
    ? 'Telegram'
    : activeWecomChannel
      ? 'WeCom'
      : hasUpstash
        ? 'Upstash'
        : 'Repo';

  const introMsg = [
    `🤖 Loop Agent Started`,
    `Key: ${LOOP_KEY}`,
    `Model: ${AI_PROVIDER}/${AI_MODEL}`,
    `Mode: ${activeInputMode}`,
    `Max Runtime: ${MAX_RUNTIME / 1000}s`,
    SYSTEM_PROMPT ? `System Prompt: ${SYSTEM_PROMPT.slice(0, 200)}${SYSTEM_PROMPT.length > 200 ? '...' : ''}` : '',
  ].filter(Boolean).join('\n');

  // ── Start initial listener ──
  if (activeTelegramChannel) {
    const { botToken, chatId } = parseTelegramToken(activeTelegramChannel.token);
    // Send intro to Telegram directly
    try {
      if (chatId) {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: introMsg }),
        });
      }
    } catch (e) {
      console.warn(`[Telegram] Failed to send intro: ${e.message}`);
    }
    _runtime.listener = await createTelegramListener(ctx);
  } else if (activeWecomChannel) {
    _runtime.listener = await createWecomListener(ctx);
  } else {
    // Upstash/Repo mode — no bidirectional listener
    await sendNotifications(PUSHOO_CHANNELS, `[Loop Agent] ${LOOP_KEY} Started`, introMsg);
  }

  // ── Start browser polling (always runs) ──
  startBrowserPolling(ctx);

  // ── Load persisted scheduled tasks from repo ──
  if (repoStore) {
    try {
      const resp = await fetch(
        `${repoStore.api}/repos/${repoStore.owner}/${repoStore.repo}/contents/loop-agent/schedules?ref=main`,
        { headers: repoStore._headers() }
      );
      if (resp.ok) {
        const files = await resp.json();
        let loaded = 0;
        for (const f of files.filter(f => f.name.endsWith('.json'))) {
          try {
            const data = await repoStore.readFile(`loop-agent/schedules/${f.name}`);
            if (data) {
              const rec = JSON.parse(data.content);
              if (rec.deleted === true) continue;
              if (rec.slug && rec.cron && rec.prompt) {
                _scheduleManager.register(rec);
                loaded++;
              }
            }
          } catch { /* skip corrupted */ }
        }
        console.log(`[Scheduler] Loaded ${loaded} scheduled task(s) from repo.`);
      }
    } catch (e) {
      console.warn(`[Scheduler] Could not load tasks from repo: ${e.message}`);
    }
  }

  // ── Start in-process scheduler (replaces GHA cron) ──
  startScheduler(ctx);

  // ── Graceful shutdown ──
  const shutdown = async (signal) => {
    console.log(`[Main] ${signal} received, shutting down...`);
    if (_runtime.pollTimer) clearTimeout(_runtime.pollTimer);
    if (_runtime.schedulerTimer) clearTimeout(_runtime.schedulerTimer);
    if (_runtime.listener) {
      await _runtime.listener.stop();
      _runtime.listener = null;
    }
    if (signal === 'SIGTERM') {
      console.log(`[Main] Attempting self-restart...`);
      const restarted = await selfRestart();
      console.log(`[Main] Self-restart: ${restarted ? 'dispatched' : 'failed'}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log(`[Loop Agent] ✅ Ready. Listener: ${_runtime.listener ? _runtime.listener.type : 'none'}, Polling: active`);

  // Block forever — event loop is kept alive by Telegraf/WeCom/setTimeout
  await new Promise(() => {});
}

// Safety net: prevent unhandled promise rejections (e.g. from VM-executed async
// code) from crashing the process. Log the error and continue running.
process.on('unhandledRejection', (reason, promise) => {
  console.error(`[SAFETY] Unhandled promise rejection: ${reason}`);
  if (reason && reason.stack) console.error(`[SAFETY] Stack: ${reason.stack}`);
});

main().catch(err => {
  console.error(`[FATAL] Unhandled error: ${err.message}`);
  process.exit(1);
});

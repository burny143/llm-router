// setup-qwen-cookie.js
//
// One-shot Qwen (chat.qwen.ai) cookie capture: opens a headed browser, waits for
// the user to be logged in, auto-sends a test message, captures the chat
// completion request (URL + headers + payload) and the session cookies, then
// wires everything into the runtime data files:
//   - QWEN_COOKIE   -> data/.env  (line-preserving update)
//   - Qwen row      -> data/ProviderConfig.csv (quote-aware, column-safe)
//   - Qwen rules    -> data/web-provider-rules.json
//
// Run: node setup-qwen-cookie.js
//
// The capture listener matches Qwen's ACTUAL chat endpoint. It must NOT rely on
// a `.json` URL suffix — Qwen's endpoint is
//   https://chat.qwen.ai/api/v2/chat/completions
// which does not end in `.json`. This script uses a non-intercepting
// page.on('request') listener filtered by method + URL substring instead of
// page.route('**/*.json', ...), so the capture actually fires.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { getFilePath, parseCsv } = require('./state-store');
const { DEFAULT_COOKIE_USER_AGENT, QWEN_PROVIDER_NAME, FILE_ROLES } = require('./shared-constants');

const QWEN_START_URL = 'https://chat.qwen.ai';
// The chat-completion endpoint path segment Qwen's SPA POSTs to. Matched as a
// URL substring (case-insensitive) — NOT a file-extension match. Falling back
// to any POST with a chat-like JSON payload keeps the capture working if Qwen
// ever renames the endpoint (e.g. v3), which the old `**/*.json` route could
// never survive.
const CHAT_ENDPOINT_MARKERS = ['/chat/completions', '/api/v2/chat/completions', '/api/chat/completions'];

// Selector fallback lists — any single one matching is enough, so a Qwen UI
// text change degrades gracefully instead of silently timing out.
const CHAT_INPUT_SELECTORS = [
  'textarea[placeholder*="message" i]',
  'textarea[placeholder*="Message" i]',
  'textarea',
  'div[contenteditable="true"]',
  'div[contenteditable="plaintext-only"]'
];
const SEND_BUTTON_SELECTORS = [
  'button[aria-label*="Send" i]',
  'button[data-testid*="send" i]',
  'button:has-text("Send")',
  'button[type="submit"]'
];
const SEND_WAIT_MAX_MS = 15000;

// Quote-aware CSV field serializer — the write-side counterpart of state-store's
// parseCsv. Never hand-roll CSV output with plain join(',') here: a baseURL that
// contains a comma (e.g. a query-string comma) would misalign every later row.
function escapeCsvValue(value) {
  if (value == null) return '';
  const str = String(value);
  return (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r'))
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

function serializeCsv(headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => escapeCsvValue(row[h])).join(','));
  }
  return lines.join('\n') + '\n';
}

// Update a single KEY=value in an existing .env, preserving every other line
// (comments, formatting, unrelated vars) exactly as-is. Appends a new line if
// the key doesn't exist yet. Always ends with a trailing newline.
function upsertEnvLine(envPath, key, value) {
  const safeValue = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const lines = content.split(/\r?\n/);
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith(`${key}=`) || trimmed.startsWith(`export ${key}=`)) {
      const exportPrefix = trimmed.startsWith('export ') ? 'export ' : '';
      lines[i] = `${exportPrefix}${key}="${safeValue}"`;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    lines.push(`${key}="${safeValue}"`);
  }
  const out = lines.join('\n').trimEnd() + '\n';
  fs.writeFileSync(envPath, out);
  return out;
}

function looksLikeChatPayload(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return false;
  if (Array.isArray(value)) return value.some(item => looksLikeChatPayload(item, depth + 1));
  const keys = Object.keys(value);
  const lower = keys.map(k => k.toLowerCase());
  if (lower.includes('role') && lower.includes('content')) return true;
  if (lower.includes('messages') && Array.isArray(value[keys[lower.indexOf('messages')]])) return true;
  return keys.some(k => value[k] && typeof value[k] === 'object' && looksLikeChatPayload(value[k], depth + 1));
}

async function findChatInput(page) {
  for (const sel of CHAT_INPUT_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 1500 })) return loc;
    } catch (e) { /* try next */ }
  }
  return null;
}

async function sendTestMessage(page) {
  const chatInput = await findChatInput(page);
  if (!chatInput) {
    console.log('Could not find a chat input — please type and send a test message manually.');
    return false;
  }
  await chatInput.click();
  await page.waitForTimeout(300);
  await page.keyboard.type('Hello, this is a test message from LLM Proxy Router!', { delay: 20 });
  await page.waitForTimeout(400);

  // Wait (bounded) for a send button to become enabled — many editors keep it
  // disabled until there is text; clicking it while disabled burns the whole
  // Playwright actionability timeout.
  const sendBtn = page.locator(SEND_BUTTON_SELECTORS.join(',')).first();
  let enabled = false;
  for (let waited = 0; waited < SEND_WAIT_MAX_MS; waited += 250) {
    enabled = await sendBtn.isEnabled().catch(() => false);
    if (enabled) break;
    await page.waitForTimeout(250);
  }
  if (enabled) {
    await sendBtn.click().catch(() => {});
  } else {
    await chatInput.press('Enter').catch(() => {});
  }
  await page.waitForTimeout(600);
  return true;
}

async function setupQwenCookie() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: DEFAULT_COOKIE_USER_AGENT
  });
  const page = await context.newPage();

  console.log('Opening Qwen chat in browser window...');
  console.log('Please log in to Qwen (https://chat.qwen.ai) if prompted.');

  await page.goto(QWEN_START_URL);

  // Non-intercepting capture listener (page.on, not page.route): it never
  // blocks or continues requests, so there is no route that can silently
  // swallow the very request we are trying to capture.
  let capturedRequest = null;
  let requestPayload = null;
  let cookies = null;

  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const url = request.url();
    if (!url.includes('chat.qwen.ai')) return;
    const postData = request.postData();
    let payload = null;
    try { payload = JSON.parse(postData || '{}'); } catch (e) { payload = null; }

    const urlMatch = CHAT_ENDPOINT_MARKERS.some(m => url.toLowerCase().includes(m));
    const payloadMatch = payload && looksLikeChatPayload(payload);
    if (!urlMatch && !payloadMatch) return;

    if (capturedRequest) return; // keep the first real chat request
    capturedRequest = request;
    requestPayload = payload;
    console.log('Captured Qwen API request:', url);
  });

  console.log('Ready! Please log in if prompted.');

  const autoSent = await sendTestMessage(page);
  if (!autoSent) {
    console.log('Auto-send did not go through — please type and send a test message manually.');
  }

  console.log('Waiting for API response...');

  // Wait for capture with a hard ceiling; bail with a clear error instead of
  // looping forever (the old route never matched, so this loop used to burn all
  // 60 attempts and exit(1) even when everything else worked).
  let attempts = 0;
  while (!capturedRequest && attempts < 60) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    attempts++;
    if (attempts % 10 === 0 || attempts === 1) {
      console.log(`Waiting for request capture (${attempts}/60)...`);
    }
  }

  if (!capturedRequest) {
    console.error('Failed to capture Qwen API request. Please make sure you are on the Qwen chat page and have sent a message.');
    await browser.close();
    process.exit(1);
  }

  console.log('\n=== Captured Qwen API Details ===');
  console.log('Request URL:', capturedRequest.url());
  console.log('Method:', capturedRequest.method());
  console.log('Payload:', JSON.stringify(requestPayload, null, 2));

  cookies = await context.cookies();
  const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

  // Save cookies to .env — line-preserving upsert so comments/formatting in the
  // original .env survive.
  const envPath = getFilePath(FILE_ROLES.ENV);
  try {
    upsertEnvLine(envPath, 'QWEN_COOKIE', cookieString);
    console.log('\n✓ Cookie saved to .env as QWEN_COOKIE');
  } catch (err) {
    console.error('Failed to save cookie to .env:', err.message);
    await browser.close();
    process.exit(1);
  }

  // Update ProviderConfig.csv using the shared quote-aware parseCsv + a matching
  // quote-aware serializer, so baseURLs containing commas can't corrupt columns.
  const configPath = getFilePath(FILE_ROLES.PROVIDER_CONFIG);
  const configContent = fs.readFileSync(configPath, 'utf-8');
  const headerLine = configContent.split(/\r?\n/)[0] || '';
  const headerColumns = headerLine.split(',').map(h => h.trim()).filter(Boolean);
  const rows = parseCsv(configContent);

  // Add authType column if missing — and BACKFILL every existing row with an
  // empty value for it so the CSV stays rectangular (a ragged column count
  // would misalign any positional parser downstream).
  const AUTH_TYPE_COLUMN = 'authType';
  let authTypeAdded = false;
  if (!headerColumns.includes(AUTH_TYPE_COLUMN)) {
    headerColumns.push(AUTH_TYPE_COLUMN);
    authTypeAdded = true;
    for (const row of rows) row[AUTH_TYPE_COLUMN] = '';
  }

  // Extract baseURL from the captured request: strip the query string rather
  // than doing a naive substring split on "/chat" (which would truncate
  // /api/v2/chat/completions at the wrong point for any URL that merely
  // *contains* /chat earlier in the path).
  const requestUrl = capturedRequest.url();
  const baseUrl = requestUrl.split('?')[0];

  const qwenIndex = rows.findIndex(r => (r.provider || '').trim() === QWEN_PROVIDER_NAME);
  const qwenEntry = {
    provider: QWEN_PROVIDER_NAME,
    baseURL: baseUrl,
    apiKeyEnv: 'QWEN_COOKIE',
    modelsEndpoint: '',
    authType: 'Cookie'
  };

  if (qwenIndex >= 0) {
    rows[qwenIndex] = { ...rows[qwenIndex], ...qwenEntry };
    console.log('✓ Updated existing Qwen entry');
  } else {
    rows.push(qwenEntry);
    console.log('✓ Added new Qwen entry');
  }

  fs.writeFileSync(configPath, serializeCsv(headerColumns, rows));
  console.log('✓ ProviderConfig.csv updated (Qwen added with authType=Cookie)');

  // Save request rules for the runtime proxy's Cookie-auth translation.
  const capturedHeaders = capturedRequest.headers();
  const rulesPath = getFilePath(FILE_ROLES.WEB_PROVIDER_RULES);
  const rules = {
    sampleRequest: {
      url: capturedRequest.url(),
      method: capturedRequest.method(),
      headers: capturedHeaders,
      payload: requestPayload
    },
    requiredHeaders: {
      'User-Agent': capturedHeaders['user-agent'] || capturedHeaders['User-Agent'] || DEFAULT_COOKIE_USER_AGENT,
      'Origin': capturedHeaders['origin'] || 'https://chat.qwen.ai',
      'Referer': capturedHeaders['referer'] || 'https://chat.qwen.ai/',
      'Accept': capturedHeaders['accept'] || 'application/json',
      'Content-Type': capturedHeaders['content-type'] || 'application/json',
      'Cookie': capturedHeaders['cookie'] || ''
    }
  };
  fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2));
  console.log('✓ Web provider rules saved to data/web-provider-rules.json');

  // Reload dotenv so process.env picks up the new cookie for this process.
  dotenv.config({ path: envPath, override: true });

  await browser.close();

  console.log('\n=== Qwen Cookie Setup Complete ===');
  console.log('The following actions were completed:');
  console.log('1. ✓ Qwen API request captured');
  console.log('2. ✓ Cookie saved to .env as QWEN_COOKIE');
  console.log('3. ✓ ProviderConfig.csv updated (Qwen added with authType=Cookie)');
  console.log('4. ✓ Web provider rules saved to web-provider-rules.json');
  console.log('\nNext steps:');
  console.log('- Restart the LLM Proxy Router app to load the new provider');
  console.log('- The Qwen provider will now use cookie authentication instead of Bearer tokens');
  console.log('- Qwen responses will be automatically translated to OpenAI format');

  process.exit(0);
}

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

setupQwenCookie().catch(err => {
  console.error('Error in Qwen cookie setup:', err);
  process.exit(1);
});

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { getFilePath, parseCsv, envPrefixFor } = require('./state-store');
require('dotenv').config({ path: getFilePath('env') });

async function tryFill(page, selectors, value, label) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: 'visible', timeout: 2500 });
      await loc.fill(value);
      console.log(`[auto] filled ${label} using selector: ${sel}`);
      return sel;
    } catch (e) { /* try next */ }
  }
  console.log(`[auto] could not find a ${label} field — skipping.`);
  return null;
}

async function tryClick(page, selectors, label) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: 'visible', timeout: 2000 });
      await loc.click();
      console.log(`[auto] clicked ${label} using selector: ${sel}`);
      return true;
    } catch (e) { /* try next */ }
  }
  return false;
}

const EMAIL_SELECTORS = ['input[type="email"]', 'input[autocomplete="username"]', 'input[name="email"]', 'input[name="username"]', 'input[type="text"]'];
const PHONE_SELECTORS = ['input[type="tel"]', 'input[autocomplete="tel"]', 'input[name="phone"]', 'input[placeholder*="phone" i]', 'input[placeholder*="手机" i]'];
const PASSWORD_SELECTORS = ['input[type="password"]'];
const NEXT_SELECTORS = ['button:has-text("Next")', 'button:has-text("Continue")', 'button:has-text("Get code")', 'button:has-text("Send code")', 'button:has-text("获取验证码")'];
const SUBMIT_SELECTORS = ['button:has-text("Log in")', 'button:has-text("Sign in")', 'button:has-text("Login")', 'button:has-text("Log In")', 'button[type="submit"]', 'button:has-text("登录")', 'button:has-text("验证")'];
const CHAT_INPUT_SELECTORS = ['textarea', 'div[contenteditable="true"]', 'div[contenteditable="plaintext-only"]', 'input[type="text"]', 'div[class*="chat-input" i]', 'div[data-testid*="input" i]'];
const SMS_CODE_SELECTORS = ['input[inputmode="numeric"]', 'input[autocomplete="one-time-code"]', 'input[placeholder*="code" i]', 'input[placeholder*="验证码" i]'];

const ANALYTICS_URL_PATTERNS = [/aplus\./i, /\/aes(\.|\/)/i, /analytics/i, /telemetry/i, /track(ing)?/i, /beacon/i, /sentry/i, /\/collect/i, /report/i, /metrics/i, /\/log(\/|\.)/i, /pixel/i, /hotjar/i, /clarity/i, /doubleclick/i, /umami/i, /\/stats/i, /monitor/i, /\/events?(\?|\/|$)/i, /heartbeat/i, /retention/i, /kimi\.com\/api\/(searcher|suggestion|conversation|upload|user)/i, /\.log\.kimi/i, /\.log\.moonshot/i];
function isAnalyticsUrl(url) { return ANALYTICS_URL_PATTERNS.some(re => re.test(url)); }

const CHAT_CONTAINER_KEYS = ['messages', 'contents', 'parts', 'history'];
const CHAT_TEXT_KEYS = ['prompt', 'question', 'query', 'content', 'text', 'input', 'message', 'user_message', 'input_text'];
function looksLikeChatPayload(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return false;
  if (Array.isArray(value)) return value.some(item => looksLikeChatPayload(item, depth + 1));
  const keys = Object.keys(value);
  const lowerKeys = keys.map(k => k.toLowerCase());
  if (CHAT_CONTAINER_KEYS.some(k => lowerKeys.includes(k))) return true;
  if (lowerKeys.includes('role') && lowerKeys.includes('content')) return true;
  for (let i = 0; i < keys.length; i++) {
    if (CHAT_TEXT_KEYS.includes(lowerKeys[i]) && typeof value[keys[i]] === 'string' && value[keys[i]].length > 0) return true;
  }
  return keys.some(k => value[k] && typeof value[k] === 'object' && looksLikeChatPayload(value[k], depth + 1));
}

// envPrefixFor is imported from state-store.js — the single canonical
// implementation shared by capture, runtime proxy, and cookie paths, so the
// profile dir for capture and runtime can never drift apart.

async function writeFileWithRetry(filePath, content, maxRetries = 5, delayMs = 300) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try { fs.writeFileSync(filePath, content); return; } 
    catch (err) {
      const isLockError = err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES';
      if (!isLockError || attempt === maxRetries) throw err;
      console.warn(`[retry] ${path.basename(filePath)} is locked (${err.code}), attempt ${attempt}/${maxRetries}...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

async function launchProviderBrowser(providerName) {
  const dataDir = path.dirname(getFilePath('providerConfig'));
  const profileDir = path.join(dataDir, 'browser-profiles', envPrefixFor(providerName).toLowerCase());
  const options = { headless: false, ignoreDefaultArgs: ['--enable-automation'], args: ['--disable-blink-features=AutomationControlled'] };
  const attempts = [{ label: 'system Google Chrome', channel: 'chrome' }, { label: 'system Microsoft Edge', channel: 'msedge' }, { label: 'bundled Chromium', channel: undefined }];
  let context = null;
  let lastError = null;
  for (const attempt of attempts) {
    try {
      context = await chromium.launchPersistentContext(profileDir, attempt.channel ? { ...options, channel: attempt.channel } : options);
      console.log(`🌐 Launched ${attempt.label} with a persistent profile.`);
      break;
    } catch (err) { lastError = err; console.warn(`[auto] could not launch ${attempt.label}: ${(err.message || String(err)).split('\n')[0]}`); }
  }
  if (!context) throw lastError || new Error('Could not launch any browser.');
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    try { if (!window.chrome) window.chrome = {}; } catch (e) {}
  });
  return context;
}

async function attemptAutoLogin(page, providerName) {
  try {
    const envPrefix = envPrefixFor(providerName);
    const identifier = process.env[`${envPrefix}_EMAIL`] || process.env[`${envPrefix}_USERNAME`] || process.env[`${envPrefix}_PHONE`];
    const password = process.env[`${envPrefix}_PASSWORD`];
    if (!identifier) { console.log(`ℹ️ No credentials found in .env — skipping auto-login.`); return false; }
    console.log(`🔐 Attempting auto-login for ${providerName}...`);
    const filled = await tryFill(page, EMAIL_SELECTORS, identifier, 'email/username');
    if (!filled) await tryFill(page, PHONE_SELECTORS, identifier, 'phone');
    const passwordVisible = await page.locator(PASSWORD_SELECTORS[0]).first().isVisible().catch(() => false);
    if (!passwordVisible) { await tryClick(page, NEXT_SELECTORS, '"Next/Continue/Get code"'); await page.waitForTimeout(1000).catch(() => {}); }
    if (password) {
      await tryFill(page, PASSWORD_SELECTORS, password, 'password');
    } else {
      // SMS-code login (e.g. Kimi): fill a code if one was supplied in .env,
      // otherwise tell the user to enter the code sent to their phone.
      const smsCode = process.env[`${envPrefix}_SMS_CODE`];
      if (smsCode) await tryFill(page, SMS_CODE_SELECTORS, smsCode, 'SMS code');
    }
    const submitted = await tryClick(page, SUBMIT_SELECTORS, '"Log in / Sign in / 登录"');
    if (!submitted) { try { await page.locator(PASSWORD_SELECTORS[0]).first().press('Enter'); } catch (e) {} }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    return true;
  } catch (err) { console.warn(`[auto] auto-login aborted: ${err.message}`); return false; }
}

async function attemptAutoChat(page) {
  try {
    console.log('💬 Attempting to auto-send a test chat message...');
    let chatLoc = null;
    for (const sel of CHAT_INPUT_SELECTORS) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 2000 })) { chatLoc = loc; break; }
      } catch (e) {}
    }
    if (!chatLoc) { console.log('  [auto] could not find a chat input box — please send a message manually.'); return false; }
    await chatLoc.click();
    await page.waitForTimeout(300);
    // Real keystrokes, not fill(): Vue/contenteditable editors (e.g. Kimi) only
    // enable their Send button in response to genuine input/key events.
    await page.keyboard.type('Hello', { delay: 30 });
    await page.waitForTimeout(500);

    const sendBtn = page.locator('button[aria-label*="Send" i], button[data-testid*="send" i], button:has-text("Send")').first();
    // Wait (short, capped) for the Send button to become enabled — Kimi keeps it
    // disabled until there is text. Clicking a disabled button would otherwise
    // make Playwright burn the full 30s actionability timeout.
    let enabled = false;
    for (let i = 0; i < 20; i++) {
      enabled = await sendBtn.isEnabled().catch(() => false);
      if (enabled) break;
      await page.waitForTimeout(250);
    }
    if (enabled) {
      await sendBtn.click();
      await page.waitForTimeout(500);
      console.log('  [auto] test message sent (Send button).');
      return true;
    }
    // Fallback: some editors submit on Enter even when the Send button is hidden.
    await chatLoc.press('Enter').catch(() => {});
    await page.waitForTimeout(800);
    console.log('  [auto] Send button never enabled — pressed Enter as fallback.');
    return true;
  } catch (err) { console.warn(`[auto] auto-chat failed: ${err.message}`); return false; }
}

function injectUserText(obj, text, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return false;
  if (Array.isArray(obj)) { for (let i = obj.length - 1; i >= 0; i--) { if (injectUserText(obj[i], text, depth + 1)) return true; } return false; }
  const keys = Object.keys(obj); const lower = keys.map(k => k.toLowerCase());
  if (lower.includes('role') && lower.includes('content')) { const roleKey = keys[lower.indexOf('role')]; const contentKey = keys[lower.indexOf('content')]; const role = String(obj[roleKey] || '').toLowerCase(); if (role === 'user' || role === '') { obj[contentKey] = text; return true; } }
  const containers = ['messages', 'contents', 'parts', 'history'];
  for (const name of containers) { const idx = lower.indexOf(name); if (idx >= 0 && Array.isArray(obj[keys[idx]])) { for (let i = obj[keys[idx]].length - 1; i >= 0; i--) { if (injectUserText(obj[keys[idx]][i], text, depth + 1)) return true; } } }
  const textKeys = ['prompt', 'question', 'query', 'input', 'text', 'message', 'user_message', 'input_text'];
  for (const name of textKeys) { const idx = lower.indexOf(name); if (idx >= 0 && typeof obj[keys[idx]] === 'string') { obj[keys[idx]] = text; return true; } }
  for (const k of keys) { if (obj[k] && typeof obj[k] === 'object' && injectUserText(obj[k], text, depth + 1)) return true; }
  return false;
}

function extractChunkText(chunk) {
  if (!chunk || typeof chunk !== 'object') return '';
  if (typeof chunk.content === 'string') return chunk.content;
  const choices = chunk.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const delta = choices[0].delta; if (delta && typeof delta.content === 'string') return delta.content;
    const msg = choices[0].message; if (msg && typeof msg.content === 'string') return msg.content;
    if (typeof choices[0].text === 'string') return choices[0].text;
  }
  if (typeof chunk.text === 'string') return chunk.text;
  if (typeof chunk.output_text === 'string') return chunk.output_text;
  if (Array.isArray(chunk.content)) return chunk.content.filter(b => b && b.type === 'text').map(b => b.text).join('');
  return '';
}

function extractSseBody(text) {
  let out = '';
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l === '[DONE]') continue;
    let payload = null;
    if (l.startsWith('data:')) {
      const candidate = l.slice(5).trim();
      if (!candidate || candidate === '[DONE]') continue;
      try { payload = JSON.parse(candidate); } catch (e) { continue; }
    } else if (l[0] === '{' || l[0] === '[') {
      // Some web UIs (e.g. Kimi) stream raw JSON objects per line instead of
      // SSE `data:` frames. Try parsing those too.
      try { payload = JSON.parse(l); } catch (e) { continue; }
    } else {
      continue;
    }
    out += extractChunkText(payload);
  }
  return out || null;
}

function extractText(data) {
  if (typeof data === 'string') {
    const trimmed = data.trim(); if (!trimmed) return null;
    if (/^<(!DOCTYPE|html|script|head|body)/i.test(trimmed) || trimmed.includes('rgv587_flag') || trimmed.includes('captcha') || trimmed.includes('x5secdata')) return null;
    if (trimmed[0] === '{' || trimmed[0] === '[') {
      try { return extractText(JSON.parse(trimmed)); } catch (e) { /* multi-line JSON stream */ }
    }
    if (/^data:/m.test(trimmed) || trimmed[0] === '{' || trimmed[0] === '[') return extractSseBody(trimmed);
    return trimmed;
  }
  if (!data || typeof data !== 'object') return null;
  if (typeof data.content === 'string') return data.content;
  const choices = data.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const msg = choices[0].message; if (msg && typeof msg.content === 'string') return msg.content;
    const delta = choices[0].delta; if (delta && typeof delta.content === 'string') return delta.content;
    if (typeof choices[0].text === 'string') return choices[0].text;
  }
  if (Array.isArray(data.content)) return data.content.filter(b => b && b.type === 'text').map(b => b.text).join('');
  if (typeof data.text === 'string') return data.text;
  if (typeof data.answer === 'string') return data.answer;
  if (typeof data.message === 'string') return data.message;
  let longest = '';
  (function find(obj) { for (const k in obj) { if (typeof obj[k] === 'string' && obj[k].length > longest.length && obj[k].length > 2) longest = obj[k]; else if (typeof obj[k] === 'object' && obj[k] !== null) find(obj[k]); } })(data);
  return longest || null;
}

// Use Playwright's page.evaluate to run fetch() INSIDE the browser context.
// This guarantees a perfect TLS fingerprint and uses the browser's actual cookies,
// completely bypassing x5sec WAF detection that blocks Node.js axios.
async function verifyCapturedRequest(page, capturedData, authToken) {
  try {
    const resp = await page.evaluate(async ({ url, payload, headers }) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload)
      });
      const text = await res.text();
      return { status: res.status, text: text };
    }, { 
      url: capturedData.url, 
      payload: capturedData.payload, 
      headers: { 
        ...capturedData.headers, 
        'Content-Type': 'application/json',
        // Kimi authenticates via the Local Storage `refresh_token`, not via the
        // `kimi-auth` cookie — ping with it as a Bearer token so the verification
        // actually exercises the token the runtime will use.
        ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
      } 
    });
    
    if (resp.text.includes('rgv587_flag') || resp.text.includes('captcha') || resp.text.includes('x5secdata')) {
      return { ok: false, status: resp.status, snippet: resp.text.slice(0, 200) };
    }
    const content = extractText(resp.text);
    return { ok: resp.status === 200 && content !== null, status: resp.status, snippet: resp.text.slice(0, 200) };
  } catch (err) {
    return { ok: false, status: 0, snippet: err.message };
  }
}

async function setupWebProvider(providerName, startUrl) {
  console.log(`🚀 Launching browser for ${providerName}...`);
  const context = await launchProviderBrowser(providerName);
  const page = context.pages()[0] || await context.newPage();
  let browserClosedEarly = false;
  context.on('close', () => { browserClosedEarly = true; });
  await page.goto(startUrl);

  let capturedData = null;
  let capturedPreferred = false;
  page.on('request', request => {
    if (request.method() !== 'POST' || !request.postData()) return;
    const url = request.url();
    if (isAnalyticsUrl(url)) return;
    let postData;
    try { postData = JSON.parse(request.postData()); } catch (e) { return; }
    if (!looksLikeChatPayload(postData)) return;
    // Sites like Kimi POST conversation-list/heartbeat payloads that happen to look
    // chat-like. Prefer URLs that clearly point at a chat completion endpoint.
    const isPreferred = /\/api\/chat\//i.test(url) || /completion\/?stream/i.test(url) || /\/chat\/completions/i.test(url);
    if (!capturedData || (isPreferred && !capturedPreferred)) {
      capturedData = { url, headers: request.headers(), payload: postData };
      capturedPreferred = isPreferred || capturedPreferred;
      console.log(`[capture] chat API request captured: ${url}`);
    }
  });

  const loginAttempted = await attemptAutoLogin(page, providerName);
  let loginFormVisible = false;
  try { loginFormVisible = await page.locator(PASSWORD_SELECTORS[0]).first().isVisible().catch(() => false); } catch (e) {}
  const autoChatOk = await attemptAutoChat(page);
  if (loginFormVisible && !loginAttempted) {
    console.log('➡️ Please log in and send a test message in the chat.');
  } else if (!autoChatOk) {
    console.log('➡️ Auto-chat did not go through — please type a message manually in the chat.');
  }

  await new Promise((resolve) => {
    const interval = setInterval(() => { if (capturedData || browserClosedEarly) { clearInterval(interval); resolve(); } }, 1000);
    setTimeout(() => { clearInterval(interval); resolve(); }, 120000);
  });

  if (!capturedData) {
    await context.close().catch(() => {});
    if (browserClosedEarly) throw new Error('The browser was closed before any chat request was captured.');
    throw new Error('No chat API request captured. Please log in and send a test message.');
  }

  const cookies = await context.cookies();
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  // Kimi does NOT authenticate through cookies — its API expects the Local
  // Storage `refresh_token` as a Bearer token. Grab it from the browser's
  // storage while we still have the context open.
  let authToken = null;
  try {
    const storage = await context.storageState();
    for (const origin of storage.origins) {
      const item = (origin.localStorage || []).find(entry => entry.name === 'refresh_token');
      if (item && item.value) { authToken = item.value; break; }
    }
  } catch (err) {
    console.warn(`[capture] could not read Local Storage: ${err.message}`);
  }
  if (authToken) console.log('🎫 Captured refresh_token from Local Storage (Kimi-style auth).');
  else console.log('⚠️ No refresh_token found in Local Storage — falling back to cookie-only auth.');

  console.log('🔎 Pinging the captured endpoint using the real browser context to verify...');
  const verification = await verifyCapturedRequest(page, capturedData, authToken);
  if (!verification.ok) {
    await context.close().catch(() => {});
    throw new Error(`Verification ping failed (HTTP ${verification.status}). The captured request/cookie did not return usable content. Raw: ${verification.snippet}`);
  }
  console.log(`🔎 Verification ping OK (HTTP ${verification.status}) — cookie works.`);

  const envPath = getFilePath('env');
  let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const envKey = `${envPrefixFor(providerName)}_COOKIE`;
  envContent = envContent.split('\n').filter(line => !line.startsWith(`${envKey}=`)).join('\n');
  const envValue = cookieHeader.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  envContent += `\n${envKey}="${envValue}"\n`;
  await writeFileWithRetry(envPath, envContent.trim() + '\n');

  const csvPath = getFilePath('providerConfig');
  const existingCsv = fs.existsSync(csvPath) && fs.readFileSync(csvPath, 'utf-8').trim().length > 0 ? fs.readFileSync(csvPath, 'utf-8') : '';
  let header = existingCsv ? existingCsv.split(/\r?\n/)[0].split(',').map(h => h.trim()).filter(Boolean) : ['provider', 'baseURL', 'apiKeyEnv', 'modelsEndpoint', 'authType'];
  ['provider', 'baseURL', 'apiKeyEnv', 'modelsEndpoint', 'authType'].forEach(h => { if (!header.includes(h)) header.push(h); });
  let rows = existingCsv ? parseCsv(existingCsv) : [];
  const existingRow = rows.find(r => r.provider === providerName);
  rows = rows.filter(r => r.provider !== providerName);
  const newRow = {};
  header.forEach(h => { newRow[h] = existingRow && existingRow[h] != null ? existingRow[h] : ''; });
  newRow.provider = providerName; newRow.baseURL = capturedData.url; newRow.apiKeyEnv = envKey; newRow.authType = 'Cookie';
  rows.push(newRow);
  const escapeCsv = (v) => { const s = v == null ? '' : String(v); return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csvLines = [header.join(','), ...rows.map(r => header.map(h => escapeCsv(r[h])).join(','))];
  await writeFileWithRetry(csvPath, csvLines.join('\n') + '\n');

  const rulesPath = getFilePath('webProviderRules');
  let rules = fs.existsSync(rulesPath) ? JSON.parse(fs.readFileSync(rulesPath, 'utf-8')) : {};
  
  const headersToSave = { ...capturedData.headers };
  delete headersToSave['host'];
  delete headersToSave['content-length'];
  delete headersToSave['cookie'];
  delete headersToSave['connection'];
  delete headersToSave['accept-encoding'];

  rules[providerName] = { 
    samplePayload: capturedData.payload, 
    headers: headersToSave,
    userAgent: capturedData.headers['user-agent'], 
    origin: capturedData.headers['origin'], 
    referer: capturedData.headers['referer'],
    // Kimi-style providers authenticate via the Local Storage `refresh_token`
    // (Bearer), not via cookies — saved so the runtime can attach it.
    ...(authToken ? { authToken } : {}),
    // The on-disk browser profile used for capture — runtime proxy requests reuse this
    // SAME profile dir so the request comes from the same device/cookie-jar that logged in.
    profileKey: envPrefixFor(providerName).toLowerCase()
  };
  await writeFileWithRetry(rulesPath, JSON.stringify(rules, null, 2));

  await context.close().catch(() => {});
  return { success: true, provider: providerName, verified: true };
}

if (require.main === module) {
  const provider = process.argv[2] || 'Qwen';
  const url = process.argv[3] || 'https://chat.qwen.ai';
  setupWebProvider(provider, url).then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
module.exports = { setupWebProvider };
// kimi-web-client.js
// Direct client for Kimi's free web chat API (kimi.moonshot.cn).
//
// Kimi's web UI does NOT expose an OpenAI-compatible endpoint. Instead it
// authenticates with a long-lived `refresh_token` (stored in
// web-provider-rules.json as `authToken`) and uses a token dance:
//   1. GET  /api/auth/token/refresh   (Bearer refresh_token) -> access_token (300s TTL)
//   2. GET  /api/user                 (Bearer access_token, X-Traffic-Id) -> userId
//   3. POST /api/chat                 -> conversation id (convId)
//   4. POST /api/chat/{convId}/completion/stream (Bearer access_token) -> SSE
//   5. DELETE /api/chat/{convId}      (cleanup after completion)
//
// This is a port of the flow reverse-engineered by the kimi-free-api project
// (lxtqq/kimi-free-api, MIT). It uses plain axios with browser-like headers, so
// no Playwright browser is involved — which sidesteps the WAF/browser issues the
// in-browser capture had.
//
// The completion result is converted to an OpenAI-style JSON object so the rest
// of the proxy (normalizeResponse / sendSseResponse) can consume it unchanged.

const axios = require('axios');

const KIMI_API_BASE = 'https://kimi.moonshot.cn';
const ACCESS_TOKEN_EXPIRES = 300; // access_token TTL in seconds
const MAX_ATTEMPT_COUNT = 2;
const RETRY_DELAY = 3000;

// Browser-like headers used on every request so the API accepts us as a normal
// web client (same trick kimi-free-api uses).
const FAKE_HEADERS = {
  'Accept': '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Origin': KIMI_API_BASE,
  'R-Timezone': 'Asia/Shanghai',
  'Sec-Ch-Ua': '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
};

class KimiAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KimiAuthError';
  }
}

// --- token cache (keyed by refresh_token) ---
const accessTokenMap = new Map();
const accessTokenRequestQueueMap = {};

function unixTimestamp() {
  return Math.floor(Date.now() / 1000);
}

function randomString(length, charset) {
  const pool = charset || 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < length; i++) out += pool[Math.floor(Math.random() * pool.length)];
  return out;
}

// Anti-bot cookie blob; regenerated per request like the web UI does.
function generateCookie() {
  const ts = unixTimestamp();
  const items = [
    `Hm_lvt_358cae4815e85d48f7e8ab7f3680a74b=${ts - Math.round(Math.random() * 2592000)}`,
    `_ga=GA1.1.${randomString(10, '0123456789')}.${ts - Math.round(Math.random() * 2592000)}`,
    `_ga_YXD8W70SZP=GS1.1.${ts - Math.round(Math.random() * 2592000)}.1.1.${ts - Math.round(Math.random() * 2592000)}.0.0.0`,
    `Hm_lpvt_358cae4815e85d48f7e8ab7f3680a74b=${ts - Math.round(Math.random() * 2592000)}`
  ];
  return items.join('; ');
}

/**
 * Validate a response payload. Throws KimiAuthError for auth failures (which
 * also evicts the cached access_token) and plain Error for other API errors.
 */
function checkResult(result, refreshToken) {
  if (result.status === 401) {
    accessTokenMap.delete(refreshToken);
    throw new KimiAuthError('Kimi returned 401 (refresh_token expired/invalid)');
  }
  if (!result.data) return null;
  const { error_type, message } = result.data;
  if (typeof error_type !== 'string') return result.data;
  if (error_type === 'auth.token.invalid') {
    accessTokenMap.delete(refreshToken);
    throw new KimiAuthError('Kimi: auth.token.invalid');
  }
  if (error_type === 'chat.user_stream_pushing') {
    throw new KimiAuthError('Kimi: another stream is pushing on this token');
  }
  throw new Error(`[Kimi request failed]: ${message || error_type}`);
}

/**
 * Refresh access_token + fetch userId. Concurrent callers with the same
 * refresh_token share one refresh (dedup via request queue).
 */
async function requestToken(refreshToken) {
  if (accessTokenRequestQueueMap[refreshToken]) {
    // Another caller is already refreshing; wait for its outcome.
    return new Promise((resolve, reject) =>
      accessTokenRequestQueueMap[refreshToken].push({ resolve, reject })
    );
  }
  accessTokenRequestQueueMap[refreshToken] = [];

  const result = await (async () => {
    const resp = await axios.get(`${KIMI_API_BASE}/api/auth/token/refresh`, {
      headers: {
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Authorization: `Bearer ${refreshToken}`,
        'Cache-Control': 'no-cache',
        Cookie: generateCookie(),
        Pragma: 'no-cache',
        Referer: `${KIMI_API_BASE}/`,
        'Sec-Ch-Ua': FAKE_HEADERS['Sec-Ch-Ua'],
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': FAKE_HEADERS['User-Agent']
      },
      timeout: 15000,
      validateStatus: () => true
    });
    const { access_token, refresh_token } = checkResult(resp, refreshToken);
    const { id: userId } = await getUserInfo(access_token, refreshToken);
    return {
      userId,
      accessToken: access_token,
      refreshToken: refresh_token,
      refreshTime: unixTimestamp() + ACCESS_TOKEN_EXPIRES
    };
  })()
    .then(ok => {
      const waiters = accessTokenRequestQueueMap[refreshToken];
      delete accessTokenRequestQueueMap[refreshToken];
      if (waiters) waiters.forEach(w => w.resolve(ok));
      return ok;
    })
    .catch(err => {
      // Reject queued waiters so they observe the real failure (auth errors
      // must propagate, not get cached as a value).
      const waiters = accessTokenRequestQueueMap[refreshToken];
      delete accessTokenRequestQueueMap[refreshToken];
      if (waiters) waiters.forEach(w => w.reject(err));
      return err; // leader falls through to the instanceof check below
    });

  if (result instanceof Error) throw result;
  return result;
}

async function acquireToken(refreshToken) {
  let result = accessTokenMap.get(refreshToken);
  if (!result || unixTimestamp() > result.refreshTime) {
    result = await requestToken(refreshToken);
    accessTokenMap.set(refreshToken, result);
  }
  return result;
}

async function getUserInfo(accessToken, refreshToken) {
  const resp = await axios.get(`${KIMI_API_BASE}/api/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Referer: `${KIMI_API_BASE}/`,
      'X-Traffic-Id': `7${randomString(18, '0123456789')}`,
      Cookie: generateCookie(),
      ...FAKE_HEADERS
    },
    timeout: 15000,
    validateStatus: () => true
  });
  return checkResult(resp, refreshToken);
}

async function createConversation(name, refreshToken) {
  const { accessToken, userId } = await acquireToken(refreshToken);
  const resp = await axios.post(`${KIMI_API_BASE}/api/chat`, { is_example: false, name }, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Referer: `${KIMI_API_BASE}/`,
      'X-Traffic-Id': userId,
      Cookie: generateCookie(),
      ...FAKE_HEADERS
    },
    timeout: 15000,
    validateStatus: () => true
  });
  const { id: convId } = checkResult(resp, refreshToken);
  return convId;
}

async function removeConversation(convId, refreshToken) {
  const { accessToken, userId } = await acquireToken(refreshToken);
  const resp = await axios.delete(`${KIMI_API_BASE}/api/chat/${convId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Referer: `${KIMI_API_BASE}/chat/${convId}`,
      'X-Traffic-Id': userId,
      Cookie: generateCookie(),
      ...FAKE_HEADERS
    },
    timeout: 15000,
    validateStatus: () => true
  });
  checkResult(resp, refreshToken);
}

// Kimi's UI wraps user-message URLs in tags; mimic it so links parse correctly.
function wrapUrlsToTags(content) {
  return String(content).replace(
    /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_+.~#?&//=]*)/gi,
    url => `<url id="" type="url" status="" title="" wc="">${url}</url>`
  );
}

/**
 * Merge OpenAI-style messages into the single combined user message Kimi's
 * endpoint expects, injecting an attention-boost system prompt on multi-turn
 * conversations (same strategy as kimi-free-api). The caller's array is copied,
 * never mutated.
 */
function messagesPrepare(messages) {
   let content;

   if (!Array.isArray(messages) || messages.length < 2) {
    content = (messages || []).reduce((acc, message) => {
      if (Array.isArray(message.content)) {
        return message.content.reduce((_acc, v) => {
          if (!v || v.type !== 'text') return _acc;
          return _acc + (v.text || '') + '\n';
        }, acc);
      }
      return acc + (message.role === 'user' ? wrapUrlsToTags(message.content) : message.content) + '\n';
    }, '');
  } else {
    const msgs = messages.slice();
    const latest = msgs[msgs.length - 1];
    const hasFileOrImage = Array.isArray(latest.content)
      && latest.content.some(v => v && typeof v === 'object' && ['file', 'image_url'].includes(v.type));
    msgs.splice(msgs.length - 1, 0, {
      role: 'system',
      content: hasFileOrImage ? '关注用户最新发送文件和消息' : '关注用户最新的消息'
    });
    content = msgs.reduce((acc, message) => {
      if (Array.isArray(message.content)) {
        return message.content.reduce((_acc, v) => {
          if (!v || v.type !== 'text') return _acc;
          return _acc + (message.role || 'user') + ':' + (v.text || '') + '\n';
        }, acc);
      }
      return acc + (message.role || 'user') + ':'
        + (message.role === 'user' ? wrapUrlsToTags(message.content) : message.content) + '\n';
    }, '');
  }

  return [{ role: 'user', content }];
}

// Minimal incremental SSE parser: collects `data:` frames, JSON.parses each.
function createSseParser(onEvent) {
  let buffer = '';
  return {
    feed(chunk) {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        parseFrame(frame);
      }
    },
    flush() {
      if (buffer.trim()) {
        const frame = buffer;
        buffer = '';
        parseFrame(frame);
      }
    }
  };

  function parseFrame(frame) {
    const data = frame.split(/\r?\n/)
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trim())
      .join('\n');
    if (!data) return;
    try {
      onEvent(JSON.parse(data));
    } catch (e) {
      // ignore malformed frames
    }
  }
}

/**
 * Collect Kimi's SSE completion stream into one OpenAI-style response object.
 * Events: `cmpl` (text chunk), `all_done`/`error` (finish), `search_plus` (refs).
 */
function receiveStream(model, convId, stream) {
  return new Promise((resolve, reject) => {
    const data = {
      id: convId,
      model,
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      created: unixTimestamp()
    };
    let refContent = '';
    let settled = false;

    const settle = (err) => {
      if (settled) return;
      settled = true;
      try { stream.destroy(); } catch (e) { /* ignore */ }
      if (err) reject(err);
      else resolve(data);
    };

    const parser = createSseParser((result) => {
      try {
        if (result.event === 'cmpl' && result.text) {
          const bad = result.text.indexOf('\uFFFD');
          data.choices[0].message.content += bad === -1 ? result.text : result.text.slice(0, bad);
        } else if (result.event === 'all_done' || result.event === 'error') {
          if (result.event === 'error') {
            data.choices[0].message.content += '\n[内容由于不合规被停止生成，我们换个话题吧]';
          }
          if (refContent) data.choices[0].message.content += `\n\n搜索结果来自：\n${refContent}`;
          settle(null);
        } else if (result.event === 'search_plus' && result.msg && result.msg.type === 'get_res') {
          refContent += `${result.msg.title} - ${result.msg.url}\n`;
        }
      } catch (e) {
        settle(e);
      }
    });

    stream.on('data', buf => parser.feed(buf.toString()));
    stream.once('error', err => settle(err));
    stream.once('end', () => { parser.flush(); settle(null); });
    stream.once('close', () => { parser.flush(); settle(null); });
  });
}

async function doCompletion(model, messages, refreshToken, useSearch, opts) {
  const convId = await createConversation('未命名会话', refreshToken);
  try {
    const { accessToken, userId } = await acquireToken(refreshToken);
    const sendMessages = messagesPrepare(messages);
    const resp = await axios.post(`${KIMI_API_BASE}/api/chat/${convId}/completion/stream`, {
      kimiplus_id: /^[0-9a-z]{20}$/.test(model) ? model : undefined,
      messages: sendMessages,
      refs: [],
      use_search: useSearch
    }, {
      timeout: 120000,
      signal: opts.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Referer: `${KIMI_API_BASE}/chat/${convId}`,
        'Priority': 'u=1, i',
        'X-Traffic-Id': userId,
        Cookie: generateCookie(),
        ...FAKE_HEADERS
      },
      validateStatus: () => true,
      responseType: 'stream'
    });

    if (resp.status !== 200) {
      if (resp.status === 401) {
        accessTokenMap.delete(refreshToken);
        throw new KimiAuthError('Kimi returned 401 (refresh_token expired/invalid)');
      }
      let errText = '';
      try {
        for await (const c of resp.data) {
          errText += c;
          if (errText.length > 512) break;
        }
      } catch (e) { /* stream already dead */ }
      throw new Error(`Kimi completion stream returned ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const answer = await receiveStream(model, convId, resp.data);
    // Kimi's SSE stream does not report token usage. Compute an estimate from
    // the actual request/response text (same ~4 chars/token heuristic the rest
    // of the proxy uses for providers that don't report real usage) and flag it
    // `estimated: true` so proxy-server.js's recordUsage carries the flag
    // through to the Token Usage panel instead of silently dropping token
    // counts (the old code hardcoded prompt_tokens/completion_tokens = 1/1,
    // which made Kimi look like it used ~0 tokens per request).
    const completionText = answer.choices && answer.choices[0] && answer.choices[0].message
      ? answer.choices[0].message.content || ''
      : '';
    const promptText = (sendMessages || []).map(m => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) return m.content.map(b => (b && b.text) || '').join(' ');
      return '';
    }).join(' ');
    const estimate = (text) => Math.max(1, Math.ceil(String(text).length / 4));
    const promptTokens = estimate(promptText);
    const completionTokens = estimate(completionText);
    answer.usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      estimated: true
    };
    return { status: 200, data: answer };
  } finally {
    // Clean up the temp conversation + snippet tracking; failures are harmless.
    removeConversation(convId, refreshToken).catch(() => {});
  }
}

/**
 * Run a full Kimi completion. Returns `{ status: 200, data: <OpenAI-style> }`
 * so callers can treat it like any other response object.
 *
 * @param {object} params
 * @param {string} params.model
 * @param {Array} params.messages  OpenAI-style messages
 * @param {string} params.refreshToken
 * @param {boolean} [params.useSearch=false]  enable Kimi web search
 * @param {AbortSignal} [params.signal]
 */
async function completion({ model, messages, refreshToken, useSearch = false, signal }) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPT_COUNT; attempt++) {
    try {
      return await doCompletion(model || 'kimi', messages, refreshToken, useSearch, { signal });
    } catch (err) {
      lastErr = err;
      // Auth failures never recover on retry; rethrow immediately.
      if (err instanceof KimiAuthError || (err && err.name === 'CanceledError')) throw err;
      if (attempt < MAX_ATTEMPT_COUNT - 1) await new Promise(r => setTimeout(r, RETRY_DELAY));
    }
  }
  throw lastErr;
}

module.exports = { completion };

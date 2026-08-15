// proxy-server.js
// proxy-server.js — complete file
const fs = require('fs');
const express = require('express');
const axios = require('axios');
const { getFilePath, envPrefixFor } = require('./state-store');
require('dotenv').config({ path: getFilePath('env') });
const { saveResults, loadUsage, saveUsage, loadAssistantConfig } = require('./state-store');
const { translateRequest, translateResponse, parseToolCallsFromText } = require('./tool-calling-translator');
const { LOG_MARKERS, DEFAULT_COOKIE_USER_AGENT } = require('./shared-constants');
const largeContextDispatcher = require('./large-context-dispatcher');

// --- WEB PROVIDER RULES (for Cookie auth & payload translation) ---
const webRulesPath = getFilePath('webProviderRules');
let webRules = {};

function reloadWebRules() {
  if (fs.existsSync(webRulesPath)) {
    try {
      webRules = JSON.parse(fs.readFileSync(webRulesPath, 'utf-8'));
    } catch (err) {
      console.warn('Could not load web-provider-rules.json:', err.message);
    }
  } else {
    webRules = {};
  }
}
reloadWebRules();

// --- ASSISTANT CONFIG (system prompt override / tool-calling / proxy features) ---
// Task 5: read on startup and whenever main.js calls reloadAssistantConfig()
// after a save from the Assistant Config tab.
let assistantConfig = loadAssistantConfig();

function reloadAssistantConfig() {
  assistantConfig = loadAssistantConfig();
}

let serverInstance = null;
let modelEntries = [];
let knownOk = [];
let knownFailedKeys = new Set();
let totalRequests = 0;
let priorityOverrideKey = null;
// --- NEW: priority lock / rotation ---
// `priorityLocked`: when true, orderEntries() will NOT silently drop the pin
// just because the pinned entry fell out of knownOk (which is what caused
// the renderer's dropdown to go stale before — the backend forgot the pin,
// but nothing told the UI). A locked pin instead falls back for just that
// one request (findWinner still moves on if the pinned entry itself fails)
// while staying pinned for the next request, so a transient blip doesn't
// permanently lose the user's choice.
let priorityLocked = false;
// `routingMode` 'rotate': round-robins across the current knownOk list
// instead of always racing fastest-first, so load spreads across multiple
// healthy models instead of hammering the single fastest one every time.
let rotateIndex = 0;

// Small ring buffer of human-readable routing events (pin cleared, model
// demoted, fallback used, lock engaged/disengaged) so the UI can show a
// "why did it downgrade" log next to the priority selector instead of the
// reason being buried in the general Developer Logs console feed.
const ROUTING_LOG_MAX = 50;
let routingLog = [];
function pushRoutingEvent(kind, text) {
  routingLog.push({ kind, text, time: Date.now() });
  if (routingLog.length > ROUTING_LOG_MAX) routingLog = routingLog.slice(-ROUTING_LOG_MAX);
  console.log(`[routing] ${text}`);
  if (typeof onPriorityStateChange === 'function') {
    try { onPriorityStateChange(getPriorityState()); } catch (_) { /* best-effort */ }
  }
}
function getRoutingLog() {
  return routingLog.slice().reverse(); // newest first
}
function getPriorityState() {
  return {
    priorityOverrideKey,
    priorityLocked,
    routingMode: assistantConfig.routingMode || 'auto'
  };
}
// Optional callback wired up by main.js so priority-state changes (whether
// user-initiated or the backend auto-clearing a stale pin) can be pushed to
// every renderer live instead of the UI having to poll for them.
let onPriorityStateChange = null;
function setPriorityStateListener(fn) { onPriorityStateChange = fn; }

let tokenUsage = loadUsage();
const activeSockets = new Set();
let usageSaveTimer = null;

function scheduleSaveUsage() {
  if (usageSaveTimer) return;
  usageSaveTimer = setTimeout(() => {
    usageSaveTimer = null;
    try {
      saveUsage(tokenUsage);
    } catch (err) {
      console.warn('Could not save token usage:', err.message);
    }
  }, 250);
}

function isCancelledError(err) {
  return !!(
    axios.isCancel(err) ||
    err?.code === 'ERR_CANCELED' ||
    err?.name === 'CanceledError' ||
    err?.name === 'AbortError'
  );
}

// --- CONNECTED APPLICATIONS (Task 2) ---
// Keyed by an "X-App-Name" header if the caller sends one, otherwise by
// User-Agent — there's no explicit app-registration handshake in this
// protocol, so this is the best identity signal an OpenAI-compatible client
// gives us for free. Purely in-memory; resets when the proxy restarts.
const connectedClients = new Map();
const CLIENT_IDLE_MS = 90000; // no activity for this long (and no in-flight request) => "disconnected"

function clientKeyFromHeaders(headers) {
  const appName = headers['x-app-name'];
  const ua = headers['user-agent'];
  return appName || ua || 'unknown client';
}

function touchClientStart(headers) {
  const key = clientKeyFromHeaders(headers);
  let c = connectedClients.get(key);
  if (!c) {
    c = {
      appName: headers['x-app-name'] || null,
      userAgent: headers['user-agent'] || null,
      activeRequests: 0,
      totalRequests: 0,
      errorCount: 0,
      lastActivity: null,
      lastModel: null,
      lastProvider: null
    };
    connectedClients.set(key, c);
  }
  c.activeRequests += 1;
  c.totalRequests += 1;
  c.lastActivity = Date.now();
  return key;
}

function touchClientEnd(key, result) {
  const c = connectedClients.get(key);
  if (!c) return;
  c.activeRequests = Math.max(0, c.activeRequests - 1);
  c.lastActivity = Date.now();
  if (result && result.success) {
    c.lastProvider = result.provider;
    c.lastModel = result.model;
  } else {
    c.errorCount += 1;
  }
}

function getConnectedClients() {
  const now = Date.now();
  return Array.from(connectedClients.entries())
    .sort((a, b) => (b[1].lastActivity || 0) - (a[1].lastActivity || 0))
    .map(([key, c]) => {
      const idleFor = c.lastActivity ? now - c.lastActivity : Infinity;
      const status = c.activeRequests > 0 ? 'active' : (idleFor < CLIENT_IDLE_MS ? 'idle' : 'disconnected');
      return {
        key,
        appName: c.appName || c.userAgent || key,
        status,
        activeRequests: c.activeRequests,
        totalRequests: c.totalRequests,
        errorCount: c.errorCount,
        lastActivity: c.lastActivity ? new Date(c.lastActivity).toLocaleTimeString() : null,
        lastModel: c.lastModel,
        lastProvider: c.lastProvider
      };
    });
}

// --- TOKEN ESTIMATION (Task 3) ---
// Cheap character-based heuristic (~4 chars/token, in line with common rule-of-
// thumb estimators) used whenever a provider doesn't report real usage.
function estimateTokensFromText(text) {
  if (!text) return 0;
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  if (!str) return 0;
  return Math.max(1, Math.ceil(str.length / 4));
}

// Pull the "real question" out of a message list for the Large Context
// Dispatcher's final assembly step. When the last user message IS the giant
// context dump, the whole thing isn't "the question" — try to isolate a
// trailing question line instead of feeding the entire dump back in twice.
function extractUserQuestion(messages) {
  const userMsgs = (messages || []).filter(m => m && m.role === 'user');
  if (userMsgs.length === 0) return '';
  const last = userMsgs[userMsgs.length - 1];
  const text = typeof last.content === 'string'
    ? last.content
    : Array.isArray(last.content) ? last.content.map(b => (b && b.text) || '').join('\n') : '';
  const trimmed = (text || '').trim();
  if (!trimmed) return '';
  if (trimmed.length <= 500) return trimmed;
  const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
  const tail = lines.slice(-5).reverse();
  const questionLine = tail.find(l => l.endsWith('?') && l.length < 400);
  if (questionLine) return questionLine;
  const lastLine = lines[lines.length - 1];
  if (lastLine && lastLine.length < 400) return lastLine;
  return "Read the provided context and give the most helpful, comprehensive answer you can.";
}

function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  const joined = messages.map(m => {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map(b => (b && b.text) || '').join(' ');
    return '';
  }).join(' ');
  return estimateTokensFromText(joined);
}

// --- REQUEST/RESPONSE LOGS (merged into Developer Logs) ---
// Logs a single human-readable line per request/response that rides the
// existing forwardLogsToRenderer pipeline straight into the Developer Logs
// panel — no [REQ]/[RESPONSE] sub-tabs, no JSON parsing on the renderer.
function safeHeaderList(headers) {
  const SENSITIVE = new Set(['authorization', 'cookie', 'x-traffic-id']);
  return Object.keys(headers || {}).filter(h => !SENSITIVE.has(h.toLowerCase()));
}

function logRequestLine(entry, payload, headers, messages) {
  if (assistantConfig.loggingVerbosity === 'quiet') return;
  const payloadSize = JSON.stringify(payload || {}).length;
  const tokenEstimate = estimateMessagesTokens(messages);
  console.log(`→ ${entry.provider}/${entry.model} POST ${entry.baseURL} (${payloadSize}b, ~${tokenEstimate} tok)`);
}

function logResponseLine(entry, status, elapsed, data, errorMessage) {
  if (assistantConfig.loggingVerbosity === 'quiet') return;
  const usage = (data && data.usage) || null;
  const tok = usage ? ` (tokens in ${usage.prompt_tokens || '?'} / out ${usage.completion_tokens || '?'})` : '';
  if (errorMessage) {
    console.warn(`← ${entry.provider}/${entry.model} ${errorMessage} (${elapsed}ms)`);
  } else {
    console.log(`← ${entry.provider}/${entry.model} ${status ?? 'ERR'} (${elapsed}ms)${tok}`);
  }
}

const keyOf = (e) => `${e.provider}::${e.model}`;

function learnSuccess(entry, elapsed) {
  const key = keyOf(entry);
  const existing = knownOk.find(k => keyOf(k) === key);
  if (existing) {
    existing.latency = elapsed;
  } else {
    knownOk.push({ provider: entry.provider, model: entry.model, latency: elapsed });
  }
  knownFailedKeys.delete(key);
  knownOk.sort((a, b) => a.latency - b.latency);
  saveResults(knownOk.map(k => ({ provider: k.provider, model: k.model, status: 'OK', latency: k.latency })));
}

// --- NEW: ping-before-demote ---
// A real request failure alone used to demote a model immediately. That's
// too trigger-happy for a one-off transient blip (dropped connection, a
// slow cold start). Now, when routing is about to move on to the next
// candidate, fire one short, cheap "ping" request at the one that just
// failed — only if THAT doesn't get a response does it actually get
// demoted. Reuses probeOne so auth/payload handling for every provider
// type (Bearer, Cookie, Kimi refresh-token) stays identical to a real
// request; the only difference is the minimal message and short timeout.
// Fallback default for ping-before-demote timeout; the live value is
// assistantConfig.pingTimeoutMs (defaults to 8000 in state-store.js).
const DEFAULT_PING_TIMEOUT_MS = 8000;

// Throttle gate: don't fire a ping at the same entry more than once per
// pingIntervalMs. Without this, a burst of near-simultaneous failures for
// one entry (e.g. several in-flight requests racing against it) would each
// trigger their own verifyAndDemote() -> pingEntry() call and pile pings on
// a provider that's already struggling. Keyed on provider/model so entries
// are throttled independently. This is the single choke point every runtime
// ping path (verifyAndDemote, and anything else that calls pingEntry) goes
// through, so gating it here covers all of them.
const lastPingAt = new Map();

async function pingEntry(entry) {
  const key = keyOf(entry);
  const intervalMs = assistantConfig.pingIntervalMs > 0 ? assistantConfig.pingIntervalMs : 0;
  const last = lastPingAt.get(key);
  if (intervalMs > 0 && last !== undefined && (Date.now() - last) < intervalMs) {
    // Too soon since the last ping for this entry — skip firing another
    // network request and assume it's still reachable rather than
    // hammering a provider that's mid cold-start/rate-limit.
    return true;
  }
  lastPingAt.set(key, Date.now());
  const controller = new AbortController();
   const timer = setTimeout(() => controller.abort(), assistantConfig.pingTimeoutMs > 0 ? assistantConfig.pingTimeoutMs : DEFAULT_PING_TIMEOUT_MS);
  try {
    await probeOne(entry, { messages: [{ role: 'user', content: 'ping' }], rest: {} }, controller.signal);
    return true;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Confirms an entry is actually unreachable before demoting it from
// known-OK / clearing its priority pin. Call this instead of learnFailure()
// directly wherever a candidate just failed and routing is about to fall
// back to the next one.
async function verifyAndDemote(entry) {
  const key = keyOf(entry);

  // --- NEW: locked pins are never demoted AND block fallback ---
  // When a user explicitly locks a model (priorityLocked = true), the system
  // honors that choice: even if the model is unresponsive, it stays in known-OK
  // and continues to be used. Fallback to other models is BLOCKED — the request
  // will fail instead of silently using a different model. A warning is logged
  // so the user knows the model is not answering and no fallback occurred.
  if (priorityOverrideKey === key && priorityLocked) {
    console.warn(`[proxy] WARNING: Locked priority model ${entry.provider}/${entry.model} is unresponsive — staying pinned (per user lock). FALLBACK BLOCKED: request will fail rather than use another model.`);
    pushRoutingEvent('lock-warning', `Locked priority model ${entry.provider}/${entry.model} is unresponsive — staying pinned per user lock. FALLBACK BLOCKED.`);
    return;
  }

  const responded = await pingEntry(entry);
  if (responded) {
    pushRoutingEvent('ping-ok', `${entry.provider}/${entry.model} failed a request but responded to a follow-up ping — keeping it known-OK.`);
    return;
  }
  pushRoutingEvent('ping-failed', `${entry.provider}/${entry.model} did not respond to a follow-up ping — demoting.`);
  learnFailure(entry);
}

function learnFailure(entry) {
  const key = keyOf(entry);
  const wasOk = knownOk.some(k => keyOf(k) === key);

  // --- NEW: locked pins are protected from demotion ---
  // When a model is explicitly locked as the priority override, learnFailure()
  // is a no-op for it: it stays in knownOk and knownFailedKeys is not touched.
  // A warning was already logged in verifyAndDemote() (the normal caller).
  // This also covers any direct learnFailure() call path as a safety net.
  if (priorityOverrideKey === key && priorityLocked) {
    console.warn(`[proxy] WARNING: Locked priority model ${entry.provider}/${entry.model} requested to be demoted but staying pinned (per user lock).`);
    return;
  }

  knownOk = knownOk.filter(k => keyOf(k) !== key);
  knownFailedKeys.add(key);
  if (wasOk) {
    pushRoutingEvent('demoted', `${entry.provider}/${entry.model} demoted from known-OK after a request failure.`);
    saveResults(knownOk.map(k => ({ provider: k.provider, model: k.model, status: 'OK', latency: k.latency })));
  }
  if (priorityOverrideKey === key) {
    priorityOverrideKey = null;
    pushRoutingEvent('pin-cleared', `Priority pin on ${entry.provider}/${entry.model} cleared after a request failure — reverted to auto routing.`);
  }
}

function flattenMessageContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(b => {
        if (!b) return '';
        if (typeof b === 'string') return b;
        if (typeof b.text === 'string') return b.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function injectUserText(obj, text, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return false;
  if (Array.isArray(obj)) {
    for (let i = obj.length - 1; i >= 0; i--) {
      if (injectUserText(obj[i], text, depth + 1)) return true;
    }
    return false;
  }
  const keys = Object.keys(obj);
  const lower = keys.map(k => k.toLowerCase());
  if (lower.includes('role') && lower.includes('content')) {
    const roleKey = keys[lower.indexOf('role')];
    const contentKey = keys[lower.indexOf('content')];
    const role = String(obj[roleKey] || '').toLowerCase();
    if (role === 'user' || role === '') {
      obj[contentKey] = text;
      return true;
    }
  }
  const containers = ['messages', 'contents', 'parts', 'history'];
  for (const name of containers) {
    const idx = lower.indexOf(name);
    if (idx >= 0 && Array.isArray(obj[keys[idx]])) {
      for (let i = obj[keys[idx]].length - 1; i >= 0; i--) {
        if (injectUserText(obj[keys[idx]][i], text, depth + 1)) return true;
      }
    }
  }
  const textKeys = ['prompt', 'question', 'query', 'input', 'text', 'message', 'user_message', 'input_text'];
  for (const name of textKeys) {
    const idx = lower.indexOf(name);
    if (idx >= 0 && typeof obj[keys[idx]] === 'string') {
      obj[keys[idx]] = text;
      return true;
    }
  }
  for (const k of keys) {
    if (obj[k] && typeof obj[k] === 'object' && injectUserText(obj[k], text, depth + 1)) return true;
  }
  return false;
}

// Shared fallback used wherever a Cookie-auth captured sample payload needs
// the outgoing user text spliced in. Tries the general injectUserText()
// walk first; if that finds no recognizable message shape, falls back to
// overwriting the first sufficiently-long string field it finds (checking
// top-level fields, then one level of nested object fields), and finally
// keeps a top-level `query` mirror (used by some web UIs, e.g. Kimi) in
// sync with the injected text. Used by both probeOne() here and the
// HEALTH_CHECK handler in main.js so the two "ping the provider" code
// paths can't drift out of sync with each other.
function injectUserTextWithFallback(payload, text) {
  if (!injectUserText(payload, text)) {
    let replaced = false;
    for (const key in payload) {
      if (typeof payload[key] === 'string' && payload[key].length > 2 && !replaced) {
        payload[key] = text;
        replaced = true;
      } else if (typeof payload[key] === 'object' && payload[key] !== null) {
        for (const subKey in payload[key]) {
          if (
            typeof payload[key][subKey] === 'string' &&
            payload[key][subKey].length > 2 &&
            !replaced
          ) {
            payload[key][subKey] = text;
            replaced = true;
          }
        }
      }
    }
  }
  // Some web UIs (e.g. Kimi) mirror the last user message in a top-level
  // `query` field alongside the `messages` array — sync it too, otherwise
  // the server sees a stale sample value.
  if (typeof payload.query === 'string') payload.query = text;
  return payload;
}

function extractChunkText(chunk) {
  if (!chunk || typeof chunk !== 'object') return '';
  const choices = chunk.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const delta = choices[0].delta;
    if (delta && typeof delta.content === 'string') return delta.content;
    const msg = choices[0].message;
    if (msg && typeof msg.content === 'string') return msg.content;
    if (msg && Array.isArray(msg.content)) {
      const t = msg.content.filter(b => b && b.type === 'text').map(b => b.text).join('');
      if (t) return t;
    }
    if (typeof choices[0].text === 'string') return choices[0].text;
  }
  if (typeof chunk.text === 'string') return chunk.text;
  if (typeof chunk.output_text === 'string') return chunk.output_text;
  if (chunk.output && typeof chunk.output === 'object') {
    if (typeof chunk.output.text === 'string') return chunk.output.text;
    if (Array.isArray(chunk.output.choices)) return extractChunkText(chunk.output);
  }
  if (Array.isArray(chunk.content)) {
    return chunk.content.filter(b => b && b.type === 'text').map(b => b.text).join('');
  }
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

function looksLikeAuthError(data) {
  if (!data || typeof data !== 'object') return false;
  const text = JSON.stringify(data).toLowerCase();
  // Common auth-failure markers returned by proxy providers (Zen, etc.) that the
  // longest-string fallback would otherwise mistake for assistant content.
  const markers = [
    'token expired', 'invalid api key', 'incorrect api key', 'invalid key',
    'authentication', 'unauthorized', 'unauthorised', 'api key invalid',
    'auth fail', 'token invalid', 'key expired', 'access denied'
  ];
  return markers.some(m => text.includes(m));
}

function looksLikeTokenLimitError(data) {
  if (!data || typeof data !== 'object') return false;
  const text = JSON.stringify(data).toLowerCase();
  // Common token-limit / context-exceeded markers from various providers.
  const markers = [
    'context length', 'context window', 'max tokens', 'maximum tokens',
    'token limit', 'context limit', 'too many tokens', 'exceeds.*max',
    'input.*too.*long', 'prompt.*too.*long', 'context.*exceeded',
    'maximum context', 'reduce.*tokens', 'reduce.*length',
    'this model.*maximum context', 'context.*size.*exceed'
  ];
  return markers.some(m => text.includes(m));
}

// Guards extractContent against mistaking upstream error responses for
// assistant content. Catches common error shapes: HTTP status codes, error
// objects, rate-limit responses, payload-too-large errors, and any response
// whose longest string is an error message rather than generated text.
function looksLikeUpstreamError(data) {
  if (!data || typeof data !== 'object') return false;

  // HTTP-style error with a numeric status code (e.g. {status: 413, ...})
  if (typeof data.status === 'number' && data.status >= 400 && data.status < 600) {
    return true;
  }
  if (typeof data.code === 'number' && data.code >= 400 && data.code < 600) {
    return true;
  }

  // Standard provider error envelope: { error: { message: "...", type: "..." } }
  if (data.error && typeof data.error === 'object' && (data.error.message || data.error.type)) {
    return true;
  }

  // Bare error object with a message that looks like an HTTP/proxy error
  if (typeof data.message === 'string') {
    const m = data.message.toLowerCase();
    const errorMarkers = [
      'payload too large', 'request entity too large', '413',
      'rate limit', 'too many requests', '429',
      'not found', '404', '503', 'service unavailable',
      'upstream', 'bad gateway', '502',
      'timeout', 'request timed out',
      'connection', 'socket', 'network',
      'unavailable', 'overloaded', 'busy'
    ];
    if (errorMarkers.some(marker => m.includes(marker))) return true;
  }

  return false;
}

function extractContent(data) {
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return null;
    if (trimmed[0] === '{' || trimmed[0] === '[') {
      try { return extractContent(JSON.parse(trimmed)); } catch (e) { /* multi-line JSON stream */ }
    }
    if (/^data:/m.test(trimmed) || trimmed[0] === '{' || trimmed[0] === '[') return extractSseBody(trimmed);
    // A bare error string from a proxy (e.g. "token expired or incorrect") is not content.
    if (looksLikeAuthError({ message: trimmed, text: trimmed })) return null;
    return trimmed;
  }

  if (!data || typeof data !== 'object') return null;

  const choices = data.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const msg = choices[0].message;
    if (msg && typeof msg.content === 'string') return msg.content;
    if (msg && Array.isArray(msg.content)) {
      const text = msg.content.filter(b => b && b.type === 'text').map(b => b.text).join('');
      if (text) return text;
    }
    const delta = choices[0].delta;
    if (delta && typeof delta.content === 'string') return delta.content;
    if (typeof choices[0].text === 'string') return choices[0].text;
  }

  if (Array.isArray(data.content)) {
    const text = data.content.filter(b => b && b.type === 'text').map(b => b.text).join('');
    if (text) return text;
  }

  if (data.data && Array.isArray(data.data.choices)) return extractContent(data.data);
  if (typeof data.output_text === 'string') return data.output_text;
  if (typeof data.text === 'string') return data.text;
  if (typeof data.answer === 'string') return data.answer;
  if (typeof data.result === 'string') return data.result;
  if (typeof data.reply === 'string') return data.reply;

   // message/output-style responses and the longest-string fallback are the two spots
   // where an upstream error body (e.g. a rate-limit or 413 error echoed back)
   // would otherwise be mistaken for assistant content. Guard both.
   if (typeof data.message === 'string') {
     if (looksLikeAuthError({ message: data.message })) return null;
     if (looksLikeUpstreamError(data)) return null;
     return data.message;
   }
   if (typeof data.response === 'string') {
     if (looksLikeUpstreamError(data)) return null;
     return data.response;
   }

  if (data.data) {
    if (typeof data.data.text === 'string') return data.data.text;
    if (typeof data.data.content === 'string') return data.data.content;
    if (typeof data.data.answer === 'string') return data.data.answer;
    if (typeof data.data.message === 'string') return data.data.message;
  }

  // Last resort before the longest-string fallback: reject auth-error and
   // upstream-error bodies (e.g. Zen's "token expired or incorrect",
   // rate-limit responses, 413 payload-too-large) so they aren't mistaken
   // for assistant content.
   if (looksLikeAuthError(data)) return null;
   if (looksLikeUpstreamError(data)) return null;

   let longestString = '';
  const seen = new WeakSet();

  function findLongestString(obj) {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
    seen.add(obj);
    for (let key in obj) {
      if (typeof obj[key] === 'string' && obj[key].length > longestString.length && obj[key].length > 2) {
        longestString = obj[key];
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        findLongestString(obj[key]);
      }
    }
  }

  findLongestString(data);
  if (longestString) return longestString;
  return null;
}

function normalizeResponse(data) {
  if (typeof data === 'string') {
    const content = extractContent(data);
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: '',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: content || '' },
          finish_reason: content ? 'stop' : 'length'
        }
      ]
    };
  }

  // Check if the upstream response contains tool calls in text form.
  // translateResponse handles both tool_call and plain-text responses.
  const requestId = (data && data.id) || `chatcmpl-${Date.now()}`;
  const model = (data && data.model) || '';
  return translateResponse(data, requestId, model);
}

function sendSseResponse(res, data, entry) {
  const model = entry.model;
  const requestId = data.id || `chatcmpl-${Date.now()}`;

  // If normalizeResponse already detected tool calls (finish_reason "tool_calls"),
  // emit the tool_calls chunk directly instead of trying to extract text content.
  const finishReason = data.choices?.[0]?.finish_reason;
  const toolCalls = data.choices?.[0]?.message?.tool_calls;

  if (finishReason === 'tool_calls' && Array.isArray(toolCalls) && toolCalls.length > 0) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const writeChunk = (delta, finishReason, extra) => {
      const payload = {
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...extra
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    writeChunk({ role: 'assistant', content: '' }, null);
    writeChunk({
      role: 'assistant',
      tool_calls: toolCalls.map((tc, i) => ({
        index: i,
        id: tc.id,
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    }, null);
    writeChunk({}, 'tool_calls');

    if (data.usage && typeof data.usage === 'object' && Object.keys(data.usage).length > 0) {
      writeChunk({}, null, { usage: data.usage });
    }

    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const content = extractContent(data);

  // If the upstream response still contains tool calls in text form
  // (not yet translated by normalizeResponse), emit proper tool_calls finish.
  if (content && typeof content === 'string') {
    const parsedCalls = parseToolCallsFromText(content);
    if (parsedCalls) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const writeChunk = (delta, finishReason, extra) => {
        const payload = {
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...extra
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      writeChunk({ role: 'assistant', content: '' }, null);
      writeChunk({
        role: 'assistant',
        tool_calls: parsedCalls.map((tc, i) => ({
          index: i,
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      }, null);
      writeChunk({}, 'tool_calls');

      if (data.usage && typeof data.usage === 'object' && Object.keys(data.usage).length > 0) {
        writeChunk({}, null, { usage: data.usage });
      }

      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
  }

  // Standard text streaming — existing behavior
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const writeChunk = (delta, finishReason, extra) => {
    const payload = {
      id: requestId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...extra
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const safeContent = typeof content === 'string' ? content : '';

  writeChunk({ role: 'assistant', content: '' }, null);

  const CHUNK_SIZE = 32;
  for (let i = 0; i < safeContent.length; i += CHUNK_SIZE) {
    writeChunk({ content: safeContent.slice(i, i + CHUNK_SIZE) }, null);
  }

  writeChunk({}, 'stop');

  if (data.usage && typeof data.usage === 'object' && Object.keys(data.usage).length > 0) {
    writeChunk({}, null, { usage: data.usage });
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

const MAX_PARALLEL_PROBES = (() => {
  const n = parseInt(process.env.MAX_PARALLEL_PROBES, 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
})();

async function probeInBatches(entries, ctx, batchSize) {
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const winner = await probeParallel(batch, ctx);
    if (winner) return winner;
  }
  return null;
}

async function findWinner(ordered, ctx) {
  // --- NEW: locked priority model gets exclusive first try, no fallback ---
  // If a model is explicitly locked, the user wants ONLY that model.
  // Try it first (sequentially), and if it fails, FAIL THE REQUEST —
  // do not silently fall back to other models.
  if (priorityOverrideKey && priorityLocked) {
    const lockedEntry = ordered.find(e => keyOf(e) === priorityOverrideKey);
    if (lockedEntry) {
      const controller = new AbortController();
      const timeoutMs = assistantConfig.timeoutMs > 0 ? assistantConfig.timeoutMs : 30000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const result = await probeOne(lockedEntry, ctx, controller.signal).catch(() => null);
      clearTimeout(timer);
      if (result) {
        learnSuccess(result.entry, result.elapsed);
        console.log(`[${result.entry.provider}/${result.entry.model}] used for this request (locked priority).`);
        return result;
      }
      await verifyAndDemote(lockedEntry);
      pushRoutingEvent('lock-fallback-blocked', `Locked priority model ${lockedEntry.provider}/${lockedEntry.model} failed — fallback blocked per user lock. Request will fail.`);
      return null;
    }
  }

  if (knownOk.length > 0) {
    const okCandidates = ordered.filter(e => knownOk.some(o => keyOf(o) === keyOf(e)));
    const okResult = await probeSequential(okCandidates, ctx);
    if (okResult) {
      learnSuccess(okResult.entry, okResult.elapsed);
      console.log(`[${okResult.entry.provider}/${okResult.entry.model}] used for this request.`);
      return okResult;
    }
  }

  const untested = ordered.filter(e => !knownFailedKeys.has(keyOf(e)));
  const winner = await probeInBatches(untested, ctx, MAX_PARALLEL_PROBES);
  if (winner) {
    console.log(`[${winner.entry.provider}/${winner.entry.model}] used for this request.`);
    return winner;
  }

  return null;
}

function orderEntries() {
  // Assistant Config "routing mode" (Task 5): 'configOrder' bypasses the
  // known-OK speed ranking entirely and just uses the config's own entry
  // order (still respecting the priority override pin below).
  if (assistantConfig.routingMode === 'configOrder') {
    if (priorityOverrideKey) {
      const pinned = modelEntries.find(e => keyOf(e) === priorityOverrideKey);
      if (pinned) return [pinned, ...modelEntries.filter(e => keyOf(e) !== priorityOverrideKey)];
    }
    return [...modelEntries];
  }

  const okSpeed = new Map();
  knownOk.forEach((e, i) => okSpeed.set(keyOf(e), i));

  // A locked pin is allowed to sit outside knownOk (learnFailure() already
  // logged the fallback-for-this-request reason) — only an *unlocked* pin
  // gets auto-cleared here, and that clear itself now goes through
  // pushRoutingEvent so the UI actually finds out about it instead of the
  // pin just quietly vanishing.
  if (priorityOverrideKey && !priorityLocked && !okSpeed.has(priorityOverrideKey)) {
    const stale = modelEntries.find(e => keyOf(e) === priorityOverrideKey);
    pushRoutingEvent('pin-cleared', `Priority pin "${stale ? `${stale.provider}/${stale.model}` : priorityOverrideKey}" is no longer known-OK; clearing pin and reverting to auto ordering.`);
    priorityOverrideKey = null;
  }

  // 'rotate' routing mode: round-robin across the current known-OK set
  // instead of always racing fastest-first, so load spreads across every
  // healthy model rather than hammering the single fastest one on every
  // request. The priority pin (if any, locked or not) still wins outright.
  if (assistantConfig.routingMode === 'rotate' && knownOk.length > 0 && !priorityOverrideKey) {
    const rotated = knownOk.map(keyOf);
    rotateIndex = rotateIndex % rotated.length;
    const pickedKey = rotated[rotateIndex];
    rotateIndex += 1;
    const rank = (entry) => {
      const k = keyOf(entry);
      if (k === pickedKey) return -1;
      if (okSpeed.has(k)) return okSpeed.get(k);
      if (knownFailedKeys.has(k)) return knownOk.length + 999;
      return knownOk.length;
    };
    return [...modelEntries].sort((a, b) => rank(a) - rank(b));
  }

  const rank = (entry) => {
    const k = keyOf(entry);
    if (priorityOverrideKey && k === priorityOverrideKey) return -1;
    if (okSpeed.has(k)) return okSpeed.get(k);
    if (knownFailedKeys.has(k)) return knownOk.length + 999;
    return knownOk.length;
  };

  return [...modelEntries].sort((a, b) => rank(a) - rank(b));
}

// --- NEW: minimum request spacing (global "slow down" gate) ---
// Free-tier LLM endpoints tend to rate-limit or outright ban bursts of
// concurrent/rapid requests. probeParallel fires several candidate entries
// at once, and retries/pings can pile on top of that, so this serializes
// the actual moment each outbound request is allowed to fire: every caller
// awaits acquireRequestSlot() right before hitting the network, and slots
// are handed out no faster than assistantConfig.minRequestIntervalMs apart,
// process-wide (not per-entry — the point is to slow the whole proxy down,
// not just one provider). requestGateChain serializes slot acquisition so
// concurrent callers can't all read a stale lastRequestSentAt and pass
// through together.
let requestGateChain = Promise.resolve();
let lastRequestSentAt = 0;

function acquireRequestSlot() {
  const slot = requestGateChain.then(async () => {
    const intervalMs = assistantConfig.minRequestIntervalMs > 0 ? assistantConfig.minRequestIntervalMs : 0;
    if (intervalMs > 0) {
      const wait = lastRequestSentAt + intervalMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    lastRequestSentAt = Date.now();
  });
  // Keep the chain alive even if this slot's wait throws for some reason.
  requestGateChain = slot.catch(() => {});
  return slot;
}

async function probeOne(entry, { messages, rest }, signal) {
  const startTime = Date.now();
  const apiKey = process.env[entry.apiKeyEnv];

  // Kimi-style providers authenticate via `authToken` (refresh_token) in the
  // rules file — the cookie env var is not required for them.
  const rule0 = entry.authType === 'Cookie' ? (webRules[entry.provider] || null) : null;
  if (!apiKey && !(rule0 && rule0.authToken)) {
    console.log(`[${entry.provider}/${entry.model}] skipped - no API key set.`);
    throw new Error('no key');
  }

  const authType = entry.authType || 'Bearer';
  const headers = {
    'Content-Type': 'application/json'
  };

  let payload = { ...rest, model: entry.model, messages };

  if (authType === 'Cookie') {
    if (apiKey) headers['Cookie'] = apiKey;
    headers['User-Agent'] = DEFAULT_COOKIE_USER_AGENT;

    const rule = webRules[entry.provider] || null;
    if (rule) {
      if (rule.userAgent) headers['User-Agent'] = rule.userAgent;
      if (rule.origin) headers['Origin'] = rule.origin;
      if (rule.referer) headers['Referer'] = rule.referer;

      if (rule.samplePayload) {
        payload = JSON.parse(JSON.stringify(rule.samplePayload));

        // Keep the payload's own stream setting (captured payloads are usually
        // stream:true). probeOne waits for the full body (SSE until [DONE]),
        // then normalizes it into one OpenAI-style JSON object for the client.
        //
        // BUGFIX: this used to inject only the LAST user message's flattened
        // text, which silently dropped the system prompt (identity lock, tool
        // definitions, project root/context) and any earlier turns whenever a
        // provider's captured payload shape only has one text field to fill —
        // that's exactly why a Kimi-style backend answered "what are you"
        // with its own vendor identity instead of staying in character as
        // this app's coding agent (see [REQ] log: only a single role:"user"
        // message survived). Inject the FULL role-labeled conversation
        // instead, so identity/tools/context always reach the model
        // regardless of how simple the captured payload's message shape is.
        const fullConversationText = (messages || [])
          .map((m) => {
            const text = flattenMessageContent(m && m.content);
            return text ? `[${String((m && m.role) || 'user').toUpperCase()}]\n${text}` : '';
          })
          .filter(Boolean)
          .join('\n\n');

        const lastUserMessage = messages.filter(m => m.role === 'user').pop();
        const fallbackText = flattenMessageContent(lastUserMessage ? lastUserMessage.content : '');

        injectUserTextWithFallback(payload, fullConversationText || fallbackText);
      }

      // Kimi-style providers authenticate via the Local Storage `refresh_token`
      // (Bearer), not via cookies — attach it when the capture saved one.
      if (rule.authToken) {
        headers['Authorization'] = `Bearer ${rule.authToken}`;
      }
    }
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  logRequestLine(entry, payload, headers, messages);

  // Assistant Config "retry count" (Task 5): extra attempts for this one
  // candidate before giving up on it (findWinner still moves on to the next
  // candidate as before once attempts are exhausted).
  const maxAttempts = 1 + Math.max(0, parseInt(assistantConfig.retryCount, 10) || 0);

  let response;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await acquireRequestSlot();
      if (authType === 'Cookie') {
        const rule = webRules[entry.provider] || null;
        const cookieTimeoutMs = assistantConfig.cookieProviderTimeoutMs > 0 ? assistantConfig.cookieProviderTimeoutMs : 60000;

        // Kimi-style providers authenticate via a `refresh_token` (stored as
        // `authToken` in the rules) and speak their own token-exchange API — no
        // browser/cookies involved. Route those through the dedicated client.
        if (rule && rule.authToken) {
          const kimiClient = require('./kimi-web-client');
          response = await kimiClient.completion({
            model: entry.model,
            messages,
            refreshToken: rule.authToken,
            useSearch: false,
            signal,
            timeoutMs: cookieTimeoutMs
          });
        } else {
          const browserClient = require('./browser-http-client');
          // Reuse the SAME persistent browser profile that captured this provider's cookie
          // so the request originates from the same device that logged in (bypasses WAF).
          const profileKey = rule && rule.profileKey ? rule.profileKey : envPrefixFor(entry.provider).toLowerCase();
          response = await browserClient.request(entry.baseURL, payload, headers, apiKey, profileKey, cookieTimeoutMs);
        }
      } else {
        response = await axios.post(entry.baseURL, payload, {
          headers,
          timeout: (assistantConfig.timeoutMs > 0 ? assistantConfig.timeoutMs : 30000),
          signal
        });
      }

      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (isCancelledError(err)) break; // don't retry a probe that was cancelled by findWinner/probeParallel
      if (attempt < maxAttempts) {
        console.log(`[${entry.provider}/${entry.model}] attempt ${attempt}/${maxAttempts} failed (${err.message}) — retrying.`);
      }
    }
  }

  if (lastError) {
    logResponseLine(entry, lastError.response ? lastError.response.status : null, Date.now() - startTime, null, lastError.message);
    throw lastError;
  }

  const elapsed = Date.now() - startTime;

  // Check for token-limit errors from upstream before normalizing
  if (looksLikeTokenLimitError(response.data)) {
    const err = new Error('Upstream model context/token limit exceeded. Reduce your input or switch to a model with a larger context window.');
    err.code = 'TOKEN_LIMIT_EXCEEDED';
    throw err;
  }

  const normalized = normalizeResponse(response.data);

  if (response.status >= 200 && response.status < 300 && normalized) {
    const completionText = extractContent(response.data);
    recordUsage(entry, response.data, { messages, completionText });

    normalized._meta = {
      provider: entry.provider,
      model: entry.model,
      elapsed
    };

    logResponseLine(entry, response.status, elapsed, response.data, null);
    console.log(`[${entry.provider}/${entry.model}] OK (${elapsed}ms)`);
    return { entry, data: normalized, elapsed };
  }

  const rawSnippet = response.data
    ? JSON.stringify(response.data).slice(0, 200)
    : '(empty)';

  logResponseLine(entry, response.status, elapsed, response.data, 'no usable content');
  console.log(
    `[${entry.provider}/${entry.model}] returned ${response.status} but no usable content. Raw: ${rawSnippet}`
  );
  // If upstream returned a token-limit error, surface it clearly
  if (looksLikeTokenLimitError(response.data)) {
    throw new Error('Upstream model context/token limit exceeded. Reduce your input or switch to a model with a larger context window.');
  }
  throw new Error(`no usable content (${response.status})`);
}

// Single-shot completion against one specific entry, for callers that already
// know which model they want (Large Context Dispatcher lanes/assembler)
// rather than racing/falling back across the known-OK list. Reuses probeOne
// so Cookie/Kimi/browser auth, retries, and logging all stay consistent with
// the normal request path, and feeds the same learnSuccess/learnFailure
// health tracking so a bad lane demotes itself out of known-OK like any
// other failure would.
async function runSingleCompletion(entry, messages, opts = {}) {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs || (assistantConfig.timeoutMs > 0 ? assistantConfig.timeoutMs : 30000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await probeOne(entry, { messages, rest: opts.rest || {} }, controller.signal);
    clearTimeout(timer);
    const text = extractContent(result.data);
    if (!text) throw new Error('empty response');
    learnSuccess(result.entry, result.elapsed);
    return { text, entry: result.entry, elapsed: result.elapsed, raw: result.data };
  } catch (err) {
    clearTimeout(timer);
    if (!isCancelledError(err)) await verifyAndDemote(entry);
    throw err;
  }
}

function recordUsage(entry, rawData, ctx) {
  const usage = rawData && rawData.usage;
  const hasRealUsage = usage && typeof usage === 'object' && !usage.estimated
    && (usage.prompt_tokens || usage.input_tokens || usage.completion_tokens || usage.output_tokens || usage.total_tokens);

  let promptTokens, completionTokens, totalTokens, estimated;

  if (hasRealUsage) {
    promptTokens = usage.prompt_tokens || usage.input_tokens || 0;
    completionTokens = usage.completion_tokens || usage.output_tokens || 0;
    totalTokens = usage.total_tokens || (promptTokens + completionTokens);
    estimated = false;
  } else if (usage && usage.estimated) {
    // Already estimated upstream (e.g. kimi-web-client.js) — trust its numbers,
    // just carry the "estimated" flag through.
    promptTokens = usage.prompt_tokens || 0;
    completionTokens = usage.completion_tokens || 0;
    totalTokens = usage.total_tokens || (promptTokens + completionTokens);
    estimated = true;
  } else {
    // No usage reported at all (typical for Cookie/browser-http-client
    // providers) — estimate from the request messages + extracted response
    // content rather than silently showing 0.
    const completionText = (ctx && ctx.completionText) || '';
    promptTokens = estimateMessagesTokens(ctx && ctx.messages);
    completionTokens = estimateTokensFromText(completionText);
    totalTokens = promptTokens + completionTokens;
    estimated = true;
  }

  const key = keyOf(entry);
  const rec = tokenUsage[key] || {
    provider: entry.provider, model: entry.model, requests: 0,
    promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedRequests: 0,
    // --- NEW: cookie-provider column --- capture authType so the Token Usage
    // tab can flag Cookie-auth (e.g. Kimi/Qwen) rows distinctly from API-key
    // rows, and so estimated-vs-real attribution is visible at a glance.
    authType: (entry.authType || 'Bearer').toLowerCase() === 'cookie' ? 'cookie' : 'bearer'
  };

  rec.requests += 1;
  rec.promptTokens += promptTokens;
  rec.completionTokens += completionTokens;
  rec.totalTokens += totalTokens;
  if (estimated) rec.estimatedRequests = (rec.estimatedRequests || 0) + 1;

  tokenUsage[key] = rec;
  scheduleSaveUsage();
}

async function probeSequential(entries, ctx) {
  for (const entry of entries) {
    const controller = new AbortController();
    const timeoutMs = assistantConfig.timeoutMs > 0 ? assistantConfig.timeoutMs : 30000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const result = await probeOne(entry, ctx, controller.signal).catch(() => null);
    clearTimeout(timer);

    if (result) return result;
    await verifyAndDemote(entry);

    // --- NEW: locked priority model failed — honor the lock, don't fall back ---
    // If the user explicitly locked a model, they want ONLY that model.
    // If it fails, the request should fail rather than silently falling back.
    if (priorityOverrideKey && priorityLocked && keyOf(entry) === priorityOverrideKey) {
      pushRoutingEvent('lock-fallback-blocked', `Locked priority model ${entry.provider}/${entry.model} failed — fallback blocked per user lock. Request will fail.`);
      return null;
    }
  }
  return null;
}

function probeParallel(entries, ctx) {
  return new Promise((resolve) => {
    let pending = entries.length;
    let winnerResolved = false;

    if (pending === 0) return resolve(null);

    const controllers = entries.map(() => new AbortController());

    entries.forEach((entry, i) => {
      probeOne(entry, ctx, controllers[i].signal).then(
        (result) => {
          learnSuccess(result.entry, result.elapsed);
          if (!winnerResolved) {
            winnerResolved = true;
            controllers.forEach((c, j) => { if (j !== i) c.abort(); });
            resolve(result);
          }
        },
        (err) => {
          if (!isCancelledError(err)) {
            console.log(`[${entry.provider}/${entry.model}] FAILED`);
            // Fire-and-forget: don't hold up the race waiting on a ping.
            verifyAndDemote(entry).catch(() => {});
          }
          if (--pending === 0 && !winnerResolved) resolve(null);
        }
      );
    });
  });
}

function startProxy(port, entries) {
  return (async () => {
    await stopProxy();
    reloadWebRules();

    modelEntries = entries.filter(e => e.enabled);

    const app = express();
    // Raise the body-parser limit so large conversation histories from agentic
    // clients (which can carry hundreds of messages / 600+ line summaries) don't
    // get rejected with a 413 PayloadTooLargeError before they even reach the
    // route handler. 10 MB is generous but bounded (won't OOM a normal machine).
    app.use(express.json({ limit: '10mb' }));

    app.post('/v1/chat/completions', async (req, res) => {
      const { messages, stream, model: _clientModel, stream_options, tools, ...rest } = req.body;

       totalRequests++;
       const clientKey = touchClientStart(req.headers);

      // --- Outbound token cap (Task 5) ---
      // Reject requests that ask the upstream for more output tokens than the
      // configured ceiling (default 100k). Keeps the proxy from relaying
      // accidentally-huge generation requests (e.g. a misbehaving client that
      // omits max_tokens, or a client that sends an absurd value).
      const maxOutputTokens = assistantConfig.maxOutputTokens > 0 ? assistantConfig.maxOutputTokens : 100000;
      if (rest.max_tokens != null && Number(rest.max_tokens) > maxOutputTokens) {
        touchClientEnd(clientKey, { success: false });
        return res.status(400).json({
          error: `max_tokens (${rest.max_tokens}) exceeds the proxy's outbound limit (${maxOutputTokens}). Lower your max_tokens or raise the limit in General Config.`
        });
      }

      // --- Inbound token cap (context limit) ---
      // Reject requests whose estimated prompt tokens exceed the configured
      // ceiling (default 128k). Uses the same cheap character heuristic the
      // proxy uses elsewhere (~4 chars/token).
      // NOTE: messagesWithOverride must be computed first because the system
      // prompt override (if any) is part of what gets counted against the cap.
      let messagesWithOverride = messages;
      if (assistantConfig.systemPromptOverride && assistantConfig.systemPromptOverride.trim()) {
        messagesWithOverride = [{ role: 'system', content: assistantConfig.systemPromptOverride }, ...(messages || [])];
      }

      const maxInputTokens = assistantConfig.maxInputTokens > 0 ? assistantConfig.maxInputTokens : 128000;
      const estimatedInputTokens = estimateMessagesTokens(messagesWithOverride);
      if (estimatedInputTokens > maxInputTokens) {
        touchClientEnd(clientKey, { success: false });
        return res.status(400).json({
          error: `Estimated prompt tokens (~${estimatedInputTokens}) exceed the proxy's context limit (${maxInputTokens}). Reduce your input or raise the limit in General Config.`
        });
      }

      const ordered = orderEntries();
      if (ordered.length === 0) {
        touchClientEnd(clientKey, { success: false });
        return res.status(502).json({ error: 'No models configured.' });
      }

      // Assistant Config "system prompt override" (Task 5): when set, it is
      // injected as the first system message ahead of the client's own
      // messages, additive to whatever the client already sent.
      // (Variable already computed above so the inbound token cap can count it.)

      // --- Large Context Dispatcher ---
      // Intercepts BEFORE tool-call translation: oversized prompts are split,
      // summarized in parallel across the known-OK lanes, and assembled into
      // a final answer with no tool-calling involved anywhere in the pipeline.
      if (assistantConfig.largeContextMode) {
        const totalTokenCount = estimateMessagesTokens(messagesWithOverride);
        const threshold = assistantConfig.largeContextThreshold > 0 ? assistantConfig.largeContextThreshold : 100000;

        if (totalTokenCount > threshold) {
          const userQuestion = extractUserQuestion(messagesWithOverride);
          console.log(`${LOG_MARKERS.DISPATCH} intercepted request (~${totalTokenCount} tokens > ${threshold} threshold)`);

          try {
            const outcome = await largeContextDispatcher.handleLargeContext(req, res, messagesWithOverride, userQuestion, totalTokenCount);
            touchClientEnd(clientKey, outcome && outcome.entry
              ? { success: true, provider: outcome.entry.provider, model: outcome.entry.model }
              : { success: false });
          } catch (err) {
            console.log(`${LOG_MARKERS.DISPATCH} failed: ${err.message}`);
            touchClientEnd(clientKey, { success: false });
            if (!res.headersSent) res.status(502).json({ error: `Large Context Dispatcher failed: ${err.message}` });
          }

          return;
        }
      }

      // Assistant Config "tool calling emulation" toggle (Task 5): when off,
      // messages/tools are passed straight through to providers instead of
      // being run through the forced-system-prompt / text-instruction
      // translation layer.
      let ctx;

      if (assistantConfig.toolCallEmulation !== false) {
        const translated = translateRequest(messagesWithOverride, tools) || {};
        const translatedRest = { ...rest };
        if (Array.isArray(translated.tools) && translated.tools.length > 0) translatedRest.tools = translated.tools;
        ctx = { messages: translated.messages || messagesWithOverride, rest: translatedRest };
      } else {
        ctx = {
          messages: messagesWithOverride,
          rest: {
            ...rest,
            ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {})
          }
        };
      }

      const winner = await findWinner(ordered, ctx);
      if (!winner) {
        touchClientEnd(clientKey, { success: false });
        return res.status(502).json({ error: 'All configured models failed.' });
      }

      touchClientEnd(clientKey, { success: true, provider: winner.entry.provider, model: winner.entry.model });

      if (stream) {
        return sendSseResponse(res, winner.data, winner.entry);
      }

      return res.json(winner.data);
    });

    await new Promise((resolve, reject) => {
      const server = app.listen(port);

      server.once('error', (err) => {
        serverInstance = null;
        if (err && err.code === 'EADDRINUSE') {
          reject(new Error(`Port already in use: ${port}`));
        } else {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

      server.once('listening', () => {
        serverInstance = server;

        server.on('connection', (socket) => {
          activeSockets.add(socket);
          socket.on('close', () => activeSockets.delete(socket));
        });

        console.log(`Proxy running at http://localhost:${port}/`);
        resolve();
      });
    });
  })();
}

function setHealthResults(results) {
  knownOk = results
    .filter(r => r.status === 'OK' && r.latency != null)
    .map(r => ({ provider: r.provider, model: r.model, latency: r.latency }))
    .sort((a, b) => a.latency - b.latency);

  knownFailedKeys = new Set();
  results.forEach(r => {
    if (r.status !== 'OK') knownFailedKeys.add(`${r.provider}::${r.model}`);
  });

  saveResults(knownOk.map(k => ({ provider: k.provider, model: k.model, status: 'OK', latency: k.latency })));
  console.log(`Routing updated live: ${knownOk.length} known-OK model(s).`);
}

function stopProxy() {
  return new Promise((resolve) => {
    if (serverInstance) {
      const server = serverInstance;

      // server.close() stops new connections but waits for all existing
      // sockets (including idle keep-alive ones, and any mid-stream SSE /
      // large-context-dispatch responses) to end on their own before its
      // callback fires. That can hang for as long as an in-flight request
      // runs. Track live sockets and force-destroy them so close() resolves
      // promptly instead of blocking the "Apply Configuration" flow.
      server.close(() => {
        serverInstance = null;
        console.log('Proxy stopped.');
        resolve();
      });

      for (const socket of activeSockets) {
        socket.destroy();
      }
      activeSockets.clear();
    } else {
      resolve();
    }
  });
}

function isProxyRunning() {
  return !!serverInstance;
}

function getKnownOk() {
  return knownOk.map(e => ({ provider: e.provider, model: e.model, latency: e.latency }));
}

function setPriorityOverride(entryKey, locked) {
  priorityOverrideKey = entryKey;
  priorityLocked = entryKey ? !!locked : false;
  const label = entryKey ? entryKey.replace('::', '/') : 'None (auto)';
  pushRoutingEvent('pin-set', `Priority ${priorityLocked ? '🔒 locked' : 'set'} to: ${label}`);
}

function getProxyStats() {
  const clients = getConnectedClients();
  return {
    running: isProxyRunning(),
    activeModelCount: modelEntries.length,
    knownOkCount: knownOk.length,
    totalRequests: totalRequests,
    connectedApps: {
      count: clients.filter(c => c.status !== 'disconnected').length,
      clients
    }
  };
}

function getTokenUsage() {
  return Object.values(tokenUsage).sort((a, b) => b.totalTokens - a.totalTokens);
}

// Assistant Config "output-format preview" (Task 5): runs a small sample
// request through the SAME translateRequest used at runtime, so the preview
// reflects the current system-prompt-override + tool-calling-emulation
// settings rather than a static, possibly-stale example.
function previewToolFormat() {
  const sampleMessages = [{ role: 'user', content: 'What is the weather in Paris?' }];
  const sampleTools = [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a location.',
      parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] }
    }
  }];

  let messagesWithOverride = sampleMessages;
  if (assistantConfig.systemPromptOverride && assistantConfig.systemPromptOverride.trim()) {
    messagesWithOverride = [{ role: 'system', content: assistantConfig.systemPromptOverride }, ...sampleMessages];
  }

  if (assistantConfig.toolCallEmulation === false) {
    return { emulation: false, messages: messagesWithOverride, tools: sampleTools };
  }

  try {
    const { messages: translatedMessages, tools: translatedTools } = translateRequest(messagesWithOverride, sampleTools);
    return { emulation: true, messages: translatedMessages, tools: translatedTools };
  } catch (err) {
    return { emulation: true, error: err.message };
  }
}

// Token-level streaming entry point used by agent-controller.js's agent loop
// when the user has "Stream responses" enabled. There is no real per-token
// feed from the underlying provider probe/fallback race (see the note on
// processChatCompletion below) — providers are only ever awaited as a single
// complete body — so this wraps processChatCompletion and fans its finished
// text out as simulated incremental tokens, in small chunks with a short
// delay between them. That's enough to drive the renderer's real streaming
// UI (cursor, incremental token events, stream-end reconciliation) even
// though the underlying fetch is not truly streamed.
//
// onToken(token) is called for each emitted chunk. Resolves to the same
// shape processChatCompletion's message would take: { content, tool_calls }.
const STREAM_SIMULATE_CHARS_PER_TOKEN = 4;
const STREAM_SIMULATE_DELAY_MS = 12;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processChatCompletionStream(messages, options = {}, onToken) {
  const response = await processChatCompletion(messages, options);
  const message = (response && response.choices && response.choices[0] && response.choices[0].message) || {};
  const content = message.content || '';

  if (typeof onToken === 'function' && content) {
    for (let i = 0; i < content.length; i += STREAM_SIMULATE_CHARS_PER_TOKEN) {
      const token = content.slice(i, i + STREAM_SIMULATE_CHARS_PER_TOKEN);
      onToken(token);

      // Don't stall tool-call-only turns or huge bodies; this is purely a
      // cosmetic pacing delay so the UI shows a believable stream.
      await sleep(STREAM_SIMULATE_DELAY_MS);
    }
  }

  return { content: message.content || null, tool_calls: message.tool_calls || null };
}

// Internal, non-HTTP entry point used by agent-controller.js's agent loop.
// Mirrors the /v1/chat/completions route handler (system-prompt override +
// tool-call translation + known-OK routing/fallback) minus the Express
// req/res plumbing and minus the Large Context Dispatcher hand-off, since the
// agent already manages its own (small, tool-loop-shaped) message history.
// Always resolves non-streamed itself — processChatCompletionStream above is
// the layer that turns this into a simulated token stream for the agent loop.
async function processChatCompletion(messages, options = {}) {
  const { tools, ...rest } = options;

  // Same outbound token cap as the HTTP route (see /v1/chat/completions).
  const maxOutputTokens = assistantConfig.maxOutputTokens > 0 ? assistantConfig.maxOutputTokens : 100000;
  if (rest.max_tokens != null && Number(rest.max_tokens) > maxOutputTokens) {
    throw new Error(`max_tokens (${rest.max_tokens}) exceeds the proxy's outbound limit (${maxOutputTokens}).`);
  }

  // Same inbound token cap (context limit) as the HTTP route.
  const maxInputTokens = assistantConfig.maxInputTokens > 0 ? assistantConfig.maxInputTokens : 128000;
  const estimatedInputTokens = estimateMessagesTokens(messages);
  if (estimatedInputTokens > maxInputTokens) {
    throw new Error(`Estimated prompt tokens (~${estimatedInputTokens}) exceed the proxy's context limit (${maxInputTokens}).`);
  }

  const ordered = orderEntries();
  if (ordered.length === 0) {
    throw new Error('No models configured.');
  }

  let messagesWithOverride = messages;
  if (assistantConfig.systemPromptOverride && assistantConfig.systemPromptOverride.trim()) {
    messagesWithOverride = [{ role: 'system', content: assistantConfig.systemPromptOverride }, ...(messages || [])];
  }

  let ctx;

  if (assistantConfig.toolCallEmulation !== false) {
    const translated = translateRequest(messagesWithOverride, tools) || {};
    const translatedRest = { ...rest };
    if (Array.isArray(translated.tools) && translated.tools.length > 0) translatedRest.tools = translated.tools;
    ctx = { messages: translated.messages || messagesWithOverride, rest: translatedRest };
  } else {
    ctx = {
      messages: messagesWithOverride,
      rest: {
        ...rest,
        ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {})
      }
    };
  }

  const winner = await findWinner(ordered, ctx);
  if (!winner) {
    throw new Error('All configured models failed.');
  }

  // winner.data is already OpenAI-shaped ({ choices: [{ message }], ... }),
  // including message.tool_calls when normalizeResponse()/translateResponse()
  // detected a tool call (native or text-emulated) — see probeOne/runSingleCompletion.
  return winner.data;
}

module.exports = {
  startProxy,
  processChatCompletion,
  processChatCompletionStream,
  stopProxy,
  isProxyRunning,
  setHealthResults,
  getKnownOk,
  setPriorityOverride,
  getRoutingLog,
  getPriorityState,
  setPriorityStateListener,
  getProxyStats,
  getTokenUsage,
  extractContent,
  injectUserText,
  injectUserTextWithFallback,
  getConnectedClients,
  reloadAssistantConfig,
  previewToolFormat,
  // Large Context Dispatcher hooks (deferred-required by large-context-dispatcher.js
  // to avoid a load-time circular require — see note at the top of that file).
  runSingleCompletion,
  orderEntries,
  sendSseResponse,
  estimateMessagesTokens,
  estimateTokensFromText,
  getAssistantConfig: () => assistantConfig
};
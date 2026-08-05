// proxy-server.js
// proxy-server.js — complete file
const fs = require('fs');
const express = require('express');
const axios = require('axios');
const { getFilePath, envPrefixFor } = require('./state-store');
require('dotenv').config({ path: getFilePath('env') });
const { saveResults, loadUsage, saveUsage } = require('./state-store');
const { translateRequest, translateResponse, createStreamingToolCallTranslator, parseToolCallsFromText } = require('./tool-calling-translator');

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

let serverInstance = null;
let modelEntries = [];
let knownOk = [];
let knownFailedKeys = new Set();
let totalRequests = 0;
let priorityOverrideKey = null;
let tokenUsage = loadUsage();

const keyOf = (e) => `${e.provider}::${e.model}`;

function learnSuccess(entry, elapsed) {
  const existing = knownOk.find(k => keyOf(k) === keyOf(entry));
  if (existing) {
    existing.latency = elapsed;
  } else {
    knownOk.push({ provider: entry.provider, model: entry.model, latency: elapsed });
    knownFailedKeys.delete(keyOf(entry));
  }
  knownOk.sort((a, b) => a.latency - b.latency);
  saveResults(knownOk.map(k => ({ provider: k.provider, model: k.model, status: 'OK', latency: k.latency })));
}

function learnFailure(entry) {
  const key = keyOf(entry);
  const wasOk = knownOk.some(k => keyOf(k) === key);
  knownOk = knownOk.filter(k => keyOf(k) !== key);
  knownFailedKeys.add(key);
  if (wasOk) {
    console.log(`[${entry.provider}/${entry.model}] demoted from known-OK after request failure.`);
    saveResults(knownOk.map(k => ({ provider: k.provider, model: k.model, status: 'OK', latency: k.latency })));
  }
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
  // where an auth-error body (e.g. Zen's {code:401, message:'token expired or incorrect'})
  // would otherwise be mistaken for assistant content. Guard both.
  if (typeof data.message === 'string') {
    if (looksLikeAuthError({ message: data.message })) return null;
    return data.message;
  }
  if (typeof data.response === 'string') return data.response;
  
  if (data.data) {
    if (typeof data.data.text === 'string') return data.data.text;
    if (typeof data.data.content === 'string') return data.data.content;
    if (typeof data.data.answer === 'string') return data.data.answer;
    if (typeof data.data.message  === 'string') return data.data.message;
  }

  // Last resort before the longest-string fallback: reject auth-error bodies
  // (e.g. Zen's "token expired or incorrect") so they aren't mistaken for content.
  if (looksLikeAuthError(data)) return null;

  let longestString = '';
  function findLongestString(obj) {
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
  // Check if the upstream response contains tool calls in text form.
  // translateResponse handles both tool_call and plain-text responses.
  const requestId = data.id || `chatcmpl-${Date.now()}`;
  const model = data.model || '';
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

  writeChunk({ role: 'assistant', content: '' }, null);
  const CHUNK_SIZE = 32;
  for (let i = 0; i < content.length; i += CHUNK_SIZE) {
    writeChunk({ content: content.slice(i, i + CHUNK_SIZE) }, null);
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
  const okSpeed = new Map();
  knownOk.forEach((e, i) => okSpeed.set(keyOf(e), i));

  if (priorityOverrideKey && !okSpeed.has(priorityOverrideKey)) {
    console.log(`Priority override "${priorityOverrideKey}" is no longer known-OK; clearing pin and reverting to auto ordering.`);
    priorityOverrideKey = null;
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
    headers['Cookie'] = apiKey;
    headers['User-Agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

    const rule = webRules[entry.provider] || null;

    if (rule) {
      if (rule.userAgent) headers['User-Agent'] = rule.userAgent;
      if (rule.origin) headers['Origin'] = rule.origin;
      if (rule.referer) headers['Referer'] =  rule.referer;

      if (rule.samplePayload) {
        payload = JSON.parse(JSON.stringify(rule.samplePayload));
        // Keep the payload's own stream setting (captured payloads are usually
        // stream:true). probeOne waits for the full body (SSE until [DONE]),
        // then normalizes it into one OpenAI-style JSON object for the client.
        const lastMsg = messages.filter(m => m.role === 'user').pop()?.content || '';

        if (!injectUserText(payload, lastMsg)) {
          let replaced = false;
          for (const key in payload) {
            if (typeof payload[key] === 'string' && payload[key].length > 3 && !replaced) {
              payload[key] = lastMsg;
              replaced = true;
            } else if (typeof payload[key] === 'object' && payload[key] !== null) {
              for (const subKey in payload[key]) {
                if (
                  typeof payload[key][subKey] === 'string' &&
                  payload[key][subKey].length > 3 &&
                  !replaced
                ) {
                  payload[key][subKey] = lastMsg;
                  replaced = true;
                }
              }
            }
          }
        }
        // Some web UIs (e.g. Kimi) mirror the last user message in a top-level
        // `query` field alongside the `messages` array — sync it too, otherwise
        // the server sees a stale sample value.
        if (typeof payload.query === 'string') payload.query = lastMsg;
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

  let response;
  if (authType === 'Cookie') {
    const rule = webRules[entry.provider] || null;
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
        signal
      });
    } else {
      const browserClient = require('./browser-http-client');
      // Reuse the SAME persistent browser profile that captured this provider's cookie
      // so the request originates from the same device that logged in (bypasses WAF).
      const profileKey = rule && rule.profileKey ? rule.profileKey : envPrefixFor(entry.provider).toLowerCase();
      response = await browserClient.request(entry.baseURL, payload, headers, apiKey, profileKey);
    }
  } else {
    response = await axios.post(entry.baseURL, payload, {
      headers,
      timeout: 30000, 
      signal
    });
  }

  const elapsed = Date.now() - startTime;
  const normalized = normalizeResponse(response.data);

  if (response.status === 200 && normalized) {
    recordUsage(entry, response.data);
    normalized._meta = {
      provider: entry.provider,
      model: entry.model,
      elapsed
    };
    console.log(`[${entry.provider}/${entry.model}] OK (${elapsed}ms)`);
    return { entry, data: normalized, elapsed };
  }

  const rawSnippet = response.data
    ? JSON.stringify(response.data).slice(0, 200)
    : '(empty)';
  console.log(
    `[${entry.provider}/${entry.model}] returned ${response.status} but no usable content. Raw: ${rawSnippet}`
  );
  throw new Error(`no usable content (${response.status})`);
}

function recordUsage(entry, rawData) {
  const usage = rawData && rawData.usage;
  if (!usage || typeof usage !== 'object') return;

  const promptTokens = usage.prompt_tokens || usage.input_tokens || 0;
  const completionTokens = usage.completion_tokens || usage.output_tokens || 0;
  const totalTokens = usage.total_tokens || (promptTokens + completionTokens);

  const key = keyOf(entry);
  const rec = tokenUsage[key] || { provider: entry.provider, model: entry.model, requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  rec.requests += 1;
  rec.promptTokens += promptTokens;
  rec.completionTokens += completionTokens;
  rec.totalTokens += totalTokens;
  tokenUsage[key] = rec;
  saveUsage(tokenUsage);
}

async function probeSequential(entries, ctx) {
  for (const entry of entries) {
    const controller = new AbortController();
    const result = await probeOne(entry, ctx, controller.signal).catch(() => null);
    if (result) return result;
    learnFailure(entry);
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
          const wasCancelled = axios.isCancel(err) || err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError';
          if (!wasCancelled) {
            learnFailure(entry);
            console.log(`[${entry.provider}/${entry.model}] FAILED`);
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
    app.use(express.json());

    app.post('/v1/chat/completions', async (req, res) => {
      const { messages, stream, model: _clientModel, stream_options, tools, ...rest } = req.body;
      totalRequests++;
      const ordered = orderEntries();

      if (ordered.length === 0) {
        return res.status(502).json({ error: 'No models configured.' });
      }

      // Apply bidirectional tool-calling translation:
      //   - Inject forced system prompt
      //   - Convert tools array → text instruction
      //   - Convert role:"tool" messages → text blocks
      const { messages: translatedMessages, tools: _translatedTools } = translateRequest(messages, tools);

      const ctx = { messages: translatedMessages, rest };
      const winner = await findWinner(ordered, ctx);

      if (!winner) {
        return res.status(502).json({ error: 'All configured models failed.' });
      }

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
      serverInstance.close(() => {
        serverInstance = null;
        console.log('Proxy stopped.');
        resolve();
      });
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

function setPriorityOverride(entryKey) {
  priorityOverrideKey = entryKey;
  console.log(`Priority override set to: ${entryKey || 'None (auto)'}`);
}

function getProxyStats() {
  return {
    running: isProxyRunning(),
    activeModelCount: modelEntries.length,
    knownOkCount: knownOk.length,
    totalRequests: totalRequests
  };
}

function getTokenUsage() {
  return Object.values(tokenUsage).sort((a, b) => b.totalTokens - a.totalTokens);
}

module.exports = { 
  startProxy, 
  stopProxy, 
  isProxyRunning, 
  setHealthResults, 
  getKnownOk, 
  setPriorityOverride, 
  getProxyStats, 
  getTokenUsage, 
  extractContent,
  injectUserText
};
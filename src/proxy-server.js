const express = require('express');
const axios = require('axios');
const { getFilePath } = require('./state-store');
require('dotenv').config({ path: getFilePath('env') });
const { saveResults, loadUsage, saveUsage } = require('./state-store');

let serverInstance = null;
let modelEntries = [];         // All enabled entries as configured
let knownOk = [];              // Confirmed-working entries, sorted by latency (fastest first)
let knownFailedKeys = new Set(); // "provider::model" keys known to fail
let totalRequests = 0;         // Total requests counter
let priorityOverrideKey = null; // Pinned provider::model key for priority routing

// Per-model token counters, keyed by "provider::model"
let tokenUsage = loadUsage();

const keyOf = (e) => `${e.provider}::${e.model}`;

// Learn from a successful request: record the winner so the NEXT request
// skips straight to known-good models instead of probing everything.
function learnSuccess(entry, elapsed) {
  const existing = knownOk.find(k => keyOf(k) === keyOf(entry));
  if (existing) {
    existing.latency = elapsed;
  } else {
    knownOk.push({ provider: entry.provider, model: entry.model, latency: elapsed });
    knownFailedKeys.delete(keyOf(entry));
  }
  knownOk.sort((a, b) => a.latency - b.latency); // fastest first
  // Persist learned state so it survives an app restart
  saveResults(knownOk.map(k => ({ provider: k.provider, model: k.model, status: 'OK', latency: k.latency })));
}

// Demote a model that was known-OK but just failed at request time:
// remove it from the OK list and mark it failed so future requests
// skip it and go straight to the next known-good model.
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

// Extract assistant text from the many response shapes providers return.
// Returns the content string, or null if the response has no usable text.
function extractContent(data) {
  if (!data || typeof data !== 'object') return null;
  const choices = data.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const msg = choices[0].message;
    if (msg && typeof msg.content === 'string') return msg.content;
    if (msg && Array.isArray(msg.content)) { // content blocks (Anthropic-style)
      const text = msg.content.filter(b => b && b.type === 'text').map(b => b.text).join('');
      if (text) return text;
    }
    if (typeof choices[0].text === 'string') return choices[0].text; // legacy completions
  }
  if (Array.isArray(data.content)) { // Anthropic /v1/messages
    const text = data.content.filter(b => b && b.type === 'text').map(b => b.text).join('');
    if (text) return text;
  }
  if (data.data && Array.isArray(data.data.choices)) { // nested wrapper
    return extractContent(data.data);
  }
  if (typeof data.output_text === 'string') return data.output_text;
  if (typeof data.text === 'string') return data.text;
  return null;
}

// Normalize a provider response into a clean OpenAI-style payload the client can read.
function normalizeResponse(data) {
  const content = extractContent(data);
  if (content === null) return null;
  return {
    choices: [{ message: { role: 'assistant', content } }],
    usage: data.usage || {}
  };
}

// OpenAI-compatible SSE stream writer.
// The router always probes upstreams in buffered (non-streaming) mode because it
// needs the full response to pick a winner and normalize it; when the client
// requests stream:true we replay the winner's content as SSE chunks. This is a
// faithful OpenAI-style stream (delta chunks + finish_reason + [DONE]) so any
// OpenAI-compatible client (e.g. opencode) works against the router.
function sendSseResponse(res, data, entry) {
  const content = extractContent(data);
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = entry.model;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const writeChunk = (delta, finishReason, extra) => {
    const payload = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...extra
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // First delta announces the assistant role, then content in small pieces
  // so the client UI renders progressively.
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

// How many candidates the parallel fallback is allowed to probe at once.
// This exists so a cold request (no known-OK model yet) doesn't fan the
// user's real chat message out to every configured provider simultaneously
// -- each parallel probe is a real, billed API call, not a cheap ping.
// Override via the MAX_PARALLEL_PROBES env var if a wider/narrower race is desired.
const MAX_PARALLEL_PROBES = (() => {
  const n = parseInt(process.env.MAX_PARALLEL_PROBES, 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
})();

// Try candidates in fixed-size batches, in parallel within each batch, resolving
// on the first success. Batches run one after another, not all at once, so total
// concurrent in-flight requests is bounded by MAX_PARALLEL_PROBES.
async function probeInBatches(entries, ctx, batchSize) {
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const winner = await probeParallel(batch, ctx);
    if (winner) return winner;
  }
  return null;
}

// Fast path (known-OK, fastest first) then bounded-parallel fallback.
// Returns the winning result or null when every candidate failed.
async function findWinner(ordered, ctx) {
  // 1) Fast path: health-check confirmed working models, tried in order (fastest first).
  if (knownOk.length > 0) {
    const okCandidates = ordered.filter(e => knownOk.some(o => keyOf(o) === keyOf(e)));
    const okResult = await probeSequential(okCandidates, ctx);
    if (okResult) {
      learnSuccess(okResult.entry, okResult.elapsed);
      console.log(`[${okResult.entry.provider}/${okResult.entry.model}] used for this request.`);
      return okResult;
    }
  }

  // 2) Fallback: nothing confirmed working (or all of them failed) -> probe
  //    candidates that aren't already known to fail, in small parallel
  //    batches (capped at MAX_PARALLEL_PROBES) rather than firing the real
  //    message at every configured model across every provider at once.
  const untested = ordered.filter(e => !knownFailedKeys.has(keyOf(e)));
  const winner = await probeInBatches(untested, ctx, MAX_PARALLEL_PROBES);
  if (winner) {
    console.log(`[${winner.entry.provider}/${winner.entry.model}] used for this request.`);
    return winner;
  }
  return null;
}

// Order candidates: pinned priority override -> known-OK (fastest first) -> untested -> known-failed
function orderEntries() {
  const okSpeed = new Map();
  knownOk.forEach((e, i) => okSpeed.set(keyOf(e), i));

  // If a priority override is pinned but that model is no longer known-OK
  // (e.g. it was demoted after a failed request), the pin is stale — clear
  // it and fall back to normal ordering rather than pinning a dead/unknown entry.
  if (priorityOverrideKey && !okSpeed.has(priorityOverrideKey)) {
    console.log(`Priority override "${priorityOverrideKey}" is no longer known-OK; clearing pin and reverting to auto ordering.`);
    priorityOverrideKey = null;
  }

  const rank = (entry) => {
    const k = keyOf(entry);
    if (priorityOverrideKey && k === priorityOverrideKey) return -1; // Pinned entry always first
    if (okSpeed.has(k)) return okSpeed.get(k);            // 0..n-1 fastest first
    if (knownFailedKeys.has(k)) return knownOk.length + 999; // last
    return knownOk.length;                                   // untested
  };

  return [...modelEntries].sort((a, b) => rank(a) - rank(b));
}

// Single-model probe; resolves with { entry, data, elapsed } or throws.
// `signal` (an AbortController.signal) lets the caller cancel this in-flight
// request -- used by probeParallel() to stop losing requests once a winner
// is picked, instead of letting them run to completion and keep burning quota.
async function probeOne(entry, { messages, rest }, signal) {
  const startTime = Date.now();
  const apiKey = process.env[entry.apiKeyEnv];
  if (!apiKey) {
    console.log(`[${entry.provider}/${entry.model}] skipped - no API key set.`);
    throw new Error('no key');
  }
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  };
  // The proxy decides WHICH model to use (router's job), so the client's
  // requested model must never reach the upstream. Spread rest FIRST, then
  // overwrite with the entry's model + original messages so they always win.
  const payload = { ...rest, model: entry.model, messages };
  const response = await axios.post(entry.baseURL, payload, { headers, timeout: 30000, signal });
  const elapsed = Date.now() - startTime;

  // Only accept responses that actually contain usable content.
  const normalized = normalizeResponse(response.data);
  if (response.status === 200 && normalized) {
    recordUsage(entry, response.data);
    normalized._meta = { provider: entry.provider, model: entry.model, elapsed };
    console.log(`[${entry.provider}/${entry.model}] OK (${elapsed}ms)`);
    return { entry, data: normalized, elapsed };
  }
  const rawSnippet = response.data ? JSON.stringify(response.data).slice(0, 200) : '(empty)';
  console.log(`[${entry.provider}/${entry.model}] returned ${response.status} but no usable content. Raw: ${rawSnippet}`);
  throw new Error(`no usable content (${response.status})`);
}

// Tally tokens spent per provider/model so the UI can show usage.
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

// Try a list in order; first success returns, failures logged and demoted as they happen.
async function probeSequential(entries, ctx) {
  for (const entry of entries) {
    const controller = new AbortController();
    const result = await probeOne(entry, ctx, controller.signal).catch(() => null);
    if (result) return result;
    learnFailure(entry); // known-OK model failed at request time -> demote it
  }
  return null;
}

// Fire all at once; resolves IMMEDIATELY with the first (fastest) success.
// Does NOT wait for slow stragglers or failed probes — only rejects (null)
// when every candidate has failed.
function probeParallel(entries, ctx) {
  return new Promise((resolve) => {
    let pending = entries.length;
    let winnerResolved = false;
    if (pending === 0) return resolve(null);
    const controllers = entries.map(() => new AbortController());
    entries.forEach((entry, i) => {
      probeOne(entry, ctx, controllers[i].signal).then(
        (result) => {
          // Learn from every parallel success, not just the fastest winner,
          // so future requests know all the endpoints that worked.
          learnSuccess(result.entry, result.elapsed);
          if (!winnerResolved) {
            winnerResolved = true;
            // A winner was picked -- cancel every other in-flight probe so
            // they don't keep running (and burning quota/cost) after their
            // result is already discarded.
            controllers.forEach((c, j) => { if (j !== i) c.abort(); });
            resolve(result);
          }
        },
        (err) => {
          const wasCancelled = axios.isCancel(err) || err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError';
          if (!wasCancelled) {
            learnFailure(entry); // mark failed so it's deprioritized next time
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
    modelEntries = entries.filter(e => e.enabled);

    const app = express();
    app.use(express.json());

    app.post('/v1/chat/completions', async (req, res) => {
      // The client's model/stream fields are router control inputs, not
      // upstream payload — never forward them (upstreams would reject the
      // unknown model string / stream options).
      const { messages, stream, model: _clientModel, stream_options, ...rest } = req.body;

      totalRequests++; // Increment total requests counter

      const ordered = orderEntries();
      if (ordered.length === 0) {
        return res.status(502).json({ error: 'No models configured.' });
      }
      const ctx = { messages, rest };

      const winner = await findWinner(ordered, ctx);
      if (!winner) {
        return res.status(502).json({ error: 'All configured models failed.' });
      }

      if (stream) {
        return sendSseResponse(res, winner.data, winner.entry);
      }
      return res.json(winner.data);
    });

    // Bind the port and wait for a definitive outcome (either 'listening' or
    // 'error') before resolving/rejecting. Attaching the 'error' listener
    // synchronously, before yielding control, means a bind failure (e.g.
    // EADDRINUSE from clicking Connect twice, or the port already being used
    // by another app) is caught here instead of throwing an unhandled 'error'
    // event that crashes the entire Electron main process.
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

// Update routing knowledge from a health-check run (live, no restart needed)
function setHealthResults(results) {
  knownOk = results
    .filter(r => r.status === 'OK' && r.latency != null)
    .map(r => ({ provider: r.provider, model: r.model, latency: r.latency }))
    .sort((a, b) => a.latency - b.latency); // fastest first

  knownFailedKeys = new Set();
  results.forEach(r => {
    if (r.status !== 'OK') knownFailedKeys.add(`${r.provider}::${r.model}`);
  });

  // Persist known-OK list so it survives app restarts
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
  // Return as a sorted array (most total tokens first) for clean display
  return Object.values(tokenUsage).sort((a, b) => b.totalTokens - a.totalTokens);
}

module.exports = { startProxy, stopProxy, isProxyRunning, setHealthResults, getKnownOk, setPriorityOverride, getProxyStats, getTokenUsage, extractContent };
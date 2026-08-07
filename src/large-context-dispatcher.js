// large-context-dispatcher.js
//
// Feature: Large Context Dispatcher
// ----------------------------------
// proxy-server.js intercepts a request BEFORE tool-call translation when
// Assistant Config's "largeContextMode" is on and the estimated prompt token
// count exceeds "largeContextThreshold". It hands off to handleLargeContext()
// here, which:
//
//   1. Splits the input messages into chunks, respecting file boundaries
//      where they can be detected (e.g. "=== FILE: x.js ===" markers, markdown
//      file headings) and otherwise splitting on paragraph boundaries.
//   2. Builds a lane pool from the current known-OK list, each lane capped at
//      a concurrency limit based on its auth type (Cookie/web-session
//      providers get 1, API-key providers get more).
//   3. Distributes chunks across lanes fastest-free-first: whichever lane is
//      both fastest (known-OK order) and currently has spare capacity gets
//      the next chunk. Each chunk is summarized independently, no tools.
//   4. Sends a final assembler request — built from the ordered chunk
//      summaries plus the user's original question — to the best available
//      model.
//   5. Streams (or returns, for non-streaming clients) the final answer
//      exactly like a normal /v1/chat/completions response.
//
// NOTE ON THE REQUIRE BELOW: this module needs several internals from
// proxy-server.js (runSingleCompletion, orderEntries, sendSseResponse, token
// estimators, live assistant config). proxy-server.js requires THIS module at
// its top level, so requiring proxy-server.js back at OUR top level would be
// a load-time circular require and would hand us a half-populated exports
// object. Instead we require it lazily, inside handleLargeContext(), by which
// point proxy-server.js has finished loading and its module.exports is
// complete (the require only ever executes once an actual HTTP request comes
// in, long after startup).

const { LOG_MARKERS } = require('./shared-constants');

// --- Tunables (with Assistant Config overrides where noted) ---
const MIN_CHUNK_TOKENS = 3000;   // never make chunks smaller than this — avoids flooding lanes with tiny requests
const MAX_CHUNK_TOKENS_HARD_CAP = 40000; // absolute ceiling regardless of config, so a bad config value can't create one giant "chunk"
const MAX_CHUNK_RETRIES = 2;     // attempts per chunk across different lanes before giving up on it
const MAX_ASSEMBLER_FALLBACKS = 5; // how many candidates to try for the final assembly call before failing

function log(msg) {
  console.log(`${LOG_MARKERS.DISPATCH} ${msg}`);
}

// ---------------------------------------------------------------------------
// Step 1: chunking (respecting file boundaries where detectable)
// ---------------------------------------------------------------------------

// Lines that look like a file/section boundary marker. Checked in order;
// first match wins. Covers the common conventions people paste multi-file
// context in (comment-style FILE: markers, ===/--- banners, markdown headings
// naming a file).
const FILE_MARKER_PATTERNS = [
  /^\s*(?:\/\/|#|--|;)\s*={0,}\s*FILE\s*:\s*(.+?)\s*={0,}\s*$/i,
  /^\s*={3,}\s*(.+?)\s*={3,}\s*$/,                 // === path/to/file.js ===
  /^\s*-{3,}\s*(.+?)\s*-{3,}\s*$/,                 // --- path/to/file.js ---
  /^\s*#{1,6}\s+`?([\w./-]+\.\w+)`?\s*$/            // markdown heading naming a file
];

function findFileBoundaries(lines) {
  const boundaries = [];
  lines.forEach((line, i) => {
    for (const re of FILE_MARKER_PATTERNS) {
      const m = line.match(re);
      if (m) {
        boundaries.push({ line: i, name: (m[1] || '').trim() });
        break;
      }
    }
  });
  return boundaries;
}

// Splits one message's text into named segments at file boundaries. If no
// boundaries are found, returns the whole text as a single unnamed segment.
function splitTextByFileBoundaries(text) {
  const lines = text.split('\n');
  const boundaries = findFileBoundaries(lines);
  if (boundaries.length === 0) return [{ name: null, text }];

  const segments = [];
  if (boundaries[0].line > 0) {
    const pre = lines.slice(0, boundaries[0].line).join('\n').trim();
    if (pre) segments.push({ name: 'preamble', text: pre });
  }
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].line;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].line : lines.length;
    segments.push({ name: boundaries[i].name || `segment-${i + 1}`, text: lines.slice(start, end).join('\n') });
  }
  return segments;
}

function messageText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map(b => (b && b.text) || '').join('\n');
  return '';
}

// Flattens the message list (minus system messages, which ride along
// unsplit/unchunked into every chunk request instead) into ordered
// "blocks" — the atomic units chunking packs together.
function buildBlocks(messages) {
  const blocks = [];
  (messages || []).forEach((m, mi) => {
    if (!m || m.role === 'system') return;
    const text = messageText(m).trim();
    if (!text) return;
    const segments = splitTextByFileBoundaries(text);
    segments.forEach((seg, si) => {
      blocks.push({ role: m.role, name: seg.name, text: seg.text, msgIndex: mi, segIndex: si });
    });
  });
  return blocks;
}

// Hard-splits a single oversized block at paragraph boundaries (falling back
// to a raw character slice for any paragraph that's still too big on its
// own) so no chunk request blows past the target size.
function hardSplitBlock(text, targetTokens, estimateTokensFromText) {
  const targetChars = targetTokens * 4;
  const paragraphs = text.split(/\n{2,}/);
  const pieces = [];
  let cur = '';
  for (const p of paragraphs) {
    if (cur && (cur.length + p.length + 2) > targetChars) {
      pieces.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > targetChars) {
      pieces.push(cur.slice(0, targetChars));
      cur = cur.slice(targetChars);
    }
  }
  if (cur) pieces.push(cur);
  return pieces.length ? pieces : [text];
}

// Greedily packs blocks into chunks up to targetTokens each. A block is only
// ever split across chunks if it alone exceeds targetTokens (keeping file
// boundaries intact whenever a block fits).
function packBlocksIntoChunks(blocks, targetTokens, estimateTokensFromText) {
  const chunks = [];
  let current = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
  };

  for (const block of blocks) {
    const blockTokens = estimateTokensFromText(block.text);
    if (blockTokens > targetTokens) {
      flush();
      const pieces = hardSplitBlock(block.text, targetTokens, estimateTokensFromText);
      pieces.forEach((p, pi) => {
        chunks.push([{ ...block, name: block.name ? `${block.name} (part ${pi + 1}/${pieces.length})` : undefined, text: p }]);
      });
      continue;
    }
    if (current.length && currentTokens + blockTokens > targetTokens) flush();
    current.push(block);
    currentTokens += blockTokens;
  }
  flush();
  return chunks;
}

function renderChunkText(blockGroup) {
  return blockGroup.map(b => (b.name ? `[${b.name}]\n${b.text}` : b.text)).join('\n\n');
}

// ---------------------------------------------------------------------------
// Step 2: lane pool
// ---------------------------------------------------------------------------

function buildLanePool(orderedEntries, assistantConfig) {
  const concurrencyCfg = assistantConfig.largeContextConcurrency || { default: 5, cookie: 1 };
  // orderedEntries is already fastest-known-good-first (or config order, per
  // routing mode) — lanes keep that order so "fastest-free-first" reduces to
  // "first lane in this array with spare capacity".
  return orderedEntries.map(entry => ({
    entry,
    key: `${entry.provider}::${entry.model}`,
    limit: Math.max(1, entry.authType === 'Cookie' ? (concurrencyCfg.cookie ?? 1) : (concurrencyCfg.default ?? 5)),
    inFlight: 0
  }));
}

// ---------------------------------------------------------------------------
// Step 3: fastest-free-first parallel chunk summarization
// ---------------------------------------------------------------------------

function buildChunkMessages(chunkText, chunkLabel, userQuestion) {
  const system = {
    role: 'system',
    content:
      'You are one worker in a distributed context-processing pipeline. You will receive one excerpt out of a ' +
      'much larger document/conversation that has been split into pieces and handed to several workers in parallel. ' +
      'Summarize this excerpt factually and comprehensively, keeping any specific details (numbers, names, dates, ' +
      'identifiers, code symbols, file paths) that could matter for answering the user\'s question below. ' +
      'Do NOT answer the question yourself and do NOT comment on the pipeline — only extract and condense the ' +
      'relevant information from THIS excerpt. If this excerpt has nothing to do with the question, say so briefly. ' +
      'Output plain text only, no markdown headers.'
  };
  const user = {
    role: 'user',
    content:
      `User's original question (for relevance only — do not answer it here): ${userQuestion || '(none given)'}\n\n` +
      `--- ${chunkLabel} ---\n${chunkText}`
  };
  return [system, user];
}

async function summarizeChunk(proxy, lane, chunkText, chunkLabel, userQuestion, timeoutMs) {
  const messages = buildChunkMessages(chunkText, chunkLabel, userQuestion);
  const result = await proxy.runSingleCompletion(lane.entry, messages, { timeoutMs });
  return result.text;
}

// Dispatches all chunks across the lane pool, fastest-free-first, retrying a
// failed chunk on a different lane up to MAX_CHUNK_RETRIES times. Resolves
// once every chunk has either succeeded or exhausted its retries (failed
// chunks are marked so the assembler can note the gap rather than the whole
// request failing).
function runLaneDispatch(proxy, chunks, lanePool, userQuestion, timeoutMs) {
  return new Promise((resolve) => {
    const total = chunks.length;
    if (total === 0) return resolve([]);

    const results = new Array(total).fill(null);
    const attempts = new Array(total).fill(0);
    const excludedLanes = chunks.map(() => new Set()); // lanes already tried & failed, per chunk
    // Indices that are ready to be picked up by a lane — a chunk index lives
    // in exactly one of {pending, in-flight, done} at any time, so nothing
    // can ever be dispatched to two lanes at once.
    const pending = chunks.map((_, i) => i);
    let completed = 0;

    function pickLaneFor(chunkIdx) {
      const excluded = excludedLanes[chunkIdx];
      return lanePool.find(l => l.inFlight < l.limit && !excluded.has(l.key)) || null;
    }

    function startChunk(idx, lane) {
      lane.inFlight++;
      attempts[idx]++;
      const label = `chunk ${idx + 1}/${total}`;
      log(`dispatching ${label} -> ${lane.entry.provider}/${lane.entry.model} (attempt ${attempts[idx]})`);

      summarizeChunk(proxy, lane, chunks[idx].text, label, userQuestion, timeoutMs)
        .then(summary => {
          lane.inFlight--;
          log(`${label} OK via ${lane.entry.provider}/${lane.entry.model}`);
          results[idx] = { ok: true, summary, chunk: chunks[idx], provider: lane.entry.provider, model: lane.entry.model };
          completed++;
          settleAndPump();
        })
        .catch(err => {
          lane.inFlight--;
          excludedLanes[idx].add(lane.key);
          log(`${label} FAILED via ${lane.entry.provider}/${lane.entry.model}: ${err.message}`);
          if (attempts[idx] < MAX_CHUNK_RETRIES && excludedLanes[idx].size < lanePool.length) {
            pending.push(idx); // retry on a different lane
          } else {
            results[idx] = { ok: false, error: err.message, chunk: chunks[idx] };
            completed++;
          }
          settleAndPump();
        });
    }

    function fillLanes() {
      // Repeatedly scan pending for a chunk whose exclusion set still leaves
      // a free lane; stop once nothing more can be started right now.
      let dispatchedSomething = true;
      while (dispatchedSomething) {
        dispatchedSomething = false;
        for (let p = 0; p < pending.length; p++) {
          const idx = pending[p];
          const lane = pickLaneFor(idx);
          if (!lane) continue;
          pending.splice(p, 1);
          startChunk(idx, lane);
          dispatchedSomething = true;
          break; // pending mutated — restart the scan
        }
      }
    }

    function settleAndPump() {
      if (completed === total) return resolve(results);
      fillLanes();
    }

    fillLanes();
  });
}

// ---------------------------------------------------------------------------
// Step 4: final assembly
// ---------------------------------------------------------------------------

function buildAssemblerMessages(userQuestion, chunkResults) {
  const total = chunkResults.length;
  const body = chunkResults.map((r, i) => {
    if (r.ok) return `[Chunk ${i + 1}/${total}]\n${r.summary}`;
    return `[Chunk ${i + 1}/${total}] (FAILED to process — treat as missing information: ${r.error})`;
  }).join('\n\n');

  const system = {
    role: 'system',
    content:
      'You are the final-assembly stage of a Large Context Dispatcher. The context was too large for one model, ' +
      'so it was split into chunks and summarized in parallel by several models. You now have those summaries, in ' +
      'their original order. Using only the information in these summaries, answer the user\'s original question as ' +
      'directly and completely as you can. If a chunk failed and the gap seems relevant, briefly note that some ' +
      'information may be missing — otherwise don\'t mention the internal chunking/summarization process at all.'
  };
  const user = {
    role: 'user',
    content: `Original question: ${userQuestion || '(the user asked to be given the best possible answer/summary of the provided context)'}\n\n--- Chunk summaries ---\n${body}`
  };
  return [system, user];
}

async function runAssembler(proxy, candidates, userQuestion, chunkResults, rest, timeoutMs) {
  const tried = candidates.slice(0, MAX_ASSEMBLER_FALLBACKS);
  const messages = buildAssemblerMessages(userQuestion, chunkResults);
  let lastErr = null;
  for (const entry of tried) {
    try {
      log(`assembling final answer via ${entry.provider}/${entry.model}`);
      const result = await proxy.runSingleCompletion(entry, messages, { timeoutMs, rest });
      return result;
    } catch (err) {
      lastErr = err;
      log(`assembler candidate ${entry.provider}/${entry.model} failed: ${err.message}`);
    }
  }
  throw lastErr || new Error('no assembler candidate available');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function handleLargeContext(req, res, originalMessages, userQuestion, tokenCount) {
  // Deferred require — see the note at the top of this file.
  const proxy = require('./proxy-server');
  const assistantConfig = proxy.getAssistantConfig();
  const { stream, ...rest } = req.body || {};
  delete rest.messages;
  delete rest.model;
  delete rest.tools;
  delete rest.stream_options;

  const timeoutMs = assistantConfig.largeContextTimeoutMs > 0 ? assistantConfig.largeContextTimeoutMs : 60000;

  const orderedEntries = proxy.orderEntries();
  const lanePool = buildLanePool(orderedEntries, assistantConfig);
  if (lanePool.length === 0) {
    if (!res.headersSent) res.status(502).json({ error: 'Large Context Dispatcher: no models configured.' });
    return { entry: null };
  }

  // --- chunk sizing: aim for roughly one chunk per unit of lane capacity,
  // bounded to a sane per-request size regardless of how big the prompt is.
  const totalLaneCapacity = lanePool.reduce((s, l) => s + l.limit, 0) || 1;
  const configuredChunkTokens = assistantConfig.largeContextChunkTokens > 0 ? assistantConfig.largeContextChunkTokens : 20000;
  const maxChunkTokens = Math.min(configuredChunkTokens, MAX_CHUNK_TOKENS_HARD_CAP);
  const desiredChunkCount = Math.max(totalLaneCapacity, Math.ceil(tokenCount / maxChunkTokens));
  const targetTokensPerChunk = Math.min(maxChunkTokens, Math.max(MIN_CHUNK_TOKENS, Math.ceil(tokenCount / desiredChunkCount)));

  const blocks = buildBlocks(originalMessages);
  const chunkGroups = packBlocksIntoChunks(blocks, targetTokensPerChunk, proxy.estimateTokensFromText);
  const chunks = chunkGroups.map(group => ({ text: renderChunkText(group) }));

  log(`~${tokenCount} tokens -> ${chunks.length} chunk(s), target ~${targetTokensPerChunk} tokens/chunk, ${lanePool.length} lane(s) (capacity ${totalLaneCapacity})`);

  if (chunks.length === 0) {
    if (!res.headersSent) res.status(400).json({ error: 'Large Context Dispatcher: nothing to summarize.' });
    return { entry: null };
  }

  const chunkResults = await runLaneDispatch(proxy, chunks, lanePool, userQuestion, timeoutMs);
  const failedCount = chunkResults.filter(r => !r.ok).length;
  if (failedCount > 0) log(`${failedCount}/${chunks.length} chunk(s) failed after retries — assembling with partial context`);
  if (failedCount === chunks.length) {
    if (!res.headersSent) res.status(502).json({ error: 'Large Context Dispatcher: all chunks failed to process.' });
    return { entry: null };
  }

  // Best available model for the final answer: fastest known-good that isn't
  // known-failed, falling back down the ordered list on error.
  const assemblerCandidates = orderedEntries;
  const final = await runAssembler(proxy, assemblerCandidates, userQuestion, chunkResults, rest, timeoutMs);

  const data = {
    id: `chatcmpl-lcd-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: final.entry.model,
    choices: [{ index: 0, message: { role: 'assistant', content: final.text }, finish_reason: 'stop' }],
    usage: (final.raw && final.raw.usage) || undefined
  };

  if (stream) {
    proxy.sendSseResponse(res, data, final.entry);
  } else {
    res.json(data);
  }
  return { entry: final.entry };
}

module.exports = { handleLargeContext };

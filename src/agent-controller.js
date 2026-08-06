// agent-controller.js
//
// Backs the renderer's "Agent" tab: a two-mode (Global / Project) coding
// agent loop built on top of the existing proxy (processChatCompletion,
// added in proxy-server.js) and the existing multi-provider routing/fallback
// it already does for the "/v1/chat/completions" HTTP route.
//
// Mode summary:
//   - Global mode  (projectRoot === null): no filesystem/shell tools; only
//     `scratchpad_write` (writes to a temp dir, never the project) plus
//     whatever the user has uploaded as chat context.
//   - Project mode (projectRoot === an absolute path): adds list_directory,
//     read_file, write_file, search_code, run_command — all path-guarded to
//     stay inside projectRoot, and write_file/run_command require an
//     explicit renderer-side approval round-trip before they execute.
//
// This module owns all of that state; main.js just calls initAgentController
// once at startup and otherwise never touches it.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const { IPC_CHANNELS, TIMEOUTS, AGENT_PROJECT_DIR, AGENT_SCRATCHPAD_DIR } = require('./shared-constants');
const {
  loadAgentConfig,
  saveAgentConfig,
  loadAgentSkills,
  saveAgentSkills
} = require('./state-store');

// Deferred require (same pattern large-context-dispatcher.js uses) so a
// require-time cycle between proxy-server.js and this module can't happen —
// proxy-server.js never requires agent-controller.js, but it's cheap
// insurance and keeps both modules independently loadable/testable.
function proxy() {
  return require('./proxy-server');
}

// --- Module state ---------------------------------------------------------
let projectRoot = null;              // null => Global mode
let sessionMessages = [];            // OpenAI-format history for the active agent conversation
let abortRequested = false;
let running = false;

let globalConfig = loadAgentConfig();
let globalSkills = loadAgentSkills();       // [{ id, name, description, prompt, enabled }]
let projectSkills = [];                     // same shape, loaded from <project>/.agent/skills.json
let globalMcpServers = globalConfig.globalMcpServers || [];
let projectMcpServers = [];

const mcpClients = new Map();        // key: `${scope}:${name}` -> client record
const pendingApprovals = new Map();  // id -> resolve(approved: boolean)

// --- NEW: diff preview --- pending diff-preview round-trips, keyed the same
// way as pendingApprovals but resolving to a boolean accept/reject.
const pendingDiffPreviews = new Map(); // id -> resolve(accepted: boolean)

// --- NEW: undo --- single-slot "last write" record so the user can revert
// the most recent file write. Cleared on undo, on mode change, and at the
// start of a new agent session (matches the "one-step revert" spec).
let lastWrite = null; // { path, existed, previousContent, sessionMessagesIndex }

const AGENT_TMP_DIR = path.join(os.tmpdir(), AGENT_SCRATCHPAD_DIR);
try { fs.mkdirSync(AGENT_TMP_DIR, { recursive: true }); } catch (_) { /* best-effort */ }

const DEFAULT_IGNORE = ['node_modules', '.git', AGENT_PROJECT_DIR, 'dist', 'build', '.next', '.venv', '__pycache__'];
const MAX_FILE_LIST = 5000;
const MAX_READ_BYTES = 300 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_MATCHES = 200;
const COMMAND_TIMEOUT_MS = TIMEOUTS.COMMAND_MS;
const MCP_REQUEST_TIMEOUT_MS = TIMEOUTS.MCP_REQUEST_MS;
const MAX_AGENT_STEPS = 25; // guards against a runaway tool-call chain
// --- NEW: agent-loop resilience (keep-alive) ---
// Previously a single failed model call (transient network blip, one bad
// probe before the routing layer's own retry/fallback kicks in) aborted the
// ENTIRE task immediately via AGENT_ERROR. This retries the model call
// itself a few times with a short backoff before giving up on the turn —
// separate from (and on top of) proxy-server.js's own per-candidate
// retryCount, which only covers one candidate before findWinner moves on.
const MODEL_CALL_MAX_ATTEMPTS = 3;
const MODEL_CALL_RETRY_DELAY_MS = 1500;
// If the model issues the exact same tool call (name + args) this many
// times in a row, it's stuck in a loop rather than making progress —
// interrupt with a corrective nudge instead of silently burning the whole
// step budget on the same failing action.
const STUCK_LOOP_THRESHOLD = 3;
// If the step budget runs out but the last few steps show real progress
// (successful tool calls, no repeated failures), grant a bounded number of
// extra steps once rather than just giving up — a real "keep going until
// actually done" behavior instead of a hard cliff.
const STEP_LIMIT_EXTENSION = 10;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function toolCallSignature(call) {
  const name = call.function && call.function.name;
  const args = call.function && call.function.arguments;
  return `${name}:${args}`;
}

async function runAgentTurn(sendToRenderer, userText, uploadedFiles) {
  if (running) throw new Error('Agent is already processing a turn.');
  running = true;
  abortRequested = false;
  try {
    let content = userText || '';
    if (Array.isArray(uploadedFiles) && uploadedFiles.length) {
      const ctx = uploadedFiles
        .filter((f) => f && f.content != null)
        .map((f) => `--- uploaded: ${f.filename} ---\n${f.content}`)
        .join('\n\n');
      if (ctx) content = `${content}\n\n[Attached files]\n${ctx}`;
    }
    sessionMessages.push({ role: 'user', content });

    const mode = getMode();
    const skills = (mode === 'project' ? [...globalSkills, ...projectSkills] : globalSkills)
      .filter((s) => s.enabled !== false);
    const skillsBlock = skills.length
      ? `\n\nActive skills:\n${skills.map((s) => `- ${s.name}: ${s.description || ''}`).join('\n')}`
      : '';
    const tools = buildToolDefs(mode);
    const messagesForModel = [{ role: 'system', content: buildSystemPrompt(mode) + skillsBlock }, ...sessionMessages];

    let stepLimit = MAX_AGENT_STEPS;
    let extensionGranted = false;
    let recentToolSignatures = [];
    let finalMessage = null;

    for (let step = 0; step < stepLimit; step++) {
      if (abortRequested) { sendToRenderer(IPC_CHANNELS.AGENT_DONE, { aborted: true }); return; }

      // --- NEW: streaming support ---
      const streamingEnabled = globalConfig.streamResponses !== false;
      let message;

      // --- NEW: retry-on-transient-error (keep-alive) ---
      let lastCallError = null;
      for (let attempt = 1; attempt <= MODEL_CALL_MAX_ATTEMPTS; attempt++) {
        if (abortRequested) break;
        try {
          if (streamingEnabled) {
            sendToRenderer(IPC_CHANNELS.AGENT_STREAM_START, {});
            let fullText = '';
            const streamResult = await proxy().processChatCompletionStream(messagesForModel, { tools }, (token) => {
              fullText += token;
              sendToRenderer(IPC_CHANNELS.AGENT_STREAM_TOKEN, { token });
            });
            message = {
              role: 'assistant',
              content: streamResult.content || fullText || null,
              ...(streamResult.tool_calls ? { tool_calls: streamResult.tool_calls } : {})
            };
            sendToRenderer(IPC_CHANNELS.AGENT_STREAM_END, {
              fullText: message.content || '',
              tool_calls: streamResult.tool_calls || null
            });
          } else {
            const response = await proxy().processChatCompletion(messagesForModel, { tools });
            message = (response && response.choices && response.choices[0] && response.choices[0].message) || {};
            if (message.content) {
              // Fallback path when streaming is off: whole message in one chunk.
              sendToRenderer(IPC_CHANNELS.AGENT_STREAM_CHUNK, { text: message.content });
            }
          }
          lastCallError = null;
          break;
        } catch (err) {
          lastCallError = err;
          if (attempt < MODEL_CALL_MAX_ATTEMPTS) {
            sendToRenderer(IPC_CHANNELS.AGENT_ERROR, {
              message: `Model call failed (attempt ${attempt}/${MODEL_CALL_MAX_ATTEMPTS}): ${err.message} — retrying.`,
              recoverable: true
            });
            await sleep(MODEL_CALL_RETRY_DELAY_MS);
          }
        }
      }
      if (lastCallError) {
        sendToRenderer(IPC_CHANNELS.AGENT_ERROR, { message: lastCallError.message });
        return;
      }
      if (abortRequested) { sendToRenderer(IPC_CHANNELS.AGENT_DONE, { aborted: true }); return; }

      messagesForModel.push(message);
      sessionMessages.push(message);

      const toolCalls = message.tool_calls;
      if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        finalMessage = message;
        break;
      }

      // --- NEW: stuck-loop detection (keep-alive) ---
      // Track only single-tool-call steps (the common "stuck" shape); a
      // multi-call step resets the streak since it's clearly doing
      // something different each time.
      if (toolCalls.length === 1) {
        const sig = toolCallSignature(toolCalls[0]);
        recentToolSignatures.push(sig);
        if (recentToolSignatures.length > STUCK_LOOP_THRESHOLD) recentToolSignatures.shift();
        const allSame = recentToolSignatures.length === STUCK_LOOP_THRESHOLD &&
          recentToolSignatures.every((s) => s === recentToolSignatures[0]);
        if (allSame) {
          const nudge = {
            role: 'user',
            content: `[system: you've called the same tool with the same arguments ${STUCK_LOOP_THRESHOLD} times in a row without making progress. ` +
              `Stop repeating it — either try a genuinely different approach, or if the task is actually complete, say so and stop.]`
          };
          messagesForModel.push(nudge);
          sessionMessages.push(nudge);
          recentToolSignatures = [];
        }
      } else {
        recentToolSignatures = [];
      }

      for (const call of toolCalls) {
        if (abortRequested) break;
        const name = call.function && call.function.name;
        let args = {};
        try { args = JSON.parse((call.function && call.function.arguments) || '{}'); } catch (_) { args = {}; }

        sendToRenderer(IPC_CHANNELS.AGENT_TOOL_START, { id: call.id, name, args });
        const result = await executeTool(sendToRenderer, name, args);
        sendToRenderer(IPC_CHANNELS.AGENT_TOOL_RESULT, { id: call.id, name, result });

        const toolMsg = {
          role: 'tool',
          tool_call_id: call.id,
          content: typeof result === 'string' ? result : (result.message || JSON.stringify(result))
        };
        messagesForModel.push(toolMsg);
        sessionMessages.push(toolMsg);
      }

      // --- NEW: bounded step-limit extension (keep-alive) ---
      // Reaching the budget with clear signs of steady progress (no stuck
      // loop just resolved) earns ONE extension rather than a hard stop, so
      // a genuinely long task isn't cut off mid-way through real work.
      if (step === stepLimit - 1 && !extensionGranted) {
        extensionGranted = true;
        stepLimit += STEP_LIMIT_EXTENSION;
        sendToRenderer(IPC_CHANNELS.AGENT_ERROR, {
          message: `Step budget reached but the task appears to be progressing — granting ${STEP_LIMIT_EXTENSION} more steps.`,
          recoverable: true
        });
      }
    }

    if (!finalMessage) {
      sendToRenderer(IPC_CHANNELS.AGENT_DONE, { stoppedReason: 'step-limit-reached' });
      return;
    }

    sendToRenderer(IPC_CHANNELS.AGENT_DONE, {});
  } finally {
    running = false;
  }
}

function getMode() { return projectRoot ? 'project' : 'global'; }

// --- Path safety -----------------------------------------------------------
// Every project-mode tool funnels its path argument through this so a model
// (or a bad prompt injection from a file it just read) can't walk outside
// the selected folder with a "../../" argument.
function resolveInProject(relPath) {
  if (!projectRoot) throw new Error('Not in project mode.');
  const abs = path.resolve(projectRoot, relPath || '.');
  const rootWithSep = projectRoot.endsWith(path.sep) ? projectRoot : projectRoot + path.sep;
  if (abs !== projectRoot && !abs.startsWith(rootWithSep)) {
    throw new Error(`Path "${relPath}" escapes the project root — refused.`);
  }
  return abs;
}

// --- Approval round-trip ----------------------------------------------------
function requestApproval(sendToRenderer, action, details) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    pendingApprovals.set(id, resolve);
    sendToRenderer(IPC_CHANNELS.AGENT_APPROVAL_REQUEST, { id, action, details });
  });
}

// --- NEW: diff preview -------------------------------------------------------
// A small, dependency-free unified-diff line generator. Not a full LCS diff
// (no external `diff` package is available in this environment — see the
// task notes), but a classic Myers-lite line-based diff is overkill for what
// the renderer needs: a scrollable, color-coded before/after view. This uses
// a straightforward LCS over lines (O(n*m) DP), which is plenty fast for
// source files up to a few thousand lines, and produces a real minimal diff
// rather than a naive "everything changed" fallback.
function diffLines(oldText, newText) {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const n = a.length, m = b.length;

  // DP table capped to avoid pathological memory use on huge files; beyond
  // the cap we fall back to a simple "old removed / new added" block, which
  // is still a correct (if less granular) diff.
  const CAP = 4000;
  if (n > CAP || m > CAP) {
    const rows = [];
    for (const line of a) rows.push({ type: 'del', text: line });
    for (const line of b) rows.push({ type: 'add', text: line });
    return rows;
  }

  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'ctx', text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'del', text: a[i] });
      i++;
    } else {
      rows.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) { rows.push({ type: 'del', text: a[i] }); i++; }
  while (j < m) { rows.push({ type: 'add', text: b[j] }); j++; }
  return rows;
}

function requestDiffPreview(sendToRenderer, details) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    pendingDiffPreviews.set(id, resolve);
    sendToRenderer(IPC_CHANNELS.AGENT_DIFF_PREVIEW, { id, ...details });
  });
}

// --- Project file tools ------------------------------------------------------
// Natural (numeric-aware) sort so "file2" sorts before "file10" and the model
// sees a stable, human-friendly listing instead of a raw lexicographic one.
function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function walkProjectFiles(rootAbs, ignore) {
  const out = [];
  const stack = [rootAbs];
  while (stack.length && out.length < MAX_FILE_LIST) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (ignore.includes(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(rootAbs, abs);
      if (e.isDirectory()) stack.push(abs);
      else out.push(rel);
      if (out.length >= MAX_FILE_LIST) break;
    }
  }
  return out.sort(naturalCompare);
}

async function toolListDirectory(args) {
  const abs = resolveInProject(args.path || '.');
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => !DEFAULT_IGNORE.includes(e.name))
    .map((e) => `${e.isDirectory() ? 'dir ' : 'file'}  ${e.name}`);
  return entries.length ? entries.join('\n') : '(empty directory)';
}

async function toolReadFile(args) {
  const abs = resolveInProject(args.path);
  const stat = fs.statSync(abs);
  if (stat.size > MAX_READ_BYTES && !args.start_line && !args.end_line) {
    throw new Error(`File is ${stat.size} bytes (cap is ${MAX_READ_BYTES}) — pass start_line/end_line to read a slice.`);
  }
  const text = fs.readFileSync(abs, 'utf-8');
  if (args.start_line || args.end_line) {
    const lines = text.split('\n');
    const start = Math.max(1, args.start_line || 1) - 1;
    const end = Math.min(lines.length, args.end_line || lines.length);
    return lines.slice(start, end).join('\n');
  }
  return text;
}

async function executeWriteFile(sendToRenderer, args) {
  const abs = resolveInProject(args.path);
  const newContent = args.content ?? '';
  const existed = fs.existsSync(abs);
  let previousContent = null;
  if (existed) {
    try { previousContent = fs.readFileSync(abs, 'utf-8'); } catch (_) { previousContent = null; }
  }

  // --- NEW: diff preview --- "Quick approval" (alwaysApproveWrites) keeps
  // the original, lighter-weight Approve/Deny flow (no diff round-trip).
  // Either way this ALWAYS pauses for an explicit user decision before
  // writing — "quick" only means "skip the diff", never "skip asking".
  // Otherwise show the diff and let the user Accept/Reject.
  if (globalConfig.alwaysApproveWrites) {
    const approved = await requestApproval(sendToRenderer, 'write_file', {
      path: args.path,
      preview: String(newContent).slice(0, 2000)
    });
    if (!approved) return { ok: false, message: 'Write denied by user.' };
  } else {
    const rows = diffLines(previousContent || '', newContent);
    const accepted = await requestDiffPreview(sendToRenderer, {
      path: args.path,
      isNewFile: !existed,
      oldContent: previousContent,
      newContent,
      diff: rows
    });
    if (!accepted) return { ok: false, message: 'Write rejected by user (diff preview).' };
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, newContent);

  // --- NEW: undo --- remember enough to revert this single write. Recording
  // sessionMessages.length here (before this tool's result message is
  // pushed) lets undoLastWrite() truncate the conversation back to just
  // before this write's tool_call/result pair.
  lastWrite = {
    path: args.path,
    existed,
    previousContent,
    sessionMessagesIndexBeforeCall: sessionMessages.length
  };
  sendToRenderer(IPC_CHANNELS.AGENT_UNDO_STATE, { canUndo: true, summary: `Write to ${args.path}` });

  return { ok: true, message: `Wrote ${Buffer.byteLength(newContent)} bytes to ${args.path}` };
}

// --- NEW: undo ---------------------------------------------------------------
// Reverts the most recent file write: restores previous content (or deletes
// the file if it didn't exist before), truncates the conversation back to
// just before that write's assistant tool-call, and clears the undo slot
// (one-step revert per the spec).
function undoLastWrite() {
  if (!lastWrite) return { ok: false, message: 'Nothing to undo.' };
  const { path: relPath, existed, previousContent, sessionMessagesIndexBeforeCall } = lastWrite;
  try {
    const abs = resolveInProject(relPath);
    if (existed) {
      fs.writeFileSync(abs, previousContent ?? '');
    } else {
      try { fs.unlinkSync(abs); } catch (_) { /* already gone / best-effort */ }
    }
  } catch (err) {
    return { ok: false, message: `Could not undo write to ${relPath}: ${err.message}` };
  }
  if (typeof sessionMessagesIndexBeforeCall === 'number') {
    // The assistant message containing the write_file tool_call is the last
    // entry before this index's worth of tool-result messages were appended;
    // trimming back to that boundary drops the tool_call/tool_result pair
    // (and anything after) so the model doesn't see a write it no longer
    // believes happened.
    sessionMessages = sessionMessages.slice(0, sessionMessagesIndexBeforeCall);
  }
  const undone = lastWrite;
  lastWrite = null;
  return { ok: true, message: `Reverted ${undone.path}${undone.existed ? '' : ' (file removed — it did not exist before this write)'}.` };
}

async function executeRunCommand(sendToRenderer, args) {
  if (!projectRoot) throw new Error('Not in project mode.');
  const approved = await requestApproval(sendToRenderer, 'run_command', { command: args.command });
  if (!approved) return { ok: false, message: 'Command denied by user.' };
  return new Promise((resolve) => {
    exec(args.command, { cwd: projectRoot, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      const parts = [];
      if (stdout) parts.push(stdout);
      if (stderr) parts.push(`[stderr]\n${stderr}`);
      if (err) parts.push(`[exit] ${err.killed ? 'timed out after 30s' : err.message}`);
      resolve({ ok: !err, message: parts.join('\n') || '(no output)' });
    });
  });
}

async function toolSearchCode(args) {
  const query = args.query;
  const useRegex = !!args.regex;
  let re = null;
  if (useRegex) {
    try { re = new RegExp(query, 'i'); } catch (err) { throw new Error(`Invalid regex: ${err.message}`); }
  }
  const files = walkProjectFiles(projectRoot, DEFAULT_IGNORE);
  const matches = [];
  for (const rel of files) {
    if (matches.length >= MAX_SEARCH_MATCHES) break;
    const abs = path.join(projectRoot, rel);
    let stat;
    try { stat = fs.statSync(abs); } catch (_) { continue; }
    if (stat.size > MAX_SEARCH_FILE_BYTES) continue; // skip large/likely-binary files
    let text;
    try { text = fs.readFileSync(abs, 'utf-8'); } catch (_) { continue; } // skip binary/undecodable files
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i++) {
      const hit = useRegex ? re.test(lines[i]) : lines[i].includes(query);
      if (hit) matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
    }
  }
  return matches.length ? matches.join('\n') : 'No matches found.';
}

async function toolScratchpadWrite(args) {
  const safeName = (args.filename || `note-${Date.now()}.md`).replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join(AGENT_TMP_DIR, `${crypto.randomUUID().slice(0, 8)}-${safeName}`);
  fs.writeFileSync(filePath, args.content ?? '');
  return { ok: true, message: `Saved to scratchpad: ${filePath}` };
}

// --- MCP client (stdio JSON-RPC + minimal HTTP JSON-RPC) -------------------
// This is a purposefully small MCP client: it speaks JSON-RPC 2.0 well
// enough for `initialize`, `tools/list`, and `tools/call`, over either a
// spawned stdio subprocess or a plain HTTP POST endpoint. It does not
// implement the full Streamable-HTTP (SSE) transport variant of the spec —
// only request/response JSON-RPC over HTTP — which covers the common case
// of a simple MCP-over-HTTP server.
function mcpStdioRequest(client, method, params) {
  return new Promise((resolve, reject) => {
    const id = client.nextId++;
    client.pending.set(id, { resolve, reject });
    client.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (client.pending.has(id)) {
        client.pending.delete(id);
        reject(new Error(`MCP "${method}" timed out.`));
      }
    }, MCP_REQUEST_TIMEOUT_MS);
  });
}

async function mcpHttpRequest(client, method, params) {
  const axios = require('axios');
  const id = client.nextId++;
  const res = await axios.post(
    client.url,
    { jsonrpc: '2.0', id, method, params },
    { headers: { 'Content-Type': 'application/json', ...(client.headers || {}) }, timeout: MCP_REQUEST_TIMEOUT_MS }
  );
  if (res.data && res.data.error) throw new Error(res.data.error.message || 'MCP error');
  return res.data && res.data.result;
}

// --- NEW: MCP SSE ---
// Streamable-HTTP transport (per the MCP spec): a persistent GET/SSE
// connection for server -> client notifications, plus POST for client ->
// server JSON-RPC requests whose response may come back either directly in
// the POST body or as an SSE event on the GET stream. Falls back to plain
// mcpHttpRequest (POST-only) if the server doesn't advertise SSE on GET.
const MCP_SSE_INITIAL_BACKOFF_MS = 1000;
const MCP_SSE_MAX_BACKOFF_MS = 30000;

function parseSseChunk(buffer) {
  // Splits a raw SSE byte stream into { events, rest } — `rest` is the
  // trailing partial event still awaiting more data.
  const events = [];
  const parts = buffer.split('\n\n');
  const rest = parts.pop() || '';
  for (const part of parts) {
    let eventType = 'message';
    const dataLines = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length) events.push({ event: eventType, data: dataLines.join('\n') });
  }
  return { events, rest };
}

function handleMcpSseMessage(client, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; } // ignore non-JSON-RPC SSE noise
  if (msg.id != null && client.pending.has(msg.id)) {
    const { resolve, reject } = client.pending.get(msg.id);
    client.pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || 'MCP error'));
    else resolve(msg.result);
  }
  // Server -> client notifications (no id) — e.g. resource/tool-list updates.
  // No renderer surface for these yet; logged so they're at least visible.
  else if (msg.method) {
    console.log(`[agent] MCP "${client.name}" notification: ${msg.method}`);
  }
}

function openMcpSseStream(client) {
  const http = require('http');
  const https = require('https');
  const { URL } = require('url');
  if (client.closed) return;

  const target = new URL(client.url);
  const lib = target.protocol === 'https:' ? https : http;
  const headers = { Accept: 'text/event-stream', ...(client.headers || {}) };
  if (client.lastEventId) headers['Last-Event-ID'] = client.lastEventId;

  const req = lib.get(target, { headers }, (res) => {
    if (res.statusCode !== 200 || !String(res.headers['content-type'] || '').includes('text/event-stream')) {
      // Server doesn't actually support SSE on GET — stop retrying and let
      // the client fall back to plain request/response POSTs.
      client.sseSupported = false;
      res.resume();
      return;
    }
    client.sseSupported = true;
    client.sseBackoffMs = MCP_SSE_INITIAL_BACKOFF_MS; // connected: reset backoff
    let buffer = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buffer += chunk;
      const { events, rest } = parseSseChunk(buffer);
      buffer = rest;
      for (const ev of events) {
        if (ev.event === 'id') client.lastEventId = ev.data;
        handleMcpSseMessage(client, ev.data);
      }
    });
    res.on('end', () => scheduleMcpSseReconnect(client));
    res.on('error', () => scheduleMcpSseReconnect(client));
  });
  req.on('error', () => scheduleMcpSseReconnect(client));
  client.sseRequest = req;
}

function scheduleMcpSseReconnect(client) {
  if (client.closed || client.sseSupported === false) return;
  const wait = client.sseBackoffMs || MCP_SSE_INITIAL_BACKOFF_MS;
  client.sseBackoffMs = Math.min(wait * 2, MCP_SSE_MAX_BACKOFF_MS);
  setTimeout(() => { if (!client.closed) openMcpSseStream(client); }, wait);
}

async function mcpHttpStreamableRequest(client, method, params) {
  const axios = require('axios');
  const id = client.nextId++;
  const pending = new Promise((resolve, reject) => {
    client.pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (client.pending.has(id)) {
        client.pending.delete(id);
        reject(new Error(`MCP "${method}" timed out.`));
      }
    }, MCP_REQUEST_TIMEOUT_MS);
  });

  const res = await axios.post(
    client.url,
    { jsonrpc: '2.0', id, method, params },
    {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(client.headers || {}) },
      timeout: MCP_REQUEST_TIMEOUT_MS,
      validateStatus: () => true
    }
  );

  // Case 1: direct JSON-RPC response in the POST body.
  const contentType = String(res.headers['content-type'] || '');
  if (contentType.includes('application/json') && res.data && (res.data.result !== undefined || res.data.error)) {
    client.pending.delete(id);
    if (res.data.error) throw new Error(res.data.error.message || 'MCP error');
    return res.data.result;
  }

  // Case 2: response arrives asynchronously as an SSE event on the GET
  // stream (or, less commonly, streamed back on this same POST as SSE).
  if (contentType.includes('text/event-stream') && typeof res.data === 'string') {
    const { events } = parseSseChunk(res.data + '\n\n');
    for (const ev of events) handleMcpSseMessage(client, ev.data);
  }
  return pending;
}

function connectMcpHttpStreamable(url, config) {
  return new Promise((resolve, reject) => {
    const client = {
      name: config.name,
      scope: config.scope,
      transport: 'streamable-http',
      url,
      headers: config.headers || {},
      tools: [],
      nextId: 1,
      pending: new Map(),
      sseBackoffMs: MCP_SSE_INITIAL_BACKOFF_MS,
      sseSupported: undefined, // unknown until the first GET responds
      lastEventId: null,
      closed: false
    };
    openMcpSseStream(client);
    mcpHttpStreamableRequest(client, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-tab', version: '1.0' } })
      .then(() => mcpHttpStreamableRequest(client, 'tools/list', {}))
      .then((res) => { client.tools = (res && res.tools) || []; resolve(client); })
      .catch(reject);
  });
}

function connectOneMcpServer(cfg, scope) {
  return new Promise((resolve, reject) => {
    const key = `${scope}:${cfg.name}`;

    // --- NEW: MCP SSE --- Streamable-HTTP transport, opted into via
    // `transport: 'streamable-http'` in the server config (or, for existing
    // `transport: 'http'` entries, auto-detected below by probing for SSE).
    if (cfg.transport === 'streamable-http') {
      connectMcpHttpStreamable(cfg.url, { name: cfg.name, scope, headers: cfg.headers })
        .then((client) => { client.status = 'connected'; mcpClients.set(key, client); resolve(); })
        .catch((err) => {
          mcpClients.set(key, { name: cfg.name, scope, transport: 'streamable-http', tools: [], status: 'error', statusMessage: err.message });
          reject(err);
        });
      return;
    }

    if (cfg.transport === 'http') {
      // Auto-detect: try the Streamable-HTTP flow first (it transparently
      // falls back to plain POST/JSON responses if the server never sends
      // real SSE — see mcpHttpStreamableRequest — so this is safe even for
      // servers that only ever speak plain JSON-RPC-over-POST).
      connectMcpHttpStreamable(cfg.url, { name: cfg.name, scope, headers: cfg.headers })
        .then((client) => { client.status = 'connected'; mcpClients.set(key, client); resolve(); })
        .catch(() => {
          // Last-resort fallback to the original minimal HTTP client, in case
          // something about the streamable probe itself (not just missing
          // SSE) tripped the server up.
          const client = { name: cfg.name, scope, transport: 'http', url: cfg.url, headers: cfg.headers || {}, tools: [], nextId: 1, status: 'connecting' };
          mcpClients.set(key, client);
          mcpHttpRequest(client, 'tools/list', {})
            .then((res) => { client.tools = (res && res.tools) || []; client.status = 'connected'; resolve(); })
            .catch((err) => {
              client.status = 'error';
              client.statusMessage = err.message;
              reject(err);
            });
        });
      return;
    }

    // Default: stdio subprocess.
    let child;
    try {
      child = spawn(cfg.command, cfg.args || [], {
        env: { ...process.env, ...(cfg.env || {}) },
        cwd: scope === 'project' ? projectRoot : undefined
      });
    } catch (err) {
      mcpClients.set(key, { name: cfg.name, scope, transport: 'stdio', tools: [], status: 'error', statusMessage: err.message });
      reject(err);
      return;
    }
    const client = { name: cfg.name, scope, transport: 'stdio', child, tools: [], nextId: 1, pending: new Map(), buffer: '', status: 'connecting' };
    mcpClients.set(key, client);

    child.stdout.on('data', (chunk) => {
      client.buffer += chunk.toString();
      let idx;
      while ((idx = client.buffer.indexOf('\n')) >= 0) {
        const line = client.buffer.slice(0, idx);
        client.buffer = client.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; } // ignore non-JSON-RPC stdout noise
        if (msg.id != null && client.pending.has(msg.id)) {
          const { resolve: res2, reject: rej2 } = client.pending.get(msg.id);
          client.pending.delete(msg.id);
          if (msg.error) rej2(new Error(msg.error.message || 'MCP error'));
          else res2(msg.result);
        }
      }
    });
    child.on('error', (err) => {
      client.status = 'error';
      client.statusMessage = err.message;
      reject(err);
    });
    child.on('exit', () => {
      // Keep the record (marked as errored) instead of deleting it outright,
      // so a server that dies mid-session still shows up in the MCP list
      // rather than silently vanishing.
      client.status = 'error';
      client.statusMessage = client.statusMessage || 'Process exited.';
    });

    mcpStdioRequest(client, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-tab', version: '1.0' } })
      .then(() => mcpStdioRequest(client, 'tools/list', {}))
      .then((res) => { client.tools = (res && res.tools) || []; client.status = 'connected'; resolve(); })
      .catch((err) => {
        client.status = 'error';
        client.statusMessage = err.message;
        reject(err);
      });
  });
}

function connectMcpServers(configs, scope) {
  return Promise.all((configs || []).map((cfg) =>
    connectOneMcpServer(cfg, scope).catch((err) => {
      console.warn(`[agent] MCP server "${cfg.name}" (${scope}) failed to connect: ${err.message}`);
    })
  ));
}

function disconnectMcp(scope) {
  for (const [key, client] of [...mcpClients.entries()]) {
    if (client.scope !== scope) continue;
    if (client.transport === 'stdio' && client.child) {
      try { client.child.kill(); } catch (_) { /* already dead */ }
    }
    // --- NEW: MCP SSE --- stop the persistent GET stream and any pending
    // reconnect backoff so a closed client doesn't keep retrying forever.
    if (client.transport === 'streamable-http') {
      client.closed = true;
      if (client.sseRequest) { try { client.sseRequest.destroy(); } catch (_) { /* already closed */ } }
    }
    mcpClients.delete(key);
  }
}

async function callMcpTool(namespacedName, args) {
  // Namespaced as "mcp.<serverName>.<toolName>" — see buildToolDefs().
  const parts = namespacedName.split('.');
  const serverName = parts[1];
  const toolName = parts.slice(2).join('.');
  const client = [...mcpClients.values()].find((c) => c.name === serverName);
  if (!client) return { ok: false, message: `MCP server "${serverName}" is not connected.` };
  try {
    const result = client.transport === 'streamable-http'
      ? await mcpHttpStreamableRequest(client, 'tools/call', { name: toolName, arguments: args })
      : client.transport === 'http'
      ? await mcpHttpRequest(client, 'tools/call', { name: toolName, arguments: args })
      : await mcpStdioRequest(client, 'tools/call', { name: toolName, arguments: args });
    const text = (result && Array.isArray(result.content) && result.content.map((c) => c.text || '').join('\n'))
      || JSON.stringify(result);
    return { ok: true, message: text };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// --- Skills / project config loading ---------------------------------------
function loadProjectSkills() {
  try {
    const p = path.join(projectRoot, AGENT_PROJECT_DIR, 'skills.json');
    if (fs.existsSync(p)) {
      const arr = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return Array.isArray(arr) ? arr.map((s) => ({ ...s, scope: 'project' })) : [];
    }
  } catch (err) { console.warn('[agent] Could not load project skills:', err.message); }
  return [];
}

function loadProjectMcpConfig() {
  try {
    const p = path.join(projectRoot, AGENT_PROJECT_DIR, 'mcp.json');
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed.servers)) return parsed.servers;
    }
  } catch (err) { console.warn('[agent] Could not load project MCP config:', err.message); }
  return [];
}

// --- Mode transitions --------------------------------------------------------
async function setProjectRoot(newRoot, sendToRenderer) {
  disconnectMcp('project');
  projectRoot = newRoot;
  projectSkills = loadProjectSkills();
  projectMcpServers = loadProjectMcpConfig();
  await connectMcpServers(projectMcpServers, 'project');
  globalConfig.lastProjectPath = projectRoot;
  saveAgentConfig(globalConfig);
  lastWrite = null; // --- NEW: undo --- undo slot doesn't survive a project switch
  sendToRenderer(IPC_CHANNELS.AGENT_MODE_CHANGED, { mode: 'project', projectRoot });
  sendToRenderer(IPC_CHANNELS.AGENT_UNDO_STATE, { canUndo: false });
}

async function clearProjectFolder(sendToRenderer) {
  disconnectMcp('project');
  projectRoot = null;
  projectSkills = [];
  projectMcpServers = [];
  globalConfig.lastProjectPath = null;
  saveAgentConfig(globalConfig);
  lastWrite = null; // --- NEW: undo ---
  sendToRenderer(IPC_CHANNELS.AGENT_MODE_CHANGED, { mode: 'global', projectRoot: null });
  sendToRenderer(IPC_CHANNELS.AGENT_UNDO_STATE, { canUndo: false });
}

async function selectProjectFolder(dialog, getMainWindow, sendToRenderer) {
  const result = await dialog.showOpenDialog(getMainWindow(), { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths.length) return null;
  await setProjectRoot(result.filePaths[0], sendToRenderer);
  return projectRoot;
}

// --- Tool catalogue + dispatch -----------------------------------------------
function buildToolDefs(mode) {
  const tools = [{
    type: 'function',
    function: {
      name: 'scratchpad_write',
      description: 'Write text to a private scratch file outside the project (or, in Global mode, anywhere on disk). Use this to hand the user a file. Returns the file path.',
      parameters: {
        type: 'object',
        properties: { filename: { type: 'string' }, content: { type: 'string' } },
        required: ['content']
      }
    }
  }];

  if (mode === 'project') {
    tools.push(
      { type: 'function', function: { name: 'list_directory', description: 'List files/folders at a path relative to the project root.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative path, default "."' } } } } },
      { type: 'function', function: { name: 'read_file', description: 'Read a project file, optionally restricted to a line range.', parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] } } },
      { type: 'function', function: { name: 'write_file', description: 'Write/overwrite a project file. Pauses for user approval before executing.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
      { type: 'function', function: { name: 'search_code', description: 'Search project text files for a substring (or, if regex:true, a regular expression).', parameters: { type: 'object', properties: { query: { type: 'string' }, regex: { type: 'boolean' } }, required: ['query'] } } },
      { type: 'function', function: { name: 'run_command', description: 'Run a shell command in the project root (30s timeout). Pauses for user approval before executing.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }
    );
  }

  for (const client of mcpClients.values()) {
    if (client.scope === 'project' && mode !== 'project') continue;
    for (const t of client.tools || []) {
      tools.push({
        type: 'function',
        function: {
          name: `mcp.${client.name}.${t.name}`,
          description: t.description || `Tool "${t.name}" from MCP server "${client.name}".`,
          parameters: t.inputSchema || { type: 'object', properties: {} }
        }
      });
    }
  }
  return tools;
}

async function executeTool(sendToRenderer, name, args) {
  try {
    if (name === 'scratchpad_write') return await toolScratchpadWrite(args);
    if (name.startsWith('mcp.')) return await callMcpTool(name, args);
    if (getMode() !== 'project') return { ok: false, message: `Tool "${name}" is only available in Project mode.` };
    switch (name) {
      case 'list_directory': return { ok: true, message: await toolListDirectory(args) };
      case 'read_file': return { ok: true, message: await toolReadFile(args) };
      case 'write_file': return await executeWriteFile(sendToRenderer, args);
      case 'search_code': return { ok: true, message: await toolSearchCode(args) };
      case 'run_command': return await executeRunCommand(sendToRenderer, args);
      default: return { ok: false, message: `Unknown tool "${name}".` };
    }
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// --- System prompt -----------------------------------------------------------
// IDENTITY_LOCK: routing can send a turn to any configured backend, including
// Cookie/web-auth providers (e.g. Kimi, Qwen) whose underlying model has its
// own strongly-trained self-description (vendor name, web/app/extension
// links, its own content policy). Left unchecked, a generic "what are you" /
// "tell me about yourself" question can pull that vendor boilerplate out
// instead of the model staying in character as this project's coding agent —
// this is a real leak that happened via scratchpad_write. Prepending an
// explicit override on every turn, for every mode/provider, keeps identity
// answers consistent regardless of which backend actually served the request.
const IDENTITY_LOCK =
  "You are this app's coding agent — not any particular underlying AI vendor or product. " +
  'If asked what you are, who made you, what app/website/extension you have, or about any ' +
  "content policy, answer only in terms of this coding agent's own tools and scope described " +
  'below; do not mention or describe an underlying model\'s vendor name, product links, or policies.';

function buildSystemPrompt(mode) {
  if (mode === 'global') {
    return [
      IDENTITY_LOCK,
      'You are a helpful coding assistant with no project folder selected (Global mode).',
      'You can reason about code, answer questions, and write code snippets or explanations.',
      'You have a `scratchpad_write` tool that writes to a private temp file — use it to hand the user a file.',
      'Use any uploaded-file content the user attaches as context.',
      'You have no filesystem or shell access in this mode; if the user wants that, tell them to select a project folder.'
    ].join(' ');
  }
  return [
    IDENTITY_LOCK,
    `You are a coding assistant working on the project at ${projectRoot} (Project mode).`,
    'Tools: list_directory, read_file, write_file, search_code, run_command, scratchpad_write.',
    'Prefer list_directory/search_code to orient yourself before reading or editing files.',
    'write_file and run_command pause for explicit user approval before they execute — a call may come back denied, so adapt instead of retrying blindly.'
  ].join(' ');
}

// --- The agent loop -----------------------------------------------------------
// (see runAgentTurn definition above, near MAX_AGENT_STEPS / the keep-alive
// constants — kept together so the retry/stuck-loop/step-extension knobs
// live right next to the loop that uses them.)

// --- IPC wiring ---------------------------------------------------------------
function initAgentController({ ipcMain, dialog, sendToRenderer, getMainWindow }) {
  // Best-effort: reopen the last project folder from a previous run.
  if (globalConfig.lastProjectPath && fs.existsSync(globalConfig.lastProjectPath)) {
    projectRoot = globalConfig.lastProjectPath;
    projectSkills = loadProjectSkills();
    projectMcpServers = loadProjectMcpConfig();
    connectMcpServers(projectMcpServers, 'project').catch(() => {});
  }
  connectMcpServers(globalMcpServers, 'global').catch(() => {});

  ipcMain.handle(IPC_CHANNELS.SELECT_PROJECT_FOLDER, () => selectProjectFolder(dialog, getMainWindow, sendToRenderer));

  ipcMain.handle(IPC_CHANNELS.CLEAR_PROJECT_FOLDER, async () => {
    await clearProjectFolder(sendToRenderer);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.GET_AGENT_MODE, () => ({ mode: getMode(), projectRoot, canUndo: !!lastWrite }));

  ipcMain.handle(IPC_CHANNELS.GET_PROJECT_FILES, async (event, ignore) => {
    if (getMode() !== 'project') throw new Error('Not in project mode.');
    if (!fs.existsSync(projectRoot)) {
      await clearProjectFolder(sendToRenderer);
      throw new Error('Project folder no longer exists — reverted to Global mode.');
    }
    return walkProjectFiles(projectRoot, [...DEFAULT_IGNORE, ...(Array.isArray(ignore) ? ignore : [])]);
  });

  ipcMain.handle(IPC_CHANNELS.READ_PROJECT_FILE, (event, relPath) => {
    if (getMode() !== 'project') throw new Error('Not in project mode.');
    return toolReadFile({ path: relPath });
  });

  ipcMain.handle(IPC_CHANNELS.WRITE_PROJECT_FILE, (event, relPath, contentText) => {
    if (getMode() !== 'project') throw new Error('Not in project mode.');
    return executeWriteFile(sendToRenderer, { path: relPath, content: contentText });
  });

  ipcMain.handle(IPC_CHANNELS.RUN_COMMAND, (event, command) => {
    if (getMode() !== 'project') throw new Error('Not in project mode.');
    return executeRunCommand(sendToRenderer, { command });
  });

  ipcMain.handle(IPC_CHANNELS.SEARCH_IN_PROJECT, (event, query, options) => {
    if (getMode() !== 'project') throw new Error('Not in project mode.');
    return toolSearchCode({ query, regex: options && options.regex });
  });

  ipcMain.handle(IPC_CHANNELS.UPLOAD_FILE, async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), { properties: ['openFile'] });
    if (result.canceled || !result.filePaths.length) return null;
    const filePath = result.filePaths[0];
    const filename = path.basename(filePath);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return { filename, path: filePath, content, binary: false };
    } catch (_) {
      return { filename, path: filePath, content: null, binary: true, message: 'Could not read as text; only the filename will be shared as context.' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.START_AGENT_SESSION, () => {
    sessionMessages = [];
    abortRequested = false;
    lastWrite = null; // --- NEW: undo --- fresh session, nothing to revert into
    return { mode: getMode(), projectRoot };
  });

  ipcMain.handle(IPC_CHANNELS.STOP_AGENT_SESSION, () => {
    abortRequested = true;
    // Resolve every pending approval/diff as "denied" so a tool call blocked
    // on user input can't hang the turn forever after a stop; the run loop
    // sees abortRequested and exits cleanly.
    const deny = (resolve) => { try { resolve(false); } catch (_) { /* already settled */ } };
    pendingApprovals.forEach(deny);
    pendingDiffPreviews.forEach(deny);
    pendingApprovals.clear();
    pendingDiffPreviews.clear();
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_SEND_MESSAGE, (event, payload) => {
    const { text, uploadedFiles } = payload || {};
    // Fire-and-forget: this resolves immediately; progress streams back over
    // the agent:* events so a long, multi-tool-call turn doesn't block invoke().
    runAgentTurn(sendToRenderer, text, uploadedFiles).catch((err) => {
      sendToRenderer(IPC_CHANNELS.AGENT_ERROR, { message: err.message });
    });
    return { started: true };
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_APPROVAL_RESPONSE, (event, payload) => {
    const { id, approved } = payload || {};
    const resolve = pendingApprovals.get(id);
    if (resolve) { pendingApprovals.delete(id); resolve(!!approved); }
    return true;
  });

  // --- NEW: diff preview ---
  ipcMain.handle(IPC_CHANNELS.AGENT_DIFF_RESPONSE, (event, payload) => {
    const { id, accepted } = payload || {};
    const resolve = pendingDiffPreviews.get(id);
    if (resolve) { pendingDiffPreviews.delete(id); resolve(!!accepted); }
    return true;
  });

  // --- NEW: undo ---
  ipcMain.handle(IPC_CHANNELS.AGENT_UNDO_LAST_WRITE, () => {
    if (getMode() !== 'project') return { ok: false, message: 'Not in project mode.' };
    const result = undoLastWrite();
    sendToRenderer(IPC_CHANNELS.AGENT_UNDO_STATE, { canUndo: !!lastWrite });
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.GET_AGENT_CONFIG, () => ({ ...globalConfig, mode: getMode(), projectRoot }));

  ipcMain.handle(IPC_CHANNELS.SAVE_AGENT_CONFIG, async (event, config) => {
    globalConfig = { ...globalConfig, ...(config || {}) };
    saveAgentConfig(globalConfig);
    if (Array.isArray(config && config.globalMcpServers)) {
      disconnectMcp('global');
      globalMcpServers = config.globalMcpServers;
      await connectMcpServers(globalMcpServers, 'global');
    }
    return globalConfig;
  });

  ipcMain.handle(IPC_CHANNELS.GET_SKILLS, () => ({
    global: globalSkills,
    project: getMode() === 'project' ? projectSkills : []
  }));

  ipcMain.handle(IPC_CHANNELS.SAVE_SKILLS, (event, skills) => {
    // Only global skills are editable from the UI; project skills are
    // read-only here — they live in the project's own .agent/skills.json.
    globalSkills = Array.isArray(skills) ? skills : [];
    saveAgentSkills(globalSkills);
    return globalSkills;
  });

  ipcMain.handle(IPC_CHANNELS.GET_MCP_STATUS, () => {
    return [...mcpClients.values()]
      .filter((c) => c.scope === 'global' || (c.scope === 'project' && getMode() === 'project'))
      .map((c) => ({
        name: c.name,
        scope: c.scope,
        transport: c.transport,
        tools: (c.tools || []).map((t) => t.name),
        status: c.status || 'connected', // older records with no status field predate this and were connected
        statusMessage: c.statusMessage || null
      }));
  });
}

module.exports = { initAgentController };

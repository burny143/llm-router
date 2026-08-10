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
const { IPC_CHANNELS } = require('./shared-constants');
const {
  loadAgentConfig,
  saveAgentConfig,
  loadAgentChats,
  saveAgentChats
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
let abortRequested = false;
let running = false;

let globalConfig = loadAgentConfig();

// Fallback token estimator (used before proxy-server is required). Uses the same
// ~4 chars/token heuristic that proxy-server.js uses for providers without
// real usage reporting.
function estimateTokensFromTextFallback(text) {
  if (!text) return 0;
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  if (!str) return 0;
  return Math.max(1, Math.ceil(str.length / 4));
}

// --- Per-project cached chat sessions --------------------------------------
// Each key is either 'global' or an absolute project path; value is
// { messages: [] (OpenAI-format history), updatedAt: number }. Cached across
// project switches (and across app restarts, via loadAgentChats/saveAgentChats)
// so switching projects doesn't wipe/confuse the agent's history.
const chatSessions = new Map();
let activeSessionKey = 'global';
const MAX_SESSION_MESSAGES = 200;

try {
  const savedChats = loadAgentChats();
  if (savedChats && typeof savedChats === 'object') {
    for (const [key, sess] of Object.entries(savedChats)) {
      if (sess && Array.isArray(sess.messages)) {
        chatSessions.set(key, { messages: sess.messages, updatedAt: sess.updatedAt || Date.now() });
      }
    }
  }
} catch (_) { /* best-effort */ }

function sessionKeyFor(root) { return root || 'global'; }

function getSession(key) {
  if (!chatSessions.has(key)) chatSessions.set(key, { messages: [], updatedAt: Date.now() });
  return chatSessions.get(key);
}

function getActiveMessages() { return getSession(activeSessionKey).messages; }

function setActiveMessages(arr) {
  const sess = getSession(activeSessionKey);
  sess.messages = arr;
  sess.updatedAt = Date.now();
}

// Trim a session down to the most recent MAX_SESSION_MESSAGES entries without
// ever starting the kept slice on a lone 'tool' message (which would orphan a
// tool_call/tool_result pair and confuse the model on the next turn).
function trimSession(key) {
  const sess = getSession(key);
  if (sess.messages.length <= MAX_SESSION_MESSAGES) return;
  let cut = sess.messages.length - MAX_SESSION_MESSAGES;
  while (cut < sess.messages.length && sess.messages[cut].role === 'tool') cut++;
  sess.messages = sess.messages.slice(cut);
}

function persistChats() {
  const obj = {};
  for (const [key, sess] of chatSessions.entries()) obj[key] = sess;
  saveAgentChats(obj);
}

const pendingApprovals = new Map();  // id -> resolve(approved: boolean)

// --- NEW: diff preview --- pending diff-preview round-trips, keyed the same
// way as pendingApprovals but resolving to a boolean accept/reject.
const pendingDiffPreviews = new Map(); // id -> resolve(accepted: boolean)

// --- NEW: undo --- single-slot "last write" record so the user can revert
// the most recent file write. Cleared on undo, on mode change, and at the
// start of a new agent session (matches the "one-step revert" spec).
let lastWrite = null; // { path, existed, previousContent, sessionMessagesIndex }

const AGENT_TMP_DIR = path.join(os.tmpdir(), 'agent-scratchpad');
try { fs.mkdirSync(AGENT_TMP_DIR, { recursive: true }); } catch (_) { /* best-effort */ }

const DEFAULT_IGNORE = ['node_modules', '.git', '.agent', 'dist', 'build', '.next', '.venv', '__pycache__'];
const MAX_FILE_LIST = 5000;
const MAX_READ_BYTES = 300 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_MATCHES = 200;
const COMMAND_TIMEOUT_MS = 30000;
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
    getActiveMessages().push({ role: 'user', content });

    const mode = getMode();
    const tools = buildToolDefs(mode);
    // --- NEW: task-progress panel --- let the renderer mirror this turn's
    // available tools in the Task Progress sidebar. Cheap (a handful of names)
    // and keeps the panel accurate even on tool-call-only turns.
    sendToRenderer(IPC_CHANNELS.AGENT_TOOL_LIST, { tools: tools.map((t) => t.function.name) });
    const messagesForModel = [{ role: 'system', content: buildSystemPrompt(mode) }, ...getActiveMessages()];

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
          // --- Agent-side input token cap --- reject the model call before
          // forwarding if the conversation exceeds the agent's configured
          // context limit. Uses the proxy's token estimator (cheap heuristic).
          const maxInputTokens = globalConfig.agentMaxInputTokens > 0 ? globalConfig.agentMaxInputTokens : 0;
          if (maxInputTokens > 0) {
            const estimateTokensFromText = proxy().estimateTokensFromText || estimateTokensFromTextFallback;
            const estimated = estimateTokensFromText(JSON.stringify(messagesForModel));
            if (estimated > maxInputTokens) {
              throw new Error(`Agent context limit exceeded (~${estimated} tokens > ${maxInputTokens}). Trim history or increase the limit.`);
            }
          }
          // Build per-call options: forward max_tokens cap (if set) and let the
          // proxy apply its own timeout (agent doesn't override proxy timeoutMs;
          // the proxy uses its own assistantConfig.timeoutMs).
          const agentOpts = { tools };
          const maxOutputTokens = globalConfig.agentMaxOutputTokens > 0 ? globalConfig.agentMaxOutputTokens : 0;
          if (maxOutputTokens > 0) agentOpts.max_tokens = maxOutputTokens;
          if (streamingEnabled) {
            sendToRenderer(IPC_CHANNELS.AGENT_STREAM_START, {});
            let fullText = '';
            const streamResult = await proxy().processChatCompletionStream(messagesForModel, agentOpts, (token) => {
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
             const response = await proxy().processChatCompletion(messagesForModel, agentOpts);
            message = (response && response.choices && response.choices[0] && response.choices[0].message) || {};
            if (message.content) {
              // Fallback path when streaming is off: whole message in one chunk.
              sendToRenderer(IPC_CHANNELS.AGENT_STREAM_CHUNK, { text: message.content });
            }
            // --- NEW: task-progress panel --- emit real usage when the backend
            // attached it to the response (non-streaming path only; the
            // streaming simulator doesn't surface usage today).
            if (response && response.usage) sendToRenderer(IPC_CHANNELS.AGENT_TOKEN_USAGE, { usage: response.usage });
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
      getActiveMessages().push(message);

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
          getActiveMessages().push(nudge);
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
        getActiveMessages().push(toolMsg);
      }

      // If the loop above broke early due to an abort, every tool_call in this
      // assistant message that never got a matching 'tool' response must still
      // get one. The OpenAI-style API requires exactly one tool message per
      // tool_call id — leaving any unanswered would corrupt this session's
      // persisted history and break every future turn (the model call would be
      // rejected as malformed). Backfill a synthetic "aborted" result for each
      // tool_call id we haven't already answered.
      if (abortRequested) {
        const answeredIds = new Set(
          getActiveMessages()
            .filter((m) => m.role === 'tool')
            .map((m) => m.tool_call_id)
        );
        for (const call of toolCalls) {
          if (answeredIds.has(call.id)) continue;
          const abortedMsg = {
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ ok: false, message: 'Aborted by user before this tool call executed.' })
          };
          messagesForModel.push(abortedMsg);
          getActiveMessages().push(abortedMsg);
        }
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
    // Cache this turn's history so switching projects (or restarting the
    // app) doesn't lose it / confuse the agent with a blank slate.
    trimSession(activeSessionKey);
    persistChats();
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
  return out.sort();
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
  // the active session's message count here (before this tool's result
  // message is pushed) lets undoLastWrite() truncate the conversation back
  // to just before this write's tool_call/result pair.
  lastWrite = {
    path: args.path,
    existed,
    previousContent,
    sessionMessagesIndexBeforeCall: getActiveMessages().length
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
    setActiveMessages(getActiveMessages().slice(0, sessionMessagesIndexBeforeCall));
  }
  const undone = lastWrite;
  lastWrite = null;
  persistChats();
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

// --- Mode transitions --------------------------------------------------------
// Switching projectRoot switches the ACTIVE chat session (each project keeps
// its own cached history — see chatSessions above); it never wipes messages.
async function setProjectRoot(newRoot, sendToRenderer) {
  projectRoot = newRoot;
  globalConfig.lastProjectPath = projectRoot;
  saveAgentConfig(globalConfig);
  lastWrite = null; // --- NEW: undo --- undo slot doesn't survive a project switch
  activeSessionKey = sessionKeyFor(projectRoot);
  getSession(activeSessionKey); // ensure it exists (so it shows up immediately as a chat tab)
  sendToRenderer(IPC_CHANNELS.AGENT_MODE_CHANGED, { mode: 'project', projectRoot });
  sendToRenderer(IPC_CHANNELS.AGENT_UNDO_STATE, { canUndo: false });
}

async function clearProjectFolder(sendToRenderer) {
  // The key for the project we're leaving — captured BEFORE projectRoot is
  // nulled below, so we know which cached session to actually remove.
  const leavingKey = sessionKeyFor(projectRoot);

  projectRoot = null;
  globalConfig.lastProjectPath = null;
  saveAgentConfig(globalConfig);
  lastWrite = null; // --- NEW: undo ---
  activeSessionKey = sessionKeyFor(null);

  // Previously this only switched the active session back to 'global' —
  // the project's cached chat session (and its tab in the strip) stuck
  // around untouched, so the button looked like it just changed tabs
  // instead of actually turning the project off. Deleting its session here
  // (Global's session is never eligible — sessionKeyFor(null) === 'global')
  // makes this button do what its "Return to Global mode" title promises:
  // the project's tab disappears and its cached history with it.
  if (leavingKey !== 'global' && chatSessions.has(leavingKey)) {
    chatSessions.delete(leavingKey);
    persistChats();
  }

  sendToRenderer(IPC_CHANNELS.AGENT_MODE_CHANGED, { mode: 'global', projectRoot: null });
  sendToRenderer(IPC_CHANNELS.AGENT_UNDO_STATE, { canUndo: false });
}

async function selectProjectFolder(dialog, getMainWindow, sendToRenderer) {
  const result = await dialog.showOpenDialog(getMainWindow(), { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths.length) return null;
  await setProjectRoot(result.filePaths[0], sendToRenderer);
  return { projectRoot, messages: getActiveMessages() };
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
  return tools;
}

async function executeTool(sendToRenderer, name, args) {
  try {
    if (name === 'scratchpad_write') return await toolScratchpadWrite(args);
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
  }
  activeSessionKey = sessionKeyFor(projectRoot);
  getSession('global');
  getSession(activeSessionKey);

  ipcMain.handle(IPC_CHANNELS.SELECT_PROJECT_FOLDER, () => selectProjectFolder(dialog, getMainWindow, sendToRenderer));

  ipcMain.handle(IPC_CHANNELS.CLEAR_PROJECT_FOLDER, async () => {
    await clearProjectFolder(sendToRenderer);
    return { projectRoot: null, messages: getActiveMessages() };
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
    // NOTE: no longer wipes history — each project (+ Global) keeps its own
    // cached chatSessions entry, so re-opening the app / re-selecting a
    // project restores prior context instead of starting from a blank slate.
    abortRequested = false;
    return { mode: getMode(), projectRoot, messages: getActiveMessages() };
  });

  ipcMain.handle(IPC_CHANNELS.STOP_AGENT_SESSION, () => {
    abortRequested = true;
    // Force-resolve any in-flight approval/diff-preview prompts as "denied" so
    // a turn paused waiting on the user (e.g. awaiting write_file/run_command
    // approval) doesn't hang forever — without this, requestApproval()'s
    // Promise never settles, runAgentTurn()'s finally block never runs, and
    // `running` stays true forever, permanently blocking every future turn.
    for (const resolve of pendingApprovals.values()) resolve(false);
    pendingApprovals.clear();
    for (const resolve of pendingDiffPreviews.values()) resolve(false);
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

  // --- NEW: per-project cached chat sessions ---
  ipcMain.handle(IPC_CHANNELS.AGENT_GET_CHAT_SESSIONS, () => {
    return Array.from(chatSessions.entries())
      .map(([key, sess]) => ({
        key,
        label: key === 'global' ? 'Global' : (path.basename(key) || key),
        messageCount: sess.messages.length,
        updatedAt: sess.updatedAt || 0
      }))
      // Global always first; the rest most-recently-active first.
      .sort((a, b) => {
        if (a.key === 'global') return -1;
        if (b.key === 'global') return 1;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_SWITCH_CHAT, (event, key) => {
    if (!key || key === 'global') {
      projectRoot = null;
    } else if (fs.existsSync(key)) {
      projectRoot = key;
      globalConfig.lastProjectPath = key;
      saveAgentConfig(globalConfig);
    } else {
      // The project this chat belonged to no longer exists on disk — fall
      // back to Global rather than switching into a dead project root.
      projectRoot = null;
    }
    activeSessionKey = sessionKeyFor(projectRoot);
    getSession(activeSessionKey);
    lastWrite = null;
    sendToRenderer(IPC_CHANNELS.AGENT_MODE_CHANGED, { mode: getMode(), projectRoot });
    sendToRenderer(IPC_CHANNELS.AGENT_UNDO_STATE, { canUndo: false });
    return { mode: getMode(), projectRoot, messages: getActiveMessages() };
  });

  // --- NEW: per-tab clear cache/history ---
  // Empties one chat session's message history in place. Unlike
  // clearProjectFolder (which removes the whole session/tab and returns to
  // Global mode), this keeps the tab itself — it's a "start fresh in this
  // project/Global chat" action, callable from any tab without switching
  // into it first.
  ipcMain.handle(IPC_CHANNELS.AGENT_CLEAR_CHAT, (event, key) => {
    const sessionKey = sessionKeyFor(key);
    const sess = getSession(sessionKey);
    sess.messages = [];
    sess.updatedAt = Date.now();
    const isActive = sessionKey === activeSessionKey;
    if (isActive) {
      lastWrite = null;
      sendToRenderer(IPC_CHANNELS.AGENT_UNDO_STATE, { canUndo: false });
    }
    persistChats();
    return { key: sessionKey, isActive, messages: sess.messages };
  });

  ipcMain.handle(IPC_CHANNELS.SAVE_AGENT_CONFIG, async (event, config) => {
    globalConfig = { ...globalConfig, ...(config || {}) };
    // --- NEW: streaming support --- strip out any transient/renamed keys we
    // don't own (e.g. legacy globalMcpServers) so they can't sneak back in
    // and confuse the renderer. Always re-derive from DEFAULT_AGENT_CONFIG
    // shape — no MCP reconnect, there's nothing to reconnect anymore.
     const { lastProjectPath, selectedModel, streamResponses, alwaysApproveWrites, agentTimeoutMs, agentMaxOutputTokens, agentMaxInputTokens } = globalConfig;
     globalConfig = { lastProjectPath, selectedModel, streamResponses, alwaysApproveWrites, agentTimeoutMs, agentMaxOutputTokens, agentMaxInputTokens };
    saveAgentConfig(globalConfig);
    return globalConfig;
  });
}

module.exports = { initAgentController };

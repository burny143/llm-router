// shared-constants.js
// Central registry of IPC channel names used between main.js / preload.js / renderer.js.
// Marker substring used to flag a "success" line in the Developer Logs panel.
// proxy-server.js's request-success log line and renderer.js's log-line
// coloring both reference this constant instead of each duplicating the
// literal 'OK (' string, so a wording change in one can't silently break
// coloring in the other.
// Single shared fake User-Agent string used anywhere the app needs to look
// like a real desktop Chrome browser (Playwright cookie-capture flows and
// Cookie-auth proxy requests to web chat providers like Kimi/Qwen). Having
// one constant instead of several hand-copied literals means the Chrome
// version can't silently drift out of sync between call sites.
const DEFAULT_COOKIE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const LOG_MARKERS = {
  SUCCESS: 'OK (',
  // Emitted by large-context-dispatcher.js for chunk/lane progress so the
  // existing Developer Logs console feed shows dispatcher activity without
  // needing a dedicated IPC channel.
  DISPATCH: '[LCD]'
};

// Canonical provider name for Qwen. NOTE: the only consumer, setup-qwen-cookie.js,
// has been archived to /archive (superseded by the generalized
// setup-web-provider.js, which is what RUN_WEB_PROVIDER_SETUP actually wires
// up). This export is retained only so the archived script still works if
// pulled back out of /archive — nothing in the live app imports it.
const QWEN_PROVIDER_NAME = 'Qwen';

// Data-file role keys passed to state-store.getFilePath(). Centralized here so
// the fetch-models / browser-http-client / setup-qwen-cookie scripts all agree
// on the same registry keys (and so a rename is a one-line change, not a
// search-and-replace across every module that touches data files).
const FILE_ROLES = {
  PROVIDER_CONFIG: 'providerConfig',
  ENV: 'env',
  WEB_PROVIDER_RULES: 'webProviderRules',
  LATEST_MODELS: 'latestModels',
  MODELS: 'models',
  PROVIDER_FLAGS: 'providerFlags'
};

// Browser in-page fetch timeouts (browser-http-client.js).
// BROWSER_FETCH_TIMEOUT_MS is the inner AbortController timeout INSIDE the
// page.evaluate fetch (kills the fetch itself). BROWSER_FETCH_HANG_GUARD_MS is
// the outer Promise.race guard in request() that only exists to catch a
// Playwright-level hang (page.evaluate never resolving). The outer guard MUST
// be meaningfully longer than the inner timeout, otherwise the two races fire
// at the same moment and the generic "timed out" error can win over the more
// specific inner one on perfectly normal requests.
const BROWSER_FETCH_TIMEOUT_MS = 60000;
const BROWSER_FETCH_HANG_GUARD_MS = 70000;

// Default minimum spacing between ping-before-demote probes fired at the
// same provider/model entry (proxy-server.js's pingEntry()). Prevents a
// burst of near-simultaneous failures for one entry from turning into a
// burst of pings against a provider that's already struggling. Configurable
// from the General Config UI (state-store.js DEFAULT_ASSISTANT_CONFIG.pingIntervalMs);
// this is only the fallback default.
const DEFAULT_PING_INTERVAL_MS = 30000;

// Default minimum spacing (ms) between successive outbound requests to any
// model, process-wide (proxy-server.js's acquireRequestSlot()). This proxy
// mainly fronts free-tier LLM endpoints that are quick to rate-limit or ban
// bursts of concurrent requests, so a small default delay keeps things slow
// and polite even when several candidates are racing in parallel. Default
// is 1 second; configurable from the General Config UI (state-store.js
// DEFAULT_ASSISTANT_CONFIG.minRequestIntervalMs) — this is only the
// fallback.
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 1000;

const IPC_CHANNELS = {
  // Proxy control
  START_PROXY: 'start-proxy',
  STOP_PROXY: 'stop-proxy',
  IS_PROXY_RUNNING: 'is-proxy-running',
  // --- NEW: INITIALIZE button ---
  // renderer->main: ensure the proxy is up before starting the agent (the
  // agent routes every model call through the local proxy). If already
  // running returns immediately; if down, starts it with the current config
  // entries + default port 8000.
  ENSURE_PROXY_RUNNING: 'ensure-proxy-running',
  GET_PROXY_STATS: 'get-proxy-stats',

  // Priority override / known-OK
  GET_KNOWN_OK: 'get-known-ok',
  SET_PRIORITY_OVERRIDE: 'set-priority-override',
  // --- NEW: priority lock / rotate + live resync ---
  GET_ROUTING_LOG: 'get-routing-log',
  GET_PRIORITY_STATE: 'get-priority-state',
  // main -> renderer: pushed any time priorityOverrideKey/lock/routingMode
  // changes for ANY reason (user action or an auto-clear on failure), so
  // every open dropdown can resync immediately instead of going stale.
  PRIORITY_STATE_CHANGED: 'priority-state-changed',

  // Config defaults / env
  GET_DEFAULT_CONFIG: 'get-default-config',
  GET_DEFAULT_FILE_NAMES: 'get-default-file-names',
  GET_ENV_VARS: 'get-env-vars',

  // Model list file (models.csv / connected file)
  GET_CONNECTED_MODEL_LIST: 'get-connected-model-list',

  // Config file (UltimateConfig.csv / ProviderConfig.csv)
  GET_CONNECTED_CONFIG: 'get-connected-config',
  GET_PROVIDER_CONFIG: 'get-provider-config',
  SAVE_CONFIG: 'save-config',
  OPEN_CONFIG_FILE_DIALOG: 'open-config-file-dialog',
  PARSE_CONFIG_CSV_FILE: 'parse-config-csv-file',
  CONFIG_READY: 'config-ready',

  // Fetch models (LatestModels.csv)
  RUN_FETCH_MODELS: 'run-fetch-models',

  // Usage / health
  GET_TOKEN_USAGE: 'get-token-usage',
  HEALTH_CHECK: 'health-check',

  // Logging
  DEV_LOG: 'dev-log',

   // Web provider setup (Qwen / Kimi / any Cookie-auth chat site)
  RUN_WEB_PROVIDER_SETUP: 'run-web-provider-setup',
  CLEAR_WEB_PROVIDER_SESSION: 'clear-web-provider-session',
  SET_PROVIDER_COOKIE: 'set-provider-cookie',
  GET_WEB_PROVIDER_PRESETS: 'get-web-provider-presets',

  // Assistant Config tab (system prompt override / tool calling / proxy features)
  GET_ASSISTANT_CONFIG: 'get-assistant-config',
  SAVE_ASSISTANT_CONFIG: 'save-assistant-config',
  PREVIEW_TOOL_FORMAT: 'preview-tool-format',

  // --- Agent tab (coding agent: Global mode / Project mode) ---
  // Project folder lifecycle
  SELECT_PROJECT_FOLDER: 'select-project-folder',
  CLEAR_PROJECT_FOLDER: 'clear-project-folder',
  GET_AGENT_MODE: 'get-agent-mode',

  // Project-aware tools, also invocable directly from the file-tree/sidebar UI
  // (they share the same guarded implementations the agent's tool_calls use)
  GET_PROJECT_FILES: 'get-project-files',
  READ_PROJECT_FILE: 'read-project-file',
  WRITE_PROJECT_FILE: 'write-project-file',
  RUN_COMMAND: 'run-command',
  SEARCH_IN_PROJECT: 'search-in-project',
  UPLOAD_FILE: 'upload-file',

  // Agent conversation lifecycle
  START_AGENT_SESSION: 'start-agent-session',
  STOP_AGENT_SESSION: 'stop-agent-session',
  AGENT_SEND_MESSAGE: 'agent-send-message',
  AGENT_APPROVAL_RESPONSE: 'agent-approval-response',

   // Agent config (global, persisted in agent-config.json)
  GET_AGENT_CONFIG: 'get-agent-config',
  SAVE_AGENT_CONFIG: 'save-agent-config',

  // --- NEW: per-project cached chat sessions ---
  // renderer -> main: list of chat sessions (Global + one per project the
  // user has visited this run/loaded from the cache file) for the chat-tab
  // strip in the Agent tab.
  AGENT_GET_CHAT_SESSIONS: 'agent:get-chat-sessions',
  // renderer -> main: switch the active chat session by key ('global' or an
  // absolute project path). Returns { mode, projectRoot, messages }.
  AGENT_SWITCH_CHAT: 'agent:switch-chat',
  // renderer -> main: clear the cached message history for one chat session
  // by key, without switching to it or removing its tab. Returns
  // { key, isActive, messages }.
  AGENT_CLEAR_CHAT: 'agent:clear-chat',

  // main -> renderer streaming/event channels (renderer subscribes via preload's onX helpers)
  AGENT_STREAM_CHUNK: 'agent:stream-chunk',
  // --- NEW: streaming support --- token-level streaming events (used when
  // agent config `streamResponses` is true; AGENT_STREAM_CHUNK above remains
  // as the turn-level fallback when streaming is off).
  AGENT_STREAM_START: 'agent:stream-start',
  AGENT_STREAM_TOKEN: 'agent:stream-token',
  AGENT_STREAM_END: 'agent:stream-end',
  AGENT_TOOL_START: 'agent:tool-start',
  AGENT_TOOL_RESULT: 'agent:tool-result',
  // --- NEW: task-progress panel ---
  // Emitted alongside the per-tool events above so the Task Progress sidebar
  // panel can mirror the agent's activity in a compact list view.
  //   AGENT_TOOL_LIST:  { tools: string[] }  — current turn's available tool names
  //   AGENT_TOKEN_USAGE: { prompt, completion, total, estimated } — per-request
  //                      token counts (cumulative within a turn)
  AGENT_TOOL_LIST: 'agent:tool-list',
  AGENT_TOKEN_USAGE: 'agent:token-usage',
  AGENT_APPROVAL_REQUEST: 'agent:approval-request',
  AGENT_DONE: 'agent:done',
  AGENT_ERROR: 'agent:error',
  AGENT_MODE_CHANGED: 'agent:mode-changed',

  // --- NEW: diff preview / undo ---
  // main -> renderer: show the diff modal for a pending write_file call
  AGENT_DIFF_PREVIEW: 'agent:diff-preview',
  // renderer -> main: user's accept/reject decision for that diff
  AGENT_DIFF_RESPONSE: 'agent:diff-response',
  // renderer -> main: revert the most recent write_file
  AGENT_UNDO_LAST_WRITE: 'agent:undo-last-write',
  // main -> renderer: whether the Undo button should be enabled
  AGENT_UNDO_STATE: 'agent:undo-state',
};

module.exports = { IPC_CHANNELS, LOG_MARKERS, DEFAULT_COOKIE_USER_AGENT, QWEN_PROVIDER_NAME, FILE_ROLES, BROWSER_FETCH_TIMEOUT_MS, BROWSER_FETCH_HANG_GUARD_MS, DEFAULT_PING_INTERVAL_MS, DEFAULT_MIN_REQUEST_INTERVAL_MS };
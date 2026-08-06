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
  // Tagged prefixes used by proxy-server.js so renderer.js can split the single
  // console -> DEV_LOG stream into the Request Logs / Response Logs sub-tabs
  // without adding a second IPC channel. Each tagged line is followed by a
  // JSON payload (see logRequestLine/logResponseLine in proxy-server.js).
  REQUEST: '[REQ]',
  RESPONSE: '[RES]',
  // Emitted by large-context-dispatcher.js for chunk/lane progress so the
  // existing Developer Logs console feed shows dispatcher activity without
  // needing a dedicated IPC channel.
  DISPATCH: '[LCD]'
};

const IPC_CHANNELS = {
  // Proxy control
  START_PROXY: 'start-proxy',
  STOP_PROXY: 'stop-proxy',
  IS_PROXY_RUNNING: 'is-proxy-running',
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
  PARSE_CONFIG_EXCEL_FILE: 'parse-config-excel-file',
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

  // Agent config / skills / MCP servers (global, persisted in agent-config.json / skills.json)
  GET_AGENT_CONFIG: 'get-agent-config',
  SAVE_AGENT_CONFIG: 'save-agent-config',
  GET_SKILLS: 'get-skills',
  SAVE_SKILLS: 'save-skills',
  GET_MCP_STATUS: 'get-mcp-status',

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

// --- NEW: auth-type + default web provider identifiers ---
// Used by setup-web-provider.js / proxy-server.js / fetch-models.js so the
// bearer-vs-cookie auth choice and provider names are single-sourced.
const AUTH_TYPE_BEARER = 'bearer';
const AUTH_TYPE_COOKIE = 'cookie';

const DEFAULT_QWEN_NAME = 'Qwen';
const DEFAULT_QWEN_URL = 'https://chat.qwen.ai';
const DEFAULT_KIMI_NAME = 'Kimi';
const DEFAULT_KIMI_URL = 'https://kimi.moonshot.cn';

// --- NEW: agent workspace directories (project-scoped) ---
// agent-controller.js resolves these relative to the selected project root so
// Global mode uses <projectRoot>/.agent/ while Project mode keeps agent state
// inside the user's repo without leaking outside it.
const AGENT_PROJECT_DIR = '.agent';
const AGENT_SCRATCHPAD_DIR = 'agent-scratchpad';
// Persisted key for the Kimi refresh token in the app's config store; the
// Kimi web client and setup-web-provider flows reference this instead of
// hand-copied string literals.
const KIMI_REFRESH_TOKEN_KEY = 'kimi_refresh_token';
// Finish reasons used across the proxy/tool-calling path; tokenizer code and
// tool-calling-translator.js compare against these instead of raw literals.
const FINISH_REASON_TOOL_CALLS = 'tool_calls';
const FINISH_REASON_STOP = 'stop';

// --- NEW: central timeout registry (ms) ---
// Every hardcoded setTimeout/setInterval delay in the codebase belongs here so
// tuning one number (e.g. reducing the client idle timeout) doesn't require
// hunting through per-file literals.
const TIMEOUTS = {
  // Periodic health/ping cadence for provider liveness checks.
  PING_MS: 8000,
  // Agent run_command execution cap.
  COMMAND_MS: 30000,
  // MCP tool request cap.
  MCP_REQUEST_MS: 15000,
  // Proxy client idle disconnect cap.
  CLIENT_IDLE_MS: 90000,
  // Kimi web-client streaming idle cap.
  KIMI_STREAM_MS: 120000,
  // Browser HTTP client request cap (fetch-models / model list refresh).
  BROWSER_FETCH_MS: 60000,
  // Chat UI non-streamed request cap.
  CHAT_UI_MS: 60000,
  // Health-check interval used by main's health ping.
  HEALTH_CHECK_MS: 15000,
  // Renderer's proxy-stats poll cadence (kept in ms; UI-only).
  POLL_STATS_MS: 3000
};

module.exports = {
  IPC_CHANNELS,
  LOG_MARKERS,
  DEFAULT_COOKIE_USER_AGENT,
  AUTH_TYPE_BEARER,
  AUTH_TYPE_COOKIE,
  DEFAULT_QWEN_NAME,
  DEFAULT_QWEN_URL,
  DEFAULT_KIMI_NAME,
  DEFAULT_KIMI_URL,
  AGENT_PROJECT_DIR,
  AGENT_SCRATCHPAD_DIR,
  KIMI_REFRESH_TOKEN_KEY,
  FINISH_REASON_TOOL_CALLS,
  FINISH_REASON_STOP,
  TIMEOUTS
};
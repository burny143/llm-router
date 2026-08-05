// shared-constants.js
// Central registry of IPC channel names used between main.js / preload.js / renderer.js.
// Marker substring used to flag a "success" line in the Developer Logs panel.
// proxy-server.js's request-success log line and renderer.js's log-line
// coloring both reference this constant instead of each duplicating the
// literal 'OK (' string, so a wording change in one can't silently break
// coloring in the other.
const LOG_MARKERS = {
  SUCCESS: 'OK ('
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
};

module.exports = { IPC_CHANNELS, LOG_MARKERS };
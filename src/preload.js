// preload.js
const { contextBridge, ipcRenderer } = require('electron');
const { IPC_CHANNELS, LOG_MARKERS } = require('./shared-constants');

contextBridge.exposeInMainWorld('api', {
  startProxy: (port, entries) => ipcRenderer.invoke(IPC_CHANNELS.START_PROXY, port, entries),
  stopProxy: () => ipcRenderer.invoke(IPC_CHANNELS.STOP_PROXY),
  isProxyRunning: () => ipcRenderer.invoke(IPC_CHANNELS.IS_PROXY_RUNNING),
  healthCheck: (entries) => ipcRenderer.invoke(IPC_CHANNELS.HEALTH_CHECK, entries),
  getDefaultConfig: () => ipcRenderer.invoke(IPC_CHANNELS.GET_DEFAULT_CONFIG),
  getDefaultFileNames: () => ipcRenderer.invoke(IPC_CHANNELS.GET_DEFAULT_FILE_NAMES),
  getEnvVars: () => ipcRenderer.invoke(IPC_CHANNELS.GET_ENV_VARS),
  getConnectedModelList: () => ipcRenderer.invoke(IPC_CHANNELS.GET_CONNECTED_MODEL_LIST),
  getConnectedConfig: () => ipcRenderer.invoke(IPC_CHANNELS.GET_CONNECTED_CONFIG),
  getProviderConfig: () => ipcRenderer.invoke(IPC_CHANNELS.GET_PROVIDER_CONFIG),
  saveConfig: (entries) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_CONFIG, entries),
  openConfigFileDialog: () => ipcRenderer.invoke(IPC_CHANNELS.OPEN_CONFIG_FILE_DIALOG),
  parseConfigCsvFile: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.PARSE_CONFIG_CSV_FILE, filePath),
  parseConfigExcelFile: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.PARSE_CONFIG_EXCEL_FILE, filePath),
  getTokenUsage: () => ipcRenderer.invoke(IPC_CHANNELS.GET_TOKEN_USAGE),
  getProxyStats: () => ipcRenderer.invoke(IPC_CHANNELS.GET_PROXY_STATS),
  runFetchModels: () => ipcRenderer.invoke(IPC_CHANNELS.RUN_FETCH_MODELS),
  getKnownOk: () => ipcRenderer.invoke(IPC_CHANNELS.GET_KNOWN_OK),
  setPriorityOverride: (key) => ipcRenderer.invoke(IPC_CHANNELS.SET_PRIORITY_OVERRIDE, key),
  runWebProviderSetup: (providerName, startUrl) => ipcRenderer.invoke(IPC_CHANNELS.RUN_WEB_PROVIDER_SETUP, providerName, startUrl),
  clearWebProviderSession: (providerName) => ipcRenderer.invoke(IPC_CHANNELS.CLEAR_WEB_PROVIDER_SESSION, providerName),
  setProviderCookie: (providerName, cookie) => ipcRenderer.invoke(IPC_CHANNELS.SET_PROVIDER_COOKIE, providerName, cookie),
  getWebProviderPresets: () => ipcRenderer.invoke(IPC_CHANNELS.GET_WEB_PROVIDER_PRESETS),
  getAssistantConfig: () => ipcRenderer.invoke(IPC_CHANNELS.GET_ASSISTANT_CONFIG),
  saveAssistantConfig: (config) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_ASSISTANT_CONFIG, config),
  previewToolFormat: () => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_TOOL_FORMAT),

  // --- Agent tab ---
  selectProjectFolder: () => ipcRenderer.invoke(IPC_CHANNELS.SELECT_PROJECT_FOLDER),
  clearProjectFolder: () => ipcRenderer.invoke(IPC_CHANNELS.CLEAR_PROJECT_FOLDER),
  getAgentMode: () => ipcRenderer.invoke(IPC_CHANNELS.GET_AGENT_MODE),
  getProjectFiles: (ignore) => ipcRenderer.invoke(IPC_CHANNELS.GET_PROJECT_FILES, ignore),
  readProjectFile: (relPath) => ipcRenderer.invoke(IPC_CHANNELS.READ_PROJECT_FILE, relPath),
  writeProjectFile: (relPath, content) => ipcRenderer.invoke(IPC_CHANNELS.WRITE_PROJECT_FILE, relPath, content),
  runCommand: (command) => ipcRenderer.invoke(IPC_CHANNELS.RUN_COMMAND, command),
  searchInProject: (query, options) => ipcRenderer.invoke(IPC_CHANNELS.SEARCH_IN_PROJECT, query, options),
  uploadFile: () => ipcRenderer.invoke(IPC_CHANNELS.UPLOAD_FILE),
  startAgentSession: () => ipcRenderer.invoke(IPC_CHANNELS.START_AGENT_SESSION),
  stopAgentSession: () => ipcRenderer.invoke(IPC_CHANNELS.STOP_AGENT_SESSION),
  agentSendMessage: (text, uploadedFiles) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_SEND_MESSAGE, { text, uploadedFiles }),
  agentApprovalResponse: (id, approved) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_APPROVAL_RESPONSE, { id, approved }),
  getAgentConfig: () => ipcRenderer.invoke(IPC_CHANNELS.GET_AGENT_CONFIG),
  saveAgentConfig: (config) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_AGENT_CONFIG, config),
  getSkills: () => ipcRenderer.invoke(IPC_CHANNELS.GET_SKILLS),
  saveSkills: (skills) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_SKILLS, skills),
  getMcpStatus: () => ipcRenderer.invoke(IPC_CHANNELS.GET_MCP_STATUS),
  onAgentStreamChunk: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.AGENT_STREAM_CHUNK, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_STREAM_CHUNK, handler);
  },
  // --- NEW: streaming support ---
  onAgentStreamStart: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.AGENT_STREAM_START, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_STREAM_START, handler);
  },
  onAgentStreamToken: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.AGENT_STREAM_TOKEN, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_STREAM_TOKEN, handler);
  },
  onAgentStreamEnd: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.AGENT_STREAM_END, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_STREAM_END, handler);
  },
  onAgentToolStart: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.AGENT_TOOL_START, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_TOOL_START, handler);
  },
  onAgentToolResult: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.AGENT_TOOL_RESULT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_TOOL_RESULT, handler);
  },
  onAgentApprovalRequest: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.AGENT_APPROVAL_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_APPROVAL_REQUEST, handler);
  },
  onAgentDone: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.AGENT_DONE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_DONE, handler);
  },
  onAgentError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.AGENT_ERROR, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_ERROR, handler);
  },
  onAgentModeChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.AGENT_MODE_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_MODE_CHANGED, handler);
  },

  // --- NEW: diff preview / undo ---
  onAgentDiffPreview: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.AGENT_DIFF_PREVIEW, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_DIFF_PREVIEW, handler);
  },
  agentDiffResponse: (id, accepted) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_DIFF_RESPONSE, { id, accepted }),
  agentUndoLastWrite: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_UNDO_LAST_WRITE),
  onAgentUndoState: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.AGENT_UNDO_STATE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_UNDO_STATE, handler);
  },

  logSuccessMarker: LOG_MARKERS.SUCCESS,
  logRequestMarker: LOG_MARKERS.REQUEST,
  logResponseMarker: LOG_MARKERS.RESPONSE,
  onDevLog: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.DEV_LOG, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DEV_LOG, handler);
  },
  onConfigReady: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.CONFIG_READY, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CONFIG_READY, handler);
  }
});
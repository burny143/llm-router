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
  logSuccessMarker: LOG_MARKERS.SUCCESS,
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
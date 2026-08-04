const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startProxy: (port, entries) => ipcRenderer.invoke('start-proxy', port, entries),
  stopProxy: () => ipcRenderer.invoke('stop-proxy'),
  isProxyRunning: () => ipcRenderer.invoke('is-proxy-running'),
  healthCheck: (entries) => ipcRenderer.invoke('health-check', entries),
  getDefaultConfig: () => ipcRenderer.invoke('get-default-config'),
  getEnvVars: () => ipcRenderer.invoke('get-env-vars'),
  getConnectedModelList: () => ipcRenderer.invoke('get-connected-model-list'),
  getConnectedConfig: () => ipcRenderer.invoke('get-connected-config'),
  getProviderConfig: () => ipcRenderer.invoke('get-provider-config'),
  saveConfig: (entries) => ipcRenderer.invoke('save-config', entries),
  openConfigFileDialog: () => ipcRenderer.invoke('open-config-file-dialog'),
  parseConfigCsvFile: (filePath) => ipcRenderer.invoke('parse-config-csv-file', filePath),
  parseConfigExcelFile: (filePath) => ipcRenderer.invoke('parse-config-excel-file', filePath),
  getTokenUsage: () => ipcRenderer.invoke('get-token-usage'),
  runFetchModels: () => ipcRenderer.invoke('run-fetch-models'),
  onDevLog: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('dev-log', handler);
    return () => ipcRenderer.removeListener('dev-log', handler);
  },
  onConfigReady: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('config-ready', handler);
    return () => ipcRenderer.removeListener('config-ready', handler);
  }
});
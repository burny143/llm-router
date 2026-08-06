// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const axios = require('axios');
const https = require('https');
const { startProxy, stopProxy, isProxyRunning, setHealthResults, extractContent, getTokenUsage, getProxyStats, getKnownOk, setPriorityOverride, getRoutingLog, getPriorityState, setPriorityStateListener, injectUserTextWithFallback, reloadAssistantConfig, previewToolFormat } = require('./proxy-server');
const { saveResults, loadResults, saveSettings, loadSettings, saveConfigBoth, syncConfigFromCsv, pruneConfigEntries, loadProviderConfig, CONFIG_CSV, PROVIDER_CONFIG_CSV, getFilePath, envPrefixFor, parseCsv, loadAssistantConfig, saveAssistantConfig } = require('./state-store');
const { IPC_CHANNELS, DEFAULT_COOKIE_USER_AGENT } = require('./shared-constants');
const { initAgentController } = require('./agent-controller');
require('dotenv').config({ path: getFilePath('env') });

const chromeAgent = new https.Agent({
  ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
  ecdhCurve: 'X25519:prime256v1:secp384r1',
  minVersion: 'TLSv1.2',
  rejectUnauthorized: false
});

let webRules = {};
function reloadWebRules() {
  try {
    const rulesPath = getFilePath('webProviderRules');
    if (fs.existsSync(rulesPath)) {
      webRules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
    } else {
      webRules = {};
    }
  } catch (e) {
    console.warn('Could not load web-provider-rules.json:', e.message);
  }
}
reloadWebRules();

let mainWindow;
let availableModels = [];
let availableProviders = [];
let availableProviderModels = {};
let latestProviderModels = {};
let modelsFile = '';
let configEntries = [];
let pendingConfigReady = null;

// Known web (Cookie-auth) provider presets. Each preset pre-fills the "Add Web
// Provider" modal (name, login URL) and seeds ProviderConfig.csv + rules with a
// sensible default baseURL/samplePayload when a cookie is pasted manually.
const WEB_PROVIDER_PRESETS = {
  Qwen: {
    loginUrl: 'https://chat.qwen.ai/',
    baseURL: 'https://chat.qwen.ai/api/v2/chat/completions',
    origin: 'https://chat.qwen.ai',
    referer: 'https://chat.qwen.ai/',
    samplePayload: { model: 'openai', question: 'hi', stream: true }
  },
  Kimi: {
    loginUrl: 'https://www.kimi.com/',
    // NOTE: Kimi's web API is a token-exchange protocol (refresh_token -> convId
    // -> completion/stream) served from kimi.moonshot.cn, NOT an OpenAI-style
    // endpoint. baseURL below is display metadata only; when an authToken is
    // present the proxy routes requests through kimi-web-client.js instead.
    baseURL: 'https://kimi.moonshot.cn/api/chat',
    origin: 'https://kimi.moonshot.cn',
    referer: 'https://kimi.moonshot.cn/',
    samplePayload: {
      copilot_ctx: null,
      is_think: true,
      kimiplus_id: '',
      messages: [{ role: 'user', content: 'hi' }],
      model: 'kimi',
      on_site_url: 'https://www.kimi.com/zh-cn',
      origin: 'web',
      query: 'hi',
      type: 'chat',
      use_research: false,
      stream: true
    }
  }
};

function loadHealthResults() {
  const saved = loadResults();
  if (saved.length > 0) {
    setHealthResults(saved);
    const okCount = saved.filter(r => r.status === 'OK').length;
    console.log(`Restored ${okCount} known-OK endpoint(s) from previous session.`);
  }
}

function sendToRenderer(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

function forwardLogsToRenderer() {
  const levels = ['log', 'info', 'warn', 'error'];
  levels.forEach(level => {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      const text = args.map(a => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(' ');
      sendToRenderer(IPC_CHANNELS.DEV_LOG, { level, text, time: new Date().toLocaleTimeString() });
    };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingConfigReady) {
      sendToRenderer(IPC_CHANNELS.CONFIG_READY, pendingConfigReady);
      pendingConfigReady = null;
    }
  });
}

function queueConfigReady(payload) {
  pendingConfigReady = payload;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    sendToRenderer(IPC_CHANNELS.CONFIG_READY, pendingConfigReady);
    pendingConfigReady = null;
  }
}

function addOrUpdateWebProviderEntry(providerName) {
  const providerMap = loadProviderConfig();
  const info = providerMap[providerName];
  if (!info) {
    console.warn(`Web provider setup: "${providerName}" not found in ${path.basename(PROVIDER_CONFIG_CSV)} after capture.`);
    return;
  }
  const placeholderModel = `${providerName}-chat`;
  configEntries = configEntries.filter(e => !(e.provider === providerName && e.model === placeholderModel));
  configEntries.push({
    provider: providerName,
    baseURL: info.baseURL,
    apiKeyEnv: info.apiKeyEnv,
    model: placeholderModel,
    enabled: true,
    authType: info.authType || 'Bearer'
  });
  saveConfigBoth(configEntries);
  console.log(`Web provider "${providerName}" added to config as ${placeholderModel} (authType: ${info.authType || 'Bearer'}).`);
}

ipcMain.handle(IPC_CHANNELS.RUN_WEB_PROVIDER_SETUP, async (event, providerName, startUrl) => {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, 'setup-web-provider.js');
    const child = spawn('node', [scriptPath, providerName, startUrl], { cwd: __dirname });
    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); console.log(data.toString()); });
    child.stderr.on('data', (data) => { output += data.toString(); console.error(data.toString()); });
    child.on('close', (code) => {
      // The child process runs its own headed Playwright browser for login/capture
      // and tears those native OS windows down before exiting. Closing a native
      // browser window triggers an OS-level activation event that doesn't reliably
      // return focus to the Electron window (esp. on Windows), which is the source
      // of the post-capture "dropdown freeze." Reclaim focus immediately when the
      // child exits — for either success or failure.
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
      if (code === 0) {
        require('dotenv').config({ path: getFilePath('env'), override: true });
        reloadWebRules();
        addOrUpdateWebProviderEntry(providerName);
        queueConfigReady({ entries: configEntries });
        resolve({ success: true, output });
      } else {
        resolve({ success: false, error: output });
      }
    });
  });
});

ipcMain.handle(IPC_CHANNELS.GET_WEB_PROVIDER_PRESETS, () => {
  // Expose only the UI-facing fields; full preset (baseURL/samplePayload) stays
  // in main for seeding config. Renderer uses these to prefill the modal.
  return Object.fromEntries(
    Object.entries(WEB_PROVIDER_PRESETS).map(([name, p]) => [name, { loginUrl: p.loginUrl, baseURL: p.baseURL }])
  );
});

ipcMain.handle(IPC_CHANNELS.CLEAR_WEB_PROVIDER_SESSION, async (event, providerName) => {
  try {
    const name = providerName || 'Qwen';
    const envKey = `${envPrefixFor(name)}_COOKIE`;
    const envPath = getFilePath('env');
    if (fs.existsSync(envPath)) {
      let content = fs.readFileSync(envPath, 'utf-8');
      content = content.split('\n').filter(line => !line.startsWith(`${envKey}=`)).join('\n');
      fs.writeFileSync(envPath, content);
    }
    
    const rulesPath = getFilePath('webProviderRules');
    if (fs.existsSync(rulesPath)) {
      const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
      delete rules[name];
      fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2));
    }
    
    const browserClient = require('./browser-http-client');
    // Only tear down THIS provider's browser session. Closing every provider's
    // Playwright windows would (a) silently destroy other providers' valid
    // logged-in sessions, and (b) close unrelated native browser windows mid-
    // flow, stealing OS focus from the Electron window and leaving native
    // <select> popups unresponsive afterwards.
    const profileKey = envPrefixFor(name).toLowerCase();

    // Reclaim focus for the Electron UI right away — closing a Playwright
    // window triggers an OS-level activation event that doesn't reliably return
    // to mainWindow on Windows, so don't wait on the profile flush before
    // refocusing.
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();

    // Close the matching session in the background; don't block the response
    // (and the UI) on Playwright's disk flush of the browser profile.
    browserClient.close(profileKey)
      .then(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus(); })
      .catch((err) => console.warn(`Background close of ${name} web session failed:`, err && err.message ? err.message : err));

    console.log(`${name} web session cleared successfully.`);
    return { success: true };
  } catch (err) {
    console.error(`Failed to clear ${providerName || 'Qwen'} web session:`, err.message);
    return { success: false, error: err.message };
  }
});

// Manually paste a cookie for a web (Cookie-auth) provider — no browser, no ping.
// Stores <PREFIX>_COOKIE in .env, upserts the ProviderConfig.csv row, and seeds
// web-provider-rules.json with a default sample payload + headers (so payload
// translation has something to clone). Does NOT probe the provider afterwards.
ipcMain.handle(IPC_CHANNELS.SET_PROVIDER_COOKIE, async (event, providerName, cookie) => {
  try {
    const prefix = envPrefixFor(providerName);
    const envKey = `${prefix}_COOKIE`;
    const envPath = getFilePath('env');
    if (fs.existsSync(envPath)) {
      let content = fs.readFileSync(envPath, 'utf-8');
      content = content.split('\n').filter(line => !line.startsWith(`${envKey}=`)).join('\n');
      const safeValue = String(cookie).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      content = `${content}\n${envKey}="${safeValue}"\n`.trim();
      fs.writeFileSync(envPath, content + '\n');
    }
    require('dotenv').config({ path: envPath, override: true });

    const preset = WEB_PROVIDER_PRESETS[providerName];

    // Upsert ProviderConfig.csv row
    const csvPath = getFilePath('providerConfig');
    const existingCsv = fs.existsSync(csvPath) ? fs.readFileSync(csvPath, 'utf-8') : '';
    let header = existingCsv ? existingCsv.split(/\r?\n/)[0].split(',').map(h => h.trim()).filter(Boolean) : [];
    ['provider', 'baseURL', 'apiKeyEnv', 'modelsEndpoint', 'authType'].forEach(h => { if (!header.includes(h)) header.push(h); });
    let rows = existingCsv ? parseCsv(existingCsv) : [];
    rows = rows.filter(r => r.provider !== providerName);
    const newRow = {};
    header.forEach(h => { newRow[h] = ''; });
    newRow.provider = providerName;
    newRow.apiKeyEnv = envKey;
    newRow.authType = 'Cookie';
    if (preset) {
      newRow.baseURL = preset.baseURL;
    }
    rows.push(newRow);
    const escapeCsv = (v) => { const s = v == null ? '' : String(v); return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s; };
    fs.writeFileSync(csvPath, [header.join(','), ...rows.map(r => header.map(h => escapeCsv(r[h])).join(','))].join('\n') + '\n');

    // Seed web-provider-rules.json if not already captured
    const rulesPath = getFilePath('webProviderRules');
    let rules = {};
    if (fs.existsSync(rulesPath)) { try { rules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8')) || {}; } catch (e) { rules = {}; } }
    if (!rules[providerName]) {
      rules[providerName] = {
        samplePayload: preset ? preset.samplePayload : { question: 'hi', stream: true },
        headers: { 'Content-Type': 'application/json' },
        userAgent: DEFAULT_COOKIE_USER_AGENT,
        origin: preset ? preset.origin : '',
        referer: preset ? preset.referer : '',
        profileKey: prefix.toLowerCase()
      };
    }
    // A JWT (eyJ...) pasted here is Kimi's Local Storage `refresh_token`, which
    // the API expects as a Bearer token — NOT a cookie. Detect it and store it
    // as authToken so the runtime sends `Authorization: Bearer <token>`.
    const trimmedCookie = String(cookie).trim();
    const looksLikeJwt = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmedCookie);
    if (looksLikeJwt) {
      rules[providerName].authToken = trimmedCookie;
      console.log(`[${providerName}] pasted value detected as a JWT refresh_token — stored as authToken.`);
    }
    fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2));

    const masked = String(cookie).replace(/^[^\s]+={0,2}/, m => m.slice(0, Math.min(m.length, 4)) + '...').replace(/[^=;:.\-_a-zA-Z0-9]/g, '');
    reloadWebRules();
    // Same post-registration as the browser-capture path: add a config entry so
    // the provider shows up in the config table + provider dropdown immediately.
    addOrUpdateWebProviderEntry(providerName);
    queueConfigReady({ entries: configEntries });
    console.log(`[${providerName}] cookie saved (${masked.length} chars). No ping performed.`);
    return { success: true };
  } catch (err) {
    console.error(`Failed to save ${providerName} cookie:`, err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle(IPC_CHANNELS.START_PROXY, async (event, port, entries) => {
  try {
    await startProxy(port, entries);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle(IPC_CHANNELS.STOP_PROXY, () => {
  stopProxy();
  return { success: true };
});

ipcMain.handle(IPC_CHANNELS.IS_PROXY_RUNNING, () => {
  return isProxyRunning();
});

ipcMain.handle(IPC_CHANNELS.GET_DEFAULT_CONFIG, () => {
  const defaultConfig = require('./models-config');
  return defaultConfig;
});

ipcMain.handle(IPC_CHANNELS.GET_DEFAULT_FILE_NAMES, () => {
  return {
    latestModelsFileName: path.basename(getFilePath('latestModels')),
    providerConfigFileName: path.basename(getFilePath('providerConfig')),
    ultimateConfigFileName: path.basename(getFilePath('ultimateConfig'))
  };
});

ipcMain.handle(IPC_CHANNELS.GET_ENV_VARS, () => {
  const envPath = getFilePath('env');
  const envVars = [];
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
          const key = trimmed.substring(0, eqIndex).trim();
          if (key) {
            envVars.push(key);
          }
        }
      }
    }
  }
  return envVars;
});

function loadLatestModels() {
  const latestPath = getFilePath('latestModels');
  if (!fs.existsSync(latestPath)) return;
  try {
    const text = fs.readFileSync(latestPath, 'utf-8');
    const rows = parseCsv(text);
    const providerModels = {};
    for (const row of rows) {
      const provider = row.provider;
      const model = row.model;
      if (!provider || !model) continue;
      if (model.startsWith('ERROR:')) continue;
      if (!providerModels[provider]) providerModels[provider] = [];
      providerModels[provider].push(model);
    }
    latestProviderModels = providerModels;
    const totalModels = Object.values(providerModels).reduce((sum, arr) => sum + arr.length, 0);
    console.log(`Loaded ${path.basename(getFilePath('latestModels'))}: ${Object.keys(providerModels).length} provider(s), ${totalModels} model(s)`);
  } catch (err) {
    console.warn(`Could not load ${path.basename(getFilePath('latestModels'))}:`, err.message);
  }
}

function connectModelFile(filePath, rows) {
  const { models, providers, providerModels } = extractModelsFromRows(rows);
  availableModels = models;
  availableProviders = providers;
  availableProviderModels = providerModels;
  modelsFile = filePath;
  saveSettings({ modelsFile });
  console.log(`Model list connected: ${providers.length} provider(s), ${models.length} model(s) from ${path.basename(filePath)}`);
  return { models, providers, providerModels };
}

function autoConnectModelFile() {
  const settings = loadSettings();
  let filePath = settings.modelsFile;
  const modelsCsv = getFilePath('models');
  if ((!filePath || !fs.existsSync(filePath)) && fs.existsSync(modelsCsv)) {
    filePath = modelsCsv;
    saveSettings({ modelsFile: filePath });
  }
  if (!filePath || !fs.existsSync(filePath)) return;
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === '.csv') {
      const csv = require('csv-parser');
      const rows = [];
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', d => rows.push(d))
        .on('end', () => connectModelFile(filePath, rows))
        .on('error', err => console.warn('Could not auto-load model list:', err.message));
    } else {
      const XLSX = require('xlsx');
      const wb = XLSX.readFile(filePath);
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
      connectModelFile(filePath, rows);
    }
  } catch (err) {
    console.warn('Could not auto-load model list:', err.message);
  }
}

ipcMain.handle(IPC_CHANNELS.GET_CONNECTED_MODEL_LIST, () => {
  return {
    models: availableModels,
    providers: availableProviders,
    providerModels: availableProviderModels,
    latestProviderModels: latestProviderModels,
    file: modelsFile,
    latestModelsFileName: path.basename(getFilePath('latestModels')),
    providerConfigFileName: path.basename(PROVIDER_CONFIG_CSV)
  };
});

function buildModelListsForProviders(providerMap) {
  const modelLists = [];
  const defaultConfig = require('./models-config');
  for (const [provider, info] of Object.entries(providerMap)) {
    const modelSet = new Set();
    if (latestProviderModels[provider]) {
      latestProviderModels[provider].forEach(m => modelSet.add(m));
    }
    if (availableProviderModels[provider]) {
      availableProviderModels[provider].forEach(m => modelSet.add(m));
    }
    const defaultModels = defaultConfig
      .filter(group => group.provider === provider)
      .map(group => group.models)
      .flat();
    defaultModels.forEach(m => modelSet.add(m));
    modelSet.forEach(model => {
      modelLists.push({
        provider,
        baseURL: info.baseURL,
        apiKeyEnv: info.apiKeyEnv,
        model,
        enabled: true,
        authType: info.authType || 'Bearer'
      });
    });
  }
  return modelLists;
}

async function autoConnectConfigFile() {
  const configPath = getFilePath('ultimateConfig');
  const configExists = fs.existsSync(configPath) && fs.readFileSync(configPath, 'utf-8').trim().length > 0;
  if (configExists) {
    let entries = syncConfigFromCsv();
    const providerMap = loadProviderConfig();
    const result = pruneConfigEntries(entries, providerMap);
    entries = result.pruned;
    const changed = result.changed;
    configEntries = entries;
    if (changed) {
      saveConfigBoth(entries);
    }
    console.log(`Loaded existing config: ${configEntries.length} entries (pruned to match ${path.basename(PROVIDER_CONFIG_CSV)}).`);
    queueConfigReady({ entries: configEntries });
  } else {
    const providerMap = loadProviderConfig();
    const modelLists = buildModelListsForProviders(providerMap);
    configEntries = modelLists;
    saveConfigBoth(configEntries);
    console.log(`Generated config: ${configEntries.length} entries (created from ${path.basename(PROVIDER_CONFIG_CSV)}).`);
    queueConfigReady({ entries: configEntries });
  }
}

ipcMain.handle(IPC_CHANNELS.GET_CONNECTED_CONFIG, () => {
  return { entries: configEntries, file: CONFIG_CSV, fileName: path.basename(CONFIG_CSV) };
});

ipcMain.handle(IPC_CHANNELS.GET_PROVIDER_CONFIG, () => {
  return loadProviderConfig();
});

ipcMain.handle(IPC_CHANNELS.SAVE_CONFIG, async (event, entries) => {
  try {
    saveConfigBoth(entries);
    configEntries = entries;
    console.log(`Config saved: ${entries.length} entries (${path.basename(getFilePath('ultimateConfig'))} + proxy-config.json updated).`);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle(IPC_CHANNELS.OPEN_CONFIG_FILE_DIALOG, async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Proxy Config File (CSV or Excel)',
    filters: [
      { name: 'CSV Files', extensions: ['csv'] },
      { name: 'Excel Files', extensions: ['xlsx', 'xls'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }
  return { canceled: false, filePath: result.filePaths[0] };
});

ipcMain.handle(IPC_CHANNELS.PARSE_CONFIG_CSV_FILE, async (event, filePath) => {
  const csv = require('csv-parser');
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => {
        const entries = results.map(r => ({
          provider: r.provider || '',
          baseURL: r.baseURL || r.baseUrl || '',
          apiKeyEnv: r.apiKeyEnv || r.apiKey || '',
          model: r.model || '',
          enabled: r.enabled !== 'false' && r.enabled !== false,
          authType: r.authType || 'Bearer'
        })).filter(e => e.provider && e.model);
        resolve({ success: true, entries, rowCount: results.length });
      })
      .on('error', (err) => reject({ success: false, error: err.message }));
  });
});

ipcMain.handle(IPC_CHANNELS.PARSE_CONFIG_EXCEL_FILE, async (event, filePath) => {
  const XLSX = require('xlsx');
  try {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet);
    const entries = rows.map(r => ({
      provider: r.provider || '',
      baseURL: r.baseURL || r.baseUrl || '',
      apiKeyEnv: r.apiKeyEnv || r.apiKey || '',
      model: r.model || '',
      enabled: r.enabled !== 'false' && r.enabled !== false,
      authType: r.authType || 'Bearer'
    })).filter(e => e.provider && e.model);
    return { success: true, entries, rowCount: rows.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle(IPC_CHANNELS.RUN_FETCH_MODELS, async () => {
  return new Promise((resolve) => {
    exec('node fetch-models.js', { cwd: __dirname }, (error, stdout, stderr) => {
      if (error) {
        console.warn('fetch-models.js error:', error.message);
        resolve({ success: false, error: error.message, output: stdout + stderr });
        return;
      }
      try {
        const csvText = fs.readFileSync(getFilePath('latestModels'), 'utf-8');
        const rows = parseCsv(csvText);
        const entries = [];
        for (const row of rows) {
          if (row.provider && row.model) {
            if (row.model.startsWith('ERROR:')) continue;
            entries.push({ provider: row.provider, model: row.model });
          }
        }
        console.log('fetch-models.js completed:', entries.length, 'models fetched');
        resolve({ success: true, output: stdout + stderr, entries });
      } catch (readErr) {
        resolve({ success: true, output: stdout + stderr, entries: [] });
      }
    });
  });
});

ipcMain.handle(IPC_CHANNELS.GET_KNOWN_OK, () => {
  return getKnownOk();
});

ipcMain.handle(IPC_CHANNELS.SET_PRIORITY_OVERRIDE, (event, providerModelKey, locked) => {
  try {
    setPriorityOverride(providerModelKey || null, !!locked);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// --- NEW: priority lock / rotate + live resync ---
ipcMain.handle(IPC_CHANNELS.GET_ROUTING_LOG, () => {
  return getRoutingLog();
});

ipcMain.handle(IPC_CHANNELS.GET_PRIORITY_STATE, () => {
  return getPriorityState();
});

// Pushed to every window whenever the backend changes priorityOverrideKey/
// lock/routingMode for any reason — including auto-clearing a stale pin,
// which previously happened silently with no way for the UI to find out.
setPriorityStateListener((state) => {
  sendToRenderer(IPC_CHANNELS.PRIORITY_STATE_CHANGED, state);
});

ipcMain.handle(IPC_CHANNELS.GET_TOKEN_USAGE, () => {
  return getTokenUsage();
});

ipcMain.handle(IPC_CHANNELS.GET_PROXY_STATS, () => {
  return getProxyStats();
});

ipcMain.handle(IPC_CHANNELS.GET_ASSISTANT_CONFIG, () => {
  return loadAssistantConfig();
});

ipcMain.handle(IPC_CHANNELS.SAVE_ASSISTANT_CONFIG, (event, config) => {
  try {
    saveAssistantConfig(config);
    reloadAssistantConfig(); // pick the new settings up in the running proxy immediately
    console.log('Assistant config saved.');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle(IPC_CHANNELS.PREVIEW_TOOL_FORMAT, () => {
  try {
    return { success: true, preview: previewToolFormat() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle(IPC_CHANNELS.HEALTH_CHECK, async (event, entries) => {
  console.log(`Health check: pinging ${entries.length} enabled model(s)...`);
  const checkOne = async (entry) => {
    const startTime = Date.now();
    const apiKey = process.env[entry.apiKeyEnv];
    // Kimi-style providers authenticate via `authToken` (refresh_token) in the
    // rules file — the cookie env var is not required for them.
    const rule0 = entry.authType === 'Cookie' ? (webRules[entry.provider] || null) : null;
    if (!apiKey && !(rule0 && rule0.authToken)) {
      console.log(`[SKIP] ${entry.provider}/${entry.model} — No API key`);
      return { provider: entry.provider, model: entry.model, status: 'Failed', reason: 'No API key', latency: Date.now() - startTime };
    }
    const authType = entry.authType || 'Bearer';
    const headers = { 'Content-Type': 'application/json' };
    let payload = {
      model: entry.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 5
    };
    if (authType === 'Cookie') {
      headers['Cookie'] = apiKey;
      headers['User-Agent'] = DEFAULT_COOKIE_USER_AGENT;
      headers['sec-ch-ua'] = '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"';
      headers['sec-ch-ua-mobile'] = '?0';
      headers['sec-ch-ua-platform'] = '"Windows"';
      headers['sec-fetch-dest'] = 'empty';
      headers['sec-fetch-mode'] = 'cors';
      headers['sec-fetch-site'] = 'same-origin';
      headers['accept'] = '*/*';
      headers['accept-language'] = 'en-US,en;q=0.9';
      const rule = webRules[entry.provider];
      if (rule) {
        if (rule.headers) {
          for (const [key, value] of Object.entries(rule.headers)) {
            if (!headers[key.toLowerCase()]) headers[key] = value;
          }
        } else {
          if (rule.userAgent) headers['User-Agent'] = rule.userAgent;
          if (rule.origin) headers['Origin'] = rule.origin;
          if (rule.referer) headers['Referer'] = rule.referer;
        }
        headers['Cookie'] = apiKey;
        headers['Content-Type'] = 'application/json';
        if (rule.samplePayload) {
          payload = JSON.parse(JSON.stringify(rule.samplePayload));
          injectUserTextWithFallback(payload, 'ping');
        }
        // Kimi-style providers authenticate via the Local Storage `refresh_token`
        // (Bearer), not via cookies — attach it when the capture saved one.
        if (rule.authToken) {
          headers['Authorization'] = `Bearer ${rule.authToken}`;
        }
      }
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    try {
      console.log(`[CHECK] ${entry.provider}/${entry.model} → ${entry.baseURL}`);
      let resp;
      if (authType === 'Cookie') {
        const rule = webRules[entry.provider];
        // Kimi-style providers authenticate via a `refresh_token` (stored as
        // `authToken` in the rules) and speak their own token-exchange API — no
        // browser/cookies involved. Route those through the dedicated client.
        if (rule && rule.authToken) {
          const kimiClient = require('./kimi-web-client');
          resp = await kimiClient.completion({
            model: entry.model,
            messages: [{ role: 'user', content: 'ping' }],
            refreshToken: rule.authToken,
            useSearch: false
          });
        } else {
          const browserClient = require('./browser-http-client');
          const profileKey = (rule && rule.profileKey) || envPrefixFor(entry.provider).toLowerCase();
          resp = await browserClient.request(entry.baseURL, payload, headers, apiKey, profileKey);
        }
      } else {
        resp = await axios.post(entry.baseURL, payload, { 
          headers, 
          timeout: 15000,
          httpsAgent: authType === 'Cookie' ? chromeAgent : undefined
        });
      }
      const hasContent = resp.status === 200 && extractContent(resp.data) !== null;
      const latency = Date.now() - startTime;
      const status = hasContent ? 'OK' : `Failed (${resp.status} - no usable content)`;
      console.log(`[${status}] ${entry.provider}/${entry.model} — ${latency}ms`);
      if (!hasContent) {
        console.log(`Raw response: ${JSON.stringify(resp.data).slice(0, 300)}`);
      }
      return { provider: entry.provider, model: entry.model, status, latency };
    } catch (err) {
      const latency = Date.now() - startTime;
      console.log(`[FAILED] ${entry.provider}/${entry.model} — ${err.message} (${latency}ms)`);
      return { provider: entry.provider, model: entry.model, status: 'Failed', reason: err.message, latency };
    }
  };
  const results = await Promise.all(entries.map(checkOne));
  const okCount = results.filter(r => r.status === 'OK').length;
  setHealthResults(results);
  console.log(`Health check complete: ${okCount}/${results.length} endpoints OK. Routing updated live.`);
  return results;
});

function extractModelsFromRows(rows) {
  if (!rows || rows.length === 0) return { models: [], providers: [], providerModels: {} };
  const columns = Object.keys(rows[0]);
  const modelColumnCandidates = [
    'model', 'model_name', 'modelname', 'model-id', 'modelid',
    'name', 'modelName', 'Model', 'Model Name', 'ModelName'
  ];
  let modelColumn = null;
  for (const candidate of modelColumnCandidates) {
    const found = columns.find(c => c.toLowerCase() === candidate.toLowerCase());
    if (found) {
      modelColumn = found;
      break;
    }
  }
  if (!modelColumn) {
    for (const col of columns) {
      const sampleValues = rows.slice(0, 5).map(r => r[col]).filter(v => v != null && v !== '');
      if (sampleValues.length > 0 && typeof sampleValues[0] === 'string') {
        modelColumn = col;
        break;
      }
    }
  }
  if (!modelColumn && columns.length > 0) {
    modelColumn = columns[0];
  }
  const models = modelColumn
    ? [...new Set(rows.map(r => r[modelColumn]).filter(v => v != null && v !== ''))]
    : [];
  let providers = [];
  let providerModels = {};
  const providerColumn = columns.find(c => c.toLowerCase() === 'provider');
  if (providerColumn) {
    providers = [...new Set(rows.map(r => r[providerColumn]).filter(v => v != null && v !== ''))];
    providers.forEach(p => {
      providerModels[p] = [...new Set(rows.filter(r => r[providerColumn] === p).map(r => r[modelColumn]).filter(v => v != null && v !== ''))];
    });
  }
  return { models, providers, providerModels };
}

app.whenReady().then(async () => {
  forwardLogsToRenderer();
  loadHealthResults();
  loadLatestModels();
  autoConnectModelFile();
  createWindow();
  try {
    initAgentController({ ipcMain, dialog, sendToRenderer, getMainWindow: () => mainWindow });
  } catch (err) {
    console.error('initAgentController failed to initialize:', err);
  }
  await autoConnectConfigFile();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
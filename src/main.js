const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const axios = require('axios');

const { startProxy, stopProxy, isProxyRunning, setHealthResults, extractContent, getTokenUsage, getProxyStats, getKnownOk, setPriorityOverride } = require('./proxy-server');
const { saveResults, loadResults, saveSettings, loadSettings, saveConfigBoth, syncConfigFromCsv, pruneConfigEntries, loadProviderConfig, CONFIG_CSV, PROVIDER_CONFIG_CSV, getFilePath } = require('./state-store');
const { IPC_CHANNELS } = require('./shared-constants');
require('dotenv').config({ path: getFilePath('env') }); // Load .env (path from file-registry.json) so process.env has the API keys

let mainWindow;
let availableModels = [];    // Models from the connected model-list file
let availableProviders = []; // Providers from the connected model-list file
let availableProviderModels = {}; // Map: provider -> models[] from model-list file
let latestProviderModels = {}; // Map: provider -> models[] from LatestModels.csv (primary)
let modelsFile = '';         // Path of the connected model-list file (auto-loaded like .env)
let configEntries = [];      // Proxy entries from the connected config file (source of truth)
let pendingConfigReady = null; // Queued config-ready payload, flushed once the renderer has finished loading

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

// Forward main-process logs to the renderer's Developer Logs panel
function forwardLogsToRenderer() {
  const levels = ['log', 'info', 'warn', 'error'];
  levels.forEach(level => {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args); // keep CMD output
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
      // Explicitly disabled: Electron 20+ defaults `sandbox` to true when
      // unset, which restricts preload.js's require() to a small whitelist
      // of built-ins (electron, events, timers, url, ...). That silently
      // breaks `require('./shared-constants')` with
      // "Error: module not found: ./shared-constants" thrown by the
      // sandboxed preloadRequire shim, which in turn means
      // contextBridge.exposeInMainWorld never runs and window.api is never
      // defined in the renderer. contextIsolation:true is kept as the real
      // security boundary between preload and page content.
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // The renderer's onConfigReady listener isn't guaranteed to be registered
  // until the page has actually finished loading, even though `mainWindow`
  // itself exists synchronously. Flush anything queued via queueConfigReady()
  // once the page is ready, so we never fire config-ready into a listener
  // that isn't there yet.
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingConfigReady) {
      sendToRenderer(IPC_CHANNELS.CONFIG_READY, pendingConfigReady);
      pendingConfigReady = null;
    }
  });
}

// Queue a config-ready payload for delivery once the renderer has finished loading.
// Use this instead of calling sendToRenderer(IPC_CHANNELS.CONFIG_READY, ...) directly.
function queueConfigReady(payload) {
  pendingConfigReady = payload;
  // If the page already finished loading by the time this is called, flush immediately.
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    sendToRenderer(IPC_CHANNELS.CONFIG_READY, pendingConfigReady);
    pendingConfigReady = null;
  }
}

// IPC handlers for proxy control
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

// Return the default models configuration (from models-config.js)
ipcMain.handle(IPC_CHANNELS.GET_DEFAULT_CONFIG, () => {
  const defaultConfig = require('./models-config');
  return defaultConfig;
});

// Canonical default basenames for the data files (LatestModels.csv, ProviderConfig.csv,
// UltimateConfig.csv, ...), resolved from state-store.js's file registry/defaults —
// the single source of truth. The renderer calls this once on startup so its fallback
// labels are never hardcoded literals that could go stale if a filename changes here.
ipcMain.handle(IPC_CHANNELS.GET_DEFAULT_FILE_NAMES, () => {
  return {
    latestModelsFileName: path.basename(getFilePath('latestModels')),
    providerConfigFileName: path.basename(getFilePath('providerConfig')),
    ultimateConfigFileName: path.basename(getFilePath('ultimateConfig'))
  };
});

// Get available environment variables from .env file
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

// Load LatestModels.csv (primary source for model dropdown)
function loadLatestModels() {
  const latestPath = getFilePath('latestModels');
  if (!fs.existsSync(latestPath)) return;
  try {
    const text = fs.readFileSync(latestPath, 'utf-8');
    const lines = text.trim().split(/\r?\n/);
    const providerModels = {};
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const firstComma = line.indexOf(',');
      if (firstComma === -1) continue;
      const provider = line.substring(0, firstComma);
      const model = line.substring(firstComma + 1);
      // Skip error entries
      if (model.startsWith('ERROR:')) continue;
      if (provider && model) {
        if (!providerModels[provider]) providerModels[provider] = [];
        providerModels[provider].push(model);
      }
    }
    latestProviderModels = providerModels;
    const totalModels = Object.values(providerModels).reduce((sum, arr) => sum + arr.length, 0);
    console.log(`Loaded ${path.basename(getFilePath('latestModels'))}: ${Object.keys(providerModels).length} provider(s), ${totalModels} model(s)`);
  } catch (err) {
    console.warn(`Could not load ${path.basename(getFilePath('latestModels'))}:`, err.message);
  }
}

// Apply a parsed model list: remember the file (like .env), extract models + providers.
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

// Like .env: if a model list file was connected before, auto-load it at startup.
// Falls back to models.csv if that file exists.
function autoConnectModelFile() {
  const settings = loadSettings();
  let filePath = settings.modelsFile;
  // Fallback to models.csv if no saved file or saved file no longer exists
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

// Get the currently connected model list (models + providers + provider-to-model map + source file)
ipcMain.handle(IPC_CHANNELS.GET_CONNECTED_MODEL_LIST, () => {
  return {
    models: availableModels,
    providers: availableProviders,
    providerModels: availableProviderModels,
    latestProviderModels: latestProviderModels,
    file: modelsFile,
    // Basenames so the renderer can build display strings without hardcoding filenames.
    latestModelsFileName: path.basename(getFilePath('latestModels')),
    providerConfigFileName: path.basename(PROVIDER_CONFIG_CSV)
  };
});

// --- Config File (source of truth for proxy entries) ---
// UltimateConfig.csv is the editable truth file — proxy-config.json is synced from it.

// Build model lists for each provider from ProviderConfig.csv
// Uses live model sources (LatestModels.csv, connected model-list) before fallback to models-config.js
function buildModelListsForProviders(providerMap) {
  const modelLists = [];
  // Priority 3 fallback catalog — hoisted out of the loop since require()
  // is cached anyway and re-requiring on every iteration was sloppy.
  const defaultConfig = require('./models-config');

  for (const [provider, info] of Object.entries(providerMap)) {
    const modelSet = new Set();
    
    // Priority 1: LatestModels.csv (fetched live)
    if (latestProviderModels[provider]) {
      latestProviderModels[provider].forEach(m => modelSet.add(m));
    }
    
    // Priority 2: Connected model-list file
    if (availableProviderModels[provider]) {
      availableProviderModels[provider].forEach(m => modelSet.add(m));
    }
    
    // Priority 3: Fallback to models-config.js (hardcoded catalog)
    const defaultModels = defaultConfig
      .filter(group => group.provider === provider)
      .map(group => group.models)
      .flat();
    defaultModels.forEach(m => modelSet.add(m));
    
    // Add deduplicated models to lists
    modelSet.forEach(model => {
      modelLists.push({
        provider,
        baseURL: info.baseURL,
        apiKeyEnv: info.apiKeyEnv,
        model,
        enabled: true
      });
    });
  }
  
  return modelLists;
}

// Auto-connect config file on startup (like .env)
async function autoConnectConfigFile() {
  // Check if UltimateConfig.csv already exists (non-empty)
  const configPath = getFilePath('ultimateConfig');
  const configExists = fs.existsSync(configPath) && fs.readFileSync(configPath, 'utf-8').trim().length > 0;
  
  if (configExists) {
    // Load existing config and prune orphaned providers
    let entries = syncConfigFromCsv();
    const providerMap = loadProviderConfig();
    const result = pruneConfigEntries(entries, providerMap);
    entries = result.pruned;
    const changed = result.changed;
    configEntries = entries;
    
    // Persist pruned config if any entries were dropped
    if (changed) {
      saveConfigBoth(entries);
    }
    console.log(`Loaded existing config: ${configEntries.length} entries (pruned to match ${path.basename(PROVIDER_CONFIG_CSV)}).`);
    // Notify renderer here too — previously this branch never sent config-ready,
    // so the renderer had no way to know the existing config had loaded.
    queueConfigReady({ entries: configEntries });
  } else {
    // Generate from ProviderConfig.csv (first-time setup)
    const providerMap = loadProviderConfig();
    const modelLists = await buildModelListsForProviders(providerMap);
    configEntries = modelLists;
    saveConfigBoth(configEntries);
    console.log(`Generated config: ${configEntries.length} entries (created from ${path.basename(PROVIDER_CONFIG_CSV)}).`);

    // Notify renderer that config is ready (queued until the page has finished loading)
    queueConfigReady({ entries: configEntries });
  }
}

// Load config entries from the connected config file
ipcMain.handle(IPC_CHANNELS.GET_CONNECTED_CONFIG, () => {
  return { entries: configEntries, file: CONFIG_CSV, fileName: path.basename(CONFIG_CSV) };
});

// Load provider configuration (provider -> baseURL, apiKeyEnv from ProviderConfig.csv)
ipcMain.handle(IPC_CHANNELS.GET_PROVIDER_CONFIG, () => {
  return loadProviderConfig();
});

// Save current config entries to UltimateConfig.csv (and regenerate proxy-config.json)
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

// Open file dialog to select config file (optional - for manual override)
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

// Parse CSV config file (provider,baseURL,apiKeyEnv,model,enabled)
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
          enabled: r.enabled !== 'false' && r.enabled !== false
        })).filter(e => e.provider && e.model);
        resolve({ success: true, entries, rowCount: results.length });
      })
      .on('error', (err) => reject({ success: false, error: err.message }));
  });
});

// Parse Excel config file
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
      enabled: r.enabled !== 'false' && r.enabled !== false
    })).filter(e => e.provider && e.model);
    return { success: true, entries, rowCount: rows.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Run fetch-models.js to update LatestModels.csv from ProviderConfig.csv
ipcMain.handle(IPC_CHANNELS.RUN_FETCH_MODELS, async () => {
  return new Promise((resolve) => {
    exec('node fetch-models.js', { cwd: __dirname }, (error, stdout, stderr) => {
      if (error) {
        console.warn('fetch-models.js error:', error.message);
        resolve({ success: false, error: error.message, output: stdout + stderr });
        return;
      }
      // Read and parse LatestModels.csv after fetch
      try {
        const csvText = fs.readFileSync(getFilePath('latestModels'), 'utf-8');
        const lines = csvText.trim().split(/\r?\n/);
        const entries = [];
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(',');
          if (cols.length >= 2 && cols[0] && cols[1]) {
            // Skip error entries (e.g. "ERROR: too many requests") so they
            // never get persisted into configEntries / UltimateConfig.csv /
            // proxy-config.json as if they were real model names.
            if (cols[1].startsWith('ERROR:')) continue;
            entries.push({ provider: cols[0], model: cols[1] });
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

// Return the current set of known-OK endpoints (provider/model/latency) for the priority dropdown
ipcMain.handle(IPC_CHANNELS.GET_KNOWN_OK, () => {
  return getKnownOk();
});

// Set (or clear, with null/undefined) the pinned provider/model priority override
ipcMain.handle(IPC_CHANNELS.SET_PRIORITY_OVERRIDE, (event, providerModelKey) => {
  try {
    setPriorityOverride(providerModelKey || null);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Token usage report per provider/model
ipcMain.handle(IPC_CHANNELS.GET_TOKEN_USAGE, () => {
  return getTokenUsage();
});

// Live proxy stats: request count + connected clients
ipcMain.handle(IPC_CHANNELS.GET_PROXY_STATS, () => {
  return getProxyStats();
});

// Health check: ping all enabled models (in parallel)
ipcMain.handle(IPC_CHANNELS.HEALTH_CHECK, async (event, entries) => {
  console.log(`Health check: pinging ${entries.length} enabled model(s)...`);

  const checkOne = async (entry) => {
    const startTime = Date.now();
    const apiKey = process.env[entry.apiKeyEnv];
    if (!apiKey) {
      console.log(`  [SKIP] ${entry.provider}/${entry.model} — No API key`);
      return { provider: entry.provider, model: entry.model, status: 'Failed', reason: 'No API key', latency: Date.now() - startTime };
    }

    try {
      const payload = {
        model: entry.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1
      };
      console.log(`  [CHECK] ${entry.provider}/${entry.model} → ${entry.baseURL}`);
      const resp = await axios.post(entry.baseURL, payload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        timeout: 15000
      });
      const hasContent = resp.status === 200 && extractContent(resp.data) !== null;
      const latency = Date.now() - startTime;
      const status = hasContent ? 'OK' : `Failed (${resp.status} - no usable content)`;
      console.log(`  [${status}] ${entry.provider}/${entry.model} — ${latency}ms`);
      return { provider: entry.provider, model: entry.model, status, latency };
    } catch (err) {
      const latency = Date.now() - startTime;
      console.log(`  [FAILED] ${entry.provider}/${entry.model} — ${err.message} (${latency}ms)`);
      return { provider: entry.provider, model: entry.model, status: 'Failed', reason: err.message, latency };
    }
  };

  // Run all checks in parallel
  const results = await Promise.all(entries.map(checkOne));

  const okCount = results.filter(r => r.status === 'OK').length;
  setHealthResults(results);
  console.log(`Health check complete: ${okCount}/${results.length} endpoints OK. Routing updated live.`);
  return results;
});

function extractModelsFromRows(rows) {
  if (!rows || rows.length === 0) return { models: [], providers: [], providerModels: {} };

  // Get all column names from the first row
  const columns = Object.keys(rows[0]);

  // Priority order for model column detection
  const modelColumnCandidates = [
    'model', 'model_name', 'modelname', 'model-id', 'modelid',
    'name', 'modelName', 'Model', 'Model Name', 'ModelName'
  ];

  // Find the best matching column
  let modelColumn = null;
  for (const candidate of modelColumnCandidates) {
    const found = columns.find(c => c.toLowerCase() === candidate.toLowerCase());
    if (found) {
      modelColumn = found;
      break;
    }
  }

  // If no standard column found, use the first column that has string values
  if (!modelColumn) {
    for (const col of columns) {
      const sampleValues = rows.slice(0, 5).map(r => r[col]).filter(v => v != null && v !== '');
      if (sampleValues.length > 0 && typeof sampleValues[0] === 'string') {
        modelColumn = col;
        break;
      }
    }
  }

  // Fallback to first column
  if (!modelColumn && columns.length > 0) {
    modelColumn = columns[0];
  }

  const models = modelColumn
    ? [...new Set(rows.map(r => r[modelColumn]).filter(v => v != null && v !== ''))]
    : [];

  // Extract unique providers if the file has a provider column
  let providers = [];
  let providerModels = {};
  const providerColumn = columns.find(c => c.toLowerCase() === 'provider');
  if (providerColumn) {
    providers = [...new Set(rows.map(r => r[providerColumn]).filter(v => v != null && v !== ''))];
    // Build map: provider -> models[]
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
  await autoConnectConfigFile();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
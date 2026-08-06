// renderer.js
// renderer.js — complete file
const { startProxy, stopProxy, isProxyRunning, healthCheck, getDefaultConfig, getEnvVars, getConnectedModelList, getConnectedConfig, getProviderConfig, saveConfig, openConfigFileDialog, parseConfigCsvFile, parseConfigExcelFile, onDevLog, runFetchModels, onConfigReady, setPriorityOverride, getKnownOk } = window.api;

let priorityOverrideKey = null;
let configEntries = [];
let envVars = [];
let loadedModels = [];
let fileProviders = [];
let providerInfo = {};
let latestProviderModels = {};
let providerModelsFromFile = {};
let connectedModelFile = '';
let latestModelsFileName = null;   // set from getDefaultFileNames() in loadDefaultConfig()
let providerConfigFileName = null; // — single source of truth is the main-process registry
let ultimateConfigFileName = null;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showAppNotice(message, isError = false) {
  let notice = document.getElementById('appNotice');

  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'appNotice';
    notice.style.cssText = [
      'position:fixed',
      'top:12px',
      'right:12px',
      'z-index:10000',
      'padding:10px 14px',
      'border-radius:6px',
      'background:#333',
      'color:#fff',
      'opacity:0.95',
      'max-width:420px',
      'white-space:pre-wrap',
      'box-shadow:0 2px 10px rgba(0,0,0,0.35)'
    ].join(';');

    document.body.appendChild(notice);
  }

  notice.textContent = message;
  notice.style.background = isError ? '#a33' : '#333';
  notice.style.display = 'block';

  clearTimeout(notice._timer);

  notice._timer = setTimeout(() => {
    notice.style.display = 'none';
  }, 4000);
}

function showConfirmDialog(message, onResult) {
  let overlay = document.getElementById('appConfirmOverlay');

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'appConfirmOverlay';
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:10001',
      'display:none',
      'align-items:center',
      'justify-content:center',
      'background:rgba(0,0,0,0.35)'
    ].join(';');

    overlay.innerHTML = `
      <div style="
        background:#fff;
        color:#222;
        border-radius:8px;
        min-width:320px;
        max-width:480px;
        padding:16px;
        box-shadow:0 6px 24px rgba(0,0,0,0.25);
        font-family:inherit;
      ">
        <div id="appConfirmMessage" style="margin-bottom:14px; white-space:pre-wrap;"></div>
        <div style="display:flex; justify-content:flex-end; gap:8px;">
          <button id="appConfirmCancel" style="padding:6px 12px;">Cancel</button>
          <button id="appConfirmOk" style="padding:6px 12px;">OK</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.style.display = 'none';

        if (typeof overlay._onResult === 'function') {
          overlay._onResult(false);
        }
      }
    });
  }

  overlay._onResult = onResult;
  overlay.querySelector('#appConfirmMessage').textContent = message;

  const okBtn = overlay.querySelector('#appConfirmOk');
  const cancelBtn = overlay.querySelector('#appConfirmCancel');

  okBtn.onclick = () => {
    overlay.style.display = 'none';

    if (typeof onResult === 'function') {
      onResult(true);
    }
  };

  cancelBtn.onclick = () => {
    overlay.style.display = 'none';

    if (typeof onResult === 'function') {
      onResult(false);
    }
  };

  overlay.style.display = 'flex';

  setTimeout(() => {
    okBtn.focus();
  }, 0);
}

async function loadDefaultConfig() {
  try {
    const defaultFileNames = await window.api.getDefaultFileNames();

    if (defaultFileNames) {
      if (defaultFileNames.latestModelsFileName) latestModelsFileName = defaultFileNames.latestModelsFileName;
      if (defaultFileNames.providerConfigFileName) providerConfigFileName = defaultFileNames.providerConfigFileName;
      if (defaultFileNames.ultimateConfigFileName) ultimateConfigFileName = defaultFileNames.ultimateConfigFileName;
    }
  } catch (err) {
    console.warn('Could not load default file names:', err.message);
  }

  const providerConfig = await getProviderConfig();
  providerInfo = {};

  if (Object.keys(providerConfig).length > 0) {
    Object.entries(providerConfig).forEach(([provider, info]) => {
      providerInfo[provider] = {
        baseURL: info.baseURL,
        apiKeyEnv: info.apiKeyEnv,
        authType: info.authType,
        models: []
      };
    });
  }

  const defaultConfig = await getDefaultConfig();

  defaultConfig.forEach(providerGroup => {
    if (providerInfo[providerGroup.provider]) {
      providerInfo[providerGroup.provider].models = providerGroup.models;
    }
  });

  await loadEnvVars();
  await loadConnectedModelList();

  if (Object.keys(providerConfig).length > 0) {
    console.log(`Loaded provider config from ${providerConfigFileName || '(unknown)'}:`, Object.keys(providerConfig).length, 'providers');
  }

  await loadConnectedConfig(defaultConfig);

  renderAllConfigTables();
  renderPriorityOverrideDropdown();
}

// Re-fetch ProviderConfig.csv from main and merge it into providerInfo so a
// provider added AFTER startup (via "Add Web Provider" capture or cookie paste)
// shows up in the config-table provider dropdown immediately — no restart needed.
async function refreshProviderInfo() {
  let providerConfig = {};

  try {
    providerConfig = await getProviderConfig();
  } catch (err) {
    console.warn('Could not refresh provider config:', err.message);
    return;
  }

  if (!providerConfig || Object.keys(providerConfig).length === 0) return;

  const knownProviderKeys = new Set(Object.keys(providerInfo));

  Object.entries(providerConfig).forEach(([provider, info]) => {
    if (!providerInfo[provider]) {
      providerInfo[provider] = {
        baseURL: info.baseURL,
        apiKeyEnv: info.apiKeyEnv,
        authType: info.authType,
        models: []
      };
    } else {
      providerInfo[provider].baseURL = info.baseURL || providerInfo[provider].baseURL;
      providerInfo[provider].apiKeyEnv = info.apiKeyEnv || providerInfo[provider].apiKeyEnv;
      providerInfo[provider].authType = info.authType || providerInfo[provider].authType;
    }
  });

  const newProviders = Object.keys(providerInfo).filter(p => !knownProviderKeys.has(p));

  if (newProviders.length > 0) {
    console.log('Provider config refreshed — new provider(s):', newProviders.join(', '));
  }
}

function getModelsForProvider(provider) {
  const latestModels = latestProviderModels[provider] || [];
  const fileModels = providerModelsFromFile[provider] || [];
  const defaultProviderModels = providerInfo[provider]?.models || [];

  return [...new Set([...latestModels, ...fileModels, ...defaultProviderModels])];
}

async function loadConnectedModelList() {
  const list = await getConnectedModelList();

  if (list) {
    loadedModels = list.models || [];
    fileProviders = list.providers || [];
    connectedModelFile = list.file || '';

    if (list.providerModels) providerModelsFromFile = list.providerModels;
    if (list.latestProviderModels) latestProviderModels = list.latestProviderModels;
    if (list.latestModelsFileName) latestModelsFileName = list.latestModelsFileName;
    if (list.providerConfigFileName) providerConfigFileName = list.providerConfigFileName;

    const label = document.getElementById('modelFileLabel');

    if (label) {
      const latestCount = Object.values(latestProviderModels).reduce((sum, arr) => sum + arr.length, 0);
      const latestProviders = Object.keys(latestProviderModels).length;

      if (latestCount > 0) {
        label.textContent = `Model list connected: ${latestProviders} provider(s) / ${latestCount} model(s) — ${latestModelsFileName || '(unknown)'}`;
      } else if (connectedModelFile) {
        label.textContent = `Model list connected: ${fileProviders.length} provider(s) / ${loadedModels.length} model(s) — ${connectedModelFile}`;
      } else {
        label.textContent = 'No model list file connected. Load one to auto-connect it (like .env).';
      }
    }
  }
}

async function loadConnectedConfig(defaultConfig) {
  const result = await getConnectedConfig();

  if (result && result.fileName) {
    ultimateConfigFileName = result.fileName;
  }

  if (result && result.entries && result.entries.length > 0) {
    configEntries = result.entries.filter(e => providerInfo[e.provider]);
    await updateConfigLabel();
  } else {
    configEntries = [];

    if (!defaultConfig) {
      defaultConfig = await getDefaultConfig();
    }

    defaultConfig.forEach(providerGroup => {
      if (providerInfo[providerGroup.provider]) {
        providerGroup.models.forEach(modelName => {
          configEntries.push({
            provider: providerGroup.provider,
            baseURL: providerInfo[providerGroup.provider].baseURL,
            apiKeyEnv: providerInfo[providerGroup.provider].apiKeyEnv,
            model: modelName,
            enabled: true,
            authType: providerInfo[providerGroup.provider].authType || 'Bearer'
          });
        });
      }
    });

    const label = document.getElementById('configFileLabel');

    if (label) {
      label.textContent = 'No config file yet. Apply Configuration to create one.';
    }
  }
}

async function loadEnvVars() {
  envVars = await getEnvVars();
}

function getProvidersList() {
  return Object.keys(providerInfo);
}

function getEnvVarsList() {
  return envVars;
}

let _modelsForProviderCache = new Map();

function getModelsForProviderMemoized(provider) {
  if (_modelsForProviderCache.has(provider)) {
    return _modelsForProviderCache.get(provider);
  }

  const models = getModelsForProvider(provider);
  _modelsForProviderCache.set(provider, models);

  return models;
}

function buildRowHtml(entry, realIdx, displayIdx) {
  const providerModels = getModelsForProviderMemoized(entry.provider);
  const modelOptions = entry.model && !providerModels.includes(entry.model)
    ? [entry.model, ...providerModels]
    : providerModels;

  return `<td>${displayIdx + 1}</td>
<td><select class="provider-select" data-idx="${realIdx}">${getProvidersList().map(p => `<option value="${escapeHtml(p)}"${p === entry.provider ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('')}</select></td>
<td><input type="text" class="baseurl-input" data-idx="${realIdx}" value="${escapeHtml(entry.baseURL || '')}" readonly style="background:#f5f5f5;"></td>
<td><input type="text" class="apikey-input" data-idx="${realIdx}" value="${escapeHtml(entry.apiKeyEnv || '')}" readonly style="background:#f5f5f5;"></td>
<td><select class="model-input" data-idx="${realIdx}"><option value="">(None)</option>${modelOptions.map(m => `<option value="${escapeHtml(m)}"${m === entry.model ? ' selected' : ''}>${escapeHtml(m)}</option>`).join('')}</select></td>
<td><input type="checkbox" class="enabled-check" data-idx="${realIdx}"${entry.enabled ? ' checked' : ''}></td>
<td><button class="delete-btn" data-idx="${realIdx}">X</button></td>`;
}

function renderApiModelsTable() {
  _modelsForProviderCache = new Map();
  apiModelsTableBody.innerHTML = '';

  let displayIdx = 0;

  configEntries.forEach((entry, realIdx) => {
    if (entry.authType === 'Cookie') return;

    const row = document.createElement('tr');
    row.dataset.idx = realIdx;
    row.innerHTML = buildRowHtml(entry, realIdx, displayIdx);

    apiModelsTableBody.appendChild(row);
    displayIdx++;
  });
}

function renderCookieModelsTable() {
  _modelsForProviderCache = new Map();
  cookieModelsTableBody.innerHTML = '';

  let displayIdx = 0;

  configEntries.forEach((entry, realIdx) => {
    if (entry.authType !== 'Cookie') return;

    const row = document.createElement('tr');
    row.dataset.idx = realIdx;
    row.innerHTML = buildRowHtml(entry, realIdx, displayIdx);

    cookieModelsTableBody.appendChild(row);
    displayIdx++;
  });
}

function renderAllConfigTables() {
  renderApiModelsTable();
  renderCookieModelsTable();
}

let _configRenderScheduled = false;

function scheduleRenderAllConfigTables() {
  if (_configRenderScheduled) return;

  _configRenderScheduled = true;

  requestAnimationFrame(() => {
    setTimeout(() => {
      _configRenderScheduled = false;
      renderAllConfigTables();
    }, 0);
  });
}

let _priorityRenderScheduled = false;

function scheduleRenderPriorityOverrideDropdown() {
  if (_priorityRenderScheduled) return;

  _priorityRenderScheduled = true;

  requestAnimationFrame(() => {
    setTimeout(() => {
      _priorityRenderScheduled = false;
      renderPriorityOverrideDropdown();
    }, 0);
  });
}

const apiModelsTableBody = document.querySelector('#apiModelsTable tbody');
const cookieModelsTableBody = document.querySelector('#cookieModelsTable tbody');
const addEntryBtn = document.getElementById('addEntryBtn');
const saveConfigBtn = document.getElementById('saveConfigBtn');
const loadDefaultsBtn = document.getElementById('loadDefaultsBtn');
const clearAllBtn = document.getElementById('clearAllBtn');
const fetchModelsBtn = document.getElementById('fetchModelsBtn');
const loadConfigFromCsvBtn = document.getElementById('loadConfigFromCsvBtn');

function refreshConfigRow(realIdx) {
  const row = document.querySelector(`tr[data-idx="${realIdx}"]`);

  if (row && configEntries[realIdx]) {
    let displayIdx = 0;
    const tableBody = row.closest('tbody');

    if (tableBody) {
      displayIdx = Array.from(tableBody.querySelectorAll('tr')).indexOf(row);
    }

    row.innerHTML = buildRowHtml(configEntries[realIdx], realIdx, displayIdx);
  }
}

apiModelsTableBody.addEventListener('change', e => {
  const row = e.target.closest('tr');
  if (!row) return;

  const idx = Number(row.dataset.idx);
  if (Number.isNaN(idx) || !configEntries[idx]) return;

  if (e.target.classList.contains('provider-select')) {
    const selectedProvider = e.target.value;
    configEntries[idx].provider = selectedProvider;

    const info = providerInfo[selectedProvider];

    if (info) {
      configEntries[idx].baseURL = info.baseURL;
      configEntries[idx].apiKeyEnv = info.apiKeyEnv;
      configEntries[idx].authType = info.authType || 'Bearer';
    }

    scheduleRenderAllConfigTables();
  } else if (e.target.classList.contains('model-input')) {
    configEntries[idx].model = e.target.value;
  } else if (e.target.classList.contains('enabled-check')) {
    configEntries[idx].enabled = e.target.checked;
  }
});

apiModelsTableBody.addEventListener('click', e => {
  const deleteBtn = e.target.closest('.delete-btn');
  if (!deleteBtn) return;

  const row = deleteBtn.closest('tr');
  if (!row) return;

  const idx = Number(row.dataset.idx);
  if (Number.isNaN(idx)) return;

  configEntries.splice(idx, 1);
  scheduleRenderAllConfigTables();
});

cookieModelsTableBody.addEventListener('change', e => {
  const row = e.target.closest('tr');
  if (!row) return;

  const idx = Number(row.dataset.idx);
  if (Number.isNaN(idx) || !configEntries[idx]) return;

  if (e.target.classList.contains('provider-select')) {
    const selectedProvider = e.target.value;
    configEntries[idx].provider = selectedProvider;

    const info = providerInfo[selectedProvider];

    if (info) {
      configEntries[idx].baseURL = info.baseURL;
      configEntries[idx].apiKeyEnv = info.apiKeyEnv;
      configEntries[idx].authType = info.authType || 'Bearer';
    }

    scheduleRenderAllConfigTables();
  } else if (e.target.classList.contains('model-input')) {
    configEntries[idx].model = e.target.value;
  } else if (e.target.classList.contains('enabled-check')) {
    configEntries[idx].enabled = e.target.checked;
  }
});

cookieModelsTableBody.addEventListener('click', e => {
  const deleteBtn = e.target.closest('.delete-btn');
  if (!deleteBtn) return;

  const row = deleteBtn.closest('tr');
  if (!row) return;

  const idx = Number(row.dataset.idx);
  if (Number.isNaN(idx)) return;

  configEntries.splice(idx, 1);
  scheduleRenderAllConfigTables();
});

loadDefaultConfig();

onConfigReady(async ({ entries }) => {
  await refreshProviderInfo();

  configEntries = entries.filter(e => providerInfo[e.provider]);

  scheduleRenderAllConfigTables();
  scheduleRenderPriorityOverrideDropdown();

  console.log('Config table updated from main process:', configEntries.length, 'entries');
});

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    // Sub-tab buttons have their own handler; skip them here.
    if (btn.classList.contains('sub-tab-btn')) return;

    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

    btn.classList.add('active');
    document.getElementById(btn.dataset.tab + '-tab').classList.add('active');

    const configFooter = document.getElementById('configFooter');

    if (configFooter) {
      configFooter.style.display = btn.dataset.tab === 'config' ? 'block' : 'none';
    }

    if (btn.dataset.tab === 'usage') renderTokenUsage();
    if (btn.dataset.tab === 'assistant') loadAssistantConfigForm();
  });
});

document.querySelectorAll('.sub-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    // Scope to the enclosing top-level tab so independent sub-tab groups
    // don't clear each other's active state.
    const scope = btn.closest('.tab-content') || document;

    scope.querySelectorAll('.sub-tab-btn').forEach(b => b.classList.remove('active'));
    scope.querySelectorAll('.sub-tab-content').forEach(t => t.classList.remove('active'));

    btn.classList.add('active');

    const target = scope.querySelector('#' + btn.dataset.subtab + '-subtab');

    if (target) {
      target.classList.add('active');
    }
  });
});

const portInput = document.getElementById('portInput');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const serverAddress = document.getElementById('serverAddress');
const priorityModelSelect = document.getElementById('priorityModelSelect');

function priorityKeyOf(entry) {
  return `${entry.provider}::${entry.model}`;
}

async function renderPriorityOverrideDropdown() {
  if (!priorityModelSelect) return;

  let known;

  try {
    known = await getKnownOk();
  } catch (err) {
    return;
  }

  const entries = known || [];

  if (priorityOverrideKey && !entries.some(entry => priorityKeyOf(entry) === priorityOverrideKey)) {
    priorityOverrideKey = null;

    try {
      await setPriorityOverride(null);
    } catch (err) {}
  }

  const sorted = [...entries].sort((a, b) => {
    const aPinned = priorityKeyOf(a) === priorityOverrideKey;
    const bPinned = priorityKeyOf(b) === priorityOverrideKey;

    if (aPinned && !bPinned) return -1;
    if (bPinned && !aPinned) return 1;

    return (a.latency ?? Infinity) - (b.latency ?? Infinity);
  });

  priorityModelSelect.innerHTML = '<option value="">None (auto)</option>' + sorted.map(e => {
    const key = priorityKeyOf(e);
    const latencyLabel = typeof e.latency === 'number' ? String(e.latency) : 'N/A';

    return `<option value="${escapeHtml(key)}"${key === priorityOverrideKey ? ' selected' : ''}>${escapeHtml(e.provider)} / ${escapeHtml(e.model)} (${escapeHtml(latencyLabel)}ms)</option>`;
  }).join('');
}

priorityModelSelect?.addEventListener('change', async e => {
  const key = e.target.value || null;
  priorityOverrideKey = key;

  try {
    await setPriorityOverride(key);
  } catch (err) {}
});

function setServerStatus(running, port) {
  serverAddress.classList.remove('running', 'stopped');

  if (running) {
    serverAddress.textContent = `Server running at http://localhost:${port}/`;
    serverAddress.classList.add('running');
  } else {
    serverAddress.textContent = 'Server stopped';
    serverAddress.classList.add('stopped');
  }
}

connectBtn.addEventListener('click', async () => {
  const port = parseInt(portInput.value);
  if (!port) return;

  const activeEntries = configEntries.filter(e => e.enabled);
  const result = await startProxy(port, activeEntries);

  if (result.success) {
    setServerStatus(true, port);

    connectBtn.disabled = true;
    disconnectBtn.disabled = false;

    scheduleRenderPriorityOverrideDropdown();
  } else {
    showAppNotice('Failed to start proxy: ' + result.error, true);
  }
});

disconnectBtn.addEventListener('click', async () => {
  await stopProxy();

  setServerStatus(false);

  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
});

const connectedAppsCount = document.getElementById('connectedAppsCount');
const connectedAppsList = document.getElementById('connectedAppsList');

function renderConnectedApps(connectedApps) {
  if (!connectedAppsCount || !connectedAppsList) return;

  const clients = (connectedApps && connectedApps.clients) || [];

  connectedAppsCount.textContent = `Connected applications: ${connectedApps ? connectedApps.count : 0}`;

  if (clients.length === 0) {
    connectedAppsList.innerHTML = '<div class="connected-apps-empty">No applications connected.</div>';
    return;
  }

  connectedAppsList.innerHTML = clients.map(c => {
    return `<div class="connected-app-card">
  <div>
    <div class="app-name">${escapeHtml(c.appName)}</div>
    <div class="app-meta">
      In-flight: ${Number(c.activeRequests || 0)} · Total: ${Number(c.totalRequests || 0)} · Errors: ${Number(c.errorCount || 0)}
      ${c.lastModel ? ` · Last: ${escapeHtml(c.lastProvider || '')}/${escapeHtml(c.lastModel)}` : ''}
      ${c.lastActivity ? ` · Last activity: ${escapeHtml(c.lastActivity)}` : ''}
    </div>
  </div>
  <span class="connected-app-status ${escapeHtml(c.status)}">${escapeHtml(c.status)}</span>
</div>`;
  }).join('');
}

async function pollProxyStats() {
  try {
    const stats = await window.api.getProxyStats();
    renderConnectedApps(stats && stats.connectedApps);
  } catch (err) {
    // proxy not running yet, or IPC not ready — ignore
  }
}

pollProxyStats();
setInterval(pollProxyStats, 3000);

const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendBtn.click();
  }
});

sendBtn.addEventListener('click', async () => {
  const text = chatInput.value.trim();
  if (!text) return;

  addMessage('user', text);
  chatInput.value = '';

  const running = await isProxyRunning();

  if (!running) {
    addMessage('assistant', 'Proxy is not running.');
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    let resp;

    try {
      resp = await fetch(`http://localhost:${portInput.value}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: text }],
          max_tokens: 200
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const data = await resp.json();

    const message = data.choices?.[0]?.message;
    const finishReason = data.choices?.[0]?.finish_reason;
    const meta = data._meta || null;

    if (message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const toolCallLines = message.tool_calls.map(tc => {
        const name = tc.function?.name || 'unknown';
        const args = tc.function?.arguments || '{}';

        return `[TOOL_CALL] ${name}(${args})`;
      });

      addMessage('assistant', toolCallLines.join('\n'), meta);
    } else {
      const content = message?.content || '';
      const textContent = typeof content === 'string' ? content : JSON.stringify(content);

      if (textContent && textContent.trim()) {
        addMessage('assistant', textContent, meta);
      } else if (data.error) {
        addMessage('assistant', `Model error: ${data.error.message || data.error}`);
      } else {
        const raw = JSON.stringify(data).substring(0, 300);
        addMessage('assistant', `No usable content (HTTP ${resp.status}). Response: ${raw}`);
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      addMessage('assistant', 'Request timed out after 60s.');
    } else {
      addMessage('assistant', 'Error: ' + e.message);
    }
  }
});

const devLogs = document.getElementById('devLogs');
const clearLogsBtn = document.getElementById('clearLogsBtn');

onDevLog(({ level, text, time }) => {
  const line = document.createElement('div');
  line.textContent = `[${time}] ${text}`;

  if (level === 'error') {
    line.classList.add('log-error');
  } else if (level === 'warn') {
    line.classList.add('log-warn');
  } else if (text.includes(window.api.logSuccessMarker)) {
    line.classList.add('log-success');
  }

  devLogs.appendChild(line);

  while (devLogs.children.length > 500) {
    devLogs.removeChild(devLogs.firstChild);
  }

  devLogs.scrollTop = devLogs.scrollHeight;
});

clearLogsBtn.addEventListener('click', () => {
  devLogs.innerHTML = '';
});

// --- Request / Response Logs ---
const requestLogsList = document.getElementById('requestLogsList');
const responseLogsList = document.getElementById('responseLogsList');
const reqResLogFilterInput = document.getElementById('reqResLogFilterInput');
const clearReqResLogsBtn = document.getElementById('clearReqResLogsBtn');
const reqResLiveTailToggle = document.getElementById('reqResLiveTailToggle');

let requestLogEntries = [];
let responseLogEntries = [];

const MAX_REQ_RES_ENTRIES = 500;

function matchesFilter(entry, filterText) {
  if (!filterText) return true;

  return JSON.stringify(entry).toLowerCase().includes(filterText.toLowerCase());
}

function renderLogList(container, entries, kind) {
  if (!container) return;

  const filterText = reqResLogFilterInput ? reqResLogFilterInput.value.trim() : '';
  const filtered = entries.filter(e => matchesFilter(e, filterText));

  if (filtered.length === 0) {
    container.innerHTML = '<div style="color:#888; font-style: italic;">No matching entries.</div>';
    return;
  }

  container.innerHTML = filtered.map(e => {
    const isError = kind === 'response' && (e.error || (e.status && e.status >= 400));

    const summary = kind === 'request'
      ? `[${e.time}] ${e.provider}/${e.model} → ${e.method} ${e.url} (${e.payloadSize}b, ~${e.tokenEstimate} tok)`
      : `[${e.time}] ${e.provider}/${e.model} ← ${e.status ?? 'ERR'} (${e.latency}ms)${e.error ? ' — ' + e.error : ''}`;

    return `<details class="req-res-log-entry ${isError ? 'status-error' : 'status-ok'}">
  <summary>${escapeHtml(summary)}</summary>
  <pre>${escapeHtml(JSON.stringify(e, null, 2))}</pre>
</details>`;
  }).join('');
}

function renderReqResLogs() {
  renderLogList(requestLogsList, requestLogEntries, 'request');
  renderLogList(responseLogsList, responseLogEntries, 'response');
}

reqResLogFilterInput?.addEventListener('input', renderReqResLogs);

clearReqResLogsBtn?.addEventListener('click', () => {
  requestLogEntries = [];
  responseLogEntries = [];

  renderReqResLogs();
});

onDevLog(({ text }) => {
  const liveTail = reqResLiveTailToggle ? reqResLiveTailToggle.checked : true;

  let changed = false;

  if (window.api.logRequestMarker && text.startsWith(window.api.logRequestMarker)) {
    try {
      requestLogEntries.push(JSON.parse(text.slice(window.api.logRequestMarker.length).trim()));

      if (requestLogEntries.length > MAX_REQ_RES_ENTRIES) {
        requestLogEntries.shift();
      }

      changed = true;
    } catch (e) {
      // malformed line, ignore
    }
  } else if (window.api.logResponseMarker && text.startsWith(window.api.logResponseMarker)) {
    try {
      responseLogEntries.push(JSON.parse(text.slice(window.api.logResponseMarker.length).trim()));

      if (responseLogEntries.length > MAX_REQ_RES_ENTRIES) {
        responseLogEntries.shift();
      }

      changed = true;
    } catch (e) {
      // malformed line, ignore
    }
  }

  if (changed && liveTail) {
    renderReqResLogs();
  }
});

function addMessage(role, content, meta) {
  const div = document.createElement('div');
  const time = new Date().toLocaleTimeString();

  const safeContent = escapeHtml(content);

  if (role === 'assistant' && meta) {
    div.innerHTML = `<strong>[${time}] ${role}:</strong> ${safeContent}<div class="chat-meta"><span class="meta-provider">${escapeHtml(meta.provider)}</span> / ${escapeHtml(meta.model)} · ${Number(meta.elapsed || 0)}ms</div>`;
  } else {
    div.innerHTML = `<strong>[${time}] ${role}:</strong> ${safeContent}`;
  }

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

addEntryBtn.addEventListener('click', () => {
  const providers = getProvidersList();
  const firstProvider = providers.length > 0 ? providers[0] : 'Custom';

  configEntries.push({
    provider: firstProvider,
    baseURL: providerInfo[firstProvider]?.baseURL || '',
    apiKeyEnv: providerInfo[firstProvider]?.apiKeyEnv || '',
    model: '',
    enabled: true,
    authType: providerInfo[firstProvider]?.authType || 'Bearer'
  });

  scheduleRenderAllConfigTables();
});

loadDefaultsBtn.addEventListener('click', () => {
  const cookieEntries = configEntries.filter(e => e.authType === 'Cookie');
  configEntries = [];

  const providers = getProvidersList();

  providers.forEach(provider => {
    const info = providerInfo[provider];

    const fileModels = providerModelsFromFile[provider] || [];
    const fallbackModels = info?.models || [];
    const models = fileModels.length > 0 ? fileModels : fallbackModels;

    models.forEach(modelName => {
      if (!modelName) return;

      configEntries.push({
        provider,
        baseURL: info?.baseURL || '',
        apiKeyEnv: info?.apiKeyEnv || '',
        model: modelName,
        enabled: true,
        authType: info?.authType || 'Bearer'
      });
    });
  });

  configEntries = [...configEntries, ...cookieEntries];

  scheduleRenderAllConfigTables();
});

clearAllBtn.addEventListener('click', () => {
  configEntries = configEntries.filter(e => e.authType === 'Cookie');

  scheduleRenderAllConfigTables();
});

fetchModelsBtn.addEventListener('click', async () => {
  const modal = document.getElementById('fetchModal');
  modal.style.display = 'flex';

  const proceedBtn = document.getElementById('fetchModalProceed');
  const cancelBtn = document.getElementById('fetchModalCancel');

  const cleanup = () => {
    modal.style.display = 'none';
  };

  cancelBtn.onclick = cleanup;

  proceedBtn.onclick = async () => {
    cleanup();

    const progressBar = document.getElementById('fetchProgressBar');

    if (progressBar) {
      progressBar.style.display = 'inline-block';
    }

    try {
      const result = await runFetchModels();

      if (progressBar) {
        progressBar.style.display = 'none';
      }

      if (!result.success) {
        showAppNotice('Failed to fetch models: ' + (result.error || 'Unknown error'), true);
        return;
      }

      const entries = result.entries || [];

      if (entries.length === 0) {
        showAppNotice('No models were fetched.', true);
        return;
      }

      latestProviderModels = {};

      entries.forEach(e => {
        if (!latestProviderModels[e.provider]) {
          latestProviderModels[e.provider] = [];
        }

        latestProviderModels[e.provider].push(e.model);
      });

      configEntries = entries.map(e => {
        const info = providerInfo[e.provider];

        return {
          provider: e.provider,
          baseURL: info?.baseURL || '',
          apiKeyEnv: info?.apiKeyEnv || '',
          model: e.model,
          enabled: true,
          authType: info?.authType || 'Bearer'
        };
      });

      const saveResult = await saveConfig(configEntries);

      if (saveResult.success) {
        const modelLabel = document.getElementById('modelFileLabel');

        if (modelLabel) {
          const totalModels = Object.values(latestProviderModels).reduce((sum, arr) => sum + arr.length, 0);
          const totalProviders = Object.keys(latestProviderModels).length;

          modelLabel.textContent = `Model list connected: ${totalProviders} provider(s) / ${totalModels} model(s) — ${latestModelsFileName || '(unknown)'}`;
        }

        scheduleRenderAllConfigTables();
        await updateConfigLabel();

        showAppNotice(`Loaded ${configEntries.length} model entries from ${latestModelsFileName || '(unknown)'}.`);
      } else {
        showAppNotice('Failed to save config: ' + saveResult.error, true);
      }
    } catch (err) {
      if (progressBar) {
        progressBar.style.display = 'none';
      }

      showAppNotice('Error fetching models: ' + err.message, true);
    }
  };
});

loadConfigFromCsvBtn?.addEventListener('click', async () => {
  const result = await openConfigFileDialog();

  if (result.canceled || !result.filePath) return;

  let loadResult;
  const ext = result.filePath.toLowerCase();

  if (ext.endsWith('.csv')) {
    loadResult = await parseConfigCsvFile(result.filePath);
  } else {
    loadResult = await parseConfigExcelFile(result.filePath);
  }

  if (loadResult && loadResult.success) {
    configEntries = loadResult.entries.map(entry => {
      const info = providerInfo[entry.provider];

      if (info) {
        return {
          ...entry,
          baseURL: info.baseURL,
          apiKeyEnv: info.apiKeyEnv,
          authType: info.authType || entry.authType || 'Bearer'
        };
      }

      return entry;
    });

    const saveResult = await saveConfig(configEntries);

    if (saveResult.success) {
      scheduleRenderAllConfigTables();
      await updateConfigLabel();

      showAppNotice(`Loaded ${configEntries.length} config entries from ${result.filePath}.`);
    } else {
      showAppNotice('Failed to save config: ' + saveResult.error, true);
    }
  } else {
    showAppNotice('Failed to load file: ' + (loadResult ? loadResult.error : 'Unknown error'), true);
  }
});

async function updateConfigLabel() {
  const label = document.getElementById('configFileLabel');

  if (label) {
    const enabledCount = configEntries.filter(e => e.enabled).length;
    label.textContent = `Config: ${enabledCount}/${configEntries.length} enabled - ${ultimateConfigFileName || '(unknown)'}`;
  }
}

saveConfigBtn.addEventListener('click', async () => {
  try {
    const saveResult = await saveConfig(configEntries);

    if (!saveResult.success) {
      showAppNotice('Failed to save config file: ' + saveResult.error, true);
      return;
    }

    await updateConfigLabel();

    const running = await isProxyRunning();

    if (running) {
      const port = parseInt(portInput.value);
      const activeEntries = configEntries.filter(e => e.enabled);
      const result = await startProxy(port, activeEntries);

      if (result.success) {
        console.log('Configuration applied. Proxy restarted.');
        showAppNotice('Configuration applied. Proxy restarted.');
      } else {
        showAppNotice('Failed to apply configuration: ' + result.error, true);
      }
    } else {
      console.log('Configuration saved.');
      showAppNotice('Configuration saved.');
    }
  } catch (err) {
    showAppNotice('Error applying configuration: ' + err.message, true);
  }
});

const pingAllBtn = document.getElementById('pingAllBtn');
const pingSummary = document.getElementById('pingSummary');

pingAllBtn.addEventListener('click', async () => {
  const activeEntries = configEntries.filter(e => e.enabled);

  if (activeEntries.length === 0) {
    pingSummary.innerHTML = '<strong>No enabled entries to ping.</strong>';
    return;
  }

  pingSummary.innerHTML = '<strong>Pinging...</strong>';

  const okLog = document.getElementById('healthOkLog');
  const failLog = document.getElementById('healthFailLog');

  if (okLog) okLog.value = 'Checking...\n';
  if (failLog) failLog.value = '';

  try {
    const results = await healthCheck(activeEntries);

    const okResults = results.filter(r => r.status === 'OK');
    const failResults = results.filter(r => r.status !== 'OK');

    if (okLog) {
      okLog.value = okResults.map(r => `${r.provider}\t${r.model}\tOK\t${r.latency || 'N/A'}ms`).join('\n');
    }

    if (failLog) {
      failLog.value = failResults.map(r => `${r.provider}\t${r.model}\t${r.status}\t${r.latency || 'N/A'}ms${r.reason ? ' — ' + r.reason : ''}`).join('\n');
    }

    pingSummary.innerHTML = `<strong>Total OK: ${okResults.length} | Total Failed: ${failResults.length}</strong>`;

    scheduleRenderPriorityOverrideDropdown();
  } catch (err) {
    pingSummary.innerHTML = `<strong>Health check failed: ${escapeHtml(err.message)}</strong>`;
  }
});

const refreshUsageBtn = document.getElementById('refreshUsageBtn');
const usageTableBody = document.querySelector('#usageTable tbody');
const usageSummary = document.getElementById('usageSummary');

async function renderTokenUsage() {
  const usage = await window.api.getTokenUsage();

  usageTableBody.innerHTML = '';

  if (!usage || usage.length === 0) {
    usageSummary.innerHTML = '<strong>No token usage recorded yet.</strong>';
    return;
  }

  let totalRequests = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalTokens = 0;
  let totalEstimatedRequests = 0;

  usage.forEach((u, i) => {
    const estimatedRequests = u.estimatedRequests || 0;

    const estimatedLabel = estimatedRequests === 0
      ? 'No'
      : estimatedRequests === u.requests
        ? 'Yes (est.)'
        : `Partial (${estimatedRequests}/${u.requests})`;

    const row = document.createElement('tr');

    row.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(u.provider)}</td><td>${escapeHtml(u.model)}</td><td>${Number(u.requests || 0)}</td><td>${Number(u.promptTokens || 0).toLocaleString()}</td><td>${Number(u.completionTokens || 0).toLocaleString()}</td><td><strong>${Number(u.totalTokens || 0).toLocaleString()}</strong></td><td>${escapeHtml(estimatedLabel)}</td><td style="color:#888;">N/A (no price table)</td>`;

    usageTableBody.appendChild(row);

    totalRequests += u.requests;
    totalPrompt += u.promptTokens;
    totalCompletion += u.completionTokens;
    totalTokens += u.totalTokens;
    totalEstimatedRequests += estimatedRequests;
  });

  usageSummary.innerHTML = `<strong>Models: ${usage.length} | Requests: ${totalRequests} (${totalEstimatedRequests} estimated) | Prompt: ${totalPrompt.toLocaleString()} | Completion: ${totalCompletion.toLocaleString()} | Total: ${totalTokens.toLocaleString()} | Est. Cost: N/A (no price table)</strong>`;
}

refreshUsageBtn.addEventListener('click', renderTokenUsage);

// --- Assistant Config tab ---
const systemPromptOverrideInput = document.getElementById('systemPromptOverrideInput');
const toolCallEmulationToggle = document.getElementById('toolCallEmulationToggle');
const previewToolFormatBtn = document.getElementById('previewToolFormatBtn');
const toolFormatPreview = document.getElementById('toolFormatPreview');
const routingModeSelect = document.getElementById('routingModeSelect');
const retryCountInput = document.getElementById('retryCountInput');
const timeoutMsInput = document.getElementById('timeoutMsInput');
const loggingVerbositySelect = document.getElementById('loggingVerbositySelect');
const largeContextModeToggle = document.getElementById('largeContextModeToggle');
const largeContextThresholdInput = document.getElementById('largeContextThresholdInput');
const largeContextChunkTokensInput = document.getElementById('largeContextChunkTokensInput');
const largeContextConcurrencyDefaultInput = document.getElementById('largeContextConcurrencyDefaultInput');
const largeContextConcurrencyCookieInput = document.getElementById('largeContextConcurrencyCookieInput');
const saveAssistantConfigBtn = document.getElementById('saveAssistantConfigBtn');

let assistantConfigLoaded = false;

async function loadAssistantConfigForm() {
  try {
    const config = await window.api.getAssistantConfig();

    if (systemPromptOverrideInput) systemPromptOverrideInput.value = config.systemPromptOverride || '';
    if (toolCallEmulationToggle) toolCallEmulationToggle.checked = config.toolCallEmulation !== false;
    if (routingModeSelect) routingModeSelect.value = config.routingMode || 'auto';
    if (retryCountInput) retryCountInput.value = config.retryCount ?? 0;
    if (timeoutMsInput) timeoutMsInput.value = config.timeoutMs ?? 30000;
    if (loggingVerbositySelect) loggingVerbositySelect.value = config.loggingVerbosity || 'normal';
    if (largeContextModeToggle) largeContextModeToggle.checked = !!config.largeContextMode;
    if (largeContextThresholdInput) largeContextThresholdInput.value = config.largeContextThreshold ?? 100000;
    if (largeContextChunkTokensInput) largeContextChunkTokensInput.value = config.largeContextChunkTokens ?? 20000;

    const concurrency = config.largeContextConcurrency || { default: 5, cookie: 1 };

    if (largeContextConcurrencyDefaultInput) largeContextConcurrencyDefaultInput.value = concurrency.default ?? 5;
    if (largeContextConcurrencyCookieInput) largeContextConcurrencyCookieInput.value = concurrency.cookie ?? 1;

    assistantConfigLoaded = true;
  } catch (err) {
    console.warn('Could not load assistant config:', err.message);
  }
}

saveAssistantConfigBtn?.addEventListener('click', async () => {
  const config = {
    systemPromptOverride: systemPromptOverrideInput ? systemPromptOverrideInput.value : '',
    toolCallEmulation: toolCallEmulationToggle ? toolCallEmulationToggle.checked : true,
    routingMode: routingModeSelect ? routingModeSelect.value : 'auto',
    retryCount: retryCountInput ? Math.max(0, parseInt(retryCountInput.value, 10) || 0) : 0,
    timeoutMs: timeoutMsInput ? Math.max(1000, parseInt(timeoutMsInput.value, 10) || 30000) : 30000,
    loggingVerbosity: loggingVerbositySelect ? loggingVerbositySelect.value : 'normal',
    largeContextMode: largeContextModeToggle ? largeContextModeToggle.checked : false,
    largeContextThreshold: largeContextThresholdInput ? Math.max(1000, parseInt(largeContextThresholdInput.value, 10) || 100000) : 100000,
    largeContextChunkTokens: largeContextChunkTokensInput ? Math.max(1000, parseInt(largeContextChunkTokensInput.value, 10) || 20000) : 20000,
    largeContextConcurrency: {
      default: largeContextConcurrencyDefaultInput ? Math.max(1, parseInt(largeContextConcurrencyDefaultInput.value, 10) || 5) : 5,
      cookie: largeContextConcurrencyCookieInput ? Math.max(1, parseInt(largeContextConcurrencyCookieInput.value, 10) || 1) : 1
    }
  };

  try {
    const result = await window.api.saveAssistantConfig(config);

    if (result.success) {
      showAppNotice('Assistant config saved. Changes apply to new requests immediately.');
    } else {
      showAppNotice('Failed to save assistant config: ' + result.error, true);
    }
  } catch (err) {
    showAppNotice('Error saving assistant config: ' + err.message, true);
  }
});

previewToolFormatBtn?.addEventListener('click', async () => {
  if (!toolFormatPreview) return;

  toolFormatPreview.style.display = 'block';
  toolFormatPreview.textContent = 'Loading preview…';

  try {
    const result = await window.api.previewToolFormat();

    toolFormatPreview.textContent = result.success
      ? JSON.stringify(result.preview, null, 2)
      : `Preview failed: ${result.error}`;
  } catch (err) {
    toolFormatPreview.textContent = `Preview failed: ${err.message}`;
  }
});

const addWebProviderBtn = document.getElementById('addWebProviderBtn');
const webProviderModal = document.getElementById('webProviderModal');
const webProviderPresetSelect = document.getElementById('webProviderPresetSelect');
const webProviderNameInput = document.getElementById('webProviderNameInput');
const webProviderUrlInput = document.getElementById('webProviderUrlInput');
const webProviderCookieInput = document.getElementById('webProviderCookieInput');
const webProviderModalProceed = document.getElementById('webProviderModalProceed');
const webProviderModalCancel = document.getElementById('webProviderModalCancel');

let webProviderPresets = {};

async function loadWebProviderPresets() {
  try {
    const presets = await window.api.getWebProviderPresets();
    webProviderPresets = presets || {};

    const presetKeys = Object.keys(webProviderPresets);

    if (webProviderPresetSelect) {
      webProviderPresetSelect.innerHTML = '<option value="">— Custom —</option>' +
        presetKeys.map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('');
    }

    const clearSelect = document.getElementById('clearWebProviderSelect');

    if (clearSelect) {
      const current = clearSelect.value;

      clearSelect.innerHTML = presetKeys.map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('') || '<option value="Qwen">Qwen</option>';

      if (presetKeys.includes(current)) {
        clearSelect.value = current;
      }
    }
  } catch (err) {
    console.warn('Could not load web provider presets:', err.message);
  }
}

function showWebProviderStatus(html) {
  const status = document.getElementById('webProviderModalStatus');

  if (status) {
    status.innerHTML = html;
    status.style.display = 'block';
  }
}

function showWebProviderForm() {
  const form = document.getElementById('webProviderModalForm');
  const status = document.getElementById('webProviderModalStatus');

  if (form) form.style.display = 'block';
  if (status) status.style.display = 'none';
}

addWebProviderBtn?.addEventListener('click', () => {
  webProviderNameInput.value = 'Qwen';
  webProviderUrlInput.value = 'https://chat.qwen.ai/';
  webProviderCookieInput.value = '';

  if (webProviderPresetSelect) {
    webProviderPresetSelect.value = 'Qwen';
  }

  webProviderModal.style.display = 'flex';

  showWebProviderForm();

  webProviderModalProceed.style.display = '';
  webProviderModalCancel.style.display = '';

  webProviderModalProceed.disabled = false;
  webProviderModalCancel.disabled = false;

  webProviderNameInput.focus();

  toggleCookieField();
});

webProviderModalCancel?.addEventListener('click', () => {
  webProviderModal.style.display = 'none';
});

webProviderPresetSelect?.addEventListener('change', () => {
  const preset = webProviderPresets[webProviderPresetSelect.value];

  if (preset) {
    webProviderNameInput.value = webProviderPresetSelect.value;
    webProviderUrlInput.value = preset.loginUrl;
  }
});

function toggleCookieField() {
  if (webProviderCookieInput) {
    webProviderCookieInput.style.display = 'block';
  }
}

webProviderNameInput?.addEventListener('input', () => {
  if (webProviderPresetSelect && webProviderPresets[webProviderNameInput.value.trim()]) {
    webProviderPresetSelect.value = webProviderNameInput.value.trim();
    webProviderUrlInput.value = webProviderPresets[webProviderNameInput.value.trim()].loginUrl;
  }
});

webProviderModalProceed?.addEventListener('click', async () => {
  const name = webProviderNameInput.value.trim();
  const url = webProviderUrlInput.value.trim();

  if (!name || !url) {
    showAppNotice('Please enter both a provider name and a login URL.', true);
    return;
  }

  const useAutoRetrieve = webProviderCookieInput.value.trim().length === 0;

  showWebProviderForm();

  showWebProviderStatus(useAutoRetrieve
    ? `<h3>Setting up ${escapeHtml(name)}...</h3><p>A browser window will open. Please log in and send <strong>ONE</strong> test message in the chat.</p><p>The script is listening for the chat API request. This may take up to 2 minutes.</p><div class="progress-bar-container" style="width: 100%; margin-top: 15px;"><div class="progress-bar-fill" style="width: 100%; animation: progress-indeterminate 1.5s ease-in-out infinite;"></div></div><p style="font-size: 12px; color: #666; margin-top: 10px;">Do not close the browser window or this app.</p>`
    : `<h3>Saving ${escapeHtml(name)} cookie…</h3><p>Storing the pasted cookie (no browser opened, no ping performed).</p>`);

  webProviderModalProceed.disabled = true;
  webProviderModalCancel.disabled = true;

  try {
    const result = useAutoRetrieve
      ? await window.api.runWebProviderSetup(name, url)
      : await window.api.setProviderCookie(name, webProviderCookieInput.value.trim());

    if (result.success) {
      showWebProviderStatus(`<h3>✅ Success!</h3><p>Web provider added.</p><p style="font-size:13px;color:#666;">${escapeHtml(name)} has been added to your config (model "${escapeHtml(name + '-chat')}"). Restart the proxy to pick it up.</p><button id="webProviderModalClose" style="margin-top:12px;padding:6px 14px;">Close</button>`);

      document.getElementById('webProviderModalClose')?.addEventListener('click', () => {
        webProviderModal.style.display = 'none';
      });
    } else {
      showAppNotice('Failed: ' + (result.error || 'Unknown error'), true);

      showWebProviderForm();

      webProviderModalProceed.disabled = false;
      webProviderModalCancel.disabled = false;
    }
  } catch (err) {
    showAppNotice('Failed: ' + (err.message || 'Unknown error'), true);

    showWebProviderForm();

    webProviderModalProceed.disabled = false;
    webProviderModalCancel.disabled = false;
  }
});

const clearWebProviderSessionBtn = document.getElementById('clearWebProviderSessionBtn');

clearWebProviderSessionBtn?.addEventListener('click', () => {
  const providerName = document.getElementById('clearWebProviderSelect')?.value || 'Qwen';

  if (document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }

  requestAnimationFrame(() => {
    setTimeout(() => {
      showConfirmDialog(
        `Are you sure you want to clear all stored ${providerName} cookies and session data?`,
        async (ok) => {
          if (!ok) return;

          try {
            const result = await window.api.clearWebProviderSession(providerName);

            if (result.success) {
              showAppNotice(`${providerName} session cleared. Please use "Add Web Provider" to log in again.`);
            } else {
              showAppNotice(`Failed to clear ${providerName} session: ${result.error}`, true);
            }
          } catch (err) {
            showAppNotice(`Failed to clear ${providerName} session: ${err.message}`, true);
          }
        }
      );
    }, 50);
  });
});

loadWebProviderPresets();
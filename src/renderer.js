const { startProxy, stopProxy, isProxyRunning, healthCheck, getDefaultConfig, getEnvVars, getConnectedModelList, getConnectedConfig, getProviderConfig, saveConfig, openConfigFileDialog, parseConfigCsvFile, parseConfigExcelFile, onDevLog, runFetchModels, onConfigReady, setPriorityOverride, getKnownOk } = window.api;

// Priority override dropdown in Proxy Control tab
let priorityOverrideKey = null; // Track current priority selection

let configEntries = [];
let envVars = [];
let loadedModels = [];
let fileProviders = [];
let defaultModels = [];
let providerInfo = {}; // Map: provider name -> { baseURL, apiKeyEnv, models: [] }
let latestProviderModels = {}; // Map: provider -> models from LatestModels.csv (primary)
let providerModelsFromFile = {}; // Map: provider -> models from connected model list file (fallback)
let connectedModelFile = ''; // Module scope - declared here to match main.js pattern
let latestModelsFileName = 'LatestModels.csv';   // Fallback label until main process reports the real basename
let providerConfigFileName = 'ProviderConfig.csv'; // Fallback label until main process reports the real basename
let ultimateConfigFileName = 'UltimateConfig.csv'; // Fallback label until main process reports the real basename

// Load default config asynchronously
async function loadDefaultConfig() {
  // Pull the real default file basenames from the main process (derived from
  // state-store.js's DEFAULT_PATHS) before any UI renders, instead of relying
  // on the hardcoded literals above, so a filename change there propagates
  // here automatically.
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

  // ProviderConfig.csv is the source of truth for available providers
  const providerConfig = await getProviderConfig();
  providerInfo = {};
  if (Object.keys(providerConfig).length > 0) {
    Object.entries(providerConfig).forEach(([provider, info]) => {
      providerInfo[provider] = { baseURL: info.baseURL, apiKeyEnv: info.apiKeyEnv, models: [] };
    });
  }

  // Load default catalog (models-config.js) — only add models to providers that exist in ProviderConfig.csv
  const defaultConfig = await getDefaultConfig();
  defaultModels = [];
  defaultConfig.forEach(providerGroup => {
    providerGroup.models.forEach(modelName => {
      defaultModels.push(modelName);
    });
    if (providerInfo[providerGroup.provider]) {
      providerInfo[providerGroup.provider].models = providerGroup.models;
    }
  });

  await loadEnvVars();
  await loadConnectedModelList();
  if (Object.keys(providerConfig).length > 0) {
    console.log(`Loaded provider config from ${providerConfigFileName}:`, Object.keys(providerConfig).length, 'providers');
  }
  await loadConnectedConfig(defaultConfig);
  renderConfigTable();

  // Populate the Priority Model dropdown from any known-OK state already on
  // disk, so restored routing data is reflected immediately at startup
  // instead of staying empty until the user reconnects or re-pings.
  renderPriorityOverrideDropdown();
}

// Get models for a specific provider (LatestModels.csv primary, model list file fallback, default config fallback)
function getModelsForProvider(provider) {
  const latestModels = latestProviderModels[provider] || [];
  const fileModels = providerModelsFromFile[provider] || [];
  const defaultProviderModels = providerInfo[provider]?.models || [];
  return [...new Set([...latestModels, ...fileModels, ...defaultProviderModels])];
}

// Auto-connect the model list file (like .env) - no manual load needed
async function loadConnectedModelList() {
  const list = await getConnectedModelList();
  if (list) {
    loadedModels = list.models || [];
    fileProviders = list.providers || [];
    connectedModelFile = list.file || '';
    // Build provider -> models map from the file data
    if (list.providerModels) {
      providerModelsFromFile = list.providerModels;
    }
    // LatestModels.csv data (primary source for model dropdown)
    if (list.latestProviderModels) {
      latestProviderModels = list.latestProviderModels;
    }
    if (list.latestModelsFileName) latestModelsFileName = list.latestModelsFileName;
    if (list.providerConfigFileName) providerConfigFileName = list.providerConfigFileName;
    const label = document.getElementById('modelFileLabel');
    if (label) {
      const latestCount = Object.values(latestProviderModels).reduce((sum, arr) => sum + arr.length, 0);
      const latestProviders = Object.keys(latestProviderModels).length;
      if (latestCount > 0) {
        label.textContent = `Model list connected: ${latestProviders} provider(s) / ${latestCount} model(s) — ${latestModelsFileName}`;
      } else if (connectedModelFile) {
        label.textContent = `Model list connected: ${fileProviders.length} provider(s) / ${loadedModels.length} model(s) — ${connectedModelFile}`;
      } else {
        label.textContent = 'No model list file connected. Load one to auto-connect it (like .env).';
      }
    }
  }
}

// Auto-connect the config file (source of truth for proxy entries)
// Entries for providers not in ProviderConfig.csv are pruned automatically.
async function loadConnectedConfig(defaultConfig) {
  const result = await getConnectedConfig();
  if (result && result.fileName) ultimateConfigFileName = result.fileName;
  if (result && result.entries && result.entries.length > 0) {
    // Only keep entries whose provider exists in ProviderConfig.csv
    configEntries = result.entries.filter(e => providerInfo[e.provider]);
    await updateConfigLabel();
  } else {
    // Fallback: build from default catalog, but only for providers in ProviderConfig.csv
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
            enabled: true
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

// Load environment variables from .env file
async function loadEnvVars() {
  envVars = await getEnvVars();
}

// Get providers list for dropdown (only providers from ProviderConfig.csv)
function getProvidersList() {
  return Object.keys(providerInfo);
}

// Get env vars list for the API Key dropdown
function getEnvVarsList() {
  return envVars;
}

// Memoization cache for getModelsForProvider, valid for a single render pass.
// renderConfigTable() resets this at the start of each full render; row-level
// updates that don't change `entry.provider` reuse the cached value instead of
// recomputing the Set union for every row.
let _modelsForProviderCache = new Map();
function getModelsForProviderMemoized(provider) {
  if (_modelsForProviderCache.has(provider)) return _modelsForProviderCache.get(provider);
  const models = getModelsForProvider(provider);
  _modelsForProviderCache.set(provider, models);
  return models;
}

// Build the innerHTML for a single config row. `entry.model` is always included
// as an option even if it isn't in getModelsForProvider()'s list, so an imported
// or previously-saved model is never shown as "(None)".
function buildRowHtml(entry, idx) {
  const providerModels = getModelsForProviderMemoized(entry.provider);
  const modelOptions = entry.model && !providerModels.includes(entry.model)
    ? [entry.model, ...providerModels]
    : providerModels;
  return `
    <td>${idx+1}</td>
    <td>
      <select class="provider-select" data-idx="${idx}">
        ${getProvidersList().map(p => `<option value="${p}" ${p===entry.provider?'selected':''}>${p}</option>`).join('')}
      </select>
    </td>
    <td>
      <input type="text" class="baseurl-input" data-idx="${idx}" value="${entry.baseURL || ''}" readonly style="background:#f5f5f5;">
    </td>
    <td>
      <input type="text" class="apikey-input" data-idx="${idx}" value="${entry.apiKeyEnv || ''}" readonly style="background:#f5f5f5;">
    </td>
    <td>
      <select class="model-input" data-idx="${idx}">
        <option value="">(None)</option>
        ${modelOptions.map(m => `<option value="${m}" ${m===entry.model?'selected':''}>${m}</option>`).join('')}
      </select>
    </td>
    <td><input type="checkbox" class="enabled-check" data-idx="${idx}" ${entry.enabled?'checked':''}></td>
    <td><button class="delete-btn" data-idx="${idx}">X</button></td>
  `;
}

// Render the configuration table with dropdowns. Full rebuild — used on load,
// add, delete, and provider change (since provider change repopulates the
// model <select> options for that row). Toggle/model/delete are otherwise
// handled without a full rebuild via the delegated listener below.
function renderConfigTable() {
  _modelsForProviderCache = new Map();
  configTableBody.innerHTML = '';
  configEntries.forEach((entry, idx) => {
    const row = document.createElement('tr');
    row.dataset.idx = idx;
    row.innerHTML = buildRowHtml(entry, idx);
    configTableBody.appendChild(row);
  });
}

// DOM element references used by the table below and by loadDefaultConfig()
// (called at page load, further down this file). These must be declared
// before any code that reads them runs — moved up from their original
// position near the bottom of the file, which threw a
// "Cannot access 'configTableBody' before initialization" ReferenceError
// and silently aborted the rest of the script (breaking tab switching,
// Quick Chat, Dev Logs, etc.) since const/let bindings are not usable
// before their declaration executes.
const configTableBody = document.querySelector('#configTable tbody');
const addEntryBtn = document.getElementById('addEntryBtn');
const saveConfigBtn = document.getElementById('saveConfigBtn');
const loadDefaultsBtn = document.getElementById('loadDefaultsBtn');
const clearAllBtn = document.getElementById('clearAllBtn');
const fetchModelsBtn = document.getElementById('fetchModelsBtn');
const loadConfigFromCsvBtn = document.getElementById('loadConfigFromCsvBtn');

// Single delegated listener for the whole table body, instead of attaching a
// listener per row on every render. Provider changes still trigger a full
// re-render (the model <select> options depend on the new provider); enabled
// toggle, model selection, and delete only touch the affected row/state.
configTableBody.addEventListener('change', e => {
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
    }
    // Provider change repopulates this row's model options, so a full
    // re-render is needed here (but nowhere else).
    renderConfigTable();
  } else if (e.target.classList.contains('model-input')) {
    configEntries[idx].model = e.target.value;
  } else if (e.target.classList.contains('enabled-check')) {
    configEntries[idx].enabled = e.target.checked;
  }
});

configTableBody.addEventListener('click', e => {
  const deleteBtn = e.target.closest('.delete-btn');
  if (!deleteBtn) return;
  const row = deleteBtn.closest('tr');
  if (!row) return;
  const idx = Number(row.dataset.idx);
  if (Number.isNaN(idx)) return;
  configEntries.splice(idx, 1);
  // Deleting shifts every subsequent row's index, so this does need a full
  // re-render (dataset.idx values must stay in sync with the array).
  renderConfigTable();
});

// Call on page load
loadDefaultConfig();

// Listen for config-ready from main process (handles async startup race)
onConfigReady(({ entries }) => {
  configEntries = entries;
  renderConfigTable();
  console.log('Config table updated from main process:', entries.length, 'entries');
});

// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab + '-tab').classList.add('active');
    // Show config footer only on config tab
    const configFooter = document.getElementById('configFooter');
    if (configFooter) configFooter.style.display = btn.dataset.tab === 'config' ? 'block' : 'none';
    if (btn.dataset.tab === 'usage') renderTokenUsage(); // refresh when opened
  });
});

// Proxy Control Tab
const portInput = document.getElementById('portInput');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const serverAddress = document.getElementById('serverAddress');
// Positioned next to disconnectBtn in index.html, confirmed present there.
const priorityModelSelect = document.getElementById('priorityModelSelect');

// Populate the priority-override dropdown from the current known-OK endpoints.
// Call after proxy start and after any health check completes.
// Populate the priority-override dropdown from the current known-OK endpoints.
// Call after proxy start and after any health check completes.
function priorityKeyOf(entry) {
  return `${entry.provider}::${entry.model}`;
}

async function renderPriorityOverrideDropdown() {
  if (!priorityModelSelect) return;

  let knownOk;
  try {
    knownOk = await getKnownOk();
  } catch (err) {
    console.warn('Could not load known-OK endpoints for priority dropdown:', err.message);
    return;
  }

  const entries = knownOk || [];

  // If the currently selected priority model is no longer known-OK, clear it.
  if (priorityOverrideKey && !entries.some(entry => priorityKeyOf(entry) === priorityOverrideKey)) {
    priorityOverrideKey = null;

    try {
      await setPriorityOverride(null);
    } catch (err) {
      console.warn('Could not clear stale priority override:', err.message);
    }
  }

  // Currently pinned entry first, then the rest sorted by latency ascending.
  const sorted = [...entries].sort((a, b) => {
    const aKey = priorityKeyOf(a);
    const bKey = priorityKeyOf(b);

    const aPinned = aKey === priorityOverrideKey;
    const bPinned = bKey === priorityOverrideKey;

    if (aPinned && !bPinned) return -1;
    if (bPinned && !aPinned) return 1;

    return (a.latency ?? Infinity) - (b.latency ?? Infinity);
  });

  priorityModelSelect.innerHTML =
    '<option value="">None (auto)</option>' +
    sorted
      .map(e => {
        const key = priorityKeyOf(e);
        const label = `${e.provider} / ${e.model} (${e.latency}ms)`;

        return `<option value="${key}" ${key === priorityOverrideKey ? 'selected' : ''}>${label}</option>`;
      })
      .join('');
}

priorityModelSelect?.addEventListener('change', async e => {
  const key = e.target.value || null;
  priorityOverrideKey = key;

  try {
    await setPriorityOverride(key);
  } catch (err) {
    console.warn('Could not set priority override:', err.message);
  }
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
    renderPriorityOverrideDropdown();
  } else {
    alert('Failed to start proxy: ' + result.error);
  }
});

disconnectBtn.addEventListener('click', async () => {
  await stopProxy();
  setServerStatus(false);
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
});

// Quick Chat
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');

// Send on Enter key
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
    const resp = await fetch(`http://localhost:${portInput.value}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: text }],
        max_tokens: 200
      })
    });
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';
    if (content) {
      const meta = data._meta || null;
      addMessage('assistant', content, meta);
    } else if (data.error) {
      addMessage('assistant', `Model error: ${data.error.message || data.error}`);
    } else {
      const raw = JSON.stringify(data).substring(0, 300);
      addMessage('assistant', `No usable content (HTTP ${resp.status}). Response: ${raw}`);
    }
  } catch (e) {
    addMessage('assistant', 'Error: ' + e.message);
  }
});

// Developer Logs
const devLogs = document.getElementById('devLogs');
const clearLogsBtn = document.getElementById('clearLogsBtn');

onDevLog(({ level, text, time }) => {
  const line = document.createElement('div');
  line.textContent = `[${time}] ${text}`;
  if (level === 'error') line.classList.add('log-error');
  else if (level === 'warn') line.classList.add('log-warn');
  else if (text.includes(window.api.logSuccessMarker)) line.classList.add('log-success');
  devLogs.appendChild(line);
  // Keep the log panel bounded
  while (devLogs.children.length > 500) {
    devLogs.removeChild(devLogs.firstChild);
  }
  devLogs.scrollTop = devLogs.scrollHeight;
});

clearLogsBtn.addEventListener('click', () => {
  devLogs.innerHTML = '';
});

function addMessage(role, content, meta) {
  const div = document.createElement('div');
  const time = new Date().toLocaleTimeString();
  if (role === 'assistant' && meta) {
    div.innerHTML = `<strong>[${time}] ${role}:</strong> ${content}<div class="chat-meta"><span class="meta-provider">${meta.provider}</span> / ${meta.model} · ${meta.elapsed}ms</div>`;
  } else {
    div.innerHTML = `<strong>[${time}] ${role}:</strong> ${content}`;
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
    enabled: true
  });
  renderConfigTable();
});

// Load defaults: populate config from the connected model list file (models.csv),
// one entry per model row per provider. Falls back to models-config.js models if a
// provider has no entries in models.csv.
loadDefaultsBtn.addEventListener('click', () => {
  configEntries = [];
  const providers = getProvidersList();
  providers.forEach(provider => {
    const info = providerInfo[provider];
    // models.csv data is the source of truth here (auto-connected model list)
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
        enabled: true
      });
    });
  });
  renderConfigTable();
});

// Clear all entries
clearAllBtn.addEventListener('click', () => {
  configEntries = [];
  renderConfigTable();
});

// Fetch All Models: show warning modal, then run fetch-models.js and populate config
fetchModelsBtn.addEventListener('click', async () => {
  const modal = document.getElementById('fetchModal');
  modal.style.display = 'flex';

  const proceedBtn = document.getElementById('fetchModalProceed');
  const cancelBtn = document.getElementById('fetchModalCancel');

  const cleanup = () => { modal.style.display = 'none'; };

  cancelBtn.onclick = cleanup;

  proceedBtn.onclick = async () => {
    cleanup();
    const progressBar = document.getElementById('fetchProgressBar');
    if (progressBar) progressBar.style.display = 'inline-block';
    try {
      const result = await runFetchModels();
      if (progressBar) progressBar.style.display = 'none';
      if (!result.success) {
        alert('Failed to fetch models: ' + (result.error || 'Unknown error'));
        return;
      }
      const entries = result.entries || [];
      if (entries.length === 0) {
        alert('No models were fetched. Check the developer logs for details.');
        return;
      }
      // Rebuild latestProviderModels from fetched entries so dropdown auto-updates
      latestProviderModels = {};
      entries.forEach(e => {
        if (!latestProviderModels[e.provider]) latestProviderModels[e.provider] = [];
        latestProviderModels[e.provider].push(e.model);
      });
      // Populate config: 1 entry per model, with baseURL/apiKeyEnv from ProviderConfig.csv
      configEntries = entries.map(e => {
        const info = providerInfo[e.provider];
        return {
          provider: e.provider,
          baseURL: info?.baseURL || '',
          apiKeyEnv: info?.apiKeyEnv || '',
          model: e.model,
          enabled: true
        };
      });
      // Save to UltimateConfig.csv + proxy-config.json
      const saveResult = await saveConfig(configEntries);
      if (saveResult.success) {
        // Update modelFileLabel to reflect LatestModels.csv is now connected
        const modelLabel = document.getElementById('modelFileLabel');
        if (modelLabel) {
          const totalModels = Object.values(latestProviderModels).reduce((sum, arr) => sum + arr.length, 0);
          const totalProviders = Object.keys(latestProviderModels).length;
          modelLabel.textContent = `Model list connected: ${totalProviders} provider(s) / ${totalModels} model(s) — ${latestModelsFileName}`;
        }
        renderConfigTable();
        await updateConfigLabel();
        alert(`Loaded ${configEntries.length} model entries from ${latestModelsFileName}.`);
      } else {
        alert('Failed to save config: ' + saveResult.error);
      }
    } catch (err) {
      if (progressBar) progressBar.style.display = 'none';
      alert('Error fetching models: ' + err.message);
    }
  };
});

// Import config entries from a CSV/Excel file (becomes the source of truth)
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
    // Auto-fill baseURL/apiKeyEnv from ProviderConfig.csv for each entry
    configEntries = loadResult.entries.map(entry => {
      const info = providerInfo[entry.provider];
      if (info) {
        return {
          ...entry,
          baseURL: info.baseURL,
          apiKeyEnv: info.apiKeyEnv
        };
      }
      return entry;
    });
    // Save to UltimateConfig.csv + proxy-config.json (source of truth)
    const saveResult = await saveConfig(configEntries);
    if (saveResult.success) {
      renderConfigTable();
      await updateConfigLabel();
      alert(`Loaded ${configEntries.length} config entries from ${result.filePath}. Saved to ${ultimateConfigFileName}.`);
    } else {
      alert('Failed to save config: ' + saveResult.error);
    }
  } else {
    alert('Failed to load file: ' + (loadResult ? loadResult.error : 'Unknown error'));
  }
});

// Update the config file status label
async function updateConfigLabel() {
  const label = document.getElementById('configFileLabel');
  if (label) {
    const enabledCount = configEntries.filter(e => e.enabled).length;
    label.textContent = `Config: ${enabledCount}/${configEntries.length} enabled - ${ultimateConfigFileName}`;
  }
}

saveConfigBtn.addEventListener('click', async () => {
  try {
    // Apply configuration WITHOUT any health check
    // First, save the config file (source of truth)
    const saveResult = await saveConfig(configEntries);
    if (!saveResult.success) {
      alert('Failed to save config file: ' + saveResult.error);
      return;
    }
    // Update the connected config label
    await updateConfigLabel();

    const running = await isProxyRunning();
    if (running) {
      const port = parseInt(portInput.value);
      const activeEntries = configEntries.filter(e => e.enabled);
      const result = await startProxy(port, activeEntries);
      if (result.success) {
        console.log('Configuration applied. Proxy restarted with updated entries.');
      } else {
        alert('Failed to apply configuration: ' + result.error);
      }
    } else {
      console.log('Configuration saved. Start the proxy to use the updated model list.');
    }
  } catch (err) {
    console.error('Apply Configuration error:', err);
    alert('Error applying configuration: ' + err.message);
  }
});

// Health Check Tab
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
    if (okLog) okLog.value = okResults.map(r => `${r.provider}\t${r.model}\tOK\t${r.latency || 'N/A'}ms`).join('\n');
    if (failLog) failLog.value = failResults.map(r => `${r.provider}\t${r.model}\t${r.status}\t${r.latency || 'N/A'}ms${r.reason ? ' — ' + r.reason : ''}`).join('\n');
    pingSummary.innerHTML = `<strong>Total OK: ${okResults.length} | Total Failed: ${failResults.length}</strong>`;
    renderPriorityOverrideDropdown();
  } catch (err) {
    pingSummary.innerHTML = `<strong>Health check failed: ${err.message}</strong>`;
  }
});

// Token Usage Tab
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
  let totalRequests = 0, totalPrompt = 0, totalCompletion = 0, totalTokens = 0;
  usage.forEach((u, i) => {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${i + 1}</td><td>${u.provider}</td><td>${u.model}</td><td>${u.requests}</td><td>${u.promptTokens.toLocaleString()}</td><td>${u.completionTokens.toLocaleString()}</td><td><strong>${u.totalTokens.toLocaleString()}</strong></td>`;
    usageTableBody.appendChild(row);
    totalRequests += u.requests;
    totalPrompt += u.promptTokens;
    totalCompletion += u.completionTokens;
    totalTokens += u.totalTokens;
  });
  usageSummary.innerHTML = `<strong>Models: ${usage.length} | Requests: ${totalRequests} | Prompt: ${totalPrompt.toLocaleString()} | Completion: ${totalCompletion.toLocaleString()} | Total: ${totalTokens.toLocaleString()}</strong>`;
}

refreshUsageBtn.addEventListener('click', renderTokenUsage);
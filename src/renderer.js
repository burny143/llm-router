// renderer.js
// renderer.js — complete file
const { startProxy, stopProxy, isProxyRunning, healthCheck, getDefaultConfig, getEnvVars, getConnectedModelList, getConnectedConfig, getProviderConfig, saveConfig, onDevLog, runFetchModels, onConfigReady, setPriorityOverride, getKnownOk, getRoutingLog, getPriorityState, onPriorityStateChanged } = window.api;

// --- Shared non-blocking modal utility ---------------------------------------
// Native alert()/confirm() are synchronous and block the renderer's event
// loop; if one opens while a <select> popup is still closing, Chromium can
// leave that popup's invisible overlay stuck, eating clicks on every dropdown
// across every tab until the page reloads. These reuse the existing
// .modal-overlay/.modal-box CSS and never block, so they can't trigger that.
function showNoticeModal(message) {
return new Promise((resolve) => {
const overlay = document.createElement('div');
overlay.className = 'modal-overlay';
const box = document.createElement('div');
box.className = 'modal-box';
const msg = document.createElement('p');
msg.textContent = message;
const actions = document.createElement('div');
actions.className = 'modal-actions';
const okBtn = document.createElement('button');
okBtn.className = 'btn-primary';
okBtn.textContent = 'OK';
const close = () => { overlay.remove(); resolve(); };
okBtn.addEventListener('click', close);
actions.appendChild(okBtn);
box.appendChild(msg);
box.appendChild(actions);
overlay.appendChild(box);
document.body.appendChild(overlay);
okBtn.focus();
});
}

function showConfirmModal(message) {
return new Promise((resolve) => {
const overlay = document.createElement('div');
overlay.className = 'modal-overlay';
const box = document.createElement('div');
box.className = 'modal-box';
const msg = document.createElement('p');
msg.textContent = message;
const actions = document.createElement('div');
actions.className = 'modal-actions';
const cancelBtn = document.createElement('button');
cancelBtn.textContent = 'Cancel';
const okBtn = document.createElement('button');
okBtn.className = 'btn-danger';
okBtn.textContent = 'OK';
const finish = (result) => { overlay.remove(); resolve(result); };
cancelBtn.addEventListener('click', () => finish(false));
okBtn.addEventListener('click', () => finish(true));
actions.appendChild(cancelBtn);
actions.appendChild(okBtn);
box.appendChild(msg);
box.appendChild(actions);
overlay.appendChild(box);
document.body.appendChild(overlay);
okBtn.focus();
});
}

let priorityOverrideKey = null;
let priorityLocked = false;
let configEntries = [];
let envVars = [];
let loadedModels = [];
let fileProviders = [];
let defaultModels = [];
let providerInfo = {};
let latestProviderModels = {};
let providerModelsFromFile = {};
let connectedModelFile = '';
let latestModelsFileName = null;   // set from getDefaultFileNames() in loadDefaultConfig()
let providerConfigFileName = null; // — single source of truth is the main-process registry
let ultimateConfigFileName = null;

async function loadDefaultConfig() {
try {
const defaultFileNames = await window.api.getDefaultFileNames();
if (defaultFileNames) {
if (defaultFileNames.latestModelsFileName) latestModelsFileName = defaultFileNames.latestModelsFileName;
if (defaultFileNames.providerConfigFileName) providerConfigFileName = defaultFileNames.providerConfigFileName;
if (defaultFileNames.ultimateConfigFileName) ultimateConfigFileName = defaultFileNames.ultimateConfigFileName;
}
} catch (err) { console.warn('Could not load default file names:', err.message); }

const providerConfig = await getProviderConfig();
providerInfo = {};
if (Object.keys(providerConfig).length > 0) {
Object.entries(providerConfig).forEach(([provider, info]) => {
providerInfo[provider] = { baseURL: info.baseURL, apiKeyEnv: info.apiKeyEnv, authType: info.authType, models: [] };
});
}

const defaultConfig = await getDefaultConfig();
defaultModels = [];
defaultConfig.forEach(providerGroup => {
providerGroup.models.forEach(modelName => defaultModels.push(modelName));
if (providerInfo[providerGroup.provider]) providerInfo[providerGroup.provider].models = providerGroup.models;
});

await loadEnvVars();
await loadConnectedModelList();
if (Object.keys(providerConfig).length > 0) console.log(`Loaded provider config from ${providerConfigFileName || '(unknown)'}:`, Object.keys(providerConfig).length, 'providers');
await loadConnectedConfig(defaultConfig);
renderAllConfigTables();
renderPriorityOverrideDropdown();
}

// Re-fetch ProviderConfig.csv from main and merge it into providerInfo so a
// provider added AFTER startup (via "Add Web Provider" capture or cookie paste)
// shows up in the config-table provider dropdown immediately — no restart needed.
// Keeps model lists for providers already known (default config merge is only
// additive; models for brand-new providers are filled in by fetchModels later).
async function refreshProviderInfo() {
let providerConfig = {};
try { providerConfig = await getProviderConfig(); } catch (err) { console.warn('Could not refresh provider config:', err.message); return; }
if (!providerConfig || Object.keys(providerConfig).length === 0) return;

const knownProviderKeys = new Set(Object.keys(providerInfo));
Object.entries(providerConfig).forEach(([provider, info]) => {
if (!providerInfo[provider]) {
providerInfo[provider] = { baseURL: info.baseURL, apiKeyEnv: info.apiKeyEnv, authType: info.authType, models: [] };
} else {
// Refresh mutable fields; keep models already fetched.
providerInfo[provider].baseURL = info.baseURL || providerInfo[provider].baseURL;
providerInfo[provider].apiKeyEnv = info.apiKeyEnv || providerInfo[provider].apiKeyEnv;
providerInfo[provider].authType = info.authType || providerInfo[provider].authType;
}
});

const newProviders = Object.keys(providerInfo).filter(p => !knownProviderKeys.has(p));
if (newProviders.length > 0) console.log('Provider config refreshed — new provider(s):', newProviders.join(', '));
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
  if (latestCount > 0) label.textContent = `Model list connected: ${latestProviders} provider(s) / ${latestCount} model(s) — ${latestModelsFileName || '(unknown)'}`;
  else if (connectedModelFile) label.textContent = `Model list connected: ${fileProviders.length} provider(s) / ${loadedModels.length} model(s) — ${connectedModelFile}`;
  else label.textContent = 'No model list file connected. Load one to auto-connect it (like .env).';
}
}
}

async function loadConnectedConfig(defaultConfig) {
const result = await getConnectedConfig();
if (result && result.fileName) ultimateConfigFileName = result.fileName;
if (result && result.entries && result.entries.length > 0) {
configEntries = result.entries.filter(e => providerInfo[e.provider]);    await updateConfigLabel();
} else {
configEntries = [];
if (!defaultConfig) defaultConfig = await getDefaultConfig();
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
if (label) label.textContent = 'No config file yet. Apply Configuration to create one.';
}
}

async function loadEnvVars() { envVars = await getEnvVars(); }
function getProvidersList() { return [...Object.keys(providerInfo), 'Custom']; }
function getEnvVarsList() { return envVars; }

let _modelsForProviderCache = new Map();
function getModelsForProviderMemoized(provider) {
if (_modelsForProviderCache.has(provider)) return _modelsForProviderCache.get(provider);
const models = getModelsForProvider(provider);
_modelsForProviderCache.set(provider, models);
return models;
}

function buildRowHtml(entry, realIdx, displayIdx) {
  const providerModels = getModelsForProviderMemoized(entry.provider);
  const modelOptions = entry.model && !providerModels.includes(entry.model) ? [entry.model, ...providerModels] : providerModels;
  const isCustom = entry.provider === 'Custom';
  const editableStyle = isCustom ? '' : 'readonly style="background:#f5f5f5;"';
  return `<td>${displayIdx + 1}</td>
  <td><select class="provider-select" data-idx="${realIdx}">
  ${getProvidersList().map(p => `<option value="${p}" ${p===entry.provider?'selected':''}>${p}</option>`).join('')}
  </select></td>
  <td><input type="text" class="baseurl-input" data-idx="${realIdx}" value="${entry.baseURL || ''}" ${editableStyle}></td>
  <td><input type="text" class="apikey-input" data-idx="${realIdx}" value="${entry.apiKeyEnv || ''}" ${editableStyle}></td>
  <td><select class="model-input" data-idx="${realIdx}">
  <option value="">(None)</option>
  ${modelOptions.map(m => `<option value="${m}" ${m===entry.model?'selected':''}>${m}</option>`).join('')}
  </select></td>
  <td><input type="checkbox" class="enabled-check" data-idx="${realIdx}" ${entry.enabled?'checked':''}></td>
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

const apiModelsTableBody = document.querySelector('#apiModelsTable tbody');
const cookieModelsTableBody = document.querySelector('#cookieModelsTable tbody');
const addEntryBtn = document.getElementById('addEntryBtn');
const saveConfigBtn = document.getElementById('saveConfigBtn');
const loadDefaultsBtn = document.getElementById('loadDefaultsBtn');
const clearAllBtn = document.getElementById('clearAllBtn');
const fetchModelsBtn = document.getElementById('fetchModelsBtn');

function refreshConfigRow(realIdx) {
const row = document.querySelector(`tr[data-idx="${realIdx}"]`);
if (row && configEntries[realIdx]) {
const allRows = document.querySelectorAll('#apiModelsTable tbody tr, #cookieModelsTable tbody tr');
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
  if (info && selectedProvider !== 'Custom') {
    configEntries[idx].baseURL = info.baseURL;
    configEntries[idx].apiKeyEnv = info.apiKeyEnv;
    configEntries[idx].authType = info.authType || 'Bearer';
  }
  // Rebuild both tables deferred by one tick. Rebuilding the table synchronously while
  // the native <select> popup is still closing leaves a stuck invisible popup that
  // swallows clicks for a while — the "can't click any dropdown after a config change" bug.
  setTimeout(() => renderAllConfigTables(), 0);
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
// Defer one tick: rebuilding the table synchronously while a native <select>
// popup is still closing leaves a phantom popup that eats clicks.
setTimeout(() => renderAllConfigTables(), 0);
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
  if (info && selectedProvider !== 'Custom') {
    configEntries[idx].baseURL = info.baseURL;
    configEntries[idx].apiKeyEnv = info.apiKeyEnv;
    configEntries[idx].authType = info.authType || 'Bearer';
  }
  setTimeout(() => renderAllConfigTables(), 0);
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
setTimeout(() => renderAllConfigTables(), 0);
});

loadDefaultConfig();
loadAssistantConfigForm();

onConfigReady(async ({ entries }) => {
await refreshProviderInfo();
configEntries = entries.filter(e => providerInfo[e.provider]);
renderAllConfigTables();
renderPriorityOverrideDropdown();
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
if (configFooter) configFooter.style.display = btn.dataset.tab === 'config' ? 'block' : 'none';
if (btn.dataset.tab === 'usage') renderTokenUsage();

// --- General Config (folded into the config tab, default sub-tab) ---
if (btn.dataset.tab === 'config') {
loadAssistantConfigForm();
// Always land on General Config (leftmost sub-tab) when opening
// Admin/Configuration, regardless of which sub-tab was active last time.
const configTab = document.getElementById('config-tab');
if (configTab) {
configTab.querySelectorAll(':scope > .sub-tabs .sub-tab-btn').forEach(b => b.classList.remove('active'));
configTab.querySelectorAll(':scope > .sub-tab-content').forEach(t => t.classList.remove('active'));
const generalTabBtn = configTab.querySelector('.sub-tab-btn[data-subtab="general-config"]');
const generalSubtab = document.getElementById('general-config-subtab');
if (generalTabBtn) generalTabBtn.classList.add('active');
if (generalSubtab) generalSubtab.classList.add('active');
}
}
});
});

document.querySelectorAll('.sub-tab-btn').forEach(btn => {
btn.addEventListener('click', () => {
// Scope to the enclosing top-level tab so independent sub-tab groups
// (Config's API/Cookie Models vs Proxy Control's Request/Response Logs)
// don't clear each other's active state.
const scope = btn.closest('.tab-content') || document;
scope.querySelectorAll(':scope > .sub-tabs .sub-tab-btn').forEach(b => b.classList.remove('active'));
scope.querySelectorAll(':scope > .sub-tab-content').forEach(t => t.classList.remove('active'));
btn.classList.add('active');
scope.querySelector('#' + btn.dataset.subtab + '-subtab').classList.add('active');
});
});

// --- NEW: collapsible panels (Quick Chat / Connected Apps / Developer Logs) ---
// State persisted to localStorage so a collapsed panel stays collapsed across
// reloads. Each collapsible has a `data-persist-key` attribute and a
// `.collapsible-header` toggle.
function applyCollapseState(section) {
const key = section.dataset.persistKey;
const body = section.querySelector('.collapsible-body');
const caret = section.querySelector('.collapsible-caret');
if (!body) return;
if (!key) { body.style.display = ''; return; }
let collapsed = localStorage.getItem('collapse.' + key) === '1';
setCollapsed(section, body, caret, collapsed);
}

function setCollapsed(section, body, caret, collapsed) {
body.style.display = collapsed ? 'none' : 'block';
if (caret) caret.style.transform = collapsed ? 'rotate(-90deg)' : 'rotate(0)';
if (section.dataset.persistKey) localStorage.setItem('collapse.' + section.dataset.persistKey, collapsed ? '1' : '0');
}

function initCollapsibles() {
document.querySelectorAll('.collapsible-section').forEach((section) => {
applyCollapseState(section);
const header = section.querySelector('.collapsible-header');
if (!header) return;
header.addEventListener('click', (e) => {
// Don't toggle from the embedded Clear/Refresh buttons — let the click
// propagate to the header-level toggle only when the header itself
// (or its text/caret) is the target.
if (e.target.closest('button, input, select')) return;
const body = section.querySelector('.collapsible-body');
const caret = section.querySelector('.collapsible-caret');
const already = body.style.display === 'none';
setCollapsed(section, body, caret, !already);
});
});
}
initCollapsibles();

// --- NEW: sync proxy toggle state on load ---
syncProxyState();

const portInput = document.getElementById('portInput');
const proxyToggleBtn = document.getElementById('proxyToggleBtn');
const serverAddress = document.getElementById('serverAddress');
const priorityModelSelect = document.getElementById('priorityModelSelect');
const priorityLockToggle = document.getElementById('priorityLockToggle');
const priorityRoutingLog = document.getElementById('priorityRoutingLog');

function priorityKeyOf(entry) { return `${entry.provider}::${entry.model}`; }

function renderPriorityRoutingLog(entries) {
if (!priorityRoutingLog) return;
if (!entries || !entries.length) {
priorityRoutingLog.innerHTML = '<div class="priority-log-empty">No routing events yet.</div>';
return;
}
priorityRoutingLog.innerHTML = entries.slice(0, 8).map(e => {
const time = new Date(e.time).toLocaleTimeString();
return `<div class="priority-log-row priority-log-${e.kind}"><span class="priority-log-time">${time}</span> ${e.text}</div>`;
}).join('');
}

async function refreshPriorityRoutingLog() {
if (!priorityRoutingLog || typeof getRoutingLog !== 'function') return;
try { renderPriorityRoutingLog(await getRoutingLog()); } catch (_) { /* best-effort */ }
}

async function renderPriorityOverrideDropdown() {
if (!priorityModelSelect) return;
let knownOk;
try { knownOk = await getKnownOk(); } catch (err) { return; }
const entries = knownOk || [];

// Pull authoritative state from the backend rather than trusting our own
// local `priorityOverrideKey`/`priorityLocked` — those can go stale the
// moment the backend auto-clears a pin on failure, which is exactly the
// bug this resync is fixing.
if (typeof getPriorityState === 'function') {
try {
const state = await getPriorityState();
priorityOverrideKey = state.priorityOverrideKey || null;
priorityLocked = !!state.priorityLocked;
} catch (_) { /* fall back to local state */ }
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
return `<option value="${key}" ${key === priorityOverrideKey ? 'selected' : ''}>${e.provider} / ${e.model} (${e.latency}ms)</option>`;
}).join('');

if (priorityLockToggle) {
priorityLockToggle.checked = priorityLocked;
priorityLockToggle.disabled = !priorityOverrideKey;
}
refreshPriorityRoutingLog();
}

priorityModelSelect?.addEventListener('change', async e => {
const key = e.target.value || null;
priorityOverrideKey = key;
if (!key) priorityLocked = false; // locking "auto" makes no sense
if (priorityLockToggle) priorityLockToggle.disabled = !key;
try { await setPriorityOverride(key, priorityLocked); } catch (err) {}
});

priorityLockToggle?.addEventListener('change', async e => {
priorityLocked = e.target.checked;
try { await setPriorityOverride(priorityOverrideKey, priorityLocked); } catch (err) {}
});

// Live resync: the backend now pushes PRIORITY_STATE_CHANGED any time the
// pin/lock/routing mode changes for ANY reason (user action here, from the
// Agent tab, or the backend auto-clearing a stale pin after a failed
// request) — this is what actually fixes the dropdown going stale, since
// before nothing told this tab a mid-session change had happened.
if (typeof onPriorityStateChanged === 'function') {
onPriorityStateChanged(() => { renderPriorityOverrideDropdown(); });
}

function setServerStatus(running, port) {
serverAddress.classList.remove('running', 'stopped');
if (running) {
serverAddress.textContent = `Server running at http://localhost:${port}/`;
serverAddress.classList.add('running');
} else {
serverAddress.textContent = 'Server stopped';
serverAddress.classList.add('stopped');
}
// --- NEW: merged Connect/Stop toggle --- single button reflects state.
// NOTE: btn-primary and btn-danger must never both be present — with equal
// CSS specificity, whichever rule is declared later in style.css wins
// regardless of which class was added most recently, so the button could
// silently stay blue while labeled "STOP". Toggling both classes together
// (not just adding btn-danger on top) is what actually fixes that.
if (proxyToggleBtn) {
proxyToggleBtn.textContent = running ? 'STOP' : 'Connect';
proxyToggleBtn.classList.toggle('btn-danger', running);
proxyToggleBtn.classList.toggle('btn-primary', !running);
proxyToggleBtn.disabled = false;
}
}

// --- NEW: merged Connect/Stop toggle --- single button handles both directions.
let proxyRunning = false;

async function syncProxyState() {
try { proxyRunning = await isProxyRunning(); } catch (_) { proxyRunning = false; }
setServerStatus(proxyRunning, parseInt(portInput.value) || 8000);
}

proxyToggleBtn && proxyToggleBtn.addEventListener('click', async () => {
const port = parseInt(portInput.value);
if (!port) return;
if (!proxyRunning) {
// Connect
const activeEntries = configEntries.filter(e => e.enabled);
const result = await startProxy(port, activeEntries);
if (result.success) {
proxyRunning = true;
setServerStatus(true, port);
// Defer one tick so any closing native <select> popup finishes first.
setTimeout(() => renderPriorityOverrideDropdown(), 0);
} else {
await showNoticeModal('Failed to start proxy: ' + result.error);
}
} else {
// Stop
await stopProxy();
proxyRunning = false;
setServerStatus(false, port);
}
});

const connectedAppsCount = document.getElementById('connectedAppsCount');
const connectedAppsList = document.getElementById('connectedAppsList');
// NEW: queue-depth visibility (Task 7).
const queueDepthIndicator = document.getElementById('queueDepthIndicator');

function renderConnectedApps(connectedApps) {
if (!connectedAppsCount || !connectedAppsList) return;
const clients = (connectedApps && connectedApps.clients) || [];
connectedAppsCount.textContent = `Connected applications: ${connectedApps ? connectedApps.count : 0}`;
if (clients.length === 0) {
connectedAppsList.innerHTML = '<div class="connected-apps-empty">No applications connected.</div>';
return;
}
connectedAppsList.innerHTML = clients.map(c => `<div class="connected-app-card">
<div>
<div class="app-name">${c.appName}</div>
<div class="app-meta">
In-flight: ${c.activeRequests} · Total: ${c.totalRequests} · Errors: ${c.errorCount}
${c.lastModel ? ` · Last: ${c.lastProvider}/${c.lastModel}` : ''}
${c.lastActivity ? ` · Last activity: ${c.lastActivity}` : ''}
</div>
</div>
<span class="connected-app-status ${c.status}">${c.status}</span>
</div>`).join('');
}

// NEW: queue-depth visibility (Task 7) — mirrors renderConnectedApps' pattern.
// Shows the live depth of proxy-server.js's queueTracker (requests currently
// waiting on findWinner()/acquireRequestSlot()) so the previously-invisible
// acquireRequestSlot() gate has a visible indicator, refreshed on the same
// pollProxyStats() interval as Connected Applications.
function renderQueueDepth(queue) {
if (!queueDepthIndicator) return;
const depth = queue ? queue.depth : 0;
if (depth === 0) {
queueDepthIndicator.textContent = 'Queue depth: 0';
queueDepthIndicator.title = '';
return;
}
queueDepthIndicator.textContent = `Queue depth: ${depth}`;
const waiting = (queue && queue.waitingClients) || [];
queueDepthIndicator.title = waiting
.map(w => `${w.appName} (waiting ${Math.round(w.waitingMs / 1000)}s on ${w.waitingOn.join(', ')})`)
.join('\n');
}

async function pollProxyStats() {
try {
const stats = await window.api.getProxyStats();
renderConnectedApps(stats && stats.connectedApps);
renderQueueDepth(stats && stats.queue);
} catch (err) { /* proxy not running yet, or IPC not ready — ignore */ }
}
pollProxyStats();
setInterval(pollProxyStats, 3000);

const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');

chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendBtn.click(); } });

sendBtn.addEventListener('click', async () => {
const text = chatInput.value.trim();
if (!text) return;
addMessage('user', text);
chatInput.value = '';

const running = await isProxyRunning();
if (!running) { addMessage('assistant', 'Proxy is not running.'); return; }

try {
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 60000);
let resp;
try {
resp = await fetch(`http://localhost:${portInput.value}/v1/chat/completions`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ messages: [{ role: 'user', content: text }], max_tokens: 200 }),
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
   // Tool calls response — display them in a readable format
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
clearLogsBtn.addEventListener('click', () => { devLogs.innerHTML = ''; });

// --- NEW: single Developer Logs feed ---
// Request/response lines now arrived as plain, human-readable dev-log lines
// (see proxy-server.js's logRequestLine/logResponseLine) — no [REQ]/[RES]
// sub-tab split. Everything flows through the one onDevLog listener below.
onDevLog(({ level, text, time }) => {
const line = document.createElement('div');
line.textContent = `[${time}] ${text}`;
if (level === 'error') line.classList.add('log-error');
else if (level === 'warn') line.classList.add('log-warn');
else if (text.includes(window.api.logSuccessMarker)) line.classList.add('log-success');
devLogs.appendChild(line);
while (devLogs.children.length > 500) devLogs.removeChild(devLogs.firstChild);
devLogs.scrollTop = devLogs.scrollHeight;
});

function addMessage(role, content, meta) {
const div = document.createElement('div');
const time = new Date().toLocaleTimeString();
// Escape HTML to prevent injection
const safeContent = String(content).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
if (role === 'assistant' && meta) {
div.innerHTML = `<strong>[${time}] ${role}:</strong> ${safeContent}<div class="chat-meta"><span class="meta-provider">${meta.provider}</span> / ${meta.model} · ${meta.elapsed}ms</div>`;
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
setTimeout(() => renderAllConfigTables(), 0);
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
provider, baseURL: info?.baseURL || '', apiKeyEnv: info?.apiKeyEnv || '', model: modelName, enabled: true, authType: info?.authType || 'Bearer'
});
});
});
configEntries = [...configEntries, ...cookieEntries];
// Defer one tick so any closing native <select> popup finishes first.
setTimeout(() => renderAllConfigTables(), 0);
});

clearAllBtn.addEventListener('click', () => {
configEntries = configEntries.filter(e => e.authType === 'Cookie');
// Defer one tick so any closing native <select> popup finishes first.
setTimeout(() => renderAllConfigTables(), 0);
});

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
if (!result.success) { await showNoticeModal('Failed to fetch models: ' + (result.error || 'Unknown error')); return; }
const entries = result.entries || [];
if (entries.length === 0) { await showNoticeModal('No models were fetched.'); return; }
latestProviderModels = {};
entries.forEach(e => {
if (!latestProviderModels[e.provider]) latestProviderModels[e.provider] = [];
latestProviderModels[e.provider].push(e.model);
});
configEntries = entries.map(e => {
const info = providerInfo[e.provider];
return { provider: e.provider, baseURL: info?.baseURL || '', apiKeyEnv: info?.apiKeyEnv || '', model: e.model, enabled: true, authType: info?.authType || 'Bearer' };
});
const saveResult = await saveConfig(configEntries);
if (saveResult.success) {
const modelLabel = document.getElementById('modelFileLabel');
if (modelLabel) {
const totalModels = Object.values(latestProviderModels).reduce((sum, arr) => sum + arr.length, 0);
const totalProviders = Object.keys(latestProviderModels).length;
modelLabel.textContent = `Model list connected: ${totalProviders} provider(s) / ${totalModels} model(s) — ${latestModelsFileName || '(unknown)'}`;
}
// Defer one tick so any closing native <select> popup finishes first.
setTimeout(() => renderAllConfigTables(), 0);
await updateConfigLabel();
await showNoticeModal(`Loaded ${configEntries.length} model entries from ${latestModelsFileName || '(unknown)'}.`);
} else {
await showNoticeModal('Failed to save config: ' + saveResult.error);
}
} catch (err) {
if (progressBar) progressBar.style.display = 'none';
await showNoticeModal('Error fetching models: ' + err.message);
}
};
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
if (!saveResult.success) { await showNoticeModal('Failed to save config file: ' + saveResult.error); return; }
await updateConfigLabel();
const running = proxyRunning || (await isProxyRunning());
if (running) {
proxyRunning = true;
const port = parseInt(portInput.value);
const activeEntries = configEntries.filter(e => e.enabled);
const result = await startProxy(port, activeEntries);
if (result.success) console.log('Configuration applied. Proxy restarted.');
else await showNoticeModal('Failed to apply configuration: ' + result.error);
} else {
proxyRunning = false;
console.log('Configuration saved.');
}
} catch (err) {
await showNoticeModal('Error applying configuration: ' + err.message);
}
});

const pingAllBtn = document.getElementById('pingAllBtn');
const pingSummary = document.getElementById('pingSummary');

pingAllBtn.addEventListener('click', async () => {
const activeEntries = configEntries.filter(e => e.enabled);
if (activeEntries.length === 0) { pingSummary.innerHTML = '<strong>No enabled entries to ping.</strong>'; return; }
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
// Defer one tick so any closing native <select> popup finishes first.
setTimeout(() => renderPriorityOverrideDropdown(), 0);
} catch (err) {
pingSummary.innerHTML = `<strong>Health check failed: ${err.message}</strong>`;
}
});

const refreshUsageBtn = document.getElementById('refreshUsageBtn');
const usageTableBody = document.querySelector('#usageTable tbody');
const usageSummary = document.getElementById('usageSummary');

async function renderTokenUsage() {
const usage = await window.api.getTokenUsage();
usageTableBody.innerHTML = '';
if (!usage || usage.length === 0) { usageSummary.innerHTML = '<strong>No token usage recorded yet.</strong>'; return; }
let totalRequests = 0, totalPrompt = 0, totalCompletion = 0, totalTokens = 0;
usage.forEach((u, i) => {
const row = document.createElement('tr');
// No price table exists anywhere in this codebase — cost stays a clearly
// marked placeholder rather than a fabricated number (Task 3).
row.innerHTML = `<td>${i + 1}</td><td>${u.provider}</td><td>${u.model}</td><td>${u.requests}</td><td>${u.promptTokens.toLocaleString()}</td><td>${u.completionTokens.toLocaleString()}</td><td><strong>${u.totalTokens.toLocaleString()}</strong></td><td style="color:#888;">N/A (no price table)</td>`;
usageTableBody.appendChild(row);
totalRequests += u.requests; totalPrompt += u.promptTokens; totalCompletion += u.completionTokens; totalTokens += u.totalTokens;
});
usageSummary.innerHTML = `<strong>Models: ${usage.length} | Requests: ${totalRequests} | Prompt: ${totalPrompt.toLocaleString()} | Completion: ${totalCompletion.toLocaleString()} | Total: ${totalTokens.toLocaleString()} | Est. Cost: N/A (no price table)</strong>`;
}
refreshUsageBtn.addEventListener('click', renderTokenUsage);

// --- General Config (leftmost sub-tab of the Admin/Configuration tab) ---
const systemPromptOverrideInput = document.getElementById('systemPromptOverrideInput');
const toolCallEmulationToggle = document.getElementById('toolCallEmulationToggle');
const previewToolFormatBtn = document.getElementById('previewToolFormatBtn');
const toolFormatPreview = document.getElementById('toolFormatPreview');
const routingModeSelect = document.getElementById('routingModeSelect');
const retryCountInput = document.getElementById('retryCountInput');
const timeoutMsInput = document.getElementById('timeoutMsInput');
const cookieProviderTimeoutMsInput = document.getElementById('cookieProviderTimeoutMsInput');
const pingTimeoutMsInput = document.getElementById('pingTimeoutMsInput');
const maxOutputTokensInput = document.getElementById('maxOutputTokensInput');
const maxInputTokensInput = document.getElementById('maxInputTokensInput');
const pingIntervalInput = document.getElementById('pingIntervalInput');
const minRequestIntervalInput = document.getElementById('minRequestIntervalInput');
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
// UI works in whole seconds; pingIntervalMs is stored/backend-wired in ms.
if (pingIntervalInput) pingIntervalInput.value = Math.round((config.pingIntervalMs ?? 30000) / 1000);
// Default 1 second: keep bursts of concurrent requests from hitting a
// free-tier provider all at once.
if (minRequestIntervalInput) minRequestIntervalInput.value = Math.round((config.minRequestIntervalMs ?? 1000) / 1000);
if (loggingVerbositySelect) loggingVerbositySelect.value = config.loggingVerbosity || 'normal';
if (largeContextModeToggle) largeContextModeToggle.checked = !!config.largeContextMode;
if (largeContextThresholdInput) largeContextThresholdInput.value = config.largeContextThreshold ?? 100000;
if (largeContextChunkTokensInput) largeContextChunkTokensInput.value = config.largeContextChunkTokens ?? 20000;
if (largeContextConcurrencyDefaultInput) largeContextConcurrencyDefaultInput.value = concurrency.default ?? 5;
if (largeContextConcurrencyCookieInput) largeContextConcurrencyCookieInput.value = concurrency.cookie ?? 1;
if (cookieProviderTimeoutMsInput) cookieProviderTimeoutMsInput.value = config.cookieProviderTimeoutMs ?? 60000;
if (pingTimeoutMsInput) pingTimeoutMsInput.value = config.pingTimeoutMs ?? 8000;
if (maxOutputTokensInput) maxOutputTokensInput.value = config.maxOutputTokens ?? 100000;
if (maxInputTokensInput) maxInputTokensInput.value = config.maxInputTokens ?? 128000;

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
  cookieProviderTimeoutMs: cookieProviderTimeoutMsInput ? Math.max(1000, parseInt(cookieProviderTimeoutMsInput.value, 10) || 60000) : 60000,
  pingTimeoutMs: pingTimeoutMsInput ? Math.max(500, parseInt(pingTimeoutMsInput.value, 10) || 8000) : 8000,
  maxOutputTokens: maxOutputTokensInput ? Math.max(1, parseInt(maxOutputTokensInput.value, 10) || 100000) : 100000,
  maxInputTokens: maxInputTokensInput ? Math.max(0, parseInt(maxInputTokensInput.value, 10) || 128000) : 128000,
  pingIntervalMs: pingIntervalInput ? Math.max(0, parseInt(pingIntervalInput.value, 10) || 0) * 1000 : 30000,
  minRequestIntervalMs: minRequestIntervalInput ? Math.max(0, parseInt(minRequestIntervalInput.value, 10) || 0) * 1000 : 1000,
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
await showNoticeModal('General config saved. Changes apply to new requests immediately.');
} else {
await showNoticeModal('Failed to save general config: ' + result.error);
}
} catch (err) {
await showNoticeModal('Error saving general config: ' + err.message);
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
// Rebuild the preset dropdown from the real preset list (Qwen, Kimi, ...).
if (webProviderPresetSelect) {
webProviderPresetSelect.innerHTML = '<option value="">— Custom —</option>' +
presetKeys.map(k => `<option value="${k}">${k}</option>`).join('');
}
// Also keep the "Clear Session" provider dropdown in sync.
const clearSelect = document.getElementById('clearWebProviderSelect');
if (clearSelect) {
const current = clearSelect.value;
clearSelect.innerHTML = presetKeys.map(k => `<option value="${k}">${k}</option>`).join('') || '<option value="Qwen">Qwen</option>';
if (presetKeys.includes(current)) clearSelect.value = current;
}
} catch (err) {
console.warn('Could not load web provider presets:', err.message);
}
}

function showWebProviderStatus(html) {
const status = document.getElementById('webProviderModalStatus');
if (status) { status.innerHTML = html; status.style.display = 'block'; }
}

function showWebProviderForm() {
const form = document.getElementById('webProviderModalForm');
const status = document.getElementById('webProviderModalStatus');
if (form) form.style.display = 'block';
if (status) status.style.display = 'none';
}

addWebProviderBtn?.addEventListener('click', () => {
// Always rebuild the cached refs: a previous setup run may have left the modal
// in a stale state (form swapped out, buttons hidden).
webProviderNameInput.value = 'Qwen';
webProviderUrlInput.value = 'https://chat.qwen.ai/';
webProviderCookieInput.value = '';
if (webProviderPresetSelect) webProviderPresetSelect.value = 'Qwen';
webProviderModal.style.display = 'flex';
showWebProviderForm();
webProviderModalProceed.style.display = '';
webProviderModalCancel.style.display = '';
webProviderModalProceed.disabled = false;
webProviderModalCancel.disabled = false;
webProviderNameInput.focus();
toggleCookieField();
});

webProviderModalCancel?.addEventListener('click', () => { webProviderModal.style.display = 'none'; });

// Selecting a preset prefills Name + Login URL from the main-process preset table.
webProviderPresetSelect?.addEventListener('change', () => {
const preset = webProviderPresets[webProviderPresetSelect.value];
if (preset) {
webProviderNameInput.value = webProviderPresetSelect.value;
webProviderUrlInput.value = preset.loginUrl;
}
});

// The cookie field is always available: leave it blank to auto-retrieve via the
// browser automation, or paste a cookie to skip the browser entirely.
// Kimi-style providers: you can paste the `refresh_token` found in DevTools →
// Application → Local Storage → https://www.kimi.com directly — it is detected
// (JWT, eyJ...) and stored as the Bearer authToken.
function toggleCookieField() {
if (webProviderCookieInput) webProviderCookieInput.style.display = 'block';
}

webProviderNameInput?.addEventListener('input', () => {
if (webProviderPresetSelect && webProviderPresets[webProviderNameInput.value.trim()]) {
webProviderPresetSelect.value = webProviderNameInput.value.trim();
webProviderUrlInput.value = webProviderPresets[webProviderNameInput.value.trim()].loginUrl;
}
});

webProviderModalProceed?.addEventListener('click', async (e) => {
if (e) e.preventDefault();
const name = webProviderNameInput.value.trim();
const url = webProviderUrlInput.value.trim();
const cookieVal = webProviderCookieInput.value.trim();
const useAutoRetrieve = cookieVal.length === 0;

if (!name) { await showNoticeModal('Please enter a provider name.'); return; }
if (useAutoRetrieve && !url) { await showNoticeModal('Please enter a login URL or paste a cookie manually.'); return; }

// Show status WITHOUT destroying the form DOM: swapping innerHTML would orphan
// the cached element refs (preset select, name/url inputs), leaving the modal
// form dead on the next open ("dropdown not responsive" bug).
showWebProviderForm();
showWebProviderStatus(useAutoRetrieve
? `<h3>Setting up ${name}...</h3><p>A browser window will open. Please log in and sending <strong>ONE</strong> test message in the chat.</p><p>The script is listening for the chat API request. This may take up to 2 minutes.</p><div class="progress-bar-container" style="width: 100%; margin-top: 15px;"><div class="progress-bar-fill" style="width: 100%; animation: progress-indeterminate 1.5s ease-in-out infinite;"></div></div><p style="font-size: 12px; color: #666; margin-top: 10px;">Do not close the browser window or this app.</p>`
: `<h3>Saving ${name} cookie…</h3><p>Storing the pasted cookie (no browser opened, no ping performed).</p>`);
webProviderModalProceed.disabled = true;
webProviderModalCancel.disabled = true;
try {
const result = useAutoRetrieve
? await window.api.runWebProviderSetup(name, url)
: await window.api.setProviderCookie(name, cookieVal);
if (result.success) {
showWebProviderStatus(`<h3>✅ Success!</h3><p>Web provider added.</p>
<p style="font-size:13px;color:#666;">${name} has been added to your config (model "${name}-chat"). Restart the proxy to pick it up.</p>
<button id="webProviderModalClose" style="margin-top:12px;padding:6px 14px;">Close</button>`);
document.getElementById('webProviderModalClose')?.addEventListener('click', () => {
webProviderModal.style.display = 'none';
});
// Do not auto-close or auto-reload — let the user dismiss when ready.
} else {
await showNoticeModal('Failed: ' + (result.error || 'Unknown error'));
showWebProviderForm();
webProviderModalProceed.disabled = false;
webProviderModalCancel.disabled = false;
}
} catch (err) {
await showNoticeModal('Failed: ' + (err.message || 'Unknown error'));
showWebProviderForm();
webProviderModalProceed.disabled = false;
webProviderModalCancel.disabled = false;
}
});

const clearWebProviderSessionBtn = document.getElementById('clearWebProviderSessionBtn');
clearWebProviderSessionBtn?.addEventListener('click', async () => {
const providerName = document.getElementById('clearWebProviderSelect')?.value || 'Qwen';
// Uses the non-blocking showConfirmModal (not native confirm()) — a native,
// synchronous confirm()/alert() opened while a <select> popup is still
// closing can leave a stuck invisible popup layer that eats every
// dropdown's clicks across every tab until the page reloads.
const confirmed = await showConfirmModal(`Are you sure you want to clear all stored ${providerName} cookies and session data?`);
if (!confirmed) return;
const result = await window.api.clearWebProviderSession(providerName);
if (result.success) {
await showNoticeModal(`${providerName} session cleared. Please use "Add Web Provider" to log in again.`);
} else {
await showNoticeModal(`Failed to clear ${providerName} session:` + result.error);
}
});

// Load provider presets (Qwen, Kimi, ...) once the renderer is ready.
loadWebProviderPresets();
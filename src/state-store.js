// state-store.js — MUST live in src/ (one folder below PROJECT_ROOT): PROJECT_ROOT is
// derived from __dirname, so moving this file breaks every data-file path resolution.
const fs = require('fs');
const path = require('path');

// --- File registry (central "notepad" that maps each data-file role to a path) ---
// file-registry.json is the single place that says WHICH file plays WHICH role.
// Every other module must resolve data-file paths via getFilePath(role) instead of
// hardcoding filenames. Relative paths are resolved against the PROJECT ROOT
// (one level above src/), not against this module.
const PROJECT_ROOT = path.resolve(__dirname, '..');
const REGISTRY_FILE = path.join(PROJECT_ROOT, 'file-registry.json');

// Defaults: used when file-registry.json is missing, unreadable, or lacks a role.
const DEFAULT_PATHS = {
  providerConfig: 'data/ProviderConfig.csv',
  ultimateConfig: 'data/UltimateConfig.csv',
  proxyConfig: 'data/proxy-config.json',
  models: 'data/models.csv',
  latestModels: 'data/LatestModels.csv',
  knownOk: 'data/known-ok.json',
  tokenUsage: 'data/token-usage.json',
  settings: 'data/settings.json',
  env: 'data/.env',
  providerFlags: 'data/provider-flags.json',
  webProviderRules: 'data/web-provider-rules.json'
};

let fileRegistry = {};
try {
  if (fs.existsSync(REGISTRY_FILE)) {
    fileRegistry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
  }
} catch (err) {
  console.warn('Could not load file-registry.json, using defaults:', err.message);
}

// Resolve a data-file role to an absolute path (registry first, then default).
// An explicit empty-string override in file-registry.json IS honored (hasOwnProperty
// instead of truthiness), and an unknown role logs a warning instead of silently
// becoming a literal relative path segment.
function getFilePath(role) {
  let value;
  if (Object.prototype.hasOwnProperty.call(fileRegistry, role)) {
    value = fileRegistry[role];
  } else if (Object.prototype.hasOwnProperty.call(DEFAULT_PATHS, role)) {
    value = DEFAULT_PATHS[role];
  } else {
    console.warn(`getFilePath('${role}'): unknown role — not in file-registry.json or defaults; treating it as a literal path.`);
    value = role;
  }
  return path.isAbsolute(value) ? value : path.join(PROJECT_ROOT, value);
}

// Derive the upper-snake env-var prefix for a provider name (e.g. "Qwen" -> "QWEN").
// Used by the web-provider capture + runtime cookie paths so both share the
// SAME provider profile dir on disk (capture device == request device).
function envPrefixFor(providerName) {
  let key = String(providerName || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (/^\d/.test(key)) key = '_' + key;
  return key;
}

// Keep the legacy constants working for any code that still destructures them.
// They are now derived from the registry, so editing file-registry.json redirects
// the app without touching code.
const STATE_FILE = getFilePath('knownOk');
const USAGE_FILE = getFilePath('tokenUsage');
const SETTINGS_FILE = getFilePath('settings');
const CONFIG_FILE = getFilePath('proxyConfig');
const CONFIG_CSV = getFilePath('ultimateConfig');
const PROVIDER_CONFIG_CSV = getFilePath('providerConfig');

// Simple CSV parsing (no external deps — handles basic quoted/unquoted fields)
function parseCsv(text) {
  const rows = [];
  let cur = '';
  let inQuotes = false;
  let row = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if ((ch === ',' || ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r') continue;
      if (ch === '\n') {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = '';
      } else {
        row.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  const headers = rows[0];
  return rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (r[i] || '').trim(); });
    return obj;
  });
}

// Parse a CSV file with specific required columns
function parseCsvWithFilter(text, requiredCol) {
  const rows = parseCsv(text);
  return rows.filter(o => o[requiredCol]);
}

// Convert config entries to CSV string with proper escaping
function configToCsv(entries) {
  const lines = ['provider,baseURL,apiKeyEnv,model,enabled,authType'];
  entries.forEach(e => {
    const escape = (value) => {
      if (value == null) return '';
      const str = String(value);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    lines.push([
      escape(e.provider),
      escape(e.baseURL),
      escape(e.apiKeyEnv),
      escape(e.model),
      e.enabled ? 'true' : 'false',
      escape(e.authType || 'Bearer')
    ].join(','));
  });
  return lines.join('\n');
}

// Regenerate proxy-config.json from UltimateConfig.csv (CSV is source of truth)
function syncConfigFromCsv() {
  try {
    if (!fs.existsSync(CONFIG_CSV)) return loadConfig();
    const text = fs.readFileSync(CONFIG_CSV, 'utf-8');
    const entries = parseCsvWithFilter(text, 'provider').map(e => ({
      ...e,
      enabled: e.enabled !== 'false' && e.enabled !== false
    }));
    saveConfig(entries);
    return entries;
  } catch (err) {
    console.warn('Could not sync config from CSV:', err.message);
    return loadConfig();
  }
}

// Persist the config to BOTH CSV (editable truth) and JSON (fast reload)
function saveConfigBoth(entries) {
  try {
    fs.writeFileSync(CONFIG_CSV, configToCsv(entries));
    saveConfig(entries);
  } catch (err) {
    console.warn('Could not save proxy config:', err.message);
  }
}

// Prune config entries whose provider no longer exists in ProviderConfig.csv
// (the single source of truth for available providers). Persists the pruned
// list back to BOTH UltimateConfig.csv and proxy-config.json so a provider
// deleted from ProviderConfig.csv cascades cleanly on the next startup.
// Returns { pruned: [], changed: boolean } where changed indicates if any entries were removed.
function pruneConfigEntries(entries, providerMap) {
  if (!providerMap || Object.keys(providerMap).length === 0) {
    return { pruned: entries, changed: false };
  }
  const pruned = entries.filter(e => providerMap[e.provider]);
  const changed = pruned.length !== entries.length;
  if (changed) {
    console.warn(`${path.basename(PROVIDER_CONFIG_CSV)}: pruning ${entries.length - pruned.length} config entr(ies) for providers no longer present.`);
    saveConfigBoth(pruned);
  }
  return { pruned, changed };
}

// Persist/load app settings (e.g. the last-used model list file, like .env auto-loading)
function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.warn('Could not save settings:', err.message);
  }
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      return saved && typeof saved === 'object' ? saved : {};
    }
  } catch (err) {
    console.warn('Could not load settings:', err.message);
  }
  return {};
}

// Persist/load the proxy configuration (entries: provider, baseURL, apiKeyEnv, model, enabled)
function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (err) {
    console.warn('Could not save proxy config:', err.message);
  }
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      return Array.isArray(saved) ? saved : [];
    }
  } catch (err) {
    console.warn('Could not load proxy config:', err.message);
  }
  return [];
}

// Load provider configuration (provider -> baseURL, apiKeyEnv) from ProviderConfig.csv
function loadProviderConfig() {
  try {
    if (fs.existsSync(PROVIDER_CONFIG_CSV)) {
      const text = fs.readFileSync(PROVIDER_CONFIG_CSV, 'utf-8');
      const rows = parseCsv(text);
      const providerMap = {};
      rows.forEach(row => {
        const provider = row.provider;
        if (provider) {
          providerMap[provider] = {
            baseURL: row.baseURL || '',
            apiKeyEnv: row.apiKeyEnv || '',
            authType: row.authType || 'Bearer'
          };
        }
      });
      return providerMap;
    }
  } catch (err) {
    console.warn('Could not load provider config:', err.message);
  }
  return {};
}

// Persist the last health-check / learned results so routing priorities survive an app restart.
// Format: array of { provider, model, status, latency } entries.
function saveResults(results) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(results, null, 2));
  } catch (err) {
    console.warn('Could not save known-OK state:', err.message);
  }
}

function loadResults() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      return Array.isArray(saved) ? saved : [];
    }
  } catch (err) {
    console.warn('Could not load saved known-OK state:', err.message);
  }
  return [];
}

// Persist/load per-model token usage counters
function saveUsage(usage) {
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2));
  } catch (err) {
    console.warn('Could not save token usage:', err.message);
  }
}

function loadUsage() {
  try {
    if (fs.existsSync(USAGE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
      return saved && typeof saved === 'object' ? saved : {};
    }
  } catch (err) {
    console.warn('Could not load token usage:', err.message);
  }
  return {};
}

module.exports = { saveResults, loadResults, saveUsage, loadUsage, saveSettings, loadSettings, saveConfig, loadConfig, saveConfigBoth, syncConfigFromCsv, pruneConfigEntries, loadProviderConfig, CONFIG_CSV, PROVIDER_CONFIG_CSV, getFilePath, parseCsv, envPrefixFor, DEFAULT_PATHS };
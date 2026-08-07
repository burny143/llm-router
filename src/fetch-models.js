/**
 * Fetches the list of available models from each provider's endpoint
 * and saves them to LatestModels.csv with 2 columns: provider, model
 * Each model gets its own row (1 row per model).
 *
 * Uses ProviderConfig.csv as the single source of truth for:
 *   - Provider names
 *   - Models endpoint URLs
 *   - API key environment variable names
 *
 * Run: node fetch-models.js
 *
 * NOTE: this file MUST stay in src/ — data-file paths resolve via
 * state-store.getFilePath(), whose PROJECT_ROOT is derived from __dirname.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getFilePath, parseCsv } = require('./state-store');
const { FILE_ROLES } = require('./shared-constants');
require('dotenv').config({ path: getFilePath(FILE_ROLES.ENV) });

// Read ProviderConfig.csv (path from file-registry.json) using the shared
// quote-aware parser from state-store.js, so a baseURL/modelsEndpoint value
// containing a comma (e.g. a URL with query parameters) no longer corrupts
// column alignment the way naive line.split(',') did.
// Guarded at module scope: a missing/unreadable CSV must fail with a clear
// message and non-zero exit, not an unhandled exception.
const providerConfigPath = getFilePath(FILE_ROLES.PROVIDER_CONFIG);
let parsedRows = [];
if (!fs.existsSync(providerConfigPath)) {
  console.error(`ProviderConfig.csv not found at ${providerConfigPath}. Nothing to fetch — exiting.`);
  process.exit(1);
}
try {
  const csvText = fs.readFileSync(providerConfigPath, 'utf-8');
  parsedRows = parseCsv(csvText);
} catch (err) {
  console.error(`Could not read/parse ProviderConfig.csv at ${providerConfigPath}: ${err.message}`);
  process.exit(1);
}

// Detect whether ProviderConfig.csv itself carries a "stripPrefix" column
// (data-driven, no hardcoded provider names), matching by header name
// case-insensitively since parseCsv keys are the raw (trimmed) header text.
const stripPrefixKey = parsedRows.length > 0
    ? Object.keys(parsedRows[0]).find(k => k.toLowerCase() === 'stripprefix')
    : null;
const hasStripPrefixColumn = !!stripPrefixKey;

// Fallback data file: { "Provider Name": true, ... }. Missing/unreadable ->
// empty map, meaning "strip nothing" (safe default, matches prior behavior
// only for providers that opt in).
let providerFlags = {};
if (!hasStripPrefixColumn) {
    try {
        const flagsPath = getFilePath('providerFlags');
        if (fs.existsSync(flagsPath)) {
            providerFlags = JSON.parse(fs.readFileSync(flagsPath, 'utf-8')) || {};
        }
    } catch (err) {
        console.warn('Could not load provider-flags.json, defaulting to no prefix stripping:', err.message);
        providerFlags = {};
    }
}

// Build provider rows from the parsed CSV objects (parseCsv already strips
// the header row and handles quoted commas, so no manual header-skipping or
// column-index math is needed here anymore).
// Filter: a provider row needs a provider name AND either a real
// modelsEndpoint OR a Cookie authType. Cookie-auth providers (Qwen/Kimi)
// legitimately have an empty modelsEndpoint — they're fetched through the
// browser/session layer, not a public /models endpoint. Dropping them here
// (the old `.filter(r => r.provider && r.modelsEndpoint)`) silently removed
// them from the run with zero log output, which is exactly the "vanish with no
// explanation" behavior fetchModels()'s explicit cookie-skip log was built to
// prevent. Keeping them in `rows` lets that skip log actually fire.
const rows = parsedRows.map(r => {
    const provider = r.provider;
    const stripPrefix = hasStripPrefixColumn
        ? ['true', '1', 'yes'].includes((r[stripPrefixKey] || '').trim().toLowerCase())
        : !!providerFlags[provider];
    return {
        provider,
        baseURL: r.baseURL,
        apiKeyEnv: r.apiKeyEnv,
        modelsEndpoint: r.modelsEndpoint,
        authType: (r.authType || 'Bearer').trim().toLowerCase() || 'Bearer',
        stripPrefix
    };
}).filter(r => r.provider && (r.modelsEndpoint || r.authType === 'cookie'));

console.log(`Found ${rows.length} providers to fetch models from.`);

// Fetch models from an endpoint
async function fetchModels(provider, endpoint, apiKeyEnv, authType) {
    let config = { timeout: 10000 };

    // Only bearer-token endpoints are supported here. Cookie-auth providers
    // (authType === 'Cookie') authenticate with a session cookie via the
    // browser client, not an API key — sending the cookie string as a Bearer
    // token would always fail, so skip them explicitly instead.
    if (authType !== 'cookie') {
        // Add authorization header if API key is available
        if (apiKeyEnv && process.env[apiKeyEnv]) {
            config.headers = { 'Authorization': `Bearer ${process.env[apiKeyEnv]}` };
        }
    } else {
        console.log(`  -> Skipping ${provider}: authType=Cookie — a browser-based models fetch is not supported yet.`);
        return [];
    }
    try {
        console.log(`[FETCHING] ${provider} -> ${endpoint}`);
        const resp = await axios.get(endpoint, config);

        // Handle different response formats
        let models = [];
        if (resp.data && Array.isArray(resp.data.data)) {
            // OpenAI-style: { data: [{ id: "model_name", ... }] }
            models = resp.data.data.map(m => m.id || m.name).filter(Boolean);
        } else if (resp.data && Array.isArray(resp.data.models)) {
            // { models: [...] }
            models = resp.data.models.filter(m => typeof m === 'string').filter(Boolean);
        } else if (resp.data && Array.isArray(resp.data)) {
            // Direct array of model names
            models = resp.data.filter(m => typeof m === 'string').filter(Boolean);
        } else if (resp.data && typeof resp.data === 'object') {
            // Object with model names as keys
            models = Object.keys(resp.data).filter(k => k && k.toLowerCase() !== 'object');
        }

        console.log(`  -> Got ${models.length} models:`, models.slice(0, 3).join(', '), '...');

        return models;
    } catch (err) {
        console.log(`  -> ERROR: ${err.response?.status || err.code} - ${err.message}`);
        return ['ERROR: ' + (err.message || 'Unknown error')];
    }
}

// Main
(async () => {
    const results = [];

    // Dedup guard: only write one row per unique (provider, model) pair,
    // even if an upstream endpoint returns the same model more than once
    // or multiple fetch passes overlap.
    const seenKeys = new Set();

    // Fetch every provider concurrently (Promise.allSettled) instead of
    // serially. Each fetch is already error-isolated inside fetchModels()
    // (it catches its own axios errors and returns an ['ERROR: ...'] entry),
    // so a failed provider can never reject the whole batch or poison the
    // results of the others.
    const settled = await Promise.allSettled(rows.map(async (row) => {
        return { row, models: await fetchModels(row.provider, row.modelsEndpoint, row.apiKeyEnv, row.authType) };
    }));

    for (const outcome of settled) {
        // fetchModels never throws, but keep the guard for future-proofing.
        if (outcome.status === 'rejected' || !outcome.value) {
            const provider = outcome.value ? outcome.value.row.provider : 'unknown';
            console.log(`  -> ERROR: provider ${provider} fetch rejected unexpectedly: ${outcome.reason ? outcome.reason.message : 'unknown'}`);
            continue;
        }
        const { row, models } = outcome.value;
        // Store each model as a separate entry
        models.forEach(model => {
            // Never prefix-strip an error entry: an axios error message often
            // contains a "/" (e.g. an embedded URL), and stripping before the
            // ERROR: check would mislabel a failure as a valid model name.
            const isError = model.startsWith('ERROR:');
            // Strip provider prefix before "/" only for providers flagged as
            // using vendor-prefixed routing IDs (e.g. "openai/gpt-4" → "gpt-4").
            // Providers where "/" is part of the real model ID (e.g. Hugging
            // Face "org/model") are left untouched unless explicitly flagged.
            const modelName = (row.stripPrefix && model.includes('/') && !isError)
                ? model.split('/').slice(1).join('/')
                : model;

            const dedupeKey = `${row.provider}::${modelName}`;
            if (seenKeys.has(dedupeKey)) return; // skip exact duplicate
            seenKeys.add(dedupeKey);

            results.push({
                provider: row.provider,
                model: modelName
            });
        });
    }

    // Write to LatestModels.csv (1 row per model)
    const outputLines = ['provider,model'];
    results.forEach(r => {
        // Escape commas in provider/model by wrapping in quotes
        const escapedProvider = r.provider.includes(',') ? `"${r.provider}"` : r.provider;
        const escapedModel = r.model.includes(',') ? `"${r.model}"` : r.model;
        outputLines.push(`${escapedProvider},${escapedModel}`);
    });

    fs.writeFileSync(getFilePath(FILE_ROLES.LATEST_MODELS), outputLines.join('\n'), 'utf-8');
    console.log(`\nSaved to ${path.basename(getFilePath(FILE_ROLES.LATEST_MODELS))} with`, results.length, 'total rows (1 row per model).');

    // Also write models.csv with top 5 models per provider (for fallback dropdown)
    const providerModels = {};
    results.forEach(r => {
        if (r.model.startsWith('ERROR')) return;
        if (!providerModels[r.provider]) providerModels[r.provider] = [];
        if (providerModels[r.provider].length < 5) {
            providerModels[r.provider].push(r.model);
        }
    });
    const modelsCsvLines = ['provider,model'];
    for (const [provider, models] of Object.entries(providerModels)) {
        const escapedProvider = provider.includes(',') ? `"${provider}"` : provider;
        models.forEach(model => {
            const escapedModel = model.includes(',') ? `"${model}"` : model;
            modelsCsvLines.push(`${escapedProvider},${escapedModel}`);
        });
    }
    fs.writeFileSync(getFilePath(FILE_ROLES.MODELS), modelsCsvLines.join('\n'), 'utf-8');
    console.log(`Saved to ${path.basename(getFilePath(FILE_ROLES.MODELS))} with`, Object.values(providerModels).reduce((s, arr) => s + arr.length, 0), 'models (top 5 per provider).');

    // Summary
    const errorCount = results.filter(r => r.model.startsWith('ERROR')).length;
    const modelCount = results.length - errorCount;
    console.log(`Total models: ${modelCount} (${errorCount} errors)`);
})();

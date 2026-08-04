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
 */

const fs = require('fs');
const axios = require('axios');
const { getFilePath } = require('./state-store');
require('dotenv').config({ path: getFilePath('env') });

// Read ProviderConfig.csv (path from file-registry.json)
const csvText = fs.readFileSync(getFilePath('providerConfig'), 'utf-8');
const lines = csvText.trim().split(/\r?\n/);

// Parse CSV (comma-separated)
const rows = lines.map(line => {
    const cols = line.split(',');
    return {
        provider: cols[0],
        baseURL: cols[1],
        apiKeyEnv: cols[2],
        modelsEndpoint: cols[3]
    };
}).filter(r => r.provider && r.provider !== 'provider' && r.modelsEndpoint);

console.log(`Found ${rows.length} providers to fetch models from.`);

// Fetch models from an endpoint
async function fetchModels(provider, endpoint, apiKeyEnv) {
    let config = { timeout: 10000 };

    // Add authorization header if API key is available
    if (apiKeyEnv && process.env[apiKeyEnv]) {
        config.headers = { 'Authorization': `Bearer ${process.env[apiKeyEnv]}` };
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

    for (const row of rows) {
        const models = await fetchModels(row.provider, row.modelsEndpoint, row.apiKeyEnv);
        // Store each model as a separate entry
        models.forEach(model => {
            // Strip provider prefix before "/" (e.g. "openai/gpt-4" → "gpt-4")
            const modelName = model.includes('/') ? model.split('/').slice(1).join('/') : model;
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

    fs.writeFileSync(getFilePath('latestModels'), outputLines.join('\n'), 'utf-8');
    console.log('\nSaved to LatestModels.csv with', results.length, 'total rows (1 row per model).');

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
    fs.writeFileSync(getFilePath('models'), modelsCsvLines.join('\n'), 'utf-8');
    console.log('Saved to models.csv with', Object.values(providerModels).reduce((s, arr) => s + arr.length, 0), 'models (top 5 per provider).');

    // Summary
    const errorCount = results.filter(r => r.model.startsWith('ERROR')).length;
    const modelCount = results.length - errorCount;
    console.log(`Total models: ${modelCount} (${errorCount} errors)`);
})();

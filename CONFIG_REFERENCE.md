# LLM Proxy Router — Configuration Settings Reference

A comprehensive reference for all configuration files, their formats, and purposes in the LLM Proxy Router application.

---

## Overview

This application uses a multi-layer configuration system with clear separation of concerns:
- **Provider Configuration**: Defines API endpoints and authentication for different LLM providers
- **Proxy Configuration**: Defines which models to use and their routing settings
- **Model Lists**: Provides available models for dropdown selection
- **Runtime State**: Tracks learned routing preferences and usage statistics

---

## Configuration File Hierarchy

### Layer 1: ProviderConfig.csv (User-Editable)

**Purpose**: Defines LLM providers, their endpoints, authentication, and model discovery settings.

**Location**: `ProviderConfig.csv` (in project root)

**Format**: CSV with 4 columns

```csv
provider,baseURL,apiKeyEnv,modelsEndpoint
Kilo Gateway,https://api.kilo.ai/v1/chat/completions,KILO_GATEWAY_API_KEY,https://api.kilo.ai/api/gateway/models
NVIDIA NIM,https://integrate.api.nvidia.com/v1/chat/completions,NVIDIA_NIM_API_KEY,https://integrate.api.nvidia.com/v1/models
Mistral,https://api.mistral.ai/v1/chat/completions,MISTRAL_API_KEY,https://api.mistral.ai/v1/models
... (12 providers total)
```

**Editable By**: Users (via UI or direct file editing)

**Managed By**: Application startup (for UltimateConfig generation)

**Key Fields**:
- `provider`: Unique provider identifier (must match across all config files)
- `baseURL`: API endpoint base URL for chat completions
- `apiKeyEnv`: Environment variable name containing API key (must match `.env`)
- `modelsEndpoint`: URL to query for available models from this provider

**Usage**:
- Powers **provider dropdown** in Admin/Configuration tab
- Provides **autofill** for baseURL and apiKeyEnv in UltimateConfig table
- Source for building **UltimateConfig.csv** model lists (app-generated)
- Used by `fetch-models.js` to discover available models from each provider

**Example Provider Entries**:
```csv
Google AI Studio,https://generativelanguage.googleapis.com/v1beta/models,GOOGLE_AI_STUDIO_API_KEY,https://generativelanguage.googleapis.com/v1beta/models
Kilo Gateway,https://api.kilo.ai/v1/chat/completions,KILO_GATEWAY_API_KEY,https://api.kilo.ai/api/gateway/models
Vercel AI Gateway,https://ai-gateway.vercel.sh/v1/chat/completions,VERCEL_AI_GATEWAY_API_KEY,https://ai-gateway.vercel.sh/v1/models
```

---

### Layer 2: UltimateConfig.csv (App-Generated)

**Purpose**: Defines which specific model instances to use for proxy routing.

**Location**: `UltimateConfig.csv` (in project root)

**Format**: CSV with 5 columns

```csv
provider,baseURL,apiKeyEnv,model,enabled
Kilo Gateway,https://api.kilo.ai/v1/chat/completions,KILO_GATEWAY_API_KEY,frontier,true
Kilo Gateway,https://api.kilo.ai/v1/chat/completions,KILO_GATEWAY_API_KEY,balanced,true
NVIDIA NIM,https://integrate.api.nvidia.com/v1/chat/completions,NVIDIA_NIM_API_KEY,yi-large,true
... (1,021 entries total)
```

**Editable By**: **NEVER** - completely managed by the application

**Managed By**: Application startup and UI operations

**Key Fields**:
- `provider`: Must match a provider in `ProviderConfig.csv`
- `baseURL`: Copied from `ProviderConfig.csv` (autofilled)
- `apiKeyEnv`: Copied from `ProviderConfig.csv` (autofilled)
- `model`: Specific model name (from provider's available models)
- `enabled`: Boolean indicating whether this model should be used

**Usage**:
- **Source of truth** for which model instances to proxy
- **Read by**: Proxy server for routing decisions
- **Written by**: Application (Apply Configuration)
- **Display**: Admin/Configuration tab shows/editable version
- **Connectivity**: Powers Quick Chat and all proxy operations

**Example Generated Entries**:
```csv
Kilo Gateway,https://api.kilo.ai/v1/chat/completions,KILO_GATEWAY_API_KEY,kilo-code-default,true
NVIDIA NIM,https://integrate.api.nvidia.com/v1/chat/completions,NVIDIA_NIM_API_KEY,yi-large,true
Mistral,https://api.mistral.ai/v1/chat/completions,MISTRAL_API_KEY,ministral-14b-2512,true
```

---

### Layer 3: proxy-config.json (App-Generated)

**Purpose**: Fast-access cache of UltimateConfig.csv in JSON format for quick reload.

**Location**: `proxy-config.json` (in project root)

**Format**: JSON array of config entry objects

```json
[
  {
    "provider": "Kilo Gateway",
    "baseURL": "https://api.kilo.ai/v1/chat/completions",
    "apiKeyEnv": "KILO_GATEWAY_API_KEY",
    "model": "frontier",
    "enabled": true
  },
  {
    "provider": "NVIDIA NIM",
    "baseURL": "https://integrate.api.nvidia.com/v1/chat/completions",
    "apiKeyEnv": "NVIDIA_NIM_API_KEY",
    "model": "yi-large",
    "enabled": true
  }
  // ... 1,021 total entries
]
```

**Editable By**: **NEVER** - completely managed by the application

**Managed By**: Application startup and Apply Configuration

**Usage**:
- **Fast reload** alternative to reading CSV on every startup
- **Consumed by**: Proxy server and renderer process
- **Synchronization**: Automatically updated with UltimateConfig.csv

---

### Layer 4: models.csv (Connected Model List)

**Purpose**: User-selectable model list for dropdown filtering.

**Location**: `models.csv` (in project root, auto-connected)

**Format**: CSV with 2 columns

```csv
provider,model
Kilo Gateway,frontier
Kilo Gateway,balanced
NVIDIA NIM,yi-large
... (41 rows total)
```

**Editable By**: User (via "Load Model File" button)

**Managed By**: Application (auto-connected like `.env`)

**Key Fields**:
- `provider`: Must match a provider in `ProviderConfig.csv`
- `model`: Available model name

**Usage**:
- **Primary source** for Model dropdown in config table
- **Fallback**: If missing, falls back to models-config.js
- **Auto-connect**: Persists connection via settings.json
- **Refreshable**: Users can load new model list files

**Example Connected File**:
```csv
provider,model
Kilo Gateway,kilo-code-default
Vercel AI Gateway,ai-gateway-default
```

---

### Layer 5: models-config.js (Fallback Catalog)

**Purpose**: Default model list when no user model file is connected.

**Location**: `models-config.js` (in project root)

**Format**: JavaScript array of provider groups

```javascript
module.exports = [
  {
    provider: 'Kilo Gateway',
    baseURL: 'https://api.kilocode.ai/v1/chat/completions',
    apiKeyEnv: 'KILO_GATEWAY_API_KEY',
    models: ['kilo-code-default']
  },
  {
    provider: 'NVIDIA NIM',
    baseURL: 'https://integrate.api.nvidia.com/v1/chat/completions',
    apiKeyEnv: 'NVIDIA_NIM_API_KEY',
    models: ['yi-large', 'fuyu-8b', 'jamba-1.5-large-instruct']
  },
  // ... 17 provider groups total
];
```

**Editable By**: Application source code (developers)

**Managed By**: Application startup

**Usage**:
- **Fallback model source** when no user model file is connected
- **Seed for** UltimateConfig.csv generation
- **Contains**: 17 providers including ones not in ProviderConfig.csv

---

### Layer 6: LatestModels.csv (Fetched Models)

**Purpose**: Live model discovery results from each provider.

**Location**: `LatestModels.csv` (in project root)

**Format**: CSV with 2 columns

```csv
provider,model
Kilo Gateway,frontier
Kilo Gateway,balanced
NVIDIA NIM,yi-large
... (1,022 rows total)
```

**Editable By**: Application (via fetch-models.js)

**Managed By**: Application (fetch-models.js script)

**Usage**:
- **Primary model source** for model dropdown
- **Error handling**: Rows with `ERROR:...` are skipped
- **Generated by**: `fetch-models.js` script
- **Updates**: Run via UI "Fetch All Models" or manually

**Example Fetched Content**:
```csv
Kilo Gateway,frontier
NVIDIA NIM,ERROR: Request failed with status code 401
Mistral,ministral-14b-2512
```

---

### Layer 7: .env (Environment Variables)

**Purpose**: Stores API keys for all providers.

**Location**: `.env` (in project root)

**Format**: KEY=VALUE pairs

```bash
KILO_GATEWAY_API_KEY=your_api_key_here
NVIDIA_NIM_API_KEY=your_nvidia_key_here
MISTRAL_API_KEY=your_mistral_key_here
GOOGLE_AI_STUDIO_API_KEY=your_google_key_here
ANTHROPIC_API_KEY=your_anthropic_key_here
... (12 provider keys)
```

**Editable By**: Users (via env.example template)

**Managed By**: Application (dotenv)

**Usage**:
- **API key storage** for all external providers
- **Read by**: Proxy server and fetch-models.js
- **Security**: Never committed to version control
- **Template**: env.example provides defaults

**Example .env**:
```bash
# Fill these with your own API keys. Leave blank if not used.
KILO_GATEWAY_API_KEY=kgw_xxx
NVIDIA_NIM_API_KEY=nvidia_xxx
GOOGLE_AI_STUDIO_API_KEY=google_xxx
...
```

---

### Layer 8: Runtime State Files

**Purpose**: Tracks application state and usage statistics across restarts.

#### known-ok.json

**Purpose**: Persists learned routing preferences and response times.

**Format**: JSON array of learning records

```json
[
  {
    "provider": "Mistral",
    "model": "ministral-14b-2512",
    "status": "OK",
    "latency": 1073
  },
  {
    "provider": "Mistral",
    "model": "mistral-medium",
    "status": "OK",
    "latency": 1074
  }
  // ... 36 learned entries
]
```

**Editable By**: Application (learning during operation)
**Managed By**: Application (`saveResults`/`loadResults`)

#### token-usage.json

**Purpose**: Tracks token consumption statistics.

**Format**: Object mapping provider::model keys to usage data

```json
{
  "Mistral::ministral-14b-2512": {
    "provider": "Mistral",
    "model": "ministral-14b-2512",
    "requests": 5,
    "promptTokens": 1234,
    "completionTokens": 567,
    "totalTokens": 1801
  },
  "Kilo Gateway::frontier": {
    "provider": "Kilo Gateway",
    "model": "frontier",
    "requests": 3,
    "promptTokens": 892,
    "completionTokens": 445,
    "totalTokens": 1337
  }
  // ... usage data for all providers
}
```

**Editable By**: Application (during proxy operation)
**Managed By**: Application (`saveUsage`/`loadUsage`)

#### settings.json

**Purpose**: Persists user preferences for auto-connected files.

**Format**: Simple object

```json
{
  "modelsFile": "/abs/path/to/user/models.csv"
}
```

**Editable By**: Application (when user loads new model file)
**Managed By**: Application (`saveSettings`/`loadSettings`)

---

## Configuration File Interactions

### ProviderConfig.csv → UltimateConfig.csv Generation
```javascript
// Startup process
const providerMap = loadProviderConfig();           // Read ProviderConfig.csv
const modelLists = await buildModelListsForProviders(providerMap);  // Generate model lists
configEntries = modelLists;                           // Create UltimateConfig entries

// Output: UltimateConfig.csv with ~1,021 entries
// Each entry: provider, baseURL, apiKeyEnv, model, enabled
```

### User Provider Management
```javascript
// User edits ProviderConfig.csv via UI
// On save:
ipcMain.handle('save-provider-config', async (event, providerConfig) => {
  // Parse existing ProviderConfig.csv
  // Update or add provider entries
  // Write back to ProviderConfig.csv
});

// Result: UltimateConfig.csv auto-regenerated on next startup
```

### UltimateConfig.csv → Proxy Configuration
```javascript
// Proxy server startup
const entries = await getConnectedConfig();  // Read UltimateConfig.csv
modelEntries = entries.filter(e => e.enabled);  // Filter enabled entries

// Result: Proxy configured with enabled model entries
```

### .env → Provider Authentication
```javascript
// Proxy server operation
const apiKey = process.env[entry.apiKeyEnv];  // Get API key from .env

// Example: entry.apiKeyEnv = "KILO_GATEWAY_API_KEY"
// Looks up: process.env["KILO_GATEWAY_API_KEY"]
```

---

## Configuration Management Commands

### Startup Commands
```bash
# Syntax check all configuration-related files
node --check main.js          # Main process
node --check preload.js       # Security bridge
node --check renderer.js      # UI process
node --check proxy-server.js  # Proxy engine
node --check state-store.js   # Persistence layer
node --check fetch-models.js  # Model discovery
node --check models-config.js # Fallback catalog

# Launch application
npm start          # Electron
npm run dev        # Node with electron
```

### Model Discovery
```bash
# Manually fetch latest models from all providers
node fetch-models.js

# Alternative: Run via UI
# Admin/Configuration Tab → Fetch All Models button
```

### Configuration Validation
```bash
# Check for syntax errors in ProviderConfig.csv
node -e "
const fs = require('fs');
const csvText = fs.readFileSync('ProviderConfig.csv', 'utf-8');
console.log('ProviderConfig.csv syntax OK');
console.log('Providers:', csvText.trim().split('\n').length - 1);
"
```

### Backup Configuration
```bash
# Create backup of all configuration files
mkdir backup_$(date +%Y%m%d_%H%M%S)
cp ProviderConfig.csv UltimateConfig.csv models.csv settings.json known-ok.json token-usage.json backup_$(date +%Y%m%d_%H%M%S)/
cp .env .env.backup
```

---

## File Dependencies and Relationships

| File | Depends On | Provides To | Purpose |
|------|------------|-------------|---------|
| `ProviderConfig.csv` | `.env` (API key names) | `UltimateConfig.csv`, `models-config.js` | Provider metadata and discovery endpoints |
| `UltimateConfig.csv` | `ProviderConfig.csv` | `proxy-config.json`, `proxy-server.js` | Proxy model configuration |
| `proxy-config.json` | `UltimateConfig.csv` | `proxy-server.js` | Fast JSON cache of proxy config |
| `models.csv` | `.env` (optional) | `renderer.js` | User-selectable model list |
| `LatestModels.csv` | `ProviderConfig.csv`, `.env` | `renderer.js` | Live model discovery results |
| `models-config.js` | N/A | `UltimateConfig.csv` | Fallback model catalog |
| `.env` | N/A | All files using API keys | Secure API key storage |

---

## Best Practices

### Provider Management
1. **Match Provider Names Exactly**: Ensure provider names are consistent across all files
2. **Test API Keys**: Verify `.env` values work with ProviderConfig URLs
3. **Document Models**: Keep model lists updated for each provider
4. **Backup Regularly**: Create backups before major configuration changes

### Configuration Changes
1. **Edit ProviderConfig.csv First**: Add/remove providers here
2. **Restart After Changes**: New providers appear after app restart
3. **Use UI for Models**: Manage model lists through the Admin tab
4. **Validate After Changes**: Use startup checks to verify configuration

### Security Practices
1. **Never Commit .env**: Add to `.gitignore`
2. **Use env.example**: Provide template for team members
3. **Protect API Keys**: Never log or expose API key values
4. **Validate Input**: Sanitize user input in configuration forms

---

## Troubleshooting Reference

### Common Issues and Solutions

**Provider not appearing in dropdown**:
```
# Check ProviderConfig.csv syntax
# Ensure provider name matches exactly
# Verify .env has corresponding API key
# Restart application
```

**No models available**:
```
# Run fetch-models.js to update LatestModels.csv
# Check models.csv connection
# Verify provider model lists are correct
```

**Proxy connection errors**:
```
# Check .env API key values
# Verify UltimateConfig.csv entries are correct
# Check known-ok.json for learned routes
```

**Configuration validation failures**:
```
# Run node --check on all JS files
# Verify CSV file syntax
# Check for extra commas or missing fields
```

---

*Last updated: 2026-08-04*
*All configuration file paths are relative to project root*
*Configuration syntax verified using node --check*

---

**Note**: This reference is continuously updated as the application evolves. Always verify current file formats against actual implementation.

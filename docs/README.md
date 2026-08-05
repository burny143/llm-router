# LLM Proxy Router — High-Availability LLM API Proxy with Desktop GUI

A local Electron application that runs a **fallback LLM proxy server** on your machine. Configure a list of provider endpoints (API base URLs, API keys via environment variables, model names), and the proxy automatically routes requests to the fastest healthy endpoint, falls back through the rest in parallel when one fails, and learns at runtime to optimize routing.

The proxy speaks **OpenAI-compatible `/v1/chat/completions`**, so any OpenAI SDK, `curl`, Open WebUI, Continue, etc. can point at `http://localhost:PORT/v1/chat/completions` and get automatic failover.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture Overview](#architecture-overview)
- [Core Features](#core-features)
- [File Map & Relationships](#file-map--relationships)
- [Configuration Model (Two-Layer)](#configuration-model-two-layer)
- [Data Flow](#data-flow)
- [Tabs & UI Reference](#tabs--ui-reference)
- [Data Files](#data-files)
- [Development](#development)
- [Known Gaps & Roadmap](#known-gaps--roadmap)

---

## Quick Start

```bash
# Install dependencies
npm install

# Copy example env file and add your API keys
cp env.example .env
# Edit .env with your keys

# Start the app
npm start          # Runs Electron
# or
npm run dev        # Runs via start.js
```

**First run:**
1. `ProviderConfig.csv` is the **single source of truth for available providers**. Add or remove a provider row here to control which providers the app uses.
2. `file-registry.json` is the **file-path notepad** — it maps every data-file role (`providerConfig`, `ultimateConfig`, `models`, `latestModels`, `.env`, …) to the actual file. To use a different file for a role, edit this JSON (relative to project root, or absolute). See [Swapping Data Files](#swapping-data-files).
3. The app auto-loads `models.csv` (provider,model list) for dropdown options
4. The app auto-loads `UltimateConfig.csv` (if present) as the proxy config source of truth, **pruning any entries for providers that are no longer in `ProviderConfig.csv`** (propagated to `proxy-config.json` too)
5. Go to **Admin / Configuration** tab → click **Load Defaults** to populate the config from `models.csv` (all models per provider)
6. Go to **Proxy Control** tab → set port → click **Connect**
7. Test in **Quick Chat** or point any OpenAI client to `http://localhost:8000/v1/chat/completions`

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Electron App                             │
├─────────────────────────────────────────────────────────────────┤
│  main.js (Main Process)                                        │
│  ├─ Window management                                          │
│  ├─ IPC handlers (start/stop proxy, health check, file I/O)   │
│  ├─ Auto-connect model-list file (like .env)                  │
│  ├─ Auto-connect config file (source of truth)                │
│  ├─ Log forwarding to renderer                                 │
│  └─ Persistence coordination                                   │
│                                                                 │
│  preload.js (Context Bridge)                                   │
│  └─ Exposes window.api → renderer (secure IPC surface)        │
│                                                                 │
│  renderer.js (UI Process)                                      │
│  ├─ Config table (Provider / BaseURL / API Key Env / Model)   │
│  ├─ Quick Chat (test proxy in-app)                            │
│  ├─ Developer Logs (color-coded, capped 500 lines)            │
│  ├─ Health Check tab                                          │
│  └─ Token Usage tab                                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  proxy-server.js (Express Proxy Server — runs in main process) │
│  ├─ Express server on /v1/chat/completions                    │
│  ├─ Routing Engine: orderEntries()                             │
│  │   └─ known-OK (sequential, fastest first) → rest (parallel) │
│  ├─ probeOne() → HTTP POST to provider                         │
│  ├─ extractContent() → validates real text in response         │
│  ├─ learnSuccess() / learnFailure() → runtime learning        │
│  ├─ recordUsage() → token counting                             │
│  └─ setHealthResults() → live routing update (no restart)     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Features

### Proxy Core
- **Express server** at `http://localhost:PORT/v1/chat/completions`
- **OpenAI-compatible API** — works with any OpenAI SDK / client
- **Streaming supported** — `stream: true` returns OpenAI-style SSE (`data:` delta chunks, `finish_reason`, `[DONE]`); upstream probing stays buffered so routing/fallback is preserved, and the winner's content is replayed as chunks

### Intelligent Routing
| Phase | Strategy | Behavior |
|-------|----------|----------|
| **Known-OK** | Sequential (fastest first) | Probes confirmed-working models in latency order; stops at first success |
| **Untested** | Parallel (first success wins) | Fires all at once; returns immediately on first success; cancels stragglers |
| **Known-Failed** | Skipped | Deprioritized entirely |

### Runtime Learning
- **`learnSuccess`**: On first successful request, promotes model to `known-ok.json` with latency; future requests prioritize it
- **`learnFailure`**: If a known-OK model fails at request time, demotes it and marks failed so it's skipped next time
- **Health Check** updates routing live (no restart needed) — `setHealthResults()` rebuilds `knownOk` array from health results

### Health Check (Content-Aware)
- Pings all enabled entries with `{"messages":[{"role":"user","content":"ping"}],"max_tokens":1}`
- **Validates response content** — rejects HTTP 200 with error bodies (e.g., Zen's `{"code":401,...}`)
- Stores OK endpoints to `known-ok.json` with latency
- Results displayed in **Health Check** tab with OK/FAIL + latency

### Token Usage Tracking
- Parses `usage` from provider responses (supports `prompt_tokens`/`input_tokens`, `completion_tokens`/`output_tokens`, `total_tokens`)
- Aggregated per `provider::model` key
- Persisted to `token-usage.json`
- Displayed in **Token Usage** tab with prompt/completion/total + summary

### Auto-Connect (Like `.env`)
| File | Purpose | Behavior |
|------|---------|----------|
| **Model List** (`models.csv`) | Dropdown options for Provider + Model | Auto-loaded on startup from `settings.json`; persists path; reload on file change via "Load Model File" |
| **Config File** (`UltimateConfig.csv`) | Source of truth for proxy entries | Auto-loaded on startup; Apply Configuration writes back to it + `proxy-config.json` |

### Web Providers (Cookie Auth) — e.g. Qwen / Kimi Chat
- **"Add Web Provider (Cookie)" button** (Admin/Configuration tab): pick a preset (Qwen,
  Kimi) from the dropdown or type a custom provider name + login URL, then a real headed
  browser opens (Playwright Chromium/Chrome/Edge), you log in and send **one test message**,
  the chat API request is captured automatically (URL, headers, payload, cookies).
- The captured session cookie is stored in `data/.env` as `<PREFIX>_COOKIE` (e.g.
  `QWEN_COOKIE`, `KIMI_COOKIE`), the provider row is upserted into `ProviderConfig.csv` with
  `authType=Cookie`, and captured request/header rules are saved to
  `data/web-provider-rules.json`.
- **Qwen**: requests are sent through `src/browser-http-client.js` (Playwright in-page fetch)
  to bypass WAF/TLS-fingerprint blocking; the browser runs minimized with a persistent profile
  in `data/browser-profiles/` so login state is reused until the cookie expires.
- **Kimi (kimi.moonshot.cn)**: uses a **token-exchange protocol** instead of cookies.
  The captured JWT `refresh_token` is stored as `authToken` in `web-provider-rules.json`
  (not as a cookie). At request time the proxy routes Kimi through `src/kimi-web-client.js`,
  a plain-axios client that performs the full dance:
  `GET /api/auth/token/refresh` (Bearer refresh_token) → access_token (300 s TTL, cached) →
  `GET /api/user` → userId → `POST /api/chat` → convId → `POST /api/chat/{convId}/completion/stream`
  (SSE, `cmpl`/`all_done`/`error`/`search_plus`) → `DELETE /api/chat/{convId}` cleanup.
  No Playwright is involved — WAF/TLS bypass is achieved via browser-like headers and fake
  cookies. The client auto-refreshes the 5-min access_token from the long-lived refresh_token.
- The proxy translates your OpenAI-style request into the web API's captured payload shape
  (`injectUserText()`), and normalizes the web API response back into OpenAI-style JSON
  (`extractContent()` handles `answer`, `text`, `result`, `message`, `data.data.*`, SSE
  `data:` frames, raw JSON-line streams, and a longest-string fallback).
- **Clear Session** (with the provider dropdown) removes that provider's cookie + rules
  (does not touch the provider row); re-run "Add Web Provider" to log in again. For Kimi,
  the token is removed from `web-provider-rules.json`; no cookie exists to clear.
- Existing Bearer/API-key providers are unaffected — only rows with `authType=Cookie` take
  the cookie/token path.

### Developer Logs
- Main-process `console.log/warn/error` forwarded to **Proxy Control** tab panel
- Capped at 500 lines, color-coded (error=red, warn=yellow, OK=green)
- "Clear Logs" button

---

## File Map & Relationships

### Source Code

All app code lives in `src/` (entry: `package.json` → `src/main.js`). All data files live
in `data/` and are resolved via `file-registry.json` → `state-store.getFilePath(role)`.

| File | Role | Dependencies |
|------|------|--------------|
| `src/main.js` | Electron main process: window, IPC, health check, log forwarding, startup auto-load | `proxy-server.js`, `state-store.js`, `models-config.js`, `dotenv` |
| `src/preload.js` | Context bridge → `window.api` (typed IPC surface) | `electron` (contextBridge, ipcRenderer) |
| `src/renderer.js` | All UI logic: config table, quick chat, dev logs, health tab, token usage tab | `window.api` (from preload) |
| `src/proxy-server.js` | Express proxy + routing engine (`probeSequential`, `probeParallel`, `learnSuccess`, `learnFailure`, `extractContent`, `recordUsage`, `injectUserText`) | `axios`, `dotenv`, `state-store.js`, `browser-http-client.js` (cookie auth), `kimi-web-client.js` (Kimi token flow) |
| `src/state-store.js` | JSON/CSV persistence + `getFilePath(role)` registry resolution | `fs`, `path` |
| `src/setup-web-provider.js` | Playwright capture script (spawned by main.js): headed browser, capture chat request + cookies, write `.env` + ProviderConfig.csv + web-provider-rules.json | `playwright`, `dotenv`, `state-store.js` |
| `src/browser-http-client.js` | Playwright in-page-fetch HTTP client for cookie-auth providers (WAF/TLS bypass) | `playwright`, `state-store.js` |
| `src/kimi-web-client.js` | **NEW (2026-08-05)** — plain-axios Kimi token-exchange client: refresh_token → access_token (300s cache) → userId → convId → SSE completion → cleanup; zero Playwright; used by proxy-server.js and main.js health check | `axios` |
| `src/tls-http-client.js` | **Archived** (dead code) — required uninstalled `tls-client` package; moved to `archive/` 2026-08-05 | — |
| `src/models-config.js` | **Default catalog** — 17 providers with base URLs, env var names, model lists | (standalone) |
| `src/fetch-models.js` | Model fetcher (regenerates `data/LatestModels.csv` + `data/models.csv`) | `axios`, `dotenv`, `state-store.js` |
| `src/index.html` | Four tabs: Proxy Control, Admin/Configuration, Health Check, Token Usage | `style.css`, `renderer.js` (same folder) |
| `src/style.css` | Light theming, tables, log colors, status labels | — |

### Configuration & Data Files (Source of Truth Hierarchy)

```
┌────────────────────────────────────────────────────────────────────┐
│                    CONFIGURATION HIERARCHY                         │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Layer 0: file-registry.json  ◄─── FILE-PATH NOTEPAD             │
│  ├─ Purpose: Maps every data-file role to its actual path       │
│  │  (providerConfig, ultimateConfig, proxyConfig, models,       │
│  │  latestModels, knownOk, tokenUsage, settings, env)           │
│  ├─ Paths: relative to project root, or absolute                │
│  ├─ Resolved by: state-store.getFilePath(role)                  │
│  ├─ Missing role → falls back to default filename               │
│  └─ Editing this file = swapping which file the app uses        │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Layer 1: ProviderConfig.csv  ◄─── PRIMARY PROVIDER METADATA      │
│  ├─ Purpose: API keys (ANTHROPIC_API_KEY, GROQ_API_KEY, etc.)    │
│  ├─ Loaded: By main.js on startup → process.env                   │
│  └─ Format: KEY=VALUE                                              │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Layer 1: ProviderConfig.csv  ◄─── PRIMARY PROVIDER METADATA      │
│  ├─ Purpose: Single source of truth for provider endpoint URLs   │
│  │         and API key environment variable names                 │
│  ├─ Schema: provider,baseURL,apiKeyEnv,modelsEndpoint,authType  │
│  │         (authType: Bearer default, or Cookie for web providers)│
│  ├─ Rows: 12 providers (Kilo Gateway, NVIDIA NIM, etc.)         │
│  ├─ Loaded: By state-store.js → provider lookup map              │
│  ├─ Used by: renderer.js (autofill baseURL/apiKeyEnv)            │
│  ├─ Cascade: Removing a provider row prunes its entries from     │
│  │   UltimateConfig.csv + proxy-config.json on next startup      │
│  └─ Sample: sample-config.csv                                     │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Layer 2: UltimateConfig.csv  ◄─── PRIMARY PROXY CONFIG TRUTH    │
│  ├─ Purpose: Human-editable source of truth for proxy entries    │
│  ├─ Schema: provider,baseURL,apiKeyEnv,model,enabled             │
│  │   - baseURL + apiKeyEnv: looked up from ProviderConfig.csv    │
│  │   - model + enabled: per-row editable                         │
│  ├─ Rows: 1 per model entry (1038 in current file)               │
│  ├─ Loaded: By state-store.js syncConfigFromCsv()                │
│  ├─ Synced to: proxy-config.json (auto-generated, fast reload)   │
│  ├─ Apply Configuration: writes table → UltimateConfig.csv +     │
│  │   proxy-config.json                                           │
│  ├─ Import Config: loads external CSV/Excel → UltimateConfig.csv │
│  └─ Fallback: models-config.js if missing                        │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Layer 3: proxy-config.json  ◄─── AUTO-GENERATED (DO NOT EDIT)   │
│  ├─ Purpose: Fast reload cache synced from UltimateConfig.csv    │
│  ├─ Generated: On startup (syncConfigFromCsv) & Apply Config     │
│  ├─ Schema: Same as UltimateConfig.csv (JSON array)              │
│  └─ Loaded: By state-store.js loadConfig()                       │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Layer 4: models.csv  ◄─── DROPDOWN MODEL SOURCE                 │
│  ├─ Purpose: All available models for Provider/Model dropdowns   │
│  ├─ Schema: provider,model                                       │
│  ├─ Rows: 41 rows (top 5 models per provider)                    │
│  ├─ Auto-connected: On startup (like .env) via settings.json    │
│  ├─ Load Model File: Selects new file, persists to settings.json │
│  └─ Fallback: models-config.js model lists                       │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Layer 5: Default Catalog (Fallback)                             │
│  ├─ models-config.js: 17 providers with baseURL, apiKeyEnv,      │
│  │   models arrays                                               │
│  ├─ Used when: UltimateConfig.csv missing OR model list missing  │
│  └─ model-config.js: Archived (legacy, not used)                 │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### Swapping Data Files

`file-registry.json` is the single place that says **which file plays which role**.
Every module resolves data-file paths through `state-store.getFilePath(role)`, so you
can insert/eject a file by editing this JSON — no code changes, no restart of logic:

```json
{
  "providerConfig": "ProviderConfig.csv",
  "ultimateConfig": "UltimateConfig.csv",
  "proxyConfig": "proxy-config.json",
  "models": "models.csv",
  "latestModels": "LatestModels.csv",
  "knownOk": "known-ok.json",
  "tokenUsage": "token-usage.json",
  "settings": "settings.json",
  "env": ".env"
}
```

- **Relative paths** resolve against the project root; **absolute paths** are used as-is.
- **Delete a role** (or leave the file missing) → that role falls back to its default
  filename, so the app never breaks on an incomplete registry.
- Swaps take effect on the next app start (no live file watcher).

### Runtime State Files

| File | Purpose | Updated By |
|------|---------|------------|
| `known-ok.json` | Persisted routing priority: `{provider,model,status,latency}` array | `saveResults()` from health check & runtime learning |
| `token-usage.json` | Persisted token counters per `provider::model` | `saveUsage()` from `recordUsage()` in proxy-server |
| `settings.json` | `{ "modelsFile": "/abs/path/to/connected.csv" }` — model-list auto-connect target | `saveSettings()` when connecting model file |
| `proxy-config.json` | Auto-generated from `UltimateConfig.csv` for fast reload | `saveConfigBoth()` |
| `web-provider-rules.json` | Captured request/header rules per web provider: `{provider: {samplePayload, headers, userAgent, origin, referer, profileKey, authToken?}}` — Kimi stores its refresh_token JWT as `authToken` here | `setup-web-provider.js` (capture), `SET_PROVIDER_COOKIE` (manual paste) |

---

## Configuration Model (Two-Layer)

### Layer 1: ProviderConfig.csv — Provider Metadata Lookup
**File**: `ProviderConfig.csv` (one row per provider)

```csv
provider,baseURL,apiKeyEnv,modelsEndpoint,authType
Kilo Gateway,https://api.kilo.ai/v1/chat/completions,KILO_GATEWAY_API_KEY,,Bearer
Qwen,https://chat.qwen.ai/api/v2/chat/completions?chat_id=...,QWEN_COOKIE,,Cookie
```

**Purpose**: Single source of truth for provider endpoint URLs and API key env var names.

**Behavior**:
- Loaded on startup → builds `provider → {baseURL, apiKeyEnv}` lookup map (`providerInfo` in renderer)
- When a provider is selected in the config table, this file provides the autofill values
- Provider names **must match** provider names in `UltimateConfig.csv` and `models.csv`

### Layer 2: UltimateConfig.csv — Editable Truth for Proxy Entries
**File**: `UltimateConfig.csv` (one row per model entry)

```csv
provider,baseURL,apiKeyEnv,model,enabled
Kilo Gateway,https://api.kilo.ai/v1/chat/completions,KILO_GATEWAY_API_KEY,frontier,true
NVIDIA NIM,https://integrate.api.nvidia.com/v1/chat/completions,NVIDIA_NIM_API_KEY,yi-large,true
...
```

**Schema**: `provider,baseURL,apiKeyEnv,model,enabled`

| Column | Source | Editable in UI |
|--------|--------|----------------|
| A: `provider` | Must match ProviderConfig.csv | Dropdown (filtered to ProviderConfig.csv providers) |
| B: `baseURL` | Autofilled from ProviderConfig.csv | Readonly input (auto-fills on provider change) |
| C: `apiKeyEnv` | Autofilled from ProviderConfig.csv | Readonly input (auto-fills on provider change) |
| D: `model` | Filtered to selected provider's models from `models.csv` | Dropdown |
| E: `enabled` | Per-entry toggle | Checkbox |

**Behavior**:
- On startup: reads `UltimateConfig.csv` + `ProviderConfig.csv` → generates `proxy-config.json` → populates config table
- On **Apply Configuration**: writes current table → `UltimateConfig.csv` + `proxy-config.json`
- On **Import Config from CSV/Excel**: loads external file → auto-fills baseURL/apiKeyEnv from ProviderConfig.csv → writes to `UltimateConfig.csv` + `proxy-config.json`
- Provider is tied to its `baseURL` + `apiKeyEnv` via `ProviderConfig.csv`; only `model` and `enabled` change per-row
- If `UltimateConfig.csv` missing → falls back to default catalog (`models-config.js`)

### Layer 3: models.csv — Dropdown Options for Models
**File**: `models.csv` (auto-connected on startup like `.env`)

```csv
provider,model
Anthropic,claude-3-5-sonnet-20241022
Anthropic,claude-3-5-haiku-20241022
OpenAI,gpt-4o
...
Kilo Gateway,kilo-code-default
...
```

**Schema**: `provider,model`

**Behavior**:
- Auto-connected on startup (path remembered in `settings.json`)
- Feeds **Provider** and **Model** dropdowns in the config table
- "Load Model File" button → selects new file, persists to `settings.json`, reconnects

---

## Data Flow

```
User Request (OpenAI SDK → localhost:PORT/v1/chat/completions)
         │
         ▼
proxy-server.js: orderEntries() → known-OK first (sequential) → rest (parallel)
         │
         ├── probeOne(entry) → HTTP POST to provider /chat/completions
         │        │
         │        ├── extractContent() validates body has real text
         │        │        │
         │        │        ├── success → learnSuccess(key) → known-ok.json
         │        │        │        │
         │        │        │        └── returns response + _meta{provider,model,elapsed}
         │        │        │
         │        │        └── failure (or garbage body) → learnFailure(key) → known-ok.json
         │        │
         │        └── first success wins; others cancelled
         │
         ▼
Client receives OpenAI-compatible response (+ _meta for UI)
```

### Startup Sequence (main.js)
```
app.whenReady()
  ├─ forwardLogsToRenderer()     // console.log/warn/error → dev-logs panel
  ├─ loadHealthResults()         // known-ok.json → setHealthResults()
  ├─ autoConnectModelFile()      // settings.json → models.csv → extractModelsFromRows()
  ├─ autoConnectConfigFile()     // UltimateConfig.csv → syncConfigFromCsv() → pruneConfigEntries() vs ProviderConfig.csv → proxy-config.json
  └─ createWindow()              // loads index.html
```

### Config Load Sequence (renderer.js)
```
loadDefaultConfig()
  ├─ getProviderConfig()     → ProviderConfig.csv → providerInfo (provider→{baseURL,apiKeyEnv,models:[]})
  ├─ getDefaultConfig()      → models-config.js → add models to matching providers in providerInfo
  ├─ getEnvVars()            → .env → envVars array
  ├─ getConnectedModelList() → models.csv → loadedModels, providerModelsFromFile
  ├─ getConnectedConfig()    → UltimateConfig.csv → configEntries (pruned to ProviderConfig.csv providers)
  └─ renderConfigTable()     → builds table with dropdowns
```

---

## Tabs & UI Reference

### 1. Proxy Control Tab
| Element | Function |
|---------|----------|
| Port input | Proxy server port (default 8000) |
| Connect button | Starts Express proxy with current enabled entries |
| Disconnect button | Stops proxy server |
| Server status | Green "Server running at http://localhost:PORT/" / red "Server stopped" |
| Quick Chat | Test proxy in-app; Enter to send; timestamps + meta (provider, model, latency) |
| Clear Logs | Clears developer logs panel |
| Developer Logs | Main-process logs (color-coded, capped 500 lines) |

### 2. Admin / Configuration Tab
| Element | Function |
|---------|----------|
| **+ Add Entry** | Adds new row with first ProviderConfig.csv provider, empty model |
| **Load Defaults** | Clears table, adds 1 entry per model in `models.csv` (per provider present in ProviderConfig.csv) with autofilled baseURL/apiKeyEnv; falls back to models-config.js models for providers missing from models.csv |
| **Clear All** | Removes all entries from table |
| **Import Config from CSV/Excel** | Opens file dialog → loads external config → auto-fills baseURL/apiKeyEnv from ProviderConfig.csv → saves to UltimateConfig.csv |
| **+ Add Web Provider (Cookie)** | Opens modal (preset dropdown: Qwen/Kimi/Custom + provider name + login URL) → spawns `setup-web-provider.js` → headed browser capture of a cookie-authed chat provider (see [Web Providers](#web-providers-cookie-auth--eg-qwen--kimi-chat)) |
| **Clear Session** | With the provider dropdown: removes `<PREFIX>_COOKIE` from `.env` + that provider's rules; browser profile untouched |
| **Apply Configuration** | Saves current table to UltimateConfig.csv + proxy-config.json; if proxy running, restarts with new entries (no health check) |
| Config Table | Columns: #, Provider (dropdown), Base URL (readonly), API Key Env Var (readonly), Model (dropdown), Enabled (checkbox), Actions (delete) |

**Provider Dropdown**: Only shows providers from `ProviderConfig.csv` (16 providers incl. Qwen)

**Model Dropdown**: Filtered to selected provider's models from `models.csv` + `models-config.js`
(web providers get a `<Provider>-chat` placeholder model added automatically on capture)

### 3. Health Check Tab
| Element | Function |
|---------|----------|
| Ping All Models | Runs health check on all enabled entries |
| Results Table | Provider, Model, Status (OK/Failed + latency) |
| Summary | Total OK / Total Failed count |

### 4. Token Usage Tab
| Element | Function |
|---------|----------|
| Refresh | Reloads token usage from `token-usage.json` |
| Results Table | #, Provider, Model, Requests, Prompt Tokens, Completion Tokens, Total Tokens |
| Summary | Models count, Total Requests, Prompt/Completion/Total tokens |

---

## Data Files

### Core Data Files (Project Root)

| File | Description | Format |
|------|-------------|--------|
| `file-registry.json` | File-path notepad: maps every data-file role to its path | JSON |
| `.env` | API keys + web-provider cookies (e.g. `QWEN_COOKIE`) (not committed) | `KEY=VALUE` |
| `env.example` | Template for .env | `KEY=VALUE` |
| `ProviderConfig.csv` | Provider metadata | `provider,baseURL,apiKeyEnv,modelsEndpoint,authType` |
| `UltimateConfig.csv` | Proxy config source of truth (1038 entries) | `provider,baseURL,apiKeyEnv,model,enabled` |
| `proxy-config.json` | Auto-generated from UltimateConfig.csv (1038 entries) | JSON array |
| `models.csv` | All available models for dropdowns (41 rows, top 5 per provider) | `provider,model` |
| `known-ok.json` | Persisted routing priority | `[{provider,model,status,latency}]` |
| `token-usage.json` | Per-model token counters | `{"provider::model":{prompt,completion,total}}` |
| `settings.json` | `{ "modelsFile": "/abs/path/to/connected.csv" }` | JSON |
| `web-provider-rules.json` | Captured request/header rules per web provider: `{provider: {samplePayload, headers, userAgent, origin, referer, profileKey, authToken?}}` — Kimi stores its refresh_token JWT as `authToken` | JSON |
| `browser-profiles/` | Persistent Playwright browser profiles per provider (login state, NOT committed) | dir |

### Sample / Reference Files

| File | Purpose |
|------|---------|
| `sample-config.csv` | Reference format for proxy config CSV |
| `sample-models.csv` | Sample model list (20 rows, 11 providers) |
| `sample-models.xlsx` | Excel version of sample-models.csv |

### Utility / Generated Files

| File | Purpose |
|------|---------|
| `LatestModels.csv` | Generated by `fetch-models.js`: live model counts from each provider's API (1022 rows) |
| `fetch-models.js` | Script: reads ProviderConfig.csv, queries modelsEndpoint URLs, writes LatestModels.csv |

---

## Development

### Project Structure
```
llm-proxy-gui/
├── package.json           # Dependencies + scripts ("main": src/main.js)
├── package-lock.json
├── file-registry.json     # File-path notepad (role → path; lands in data/ by default)
├── .gitignore
├── src/                   # All application code (JS + HTML + CSS together)
│   ├── main.js            # Electron main process (entry)
│   ├── preload.js         # Context bridge
│   ├── proxy-server.js    # Express proxy + routing
│   ├── state-store.js     # JSON/CSV persistence + getFilePath() registry resolve
│   ├── setup-web-provider.js # Playwright capture script for cookie-authed providers
│   ├── browser-http-client.js # Playwright in-page-fetch client (cookie auth / WAF bypass)
│   ├── models-config.js   # Default catalog (17 providers) — fallback
│   ├── fetch-models.js    # Model fetcher script (reads ProviderConfig.csv)
│   ├── start.js           # Dev launcher (npx electron .)
│   ├── index.html         # 4-tab UI
│   ├── renderer.js        # UI logic
│   └── style.css          # Theming
├── data/                  # Data files (resolved via file-registry.json)
│   ├── ProviderConfig.csv # Provider metadata
│   ├── UltimateConfig.csv # Proxy config truth
│   ├── proxy-config.json  # Auto-generated from CSV
│   ├── models.csv         # Model dropdown source
│   ├── LatestModels.csv   # Fetched live models
│   ├── known-ok.json      # Routing priority (runtime)
│   ├── token-usage.json   # Token counters (runtime)
│   ├── settings.json      # Model-list path (runtime)
│   ├── web-provider-rules.json # Captured request/header rules per web provider
│   ├── browser-profiles/  # Playwright login profiles (NOT committed)
│   ├── .env               # API keys + cookies (gitignored)
│   └── env.example        # .env template
├── samples/               # Sample/reference data
│   ├── sample-config.csv
│   ├── sample-models.csv
│   └── sample-models.xlsx
├── docs/                  # Documentation
│   ├── README.md          # This file
│   ├── APP.md             # Architecture/feature doc
│   ├── AI_REFERENCE.md    # AI onboarding deep-dive
│   ├── CONFIG_REFERENCE.md# Config formats reference
│   └── AGENTS.md          # Agent rules / handoff
├── archive/               # Stale files (model-config.js, etc.)
└── .opencode/             # Session/handoff state
```

### Dependencies
```json
{
  "axios": "^1.6.7",
  "csv-parser": "^3.2.1",
  "dotenv": "^16.4.1",
  "electron": "^43.2.0",
  "express": "^4.18.2",
  "playwright": "^1.62.1",
  "xlsx": "^0.18.5"
}
```
> Note: `playwright` browsers are not auto-installed by `npm install`. If the cookie-setup
> browser fails to launch, run `npx playwright install chromium` (or use a system Chrome/Edge,
> which `setup-web-provider.js` and `browser-http-client.js` prefer).

### NPM Scripts
```bash
npm start    # electron .
npm run dev  # node start.js
```

### Adding a New Provider
1. Add row to `ProviderConfig.csv`: `provider,baseURL,apiKeyEnv,modelsEndpoint,authType`
   (omit `authType` or use `Bearer` for API-key providers; `Cookie` for web providers)
2. For Bearer: add env var to `.env` (e.g., `NEW_PROVIDER_API_KEY=...`) and `env.example`
3. For Cookie providers: use **"+ Add Web Provider (Cookie)"** to capture the cookie and
   request shape automatically (it writes ProviderConfig.csv + .env + web-provider-rules.json)
   - For Kimi-style token providers: the capture detects a JWT `refresh_token` (regex `^eyJ...`)
     and stores it as `authToken` in `web-provider-rules.json`; no cookie env var is required
4. Add row(s) to `models.csv`: `provider,model`
5. Restart app → provider appears in dropdowns, autofill works

### Removing a Provider
1. Delete its row from `ProviderConfig.csv` (the single source of truth for available providers)
2. Restart app → all config entries for that provider are automatically pruned from `UltimateConfig.csv` + `proxy-config.json`; the provider disappears from all dropdowns
3. Optionally clean up: remove its `provider,model` rows from `models.csv`, its key from `.env`, and re-run **Fetch All Models** to regenerate `LatestModels.csv`

### Debugging
- **Developer Logs** panel (Proxy Control tab) shows all main-process logs
- `console.log` in `renderer.js` → browser dev tools (F12)
- `known-ok.json` shows current routing priority
- `token-usage.json` shows token spending

---

## Known Gaps & Roadmap

### High Priority
- [ ] **Config file watcher** — auto-reload when external edits to `UltimateConfig.csv` are detected
- [ ] **Per-entry baseURL/apiKeyEnv inline editing** — currently only provider/model/enabled are editable in the table; baseURL/apiKeyEnv come from ProviderConfig.csv
- [ ] **Per-entry health status** — health check results not yet displayed per-row in the config table

### Medium Priority
- [x] Streaming support (`/v1/chat/completions` with `stream: true`) — SSE replay of the buffered winner (2026-08-04)
- [x] Web providers via cookie auth (Qwen chat) — Playwright capture + Cookie header routing + payload/response translation (2026-08-05)
- [x] **Kimi token-exchange flow (no browser)** — `kimi-web-client.js`: refresh_token → access_token (300s cache) → userId → convId → SSE completion → cleanup; plain axios + browser headers, zero Playwright (2026-08-05)
- [ ] Provider-specific request/response normalization (Anthropic, Google, etc.)
- [ ] Config validation on import (warn on unknown providers, missing models)
- [ ] Export config to CSV/Excel button
- [ ] Per-provider timeout configuration

### Low Priority
- [ ] Dark mode toggle
- [ ] Request/response logging panel
- [ ] Multi-port proxy support
- [ ] Docker deployment config

---

## Bug Fixes Applied (Historical)

| Issue | Fix |
|-------|-----|
| Proxy restart race on Apply Configuration | `stopProxy()` returns Promise; `startProxy` awaits it before binding port |
| Alert spam on Apply Configuration | Removed "restarted proxy" popup; logs silently to console |
| CSV ↔ JSON sync confusion | `UltimateConfig.csv` = editable truth; `proxy-config.json` = auto-generated cache |
| Provider dropdown mismatches | Renamed `models-config.js` providers to match `ProviderConfig.csv` (Codestral, Hugging Face, Zen, Command) |
| CSV import baseURL/apiKeyEnv not autofilling | Import handler now overrides baseURL/apiKeyEnv from ProviderConfig.csv after load |
| Dropdown showed providers not in ProviderConfig.csv | `providerInfo` built from ProviderConfig.csv first; models-config.js only adds models to matching providers |
| UltimateConfig.csv had stale providers (Anthropic, OpenAI, OpenRouter) | `loadConnectedConfig()` filters entries to only ProviderConfig.csv providers |
| Deleting a provider row in ProviderConfig.csv left stale entries in UltimateConfig.csv + proxy-config.json | `pruneConfigEntries()` on startup drops + persists removal of entries for providers no longer listed in ProviderConfig.csv |
| Startup race: renderer could read config before main finished loading → table blank/flash | main now `await`s `autoConnectConfigFile()` before `createWindow()` and pushes a `config-ready` event; renderer listens for it |
| Dead/leaked-code hygiene | Archived `model-config.js`/`QueryModelsList.csv`/`structure.txt`; removed dead preload APIs (`getLoadedModels`, `parseCsvFile`, `parseExcelFile`, `openModelFileDialog`); scrubbed real-looking `COMMAND_API_KEY` from `env.example`, fixed `OPENCODE_ZEN_API_KEY`→`ZEN_API_KEY`, commented stale `GOOGLE_AI_STUDIO_API_KEY` in `.env` |
| **Dropdown unclickable after config changes** (renderer.js) | Select `change` handler rebuilt entire table synchronously while native `<select>` popup was closing → stuck invisible popup ate clicks; now `refreshConfigRow(idx)` only updates one row, deferred one tick (`setTimeout(..., 0)`) |
| **Add-Web-Provider modal dropdown dead after a setup attempt** (renderer.js + index.html) | Proceed handler replaced `modalBox.innerHTML` with status, restoring it on failure; cached element refs pointed at detached DOM nodes → lost listeners; fixed by never swapping form DOM (status goes in separate `#webProviderModalStatus` div; modal open handler resets form every time) |
| **Kimi capture auto-chat failed on disabled Send button** (setup-web-provider.js) | `fill()` doesn't enable Vue contenteditable Send button; old code pressed Enter then `click()` burned the 30s actionability timeout on `<button disabled>`; now types via real keystrokes (`page.keyboard.type`), polls Send for enabled (≤5s), clicks when enabled, Enter as fallback; caller prints manual guidance if auto-chat fails |
| **Clear Web Provider Session closed every browser session** (main.js + browser-http-client.js) | `browserClient.close()` now takes a `profileKey` filter (`${origin}::${profileKey}`); main.js computes `envPrefixFor(name).toLowerCase()` and only closes that provider's session; `mainWindow.focus()` called immediately after close to reclaim OS focus |
| **Provider missing from dropdown/config after paste/capture** (main.js + renderer.js) | Paste path never added config entry + queued config-ready; capture path didn't queue config-ready; `providerInfo` was startup-frozen. Fixed: `addOrUpdateWebProviderEntry()` + `queueConfigReady()` in both paths; `refreshProviderInfo()` merges ProvidersConfig.csv; `onConfigReady` async refreshes + re-renders table + priority dropdown |
| **8 sync table rebuilds deferred** (renderer.js) | Wrapped remaining `renderConfigTable()`/`renderPriorityOverrideDropdown()` calls in `setTimeout(..., 0)` at delete/add/load/clear/fetch/load buttons; initial startup + `onConfigReady` stay synchronous |
| **Kimi health-check 404 / no usable content** (proxy-server.js + main.js) | New `src/kimi-web-client.js` implements Kimi's token-exchange protocol (refresh_token → access_token 300s → userId → convId → SSE completion → cleanup) on `kimi.moonshot.cn` with plain axios + browser headers; proxy-server.js and main.js health check route through this client when `rule.authToken` exists; apiKey gate relaxed for token-auth providers |
| **CLEAR_WEB_PROVIDER_SESSION blocked UI on Playwright flush** (main.js) | Handler now reclaims `mainWindow.focus()` immediately, fires `browserClient.close(profileKey)` detached (background), returns `{success:true}` to renderer instantly; belt-and-suspenders `.then()` re-focuses after flush; `.catch()` → `console.warn` so background errors aren't silently swallowed |

---

## License

MIT — see `package.json` for details.

---

*Generated from project scan on 2026-08-04; Kimi token-exchange flow, CLEAR_WEB_PROVIDER_SESSION fix, and dropdown/config bug fixes added 2026-08-05. All file paths, line counts, and schemas verified against actual codebase.*
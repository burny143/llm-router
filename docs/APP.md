# LLM Proxy Router — Architecture & Feature Reference

## What This App Is

A local Electron GUI that runs a **fallback LLM proxy server** on your machine. You configure a list of provider endpoints (API base URLs, API keys via env vars, model names), and the proxy automatically:

- Routes requests to the **fastest healthy endpoint first**
- **Falls back** through the rest in parallel when one fails
- **Learns at runtime** — successful models are promoted, failed known-OK models are demoted
- Persists routing priority (`known-ok.json`) and **token usage** (`token-usage.json`) across restarts
- Loads API keys from `.env` automatically (like a secret store)
- **Auto-connects a model-list file** (CSV/Excel) on startup — providers + models populate the config dropdowns without manual reload
- **Auto-connects a config file** (CSV/Excel/JSON) on startup — this is the **source of truth** for proxy entries; Apply Configuration writes back to it in realtime

The proxy speaks **OpenAI-compatible `/v1/chat/completions`**, so any OpenAI SDK / `curl` / Open WebUI / Continue / etc. can point at `http://localhost:PORT/v1/chat/completions` and get automatic failover.

---

## Current Features

| Area | Capability |
|------|------------|
| **Proxy Core** | Express server at `http://localhost:PORT/v1/chat/completions` |
| **Routing** | Known-OK models (fastest first, sequential) → untested (parallel, first success wins) |
| **Health Check** | Validates *response content* (rejects HTTP 200 with error bodies like Zen's `{"code":401,...}`); stores OK endpoints |
| **Runtime Learning** | `learnSuccess` promotes on first success; `learnFailure` demotes known-OK on failure |
| **Persistence** | `known-ok.json` (routing priority), `token-usage.json` (per `provider::model` counters), `settings.json` (connected model-list file), `proxy-config.json` (proxy entries) |
| **Configuration Tab** | Editable table: Provider / API Key Env / Model / Enabled / Delete; dropdowns fed from default config + connected model-list file |
| **Auto-Connect Model List** | Load CSV/Excel once → remembered in `settings.json` → auto-reloaded on every startup (like `.env`) |
| **Auto-Connect Config File** | `proxy-config.json` (or CSV/Excel) is the **source of truth**; loaded on startup; Apply Configuration writes back to it |
| **Quick Chat** | Test the proxy in-app; Enter to send; timestamps + meta line (provider, model, latency); extracts content robustly |
| **Developer Logs** | Main-process `console.log/warn/error` forwarded to a panel under Quick Chat (capped 500 lines, color-coded) |
| **Health Check Tab** | Ping all configured entries; shows OK/FAIL + latency; Apply Configuration does **not** run health check |
| **Token Usage Tab** | Aggregated table per `provider::model` with prompt/completion/total + summary row; Refresh button |
| **Web Providers (Cookie)** | "+ Add Web Provider (Cookie)" — Playwright capture of cookie-authed chat providers (Qwen); Cookie header routing + request/response translation; WAF-bypass via `browser-http-client.js`; Bearer providers unaffected |
| **Server Status** | Green "Server running at http://localhost:PORT/" / red "Server stopped" |

---

## Performance Characteristics

| Metric | Observed / Design |
|--------|-------------------|
| **Parallel probe** | Returns first success immediately (measured ~130 ms) even with a 5 s straggler in the pool |
| **Sequential known-OK** | Probes in latency order; stops at first success |
| **Health check content validation** | Rejects garbage 200 responses (e.g., expired tokens) so they don't pollute known-OK |
| **Startup** | Reads `.env` + `known-ok.json` + `token-usage.json` + `settings.json` + model-list file + config file (if any) — all sync, < 100 ms |
| **Memory** | Small — Electron + Express + a few KB of JSON state |

---

## File Map

| File | Purpose |
|------|---------|
| `src/main.js` | Electron main process: window, IPC, health check, log forwarding, startup auto-load (health results, model list, config file, settings) |
| `src/preload.js` | `contextBridge` → `window.api` (typed IPC surface for renderer) |
| `src/renderer.js` | All UI logic: config table, quick chat, dev logs, health tab, token usage tab, dropdowns fed from default + connected files |
| `src/proxy-server.js` | Express proxy + routing engine (`probeSequential`, `probeParallel`, `learnSuccess`, `learnFailure`, `extractContent`, `recordUsage`, `injectUserText`) — Bearer via axios, Cookie via browser-http-client |
| `src/setup-web-provider.js` | Playwright capture script: headed browser → capture chat POST → write `.env` cookie + ProviderConfig.csv row + web-provider-rules.json |
| `src/browser-http-client.js` | Playwright in-page-fetch client for `authType=Cookie` requests (WAF/TLS bypass); minimized persistent contexts under `data/browser-profiles/` |
| `src/models-config.js` | Hardcoded default provider catalog (17 providers, base URLs, env var names, model lists) |
| `src/state-store.js` | JSON/CSV persistence + `getFilePath(role)` registry resolution: `saveResults/loadResults` (known-ok), `saveUsage/loadUsage` (tokens), `saveSettings/loadSettings` (model-list path), `saveConfig/loadConfig` (proxy entries), `loadProviderConfig` (provider lookup), `syncConfigFromCsv`/`saveConfigBoth` (CSV↔JSON sync) |
| `src/index.html` | Four tabs: Proxy Control (chat + dev logs), Admin/Configuration, Health Check, Token Usage |
| `src/style.css` | Light theming, tables, log colors, status labels |
| `src/fetch-models.js` | Script: reads ProviderConfig.csv, queries modelsEndpoint URLs, writes LatestModels.csv |
| `file-registry.json` | **File-path notepad** — maps every data-file role (`providerConfig`, `ultimateConfig`, `models`, `latestModels`, …) to its actual path (defaults: `data/`); resolved via `state-store.getFilePath(role)` |
| `data/.env` | API keys (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY, etc.) — **not committed** |
| `samples/sample-models.csv` / `.xlsx` | Example `provider,model` lists (20 rows, 11 providers) for the auto-connect feature |
| `samples/sample-config.csv` | Example proxy config: `provider,baseURL,apiKeyEnv,model,enabled` (14 entries) — reference format |
| `data/UltimateConfig.csv` | **Primary config truth** — `provider,baseURL,apiKeyEnv,model,enabled,authType` (human-editable) |
| `data/proxy-config.json` | Auto-generated from `UltimateConfig.csv` for fast reload — not hand-edited |
| `data/models.csv` | All available models (`provider,model` — rows across providers) for dropdown filtering |
| `data/ProviderConfig.csv` | Provider metadata (`provider,baseURL,apiKeyEnv,modelsEndpoint,authType`) — drives autofill + fetch-models.js |
| `data/LatestModels.csv` | Generated by `fetch-models.js`: live model counts from each provider's API |
| `data/known-ok.json` | Persisted routing priority: `{ "provider::model": { okCount, avgLatency, lastOk } }` |
| `data/token-usage.json` | Persisted counters: `{ "provider::model": { prompt, completion, total } }` |
| `data/settings.json` | `{ "modelsFile": "/abs/path/to/connected.csv" }` — model-list auto-connect target |
| `data/web-provider-rules.json` | Captured request shape + browser headers per web provider (cookie lives in `.env`, NOT here) |
| `data/browser-profiles/` | Persistent Playwright login profiles per provider — never committed (contains session cookies) |

---

## Data Flow (Simplified)

```
User request (OpenAI SDK → localhost:PORT/v1/chat/completions)
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

---

## Configuration Model (Two-Layer)

### Layer 1: UltimateConfig.csv — Editable Truth for Proxy Entries
- **File**: `UltimateConfig.csv` (primary, human-editable) + `proxy-config.json` (auto-synced for fast reload)
- **Schema**: `provider,model,enabled` (baseURL + apiKeyEnv are looked up from ProviderConfig.csv, not duplicated here)
- **Column mapping** (CSV → table):
  - Column A (`provider`) → **Provider** dropdown in table column 2
  - Column B (`baseURL`) → **Base URL** readonly input (autofills from ProviderConfig.csv when provider selected)
  - Column C (`apiKeyEnv`) → **API Key Env Var** dropdown (autofills from ProviderConfig.csv when provider selected)
  - Column D (`model`) → **Model** dropdown (filtered to selected provider's models from models.csv)
  - Column E (`enabled`) → **Enabled** checkbox
- **Behavior**: 
  - On startup: reads `UltimateConfig.csv` + `ProviderConfig.csv` → generates `proxy-config.json` → populates config table
  - On Apply Configuration: writes current table → `UltimateConfig.csv` + `proxy-config.json`
  - On Import Config from CSV/Excel: loads external file → writes to `UltimateConfig.csv` + `proxy-config.json`
  - Provider is tied to its `baseURL` + `apiKeyEnv` via `ProviderConfig.csv`; only `model` and `enabled` change per-row
  - If `UltimateConfig.csv` missing → falls back to default catalog (`models-config.js`)
- **Autofill**: selecting a provider auto-populates `baseURL` + `apiKeyEnv` from `ProviderConfig.csv`; model dropdown filters to that provider's available models

### Layer 1b: ProviderConfig.csv — Provider Metadata Lookup
- **File**: `ProviderConfig.csv` (one row per provider)
- **Schema**: `provider,baseURL,apiKeyEnv,modelsEndpoint,authType` (`authType` default `Bearer`)
- **Purpose**: Single source of truth for provider endpoint URLs, credential env-var names, and auth mode
- **Behavior**:
  - Loaded on startup → builds provider→{baseURL,apiKeyEnv,authType} lookup map
  - When a provider is selected in the config table, this file provides the autofill values
  - Provider names here must match provider names in `UltimateConfig.csv` and `models.csv`
  - **Adding/removing a provider row cascades on next startup**: config entries for providers no longer listed here are pruned from `UltimateConfig.csv` + `proxy-config.json` automatically (they are never rendered in the table either)
  - **Web providers**: row with `authType=Cookie` + `<PREFIX>_COOKIE` in `.env` routes through the cookie path (see `proxy-server.js` `probeOne()` / `browser-http-client.js`)
- **Sample**: `sample-config.csv` shows the expected format

### Layer 2: models.csv — Dropdown Options for Models
- **File**: `models.csv` (auto-connected on startup like `.env`; also `sample-models.csv` as alternate sample)
- **Schema**: `provider, model`
- **Behavior**:
  - Auto-connected on startup (like `.env`)
  - Feeds **Provider** and **Model** dropdowns in the config table
  - Load Model File button → selects new file, persists to `settings.json`, reconnects

### Default Catalog (Fallback)
- `models-config.js` — 17 providers with base URLs, env var names, model lists
- Used when `UltimateConfig.csv` missing; also provides model dropdown options when `models.csv` missing

---

## Known Gaps / Next Work

- **Config file watcher** — auto-reload when external edits to `UltimateConfig.csv` are detected (currently only reloaded on app start)
- **Per-entry baseURL/apiKeyEnv inline editing** — currently only provider/model/enabled are editable in the table; baseURL/apiKeyEnv come from the config file entry (fully editable when imported via CSV)
- **Per-entry health status** — health check results not yet displayed per-row in the config table
- **`src/tls-http-client.js` is dead code** — requires the uninstalled `tls-client` package (won't compile on this Windows box: Windows SDK 10.0.26100.0 missing). Runtime Cookie auth uses `browser-http-client.js` instead. Moved to `archive/` (2026-08-05); `src/setup-qwen-cookie.js` (legacy Qwen-only capture) was archived too — the generic `setup-web-provider.js` handles all cookie providers.
- **`web-provider-rules.json` can be `{}`** after "Clear Qwen Session" — re-run "+ Add Web Provider" to regenerate; cookie lives in `.env`, not the rules file.
- **Capture success popup** no longer auto-reloads; dismiss it manually, then restart the proxy.

## Bug Fixes Applied

- **ProviderConfig.csv cascade** — deleting a provider row now prunes its orphaned config entries from `UltimateConfig.csv` + `proxy-config.json` on startup (previously they persisted forever as stale rows)
- **Proxy restart race** — `stopProxy()` now returns a Promise; `startProxy` awaits it before binding the port (fixes Quick Chat unresponsiveness after Apply Configuration)
- **Removed alert spam** — Apply Configuration no longer shows "restarted proxy" popup; logs silently to console
- **CSV ↔ JSON sync** — `UltimateConfig.csv` is the editable truth; `proxy-config.json` is auto-generated from it on startup and Apply Configuration
- **Runtime chat hang on Qwen (2026-08-05)** — chat requests stalled ("All configured models failed" after 20s) while the health-check ping succeeded (~4s). Root cause: the ping (in main.js, does NOT force stream:false) sent stream:true (SSE from the captured payload); for the tiny "ping" message Qwen returned a complete SSE response with [DONE] (206 bytes, fast). But real chat messages trigger Qwen server-side thinking that streams SSE chunks over 20s+, and res.text() blocks until the stream fully closes, so it hung past the 20s timeout. **Fix:** (a) probeOne() forces stream:false / incremental_output:false on the cloned sample-payload so Qwen returns a single complete JSON object (the proxy front-end is non-SSE; SSE via res.text() on long-thinking responses hangs), and (b) increased the in-page fetch + outer Promise.race timeout to 60s (Qwen thinking can take 15-40s for real questions), with a matching 60s AbortController on the renderer Quick Chat fetch.
  - **Follow-up (2026-08-05, later)** — per user request, streaming is restored: probeOne() no longer forces stream:false / incremental_output:false; the captured payload's own `stream:true` is kept, so the full SSE body is read via res.text() (until [DONE]) and normalized into one OpenAI-style JSON object. The 60s timeouts remain. Cookie-auth providers are now preset-driven (Qwen, Kimi) via the "Add Web Provider" dropdown; Kimi (www.kimi.com, `kimi-auth` cookie) uses the same capture flow. The SSE extractor accepts both `data:` frames and raw JSON-lines (Kimi's stream format), and a top-level `query` mirror (Kimi) is synced with the injected user text in probeOne() and the health check.
- **Capture success popup auto-reload (2026-08-05)** — the "+ Add Web Provider" success screen no longer auto-closes after 1.5s; it now stays open until the user clicks "Close" (restart the proxy when ready).
- **Web provider capture (2026-08-05)** — one-click Playwright capture: cookie → `.env`, provider row → ProviderConfig.csv (`authType=Cookie`), request rules → web-provider-rules.json; verified with an in-page fetch before saving
- **Same-device cookie routing (2026-08-05)** — runtime `browser-http-client.js` now opens the same persistent Chrome profile the capture used (`data/browser-profiles/qwen`), so the WAF sees the request from the same device/cookie-jar that logged in; retries once on "existing browser session".
- **Zen false-OK fix (2026-08-05)** — `extractContent()` rejects auth-error bodies (`looksLikeAuthError`: "token expired", "invalid api key", …) before the longest-string fallback, so 401/error responses are treated as failed and pruned from known-OK.
- **Fetch All Models re-enabled (2026-08-05)** — `modelsEndpoint` URLs restored for all Bearer providers in ProviderConfig.csv (the column had been blanked; `fetch-models.js` filters on it).

## File Summary

| File | Role |
|------|------|
| `UltimateConfig.csv` | **Primary config truth** — edit this manually (provider, baseURL, apiKeyEnv, model, enabled) |
| `proxy-config.json` | Auto-generated from CSV for fast reload — do not edit manually |
| `models.csv` | **All available models** for provider/model dropdowns (auto-connected on startup) |
| `sample-models.csv` | Alternate sample model list (same format) |
| `sample-config.csv` | Reference for the config CSV format
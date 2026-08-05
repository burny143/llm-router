# LLM Proxy Router — AI Developer Reference

> Written for AI agents / new developers who need to modify this codebase safely.
> Everything here was verified against the actual files on **2026-08-04** (12 providers, 1038 config entries).

---

## 1. What This App Is (30-second version)

A local **Electron** desktop app that runs a **fallback LLM proxy server** (Express) on
`http://localhost:PORT/v1/chat/completions`. You configure a list of provider endpoints;
each incoming request is tried against **known-good** models first (sequential, fastest
first), then **all untested** models in parallel (first success wins). The app learns at
runtime (`known-ok.json`), tracks tokens (`token-usage.json`), and auto-loads CSV/Excel
config + model lists on startup.

Key architectural rule: **`ProviderConfig.csv` is the single source of truth for which
providers exist.** Everything else (dropdowns, config table, proxy routing) derives from it.

---

## 2. Runtime Topology

```
┌────────────────────────── Electron (3 processes) ─────────────────────────┐
│                                                                            │
│  MAIN PROCESS  ── main.js (entry, package.json "main")                     │
│  ├─ Electron window + IPC handlers                                         │
│  ├─ proxy-server.js  (Express proxy + routing engine, runs IN main)        │
│  ├─ state-store.js   (all file I/O: JSON + CSV)                            │
│  ├─ models-config.js (fallback catalog, 17 providers)                      │
│  └─ loads .env via dotenv → process.env                                    │
│                                                                            │
│  PRELOAD  ── preload.js                                                    │
│  └─ contextBridge.exposeInMainWorld('api', {...}) → window.api             │
│                                                                            │
│  RENDERER  ── index.html + renderer.js (all UI logic, NO node access)      │
│  └─ talks to main ONLY through window.api (ipcRenderer.invoke)             │
└────────────────────────────────────────────────────────────────────────────┘
                     │ HTTP POST /v1/chat/completions
                     ▼
        Any OpenAI-compatible client (curl, SDK, Open WebUI...)
```

**Process model gotcha:** the Express proxy runs inside the **main** process, not a
separate one. `startProxy()`/`stopProxy()` are called from renderer via IPC.

---

## 3. File Map & Dependencies (verified)

> Layout (reorganized 2026-08-04): all app code in `src/` (entry `package.json` → `src/main.js`,
> HTML/CSS/JS together so `index.html`→`style.css`/`renderer.js` relative refs stay valid);
> all data files in `data/` (resolved via `file-registry.json` → `getFilePath(role)`);
> samples in `samples/`; docs in `docs/`.

### Source code (require graph)

| File | Requires | Exports / Role |
|------|----------|----------------|
| `src/main.js` | `electron`, `axios`, `dotenv`, `https`, `proxy-server.js`, `state-store.js`, `models-config.js`, `child_process` (exec+spawn), `path`, `fs` | Electron main: window, IPC, health check, log forwarding, startup auto-load, web-provider setup spawn |
| `src/preload.js` | `electron` (contextBridge, ipcRenderer) | Exposes `window.api` (the ONLY bridge to renderer) |
| `src/renderer.js` | none (uses `window.api` from preload) | All UI: config table, quick chat, dev logs, health tab, token usage, web-provider modal |
| `src/proxy-server.js` | `express`, `axios`, `dotenv`, `state-store.js`, `browser-http-client.js` (lazy) | `startProxy, stopProxy, isProxyRunning, setHealthResults, getKnownOk, getTokenUsage, extractContent, injectUserText` |
| `src/state-store.js` | `fs`, `path` | `saveResults/loadResults, saveUsage/loadUsage, saveSettings/loadSettings, saveConfig/loadConfig, saveConfigBoth, syncConfigFromCsv, pruneConfigEntries, loadProviderConfig, getFilePath` + file-path resolution via registry |
| `src/setup-web-provider.js` | `playwright`, `fs`, `path`, `dotenv`, `state-store.js` | Capture script (spawned by main `run-web-provider-setup`): headed browser, capture chat POST, write `.env` + ProviderConfig.csv + web-provider-rules.json; CLI: `node src\setup-web-provider.js <Name> <URL>` |
| `src/browser-http-client.js` | `playwright`, `state-store.js` | Playwright in-page-fetch HTTP client for `authType=Cookie` requests (WAF/TLS-fingerprint bypass); lazy per-origin minimized persistent contexts under `data/browser-profiles/` |
| `src/tls-http-client.js` | `tls-client` (NOT installed) | **ARCHIVED (2026-08-05)** — dead code; never required by main/proxy; moved to `archive/` |
| `src/models-config.js` | (standalone) | **Fallback default catalog** — 17 provider groups `{provider, baseURL, apiKeyEnv, models[]}`. Uses `api.kilocode.ai` for Kilo. Model IDs updated 2026-08-05 to current catalogs (Claude Opus 4.8 / Sonnet 4.6 / Haiku 4.5, GPT-5.x, Gemini 2.5/3.1). |
| `model-config.js` | (standalone) | **MOVED TO `archive/`** — legacy/alternate catalog, different URLs (e.g. Anthropic via `cc.freemodel.dev`). **Not loaded anywhere**; kept only for reference. |
| `src/fetch-models.js` | `fs`, `axios`, `dotenv` | CLI script (run via IPC `run-fetch-models` or `node src\fetch-models.js`): reads `ProviderConfig.csv`, hits each `modelsEndpoint`, writes `LatestModels.csv` + `models.csv` |
| `src/index.html` | `style.css`, `renderer.js` | 4 tabs: Proxy Control / Admin-Configuration / Health Check / Token Usage |
| `src/style.css` | — | Light theme |

### Data files (who reads / who writes)

**All data-file paths resolve through `state-store.getFilePath(role)`** (registry first,
default filename fallback) into `data/`. `file-registry.json` (project root) is the map —
edit it to point a role at a different file. Roles: `providerConfig`, `ultimateConfig`,
`proxyConfig`, `models`, `latestModels`, `knownOk`, `tokenUsage`, `settings`, `env`,
`webProviderRules`.

| File | Schema | Read by | Written by | Source of truth? |
|------|--------|---------|------------|------------------|
| `.env` | `KEY=VALUE` | main.js (`dotenv`), proxy-server.js (`dotenv`), fetch-models.js, setup-web-provider.js | user (NOT committed); setup-web-provider.js appends `<PREFIX>_COOKIE` | API keys + web-provider cookies |
| `ProviderConfig.csv` | `provider,baseURL,apiKeyEnv,modelsEndpoint,authType` (`authType`: `Bearer` default / `Cookie`) | `state-store.loadProviderConfig()` → main.js `get-provider-config` → renderer `providerInfo`; also fetch-models.js | user (hand-edit); setup-web-provider.js upserts `authType=Cookie` rows | **YES — provider list** |
| `UltimateConfig.csv` | `provider,baseURL,apiKeyEnv,model,enabled,authType` | `state-store.syncConfigFromCsv()` | `state-store.saveConfigBoth()` (Apply Config / prune / web-provider placeholder) | **YES — proxy entries** |
| `proxy-config.json` | JSON array of config entries | `state-store.loadConfig()` (fallback when CSV missing) | `state-store.saveConfig()` / `saveConfigBoth()` | NO — auto-generated cache |
| `models.csv` | `provider,model` | main.js `autoConnectModelFile()` → dropdown sources | user or `fetch-models.js` (top 5/provider) | dropdown options |
| `LatestModels.csv` | `provider,model` (may contain `ERROR:...` rows) | main.js `loadLatestModels()` (skips `ERROR:` rows) | `fetch-models.js` | model dropdown (primary) |
| `known-ok.json` | `[{provider, model, status, latency}]` | main.js `loadHealthResults()` → `setHealthResults()` | `state-store.saveResults()` (health check + runtime learning) | routing priority cache |
| `token-usage.json` | `{"provider::model": {provider, model, requests, promptTokens, completionTokens, totalTokens}}` | proxy-server.js `loadUsage()` at boot | proxy-server.js `recordUsage()` → `saveUsage()` | token counters |
| `settings.json` | `{"modelsFile": "/abs/path.csv"}` | main.js `autoConnectModelFile()` | `state-store.saveSettings()` | model-list auto-connect target |
| `web-provider-rules.json` | `{provider: {samplePayload, headers, userAgent, origin, referer}}` | main.js + proxy-server.js at boot (cookie-auth request shaping) | setup-web-provider.js; `clear-web-provider-session` deletes `rules[provider]` | cookie-auth request rules (no cookies inside — those live in `.env`) |

---

## 4. IPC Surface (preload ↔ main)

Channels handled by `ipcMain.handle` in main.js, exposed via `window.api` in preload.js.
Renderer **cannot** touch Node/fs — everything goes through these.

| IPC channel | window.api method | Args | Returns |
|-------------|-------------------|------|---------|
| `start-proxy` | `startProxy(port, entries)` | port, entries[] | `{success}` / `{success:false, error}` |
| `stop-proxy` | `stopProxy()` | — | `{success:true}` |
| `is-proxy-running` | `isProxyRunning()` | — | boolean |
| `get-default-config` | `getDefaultConfig()` | — | models-config.js array |
| `get-env-vars` | `getEnvVars()` | — | key names parsed from `.env` |
| `get-connected-model-list` | `getConnectedModelList()` | — | `{models, providers, providerModels, latestProviderModels, file}` |
| `get-connected-config` | `getConnectedConfig()` | — | `{entries, file}` (entries = configEntries in main) |
| `get-provider-config` | `getProviderConfig()` | — | `{provider: {baseURL, apiKeyEnv, authType}}` from ProviderConfig.csv |
| `save-config` | `saveConfig(entries)` | entries[] | `{success}` / `{success:false, error}` — writes CSV+JSON |
| `open-config-file-dialog` | `openConfigFileDialog()` | — | `{canceled}` / `{canceled:false, filePath}` |
| `parse-config-csv-file` | `parseConfigCsvFile(filePath)` | abs path | `{success, entries, rowCount}` |
| `parse-config-excel-file` | `parseConfigExcelFile(filePath)` | abs path | `{success, entries, rowCount}` |
| `run-fetch-models` | `runFetchModels()` | — | `{success, output, entries}` — spawns `node src\fetch-models.js` |
| `get-token-usage` | `getTokenUsage()` | — | usage array sorted by totalTokens desc |
| `health-check` | `healthCheck(entries)` | entries[] | results[] (ping every enabled model in parallel) |
| `dev-log` (event) | `onDevLog(callback)` | — | `{level, text, time}` pushed from main's console interception |
| `config-ready` (event) | `onConfigReady(callback)` | — | `{entries}` pushed from main after startup config load (handles the async startup race between main's config load and renderer's `loadDefaultConfig()`) |
| `run-web-provider-setup` | `runWebProviderSetup(name, url)` | provider name, login URL | `{success, output}` / `{success:false, error}` — spawns `node src\setup-web-provider.js <name> <url>`; on success reloads `.env` (override) + adds `<name>-chat` placeholder entry |
| `clear-web-provider-session` | `clearWebProviderSession(providerName)` | provider name | `{success}` / `{success:false, error}` — strips `<PREFIX>_COOKIE=` from `.env`, deletes `rules[provider]`, closes browser client |
| `get-web-provider-presets` | `getWebProviderPresets()` | — | `{Qwen:{loginUrl,baseURL}, Kimi:{loginUrl,baseURL}, ...}` — UI-facing preset fields for the Add Web Provider modal dropdown |
| `set-provider-cookie` | `setProviderCookie(name, cookie)` | provider name, cookie string | `{success}` / `{success:false, error}` — stores `<PREFIX>_COOKIE` in `.env`, upserts ProviderConfig.csv row, seeds web-provider-rules.json from presets (no browser, no ping) |

**Removed dead APIs (2026-08-04):** `get-loaded-models` / `getLoadedModels()`,
`parse-csv-file`, `parse-excel-file`, `open-model-file-dialog` were exposed in preload.js but
had no main-process handlers (or weren't used). They have been deleted from preload.js.


---

## 5. Key Functions & Call Chains

### Startup (main.js `app.whenReady`)
```
forwardLogsToRenderer()   // wraps console.log/warn/error → sendToRenderer('dev-log')
loadHealthResults()       // known-ok.json → proxy-server.setHealthResults() (live routing)
loadLatestModels()        // LatestModels.csv → latestProviderModels (skips "ERROR:" rows)
autoConnectModelFile()    // settings.json→modelsFile, fallback models.csv → extractModelsFromRows()
autoConnectConfigFile()   // ★ the cascade: syncConfigFromCsv() then pruneConfigEntries(entries, loadProviderConfig()); AWAITED before createWindow
sendToRenderer('config-ready', { entries })  // push loaded entries to renderer (race-condition guard)
createWindow()            // BrowserWindow → index.html → renderer.js
```

### ★ ProviderConfig.csv cascade (the important invariant)
```
autoConnectConfigFile()
  ├─ syncConfigFromCsv()          // read UltimateConfig.csv → entries; saveConfig(proxy-config.json)
  └─ pruneConfigEntries(entries, loadProviderConfig())
       ├─ providerMap = ProviderConfig.csv rows (key = provider name)
       ├─ pruned = entries where providerMap[entry.provider] exists
       └─ if dropped > 0 → saveConfigBoth(pruned)   // rewrites UltimateConfig.csv + proxy-config.json
```
- **Safeguard:** if `providerMap` is empty (ProviderConfig.csv missing/empty), prune is a
  no-op — the config is NOT wiped.
- Deleting a row in `ProviderConfig.csv` → on next startup the provider's entries are
  removed from BOTH `UltimateConfig.csv` and `proxy-config.json` (and never rendered).

### Renderer startup (renderer.js `loadDefaultConfig()`)
```
getProviderConfig()     → providerInfo = {provider: {baseURL, apiKeyEnv, models: []}}
getDefaultConfig()      → models-config.js; only ADDS models to providers already in providerInfo
loadEnvVars()           → envVars (dropdown for API key env var)
loadConnectedModelList()→ loadedModels, providerModelsFromFile, latestProviderModels
loadConnectedConfig()   → configEntries = entries.filter(e => providerInfo[e.provider])  // UI-side prune
renderConfigTable()     → table rows; provider dropdown = Object.keys(providerInfo)
```

### Proxy request path (proxy-server.js)
```
POST /v1/chat/completions
  ├─ orderEntries() → known-OK (fastest first) → untested → known-failed
  ├─ if knownOk.length > 0 → probeSequential(okCandidates)   // stops at first success
  ├─ else / all failed → probeParallel(ordered)              // first success wins
  ├─ probeOne(entry):
  │    authType = entry.authType || 'Bearer'
  │    if Bearer → axios.post(baseURL, {model:entry.model, messages, ...rest},
  │                          {Authorization: Bearer <env[apiKeyEnv]>})
  │    if Cookie  → payload = clone(rule.samplePayload) with user message injected
  │                 via injectUserText() (fallback: replace first long string field)
  │                 headers = Cookie: <env[apiKeyEnv]> + UA/Origin/Referer from rules
  │                 POST via browser-http-client.request() (in-page fetch, WAF bypass)
  │    → extractContent() validates real text (choices/answer/text/result/message/
  │      data.data.*/raw SSE/longest-string fallback)
  │     ├─ success → learnSuccess(entry, elapsed) → saveResults() → known-ok.json
  │     └─ fail/no-content → learnFailure(entry) → demote + saveResults()
  └─ respond with normalized OpenAI payload + _meta {provider, model, elapsed}
```

### Health check (main.js `health-check` handler)
Parallel probes of `{model, messages:[{role:'user',content:'ping'}], max_tokens:5}` to each
enabled entry. **Bearer** entries go through `axios.post`; **Cookie** entries go through
`browser-http-client` with the same headers/payload-shaping rules as `probeOne()` (sample
payload with `ping` injected). Validates content via `extractContent()`; results →
`setHealthResults()` (rebuilds known-ok live, no proxy restart) + forwarded to renderer.

---

## 6. Environment Variables

Loaded via `dotenv` in main.js, proxy-server.js, fetch-models.js. `apiKeyEnv` column in
ProviderConfig.csv must match a key name here (renderer's dropdown is built from `.env` keys).

| Var | Used by provider(s) | Present in .env? |
|-----|---------------------|------------------|
| `KILO_GATEWAY_API_KEY` | Kilo Gateway | ✅ |
| `GOOGLE_AI_STUDIO_API_KEY` | *(Google AI Studio — provider row DELETED from ProviderConfig.csv)* | ⚠️ commented-out (stale, harmless) |
| `NVIDIA_NIM_API_KEY` | NVIDIA NIM | ✅ |
| `MISTRAL_API_KEY` | Mistral | ✅ |
| `CODESTRAL_API_KEY` | Codestral | ✅ |
| `HUGGINGFACE_API_KEY` | Hugging Face | ✅ |
| `VERCEL_AI_GATEWAY_API_KEY` | Vercel AI Gateway | ✅ |
| `ZEN_API_KEY` | Zen | ✅ |
| `CEREBRAS_API_KEY` | Cerebras | ✅ |
| `GROQ_API_KEY` | Groq | ✅ |
| `COHERE_API_KEY` | Cohere | ✅ |
| `FIREWORKS_API_KEY` | Fireworks | ✅ |
| `COMMAND_API_KEY` | Command | ✅ |
| `QWEN_COOKIE` | Qwen (authType=Cookie) | ✅ (after "Add Web Provider" capture) — full `name=value; name2=value2` cookie string, NOT an API key |
| `ANTHROPIC_API_KEY` | *(Anthropic — NOT in ProviderConfig.csv)* | ❌ (only in env.example) |
| `OPENAI_API_KEY` | *(OpenAI — NOT in ProviderConfig.csv)* | ❌ |
| `OPENROUTER_API_KEY` | *(OpenRouter — NOT in ProviderConfig.csv)* | ❌ |
| `LMSTUDIO_LOCAL_API_KEY` | *(not in ProviderConfig.csv)* | ❌ |

**⚠ env.example note (fixed 2026-08-04):** the old `OPENCODE_ZEN_API_KEY=...` key was
renamed to `ZEN_API_KEY` (matching `.env` + ProviderConfig.csv), and the real-looking
`COMMAND_API_KEY` value was replaced with a placeholder. `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`
remain in env.example for providers NOT in ProviderConfig.csv — harmless placeholders.

---

## 7. CSV Formats (exact)

**ProviderConfig.csv** — one row per provider, THE provider registry:
```
provider,baseURL,apiKeyEnv,modelsEndpoint,authType
Kilo Gateway,https://api.kilo.ai/v1/chat/completions,KILO_GATEWAY_API_KEY,,Bearer
Qwen,https://chat.qwen.ai/api/v2/chat/completions?chat_id=...,QWEN_COOKIE,,Cookie
...
```
`authType` is optional; missing/empty ⇒ `Bearer` (unchanged legacy behavior).

**UltimateConfig.csv** — proxy entries (editable truth):
```
provider,baseURL,apiKeyEnv,model,enabled,authType
Kilo Gateway,https://api.kilo.ai/v1/chat/completions,KILO_GATEWAY_API_KEY,frontier,true,Bearer
...
```

**models.csv / LatestModels.csv** — `provider,model`. LatestModels may contain
`provider,ERROR: <message>` rows for failed fetches (skipped by loader).

**Quoting:** `state-store.parseCsv` and `fetch-models.js` handle basic `"` quoting for
commas in fields. `configToCsv()` writes unquoted — don't put commas in provider/model names
or rows break.

---

## 8. Conventions, Gotchas & Footguns

1. **Provider names must match exactly** (case-sensitive, string equality) across
   `ProviderConfig.csv`, `UltimateConfig.csv`, `models.csv`, `LatestModels.csv`, and the
   `provider` field in `known-ok.json`/`token-usage.json`. A mismatch = silently dropped
   entry or orphaned runtime data.
2. **Resolve every data-file path via `state-store.getFilePath(role)`** — never hardcode a
   filename or `path.join(__dirname, ...)`. To redirect the app to a different file, edit
   `file-registry.json` (relative = project root, or absolute). Missing role ⇒ default
   fallback, so an incomplete registry never breaks startup.
3. **Editing files while app runs:** there is NO file watcher. CSV/JSON edits only take
   effect on restart (or Apply Configuration / Load Model File). APP.md/README list a
   watcher as roadmap.
4. **Do NOT hand-edit `proxy-config.json`** — `syncConfigFromCsv()` regenerates it from
   `UltimateConfig.csv` at every startup.
5. **`providerInfo` vs default catalog:** renderer builds `providerInfo` from
   `ProviderConfig.csv` first; `models-config.js` only contributes model *lists* to
   providers already in `providerInfo`. `models-config.js` includes providers NOT in
   ProviderConfig.csv (Anthropic, OpenAI, Google AI Studio, OpenRouter) — they are
   invisible to the UI. Don't add a provider there expecting it to show up; add it to
   `ProviderConfig.csv`.
6. **`model-config.js` is dead code** — moved to `archive/` (2026-08-04). Not required by
   any entry point. Don't edit it thinking it affects the app.
7. **Prune safeguard:** deleting ALL rows (or corrupting) `ProviderConfig.csv` empties the
   provider map → prune no-op → config preserved. But renderer then has an empty provider
   dropdown, so the app is effectively unusable until ProviderConfig.csv is restored.
8. **`LatestModels.csv` stale rows:** rows for providers removed from `ProviderConfig.csv`
   persist until the next "Fetch All Models" run. `ERROR:` rows are skipped at load, so a
   stale `Google AI Studio,ERROR:...` row is harmless.
9. **Windows/PowerShell:** if running CLI commands, use `;` not `&&`; quote paths with
   spaces (this repo path contains spaces).
10. **Concurrency:** `startProxy` awaits `stopProxy()` before binding the port (fixed
    restart race). Health check and quick chat hit live `knownOk` state — no mutex.
11. **`.env` secrets:** real API keys live in `.env` (gitignored). Never log them; never
    commit `.env`. `env.example` holds placeholders only (the real-looking COMMAND key was
    scrubbed 2026-08-04).

---

## 9. Quick Debug Recipes

| Symptom | Look here |
|---------|-----------|
| App reads the wrong file | `file-registry.json` role → path mapping (relative to root or absolute) |
| Provider missing from dropdown | `ProviderConfig.csv` row exists? Name matches exactly? |
| Config row vanishes on startup | Provider removed from ProviderConfig.csv → prune (by design) |
| Request returns 502 "No models configured" | No enabled entries; check `enabled` column + Connect pressed |
| Models list stale | Run "Fetch All Models" → regenerates LatestModels.csv + models.csv |
| Token counts wrong | `token-usage.json` keys `provider::model`; usage object shape from provider |
| Routing always slow | `known-ok.json` — check latency values; health check rebuilds it |
| Renderer errors | F12 DevTools (renderer console) vs Developer Logs panel (main console) |
| Proxy errors | Developer Logs panel — main-process console.log/warn/error forwarded there |

---

## 10. Test / Verify Commands

```powershell
# Syntax check all JS (no execution side effects)
node --check main.js; node --check preload.js; node --check renderer.js
node --check proxy-server.js; node --check state-store.js; node --check fetch-models.js

# Verify the cascade logic without launching the GUI:
#   node -e "const s=require('./state-store'); const e=s.syncConfigFromCsv(); const p=s.pruneConfigEntries(e,s.loadProviderConfig()); console.log(e.length,'->',p.length)"

# Launch app (opens window; kill with Ctrl+C / Stop-Process)
npm start          # electron .
npm run dev        # node start.js  (npx electron .)

# Regenerate model lists
node src\fetch-models.js
```

There is **no automated test suite** — no test runner in package.json, no `test` script.
Changes are verified by launching the app and exercising the affected flow.

---

*Generated 2026-08-04 from live inspection of the codebase. Counts (12 providers, 1038
entries, 41 models.csv rows, 1021 LatestModels rows) reflect the repo state at that date.*

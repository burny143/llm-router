# AGENTS.md — LLM Proxy Router (llm-proxy-gui)

Read this before touching anything. For the full deep-dive (dependency graph, IPC surface,
function call chains, data-file matrix, env vars, debug recipes) read **`AI_REFERENCE.md`**.
`APP.md` is the architecture/feature doc; `README.md` is user-facing.

## What this is

A local **Electron** app (main.js entry) that runs a fallback LLM proxy (Express in the
**main** process, `proxy-server.js`) at `http://localhost:PORT/v1/chat/completions`.
OpenAI-compatible clients point at it; requests try known-good models sequentially (fastest
first), then all untested in parallel (first success wins). It learns at runtime
(`known-ok.json`), tracks tokens (`token-usage.json`), and auto-loads config/model-list
CSVs on startup. **There is no test suite** — verify with `node --check` + launching the app.

## Source-of-truth hierarchy (the invariant that matters most)

0. **`file-registry.json`** — the "notepad" that maps every data-file *role* to a path
   (`providerConfig`, `ultimateConfig`, `proxyConfig`, `models`, `latestModels`, `knownOk`,
   `tokenUsage`, `settings`, `env`). Paths are relative to project root or absolute.
   Resolve via `getFilePath(role)` from `state-store.js` — **never hardcode a data-file
   path anywhere else**. Missing role ⇒ falls back to the default filename, so the app
   never breaks on an incomplete registry.
1. **`ProviderConfig.csv`** — the single registry of available providers
   (`provider,baseURL,apiKeyEnv,modelsEndpoint`). Everything else derives from it.
2. **`UltimateConfig.csv`** — editable proxy entries (`provider,baseURL,apiKeyEnv,model,enabled`).
3. **`proxy-config.json`** — auto-generated cache of the CSV. **Never hand-edit**; it is
   regenerated from `UltimateConfig.csv` on every startup (`syncConfigFromCsv()`).

**Cascade rule:** deleting a provider row from `ProviderConfig.csv` must prune that
provider's entries from `UltimateConfig.csv` + `proxy-config.json` — done automatically at
startup by `pruneConfigEntries()` in `state-store.js`, called from `autoConnectConfigFile()`
in main.js. If you change this flow, keep the two safety properties:
- empty/missing provider map ⇒ prune is a **no-op** (never wipe config because a CSV is broken)
- the renderer ALSO filters (`loadConnectedConfig()` filters by `providerInfo[provider]`) —
  the main-process prune is what makes the persisted files clean, the renderer filter is
  what keeps the UI from crashing.

## Non-negotiables / footguns

- **Provider names must match byte-for-byte** across `ProviderConfig.csv`,
  `UltimateConfig.csv`, `models.csv`, `LatestModels.csv`, and the `provider` field of
  `known-ok.json` / `token-usage.json`. A mismatch = silently dropped entry or orphaned data.
- **No file watcher.** CSV/JSON edits take effect only on restart (or Apply Configuration /
  Load Model File). Live watching is roadmap, not implemented.
- **Startup is async.** main `await`s `autoConnectConfigFile()` (which prunes + persists)
  BEFORE `createWindow()`, then pushes a `config-ready` event with the loaded entries.
  Renderer listens via `onConfigReady()` — keep this wiring if you touch startup; otherwise
  the config table can render empty on first paint.
- **`models-config.js` is the fallback catalog** (17 providers incl. some NOT in
  ProviderConfig.csv: Anthropic, OpenAI, Google AI Studio, OpenRouter). Adding a provider
  there does NOT make it appear in the UI — add it to `ProviderConfig.csv`.
- **`model-config.js` is dead code** — moved to `archive/`. Don't edit it expecting behavior
  changes.
- **Preload dead APIs were removed** (`getLoadedModels`, `parseCsvFile`, `parseExcelFile`,
  `openModelFileDialog`). If you add an IPC feature, wire all three of `ipcMain.handle`
  (main.js), preload exposure (preload.js), and the renderer call together.
- **`.env` contains real API keys** — never commit, never log, never send them anywhere.
  `env.example` holds placeholders only (real-looking `COMMAND_API_KEY` scrubbed,
  `OPENCODE_ZEN_API_KEY` renamed to `ZEN_API_KEY` to match `.env`; done 2026-08-04).
- `LatestModels.csv` may contain `ERROR:...` rows and stale rows for removed providers —
  both are skipped/ignored at load; `node fetch-models.js` regenerates the file.
- CSV fields are comma-separated with basic `"` quoting. **Don't put commas in provider or
  model names** or rows break.
- Windows/PowerShell host: chain with `;` (no `&&`); quote paths containing spaces (this
  repo path has them). Use `workdir` instead of `cd`.

## Commands

```powershell
npm start          # electron .
npm run dev        # node start.js (npx electron .)
node fetch-models.js            # regenerate LatestModels.csv + models.csv from ProviderConfig.csv
node --check <file>.js          # syntax check any JS file
```

## Conventions

- Keep `state-store.js` as the ONLY file doing fs I/O for persistence; main.js wires IPC to
  it; renderer.js never touches the filesystem (goes through `window.api` from preload.js).
- **Every data-file path resolves through `state-store.getFilePath(role)`.** If you need a
  file's location (read or write), call `getFilePath(role)` — do NOT hardcode a filename or
  `path.join(__dirname, ...)`. Edit `file-registry.json` to redirect the app to a different
  file (insert/eject) instead of changing code. To add a brand-new data-file role, add it to
  `file-registry.json` + `DEFAULT_PATHS` in `state-store.js`, then resolve it via
  `getFilePath('your-role')`.
- When adding an IPC feature: add `ipcMain.handle` in main.js, expose it in preload.js
  (`contextBridge`), call it via `window.api` in renderer.js.
- When editing the config table rendering, remember dropdowns are fed by `providerInfo`
  (from ProviderConfig.csv) + model sources (LatestModels.csv primary, connected model-list
  fallback, models-config.js last).
- Update `APP.md` (architecture), `README.md` (user docs), and `AI_REFERENCE.md` (AI
  onboarding) when behavior or file roles change. Keep the counts in README current.

## Handoff

Project session state lives in `.opencode/SESSION.md` — read it first, update it when a
major subtask completes, clear it when the task is fully done. Global rules live in
`~/.config/opencode/AGENTS.md`.

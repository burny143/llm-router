# AGENTS.md — LLM Proxy Router (llm-proxy-gui)

Terse reference for the codebase. For the full deep-dive (dependency graph, IPC surface,
function call chains, data-file matrix, env vars, debug recipes) read **`AI_REFERENCE.md`**.
`APP.md` is the architecture/feature doc; `README.md` is user-facing.

## Meta
- Do **not** re‑verify conventions for every single edit. Trust the existing patterns.
- Before using a file, open it once and keep its contents in context — don’t re‑read.
- If you already know the structure, act directly; don’t plan or read additional files unless
  the current step fails.

## What this is
A local **Electron** app that runs a fallback LLM proxy (Express in the **main** process,
`src/proxy-server.js`). OpenAI‑compatible clients point at it; requests try known‑good models
sequentially, then all untested in parallel (first success wins). **There is no test suite** —
verify with `node --check` + launching the app.

## Quick rules
- All data file I/O goes through `src/state-store.js` — no direct fs in renderer.
- Resolve file paths via `getFilePath(role)` only when the file is non‑obvious; default names
  are safe otherwise.
- Add an IPC feature: `ipcMain.handle` in main.js → expose in preload.js → call via
  `window.api` in renderer. Don't over‑check the pattern.
- Provider names must match byte‑for‑byte across all CSVs/JSONs. A single grep for the name
  is enough.
- Never log cookie header values.

## Critical footguns
- `modelsEndpoint` in ProviderConfig.csv must **not** be empty (causes 0 models fetched).
- `authType=Cookie` web providers require three parts in sync:
  1. ProviderConfig row with `authType=Cookie`
  2. `<PREFIX>_COOKIE` in `data/.env`
  3. `web-provider-rules.json` entry keyed by provider name.
  Check with a single grep across the three sources.
- `.env` is never committed; `data/browser-profiles/` is gitignored — do not inspect them.

## Source-of-truth hierarchy
0. **`file-registry.json`** — maps data‑file roles to paths. Use `getFilePath(role)`.
1. **`ProviderConfig.csv`** — the single registry of available providers.
2. **`UltimateConfig.csv`** — editable proxy entries.
3. **`proxy-config.json`** — auto‑generated cache, never hand‑edit.

Cascade rule: deleting a provider from ProviderConfig.csv prunes its entries from
UltimateConfig.csv + proxy-config.json on startup. Empty/missing provider map ⇒ prune is a
no‑op (never wipe config because a CSV is broken). The renderer also filters by
`providerInfo[provider]`.

## Commands
```powershell
npm start                # electron .
npm run dev              # node start.js (npx electron .)
node src\fetch-models.js # regenerate LatestModels.csv + models.csv
node --check <file>.js   # syntax check any JS file
# Web provider capture:
node src\setup-web-provider.js <ProviderName> <LoginURL>
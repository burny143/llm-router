# Active Session State

- **Goal:** Reorganize project into folders + push to GitHub. COMPLETE.
- **Status:** Complete
- **Completed:**
  - Git repo initialized (`main` branch, remote `origin` = https://github.com/burny143/llm-router.git, pushed).
  - `.gitignore` created BEFORE first commit — protects `.env`, `node_modules/`, runtime data (proxy-config.json, models.csv, LatestModels.csv, known-ok.json, token-usage.json, settings.json), `archive/`.
  - Baseline commit `90d0e30` (flat layout safety net, 26 files).
  - Reorg commit `d6625bf`: `src/` (all app code incl. index.html/style.css/renderer.js together), `data/` (all data files), `samples/`, `docs/` (README/APP/AI_REFERENCE/CONFIG_REFERENCE/AGENTS).
  - Code path updates for the move: `package.json "main"` → `src/main.js`; `state-store.getFilePath` resolves relative against PROJECT_ROOT (`../`) and registry defaults now point into `data/`; `file-registry.json` paths → `data/…`; `main.js loadFile` → `path.join(__dirname,'index.html')`; `start.js` resolves project root explicitly; `data/settings.json` modelsFile updated to `data\models.csv`.
  - Docs updated with new layout (README structure tree, file maps, `node src\fetch-models.js`, "in `data/`" locations).
  - Verified: all `node --check` pass; Electron launches clean both via direct electron and via `node src/start.js`; paths resolve into `data/`.
- **Current Step:** None — done.
- **Next Step:** None.
- **Blockers/Notes:**
  - `.env` (real API keys) + runtime data are gitignored — confirmed not in any commit.
  - No test suite — verification = `node --check` + launch.
  - `node_modules` present locally but gitignored.

# Active Session State

- **Goal:** File-path notepad (`file-registry.json`) so every data-file path resolves through config, not hardcoded constants.
- **Status:** Complete
- **Completed:**
  - `file-registry.json` created: maps roles `providerConfig/ultimateConfig/proxyConfig/models/latestModels/knownOk/tokenUsage/settings/env` → paths (relative to root or absolute).
  - `state-store.js`: `getFilePath(role)` (registry first, `DEFAULT_PATHS` fallback); legacy constants (`CONFIG_CSV`, `PROVIDER_CONFIG_CSV`, etc.) now derived from registry — exported for compat.
  - `main.js`: dotenv path + LatestModels/models/UltimateConfig/.env reads all via `getFilePath()`.
  - `fetch-models.js`: reads/writes ProviderConfig/LatestModels/models.csv via `getFilePath()`.
  - Verified: no remaining hardcoded data-file paths in src JS; node -e insert/eject test (redirect `providerConfig` to abs path → resolved; restore works); missing-role fallback works; Electron launches clean.
  - Docs updated: AGENTS.md (hierarchy + convention), README.md (Layer 0 + "Swapping Data Files" section), AI_REFERENCE.md (file map + footgun #2), APP.md (file table + counts).
- **Current Step:** None — done.
- **Next Step (optional):**
  - Load Defaults button now populates from `models.csv` (all models per provider) — user approved.
- **Blockers/Notes:**
  - No test suite — verification = `node --check` + launch.
  - `file-registry.json` is the file to edit to insert/eject a data file (user-requested feature).

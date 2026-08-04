# Active Session State

- **Goal:** Connect the LLM proxy (localhost:8000) so opencode can use it as a provider.
- **Status:** In Progress (Electron app running, proxy needs to be started from GUI)
- **Completed:**
  - Root cause 1 (streaming): opencode has NO provider-level toggle to disable streaming (confirmed via schema `opencode.ai/config.json` — only a stream timeout option), and the proxy rejected `stream:true` with HTTP 400. Fixed the proxy instead: `src/proxy-server.js` now serves `stream:true` as OpenAI-style SSE (32-char delta chunks, `finish_reason: "stop"`, usage chunk, `[DONE]`). Upstream probing stays buffered so known-OK fast path + parallel fallback routing is preserved (`findWinner()` helper extracted). Verified with mock-upstream harness: reassembled content byte-identical, `[DONE]` present, usage chunk present. (commit `c101710`)
  - Root cause 2 (502 "All configured models failed"): handler only destructured `messages`+`stream` out of the body, so the client's `model` stayed in `rest`, and `probeOne` built `{ model: entry.model, messages, ...rest }` — rest spread LAST overrode `entry.model`. Every upstream got `model: "router"` (opencode's id) and rejected it → all failed → 502. Fixed: probe payload now `{ ...rest, model: entry.model, messages }` (entry model always wins) and handler strips `model`/`stream`/`stream_options` from rest; legit params (temperature, messages) still forwarded. Verified with echo harness: upstream receives `real-entry-model-v7`, no stream/stream_options leak. (commit `dbf81f7`)
  - Added provider to `C:\Users\THINKPAD\.config\opencode\opencode.json` (`llm-router`: `@ai-sdk/openai-compatible`, baseURL `http://localhost:8000/v1`, dummy apiKey, `models.router`). JSON validates.
  - Docs updated: `docs/README.md` streaming line + roadmap checkbox.
  - Electron app started (restored 36 known-OK endpoints, loaded config).
- **Current Step:** Start proxy from GUI (click "Start Proxy" button), then restart opencode, then select `llm-router / Router (auto)` and test chat.
- **Next Step:** User clicks "Start Proxy" in the Electron app → proxy runs on port 8000 → restart opencode → verify chat works.
- **Blockers/Notes:**
  - Electron app on port 8000 was running old code; restart required (no hot reload). opencode config also loaded once at startup — restart opencode too.
  - `data/UltimateConfig.csv` has a dirty working-tree diff from the user's OWN live app edits (model list reordering) — NOT mine; left untouched, don't stage it.
  - Commits `c101710` + `dbf81f7` are LOCAL (not pushed) — push on request.
  - `.env` (real keys) + runtime data gitignored — unchanged.
  - Proxy is NOT auto-started; must click "Start Proxy" in the GUI.

(End of file - total 19 lines)
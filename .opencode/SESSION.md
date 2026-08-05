# Active Session State
- **Goal:** Make the manually pasted Kimi `refresh_token` actually connect at runtime (health check + chat). DONE + live-verified. Next: user health-check/chat in GUI, then commit.
- **Status:** In Progress (code done + live-verified via direct client and through the real proxy; user UI verification + commit pending).

## Today (2026-08-05, Kimi token flow — the fix)
- **Root cause:** Kimi's web API is NOT an OpenAI-style endpoint (`https://www.kimi.com/api/chat/completion/stream` → 404). It's a token-exchange protocol served from `kimi.moonshot.cn`, reverse-engineered by kimi-free-api (lxtqq/kimi-free-api, MIT): refresh_token → access_token (300s TTL) → userId → create conv → stream completion → delete conv. Plain axios + browser-like headers works; no Playwright/WAF trouble.
- **New `src/kimi-web-client.js`**: `completion({model, messages, refreshToken, useSearch, signal})` returns `{status:200, data:<OpenAI-style>}`. Implements token refresh w/ per-token cache + request dedup queue, getUserInfo, createConversation, SSE stream collection (cmpl/all_done/error/search_plus), conv cleanup, message merging (single user msg + injected attention system prompt), URL wrapping, minimal retry (skips auth failures), abort support. Uses existing axios dep — no new packages.
- **proxy-server.js probeOne**: Cookie branch now routes through kimi client when `rule.authToken` exists; falls back to browserClient otherwise (Qwen unaffected). apiKey gate relaxed for token-auth providers (cookie env not required).
- **main.js health check**: same routing + relaxed gate.
- **Presets/CSVs**: Kimi preset baseURL/origin/referer → `kimi.moonshot.cn` (loginUrl stays www.kimi.com); UltimateConfig.csv + ProviderConfig.csv Kimi rows updated to match.
- **Verified live (real pasted token):** direct client ping → "pong" (4.3s); through real proxy (entry from UltimateConfig.csv) → HTTP 200 with assistant reply (3.2s); token cache: call1 9.6s / call2 4.3s / call3 2.9s. All changed files pass `node --check`.
- **Blocked item resolved:** previous Kimi health-check "Failed (404 - no usable content)" root-caused and fixed.

### Completed
- src/kimi-web-client.js (new), proxy-server.js (routing + relaxed gate), main.js (health-check routing + relaxed gate + preset update), both CSVs.
- Verified: node --check ×3; live direct completion; live e2e through proxy; access_token cache reuse.

- **Current Step:** User opens GUI → health-check Kimi → Quick Chat.
- **Next Step:** Commit all uncommitted work once user confirms GUI health-check/chat passes (git status shows many M/?? from prior turns, all still uncommitted).
- **Blockers/Notes:**
  - Qwen runtime chat still UNVERIFIED live (earlier hang was being diagnosed; stream restored to captured value).
  - setup-web-provider.js automation is parked per user ("dont worry about the automation process, i can just manual paste the token").
  - `.env` + browser-profiles + web-provider-rules gitignored; cookies/tokens never logged.

## Audit-driven cleanup (2026-08-05, external audit applied)
- **Archived dead code** → `archive/`: `src/tls-http-client.js` + `src/setup-qwen-cookie.js`. Zero `require`s confirmed; docs updated.
- **fetch-models.js**: guarded module-level readFileSync; `ERROR:` entries never prefix-stripped; honors `authType` (Cookie providers skipped).
- **models-config.js**: confirmed LIVE; stale model IDs updated from verified 2026 catalogs.
- **index.html**: removed hardcoded Qwen/Kimi option lists (dropdowns populated via GET_WEB_PROVIDER_PRESETS).
- **browser-http-client.js**: method param; unified WAF markers; removed dead import + redundant _injectCookies; close() var rename.
- **state-store.js**: getFilePath hasOwnProperty guard + unknown-role warning.
- **style.css**: removed orphaned `#healthResults h3`.
- IPC surface audit: all shared-constants channels have handlers (config-ready/dev-log are push-only).
- All changed files pass `node --check`.

## Bug fixes applied (unverified live)
- **Dropdown unclickable after config changes** (renderer.js): select change handler no longer rebuilds whole table synchronously → `refreshConfigRow(idx)` deferred one tick.
- **Add-Web-Provider modal dropdown dead after a setup attempt** (renderer.js + index.html): form DOM never swapped; status lives in separate `#webProviderModalStatus` div; modal open resets form each time.
- **Kimi capture auto-chat failed on disabled Send button** (setup-web-provider.js): real keystrokes + Send-enabled polling (≤5s) + click/Enter fallback; prints manual guidance if auto-chat fails.
- **Clear-Web-Provider-Session closes every browser session** (main.js + browser-http-client.js): `close(profileKey)` scoped; main.js computes `envPrefixFor(name).toLowerCase()`, focuses window after close.
- **Provider missing from dropdown/config after paste/capture** (main.js + renderer.js): paste path adds config entry + queueConfigReady; capture path also queues; `refreshProviderInfo()` merges ProvidersConfig.csv into startup-frozen providerInfo; onConfigReady async refresh → filter → re-render.
- **8 remaining sync table rebuilds** deferred via setTimeout(0) in renderer.js (delete/load-defaults/clear-all/fetch-models/load-csv + connect/ping-all).
- **Kimi runtime 404** → new kimi-web-client.js token flow (this session's main fix).
- All changed files pass `node --check`.

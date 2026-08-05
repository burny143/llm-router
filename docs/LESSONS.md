# Lessons — environment constraints & quirks

- [npm/native build] `npm install tls-client` fails on this Windows box: it pulls `ffi-napi`, which compiles via node-gyp/MSBuild and errors `MSB8036: The Windows SDK version 10.0.26100.0 was not found`. Install the VS2022 "Desktop development with C++" workload (Windows 11 SDK, ~15–20 GB) before attempting any native npm package; otherwise prefer non-native alternatives (e.g. Playwright in-page fetch for TLS/WAF bypass).
- [Windows/PowerShell] chain commands with `;`, not `&&`; always quote paths containing spaces; use the `workdir` parameter instead of `cd`.
- [Electron preload] `require('electron')` returns undefined under plain Node — `node --check` validates `preload.js` syntax, but loading it via `node -e require(...)` throws `Cannot read properties of undefined (reading 'exposeInMainWorld')`; only the Electron runtime provides `contextBridge`.
- [Windows/PowerShell] `node -e` with inline JS containing escaped quotes/backslashes gets mangled by PowerShell escaping (unterminated string / `\"` replacement) — write a temp `.js` file (e.g. under `C:\Users\THINKPAD\AppData\Local\Temp\opencode`) and run it instead.

## Kimi web API — model/provider knowledge
- [kimi-api] Kimi's web API is NOT OpenAI-compatible: `https://www.kimi.com/api/chat/completion/stream` 404s (no usable content). Real flow is a token dance on `kimi.moonshot.cn`: refresh_token → access_token (300s TTL) → userId → POST `/api/chat` → convId → POST `/api/chat/{convId}/completion/stream` (SSE) → DELETE `/api/chat/{convId}` cleanup.
- [kimi-api] Works with plain axios + browser-like headers (fake `Hm_lvt_*`/`_ga` cookies, sec-ch-ua, UA, R-Timezone); no Playwright/browser needed — route Kimi through `kimi-web-client.js`, NOT `browser-http-client` (kills the WAF/browser-close flakiness entirely).
- [kimi-api] A pasted Kimi JWT (`eyJ...` 3-part, regex `/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/`) is a **refresh_token** → store as `authToken` in web-provider-rules.json, not as `<PREFIX>_COOKIE` env; a cookie env var is not required for token-auth providers (relax the "no API key" gate when `rule.authToken` exists).
- [kimi-api] access_token TTL = 300s: cache per refresh_token and dedup concurrent refreshes with a waiters queue; re-refresh only when `unixTimestamp() > refreshTime`.
- [kimi-api] Completion body is `{kimiplus_id, messages, refs: [], use_search}` (model only sent if it matches `^[0-9a-z]{20}$`); messages must be merged into ONE user message with `role:content` lines and an injected system prompt (`关注用户最新的消息`) before the last message; user URLs wrapped in `<url id="" type="url" status="" title="" wc="">` tags.
- [kimi-api] Stream events: `cmpl` (text chunk, strip U+FFFD), `all_done`/`error` (finish), `search_plus` (web-search refs); requests need `X-Traffic-Id: <userId>` + `Referer: <base>/chat/{convId}`.
- [kimi-api] refresh_token JWT carries its own `exp` claim (~90 days from issue, e.g. issued 2026-08-05 → exp 2026-11-03); can be invalidated early by logout/password change; a `401`/`auth.token.invalid` on health check means re-paste a fresh token (no re-setup — SET_PROVIDER_COOKIE JWT detection is already wired).

## Coding habits learned (this project)
- [web-ui] Native `<select>` popup + synchronous DOM rebuild or `confirm()` in the same tick = stuck invisible popup that eats clicks → defer rebuilds/dialogs one tick (`setTimeout(..., 0)`) and never swap a modal's form DOM in/out (keep status in a separate div).
- [web-ui] Playwright window close steals OS focus from the Electron window → `mainWindow.focus()` after closing; never block the IPC response on slow `browserContext.close()` disk flush — close in the background (`.then` re-focus as belt-and-suspenders, `.catch` → `console.warn`).
- [web-ui] Browser sessions keyed `${origin}::${profileKey}` → `close(profileKey)` filter so clearing one provider never nukes another provider's valid logged-in session.
- [testing] Verify against the real token/API before claiming a fix: live direct ping, then e2e through the real proxy (`startProxy` + POST `/v1/chat/completions`); access_token cache is observable (first call ~9s incl. refresh, later calls ~3s).
- [secrets] Never log cookies/tokens/authTokens; mask with regex when inspecting rules/.env (e.g. `("authToken":\s*")[^"]{8}[^"]*(")` → `$1***REDACTED***$2`); check `.env` presence with key-name-only listing.
- [config] Reload `webRules` on `startProxy` and after capture/cookie-set so a newly added provider is picked up without an app restart.

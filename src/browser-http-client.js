// browser-http-client.js — place in src/ (same folder as main.js)
const { chromium } = require('playwright');
const path = require('path');
const { getFilePath } = require('./state-store');
const {
  DEFAULT_COOKIE_USER_AGENT,
  FILE_ROLES,
  BROWSER_FETCH_TIMEOUT_MS,
  BROWSER_FETCH_HANG_GUARD_MS
} = require('./shared-constants');

// Same marker set for the initial clean-load check and the response check, so a
// challenge is detected in both places (the union of the old PAGE_/RESPONSE_
// lists, which had drifted apart).
const WAF_MARKERS = ['rgv587_flag', 'x5secdata', 'captcha', 'punish', 'just a moment', "checking your browser", 'cf-challenge', 'turnstile', 'attention required'];

function defaultProfileKeyForUrl(url) {
  try {
    const host = new URL(url).hostname || '';
    const parts = host.split('.');
    // e.g. chat.qwen.ai -> 'qwen.ai'; bare host kept as-is
    return parts.length > 2 ? parts.slice(-2).join('.') : (host || 'proxy-client');
  } catch (e) {
    return 'proxy-client';
  }
}

function containsAny(text, markers) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return markers.some(m => lower.includes(m));
}

function domainForUrl(url) {
  try {
    const host = new URL(url).hostname;
    const parts = host.split('.');
    return parts.length > 2 ? '.' + parts.slice(-2).join('.') : '.' + host;
  } catch (e) {
    return null;
  }
}

function originForUrl(url) {
  try {
    return new URL(url).origin;
  } catch (e) {
    return url;
  }
}

class BrowserHttpClient {
  constructor() {
    this.sessions = new Map();
  }

   async _launchContext(profileKey) {
    const dataDir = path.dirname(getFilePath(FILE_ROLES.PROVIDER_CONFIG));
    const profileDir = path.join(dataDir, 'browser-profiles', profileKey || 'proxy-client');
    const base = {
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--disable-blink-features=AutomationDetected',
        '--start-minimized',
        '--window-position=-32000,-32000'
      ],
      // Single shared desktop-Chrome User-Agent for every Cookie-auth provider
      // request. Imported from shared-constants.js (not a local literal) so it
      // can't drift out of sync with the cookie-capture script's UA.
      userAgent: DEFAULT_COOKIE_USER_AGENT
    };
    const attempts = [
      { label: 'system Google Chrome (minimized)', channel: 'chrome', headless: false },
      { label: 'system Microsoft Edge (minimized)', channel: 'msedge', headless: false },
      { label: 'bundled Chromium (minimized)', channel: undefined, headless: false },
      { label: 'bundled Chromium (headless)', channel: undefined, headless: true }
    ];
    let lastError = null;
    for (const attempt of attempts) {
      try {
        const context = await chromium.launchPersistentContext(
          profileDir,
          Object.assign({}, base, { headless: attempt.headless }, attempt.channel ? { channel: attempt.channel } : {})
        );
        console.log(`[BrowserHttpClient] Launched ${attempt.label} using profile ${profileKey}.`);
        return context;
       } catch (err) {
        lastError = err;
        const msg = (err.message || String(err)).split('\n')[0];
        // "Opening in existing browser session" = the capture headed browser (same
        // profile dir) is still winding down / still open. Wait and retry each
        // attempt once before falling through to the next launch config.
        if (/existing browser session/i.test(msg) && !attempt._retried) {
          console.warn(`[BrowserHttpClient] ${attempt.label} busy (profile ${profileKey} in use), retrying once...`);
          attempt._retried = true;
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        console.warn(`[BrowserHttpClient] could not launch ${attempt.label}: ${msg}`);
      }
    }
    throw lastError || new Error('Could not launch any browser for BrowserHttpClient.');
  }

  async _injectCookies(context, url, cookies) {
    const domain = domainForUrl(url);
    if (!domain) {
      console.log(`[BrowserHttpClient] could not derive cookie domain from ${url} — skipping cookie injection.`);
      return;
    }
    const pairs = String(cookies).split(';').map(s => s.trim()).filter(Boolean);
    const list = pairs.map(pair => {
      const eq = pair.indexOf('=');
      if (eq === -1) return null;
      return {
        name: pair.slice(0, eq).trim(),
        value: pair.slice(eq + 1).trim(),
        domain: domain,
        path: '/'
      };
    }).filter(Boolean);
    if (list.length > 0) await context.addCookies(list).catch(() => {});
  }

  async _loadOriginClean(page, origin) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await page.goto(origin, { waitUntil: 'domcontentloaded' }); } catch (e) {}
      await page.waitForTimeout(2500).catch(() => {});
      let html = '';
      try { html = await page.content(); } catch (e) {}
      const wafHit = containsAny(html, WAF_MARKERS);
      console.log(`[BrowserHttpClient] _loadOriginClean attempt ${attempt+1}/${3}: origin=${origin} htmlLen=${html.length} wafDetected=${wafHit} snippet=${html.slice(0, 120).replace(/\s+/g,' ').replace(/"/g, '\\"')}`);
      if (!wafHit) return true;
      await page.waitForTimeout(3000).catch(() => {});
    }
    return false;
  }

   async _getSession(url, cookies, profileKey) {
    const origin = originForUrl(url);
    const sessionKey = profileKey ? `${origin}::${profileKey}` : origin;
    let session = this.sessions.get(sessionKey);
    const isNew = !session;
    if (isNew) {
      console.log(`[BrowserHttpClient] creating new session (profileKey=${profileKey || 'default'})`);
      const context = await this._launchContext(profileKey || defaultProfileKeyForUrl(url));
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        try { if (!window.chrome) window.chrome = {}; } catch (e) {}
      });
      const page = context.pages()[0] || await context.newPage();
      session = { context, page };
      this.sessions.set(sessionKey, session);
    }
    if (cookies) await this._injectCookies(session.context, url, cookies);
    if (isNew) await this._loadOriginClean(session.page, origin);
    return session;
  }

  async _fetchInPage(page, url, payload, headers, method = 'POST') {
    return page.evaluate(async ({ url, payload, headers, method, timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const fetchOptions = {
          method: method,
          headers: headers,
          credentials: 'include',
          signal: controller.signal
        };
        if (method !== 'GET' && payload != null) {
          fetchOptions.body = JSON.stringify(payload);
        }
        const res = await fetch(url, fetchOptions);
        const text = await res.text();
        return { status: res.status, text: text, ok: true };
      } catch (err) {
        return { status: 0, text: err.name === 'AbortError' ? `request timed out after ${timeoutMs}ms` : err.message, ok: false };
      } finally {
        clearTimeout(timer);
      }
    }, { url, payload, headers, method, timeoutMs: BROWSER_FETCH_TIMEOUT_MS });
  }

   async request(url, payload, headers, cookies, profileKey, method = 'POST') {
    const session = await this._getSession(url, cookies, profileKey);
    // NOTE: cookies were already injected inside _getSession — no second call here.
    console.log(`[BrowserHttpClient] dispatching in-page ${method} to ${url.toString().slice(0, 80)} payload=${JSON.stringify(payload).slice(0, 120)}`);

     // Outer timeout: catches a Playwright-level hang (page.evaluate never resolves).
     // BROWSER_FETCH_HANG_GUARD_MS is deliberately LONGER than the inner
     // AbortController timeout (BROWSER_FETCH_TIMEOUT_MS) so this guard only
     // fires on a genuine Playwright-level hang, never on ordinary race
     // ambiguity with the inner fetch timeout.
     let result;
     try {
       result = await Promise.race([
         this._fetchInPage(session.page, url, payload, headers, method),
         new Promise((_, rej) => setTimeout(() => rej(new Error('browser fetch timed out')), BROWSER_FETCH_HANG_GUARD_MS))
       ]);
     } catch (e) {
       console.log(`[BrowserHttpClient] in-page fetch ABORTED: ${e.message}`);
       throw new Error(`Browser fetch failed: ${e.message}`);
     }
     if (!result.ok) {
       console.log(`[BrowserHttpClient] in-page fetch returned status=${result.status} text=${String(result.text).slice(0, 200)}`);
       throw new Error(`Browser fetch failed: ${result.text}`);
     }

     if (containsAny(result.text, WAF_MARKERS)) {
       console.log(`[BrowserHttpClient] WAF/challenge markers detected in response, reloading origin...`);
       await this._loadOriginClean(session.page, originForUrl(url));
       result = await this._fetchInPage(session.page, url, payload, headers, method);
       if (!result.ok) throw new Error(`Browser fetch failed: ${result.text}`);
       if (containsAny(result.text, WAF_MARKERS)) {
         throw new Error('WAF/CAPTCHA detected in browser response');
       }
     }

     console.log(`[BrowserHttpClient] GET/POST ${url.toString().slice(0, 60)} -> status=${result.status} len=${result.text.length} snippet=${String(result.text).slice(0, 160).replace(/\s+/g, ' ')}`);
     return { status: result.status, data: result.text, headers: {} };
   }

  // Close sessions, optionally scoped to one provider's profile. Sessions are
  // keyed `${origin}::${profileKey}`, so a profileKey filter only tears down
  // that provider's windows. Without an argument, closes everything (full-app
  // shutdown only — closing unrelated native browser windows mid-flow steals
  // OS focus from the Electron window and breaks native <select> popups).
  async close(profileKey) {
    for (const [sessionKey, session] of this.sessions.entries()) {
      if (profileKey && !sessionKey.endsWith(`::${profileKey}`)) continue;
      if (session.context) await session.context.close().catch(() => {});
      this.sessions.delete(sessionKey);
    }
  }
}

module.exports = new BrowserHttpClient();
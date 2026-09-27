import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
// Side-effect import: init i18next + negotiate the active UI locale BEFORE
// first render (ADR 0065), so useTranslation resolves + <html lang|dir> is set.
// `i18nReady` gates the first render on the negotiated locale's lazy chunk
// (CHV-UX-1 / ADR 0329) so non-en users never see an English flash; it
// self-resolves after 1.5 s if the chunk stalls, so it can never brick boot.
import { i18nReady } from './i18n/index.js';
import { installRateLimitObserver } from './client/rateLimitSignal.js';

// ADR 0640 — observe 429s at the one seam every client module shares. Reads
// status + Retry-After off responses; never alters a request or a body.
installRateLimitObserver();
import { initObservability } from './platform/initObservability.js';
import { migrateSampleNamespace } from './platform/storage.js';
import { BrandProvider } from './brand/BrandProvider.js';
import { readCachedIdentity, applyBrandIdentity, hydrateBrandSingleton } from './brand/applyBrand.js';
// Side-effect import: initializes Firebase Auth (if configured) so the
// `onIdTokenChanged` subscriber populates the cached ID token before
// any fetch fires. No-op when Firebase env vars are unset.
import './auth/firebase.js';
import { getCurrentUser, getRedirectState } from './auth/firebase.js';
// Trigger lazy init synchronously at module load so the auth state
// settles before the first fetch.
void getCurrentUser();
// Kick off redirect-result processing at boot. The promise is
// memoized inside firebase.ts; components await the same one.
// Awaiting here pre-warms it so the redirect-back handler runs
// before the first paint that might depend on its outcome.
void getRedirectState();

// A code-split (lazy) chunk can 404 after a deploy replaces its content hash —
// Firebase Hosting serves only the current release's files, so a tab left open
// ACROSS a deploy holds stale chunk names. When it later lazy-loads a route
// chunk, the missing `assets/*.js` is answered by the SPA fallback (index.html,
// `text/html`) and the browser rejects it as a module ("Failed to load module
// script … MIME type text/html"). Vite fires `vite:preloadError` for exactly
// this; reload ONCE to pull the current index.html + chunk graph. A timestamped
// sessionStorage guard breaks the loop if a reload doesn't fix it (the chunk is
// genuinely broken, not merely stale) while still allowing a fresh reload after
// a LATER deploy in the same session.
window.addEventListener('vite:preloadError', (event) => {
  const KEY = 'openwop-app.preloadReloadedAt';
  const last = Number(sessionStorage.getItem(KEY) ?? '0');
  if (Date.now() - last < 10_000) return; // just retried and still failing → let it surface
  sessionStorage.setItem(KEY, String(Date.now()));
  event.preventDefault(); // we're handling it — suppress the default unhandled rejection
  window.location.reload();
});

// Re-home legacy `openwop.sample.*` localStorage keys to `openwop-app.*` before
// any module reads them, so returning users keep chat sessions / prompts / drafts.
migrateSampleNamespace();

// Wire observability (reporter, API timing seam, web vitals) before first paint.
initObservability();

// ADR 0118 Phase 6 — browser-side OpenTelemetry, fire-and-forget + LAZY. The whole
// OTel-web SDK stays in a SEPARATE async chunk (never the entry bundle), pulled in
// only when a build configures VITE_OTEL_EXPORTER_OTLP_ENDPOINT. Unconfigured ⇒
// zero cost, no import.
if (import.meta.env.VITE_OTEL_EXPORTER_OTLP_ENDPOINT) {
  void import('./observability/browserOtel.js').then((m) => m.initBrowserOtel()).catch(() => {});
}

// ADR 0170 — synchronously hydrate the runtime brand from the last-known identity
// (cached by BrandProvider) BEFORE first render, so every load after the first
// paints a super-admin override with no flash. BrandProvider then refreshes it from
// /public-brand. The inline <head> script already pre-applied colors/title/favicon.
const cachedBrand = readCachedIdentity();
if (cachedBrand) {
  hydrateBrandSingleton(cachedBrand);
  applyBrandIdentity(cachedBrand);
}

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Mount point #root not found in index.html');
}

void i18nReady.then(() => {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <BrowserRouter>
        <BrandProvider>
          <App />
        </BrandProvider>
      </BrowserRouter>
    </React.StrictMode>,
  );
});

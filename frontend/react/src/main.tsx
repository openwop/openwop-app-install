import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
// Side-effect import: init i18next + negotiate the active UI locale BEFORE
// first render (ADR 0065), so useTranslation resolves + <html lang|dir> is set.
import './i18n/index.js';
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

// Re-home legacy `openwop.sample.*` localStorage keys to `openwop-app.*` before
// any module reads them, so returning users keep chat sessions / prompts / drafts.
migrateSampleNamespace();

// Wire observability (reporter, API timing seam, web vitals) before first paint.
initObservability();

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

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <BrowserRouter>
      <BrandProvider>
        <App />
      </BrandProvider>
    </BrowserRouter>
  </React.StrictMode>,
);

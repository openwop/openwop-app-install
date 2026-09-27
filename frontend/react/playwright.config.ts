import { defineConfig, devices } from '@playwright/test';

/**
 * PER-WORKTREE PORT. Several checkouts of this repo run side by side, and a
 * fixed :5173 means they contend for one dev server — which, with server reuse
 * on, meant a suite could bind to ANOTHER worktree's app and pass without ever
 * executing your code. Set OPENWOP_E2E_PORT to give a worktree its own.
 */
const E2E_PORT = Number(process.env.OPENWOP_E2E_PORT ?? '5173');
const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;

/**
 * Playwright e2e config (GAP-ANALYSIS E16). Boots the Vite dev server and runs
 * the smoke specs in e2e/. NOTE: requires browsers once via
 * `npx playwright install chromium`, and a backend on :8080 (or
 * OPENWOP_DEV_PROXY_TARGET) for the data-dependent specs. Kept out of the
 * default `npm test` (vitest) — run with `npm run test:e2e`.
 */
export default defineConfig({
  // Grade-trio finding 3: with the default `updateSnapshots: 'missing'`, a
  // machine with no baseline for its platform (a Linux adopter — the
  // committed set is -darwin) WRITES fresh baselines on the first failing
  // run, and the second run goes green against them: the visual gate
  // self-certifies whatever that box rendered. 'none' makes a missing
  // baseline fail identically on every run instead.
  updateSnapshots: 'none',
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: E2E_ORIGIN,
    trace: 'on-first-retry',
    // ADR 0375 — '/' shows the MARKETING front page to a first-time anonymous
    // visitor when a backend is reachable (the runtime pointer resolves
    // enabled). The e2e specs exercise the APP shell, so every default context
    // starts with the product's own "this browser has entered the app" marker —
    // exactly what a real browser has after any demo entry or deep link.
    // (Specs that create their own contexts via browser.newContext() don't
    // inherit this; they log in, which also keeps '/' in-app.)
    storageState: {
      cookies: [],
      origins: [
        {
          origin: E2E_ORIGIN,
          localStorage: [{ name: 'openwop:app-entered', value: '1' }],
        },
      ],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run dev -- --port ${E2E_PORT} --strictPort`,
    url: E2E_ORIGIN,
    // REUSE IS OFF BY DEFAULT, and this is not a performance oversight.
    //
    // With `reuseExistingServer: !CI`, a run in ANY worktree silently binds to
    // whatever already holds :5173 — which, with several parallel checkouts, is
    // routinely a DIFFERENT COPY OF THE APP. That is not a flake; it is a green
    // suite that never executed your code. It was caught by sabotage: deleting
    // `<GlobalLiveRegion/>` from the shell left all three specs passing, because
    // they were testing another worktree's server.
    //
    // A test that cannot fail when you break the thing it tests is worse than no
    // test, so correctness wins over the seconds reuse saves. Opt back in
    // explicitly with OPENWOP_E2E_REUSE_SERVER=1 when you know the server is
    // yours (e.g. iterating on one spec against your own `npm run dev`).
    reuseExistingServer: process.env.OPENWOP_E2E_REUSE_SERVER === '1',
    timeout: 120_000,
    // The e2e session is a COOKIE session (test/login mints `__session`), but the
    // client's default authMode is 'bearer', where `fetchOpts` attaches no
    // `credentials` — every page-side API fetch was silently anonymous (collab's
    // org list came back empty; only demo-mode anon-owner grants masked it
    // elsewhere). Cookie mode makes the page fetches carry the session, matching
    // the deployed cookie posture.
    env: { VITE_OPENWOP_AUTH_MODE: 'cookie' },
  },
});

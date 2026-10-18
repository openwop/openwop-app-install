import { defineConfig, devices } from '@playwright/test';

/**
 * ADR 0873 Verification 2–3 — the offline service worker, end to end, in Chromium.
 *
 * No feature declares `offline` on main, so the shipped worker has no engine. This
 * lane runs against two fixture builds that do (scripts/build-offline-fixture.mjs),
 * served by e2e/offlineFixtureServer.ts, which each spec starts and stops itself:
 * "offline" here is the server going away, not emulation. `npm run test:e2e:offline`
 * builds both fixtures first.
 *
 * Only `*.offline.ts` files run here; neither of the other configs matches them.
 */
export const OFFLINE_E2E_PORT = Number(process.env.OPENWOP_E2E_OFFLINE_PORT ?? '4875');
const ORIGIN = `http://127.0.0.1:${OFFLINE_E2E_PORT}`;

export default defineConfig({
  updateSnapshots: 'none',
  testDir: './e2e',
  testMatch: '**/*.offline.ts',
  reporter: 'list',
  workers: 1,
  timeout: 90_000,
  use: {
    baseURL: ORIGIN,
    // Service workers are the subject, so never let Playwright block them.
    serviceWorkers: 'allow',
    storageState: {
      cookies: [],
      origins: [{ origin: ORIGIN, localStorage: [{ name: 'openwop:app-entered', value: '1' }] }],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

import { defineConfig, devices } from '@playwright/test';

/**
 * ADR 0874 W-STALE — Playwright against the PRODUCTION build (`vite preview` of `dist/`).
 *
 * The default config (playwright.config.ts) boots the Vite DEV server, which has no
 * hashed chunks, no preload helper and no stale-chunk failure mode, so it cannot
 * witness what a deploy does to an open tab. This lane serves a real `npm run build`
 * output. Run `npm run build` first, then `npm run test:e2e:built`.
 *
 * Only `*.built.ts` files run here, and the default config never matches them
 * (its testMatch is Playwright's `*.spec.ts`/`*.test.ts`).
 */
const PORT = Number(process.env.OPENWOP_E2E_BUILT_PORT ?? '4873');
const ORIGIN = `http://localhost:${PORT}`;

export default defineConfig({
  updateSnapshots: 'none',
  testDir: './e2e',
  testMatch: '**/*.built.ts',
  reporter: 'list',
  workers: 1,
  use: {
    baseURL: ORIGIN,
    storageState: {
      cookies: [],
      origins: [{ origin: ORIGIN, localStorage: [{ name: 'openwop:app-entered', value: '1' }] }],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // `node …/vite.js`, not `npx vite`: npx can exit 194 silently in this sandbox (CLAUDE.md).
    command: `node node_modules/vite/bin/vite.js preview --port ${PORT} --strictPort`,
    url: ORIGIN,
    // Same reason as the default config: a reused server can be another worktree's app.
    reuseExistingServer: false,
  },
});

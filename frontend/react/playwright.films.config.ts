import { defineConfig, devices } from '@playwright/test';
// Explicit ports prevent reuse of another worktree's app. The documented
// runner chooses free ports before invoking this dedicated acceptance lane.
const front = Number(process.env.OPENWOP_FILM_FRONT_PORT);
const back = Number(process.env.OPENWOP_FILM_ACCEPTANCE_PORT);
if (![front, back].every(port => Number.isInteger(port) && port > 0 && port < 65536) || front === back) throw new Error('Supply distinct free OPENWOP_FILM_FRONT_PORT and OPENWOP_FILM_ACCEPTANCE_PORT.');
const origin = `http://127.0.0.1:${front}`;
const backend = `http://127.0.0.1:${back}`;
export default defineConfig({
  testDir: './e2e', testMatch: '**/*films.acceptance.ts', fullyParallel: false, workers: 1, retries: 0, timeout: 90_000,
  reporter: 'list', outputDir: 'test-results/films',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  use: { baseURL: origin, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: 'openwop:app-entered', value: '1' }] }] }, launchOptions: { args: ['--host-resolver-rules=MAP fonts.googleapis.com ~NOTFOUND, MAP fonts.gstatic.com ~NOTFOUND'] } },
  webServer: [
    { command: 'node --import tsx test/support/filmAcceptanceServer.ts', cwd: '../../backend/typescript', url: `${backend}/health`, reuseExistingServer: false, timeout: 90_000 },
    { command: `npm run dev -- --host 127.0.0.1 --port ${front} --strictPort`, url: origin, reuseExistingServer: false, timeout: 60_000,
      env: { VITE_OPENWOP_BASE_URL: '/api', VITE_OPENWOP_SSE_BASE_URL: '/api', VITE_OPENWOP_AUTH_MODE: 'cookie', OPENWOP_DEV_PROXY_TARGET: backend } },
  ],
});

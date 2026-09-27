/**
 * Feature route render-smoke (ADR 0183) — the AUTOMATED mirror of the manual-test catalog.
 * Data-driven off the SAME `suites.ts` the manual runner uses (single source of truth), so it
 * stays in sync automatically: for every suite route it signs in, enables any toggle the route
 * is gated behind (the recorded `toggle.id`), navigates, and asserts the surface renders
 * without the error-boundary crash — automating the first step of every manual case
 * ("navigate → the feature renders").
 *
 * Env-gated (OPENWOP_E2E_ROUTES=1) + needs a backend on :8080 with the test seams — see
 * e2e/support/session.ts. Skips cleanly in the default CI path.
 */
import { test, expect, type BrowserContext } from '@playwright/test';
import { SUITES } from '../src/features/manual-tests/suites.js';
import { login, enableToggle } from './support/session.js';

const ENABLED = process.env.OPENWOP_E2E_ROUTES === '1';
const TENANT = 'e2e-routes';

// Unique page routes → the features that live there + the toggle ids gating any of them.
const routes = new Map<string, { features: string[]; toggles: Set<string> }>();
for (const s of SUITES) {
  if (!s.route.startsWith('/')) continue;
  const e = routes.get(s.route) ?? { features: [], toggles: new Set<string>() };
  e.features.push(s.feature);
  if (s.toggle.off && s.toggle.id) e.toggles.add(s.toggle.id);
  routes.set(s.route, e);
}

test.describe('feature route render-smoke (ADR 0183)', () => {
  test.skip(!ENABLED, 'Set OPENWOP_E2E_ROUTES=1 + a local backend with the test seams (see e2e/support/session.ts).');
  test.describe.configure({ timeout: 60_000 });

  let ctx: BrowserContext;
  test.beforeAll(async ({ browser }) => {
    if (!ENABLED) return;
    ctx = await browser.newContext();
    await login(ctx.request, 'admin@e2e.test', TENANT);
  });
  test.afterAll(async () => { await ctx?.close(); });

  for (const [route, meta] of routes) {
    test(`renders ${route} — ${meta.features.join(', ')}`, async () => {
      for (const id of meta.toggles) await enableToggle(ctx.request, id);
      const page = await ctx.newPage();
      try {
        await page.goto(route);
        // The surface mounted (a <main> — the app shell #main-content OR the public
        // landing #public-main, both valid renders) — not a white screen.
        await expect(page.locator('main').first()).toBeVisible();
        // The error-boundary fallback is absent (no runtime crash on this route).
        await expect(page.getByText('Something went wrong')).toHaveCount(0);
      } finally {
        await page.close();
      }
    });
  }
});

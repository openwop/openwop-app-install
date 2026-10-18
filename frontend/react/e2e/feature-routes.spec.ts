/**
 * Feature route render-smoke (ADR 0183) — the AUTOMATED mirror of the manual-test catalog.
 * Data-driven off the SAME `suites.ts` the manual runner uses (single source of truth), so it
 * stays in sync automatically: for every suite route it signs in, enables any toggle the route
 * is gated behind (the recorded `toggle.id`), navigates, and asserts the surface renders
 * without the error-boundary crash — automating the first step of every manual case
 * ("navigate → the feature renders").
 *
 * Env-gated (OPENWOP_E2E_ROUTES=1): it runs ONLY under `scripts/e2e-routes.sh`
 * (`npm run ci:full` / `npm run test:e2e:full`), never in the default gate. See
 * e2e/support/session.ts for the backend seams.
 *
 * WHAT "RENDERS" MEANS (grade-tests wave 53). The first cut asserted "a <main> is
 * visible and no error boundary" the instant the SHELL's <main> painted — before the
 * route's lazy chunk mounted — so a page that threw on render stayed green (probes:
 * a throwing JournalPage and a throwing BillingPage were both missed). Each route now
 * SETTLES first (no route-loading/skeleton/aria-busy placeholder left in <main>),
 * then asserts: no error boundary, no "Administrator access required" deny card
 * (trap 1 — the caller signs in to its OWN workspace, so admin-tier routes render
 * the page, not a deny card), and every toggle the catalog names exists.
 */
import { test, expect, type BrowserContext } from '@playwright/test';
import { SUITES } from '../src/features/manual-tests/suites.js';
import { API, enableToggle } from './support/session.js';

const ENABLED = process.env.OPENWOP_E2E_ROUTES === '1';

/**
 * BLOCKED-ON-PRODUCT (SUITES-STALE-TOGGLE-1, wave 53): `suites.ts` still records
 * these as toggle-gated (`toggle.off` + `toggle.id`), but the server has no toggle
 * config to enable for any of them (MEASURED: `enableToggle` → false for exactly
 * these 5 of the catalog's 44 ids). `channels`, `kb`, `memory-auto-extract` and
 * `sharing` (ADR 0434) graduated to always-on (their feature.ts has no
 * `toggleDefault`); `context-economy` has no feature registration at all. The spec used to ignore `enableToggle`'s result, which is
 * how the drift stayed invisible. SHRINK-ONLY: every other catalog toggle must
 * enable, and the case below fails the moment one of these starts enabling (fix
 * `suites.ts`, then delete its line here).
 */
const STALE_CATALOG_TOGGLES = new Set(['channels', 'context-economy', 'kb', 'memory-auto-extract', 'sharing']);

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
    // The caller's OWN workspace (no tenantId): an explicit tenant makes the seam
    // treat the workspace as somebody else's, and every admin-tier route then
    // renders a deny card that "renders without crashing" (support/session.ts trap 1).
    const res = await ctx.request.post(`${API}/test/login`, { data: { email: 'admin@e2e.test' } });
    expect(res.status(), await res.text()).toBe(201);
  });
  test.afterAll(async () => { await ctx?.close(); });

  test('the stale catalog toggles are still unknown to the server (SUITES-STALE-TOGGLE-1, shrink-only)', async () => {
    const named = new Set([...routes.values()].flatMap((m) => [...m.toggles]));
    for (const id of STALE_CATALOG_TOGGLES) {
      expect(named.has(id), `'${id}' is no longer named by suites.ts — delete it from STALE_CATALOG_TOGGLES`).toBe(true);
      expect(await enableToggle(ctx.request, id), `'${id}' now enables — it is a real toggle again; delete it from STALE_CATALOG_TOGGLES`).toBe(false);
    }
  });

  for (const [route, meta] of routes) {
    test(`renders ${route} — ${meta.features.join(', ')}`, async () => {
      for (const id of meta.toggles) {
        if (STALE_CATALOG_TOGGLES.has(id)) continue; // asserted in its own case below
        expect(await enableToggle(ctx.request, id), `toggle '${id}' (named by suites.ts for ${route}) could not be enabled`).toBe(true);
      }
      const page = await ctx.newPage();
      try {
        await page.goto(route);
        // The surface mounted (a <main> — the app shell #main-content OR the public
        // landing #public-main, both valid renders) — not a white screen.
        await expect(page.locator('main').first()).toBeVisible();
        // SETTLE before any absence: the route chunk's fallback (`RouteLoading`, a
        // busy skeleton), EntitlementGuard's busy state and page skeletons all carry
        // `.skeleton` / `aria-busy`. The gallery's specimens are permanent ones.
        await expect(
          page.locator('main :is(.skeleton, .skeleton-rows, [aria-busy="true"]):not([data-gallery] *)'),
          `${route} never finished loading`,
        ).toHaveCount(0, { timeout: 30_000 });
        // The error-boundary fallback is absent (no runtime crash on this route)…
        await expect(page.getByText('Something went wrong')).toHaveCount(0);
        // …and the page is the feature, not the admin deny card.
        // (Outside the gallery: /design-system renders that title as a specimen.)
        await expect(page.locator('main').getByText('Administrator access required').and(page.locator(':not([data-gallery] *)'))).toHaveCount(0);
      } finally {
        await page.close();
      }
    });
  }
});

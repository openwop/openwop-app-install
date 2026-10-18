/**
 * Admin shell governance (ADR 0510 Phase 4 — the admin governance/visual contract;
 * Phase 7 DSA-026 — the ≤860px rail is a compact DISCLOSURE, not a link cloud).
 *
 * What only a browser can show, one case each:
 *  1. Ten admin aliases / detail routes, loaded by URL and walked through browser
 *     history, keep ONE <main> and exactly one current destination (`aria-current`,
 *     ADR 0139 `activeFor` aliases) — or, for a child whose parent is hidden from a
 *     non-superadmin, zero current plus an explicit parent link (wayfinding).
 *  2. WCAG 1.4.10 reflow at 320px: no horizontal page overflow, one main, every nav
 *     uniquely labelled (the admin rail among them), one current destination.
 *  3. WCAG 2.1.1 keyboard: the mobile disclosure opens with Enter and closes on
 *     navigation.
 *  4. WCAG 2.5.8 / DESIGN `--hit-target`: coarse-pointer admin targets ≥ 44 CSS px.
 * `AdminLayout.activeAlias.test.tsx` (jsdom) pins one alias and the accordion
 * state; it cannot load lazy routes, walk history, lay out or size targets.
 *
 * Incidents already paid for (see the inline notes): the one-shot count that raced
 * the rail (72d56d6eb), the 44px float compare (d05a421b8), the per-route budget
 * (ADR 0863). Breaks it (w53 probes, all witnessed): dropping the rail's
 * `aria-current`, a fixed-width admin grid at ≤860px, not closing the disclosure on
 * navigation, a sub-44px toggle, or dropping the parent route context.
 */
import { devices, expect, test, type APIRequestContext } from '@playwright/test';
import { API, enableToggle } from './support/session.js';

async function loginPersonal(request: APIRequestContext, email: string): Promise<void> {
  const response = await request.post(`${API}/test/login`, { data: { email } });
  expect(response.status(), await response.text()).toBe(201);
}

test.describe('admin shell governance matrix', () => {
  // Cases 2–4 wait up to 60 s for the first admin paint (a cold lazy-chunk compile),
  // which the DEFAULT 30 s test budget made unreachable — case 4 timed out at 30 s
  // under a loaded machine (w53 baseline, 2026-10-17), the same defect case 1 fixed for
  // itself (ADR 0863). Budget every case for the waits it declares; case 1 still sets
  // its own larger per-route budget.
  test.describe.configure({ timeout: 90_000 });
  test('direct admin aliases and detail routes preserve shell wayfinding through browser history', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginPersonal(page.request, 'admin-history@e2e.test');
    expect(await enableToggle(page.request, 'kicktodo-core')).toBe(true);
    const routes = [
      { path: '/keys', current: 1 },
      { path: '/connections', current: 1 },
      { path: '/orgs', current: 1 },
      { path: '/capability-firewall', current: 1 },
      { path: '/model-router', current: 1 },
      // This caller is a workspace owner, not a host superadmin. The hidden
      // parent cannot be current, but the child must retain explicit wayfinding.
      { path: '/operations/webhooks', current: 0, parent: 'Ops Console' },
      { path: '/admin/kicktodo/safety', current: 1 },
      { path: '/runs/e2e-missing/audit', current: 1 },
      { path: '/workforces/e2e-missing/migrate', current: 1 },
      { path: '/cms/p/e2e-org/e2e-page', current: 1 },
    ];
    // The per-route wait below is 60 s, inside the DEFAULT 30 s test budget. That
    // made the per-route allowance unreachable: one cold Vite compile of a lazy
    // admin chunk consumed the whole test. It went red on the ADR 0863 Linux pilot's slower
    // cores (ADR 0863). Budget the test for the waits it declares.
    test.setTimeout(routes.length * 60_000 + 30_000);
    for (const route of routes) {
      await page.goto(route.path);
      await expect(page.locator('.admin-shell')).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('main')).toHaveCount(1);
      // AUTO-RETRYING, deliberately. This was `expect(await locator.count()).toBe(n)`
      // — a ONE-SHOT read taken the instant the shell is visible. The shell paints
      // before the rail resolves which destination is current (the route's lazy
      // chunk + the nav projection land a tick later), so the read raced it and
      // the spec failed on a DIFFERENT route each run: `/admin/kicktodo/safety` in
      // two gate runs, `/workforces/e2e-missing/migrate` in two others, same tree.
      // `toHaveCount` polls until the count settles or times out, which is the
      // assertion the test always meant. For `current: 0` it still proves absence:
      // it must HOLD at zero through the settle window rather than be zero once.
      await expect(page.locator('[aria-current="page"]'), `${route.path} current destination count`).toHaveCount(route.current);
      if (route.parent) await expect(page.getByRole('link', { name: route.parent })).toBeVisible();
    }
    await page.goBack();
    await expect(page).toHaveURL(/\/workforces\/e2e-missing\/migrate$/);
    await expect(page.locator('[aria-current="page"]')).toHaveCount(1);
    await page.goForward();
    await expect(page).toHaveURL(/\/cms\/p\/e2e-org\/e2e-page$/);
    await expect(page.locator('[aria-current="page"]')).toHaveCount(1);
  });

  test('320px reflow preserves one main, named rails, and exactly one current destination', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await loginPersonal(page.request, 'admin-governance@e2e.test');
    await page.goto('/admin');
    await expect(page.locator('.admin-rail-mobile-toggle')).toBeVisible({ timeout: 60_000 });
    // Web-first, like case 1: the shell paints before the rail resolves its current
    // destination, so the one-shot evaluate below must not read it mid-settle.
    await expect(page.locator('[aria-current="page"]')).toHaveCount(1);
    const measurement = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      mains: document.querySelectorAll('main').length,
      navNames: [...document.querySelectorAll('nav')].map((nav) => nav.getAttribute('aria-label')),
      current: document.querySelectorAll('[aria-current="page"]').length,
    }));
    expect(measurement.overflow).toBeLessThanOrEqual(0);
    expect(measurement.mains).toBe(1);
    // Non-vacuous: `every` is true of an EMPTY list, so the admin rail's own nav must be present.
    expect(measurement.navNames).toContain('Admin sections');
    expect(measurement.navNames.every((name) => typeof name === 'string' && name.trim().length > 0)).toBe(true);
    expect(new Set(measurement.navNames).size).toBe(measurement.navNames.length);
    expect(measurement.current).toBe(1);
  });

  test('mobile disclosure is keyboard reachable and closes after navigation', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginPersonal(page.request, 'admin-keyboard@e2e.test');
    await page.goto('/admin');
    const toggle = page.locator('.admin-rail-mobile-toggle');
    await expect(toggle).toBeVisible({ timeout: 60_000 });
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Enter');
    const nav = page.locator('#admin-rail-nav');
    await expect(nav).toBeVisible();
    await nav.getByRole('button', { name: 'Work management' }).click();
    const destination = nav.getByRole('link', { name: /Library/ });
    await destination.focus();
    await expect(destination).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(nav).toBeHidden();
  });

  test('coarse-pointer admin targets meet the 44px effective floor', async ({ browser }) => {
    const context = await browser.newContext({ ...devices['Pixel 5'], baseURL: `http://localhost:${process.env.OPENWOP_E2E_PORT ?? '5173'}` });
    const page = await context.newPage();
    await loginPersonal(page.request, 'admin-coarse@e2e.test');
    await page.goto('/admin');
    const toggle = page.locator('.admin-rail-mobile-toggle');
    await expect(toggle).toBeVisible({ timeout: 60_000 });
    // Compared at 1/100 px, not raw. A Pixel 5 has a 2.75x device-pixel ratio, so a
    // 44 CSS-px box comes back from `boundingBox()` as float arithmetic over device
    // pixels — MEASURED in two consecutive full gate runs: `43.99999237060547`, red
    // against `>= 44`, while the same test passed 3/3 alone (the fraction depends on
    // where the element lands, which depends on what else has painted). The floor
    // is 44 CSS px; eight-millionths of a pixel is the measurement, not the target.
    const px = (h: number | undefined): number => Math.round((h ?? 0) * 100) / 100;
    const box = await toggle.boundingBox();
    expect(px(box?.height)).toBeGreaterThanOrEqual(44);
    await toggle.click();
    const link = page.locator('#admin-rail-nav a').first();
    const linkBox = await link.boundingBox();
    expect(px(linkBox?.height)).toBeGreaterThanOrEqual(44);
    await context.close();
  });
});

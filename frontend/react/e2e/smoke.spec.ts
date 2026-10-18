import { test, expect } from '@playwright/test';
import { API } from './support/session.js';

/**
 * App shell smoke (GAP-ANALYSIS E16). Confirms the SPA boots, the persistent
 * sidebar + main land, the skip-to-content a11y link (E6) is present AND works,
 * and a lazy route chunk (E13) renders without a white screen — the error
 * boundary (E1) would otherwise swallow a crash into a fallback INSIDE `main`.
 *
 * Sabotage-witnessed (wave 53): the sidebar nav's accessible name changed
 * (case 1); the skip link's name broken, or its target moved off `#main-content`
 * (case 2); `/boards`' admin shell throwing on render (case 3 — and every case of
 * its twin, `modal.spec.ts`, which also renders `/boards` as the owner and
 * clicks "+ New board").
 */
test.describe('app shell', () => {
  test('boots the app shell with sidebar + main', async ({ page }) => {
    // ADR 0487 — '/' is the public marketing home; the app shell lives under its
    // own routes ('/dashboard' is the pinned home).
    await page.goto('/dashboard');
    await expect(page.locator('main#main-content')).toBeVisible();
    // The persistent left-rail sidebar nav (labelled "Sections").
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
  });

  test('exposes the skip-to-content link (a11y)', async ({ page }) => {
    await page.goto('/dashboard');
    const link = page.getByRole('link', { name: /skip to content/i });
    await expect(link).toHaveCount(1);
    // A skip link is only a skip link if it points at the main landmark that
    // exists and ACTIVATING it moves keyboard focus there. (This used to assert
    // presence by name only — a link to `#nowhere` passed; wave 53 probe
    // w53g3-smoke-skip-target.) Not "the first Tab reaches it": App.tsx moves
    // focus to <main> on every navigation, initial load included (E6), so a
    // fresh page is already past the link — measured in wave 53, by design.
    const main = page.locator('main#main-content');
    await expect(link).toHaveAttribute('href', '#main-content');
    await expect(main).toHaveCount(1);
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(main).toBeFocused();
  });

  test('navigates to a lazy route without a fatal error', async ({ page }) => {
    // Signed in to the caller's PERSONAL workspace (no tenantId — e2e README
    // trap 1): `/boards` is admin-tier, and an anonymous session renders a deny
    // card instead of the lazy page, so the route under test never loaded.
    const login = await page.request.post(`${API}/test/login`, { data: { email: 'smoke-lazy@e2e.test' } });
    expect(login.status(), `login: ${await login.text()}`).toBe(201);
    await page.goto('/boards');
    // POSITIVE signal first: the lazy page itself rendered its own control. The
    // old version asserted the error copy ABSENT immediately after `goto`, which
    // passed on the first poll before anything rendered, and `main` is visible
    // even when the boundary's fallback renders inside it (wave 53 probe
    // w53g3-smoke-adminlayout-crash: vacuous). Twin: every `modal.spec.ts` case.
    const main = page.locator('main#main-content');
    await expect(main.getByRole('button', { name: '+ New board' }).first()).toBeVisible({ timeout: 30_000 });
    // Only now is "no fallback" meaningful.
    await expect(main.getByText('Something went wrong')).toHaveCount(0);
  });
});

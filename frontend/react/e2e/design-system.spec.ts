import { test, expect, devices, type Page } from '@playwright/test';
import { API } from './support/session.js';
import { serveFontsLocally } from './support/localFonts.js';

/**
 * Visual-contract snapshots (ADR 0510 Phase 2, DSA-031) — the gallery at
 * /design-system renders every shared primitive from FIXED specimen data, so
 * these baselines are deterministic by construction and BLOCK the merge gate.
 *
 * Determinism contract:
 *  - fonts: wait for `document.fonts.ready` AND assert the webfonts actually
 *    loaded — a fallback-font render must fail loudly, never rebaseline.
 *  - motion: `reducedMotion: 'reduce'` + `animations: 'disabled'` + no caret.
 *  - data: the gallery fetches nothing; sections carry fixture rows only.
 *  - baselines are platform-suffixed (darwin — `npm run ci` is the local merge
 *    gate; a hosted-CI revival re-baselines on its own platform).
 *
 * Whole-page captures (the preference matrix + width tests) shoot the
 * GALLERY ROOT ([data-walkthrough="design-system.page"]), never
 * main#main-content — main wraps the admin rail, whose resolved-nav rows are
 * BACKEND state and differ between a warm dev backend and CI's fresh boot.
 * They carry maxDiffPixelRatio 0.001 for tall-column sub-pixel variance;
 * 0.1% still fails any real visual change.
 *
 * Critical-ROUTE snapshots live in route-snapshots.spec.ts behind
 * OPENWOP_E2E_ROUTES=1 (ci:full) until their masks prove stable — the ADR 0509
 * rule: only promote what is already green and deterministic.
 */

const SECTIONS = [
  'typography', 'buttons', 'chips', 'notices', 'states', 'inline-states',
  'fields', 'table', 'figures', 'identity', 'tabs', 'admin-shell', 'toasts',
] as const;

async function login(page: Page): Promise<void> {
  const res = await page.request.post(`${API}/test/login`, { data: { email: 'design-system@e2e.test' } });
  expect(res.status(), await res.text()).toBe(201);
}

async function openGallery(page: Page): Promise<void> {
  // ROOT CAUSE FIX (2026-08-14) — the fonts are fulfilled from vendored
  // copies, so this gate no longer depends on the Google Fonts CDN. See
  // support/localFonts.ts for the six-occurrence history.
  await serveFontsLocally(page);
  await page.goto('/design-system');
  await expect(page.locator('[data-gallery="tabs"]')).toBeVisible({ timeout: 60_000 });
  // Fonts must be the real webfonts — a fallback render is a loud failure.
  // `fonts.load()` STARTS and AWAITS each family (fonts.ready alone can
  // resolve before a lazily-started face begins loading — Geist Mono lost
  // that race under cold-boot suite load and repainted mid-matrix).
  // With fonts served locally (above), a load failure can only be OUR
  // harness or CSS — strict single attempt, loud failure. The retry/skip
  // scaffolding that grew here (retry-once → 3× reload → skip-loudly) was
  // treating the symptom; vendoring removed the network from the equation.
  const loaded = await page.evaluate(async () => {
    const families = ['14px "Geist"', '14px "Geist Mono"', '14px "Instrument Serif"'];
    await Promise.all(families.map((f) => document.fonts.load(f)));
    await document.fonts.ready;
    return families.every((f) => document.fonts.check(f));
  });
  expect(loaded, 'webfonts did not load — snapshot would capture fallback fonts').toBe(true);
  // The screenshots target the fixture-only gallery root. Fixed shell chrome is
  // outside that contract, but Chromium composites fixed elements into tall
  // element screenshots while stitching; hide it just as the old top launcher
  // was absent from these baselines.
  await page.addStyleTag({ content: '* { caret-color: transparent !important; } .app-mobile-nav { display: none !important; }' });
}

function setPref(page: Page, attr: string, value: string | null): Promise<void> {
  return page.evaluate(([a, v]) => {
    if (v === null) document.documentElement.removeAttribute(a as string);
    else document.documentElement.setAttribute(a as string, v as string);
  }, [attr, value]);
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((t) => {
    document.documentElement.classList.remove('theme-light', 'theme-dark');
    document.documentElement.classList.add(`theme-${t}`);
  }, theme);
}

test.use({ viewport: { width: 1280, height: 900 } });

test.describe('design-system gallery — visual contract', () => {
  test.describe.configure({ timeout: 120_000 });
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await login(page);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`sections @${theme}`, async ({ page }) => {
      await openGallery(page);
      await setTheme(page, theme);
      for (const section of SECTIONS) {
        await expect(page.locator(`[data-gallery="${section}"]`)).toHaveScreenshot(
          `gallery-${section}-${theme}.png`,
          { animations: 'disabled' },
        );
      }
    });
  }

  test('preference matrix @light', async ({ page }) => {
    await openGallery(page);
    await setTheme(page, 'light');
    // The GALLERY ROOT, not main#main-content: main wraps the admin rail,
    // whose resolved-nav rows are backend state — a warm vs fresh backend
    // rendered different rows and produced a deterministic cross-environment
    // diff. Fixture-only content is the determinism contract.
    const main = page.locator('[data-walkthrough="design-system.page"]');

    await setPref(page, 'data-contrast', 'more');
    await expect(main).toHaveScreenshot('gallery-contrast-more.png', { animations: 'disabled', maxDiffPixelRatio: 0.001 });
    await setPref(page, 'data-contrast', null);

    await setPref(page, 'data-density', 'compact');
    await expect(main).toHaveScreenshot('gallery-density-compact.png', { animations: 'disabled', maxDiffPixelRatio: 0.001 });
    await setPref(page, 'data-density', null);

    await page.evaluate(() => {
      document.documentElement.setAttribute('data-font-scale', '125');
      document.documentElement.style.setProperty('--font-scale', '1.25');
    });
    await expect(main).toHaveScreenshot('gallery-font-125.png', { animations: 'disabled', maxDiffPixelRatio: 0.001 });
    await page.evaluate(() => {
      document.documentElement.removeAttribute('data-font-scale');
      document.documentElement.style.removeProperty('--font-scale');
    });
  });

  test('focus ring — default and bold', async ({ page }) => {
    await openGallery(page);
    await setTheme(page, 'light');
    const firstButton = page.locator('[data-gallery="buttons"] button').first();
    // :focus-visible requires keyboard focus — Tab to it deterministically.
    await firstButton.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-gallery="buttons"]')).toHaveScreenshot('gallery-focus-default.png', { animations: 'disabled' });
    await setPref(page, 'data-focus-style', 'bold');
    await expect(page.locator('[data-gallery="buttons"]')).toHaveScreenshot('gallery-focus-bold.png', { animations: 'disabled' });
  });

  /* The SELECTED tab's indicator, resting AND focused.
   *
   * Why this exists: the `sections` shots capture the tab bar at rest only, and
   * nothing captured it FOCUSED — so when `.tab` inherited `border-radius` from
   * the global `button` rule, the selected underline curved up at both ends into
   * a bracket and NO baseline moved. It shipped, was reported from a screenshot,
   * and `--update-snapshots` then reported green while changing nothing, because
   * the state was simply never rendered. (Fixed 2026-08-08; `.tab` is square and
   * `:focus-visible` rounds only the TOP corners so focus cannot reintroduce the
   * curve.) Both states are now in the visual contract. */
  test('selected tab — resting and focused', async ({ page }) => {
    await openGallery(page);
    await setTheme(page, 'light');
    const tabs = page.locator('[data-gallery="tabs"]');
    await expect(tabs).toHaveScreenshot('gallery-tab-selected.png', { animations: 'disabled' });

    // :focus-visible needs KEYBOARD focus — the same Shift+Tab/Tab round-trip
    // the focus-ring test uses. A bare .focus() does not set it in Chromium.
    const selected = page.locator('[data-gallery="tabs"] .tab[aria-selected="true"]');
    await selected.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(tabs).toHaveScreenshot('gallery-tab-focused.png', { animations: 'disabled' });
  });

  for (const width of [360, 768] as const) {
    test(`narrow layout @${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openGallery(page);
      await setTheme(page, 'light');
      await expect(page.locator('[data-walkthrough="design-system.page"]')).toHaveScreenshot(`gallery-width-${width}.png`, { animations: 'disabled', maxDiffPixelRatio: 0.001 });
    });
  }
});

/**
 * ADR 0510 Phase 9 — expanded matrix: coarse-pointer effective hit areas
 * (DSA-023, the Phase-4 deferred measurement) and forced-colors rendering.
 */
test.describe('design-system — coarse pointer + forced colors', () => {
  test.describe.configure({ timeout: 120_000 });

  test('coarse pointer: isolated icon targets expand to --hit-target', async ({ browser }) => {
    // A mobile device descriptor makes Chromium report (pointer: coarse).
    const context = await browser.newContext({
      ...devices['Pixel 5'],
      baseURL: `http://localhost:${process.env.OPENWOP_E2E_PORT ?? '5173'}`,
    });
    const page = await context.newPage();
    const res = await page.request.post(`${API}/test/login`, { data: { email: 'coarse@e2e.test' } });
    expect(res.status()).toBe(201);
    await page.goto('/design-system');
    await expect(page.locator('[data-gallery="buttons"]')).toBeVisible({ timeout: 60_000 });
    const m = await page.evaluate(() => {
      const el = document.querySelector('[data-gallery="buttons"] .icon-button');
      if (!el) return null;
      const after = getComputedStyle(el, '::after');
      return { coarse: matchMedia('(pointer: coarse)').matches, w: parseFloat(after.width), h: parseFloat(after.height) };
    });
    expect(m, 'icon-button specimen missing').not.toBeNull();
    expect(m!.coarse, 'device emulation must report a coarse pointer').toBe(true);
    expect(m!.w, `effective width ${m!.w}px < 44px`).toBeGreaterThanOrEqual(44);
    expect(m!.h, `effective height ${m!.h}px < 44px`).toBeGreaterThanOrEqual(44);
    await context.close();
  });

  test('forced colors: gallery controls stay visible and labeled', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    const res = await page.request.post(`${API}/test/login`, { data: { email: 'forced@e2e.test' } });
    expect(res.status()).toBe(201);
    await page.goto('/design-system');
    await expect(page.locator('[data-gallery="buttons"]')).toBeVisible({ timeout: 60_000 });
    // Every button in the specimen row still hit-tests and carries a name —
    // forced colors must never render an invisible or nameless control.
    const buttons = page.locator('[data-gallery="buttons"] button');
    const n = await buttons.count();
    expect(n).toBeGreaterThan(4);
    for (let i = 0; i < n; i++) {
      await expect(buttons.nth(i)).toBeVisible();
      expect((await buttons.nth(i).textContent())?.trim() || (await buttons.nth(i).getAttribute('aria-label'))).toBeTruthy();
    }
  });
});

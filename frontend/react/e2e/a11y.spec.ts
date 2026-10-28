import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { expiredExceptions, isExcepted } from './support/axeExceptions.js';
import { serveFontsLocally } from './support/localFonts.js';

/**
 * Live accessibility audit (GAP-ANALYSIS — live-app pass). Runs axe-core
 * against the app shell + key routes in BOTH themes. Routes that need a
 * backend render their error/empty states (still fully auditable for the
 * shell, nav, headers, notices, and any rendered controls). EVERY in-scope
 * violation fails the suite (ADR 0510 Phase 2, DSA-021); the only ship path is an
 * owned, EXPIRING row in support/axeExceptions.ts, and an expired row fails every
 * case. Scope is axe's `wcag2a` + `wcag2aa` tags — WCAG 2.0 A/AA; the 2.1/2.2-only
 * rules (e.g. target-size) are NOT audited here (admin-governance.spec.ts carries
 * the 44px floor for the admin rail).
 *
 * Breaks it (w53 probes, all witnessed): a dark-only muted-text token below AA
 * (`--ink-3` in `:root.theme-dark`) reds every `(dark)` case; `aria-hidden` on the
 * app shell's <main> (focusable content hidden from AT) reds every app-shell route;
 * an expired exception row reds every case.
 */

const ROUTES = [
  '/', '/chat', '/runs', '/boards', '/agents', '/orgs', '/keys', '/prompts',
  '/builder', '/inbox', '/runs?tab=active', '/memory', '/roster', '/capabilities', '/cli', '/demo-data',
  // ADR 0510 Phase 2 — the design-system gallery: axe over the full primitive
  // matrix catches a defect in a shared component once, at its source.
  '/design-system',
];

for (const theme of ['light', 'dark'] as const) {
  for (const route of ROUTES) {
    test(`a11y: ${route} (${theme})`, async ({ page }) => {
      // Audit the SETTLED state: the page-enter animation ramps opacity 0→1,
      // and axe measures real pixels — capturing mid-animation blends fg/bg and
      // reports false contrast failures. The app honors prefers-reduced-motion,
      // so reduced-motion disables the animation and axe sees true colors.
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
      // Use the same saved preference as the first-paint script and
      // ThemeToggle. Changing the class after navigation races a later shell
      // mount, whose effect would reapply its independently read preference.
      await page.addInitScript((value) => {
        localStorage.setItem('openwop.theme', value);
      }, theme);
      // Audit the faces users get, not the fallback stack: the config fails the
      // Google Fonts hosts fast (E2E-ORDER-1), so serve the vendored copies.
      await serveFontsLocally(page);
      await page.goto(route);
      // EITHER main, because the app has two shells. `/` is the PUBLIC root
      // (ADR 0487 split public root from `/dashboard`), so it renders
      // `PublicShell`'s `main#public-main`, not the app shell's
      // `main#main-content`. Waiting only for the app shell meant `/` timed out
      // at 30s in BOTH themes and was never audited at all — the route most
      // likely to be a stranger's first impression was the one route with no
      // a11y coverage, and the timeout read as "flaky lane" rather than "this
      // assertion is stale".
      await page.waitForSelector('main#main-content, main#public-main');
      const expectedTheme = new RegExp(`(?:^|\\s)theme-${theme}(?:\\s|$)`);
      await expect(page.locator('html')).toHaveClass(expectedTheme);
      // Let data fetches + AutoSeedDemoData re-renders settle before axe —
      // capturing mid-fetch/mid-seed measures a transient render and reports
      // false contrast failures (e.g. a board column briefly on default colors).
      // NOTE: not networkidle — the live backend's SSE/polling never goes idle.
      // Web-first settle signals instead of a fixed 1.2 s sleep (w53): the app's
      // loading regions mark themselves `aria-busy` (StateCard loading, AdminLayout,
      // ~150 sites), so none may remain; and fonts must be loaded before axe
      // measures text colour against layout. (A loading region WITHOUT aria-busy
      // is not waited for — that is the residual this signal cannot see.)
      // `/design-system` renders loading STATES as specimens inside its
      // `[data-gallery]` sections — permanently busy by design, so excluded.
      await expect(page.locator('[aria-busy="true"]:not([data-gallery] *)')).toHaveCount(0, { timeout: 15_000 });
      await page.evaluate(async () => { await document.fonts.ready; });
      await expect(page.locator('html')).toHaveClass(expectedTheme);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();
      await expect(page.locator('html')).toHaveClass(expectedTheme);
      // The accent/semantic palette is now AA-compliant via --clay-text /
      // --clay-strong / --color-ai-text (the prior mid-tone baseline is gone).
      // Only skip axe "can't-determine" contrast nodes (e.g. gradient fills),
      // which aren't actionable.
      const isUnmeasurable = (n: { any?: Array<{ data?: unknown }> }): boolean => {
        const d = n.any?.[0]?.data as { fgColor?: string; bgColor?: string } | undefined;
        return !d || (d.fgColor === undefined && d.bgColor === undefined);
      };
      // ADR 0510 Phase 2 (DSA-021): EVERY in-scope WCAG A/AA violation fails,
      // not just serious/critical — moderate hits are real A/AA failures. The
      // only ship path is a narrow, owned, EXPIRING row in axeExceptions.ts.
      const now = new Date();
      const expired = expiredExceptions(now);
      expect(expired, `EXPIRED axe exceptions — fix the violation or renew with a reason:\n${expired.map((e) => `${e.rule} @ ${e.route} (${e.owner}, expired ${e.expires})`).join('\n')}`).toEqual([]);
      const serious = results.violations
        .map((v) => (v.id === 'color-contrast' ? { ...v, nodes: v.nodes.filter((n) => !isUnmeasurable(n)) } : v))
        .map((v) => ({ ...v, nodes: v.nodes.filter((n) => !isExcepted(route, v.id, n.target?.join(' ') ?? '', now)) }))
        .filter((v) => v.nodes.length > 0);
      if (serious.length) {
        console.log(`\n[a11y ${route} ${theme}] ${serious.length} WCAG A/AA violation(s):`);
        for (const v of serious) {
          console.log(`  - ${v.id} (${v.impact}) ×${v.nodes.length}: ${v.help}`);
          for (const n of v.nodes.slice(0, 8)) {
            const d = n.any?.[0]?.data as { fgColor?: string; bgColor?: string; contrastRatio?: number; expectedContrastRatio?: string } | undefined;
            const detail = d ? `fg=${d.fgColor} bg=${d.bgColor} ratio=${d.contrastRatio} need=${d.expectedContrastRatio}` : '';
            console.log(`      · ${n.target?.join(' ')}  ${detail}`);
          }
        }
      }
      expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([]);
    });
  }
}

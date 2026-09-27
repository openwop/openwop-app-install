import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { expiredExceptions, isExcepted } from './support/axeExceptions.js';

/**
 * Live accessibility audit (GAP-ANALYSIS — live-app pass). Runs axe-core
 * against the app shell + key routes in BOTH themes. Routes that need a
 * backend render their error/empty states (still fully auditable for the
 * shell, nav, headers, notices, and any rendered controls). Serious/critical
 * violations fail the suite; we fix the app until each route is clean.
 */

const ROUTES = [
  '/', '/chat', '/runs', '/boards', '/agents', '/orgs', '/keys', '/prompts',
  '/builder', '/inbox', '/runs?tab=active', '/memory', '/roster', '/capabilities', '/cli', '/demo-data',
  // ADR 0510 Phase 2 — the design-system gallery: axe over the full primitive
  // matrix catches a defect in a shared component once, at its source.
  '/design-system',
];

async function setTheme(page: import('@playwright/test').Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => {
    document.documentElement.classList.remove('theme-light', 'theme-dark');
    document.documentElement.classList.add(`theme-${t}`);
  }, theme);
}

for (const theme of ['light', 'dark'] as const) {
  for (const route of ROUTES) {
    test(`a11y: ${route} (${theme})`, async ({ page }) => {
      // Audit the SETTLED state: the page-enter animation ramps opacity 0→1,
      // and axe measures real pixels — capturing mid-animation blends fg/bg and
      // reports false contrast failures. The app honors prefers-reduced-motion,
      // so reduced-motion disables the animation and axe sees true colors.
      await page.emulateMedia({ reducedMotion: 'reduce' });
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
      await setTheme(page, theme);
      // Let data fetches + AutoSeedDemoData re-renders settle before axe —
      // capturing mid-fetch/mid-seed measures a transient render and reports
      // false contrast failures (e.g. a board column briefly on default colors).
      // NOTE: not networkidle — the live backend's SSE/polling never goes idle.
      await page.waitForTimeout(1200);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();
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

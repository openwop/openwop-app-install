import { test, expect, type Page } from '@playwright/test';

/**
 * WCAG contrast for token PAIRINGS that no rendered page happens to exercise.
 *
 * WHY THIS EXISTS. `#2742` fixed a real AA failure in `.btn-link` (3.99:1) that
 * axe caught on `/keys`. But `builder/ProposalBanner.tsx:107` puts the same
 * primitive inside `div.alert.success` / `.alert.warning` — TINTED surfaces, not
 * paper — and **no e2e spec renders that banner**, so axe never measured it. It
 * was filed as a human-verify item (`CT-BTNLINK-1`) on the grounds that only a
 * person could check it.
 *
 * That was wrong. A browser can measure it exactly: mount the real class pair,
 * read `getComputedStyle`, and compute the ratio. This is the same move as
 * converting the other human-verify items — the honest question is only whether
 * the machine can decide it, and here it can.
 *
 * WHAT THIS MEASURES, PRECISELY. The TOKEN PAIRING as the stylesheet resolves it
 * in a real browser, in both themes — not the composed page. A pairing that
 * passes here can still fail in situ if something adds opacity, a gradient, or a
 * different ancestor background. So this retires "is this token pair legible",
 * not "is every screen legible". Said plainly so a green run is not over-read.
 */

/** WCAG 2.1 AA for normal-size text. */
const AA_NORMAL = 4.5;

/** Pairings that exist in the app but that no spec renders. */
const PAIRINGS = [
  { name: '.btn-link on .alert.success', surface: 'alert success', fg: 'btn-link' },
  { name: '.btn-link on .alert.warning', surface: 'alert warning', fg: 'btn-link' },
  { name: '.btn-link on .alert.error', surface: 'alert error', fg: 'btn-link' },
];

/**
 * Resolve any CSS colour — including `oklch()` and alpha tints — by letting the
 * BROWSER do it: paint onto a canvas and read back sRGB bytes.
 *
 * The first cut of this file parsed `rgb(...)` with a regex. Computed styles come
 * back as `oklch(...)` here, so it read every colour as black and reported
 * 1.00:1 for EVERY pairing — a checker that fails correct code, which is worse
 * than no checker. It also read the tint directly, but `.alert.*` backgrounds are
 * ~10% alpha and must be COMPOSITED over what is behind them.
 */
async function measure(page: Page, surface: string, fg: string): Promise<{ ratio: number; fgCss: string; bgCss: string; identical: boolean }> {
  return page.evaluate(({ surface, fg }) => {
    const cvs = document.createElement('canvas');
    cvs.width = 1; cvs.height = 1;
    const ctx = cvs.getContext('2d', { willReadFrequently: true })!;

    /** Paint `layers` bottom-up onto opaque white; return the resulting sRGB. */
    const composite = (layers: string[]): [number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 1, 1);
      for (const c of layers) { ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); }
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!];
    };
    const lum = (rgb: [number, number, number]): number => {
      const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };

    const host = document.createElement('div');
    host.className = surface;
    const link = document.createElement('a');
    link.className = fg;
    link.textContent = 'measure me';
    host.appendChild(link);
    document.body.appendChild(host);

    const fgCss = getComputedStyle(link).color;
    // Every background from the root down to the tint, so alpha composites.
    const stack: string[] = [];
    for (let el: HTMLElement | null = host; el; el = el.parentElement) {
      const c = getComputedStyle(el).backgroundColor;
      if (c && c !== 'transparent' && !/,\s*0\s*\)$/.test(c)) stack.unshift(c);
    }
    const bgRgb = composite(stack);
    // The link paints ON TOP of that background, so composite it too — an alpha
    // foreground over a tint is a different colour than the token alone.
    const fgRgb = composite([...stack, fgCss]);

    const a = lum(fgRgb); const b = lum(bgRgb);
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return {
      ratio: (hi + 0.05) / (lo + 0.05),
      fgCss,
      bgCss: `rgb(${bgRgb.join(', ')})`,
      // Compared as RESOLVED sRGB, not as strings. The first cut compared the
      // computed `oklch(...)` foreground against an `rgb(...)` background — two
      // formats that can never be equal, so the "did the classes apply?" guard
      // could not fail. A guard that cannot fire is not a guard.
      identical: fgRgb.join() === bgRgb.join(),
    };
  }, { surface, fg });
}

test.describe('token contrast — pairings no page renders', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const p of PAIRINGS) {
      test(`${p.name} @${theme}`, async ({ page }) => {
        await page.goto('/');
        await page.evaluate((t) => {
          document.documentElement.classList.remove('theme-light', 'theme-dark');
          document.documentElement.classList.add(`theme-${t}`);
        }, theme);

        const { ratio, fgCss, bgCss, identical } = await measure(page, p.surface, p.fg);

        // Guard: identical resolved colours mean the classes did not apply, and
        // the ratio below would be measuring nothing.
        expect(identical, `${p.name}: fg and bg resolved identically — the classes did not apply`).toBe(false);

        expect(
          ratio,
          `${p.name} @${theme}: ${ratio.toFixed(2)}:1 (need ${AA_NORMAL}:1) — fg ${fgCss} on bg ${bgCss}. `
            + `Pick a token that clears AA on THIS surface; --clay-text is theme-aware and moves away from the background.`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
      });
    }
  }
});

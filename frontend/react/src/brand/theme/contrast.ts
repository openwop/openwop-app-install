/**
 * Contrast math for the theme generator (ADR 0171 Phase A).
 *
 * - `wcagRatio` is the **shippable gate** (WCAG 2.x: 4.5:1 text / 3:1 UI) — the
 *   legal floor (`DESIGN.md` a11y).
 * - `apcaLc` is **advisory only** (WCAG 3 has no finalized contrast method; APCA
 *   and WCAG 2 disagree in both directions) — surfaced as a readout, never a gate.
 * - `solveOnColorLightness` ports MyndHyve's `deriveDarkMode` idea: bump an OKLCH
 *   color's lightness *away from* a background until it meets a target ratio, with
 *   an explicit `bumpExhausted` signal for the rare seed that can't reach it.
 */
import { oklchToRgb, type Oklch, type Rgb } from './oklch.js';

const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** WCAG 2.x relative luminance from sRGB (0..1). */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/** WCAG 2.x contrast ratio (1..21), order-independent. */
export function wcagRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// ── APCA (W3C 0.1.9), advisory ───────────────────────────────────────────────
const APCA = { trc: 2.4, bClip: 1.414, bThrsh: 0.022, scaleW: 1.14, scaleB: 1.14, loClip: 0.1, loOff: 0.027 };
const apcaY = (rgb: Rgb): number => {
  const y = 0.2126729 * rgb[0] ** APCA.trc + 0.7151522 * rgb[1] ** APCA.trc + 0.072175 * rgb[2] ** APCA.trc;
  return y > APCA.bThrsh ? y : y + (APCA.bThrsh - y) ** APCA.bClip;
};
/** APCA lightness contrast Lc (−108..106). Sign = polarity. Advisory only. */
export function apcaLc(text: Rgb, bg: Rgb): number {
  const yt = apcaY(text), yb = apcaY(bg);
  if (Math.abs(yt - yb) < 0.0005) return 0;
  let lc: number;
  if (yb > yt) { // normal polarity (dark text on light bg)
    lc = (yb ** 0.56 - yt ** 0.57) * APCA.scaleW;
    lc = lc < APCA.loClip ? 0 : lc - APCA.loOff;
  } else { // reverse polarity (light text on dark bg)
    lc = (yb ** 0.65 - yt ** 0.62) * APCA.scaleB;
    lc = lc > -APCA.loClip ? 0 : lc + APCA.loOff;
  }
  return lc * 100;
}

export interface ContrastSolve { color: Oklch; ratio: number; meetsTarget: boolean; bumpExhausted: boolean }

/**
 * Adjust `fg`'s lightness (keeping hue/chroma) until it meets `target` contrast
 * against `bg`, moving AWAY from the background's luminance. Returns the best
 * reachable color; `bumpExhausted` = true if the L bound was hit short of target.
 */
export function solveOnColorLightness(
  fg: Oklch,
  bg: Rgb,
  target = 4.5,
  opts: { min?: number; max?: number; step?: number } = {},
): ContrastSolve {
  const min = opts.min ?? 0.04, max = opts.max ?? 0.99, step = opts.step ?? 0.01;
  const ratioAt = (L: number): number => wcagRatio(oklchToRgb({ ...fg, L }), bg);
  if (ratioAt(fg.L) >= target) return { color: fg, ratio: ratioAt(fg.L), meetsTarget: true, bumpExhausted: false };
  // Move away from the bg: if the bg is light, darken; else lighten.
  const bgLum = relativeLuminance(bg);
  const dir = bgLum > 0.18 ? -1 : 1; // perceptual-mid threshold
  let best = fg.L, bestRatio = ratioAt(fg.L);
  for (let L = fg.L; L >= min && L <= max; L += dir * step) {
    const r = ratioAt(L);
    if (r > bestRatio) { bestRatio = r; best = L; }
    if (r >= target) return { color: { ...fg, L }, ratio: r, meetsTarget: true, bumpExhausted: false };
  }
  // Bound hit without reaching target — return the max-contrast L we found.
  return { color: { ...fg, L: best }, ratio: bestRatio, meetsTarget: false, bumpExhausted: true };
}

/** Convenience: does a pair meet WCAG AA for normal text (4.5) / large+UI (3.0)? */
export function meetsAA(fg: Rgb, bg: Rgb, large = false): boolean {
  return wcagRatio(fg, bg) >= (large ? 3 : 4.5);
}

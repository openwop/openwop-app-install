/**
 * Minimal, dependency-free OKLCH ↔ sRGB color math for the theme generator
 * (ADR 0171 Phase A). We hand-roll this rather than add a runtime dep: the app
 * already commits to OKLCH, the conversions are standard (Björn Ottosson's OKLab
 * matrices + the sRGB transfer function), and the Appearance module is lazy-chunked
 * so there's no entry-bundle cost — but a color library would still add weight for
 * ~90 lines of well-tested math.
 *
 * Conventions: sRGB channels are 0..1; OKLCH is { L: 0..1, C: ≥0, H: degrees }.
 */

export interface Oklch { L: number; C: number; H: number }
export type Rgb = readonly [number, number, number]; // sRGB, 0..1

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// ── sRGB transfer function ───────────────────────────────────────────────────
const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

// ── hex ↔ sRGB ───────────────────────────────────────────────────────────────
export function hexToRgb(hex: string): Rgb | null {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((d) => d + d).join('');
  if (h.length === 8) h = h.slice(0, 6); // drop alpha for color math
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

export function rgbToHex(rgb: Rgb): string {
  const to = (c: number): string => Math.round(clamp01(c) * 255).toString(16).padStart(2, '0');
  return `#${to(rgb[0])}${to(rgb[1])}${to(rgb[2])}`;
}

// ── sRGB ↔ OKLab/OKLCH (Ottosson) ────────────────────────────────────────────
export function srgbToOklch(rgb: Rgb): Oklch {
  const r = srgbToLinear(rgb[0]), g = srgbToLinear(rgb[1]), b = srgbToLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(a, bb);
  let H = (Math.atan2(bb, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H };
}

export function oklchToRgb({ L, C, H }: Oklch): Rgb {
  const hr = (H * Math.PI) / 180;
  const a = C * Math.cos(hr), b = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [clamp01(linearToSrgb(r)), clamp01(linearToSrgb(g)), clamp01(linearToSrgb(bl))];
}

// ── parse any supported CSS color string → sRGB ──────────────────────────────
/** Parse `#hex`, `rgb()/rgba()`, or `oklch()` (incl. the stock literal form) to
 *  sRGB. Returns null on an unrecognized/relative form (caller falls back). */
export function parseColorToRgb(css: string): Rgb | null {
  const v = css.trim();
  if (v.startsWith('#')) return hexToRgb(v);
  const oklch = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/i.exec(v);
  if (oklch) {
    const L = oklch[2] === '%' ? Number(oklch[1]) / 100 : Number(oklch[1]);
    return oklchToRgb({ L, C: Number(oklch[3]), H: Number(oklch[4]) });
  }
  const rgb = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(v);
  if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
  return null;
}

/** Parse any supported CSS color to OKLCH (null if unparseable). */
export function parseColorToOklch(css: string): Oklch | null {
  const rgb = parseColorToRgb(css);
  return rgb ? srgbToOklch(rgb) : null;
}

/** Round to `dp` decimals as a plain string with no trailing zeros. CSS color
 *  syntax is locale-INSENSITIVE (always a `.` decimal), so this deliberately does
 *  NOT route through the i18n number formatter — a locale-formatted "0,13" would
 *  corrupt the CSS value. (Hence the bare arithmetic, not `toLocaleString`.) */
export function numStr(x: number, dp: number): string {
  const f = 10 ** dp;
  return (Math.round(x * f) / f).toString();
}

/** Format OKLCH as the app's canonical `oklch(L% C H)` token string. */
export function formatOklch({ L, C, H }: Oklch, alpha?: number): string {
  const l = `${numStr(clamp01(L) * 100, 2)}%`;
  const c = numStr(C, 4);
  const h = numStr(H, 2);
  return alpha != null && alpha < 1 ? `oklch(${l} ${c} ${h} / ${alpha})` : `oklch(${l} ${c} ${h})`;
}

/** Is an OKLCH color inside the sRGB gamut (round-trips without clamping)? */
export function inSrgbGamut({ L, C, H }: Oklch, eps = 0.002): boolean {
  const back = srgbToOklch(oklchToRgb({ L, C, H }));
  return Math.abs(back.L - L) < eps && Math.abs(back.C - C) < eps + 0.01;
}

/**
 * ADR 0363 P4 — per-user accessibility preferences that LAYER OVER the OS media
 * queries (`prefers-reduced-motion` / `prefers-contrast`). Mirrors `ThemeToggle`:
 * persisted in localStorage, applied as `data-*` attributes on
 * `document.documentElement`, pre-painted by an inline script in index.html (no
 * flash). The CSS honors OS-pref OR the user override (see global.css mirror rules).
 */

export type ReduceMotionPref = 'system' | 'reduce';
export type ContrastPref = 'system' | 'more';
/** ADR 0396 P2 — font-size multiplier ('system' = 1.0; values are percent). */
export type FontScalePref = 'system' | '110' | '125' | '140';
/** ADR 0396 P2 — focus-indicator style ('bold' = thicker, high-vis ring). */
export type FocusStylePref = 'system' | 'bold';
/** ADR 0396 P2 — layout density (General panel; 'compact' tightens spacing). */
export type DensityPref = 'comfortable' | 'compact';

const MOTION_KEY = 'openwop.reduceMotion';
const CONTRAST_KEY = 'openwop.contrast';
const FONT_SCALE_KEY = 'openwop.fontScale';
const FOCUS_STYLE_KEY = 'openwop.focusStyle';
const DENSITY_KEY = 'openwop.density';

export function applyA11yPrefs(motion: ReduceMotionPref, contrast: ContrastPref): void {
  const el = document.documentElement;
  // Only stamp an attribute for an explicit override; 'system' removes it so the
  // OS @media query is the sole signal.
  if (motion === 'system') el.removeAttribute('data-reduce-motion');
  else el.setAttribute('data-reduce-motion', motion);
  if (contrast === 'system') el.removeAttribute('data-contrast');
  else el.setAttribute('data-contrast', contrast);
}

/** ADR 0396 P2 — the depth prefs, same attribute pattern (additive `data-*` +
 *  a root var; 'system'/default removes the override entirely). */
export function applyA11yDepthPrefs(fontScale: FontScalePref, focusStyle: FocusStylePref, density: DensityPref): void {
  const el = document.documentElement;
  if (fontScale === 'system') {
    el.removeAttribute('data-font-scale');
    el.style.removeProperty('--font-scale');
  } else {
    el.setAttribute('data-font-scale', fontScale);
    el.style.setProperty('--font-scale', String(Number(fontScale) / 100));
  }
  if (focusStyle === 'system') el.removeAttribute('data-focus-style');
  else el.setAttribute('data-focus-style', focusStyle);
  if (density === 'comfortable') el.removeAttribute('data-density');
  else el.setAttribute('data-density', density);
}

export function readFontScale(): FontScalePref {
  try {
    const v = localStorage.getItem(FONT_SCALE_KEY);
    if (v === '110' || v === '125' || v === '140' || v === 'system') return v;
  } catch { /* ignore */ }
  return 'system';
}
export function readFocusStyle(): FocusStylePref {
  try {
    const v = localStorage.getItem(FOCUS_STYLE_KEY);
    if (v === 'bold' || v === 'system') return v;
  } catch { /* ignore */ }
  return 'system';
}
export function readDensity(): DensityPref {
  try {
    const v = localStorage.getItem(DENSITY_KEY);
    if (v === 'compact' || v === 'comfortable') return v;
  } catch { /* ignore */ }
  return 'comfortable';
}
export function writeFontScale(v: FontScalePref): void {
  try { localStorage.setItem(FONT_SCALE_KEY, v); } catch { /* ignore */ }
}
export function writeFocusStyle(v: FocusStylePref): void {
  try { localStorage.setItem(FOCUS_STYLE_KEY, v); } catch { /* ignore */ }
}
export function writeDensity(v: DensityPref): void {
  try { localStorage.setItem(DENSITY_KEY, v); } catch { /* ignore */ }
}

export function readReduceMotion(): ReduceMotionPref {
  try {
    const v = localStorage.getItem(MOTION_KEY);
    if (v === 'reduce' || v === 'system') return v;
  } catch { /* ignore */ }
  return 'system';
}

export function readContrast(): ContrastPref {
  try {
    const v = localStorage.getItem(CONTRAST_KEY);
    if (v === 'more' || v === 'system') return v;
  } catch { /* ignore */ }
  return 'system';
}

export function writeReduceMotion(v: ReduceMotionPref): void {
  try { localStorage.setItem(MOTION_KEY, v); } catch { /* ignore */ }
}
export function writeContrast(v: ContrastPref): void {
  try { localStorage.setItem(CONTRAST_KEY, v); } catch { /* ignore */ }
}

/**
 * Runtime brand application (ADR 0170 Phase 5). Applies the app identity returned
 * by `GET /host/openwop-app/public-brand` to the live DOM — `:root` CSS tokens
 * (colors + typography), document title, favicon, and the fonts `<link>` — and
 * merges it onto the build-time `brand` singleton so React consumers reflect a
 * super-admin override.
 *
 * Values are ALREADY server-sanitized (the `/public-brand` route → brandService
 * `sanitizeIdentity`: colors/fonts pass a strict CSS grammar, asset URLs reject
 * dangerous schemes), so injection here is safe; `setProperty` is CSSOM-escaped
 * regardless. The build-time identity (stamped into index.html + the `brand`
 * singleton from `VITE_BRAND_*`) is the first-paint fallback when no override exists.
 */
import { brand } from './brand.js';
import type { ThemeInputs } from './theme/generate.js';

/**
 * The identity subset `/public-brand` returns — mirrors the backend `BrandIdentity`.
 *
 * ── MIRROR CONTRACT (ADR 0170) ──────────────────────────────────────────────
 * The brand identity SHAPE + the color→token mapping are hand-mirrored across the
 * FE/BE package boundary (no shared type is possible — same as the SDK). When you
 * add or rename a brandable FIELD or COLOR, update ALL of:
 *   1. backend `features/brand/types.ts` → `BrandIdentity` (+ `BRAND_COLOR_KEYS`) + `brandService.sanitizeIdentity`
 *   2. this `PublicBrandIdentity`
 *   3. `COLOR_TOKEN` below (color → `:root` token)  AND  the inline pre-paint map in `index.html`
 *   4. the clay ramp in `styles/global.css`  AND  `CLAY_RAMP_DERIVATIONS` in `defaults.ts` (preview)
 *   5. `hydrateBrandSingleton` below + the `BrandConfig` singleton + the Appearance editor
 *   6. (ADR 0171) the `theme` INPUTS mirror the backend `BrandTheme` AND the generator's
 *      `ThemeInputs` (theme/generate.ts); the override map keys ⊆ backend `THEMEABLE_TOKENS`
 * ────────────────────────────────────────────────────────────────────────────
 */
export interface PublicBrandIdentity {
  productName?: string;
  wordmark?: { pre: string; emphasis: string; sub: string };
  tagline?: string;
  footerText?: string;
  instanceName?: string;
  assistantName?: string;
  documentTitle?: string;
  logo?: { markSrc?: string; lockupSrc?: string; faviconSrc?: string; markSrcDark?: string; lockupSrcDark?: string };
  colors?: Partial<Record<'accent' | 'paper' | 'paper2' | 'ink' | 'ink2' | 'rule' | 'themeColor', string>>;
  typography?: { serif?: string; sans?: string; mono?: string; fontsHref?: string };
  /** Theme: mode + generative inputs + advanced override (ADR 0171). Mirrors the
   *  backend `BrandTheme` and the generator's `ThemeInputs` (theme/generate.ts). */
  theme?: {
    defaultMode?: 'system' | 'light' | 'dark';
    accentSeed?: string;
    neutralSeed?: string;
    secondarySeed?: string;
    contrastLevel?: 'standard' | 'medium' | 'high';
    radius?: 'sm' | 'md' | 'lg';
    density?: 'compact' | 'comfortable';
    override?: { light?: Record<string, string>; dark?: Record<string, string> };
  };
  domains?: { primaryDomain?: string; homeUrl?: string; repoUrl?: string };
  chromePolicy?: { showPoweredBy?: boolean; customFooter?: string; customCopyright?: string };
}

/** Contrast-bearing tokens are GENERATOR-OWNED (ADR 0510 §5): the ADR 0171
 *  generator solves their WCAG-AA relationships, so an advanced override may not
 *  set them. MIRROR: backend `features/brand/types.ts` `GENERATOR_OWNED_TOKENS`
 *  must stay byte-identical — the backend silently drops these on save, so the
 *  editor must reject them VISIBLY here or the preview lies about what persists. */
export const GENERATOR_OWNED_TOKENS: ReadonlySet<string> = new Set([
  '--clay', '--clay-soft', '--clay-text', '--clay-strong', '--clay-rule', '--clay-wash', '--clay-glow', '--clay-bg-hi',
  '--paper', '--paper-2', '--rule', '--rule-2', '--ink', '--ink-2', '--ink-3', '--star-glow',
  '--color-success', '--color-warning', '--color-danger', '--color-ai', '--color-info',
  '--color-success-text', '--color-warning-text', '--color-danger-text', '--color-ai-text', '--color-info-text',
]);

/** Split a per-mode override map into the entries the server will keep vs the
 *  generator-owned keys it will drop (ADR 0510 §5). Used by the Appearance editor
 *  to keep the preview honest and to name rejected keys in a visible notice. */
export function splitGeneratorOwnedOverride(
  override: { light?: Record<string, string>; dark?: Record<string, string> } | undefined,
): { kept: { light?: Record<string, string>; dark?: Record<string, string> } | undefined; dropped: string[] } {
  if (!override) return { kept: undefined, dropped: [] };
  const dropped = new Set<string>();
  const filterMode = (map: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (!map) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
      if (GENERATOR_OWNED_TOKENS.has(k)) dropped.add(k);
      else out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const light = filterMode(override.light);
  const dark = filterMode(override.dark);
  const kept = light || dark ? { ...(light ? { light } : {}), ...(dark ? { dark } : {}) } : undefined;
  return { kept, dropped: [...dropped].sort() };
}

/** localStorage key the inline pre-paint script + the provider share. */
export const BRAND_CACHE_KEY = 'openwop.brand';

/** Brandable color key → the `:root` design token it drives (ADR 0170 token
 *  contract). `accent` → `--clay` recolors the whole derived ramp (Phase 2a).
 *  MIRROR: keep in sync with the inline pre-paint map in `index.html` (see the
 *  mirror contract on `PublicBrandIdentity`). */
const COLOR_TOKEN: Record<string, string> = {
  accent: '--clay',
  paper: '--paper',
  paper2: '--paper-2',
  ink: '--ink',
  ink2: '--ink-2',
  rule: '--rule',
};

function setMeta(name: string, content: string): void {
  let m = document.querySelector(`meta[name="${name}"]`);
  if (!m) {
    m = document.createElement('meta');
    m.setAttribute('name', name);
    document.head.appendChild(m);
  }
  m.setAttribute('content', content);
}

function setLink(selector: string, build: () => HTMLLinkElement, href: string): void {
  let l = document.querySelector(selector) as HTMLLinkElement | null;
  if (!l) {
    l = build();
    document.head.appendChild(l);
  }
  l.href = href;
}

/** Apply an identity to the live DOM. Idempotent; safe in jsdom + browser. */
export function applyBrandIdentity(identity: PublicBrandIdentity): void {
  const root = document.documentElement;
  if (identity.colors) {
    for (const [key, token] of Object.entries(COLOR_TOKEN)) {
      const v = identity.colors[key as keyof NonNullable<PublicBrandIdentity['colors']>];
      if (v) root.style.setProperty(token, v);
    }
    if (identity.colors.themeColor) setMeta('theme-color', identity.colors.themeColor);
  }
  if (identity.typography) {
    const t = identity.typography;
    if (t.serif) root.style.setProperty('--serif', t.serif);
    if (t.sans) root.style.setProperty('--sans', t.sans);
    if (t.mono) root.style.setProperty('--mono', t.mono);
    if (t.fontsHref) {
      setLink('link[data-brand-fonts]', () => {
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.setAttribute('data-brand-fonts', '');
        return l;
      }, t.fontsHref);
    }
  }
  const title = identity.documentTitle || identity.productName;
  if (title) document.title = title;
  if (identity.logo?.faviconSrc) {
    setLink('link[rel="icon"]', () => {
      const l = document.createElement('link');
      l.rel = 'icon';
      return l;
    }, identity.logo.faviconSrc);
    // Drop the build-time `type="image/svg+xml"` — an override may be PNG/ICO; let
    // the browser sniff rather than mislabel it.
    document.querySelector('link[rel="icon"]')?.removeAttribute('type');
  }
}

/** localStorage key for the GENERATED token maps (light/dark). The pre-paint script
 *  applies these directly so it never needs the generator inline (no FOUC). */
export const TOKEN_CACHE_KEY = 'openwop.brand.tokens';
/** Reject any value that could break out of the `--token: value;` grammar (defense in
 *  depth — generator output is already format-safe and overrides are server-sanitized). */
const SAFE_TOKEN_VALUE = /^[^;{}<>]+$/;

/** Does this identity carry generative theme inputs (ADR 0171), vs only the legacy
 *  ADR 0170 closed-key colors / mode? */
export function hasGenerativeTheme(theme: PublicBrandIdentity['theme']): boolean {
  return !!(theme && (theme.accentSeed || theme.neutralSeed || theme.secondarySeed || theme.contrastLevel || theme.radius || theme.override));
}

/** Map the persisted theme inputs → the generator's `ThemeInputs` (type-only import,
 *  so the generator itself stays in its lazy chunk). */
export function toThemeInputs(theme: PublicBrandIdentity['theme']): ThemeInputs {
  return {
    ...(theme?.accentSeed ? { accentSeed: theme.accentSeed } : {}),
    ...(theme?.neutralSeed ? { neutralSeed: theme.neutralSeed } : {}),
    ...(theme?.secondarySeed ? { secondarySeed: theme.secondarySeed } : {}),
    ...(theme?.contrastLevel ? { contrastLevel: theme.contrastLevel } : {}),
    ...(theme?.radius ? { radius: theme.radius } : {}),
    ...(theme?.density ? { density: theme.density } : {}),
  };
}

/** Inject a generated token set into the live DOM via a single `<style>` element —
 *  light + dark for BOTH dark entry points: the forced `.theme-dark` class AND the
 *  default `system` mode's `@media (prefers-color-scheme: dark)` (UX-ASSESSMENT
 *  DS-1 — without the media block, a dark-OS user in system mode fell through to
 *  global.css's stock dark tokens and lost the AA-solved palette). Selectors are
 *  deliberately over-specified (`:root:root…`) so the injected rules beat the
 *  same-token stock blocks in global.css regardless of where this `<style>`
 *  element sits relative to the bundled stylesheet (the pre-paint mirror in
 *  index.html creates it early in <head>, BEFORE the CSS link — on equal
 *  specificity the stock sheet would win that tie). Idempotent (replaces the
 *  element's contents). */
export function applyGeneratedTokens(light: Record<string, string>, dark: Record<string, string>): void {
  const rule = (sel: string, map: Record<string, string>): string => {
    const decls = Object.entries(map)
      .filter(([k, v]) => k.startsWith('--') && typeof v === 'string' && SAFE_TOKEN_VALUE.test(v))
      .map(([k, v]) => `${k}:${v}`)
      .join(';');
    return decls ? `${sel}{${decls}}` : '';
  };
  const css = [
    rule(':root:root', light),
    rule(':root:root.theme-dark', dark),
    `@media (prefers-color-scheme: dark){${rule(':root:root:not(.theme-light)', dark)}}`,
  ].join('\n');
  let el = document.getElementById('openwop-brand-theme') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = 'openwop-brand-theme';
    document.head.appendChild(el);
  }
  el.textContent = css;
}

/** Cache the generated token maps for the next load's pre-paint (no-FOUC). */
export function cacheGeneratedTokens(light: Record<string, string>, dark: Record<string, string>): void {
  try {
    localStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify({ light, dark }));
  } catch {
    /* private mode / quota — non-fatal */
  }
}

/** Remove the generated-token style element + cache, reverting to the stock
 *  `global.css` baseline. Called when a brand has no generative theme (e.g. after a
 *  Reset) so the app actually un-skins instead of keeping a stale override. */
export function clearGeneratedTokens(): void {
  document.getElementById('openwop-brand-theme')?.remove();
  try {
    localStorage.removeItem(TOKEN_CACHE_KEY);
  } catch {
    /* non-fatal */
  }
}

/** Merge a runtime identity onto the build-time `brand` singleton, so React
 *  consumers that read `brand.*` reflect a super-admin override after a re-render
 *  (or, when called synchronously before first render, on the initial render). */
export function hydrateBrandSingleton(identity: PublicBrandIdentity): void {
  if (identity.productName) brand.productName = identity.productName;
  if (identity.wordmark) brand.brandMark = identity.wordmark;
  if (identity.tagline) brand.tagline = identity.tagline;
  if (identity.footerText !== undefined) brand.footerText = identity.footerText;
  if (identity.instanceName) brand.instanceName = identity.instanceName;
  if (identity.assistantName) brand.assistantName = identity.assistantName;
  if (identity.logo?.markSrc) {
    brand.markSrc = identity.logo.markSrc;
    brand.logoSrc = identity.logo.markSrc;
  }
  if (identity.logo?.markSrcDark !== undefined) brand.markSrcDark = identity.logo.markSrcDark;
  if (identity.logo?.lockupSrc) brand.lockupSrc = identity.logo.lockupSrc;
  if (identity.logo?.lockupSrcDark !== undefined) brand.lockupSrcDark = identity.logo.lockupSrcDark;
  if (identity.theme?.defaultMode) brand.defaultTheme = identity.theme.defaultMode;
  if (identity.domains?.homeUrl) brand.homeUrl = identity.domains.homeUrl;
  if (identity.domains?.repoUrl) brand.repoUrl = identity.domains.repoUrl;
  if (identity.domains?.primaryDomain) brand.primaryDomain = identity.domains.primaryDomain;
}

/** Read the cached identity (written by the provider). Used for the synchronous
 *  pre-render hydrate so every load after the first paints the override with no FOUC. */
export function readCachedIdentity(): PublicBrandIdentity | null {
  try {
    const raw = localStorage.getItem(BRAND_CACHE_KEY);
    return raw ? (JSON.parse(raw) as PublicBrandIdentity) : null;
  } catch {
    return null;
  }
}

/** Persist the identity for the next load's pre-paint hydrate. */
export function cacheIdentity(identity: PublicBrandIdentity): void {
  try {
    localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(identity));
  } catch {
    /* private mode / quota — non-fatal, the network fetch still applies it this load */
  }
}

/**
 * Runtime brand application (ADR 0170 Phase 5) — jsdom unit tests for the DOM
 * injector + singleton hydrate. Values arrive already server-sanitized; these
 * tests assert the mapping (brandable color keys → :root tokens, title, favicon)
 * and that the build-time singleton merges a runtime override.
 *
 * Sabotage-witnessed (wave 51): mis-map any of the six colour keys or drop the
 * theme-color meta → case 1 red; keep a font override a later identity lacks → case 4
 * red; prefix/mangle the favicon href or keep its build-time `type` → case 3 red; rename
 * the cache key that index.html's pre-paint script reads → the cache case red; drift
 * either side of GENERATOR_OWNED_TOKENS → the MIRROR case red.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyBrandIdentity, hydrateBrandSingleton, readCachedIdentity, cacheIdentity, GENERATOR_OWNED_TOKENS, splitGeneratorOwnedOverride } from './applyBrand.js';
import { brand } from './brand.js';
import { BRAND_DEFAULTS } from './defaults.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  document.documentElement.removeAttribute('style');
  document.querySelector('meta[name="theme-color"]')?.remove();
  localStorage.clear();
});

describe('applyBrandIdentity', () => {
  it('maps every brandable color to its :root design token, and themeColor to the meta tag', () => {
    applyBrandIdentity({ colors: {
      accent: 'oklch(58% 0.13 250)', paper: '#101014', paper2: '#16161c', ink: '#f4f1ea', ink2: '#d0ccc2', rule: '#2a2a33',
      themeColor: '#0b0b0f',
    } });
    const s = document.documentElement.style;
    expect(s.getPropertyValue('--clay')).toBe('oklch(58% 0.13 250)'); // accent → --clay (recolors the ramp)
    expect(s.getPropertyValue('--paper')).toBe('#101014');
    expect(s.getPropertyValue('--paper-2')).toBe('#16161c');
    expect(s.getPropertyValue('--ink')).toBe('#f4f1ea');
    expect(s.getPropertyValue('--ink-2')).toBe('#d0ccc2');
    expect(s.getPropertyValue('--rule')).toBe('#2a2a33');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#0b0b0f');
  });

  it('applies typography tokens and the document title', () => {
    applyBrandIdentity({ typography: { serif: 'Fraunces, serif', sans: 'Inter, sans-serif' }, documentTitle: 'Acme Ops' });
    expect(document.documentElement.style.getPropertyValue('--serif')).toBe('Fraunces, serif');
    expect(document.documentElement.style.getPropertyValue('--sans')).toBe('Inter, sans-serif');
    expect(document.title).toBe('Acme Ops');
  });

  it('swaps the favicon link and drops the build-time type (an override may be PNG/ICO)', () => {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = 'https://old/favicon.ico';
    link.setAttribute('type', 'image/svg+xml');
    document.head.appendChild(link);
    try {
      applyBrandIdentity({ logo: { faviconSrc: '/brand/acme.svg' } });
      const icons = document.querySelectorAll('link[rel="icon"]');
      expect(icons).toHaveLength(1); // swapped in place, not a second icon link
      expect(icons[0]?.getAttribute('href')).toBe('/brand/acme.svg');
      expect(icons[0]?.getAttribute('type')).toBeNull();
    } finally {
      link.remove();
    }
  });

  it('clears a font override a later identity no longer carries (ADR 0883 correction)', () => {
    applyBrandIdentity({ typography: { serif: '"Instrument Serif", serif', sans: 'Geist', mono: 'Geist Mono', fontsHref: 'https://fonts.googleapis.com/css2?family=Instrument+Serif' } });
    expect(document.documentElement.style.getPropertyValue('--serif')).toBe('"Instrument Serif", serif');
    expect(document.querySelector('link[data-brand-fonts]')).not.toBeNull();
    applyBrandIdentity({ colors: { accent: 'oklch(58% 0.13 40)' } });
    const s = document.documentElement.style;
    expect(s.getPropertyValue('--serif')).toBe('');
    expect(s.getPropertyValue('--sans')).toBe('');
    expect(s.getPropertyValue('--mono')).toBe('');
    expect(document.querySelector('link[data-brand-fonts]')).toBeNull();
  });

  it('no-ops on an empty identity (build-time fallback stays)', () => {
    applyBrandIdentity({});
    expect(document.documentElement.getAttribute('style')).toBeFalsy();
  });
});

describe('hydrateBrandSingleton', () => {
  it('merges a runtime override onto the build-time brand singleton', () => {
    const origName = brand.productName;
    try {
      hydrateBrandSingleton({ productName: 'Acme', logo: { markSrc: '/acme.svg' } });
      expect(brand.productName).toBe('Acme');
      expect(brand.markSrc).toBe('/acme.svg');
      expect(brand.logoSrc).toBe('/acme.svg'); // logoSrc tracks markSrc
    } finally {
      // restore even on a red, so nothing leaks into other cases under shuffle
      brand.productName = origName;
      brand.markSrc = BRAND_DEFAULTS.markSrc;
      brand.logoSrc = BRAND_DEFAULTS.markSrc;
    }
  });
});

describe('identity cache', () => {
  it('round-trips through localStorage under the key the pre-paint script reads', () => {
    expect(readCachedIdentity()).toBeNull();
    cacheIdentity({ productName: 'Acme' });
    expect(readCachedIdentity()).toEqual({ productName: 'Acme' });
    // LITERAL key: index.html's inline pre-paint script reads
    // localStorage.getItem('openwop.brand') before any module loads, so the
    // product constant must not be the expectation (it would move with a rename).
    expect(localStorage.getItem('openwop.brand')).toBe('{"productName":"Acme"}');
  });
});

describe('splitGeneratorOwnedOverride (ADR 0510 §5)', () => {
  it('keeps category tokens and drops generator-owned tokens, naming them', () => {
    const { kept, dropped } = splitGeneratorOwnedOverride({
      light: { '--clay': '#123456', '--cat-ai': '#654321' },
      dark: { '--paper': '#000', '--cat-data': '#fff' },
    });
    expect(kept).toEqual({ light: { '--cat-ai': '#654321' }, dark: { '--cat-data': '#fff' } });
    expect(dropped).toEqual(['--clay', '--paper']);
  });

  it('returns undefined kept when everything is generator-owned', () => {
    const { kept, dropped } = splitGeneratorOwnedOverride({ light: { '--ink': '#000' } });
    expect(kept).toBeUndefined();
    expect(dropped).toEqual(['--ink']);
  });

  it('passes through an absent override untouched', () => {
    expect(splitGeneratorOwnedOverride(undefined)).toEqual({ kept: undefined, dropped: [] });
  });

  it('MIRROR CONTRACT: matches the backend GENERATOR_OWNED_TOKENS byte-for-byte', () => {
    // The backend set is the fail-closed floor (brandService drops these on
    // save); this mirror is what makes the editor honest about it. Parse the
    // backend source so drift is a red test, not a silent divergence.
    const src = readFileSync(
      join(__dirname, '../../../../backend/typescript/src/features/brand/types.ts'),
      'utf8',
    );
    const body = src.match(/export const GENERATOR_OWNED_TOKENS = \[([\s\S]*?)\] as const;/)?.[1] ?? '';
    expect(body, 'backend GENERATOR_OWNED_TOKENS not found — the mirror contract moved').not.toBe('');
    const backendTokens = [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect([...GENERATOR_OWNED_TOKENS].sort()).toEqual(backendTokens);
  });
});

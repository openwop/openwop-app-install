/**
 * Runtime brand application (ADR 0170 Phase 5) — jsdom unit tests for the DOM
 * injector + singleton hydrate. Values arrive already server-sanitized; these
 * tests assert the mapping (brandable color keys → :root tokens, title, favicon)
 * and that the build-time singleton merges a runtime override.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyBrandIdentity, hydrateBrandSingleton, readCachedIdentity, cacheIdentity, BRAND_CACHE_KEY, GENERATOR_OWNED_TOKENS, splitGeneratorOwnedOverride } from './applyBrand.js';
import { brand } from './brand.js';
import { BRAND_DEFAULTS } from './defaults.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  document.documentElement.removeAttribute('style');
  localStorage.clear();
});

describe('applyBrandIdentity', () => {
  it('maps brandable colors to the :root design tokens', () => {
    applyBrandIdentity({ colors: { accent: 'oklch(58% 0.13 250)', paper: '#101014', ink: '#f4f1ea' } });
    const s = document.documentElement.style;
    expect(s.getPropertyValue('--clay')).toBe('oklch(58% 0.13 250)'); // accent → --clay (recolors the ramp)
    expect(s.getPropertyValue('--paper')).toBe('#101014');
    expect(s.getPropertyValue('--ink')).toBe('#f4f1ea');
  });

  it('applies typography tokens and the document title', () => {
    applyBrandIdentity({ typography: { serif: 'Fraunces, serif', sans: 'Inter, sans-serif' }, documentTitle: 'Acme Ops' });
    expect(document.documentElement.style.getPropertyValue('--serif')).toBe('Fraunces, serif');
    expect(document.documentElement.style.getPropertyValue('--sans')).toBe('Inter, sans-serif');
    expect(document.title).toBe('Acme Ops');
  });

  it('swaps the favicon link', () => {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = 'https://old/favicon.ico';
    document.head.appendChild(link);
    applyBrandIdentity({ logo: { faviconSrc: '/brand/acme.svg' } });
    expect((document.querySelector('link[rel="icon"]') as HTMLLinkElement).getAttribute('href')).toContain('/brand/acme.svg');
    link.remove();
  });

  it('no-ops on an empty identity (build-time fallback stays)', () => {
    applyBrandIdentity({});
    expect(document.documentElement.getAttribute('style')).toBeFalsy();
  });
});

describe('hydrateBrandSingleton', () => {
  it('merges a runtime override onto the build-time brand singleton', () => {
    const origName = brand.productName;
    hydrateBrandSingleton({ productName: 'Acme', logo: { markSrc: '/acme.svg' } });
    expect(brand.productName).toBe('Acme');
    expect(brand.markSrc).toBe('/acme.svg');
    expect(brand.logoSrc).toBe('/acme.svg'); // logoSrc tracks markSrc
    // restore to avoid leaking into other tests in this file
    brand.productName = origName;
    brand.markSrc = BRAND_DEFAULTS.markSrc;
    brand.logoSrc = BRAND_DEFAULTS.markSrc;
  });
});

describe('identity cache', () => {
  it('round-trips through localStorage', () => {
    expect(readCachedIdentity()).toBeNull();
    cacheIdentity({ productName: 'Acme' });
    expect(readCachedIdentity()).toEqual({ productName: 'Acme' });
    expect(localStorage.getItem(BRAND_CACHE_KEY)).toContain('Acme');
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

/**
 * Runtime brand application (ADR 0170 Phase 5) — jsdom unit tests for the DOM
 * injector + singleton hydrate. Values arrive already server-sanitized; these
 * tests assert the mapping (brandable color keys → :root tokens, title, favicon)
 * and that the build-time singleton merges a runtime override.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { applyBrandIdentity, hydrateBrandSingleton, readCachedIdentity, cacheIdentity, BRAND_CACHE_KEY } from './applyBrand.js';
import { brand } from './brand.js';
import { BRAND_DEFAULTS } from './defaults.js';

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

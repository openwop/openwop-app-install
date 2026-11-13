/**
 * The font preconnect hints follow the font stylesheet's host. A preconnect opens a
 * TLS connection even when nothing is fetched, so a deployment that self-hosts its
 * fonts must not hint Google (found live on myndhyve.ai, 2026-11-11: fonts served
 * from /myndhyve/fonts/, but the shell still preconnected to both Google hosts).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND_DEFAULTS, fontPreconnectLinks } from '../defaults';

// vitest's root is frontend/react (the jsdom env gives import.meta.url an http scheme).
const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

describe('fontPreconnectLinks', () => {
  it('hints both Google hosts for the Google Fonts stylesheet (the stock brand)', () => {
    const links = fontPreconnectLinks(BRAND_DEFAULTS.fontsHref);
    expect(links).toContain('href="https://fonts.googleapis.com"');
    expect(links).toMatch(/href="https:\/\/fonts\.gstatic\.com" crossorigin/);
  });

  it('hints nothing for a same-origin or other-host stylesheet', () => {
    expect(fontPreconnectLinks('/myndhyve/fonts/fonts.css')).toBe('');
    expect(fontPreconnectLinks('https://cdn.example.com/fonts.css')).toBe('');
    expect(fontPreconnectLinks('https://fonts.googleapis.com.evil.test/css2')).toBe('');
  });

  it('index.html stamps the hints instead of hard-coding them, and the brand plugin fills the slot', () => {
    expect(indexHtml).toContain('{{BRAND_FONTS_PRECONNECT}}');
    const viteConfig = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');
    expect(viteConfig).toContain(".replaceAll('{{BRAND_FONTS_PRECONNECT}}', fontPreconnectLinks(brand.fontsHref))");
    expect(indexHtml).not.toMatch(/rel="preconnect" href="https:\/\/fonts\.(googleapis|gstatic)\.com"/);
  });
});

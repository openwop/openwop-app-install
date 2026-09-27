/**
 * UX_UPGRADE-site R2-G6 (SITE-R2-2) — `seo.canonicalUrl` arrived in every
 * PublicPage payload and was discarded: no `<link rel="canonical">`, no
 * `og:url`. Pins that applySeo applies BOTH and that the undo restores the
 * head (the SPA swaps pages client-side — a leaked canonical from the previous
 * page would be worse than none).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { applySeo } from '../siteSeo.js';
import type { PublicPage } from '../siteClient.js';

function page(canonicalUrl: string): PublicPage {
  return {
    slug: 'p', title: 'P', sections: [], updatedAt: '',
    seo: { title: 'P', description: 'd', canonicalUrl, ogTitle: 'P', ogDescription: '', noindex: false },
  };
}

const q = (): { link: HTMLLinkElement | null; og: HTMLMetaElement | null } => ({
  link: document.head.querySelector('link[rel="canonical"]'),
  og: document.head.querySelector('meta[property="og:url"]'),
});

afterEach(() => {
  document.head.querySelectorAll('link[rel="canonical"], meta[property="og:url"]').forEach((el) => el.remove());
});

describe('applySeo canonical (R2-G6)', () => {
  it('applies <link rel="canonical"> + og:url from the payload, and undo removes them', () => {
    const undo = applySeo(page('https://app.example/p/home'));
    expect(q().link?.getAttribute('href')).toBe('https://app.example/p/home');
    expect(q().og?.getAttribute('content')).toBe('https://app.example/p/home');
    undo();
    expect(q().link).toBeNull();
    expect(q().og).toBeNull();
  });

  it('a client-side page swap restores the PREVIOUS canonical, never leaks the new one', () => {
    const undoA = applySeo(page('https://app.example/p/a'));
    const undoB = applySeo(page('https://app.example/p/b'));
    expect(q().link?.getAttribute('href')).toBe('https://app.example/p/b');
    undoB();
    expect(q().link?.getAttribute('href')).toBe('https://app.example/p/a');
    undoA();
    expect(q().link).toBeNull();
  });

  it('an empty canonicalUrl applies nothing (never an empty href claim)', () => {
    const undo = applySeo(page(''));
    expect(q().link).toBeNull();
    expect(q().og).toBeNull();
    undo();
  });
});

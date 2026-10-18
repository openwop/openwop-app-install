/**
 * UX_UPGRADE-site R2-G2 (review R2-2) — the discriminated-read MECHANISM itself.
 *
 * Every consumer test mocks `fetchPublicPageResult` away, so nothing else pins
 * the status mapping (the ADR 0502 mechanism-vs-wiring lesson). This file tests
 * the real function against a stubbed `fetch`: 404/410 → notFound; other non-ok
 * (incl. a 503 whose body is HTML) → error, never notFound and never a throw;
 * network failure → error; a 200 with a non-array `sections` → ok with `[]`
 * (the pricing-'*' wire-shape guard); a 200 with a non-JSON body → error.
 *
 * Every stub is a REAL `Response` (an HTML body makes the real `json()` throw
 * the real SyntaxError). Sabotages that red it (/grade-tests w50): 410 not
 * mapped, a 5xx mapped to notFound, a catch mapped to notFound, no sections
 * guard, no unconfigured-org short-circuit, a legacy wrapper that passes an
 * error through as a page.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchPublicPage, fetchPublicPageResult } from '../siteClient.js';

const HTML = '<!doctype html><title>Service Unavailable</title>';
/** A real Response: JSON-encoded unless `raw` (then sent as an HTML document). */
const stub = (status: number, body: unknown, raw = false): void => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(raw ? String(body) : JSON.stringify(body), {
    status, headers: { 'content-type': raw ? 'text/html' : 'application/json' },
  })));
};

afterEach(() => vi.unstubAllGlobals());

describe('fetchPublicPageResult status mapping', () => {
  it('404 and 410 → notFound (the server answered: nothing published)', async () => {
    for (const code of [404, 410]) {
      stub(code, { error: 'not_found' });
      expect(await fetchPublicPageResult('org-1', 'nope')).toEqual({ status: 'notFound' });
    }
  });

  it('a 503 with an HTML error body → error (never notFound, never a throw)', async () => {
    stub(503, HTML, true);
    expect(await fetchPublicPageResult('org-1', 'real')).toEqual({ status: 'error' });
  });

  it('a network failure → error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await fetchPublicPageResult('org-1', 'real')).toEqual({ status: 'error' });
  });

  it('a 200 whose body is not JSON → error (we do not know what is published)', async () => {
    stub(200, HTML, true);
    expect(await fetchPublicPageResult('org-1', 'real')).toEqual({ status: 'error' });
  });

  it('a 200 with a non-array sections → ok with [] (the pricing-"*" wire guard)', async () => {
    stub(200, { slug: 's', title: 'T', sections: 'bogus', updatedAt: '', seo: {} });
    expect(await fetchPublicPageResult('org-1', 's')).toEqual({
      status: 'ok', page: { slug: 's', title: 'T', sections: [], updatedAt: '', seo: {} },
    });
  });

  it('an unconfigured org → notFound without a network call', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(await fetchPublicPageResult('', 'home')).toEqual({ status: 'notFound' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('the legacy page-or-null wrapper collapses notFound AND error to null (funnel-viewer contract)', async () => {
    stub(404, {});
    expect(await fetchPublicPage('org-1', 'x')).toBeNull();
    stub(500, {});
    expect(await fetchPublicPage('org-1', 'x')).toBeNull();
    stub(200, { slug: 'x', title: 'T', sections: [], updatedAt: '', seo: {} });
    expect((await fetchPublicPage('org-1', 'x'))?.slug).toBe('x');
  });
});

/**
 * ADR 0101 Phase 4 — `fetchBatch` reports the FINAL url after redirects.
 *
 * The fetch already followed redirects through the guarded dispatcher, but the
 * page was built from the REQUESTED url, so the resolved location was discarded.
 * A caller recording a citation therefore recorded the redirector rather than the
 * page it actually read — which matters anywhere a url is hashed, deduped, or
 * shown to a human as provenance.
 */
// `as unknown as Response` below is the deliberate, minimal fetch-response stub:
// the surface reads only `ok`/`status`/`url`/`headers.get`/`text()`, and
// constructing a real `Response` cannot set `url` (it is read-only and derives
// from an actual request), which is the exact field under test.
import { describe, expect, it, vi, afterEach } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
// Spread the REAL module and override only `fetch`: the surface's SSRF guard
// builds an undici `Agent` for its dispatcher, so a wholesale mock makes that
// construction throw — the request then fails and `fetchOne`'s catch returns the
// REQUESTED url, which is exactly the value under test. (A mock that silently
// routes the assertion through the error path would pass for the wrong reason.)
vi.mock('undici', async (importActual) => ({
  ...(await importActual<typeof import('undici')>()),
  fetch: fetchMock,
}));

const { createWebResearchSurface } = await import('../src/host/webResearchSurface.js');

function htmlResponse(finalUrl: string, body: string): Response {
  return {
    ok: true,
    status: 200,
    url: finalUrl,
    headers: { get: () => 'text/html' },
    text: async () => body,
  } as unknown as Response;
}

afterEach(() => { fetchMock.mockReset(); });

describe('fetchBatch — final-url reporting', () => {
  it('reports the RESOLVED url and keeps the requested one when they differ', async () => {
    fetchMock.mockResolvedValue(htmlResponse('https://publisher.example/article', '<title>Real Article</title><p>body</p>'));
    const surface = createWebResearchSurface({ tenantId: 't1' });

    const { pages } = await surface.fetchBatch({ urls: ['https://redirector.example/go?id=abc'] });

    expect(pages[0]!.url).toBe('https://publisher.example/article');   // what we READ
    expect(pages[0]!.requestedUrl).toBe('https://redirector.example/go?id=abc'); // what we ASKED for
  });

  it('omits requestedUrl when no redirect happened (no noise on the common path)', async () => {
    const direct = 'https://publisher.example/article';
    fetchMock.mockResolvedValue(htmlResponse(direct, '<title>Real Article</title>'));
    const surface = createWebResearchSurface({ tenantId: 't1' });

    const { pages } = await surface.fetchBatch({ urls: [direct] });

    expect(pages[0]!.url).toBe(direct);
    expect(pages[0]!.requestedUrl).toBeUndefined();
  });

  it('falls back to the requested url when the response exposes none', async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200, url: '', headers: { get: () => 'text/html' }, text: async () => '<title>T</title>',
    } as unknown as Response);
    const surface = createWebResearchSurface({ tenantId: 't1' });

    const { pages } = await surface.fetchBatch({ urls: ['https://example.org/a'] });

    expect(pages[0]!.url).toBe('https://example.org/a'); // never empty
  });
});

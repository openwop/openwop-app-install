/**
 * INT-1 (CODEBASE-ASSESSMENT.md): web-research egress is run-controllable, so
 * fetchOne / searchLive MUST refuse loopback / link-local / cloud-metadata
 * targets (SSRF) when private egress is not explicitly allowed — closing the
 * one path that previously bypassed the host's pinned-resolution egress guard.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createWebResearchSurface } from '../src/host/webResearchSurface.js';

const scope = { tenantId: 'tenant-ssrf-test' };

afterEach(() => {
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  delete process.env.OPENWOP_WEBSEARCH_API_KEY;
  delete process.env.OPENWOP_WEBSEARCH_BASE_URL;
});

describe('web-research SSRF guard', () => {
  it('fetchBatch denies loopback + cloud-metadata URLs (no private egress)', async () => {
    delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
    const surface = createWebResearchSurface(scope);
    const { pages } = await surface.fetchBatch({
      urls: [
        'http://127.0.0.1:9/',
        'http://169.254.169.254/latest/meta-data/',
        'http://localhost/admin',
      ],
    });
    expect(pages).toHaveLength(3);
    for (const p of pages) {
      // fetchOne catches the egress denial and surfaces it as a failed page.
      expect(p.status).toBe(0);
      expect(p.error ?? '').toMatch(/egress denied|denied|loopback|link-local|private/i);
    }
  });

  it('fetchBatch refuses non-http(s) schemes', async () => {
    const surface = createWebResearchSurface(scope);
    const { pages } = await surface.fetchBatch({ urls: ['file:///etc/passwd'] });
    expect(pages[0]!.status).toBe(0);
    expect(pages[0]!.error ?? '').toMatch(/scheme|http/i);
  });

  it('searchLive refuses a loopback OPENWOP_WEBSEARCH_BASE_URL', async () => {
    // A live search key routes to searchLive; point the base at metadata.
    process.env.OPENWOP_WEBSEARCH_API_KEY = 'k-live';
    process.env.OPENWOP_WEBSEARCH_BASE_URL = 'http://169.254.169.254/search';
    const surface = createWebResearchSurface(scope);
    // searchLive throws on egress denial; search() catches and falls back to
    // the honest demo result rather than hitting the internal address.
    const res = await surface.search({ query: 'anything' });
    expect(res.engine).toBe('demo');
  });

  it('allows the call to proceed when private egress is explicitly enabled', async () => {
    // With the opt-in flag the guard no longer pre-rejects the host; the
    // request fails for an ordinary connection reason instead of an egress
    // denial (port 9 / discard is closed), proving the guard was bypassed.
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const surface = createWebResearchSurface(scope);
    const { pages } = await surface.fetchBatch({ urls: ['http://127.0.0.1:9/'], perRequestTimeoutMs: 1500 });
    expect(pages[0]!.status).toBe(0);
    expect(pages[0]!.error ?? '').not.toMatch(/egress denied/i);
  });
});

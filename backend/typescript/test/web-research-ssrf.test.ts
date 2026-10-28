/**
 * INT-1 (docs/steward/CODEBASE-ASSESSMENT.md): web-research egress is run-controllable, so
 * fetchOne / searchLive MUST refuse loopback / link-local / cloud-metadata
 * targets (SSRF) when private egress is not explicitly allowed — closing the
 * one path that previously bypassed the host's pinned-resolution egress guard.
 *
 * TWO GUARDS sit in `ssrfGuardedFetch` (`host/webResearchSurface.ts`): a hostname
 * PRECHECK (`isDeniedWebhookHost`, a clear `webhook egress denied: …` error before any
 * socket) and the pinned-resolution DISPATCHER (`webhookEgressDispatcher`, re-resolves
 * at connect time and on every redirect). Only the precheck is visible here: `fetchOne`
 * records `err.message`, and a dispatcher denial surfaces as undici's generic
 * `fetch failed` — the same text as an ordinary ECONNREFUSED. So these cases assert
 * the PRECHECK's own message (round-1 probe 8fw4g1-ssrf-precheck: witnessed) and the
 * shared opt-in flag both guards read (8fw4g1-ssrf-flag: witnessed). The dispatcher is
 * witnessed by the webhook egress tests, not here — an honest ceiling, not a hole.
 *
 * undici's `fetch` is wrapped (pass-through) so the searchLive case can assert the
 * request was NEVER made — `search()` falls back to the demo engine on ANY failure, so
 * `engine === 'demo'` alone could not tell a refusal from a network error
 * (8fw4g1-ssrf-search was vacuous, and slow, in round 1).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import { createWebResearchSurface } from '../src/host/webResearchSurface.js';

const METADATA_HOST = '169.254.169.254';
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    // Pass-through, except a metadata-host request is refused instantly: under sabotage
    // the probe must go red fast, never wait out a connect timeout to a link-local IP.
    fetch: vi.fn((input: Parameters<typeof actual.fetch>[0], init?: Parameters<typeof actual.fetch>[1]) =>
      String(input).includes('169.254.169.254')
        ? Promise.reject(new Error('test double: metadata host must never be fetched'))
        : actual.fetch(input, init)),
  };
});
const fetchSpy = vi.mocked(undiciFetch);

const scope = { tenantId: 'tenant-ssrf-test' };
const fetchedUrls = (): string[] => fetchSpy.mock.calls.map(([u]) => String(u));

afterEach(() => {
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  delete process.env.OPENWOP_WEBSEARCH_API_KEY;
  delete process.env.OPENWOP_WEBSEARCH_BASE_URL;
  fetchSpy.mockClear();
});

describe('web-research SSRF guard', () => {
  it('fetchBatch denies loopback + cloud-metadata URLs (no private egress)', async () => {
    delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
    const surface = createWebResearchSurface(scope);
    const { pages } = await surface.fetchBatch({
      urls: [
        'http://127.0.0.1:9/',
        `http://${METADATA_HOST}/latest/meta-data/`,
        'http://localhost/admin',
      ],
      perRequestTimeoutMs: 1500,
    });
    expect(pages).toHaveLength(3);
    for (const p of pages) {
      // fetchOne catches the egress denial and surfaces it as a failed page — by the
      // PRECHECK's own message, not merely "some error".
      expect(p.status).toBe(0);
      expect(p.error ?? '').toContain('webhook egress denied: ');
    }
    expect(fetchedUrls(), 'no denied URL reached the network layer').toEqual([]);
  });

  it('fetchBatch refuses non-http(s) schemes', async () => {
    const surface = createWebResearchSurface(scope);
    const { pages } = await surface.fetchBatch({ urls: ['file:///etc/passwd'] });
    expect(pages[0]!.status).toBe(0);
    expect(pages[0]!.error).toBe("web-research: refusing non-http(s) URL scheme 'file:'");
    expect(fetchedUrls()).toEqual([]);
  });

  it('searchLive refuses a loopback OPENWOP_WEBSEARCH_BASE_URL', async () => {
    // A live search key routes to searchLive; point the base at metadata.
    process.env.OPENWOP_WEBSEARCH_API_KEY = 'k-live';
    process.env.OPENWOP_WEBSEARCH_BASE_URL = `http://${METADATA_HOST}/search`;
    const surface = createWebResearchSurface(scope);
    // searchLive throws on egress denial; search() catches and falls back to
    // the honest demo result rather than hitting the internal address.
    const res = await surface.search({ query: 'anything' });
    expect(res.engine).toBe('demo');
    // The refusal itself: the metadata host was never requested.
    expect(fetchedUrls().filter((u) => u.includes(METADATA_HOST))).toEqual([]);
  });

  it('allows the call to proceed when private egress is explicitly enabled', async () => {
    // With the opt-in flag the guard no longer pre-rejects the host; the
    // request fails for an ordinary connection reason instead of an egress
    // denial (port 9 / discard is closed), proving the precheck was bypassed.
    // Ceiling: `fetch failed` is also what a DISPATCHER denial reads as (see header).
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const surface = createWebResearchSurface(scope);
    const { pages } = await surface.fetchBatch({ urls: ['http://127.0.0.1:9/'], perRequestTimeoutMs: 1500 });
    expect(pages[0]!.status).toBe(0);
    expect(pages[0]!.error).toBe('fetch failed');
    expect(fetchedUrls(), 'the request reached the network layer').toEqual(['http://127.0.0.1:9/']);
  });
});

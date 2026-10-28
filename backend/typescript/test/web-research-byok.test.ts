/**
 * host.webResearch.search — BYOK/env-gated live provider (Residual #2).
 *
 * With a provider key + base URL configured, search() queries the real provider
 * (mock Brave-shaped JSON here) and returns live results + engine. With no key
 * it returns the honest demo result; on a provider error it falls back to demo
 * rather than hard-failing. research() composes search→fetchBatch.
 *
 * NO PUBLIC NETWORK (grade-tests wave 63): the mock provider's results point at
 * pages served by the SAME loopback server, so research() fetches only
 * 127.0.0.1 and the test asserts the requests the product made (the search
 * query, then each page). The old fixture pointed at https://example.com and
 * asserted `typeof content === 'string'`, which a failed fetch (`''`) also
 * satisfies (probe 8fw4g4-wrb-research-content, vacuous).
 */

import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';

let app: http.Server;
let provider: http.Server;
let providerUrl: string;
let origin: string;
let lastAuthHeader: string | null = null;
let lastQuery: string | null = null;
let pagesFetched: string[] = [];
let providerStatus = 200;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  // The mock search provider below runs on 127.0.0.1; web-research egress is
  // now SSRF-guarded (denies loopback by default), so opt into private egress
  // for the test — same flag the webhook-egress tests use.
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  const a = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { app = a.listen(0, '127.0.0.1', res); });
  provider = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/page-')) {
      pagesFetched.push(url.pathname);
      const name = url.pathname === '/page-a' ? 'Alpha' : 'Beta';
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><head><title>${name} page</title></head><body><p>${name} readable body.</p></body></html>`);
      return;
    }
    lastAuthHeader = (req.headers['x-subscription-token'] as string) ?? null;
    lastQuery = url.searchParams.get('q');
    if (providerStatus !== 200) { res.writeHead(providerStatus).end('err'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ web: { results: [
      { url: `${origin}/page-a`, title: 'Result A', description: 'snippet A' },
      { url: `${origin}/page-b`, title: 'Result B', description: 'snippet B' },
    ] } }));
  });
  await new Promise<void>((res) => provider.listen(0, '127.0.0.1', res));
  origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  providerUrl = `${origin}/search`;
});

afterAll(async () => {
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  await new Promise<void>((res) => app.close(() => res()));
  await new Promise<void>((res) => provider.close(() => res()));
});

afterEach(() => {
  delete process.env.OPENWOP_WEBSEARCH_API_KEY;
  delete process.env.OPENWOP_WEBSEARCH_BASE_URL;
  delete process.env.OPENWOP_WEBSEARCH_ENGINE;
  providerStatus = 200;
  lastAuthHeader = null;
  lastQuery = null;
  pagesFetched = [];
});

const wr = () => buildHostSurfaceBundle({ tenantId: 'default' }).webResearch;

describe('host.webResearch.search BYOK provider', () => {
  it('queries the live provider when a key + base URL are configured', async () => {
    process.env.OPENWOP_WEBSEARCH_API_KEY = 'test-key';
    process.env.OPENWOP_WEBSEARCH_BASE_URL = providerUrl;
    process.env.OPENWOP_WEBSEARCH_ENGINE = 'brave';
    const r = await wr().search({ query: 'openwop protocol', maxResults: 5 });
    expect(r.engine).toBe('brave');
    expect(r.results).toHaveLength(2);
    expect(r.results[0]!.url).toBe(`${origin}/page-a`);
    expect(lastQuery, 'the query reaches the provider unchanged').toBe('openwop protocol');
    expect(r.results[0]!.snippet).toBe('snippet A');
    expect(r.results[1]!.rank).toBe(2);
    expect(lastAuthHeader, 'the provider key is sent as x-subscription-token').toBe('test-key');
  });

  it('applies siteFilter to the query', async () => {
    process.env.OPENWOP_WEBSEARCH_API_KEY = 'k';
    process.env.OPENWOP_WEBSEARCH_BASE_URL = providerUrl;
    const r = await wr().search({ query: 'spec', siteFilter: 'openwop.dev' });
    expect(r.engine).toBe('brave'); // default engine label
    expect(r.results.length).toBeGreaterThan(0);
    // The claim: the filter rides INSIDE the query the provider received.
    expect(lastQuery).toBe('spec site:openwop.dev');
  });

  it('returns the honest demo result when no key is configured', async () => {
    const r = await wr().search({ query: 'anything' });
    expect(r.engine).toBe('demo');
    expect(r.results[0]!.url).toContain('duckduckgo.com');
  });

  it('falls back to demo on a provider error (does not hard-fail)', async () => {
    process.env.OPENWOP_WEBSEARCH_API_KEY = 'k';
    process.env.OPENWOP_WEBSEARCH_BASE_URL = providerUrl;
    providerStatus = 500;
    const r = await wr().search({ query: 'x' });
    expect(lastQuery, 'the live provider WAS tried first').toBe('x');
    expect(r.engine).toBe('demo');
    expect(r.results[0]!.url).toContain('duckduckgo.com');
  });

  it('research composes the live search with real fetch', async () => {
    process.env.OPENWOP_WEBSEARCH_API_KEY = 'k';
    process.env.OPENWOP_WEBSEARCH_BASE_URL = providerUrl;
    const r = await wr().research({ query: 'openwop', maxResults: 2 });
    expect(r.engine).toBe('brave');
    expect(lastQuery).toBe('openwop');
    // fetchBatch fetched EACH result url (loopback only — no public network)…
    expect([...pagesFetched].sort()).toEqual(['/page-a', '/page-b']);
    // …and each citation carries that page's extracted title + readable text.
    expect(r.citations.map((c) => [c.url, c.title, c.content])).toEqual([
      [`${origin}/page-a`, 'Alpha page', 'Alpha page Alpha readable body.'],
      [`${origin}/page-b`, 'Beta page', 'Beta page Beta readable body.'],
    ]);
  });
});

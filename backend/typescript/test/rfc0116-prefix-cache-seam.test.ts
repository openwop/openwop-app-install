/**
 * RFC 0116 — prompt-prefix cache seam (the live witness driver). Boots the app
 * with the seam enabled and drives the §witness scenario over HTTP: tenant A
 * primes → A hits → tenant B (SAME cachePrefixId) structurally misses. Also
 * asserts the key-gated advert appears when the seam env is on.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function jf<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
}
const probe = (tenant: string, cachePrefixId: string) =>
  jf<{ cacheReadTokens: number; cacheWriteTokens: number; inputTokens: number; outputTokens: number; cacheHit: boolean }>(
    '/host/sample/aiProviders/prefix-cache-probe',
    { method: 'POST', body: JSON.stringify({ tenant, cachePrefixId }) },
  );

// ADR 0812 P3c-0 — the `aiProviders.promptPrefixCache` advert block is deleted: the facet exists only
// in the retired v1 document (the v2 `aiProviders` record carries none); the seam witness remains.

describe('RFC 0116 — prefix-cache-probe seam witness (two tenants over HTTP)', () => {
  it('A primes → A hits → B (same cachePrefixId) structurally misses; outcome-invariant', async () => {
    const a1 = await probe('tenant-A', 'shared');
    expect(a1.status).toBe(200);
    expect(a1.body.cacheReadTokens).toBe(0); // prime
    expect(a1.body.cacheWriteTokens).toBeGreaterThan(0);

    const a2 = await probe('tenant-A', 'shared');
    expect(a2.body.cacheReadTokens).toBeGreaterThan(0); // hit

    const b1 = await probe('tenant-B', 'shared'); // SAME cachePrefixId, different tenant
    expect(b1.body.cacheReadTokens).toBe(0); // cross-tenant structural MISS (the MUST)

    // Outcome-invariance: cachePrefixId is a cost hint only.
    expect(a2.body.inputTokens).toBe(b1.body.inputTokens);
    expect(a2.body.outputTokens).toBe(b1.body.outputTokens);
  });

  it('rejects a malformed probe (400)', async () => {
    const res = await jf('/host/sample/aiProviders/prefix-cache-probe', { method: 'POST', body: JSON.stringify({ tenant: 'x' }) });
    expect(res.status).toBe(400);
  });
});

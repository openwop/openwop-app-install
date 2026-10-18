/**
 * CDP-G — collection SDK (ADR 0269). The zero-dep client builds the right requests
 * (path, method, bearer auth, JSON body) and treats a resolve 404 as null.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getSetCookies } from './headerCookies.js';
// Typed by the ambient declaration in test/feature-packs.d.ts (the SDK is plain ESM).
import { createCdpClient } from '../sdk/cdpCollectSdk.mjs';

interface Init { method?: string; headers: Record<string, string>; body?: string }
function mockFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string, _init: Init) => ({ status, ok: status >= 200 && status < 300, json: async () => body }));
}

describe('CDP-G createCdpClient', () => {
  it('collect POSTs the event with bearer auth + JSON body', async () => {
    const f = mockFetch(201, { eventId: 'evt:1', hasSchema: false });
    const cdp = createCdpClient({ baseUrl: 'https://app.test/', token: 'owk_abc', fetchImpl: f });
    const r = await cdp.collect('signup', { orderId: 'o1' });
    expect(r.status).toBe(201);
    const [calledUrl, init] = f.mock.calls[0]!;
    expect(calledUrl).toBe('https://app.test/host/openwop-app/cdp/collect');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer owk_abc');
    expect(JSON.parse(init.body ?? '')).toEqual({ eventType: 'signup', payload: { orderId: 'o1' } });
  });

  it('resolveIdentity returns the record, or null on a 404 miss', async () => {
    const hit = createCdpClient({ baseUrl: 'https://app.test', token: 't', fetchImpl: mockFetch(200, { contact: { contactId: 'crm:1' } }) });
    expect(await hit.resolveIdentity('email', 'a@x.test')).toEqual({ contact: { contactId: 'crm:1' } });
    const miss = createCdpClient({ baseUrl: 'https://app.test', token: 't', fetchImpl: mockFetch(404, { error: 'not_found' }) });
    expect(await miss.resolveIdentity('email', 'none@x.test')).toBeNull();
  });

  it('requires a baseUrl', () => {
    expect(() => createCdpClient({})).toThrow(/baseUrl/);
  });
});

/**
 * ADR 0812 P3-0 — the SDK against a REAL host that has retired major 1.
 *
 * The mock tests above only compare a URL string, so they pinned the defect: the
 * SDK addressed `/v1/host/openwop-app/cdp`, which a retired host answers with 410
 * (writes are not forwarded). MEASURED on app.openwop.dev 2026-10-05. This drives
 * every SDK method through the real routes with retirement ON, so a `/v1` path
 * goes red here as a 410 rather than passing as a string.
 */
describe('CDP-G createCdpClient against a host that has retired v1', () => {
  let server: http.Server; let base = ''; let cookie = '';
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    for (const id of ['users', 'cdp']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
    const login = await fetch(`${base}/host/openwop-app/test/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sdk@cdp.test', tenantId: 'org:cdp-sdk' }) });
    expect(login.status).toBe(201);
    for (const c of getSetCookies(login.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    expect(cookie).not.toBe('');
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  // The SDK authenticates with a bearer key in production; the session cookie
  // stands in for it here. What is under test is the PATH the SDK addresses.
  const withSession = (input: string, init: Init) => fetch(input, { ...init, headers: { ...init.headers, cookie } });

  it('every method reaches its route (no 410), and collect/resolve round-trip', async () => {
    const seen: string[] = [];
    const cdp = createCdpClient({ baseUrl: base, fetchImpl: (i, init) => { seen.push(i); return withSession(i, init); } });

    const reg = await cdp.registerSchema('signup', { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string' } } });
    expect(reg.status, JSON.stringify(reg.body)).toBeLessThan(300);
    const one = await cdp.collect('signup', { orderId: 'o1', email: 'sdk-a@x.test' });
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    expect((one.body as { hasSchema?: boolean }).hasSchema).toBe(true); // the registered schema took effect
    // (also the collectBatch path+body witness: the former mock-only case is subsumed here)
    const batch = await cdp.collectBatch([{ eventType: 'signup', payload: { orderId: 'o2' } }]);
    expect(batch.status, JSON.stringify(batch.body)).toBe(200);
    expect((batch.body as { accepted?: number }).accepted).toBe(1);
    // A miss resolves to null (404), never a 410 body passed through as a record.
    const miss = await cdp.resolveIdentity('email', 'nobody@x.test');
    expect(miss).toBeNull();

    // Exact paths: a 404 miss is indistinguishable from a wrong path, and the
    // retired `/v1/host/…` spelling is the defect this case was written for.
    expect(seen).toEqual([
      `${base}/host/openwop-app/cdp/event-schemas`,
      `${base}/host/openwop-app/cdp/collect`,
      `${base}/host/openwop-app/cdp/collect/batch`,
      `${base}/host/openwop-app/cdp/identity/resolve?type=email&value=nobody%40x.test`,
    ]);
  });
});

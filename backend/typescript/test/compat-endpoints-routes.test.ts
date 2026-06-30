/**
 * Compat endpoint config routes — RFC 0108 / ADR 0121. Route-level test
 * (createApp + cookie jar): env-gate, org-scoped RBAC, create→list→delete,
 * create-time SSRF validation, and cross-owner isolation. Advertisement-neutral
 * (these routes only store config; the wire flip is separately gated).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_COMPAT_PROVIDER_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE; // so private hosts are rejected
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), del: (p: string) => call('DELETE', p) };
}
const uniqEmail = (who: string) => `${who}-${Date.now()}-${n++}@acme.test`;
async function ownerWithOrg(who: string) {
  const c = client();
  await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail(who) });
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  return { c, orgId: org.body.orgId as string };
}
const CE = '/v1/host/openwop-app/compat-endpoints';

describe('compat-endpoints routes (RFC 0108 / ADR 0121)', () => {
  it('create → list → delete round-trips for an org owner', async () => {
    const { c, orgId } = await ownerWithOrg('ce-crud');
    const created = await c.post(CE, { orgId, label: 'Internal vLLM', baseUrl: 'https://vllm.example.com/v1', capabilities: { tools: true } });
    expect(created.status).toBe(201);
    expect(created.body.id).toMatch(/^compat-/);
    expect(created.body).not.toHaveProperty('credentialRef'); // §D: key/ref never returned
    expect(created.body.baseUrl).toBe('https://vllm.example.com/v1'); // owner sees their own config

    const listed = await c.get(`${CE}?orgId=${orgId}`);
    expect(listed.status).toBe(200);
    expect(listed.body.endpoints.map((e: any) => e.id)).toEqual([created.body.id]);

    expect((await c.del(`${CE}/${created.body.id}`)).status).toBe(204);
    expect((await c.get(`${CE}?orgId=${orgId}`)).body.endpoints).toEqual([]);
  });

  // The keyless path (e.g. a default Ollama). The keyed path stores via BYOK
  // `setSecret`, which needs KMS configured — exercised in production / the byok
  // route tests, not this KMS-less memory harness.
  it('a keyless endpoint has hasKey false and never exposes a key/ref', async () => {
    const { c, orgId } = await ownerWithOrg('ce-nokey');
    const created = await c.post(CE, { orgId, label: 'ollama', baseUrl: 'https://ollama.example.com/v1' });
    expect(created.status).toBe(201);
    expect(created.body.hasKey).toBe(false);
    expect(created.body).not.toHaveProperty('credentialRef');
    await c.del(`${CE}/${created.body.id}`);
  });

  it('rejects a private/loopback base URL (SSRF) and a non-https URL', async () => {
    const { c, orgId } = await ownerWithOrg('ce-ssrf');
    expect((await c.post(CE, { orgId, label: 'x', baseUrl: 'https://10.0.0.5/v1' })).status).toBe(400);
    expect((await c.post(CE, { orgId, label: 'x', baseUrl: 'http://vllm.example.com/v1' })).status).toBe(400);
  });

  it('validates required fields (orgId, label, baseUrl)', async () => {
    const { c, orgId } = await ownerWithOrg('ce-val');
    expect((await c.post(CE, {})).status).toBe(400); // no orgId
    expect((await c.post(CE, { orgId })).status).toBe(400); // no label
    expect((await c.post(CE, { orgId, label: 'x' })).status).toBe(400); // no baseUrl
  });

  it('isolates across owners — a different account cannot delete or see it', async () => {
    const a = await ownerWithOrg('ce-iso-a');
    const created = await a.c.post(CE, { orgId: a.orgId, label: 'a', baseUrl: 'https://a.example.com/v1' });
    expect(created.status).toBe(201);
    const b = await ownerWithOrg('ce-iso-b');
    const delByB = await b.c.del(`${CE}/${created.body.id}`);
    expect([403, 404]).toContain(delByB.status); // never 204
    // and B's own org list doesn't contain A's endpoint
    expect((await b.c.get(`${CE}?orgId=${b.orgId}`)).body.endpoints).toEqual([]);
    // A's endpoint still there
    expect((await a.c.get(`${CE}?orgId=${a.orgId}`)).body.endpoints.length).toBe(1);
    await a.c.del(`${CE}/${created.body.id}`);
  });
});

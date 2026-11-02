/**
 * Compat endpoint config routes — RFC 0108 / ADR 0121. Route-level test
 * (createApp + cookie jar): org-scoped RBAC, create→list→delete, create-time
 * SSRF validation, required fields, and isolation. Advertisement-neutral (these
 * routes only store config; the wire flip is separately gated). Tracker: TST-CGD-1.
 *
 * Red when: the SSRF host check or the https check is dropped (each refusal is
 * asserted by its own message — both are `validation_error` 400); `label` stops
 * being required; the org-scope check on DELETE or GET is dropped (a SAME-TENANT
 * non-member of the org — the only caller who reaches that check); or the store
 * lookup stops being tenant-keyed (a CROSS-TENANT caller then reaches the org
 * check and gets 403 instead of the uniform 404).
 *
 * Isolation is TWO guards in series, each witnessed by its own leg: the
 * tenant-keyed store (`host/compatEndpoints.ts` `getCompatEndpoint`) refuses a
 * cross-tenant caller with 404; the route's `requireOrgScope` refuses a same-tenant
 * non-member with 403.
 *
 * HONEST CEILING: the keyed path (an `apiKey` stored via BYOK `setSecret`) needs
 * KMS, which this memory harness does not configure and no shared test seam
 * provides (test/setup, test/helpers: none). So "the stored key/ref is never
 * returned" is asserted only on the keyless path, where `credentialRef` never
 * exists — dropping the `publicView` destructure stays green here.
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
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
interface Endpoint { id: string; baseUrl: string; hasKey: boolean; credentialRef?: string }
interface ErrorBody { error: string; message: string; details?: { requiredScope?: string; field?: string } }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
    return { status: res.status, body: out };
  };
  return {
    get: <T>(p: string) => call<T>('GET', p),
    post: <T>(p: string, b?: unknown) => call<T>('POST', p, b),
    del: <T>(p: string) => call<T>('DELETE', p),
  };
}
const uniqEmail = (who: string) => `${who}-${Date.now()}-${n++}@acme.test`;
/** An owner in their own tenant (`tenantId`), with an org. */
async function ownerWithOrg(who: string, tenantId = `org:ce-${who}-${Date.now()}-${n++}`) {
  const c = client();
  const login = await c.post<unknown>('/host/openwop-app/test/login', { email: uniqEmail(who), tenantId });
  expect(login.status).toBe(201);
  const org = await c.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { c, orgId: org.body.orgId, tenantId };
}
/** A second account in the SAME tenant that belongs to none of its orgs. */
async function sameTenantNonMember(tenantId: string) {
  const c = client();
  const login = await c.post<unknown>('/host/openwop-app/test/login', { email: uniqEmail('ce-stranger'), tenantId });
  expect(login.status).toBe(201);
  return c;
}
const CE = '/host/openwop-app/compat-endpoints';

describe('compat-endpoints routes (RFC 0108 / ADR 0121)', () => {
  it('create → list → delete round-trips for an org owner', async () => {
    const { c, orgId } = await ownerWithOrg('ce-crud');
    const created = await c.post<Endpoint>(CE, { orgId, label: 'Internal vLLM', baseUrl: 'https://vllm.example.com/v1', capabilities: { tools: true } });
    expect(created.status).toBe(201);
    expect(created.body.id).toMatch(/^compat-/);
    expect(created.body).not.toHaveProperty('credentialRef'); // §D: key/ref never returned
    expect(created.body.baseUrl).toBe('https://vllm.example.com/v1'); // owner sees their own config

    const listed = await c.get<{ endpoints: Endpoint[] }>(`${CE}?orgId=${orgId}`);
    expect(listed.status).toBe(200);
    expect(listed.body.endpoints.map((e) => e.id)).toEqual([created.body.id]);

    expect((await c.del(`${CE}/${created.body.id}`)).status).toBe(204);
    expect((await c.get<{ endpoints: Endpoint[] }>(`${CE}?orgId=${orgId}`)).body.endpoints).toEqual([]);
  });

  // The keyless path (e.g. a default Ollama). The keyed path stores via BYOK
  // `setSecret`, which needs KMS configured — exercised in production / the byok
  // route tests, not this KMS-less memory harness.
  it('a keyless endpoint has hasKey false and never exposes a key/ref', async () => {
    const { c, orgId } = await ownerWithOrg('ce-nokey');
    // CEILING (see header): keyless only — no KMS in this harness.
    const created = await c.post<Endpoint>(CE, { orgId, label: 'ollama', baseUrl: 'https://ollama.example.com/v1' });
    expect(created.status).toBe(201);
    expect(created.body.hasKey).toBe(false);
    expect(created.body).not.toHaveProperty('credentialRef');
    await c.del(`${CE}/${created.body.id}`);
  });

  it('rejects a private/loopback base URL (SSRF) and a non-https URL', async () => {
    const { c, orgId } = await ownerWithOrg('ce-ssrf');
    // Both are `validation_error` 400, so each is pinned by its own message.
    const priv = await c.post<ErrorBody>(CE, { orgId, label: 'x', baseUrl: 'https://10.0.0.5/v1' });
    expect(priv.status).toBe(400);
    expect(priv.body.error).toBe('validation_error');
    expect(priv.body.message).toMatch(/private\/loopback blocked/);
    const plain = await c.post<ErrorBody>(CE, { orgId, label: 'x', baseUrl: 'http://vllm.example.com/v1' });
    expect(plain.status).toBe(400);
    expect(plain.body.message).toMatch(/baseUrl must be https/);
    // Nothing was stored by either refusal.
    expect((await c.get<{ endpoints: Endpoint[] }>(`${CE}?orgId=${orgId}`)).body.endpoints).toEqual([]);
  });

  it('validates required fields (orgId, label, baseUrl)', async () => {
    const { c, orgId } = await ownerWithOrg('ce-val');
    // Each body is valid EXCEPT the one field under test, so the refusal names it.
    const BASE_URL = 'https://ok.example.com/openai';
    const noOrg = await c.post<ErrorBody>(CE, { label: 'x', baseUrl: BASE_URL });
    expect(noOrg.status).toBe(400);
    expect(noOrg.body.details?.field).toBe('orgId');
    const noLabel = await c.post<ErrorBody>(CE, { orgId, baseUrl: BASE_URL });
    expect(noLabel.status).toBe(400);
    expect(noLabel.body.details?.field).toBe('label');
    const noBase = await c.post<ErrorBody>(CE, { orgId, label: 'x' });
    expect(noBase.status).toBe(400);
    expect(noBase.body.details?.field).toBe('baseUrl');
  });

  it('isolates across owners — a different account cannot delete or see it', async () => {
    const a = await ownerWithOrg('ce-iso-a');
    const created = await a.c.post<Endpoint>(CE, { orgId: a.orgId, label: 'a', baseUrl: 'https://a.example.com/v1' });
    expect(created.status).toBe(201);

    // Guard 1 — the ORG check. A same-tenant account outside A's org reaches the
    // row (the store is tenant-keyed, and this is the same tenant) and is refused
    // by `requireOrgScope`, for the delete AND the list.
    const stranger = await sameTenantNonMember(a.tenantId);
    const delByStranger = await stranger.del<ErrorBody>(`${CE}/${created.body.id}`);
    expect(delByStranger.status).toBe(403);
    expect(delByStranger.body.error).toBe('forbidden_scope');
    expect(delByStranger.body.details?.requiredScope).toBe('workspace:write');
    const listByStranger = await stranger.get<ErrorBody>(`${CE}?orgId=${encodeURIComponent(a.orgId)}`);
    expect(listByStranger.status).toBe(403);
    expect(listByStranger.body.details?.requiredScope).toBe('workspace:read');

    // Guard 2 — the TENANT-keyed store. An owner in ANOTHER tenant never reaches
    // the org check: the row is absent for them, the uniform no-existence-leak 404.
    const b = await ownerWithOrg('ce-iso-b');
    const delByB = await b.c.del<ErrorBody>(`${CE}/${created.body.id}`);
    expect(delByB.status).toBe(404);
    expect(delByB.body.message).toBe('Compat endpoint not found.');
    expect((await b.c.get<{ endpoints: Endpoint[] }>(`${CE}?orgId=${encodeURIComponent(b.orgId)}`)).body.endpoints).toEqual([]);

    // Positive control: A's endpoint is still there, and A can delete it.
    expect((await a.c.get<{ endpoints: Endpoint[] }>(`${CE}?orgId=${encodeURIComponent(a.orgId)}`)).body.endpoints.map((e) => e.id)).toEqual([created.body.id]);
    expect((await a.c.del(`${CE}/${created.body.id}`)).status).toBe(204);
  });
});

/**
 * CDP-H Phase 1 — self-service scoped API keys (ADR 0270). Issue returns the
 * plaintext token once; verifyApiKey (the auth-middleware seam) is fail-closed on
 * unknown/revoked/expired; management routes never leak the hash.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { verifyApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { createMember } from '../src/host/accessControlService.js';

let BASE: string; let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users'); if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: any }
function client() {
  let cookie = '';
  const call = async (m: string, p: string, b?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const mm = /(__session=[^;]+)/.exec(c); if (mm) cookie = mm[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), del: (p: string) => call('DELETE', p) };
}
let n = 0;
async function owner() { const c = client(); const r = await c.post('/v1/host/openwop-app/test/login', { email: `h-${Date.now()}-${n++}@a.test`, tenantId: `org:h-${Date.now()}-${n++}` }); expect(r.status).toBe(201); return c; }
/** Log in an explicit (subject, tenant) so two principals can share a tenant. Returns the
 *  client + the canonical caller subject (req.userId === user.userId post-login). */
async function loginAs(subject: string, tenantId: string) {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { subject, tenantId, email: `${subject}@a.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { c, userId: r.body.user.userId as string };
}
const KEYS_PATH = '/v1/host/openwop-app/developer-keys';

describe('CDP-H developer API keys', () => {
  it('issues a token once, verifies it, and never leaks the hash', async () => {
    const c = await owner();
    const issued = await c.post('/v1/host/openwop-app/developer-keys', { name: 'ci', scopes: ['runs:create', 'manifest:read'] });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const token = issued.body.token as string;
    expect(token.startsWith('owk_')).toBe(true);
    expect(issued.body.key.tokenHash).toBeUndefined(); // never returned

    const v = await verifyApiKey(token);
    expect(v).toBeTruthy();
    expect(v!.scopes).toEqual(['runs:create', 'manifest:read']);

    const list = await c.get('/v1/host/openwop-app/developer-keys');
    expect(list.body.keys.length).toBe(1);
    expect(list.body.keys[0].tokenHash).toBeUndefined();
  });

  it('verify is fail-closed: unknown, revoked, expired all → null', async () => {
    const c = await owner();
    expect(await verifyApiKey('owk_bogus')).toBeNull();
    expect(await verifyApiKey('not-even-prefixed')).toBeNull();

    // expired
    const exp = await c.post('/v1/host/openwop-app/developer-keys', { name: 'exp', expiresAt: '2000-01-01T00:00:00.000Z' });
    expect(await verifyApiKey(exp.body.token)).toBeNull();

    // revoked
    const live = await c.post('/v1/host/openwop-app/developer-keys', { name: 'live' });
    expect(await verifyApiKey(live.body.token)).toBeTruthy();
    const del = await c.del(`/v1/host/openwop-app/developer-keys/${live.body.key.keyId}`);
    expect(del.status).toBe(204);
    expect(await verifyApiKey(live.body.token)).toBeNull();
  });

  // ADR 0434 — the `developer-keys` toggle graduated to always-on. It had been
  // half-open and security-relevant: `verifyApiKey` already ran unconditionally in
  // core auth, so an OFF toggle left minted keys authenticating while removing the
  // operator's ability to REVOKE them. The real authority is (and always was) an
  // authenticated principal + `keyScopeOf`, pinned here and below.
  it('serves unconditionally — no toggle 404 (always-on)', async () => {
    const c = await owner();
    const r = await c.get(KEYS_PATH);
    expect(r.status).toBe(200);
    // The former OFF-leg asserted 404 here. Authority did not move: an
    // authenticated principal is still required to manage a key, and the
    // caller-scoping/IDOR contract is pinned by the self-service+admin case below.
  });

  // Self-service + admin oversight (ADR 0270, /architect-ruled). A non-admin co-tenant
  // member must NOT enumerate or revoke another member's keys (the closed IDOR); an
  // admin|owner may manage all.
  it('scopes list/revoke to the caller\'s own keys; admin sees + manages all', async () => {
    const T = `org:devkeys-authz-${Date.now()}`;
    const alice = await loginAs(`oidc:alice-${Date.now()}`, T);
    const bob = await loginAs(`oidc:bob-${Date.now()}`, T);

    // Alice self-issues a key (no role required — self-service)
    const issued = await alice.c.post(KEYS_PATH, { name: 'alice-key' });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const aliceKeyId = issued.body.key.keyId as string;
    expect(issued.body.key.createdBy).toBe(alice.userId);

    // Alice sees her own key; Bob (non-admin co-tenant) does NOT see it
    expect((await alice.c.get(KEYS_PATH)).body.keys.length).toBe(1);
    expect((await bob.c.get(KEYS_PATH)).body.keys.find((k: any) => k.keyId === aliceKeyId)).toBeUndefined();

    // Bob cannot revoke Alice's key → 404 (IDOR-safe, no existence leak); it stays live
    expect((await bob.c.del(`${KEYS_PATH}/${aliceKeyId}`)).status).toBe(404);
    expect((await alice.c.get(KEYS_PATH)).body.keys.length).toBe(1);

    // Promote Bob to tenant admin → he now sees every key and can revoke Alice's
    await createMember({ tenantId: T, orgId: T, subject: bob.userId, displayName: 'Bob', roles: ['admin'] });
    expect((await bob.c.get(KEYS_PATH)).body.keys.find((k: any) => k.keyId === aliceKeyId)).toBeTruthy();
    expect((await bob.c.del(`${KEYS_PATH}/${aliceKeyId}`)).status).toBe(204);
    // and the revoke stuck: Alice no longer lists a live key under it (it's revoked)
    expect((await alice.c.get(KEYS_PATH)).body.keys.find((k: any) => k.keyId === aliceKeyId)?.revokedAt).toBeTruthy();
  });
});

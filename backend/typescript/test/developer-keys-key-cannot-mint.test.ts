/**
 * ADR 0800 D1 — a key is a delegation, and a delegation must not be able to
 * widen itself or reach the other keys.
 *
 * MINT: `POST /developer-keys` only refused an ANONYMOUS principal, so a
 * "Read only" key (`workspace:read`) could mint a key that declared no scopes —
 * an un-narrowed one — and that key then created and read runs. The new key was
 * stamped `createdBy: apikey:<keyId>`, so it was absent from the delegating
 * user's own key list.
 *
 * LIST / REVOKE: the key's own subject went through `keyScopeOf`, and in DEMO
 * MODE an unknown subject on a single-principal tenant resolves to OWNER — so
 * the same read-only key listed and revoked every key in a personal workspace.
 *
 * Route-level: the `api-key` principal only exists after the real auth middleware.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { issueApiKey, listApiKeys } from '../src/features/developer-keys/apiKeyService.js';

const TENANT = 'adr0800-key-mint';
// Single-principal: the tenant shape the demo-mode owner fallback applies to.
const PERSONAL = 'user:adr0800personal';
const ENV_KEY = 'adr0800-operator-key';
const KEYS = '/host/openwop-app/developer-keys';
const ALL = { callerSubject: 'user:adr0800', isAdmin: true } as const;
let BASE = ''; let server: http.Server;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_AUTHORIZATION_ENFORCEMENT', 'OPENWOP_DEMO_MODE', 'OPENWOP_API_KEYS']) saved[k] = process.env[k];
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  // The production posture, both halves: RFC 0049 membership enforcement OFF
  // (the minted key's authority was unbounded) and demo mode ON (an unknown
  // subject is OWNER of a single-principal tenant).
  delete process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT;
  process.env.OPENWOP_DEMO_MODE = 'true';
  process.env.OPENWOP_API_KEYS = `${ENV_KEY}:${TENANT}`;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0800', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const call = (token: string, method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', connection: 'close' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

async function key(scopes?: string[], tenantId: string = TENANT): Promise<{ token: string; keyId: string }> {
  const out = await issueApiKey({ tenantId, name: 'adr0800', createdBy: 'user:adr0800', ...(scopes ? { scopes } : {}) });
  return { token: out.token, keyId: out.key.keyId };
}

describe('ADR 0800 D1 — an API key cannot mint API keys', () => {
  it.each([
    ['a read-only key', ['workspace:read']],
    ['a narrowed protocol key', ['runs:read']],
    ['an un-narrowed key', undefined],
  ])('%s is refused 403, and nothing is issued', async (_label, scopes) => {
    const { token } = await key(scopes);
    const before = (await listApiKeys(TENANT, ALL)).length;
    const res = await call(token, 'POST', KEYS, { name: 'wide' });
    const body = (await res.json()) as { error?: string; token?: string; details?: { code?: string } };
    expect(res.status, JSON.stringify(body)).toBe(403);
    expect(body.error).toBe('forbidden');
    expect(body.details?.code).toBe('key_cannot_manage_keys');
    expect(body.token).toBeUndefined();
    expect((await listApiKeys(TENANT, ALL)).length).toBe(before);
  });

  it('CONTROL: the operator env key still mints one (the refusal is about delegation, not bearers)', async () => {
    const res = await call(ENV_KEY, 'POST', KEYS, { name: 'operator-minted', scopes: ['runs:read'] });
    const body = (await res.json()) as { token?: string };
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body.token).toMatch(/^owk_/);
  });
});

describe('ADR 0800 D1 — an API key cannot list or revoke keys, even where demo mode makes its subject OWNER', () => {
  it('a read-only key in a personal workspace cannot list the workspace’s keys', async () => {
    await key(undefined, PERSONAL); // the owner's own key: what a leak would show
    const ro = await key(['workspace:read'], PERSONAL);
    const res = await call(ro.token, 'GET', KEYS);
    const body = (await res.json()) as { keys?: unknown[] };
    expect(res.status, JSON.stringify(body)).toBe(403);
    expect(body.keys).toBeUndefined();
  });

  it('…and cannot revoke the owner’s key: it is refused and the key stays live', async () => {
    const owners = await key(undefined, PERSONAL);
    const ro = await key(['workspace:read'], PERSONAL);
    const res = await call(ro.token, 'DELETE', `${KEYS}/${encodeURIComponent(owners.keyId)}`);
    expect(res.status).toBe(403);
    const still = (await listApiKeys(PERSONAL, ALL)).find((k) => k.keyId === owners.keyId);
    expect(still, 'the owner’s key must still exist').toBeDefined();
    expect(still!.revokedAt).toBeUndefined();
  });
});

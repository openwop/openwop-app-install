/**
 * ADR 0779 D1 (compat) + D2 + D3 — the Keys lane's write boundary, at the HTTP
 * boundary (the ADR 0711 harness and its three measured corrections: log in
 * with `sharedWorkspace: true`, membership in the workspace-ROOT org, member
 * rows created BEFORE login).
 *
 *  - D1: compat endpoints mint `compat-key:*` into the tenant key store, so an
 *    editor (`workspace:write`) is refused and an admin is admitted.
 *  - D2: a ref another lifecycle owns (`connection:*` OAuth token JSON,
 *    `subscription:*`, `compat-key:*`, …) is refused on POST, refused on DELETE
 *    without `?force=true`, and a forced delete is audited naming the owner.
 *  - D3: the create echo reveals at most the last four characters.
 *
 * Sabotage record (on committed code; each reds a disjoint leg):
 *   - drop the compat `host:byok:manage` line (POST)     → leg 1
 *   - drop the POST `systemOwnedRefOwner` refusal        → leg 2
 *   - drop the DELETE owned-ref 409                      → leg 3
 *   - drop `owner` from the force-delete audit payload   → leg 4
 *   - restore `first4…last4` masking                     → leg 5
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { listChain } from '../src/host/auditChainService.js';
import { configureKmsClient, createLocalAesKmsClient, _resetKmsForTesting } from '../src/byok/kmsEncryption.js';
import { randomBytes } from 'node:crypto';

const B = '/host/openwop-app/byok';
const CE = '/host/openwop-app/compat-endpoints';
let server: Server;
let BASE = '';
let WS = '';
const ADMIN = 'oidc:b779-admin';
const EDITOR = 'oidc:b779-editor';

async function login(subject: string, tenantId: string): Promise<string> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, tenantId, displayName: subject, sharedWorkspace: true }),
  });
  expect(res.status, 'test seam must mint a session').toBeLessThan(300);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function call(path: string, cookie: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
}

beforeAll(async () => {
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_COMPAT_PROVIDER_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  // A hermetic tenant KMS (the `byok-kms` recipe): without one a signed-in
  // tenant's write 500s — the ADR 0711 test's leg 7 never asserted its POST.
  configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes'));
  const ws = await createWorkspace({ name: 'ADR 0779 workspace', ownerSubject: 'oidc:b779-owner' });
  WS = ws.orgId ?? ws.tenantId;
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Admin', subject: userIdFor(WS, ADMIN), roles: ['admin'] });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Editor', subject: userIdFor(WS, EDITOR), roles: ['editor'] });
});

afterAll(async () => { _resetKmsForTesting(); await new Promise<void>((r) => server.close(() => r())); });

describe('ADR 0779 — the Keys lane write boundary', () => {
  it('leg 1: compat endpoints are BYOK-admin-class — an editor is refused naming the scope, an admin is admitted', async () => {
    const editor = await login(EDITOR, WS);
    const endpoint = { orgId: WS, label: 'vllm', baseUrl: 'https://vllm.example.com/v1', apiKey: 'k'.repeat(24) };
    const refused = await call(CE, editor, 'POST', endpoint);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(JSON.stringify(refused.body)).toContain('host:byok:manage');
    const admin = await login(ADMIN, WS);
    const made = await call(CE, admin, 'POST', endpoint);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    // The editor cannot remove it either (the delete is gated the same way).
    const del = await call(`${CE}/${made.body.id}`, editor, 'DELETE');
    expect(del.status, JSON.stringify(del.body)).toBe(403);
  });

  const OWNED = ['connection:c-1', 'connection-inbound:c-1', 'subscription:github.copilot', 'compat-key:compat-1', 'pm-peer:p-1', 'email-webhook:w-1', 'managed:openwop-free'];

  it('leg 2: POST refuses every system-owned namespace, naming the owner, and still accepts an ordinary ref', async () => {
    const admin = await login(ADMIN, WS);
    for (const ref of OWNED) {
      const res = await call(`${B}/secrets`, admin, 'POST', { credentialRef: ref, value: 'v'.repeat(24) });
      expect(res.status, `${ref} was accepted on the keys lane`).toBe(400);
      expect(typeof res.body?.details?.owner, JSON.stringify(res.body)).toBe('string');
    }
    const ok = await call(`${B}/secrets`, admin, 'POST', { credentialRef: 'byok:google', value: 'v'.repeat(24) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    // ADR 0556 §D — `auth:` stays writable (its rotation IS a write).
    const salt = await call(`${B}/secrets`, admin, 'POST', { credentialRef: 'auth:workload-identity-subject-salt', value: 's'.repeat(32) });
    expect(salt.status, JSON.stringify(salt.body)).toBe(201);
  });

  it('leg 3: DELETE of an owned ref is a 409 naming the owner unless forced', async () => {
    const admin = await login(ADMIN, WS);
    const res = await call(`${B}/secrets/${encodeURIComponent('connection:c-9')}`, admin, 'DELETE');
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body?.details?.owner).toBe('connections');
  });

  it('leg 4: a forced delete of an owned ref is audited, carrying the owner it overrode', async () => {
    const admin = await login(ADMIN, WS);
    const res = await call(`${B}/secrets/${encodeURIComponent('subscription:github.copilot')}?force=true`, admin, 'DELETE');
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    const entry = (await listChain(WS)).filter((e) => e.kind === 'byok.secret.force_deleted').at(-1);
    expect((entry?.payload as Record<string, unknown> | undefined)?.owner).toBe('subscription credentials');
  });

  it('leg 5: the create echo shows at most the last four characters', async () => {
    const admin = await login(ADMIN, WS);
    const short = await call(`${B}/secrets`, admin, 'POST', { credentialRef: 'b779-short', value: 'abcdefghi' });
    expect(short.status).toBe(201);
    expect(short.body.masked).toBe('••••');
    const long = 'sk-FIRSTxxxxxxxxxxxxxxxLAST';
    const res = await call(`${B}/secrets`, admin, 'POST', { credentialRef: 'b779-long', value: long });
    expect(res.status).toBe(201);
    expect(res.body.masked).toBe('…LAST');
    expect(res.body.masked).not.toContain('sk-F');
  });
});

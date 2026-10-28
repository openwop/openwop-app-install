/**
 * ADR 0821 D5 (architect #8) — the "use my key for background AI" opt-in
 * (`preferForText` on the ADR 0110 headless-default row) over the HTTP boundary
 * the BYOK settings UI uses: `PUT`/`GET /byok/ai-default`.
 *
 * `byok-ai-default-route.test.ts` could not cover a happy-path save (no tenant
 * KMS in its harness), so the flag's ROUND-TRIP was only service-tested. This
 * file installs the hermetic local-AES KMS stub (the `byok-kms.test.ts` recipe)
 * and stores a real secret in a `ws:` workspace, so the save is the real one.
 *
 * Authority uses the ADR 0554 §P3 harness (`adr0711-byok-operator-gate`):
 * `sharedWorkspace: true`, membership in the workspace-root org, created BEFORE
 * login. Pins:
 *   - an ADMIN saves `preferForText: true` and reads it back; saving without it
 *     turns it OFF again (the UI always sends the switch's state);
 *   - an EDITOR (a real member: the ungated GET answers 200) is refused the write
 *     with a 403 naming `host:byok:manage`, and the stored opt-in is unchanged;
 *   - a non-boolean value is a 400, never a coerced opt-in.
 * Tracker: TST-BNC-4.
 *
 * Red when (wave 60 probes w60g4-prefer-*): any value other than `true` (or an
 * omitted one) stores the opt-in; a non-boolean is accepted; an editor may write.
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { setSecret } from '../src/byok/secretResolver.js';
import { configureKmsClient, createLocalAesKmsClient, _resetKmsForTesting } from '../src/byok/kmsEncryption.js';

const AID = '/host/openwop-app/byok/ai-default';
const ADMIN = 'oidc:prefer-admin';
const EDITOR = 'oidc:prefer-editor';
const REF = 'gem-0821';
let server: Server;
let BASE = '';
let WS = '';

async function login(subject: string, tenantId: string): Promise<string> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, tenantId, displayName: subject, sharedWorkspace: true }),
  });
  expect(res.status, 'test seam must mint a session').toBeLessThan(300);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}
function call(cookie: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${AID}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function stored(cookie: string): Promise<{ preferForText?: boolean } | null> {
  return ((await (await call(cookie, 'GET')).json()) as { default: { preferForText?: boolean } | null }).default;
}
const binding = { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: REF };

const ENV_KEYS = ['OPENWOP_STORAGE_DSN', 'OPENWOP_SESSION_SECRET', 'OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_AUTH_DISABLE_COOKIES'] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes'));
  const ws = await createWorkspace({ name: 'ADR 0821 D5 workspace', ownerSubject: 'oidc:prefer-owner' });
  WS = ws.orgId ?? ws.tenantId;
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Admin', subject: userIdFor(WS, ADMIN), roles: ['admin'] });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Editor', subject: userIdFor(WS, EDITOR), roles: ['editor'] });
  await setSecret(REF, 'AIza-test-0821', { tenantId: WS });
});

afterAll(async () => {
  _resetKmsForTesting();
  for (const k of ENV_KEYS) { const v = savedEnv[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((r) => server.close(() => r()));
});

describe('ADR 0821 D5 — the background-AI opt-in over HTTP', () => {
  it('an ADMIN saves the opt-in ON and reads it back; saving without it turns it OFF', async () => {
    const admin = await login(ADMIN, WS);
    const on = await call(admin, 'PUT', { ...binding, preferForText: true });
    expect(on.status, await on.clone().text()).toBe(200);
    expect(((await on.json()) as { default: { preferForText?: boolean } }).default.preferForText).toBe(true);
    expect((await stored(admin))?.preferForText).toBe(true);

    const off = await call(admin, 'PUT', { ...binding, preferForText: false });
    expect(off.status).toBe(200);
    expect((await stored(admin))?.preferForText).toBeUndefined();

    // Saving WITHOUT the field (the header's claim) also turns it off.
    expect((await call(admin, 'PUT', { ...binding, preferForText: true })).status).toBe(200);
    expect((await stored(admin))?.preferForText).toBe(true);
    const omitted = await call(admin, 'PUT', binding);
    expect(omitted.status).toBe(200);
    expect((await stored(admin))?.preferForText).toBeUndefined();
  });

  it('an EDITOR (a real member) is refused the write, and the stored opt-in is unchanged', async () => {
    const admin = await login(ADMIN, WS);
    expect((await call(admin, 'PUT', { ...binding, preferForText: true })).status).toBe(200);

    const editor = await login(EDITOR, WS);
    expect((await call(editor, 'GET')).status, 'fixture honesty: the editor can read').toBe(200);
    const res = await call(editor, 'PUT', { ...binding, preferForText: false });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('host:byok:manage');
    expect((await stored(admin))?.preferForText).toBe(true);
  });

  it('a non-boolean opt-in is a 400, never a coerced ON', async () => {
    const admin = await login(ADMIN, WS);
    expect((await call(admin, 'PUT', { ...binding, preferForText: false })).status).toBe(200);
    const res = await call(admin, 'PUT', { ...binding, preferForText: 'yes' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'validation_error', details: { field: 'preferForText' } });
    expect((await stored(admin))?.preferForText, 'the refused write stored nothing').toBeUndefined();
  });
});

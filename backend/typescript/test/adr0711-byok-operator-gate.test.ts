/**
 * ADR 0711 — BYOK writes in a SHARED workspace are admin-class, and a
 * `?force=true` secret delete is audited on its own.
 *
 * WHY THIS IS A ROUTE TEST AND NOT A SERVICE TEST. The defect was never in
 * `secretResolver`; it was that the ROUTE asked only "are you signed in?".
 * Authorization, and the personal-workspace short-circuit that makes the gate
 * safe for solo users, are both observable only at the HTTP boundary. A
 * service-level test would have passed against the vulnerable code.
 *
 * The harness is the ADR 0554 §P3 recipe proven in `kicktodo-authz-http.test.ts`,
 * and its three measured corrections apply here unchanged:
 *   1. log in with `sharedWorkspace: true`, or the seam collapses `personalTenant`
 *      onto the tenant, `isOwnPersonalWorkspace` goes true, and the gate
 *      short-circuits BEFORE membership is consulted — a green that proves nothing;
 *   2. membership must be in the workspace-ROOT org (`orgId === tenantId`);
 *   3. the member row must exist BEFORE login — membership is evaluated at mint.
 *
 * Sabotage record (each removal reds a DISJOINT set — never "the change"):
 *   - drop the gate on POST /secrets            → leg 2 only
 *   - drop the gate on DELETE /secrets/:ref     → leg 3 only
 *   - drop the gate on PUT /active-config       → leg 4 only
 *   - drop the gate on DELETE /active-config    → leg 5 only
 *   - drop the `if (force)` audit append        → leg 7 only
 *   - move the audit inside a `!force` branch   → leg 7 only
 *   - gate the READ route too                   → leg 6 only
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { listChain } from '../src/host/auditChainService.js';

const B = '/v1/host/openwop-app/byok';
let server: Server;
let BASE = '';
let WS = '';
const ADMIN = 'oidc:byok-admin';
const EDITOR = 'oidc:byok-editor';

async function login(subject: string, tenantId: string): Promise<string> {
  const res = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, tenantId, displayName: subject, sharedWorkspace: true }),
  });
  expect(res.status, 'test seam must mint a session').toBeLessThan(300);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

function call(path: string, cookie: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  const ws = await createWorkspace({ name: 'ADR 0711 workspace', ownerSubject: 'oidc:byok-owner' });
  WS = ws.orgId ?? ws.tenantId;
  // Membership BEFORE login (correction 3), in the workspace-root org (correction 2).
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Admin', subject: userIdFor(WS, ADMIN), roles: ['admin'] });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Editor', subject: userIdFor(WS, EDITOR), roles: ['editor'] });
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('ADR 0711 — BYOK writes are admin-class in a shared workspace', () => {
  it('leg 1: the fixture is honest — an editor IS a member, so a refusal is the GATE, not absence', async () => {
    const editor = await login(EDITOR, WS);
    const read = await call(`${B}/secrets`, editor);
    // The read route is NOT gated, so a member reaching it proves the session is
    // real and scoped to WS. Without this, every 403 below could be a non-member
    // artifact — the "green for the wrong reason" failure the recipe warns about.
    expect(read.status, 'an editor member must reach the ungated READ route').toBe(200);
  });

  const WRITES: ReadonlyArray<[string, string, string, unknown?]> = [
    ['leg 2', 'POST',   `${B}/secrets`,       { credentialRef: 'adr0711-probe', value: 'x' }],
    ['leg 3', 'DELETE', `${B}/secrets/adr0711-probe`],
    ['leg 4', 'PUT',    `${B}/active-config`, { provider: 'anthropic', model: 'claude-opus-5', credentialRef: 'adr0711-probe' }],
    ['leg 5', 'DELETE', `${B}/active-config`],
  ];

  for (const [leg, method, path, body] of WRITES) {
    it(`${leg}: ${method} ${path.replace(B, '')} refuses an editor 403 and names the scope`, async () => {
      const editor = await login(EDITOR, WS);
      const res = await call(path, editor, method, body);
      expect(res.status, `${method} ${path} admitted an editor — the ADR 0711 gate is not in force`).toBe(403);
      // Assert the BODY names the scope: a 403 from some unrelated guard would
      // otherwise pass this leg and prove nothing about THIS gate.
      const text = await res.text();
      expect(text, `the 403 body must name host:byok:manage (got ${text})`).toContain('host:byok:manage');
    });
  }

  it('leg 6: an ADMIN is admitted through every write route (the gate is not a blanket denial)', async () => {
    const admin = await login(ADMIN, WS);
    for (const [, method, path, body] of WRITES) {
      const res = await call(path, admin, method, body);
      expect([401, 403], `${method} ${path} refused an ADMIN — the gate is over-tight`).not.toContain(res.status);
    }
  });

  it('leg 7: a ?force=true delete writes its own audit record, carrying what it overrode', async () => {
    const admin = await login(ADMIN, WS);
    await call(`${B}/secrets`, admin, 'POST', { credentialRef: 'adr0711-force', value: 'x' });
    // Count entries OF THIS KIND, not chain length. The chain lazily writes a
    // genesis entry on its first append, so `length` moves by 2 on the first
    // override and by 1 thereafter — an assertion on total length is a function
    // of test ORDER, which is exactly the kind of gate that passes for the wrong
    // reason later. Measured: 0 -> 2 on the first force delete in a fresh tenant.
    const forceCount = async (): Promise<number> =>
      (await listChain(WS)).filter((e) => e.kind === 'byok.secret.force_deleted').length;
    const before = await forceCount();

    const res = await call(`${B}/secrets/adr0711-force?force=true`, admin, 'DELETE');
    expect(res.status, 'force delete by an admin must succeed').toBe(204);

    expect(await forceCount(), 'the force override must append exactly one audit entry').toBe(before + 1);
    const entries = await listChain(WS);
    const entry = entries.filter((e) => e.kind === 'byok.secret.force_deleted').at(-1)!;
    const payload = entry.payload as Record<string, unknown>;
    expect(payload.credentialRef).toBe('adr0711-force');
    // `referencesKnown` is what the guard WOULD have said. Recording only "a force
    // happened" would leave the reader unable to tell an override of a real
    // conflict from one that skipped nothing.
    expect(payload, 'the record must carry what was overridden').toHaveProperty('referencesKnown');
  });

  it('leg 8: a delete WITHOUT force appends nothing — the override is the event, not the delete', async () => {
    const admin = await login(ADMIN, WS);
    await call(`${B}/secrets`, admin, 'POST', { credentialRef: 'adr0711-plain', value: 'x' });
    const forceCount = async (): Promise<number> =>
      (await listChain(WS)).filter((e) => e.kind === 'byok.secret.force_deleted').length;
    const before = await forceCount();
    await call(`${B}/secrets/adr0711-plain`, admin, 'DELETE');
    expect(await forceCount(), 'a non-force delete must NOT write a force-override record').toBe(before);
  });
});

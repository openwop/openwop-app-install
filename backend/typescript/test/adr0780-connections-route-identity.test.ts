/**
 * ADR 0780 D2 correction (grade-code `CONNCD-16`) — the ROUTE half of the
 * principal-alias rule, at the HTTP boundary.
 *
 * Principal ids are not issuer-qualified: user X, homed in H with principal
 * `scim:jsmith` from IdP A, switches into shared workspace T, which holds a legacy
 * connection keyed `scim:jsmith` belonging to T's OWN jsmith (IdP B). `callerOwnerIds`
 * must add X's principal only in X's HOME tenant — in T, X can neither list nor
 * revoke that row. In H the alias still holds (the #4215 contract).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/index.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { configureKmsClient, createLocalAesKmsClient, _resetKmsForTesting } from '../src/byok/kmsEncryption.js';
import { createSecretConnection, getConnection } from '../src/features/connections/connectionsService.js';

const C = '/host/openwop-app/connections';
const PRINCIPAL = 'scim:jsmith';
const HOME = 'user:b780-route-home-x';
let server: Server;
let BASE = '';
let T = '';

function cookieOf(res: Response, prev = ''): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0] || prev;
}

async function call(path: string, cookie: string, method = 'GET'): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { cookie } });
  return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
}

beforeAll(async () => {
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes'));
  const ws = await createWorkspace({ name: 'ADR 0780 route identity', ownerSubject: 'oidc:b780-route-owner' });
  T = ws.orgId ?? ws.tenantId;
  // X is an editor of T, keyed by X's canonical (HOME) user id.
  await createMember({ orgId: T, tenantId: T, displayName: 'X', subject: userIdFor(HOME, PRINCIPAL), roles: ['editor'] });
});

afterAll(async () => { _resetKmsForTesting(); await new Promise<void>((r) => server.close(() => r())); });

async function loginHomeThenSwitch(target?: string): Promise<string> {
  const login = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject: PRINCIPAL, tenantId: HOME, displayName: 'X' }),
  });
  expect(login.status).toBeLessThan(300);
  let cookie = cookieOf(login);
  if (target) {
    const sw = await fetch(`${BASE}/host/openwop-app/workspaces/${encodeURIComponent(target)}/switch`, { method: 'POST', headers: { cookie } });
    expect(sw.status, await sw.clone().text()).toBeLessThan(300);
    cookie = cookieOf(sw, cookie);
  }
  return cookie;
}

describe('ADR 0780 D2 correction — callerOwnerIds is home-tenant-only (CONNCD-16)', () => {
  it('in a SHARED workspace, X can neither list nor revoke T\'s own `scim:jsmith` row', async () => {
    const theirs = await createSecretConnection({ tenantId: T, provider: 'heygen', kind: 'api_key', secret: 'hg-t-jsmith-route', scope: 'user', userId: PRINCIPAL });
    const x = await loginHomeThenSwitch(T);
    const listed = await call(C, x);
    expect(listed.status).toBe(200);
    expect((listed.body.connections as Array<{ connectionId: string }>).some((c) => c.connectionId === theirs.connectionId), 'X must not see T\'s jsmith').toBe(false);
    expect((await call(`${C}/${encodeURIComponent(theirs.connectionId)}`, x, 'DELETE')).status).toBe(403);
    expect(await getConnection(T, theirs.connectionId)).not.toBeNull();
  });

  it('in X\'s HOME tenant the legacy spelling is still X\'s own (the #4215 contract)', async () => {
    const mine = await createSecretConnection({ tenantId: HOME, provider: 'heygen', kind: 'api_key', secret: 'hg-home-x-route1', scope: 'user', userId: PRINCIPAL });
    const x = await loginHomeThenSwitch();
    const listed = await call(C, x);
    expect((listed.body.connections as Array<{ connectionId: string }>).some((c) => c.connectionId === mine.connectionId)).toBe(true);
    expect((await call(`${C}/${encodeURIComponent(mine.connectionId)}`, x, 'DELETE')).status).toBe(204);
  });
});

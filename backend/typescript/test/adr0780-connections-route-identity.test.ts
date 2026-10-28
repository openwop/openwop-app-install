/**
 * ADR 0780 D2 correction (grade-code `CONNCD-16`) — the ROUTE half of the
 * principal-alias rule, at the HTTP boundary.
 *
 * Principal ids are not issuer-qualified: user X, homed in H with principal
 * `scim:jsmith` from IdP A, switches into shared workspace T, which holds a legacy
 * connection keyed `scim:jsmith` belonging to T's OWN jsmith (IdP B). `callerOwnerIds`
 * must add X's principal only in X's HOME tenant — in T, X can neither list nor
 * revoke that row. In H the alias still holds (the #4215 contract).
 *
 * Tracker: TST-BCN-2 (/grade-tests wave 60). `callerOwnerIds` is a separate copy
 * of the home-tenant rule from the broker's `actingUserIds` (covered by
 * adr0780-connections-broker legs 7/7b). Probe-witnessed:
 *   - red when `callerOwnerIds` aliases the principal outside the home tenant → case 1
 *   - red when `callerOwnerIds` drops the home-tenant alias                    → case 2
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

async function call(path: string, cookie: string, method = 'GET'): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { cookie } });
  const parsed: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  return { status: res.status, body: parsed };
}

/** Read a nested field of an untyped JSON body, without a cast. */
function field(value: unknown, ...path: string[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = Reflect.get(cur, key);
  }
  return cur;
}

/** A string field, or '' (so a missing id fails the next assertion, not a type check). */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The `connectionId`s of a `GET /connections` body. */
function connectionIds(body: unknown): string[] {
  const rows = field(body, 'connections');
  return Array.isArray(rows) ? rows.map((r: unknown) => text(field(r, 'connectionId'))) : [];
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
    expect(connectionIds(listed.body).includes(theirs.connectionId), 'X must not see T\'s jsmith').toBe(false);
    const del = await call(`${C}/${encodeURIComponent(theirs.connectionId)}`, x, 'DELETE');
    expect(del.status).toBe(403);
    expect(field(del.body, 'message')).toBe('Only the connecting user may manage this connection.');
    expect(await getConnection(T, theirs.connectionId)).not.toBeNull();
  });

  it('in X\'s HOME tenant the legacy spelling is still X\'s own (the #4215 contract)', async () => {
    const mine = await createSecretConnection({ tenantId: HOME, provider: 'heygen', kind: 'api_key', secret: 'hg-home-x-route1', scope: 'user', userId: PRINCIPAL });
    const x = await loginHomeThenSwitch();
    const listed = await call(C, x);
    expect(listed.status).toBe(200);
    expect(connectionIds(listed.body).includes(mine.connectionId)).toBe(true);
    expect((await call(`${C}/${encodeURIComponent(mine.connectionId)}`, x, 'DELETE')).status).toBe(204);
    expect(await getConnection(HOME, mine.connectionId), 'the revoke must have removed the row').toBeNull();
  });
});

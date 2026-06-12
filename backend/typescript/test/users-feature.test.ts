/**
 * Users & Authentication feature — service-level tests (ADR 0002, Phase 1).
 *
 * Verifies the identity invariants the ADR's architect findings make binding:
 *   - upsertFromPrincipal is idempotent + STABLE across logins (finding C4):
 *     same (tenant, principal) => same userId; never a second record.
 *   - raw IdP groups are captured, NOT mapped to roles (finding H6 boundary).
 *   - the lifecycle is FAIL-CLOSED (finding H5): disable => isActiveUser false;
 *     a re-login does NOT silently re-activate a disabled user.
 *   - tenant isolation: one tenant never sees another's users.
 * Mirrors test/host-ext-durability.test.ts: a real sqlite Storage wired via
 * initHostExtPersistence, since the store is read-through DurableCollection.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  __resetUsersStore,
  createUser,
  getUser,
  getUserByPrincipal,
  isActiveUser,
  listUsers,
  resolveCanonicalUserForTenant,
  setUserStatus,
  updateUser,
  upsertFromPrincipal,
} from '../src/features/users/usersService.js';

const dir = mkdtempSync(join(tmpdir(), 'owop-users-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('users service: identity reconciliation', () => {
  beforeEach(async () => {
    __resetHostExtPersistence();
    initHostExtPersistence(openSqliteStorage(join(dir, 'users.db')));
    await __resetUsersStore();
  });

  it('upsertFromPrincipal is idempotent + stable across logins (finding C4)', async () => {
    const first = await upsertFromPrincipal({ tenantId: 'acme', principalId: 'oidc:sub-1', email: 'a@acme.test' });
    expect(first.userId).toMatch(/^user:/);
    expect(first.source).toBe('oidc');

    // "Second login": refreshes profile/groups but keeps the SAME userId.
    const second = await upsertFromPrincipal({
      tenantId: 'acme',
      principalId: 'oidc:sub-1',
      email: 'a2@acme.test',
      groups: ['eng', 'admins'],
    });
    expect(second.userId).toBe(first.userId); // stable — never re-minted
    expect(second.email).toBe('a2@acme.test');
    expect(second.groups).toEqual(['eng', 'admins']);
    expect(await listUsers('acme')).toHaveLength(1); // exactly one record
  });

  it('canonicalizes a personal tenant onto ONE user across auth channels (2026-06-12 identity-split fix)', async () => {
    const home = 'user:abc123'; // a single-human personal tenant
    const viaOidc = await resolveCanonicalUserForTenant({ homeTenant: home, principalId: 'oidc:sub-x', source: 'oidc' });
    // A bound user-tier cookie presents `user:<userId>` — a DIFFERENT principal
    // for the SAME human. It MUST resolve to the same durable user.
    const viaCookie = await resolveCanonicalUserForTenant({ homeTenant: home, principalId: `user:${viaOidc.userId}`, source: 'oidc' });
    expect(viaCookie.userId).toBe(viaOidc.userId);
    expect(await listUsers(home)).toHaveLength(1); // exactly one record, not one-per-channel
  });

  it('reconciles a pre-existing split: two rows in a personal tenant converge on the oidc record', async () => {
    const home = 'user:split1';
    // The prod artifact: a legacy session/manual user AND the real oidc user,
    // both already in the personal tenant (the bug that hid the pin).
    const manual = await createUser({ tenantId: home, principalId: 'session:sid-legacy', source: 'manual' });
    const oidc = await createUser({ tenantId: home, principalId: 'oidc:sub-real', source: 'oidc' });
    expect(await listUsers(home)).toHaveLength(2);
    // Canonical resolution adopts the FEDERATED (oidc) record — the one that holds
    // the user's profile/pins — regardless of which channel asks.
    const a = await resolveCanonicalUserForTenant({ homeTenant: home, principalId: 'oidc:sub-real', source: 'oidc' });
    const b = await resolveCanonicalUserForTenant({ homeTenant: home, principalId: `user:${manual.userId}`, source: 'oidc' });
    expect(a.userId).toBe(oidc.userId);
    expect(b.userId).toBe(oidc.userId); // both channels → the oidc record
    expect(a.userId).not.toBe(manual.userId);
  });

  it('captures raw IdP groups verbatim and assigns no role (boundary H6)', async () => {
    const u = await upsertFromPrincipal({ tenantId: 't', principalId: 'saml:nameid-9', groups: ['Finance', 'Approvers'], source: 'saml' });
    expect(u.groups).toEqual(['Finance', 'Approvers']);
    // The record carries identity + groups only — there is no `role`/`permissions`
    // field on a User; that is ADR 0005's surface.
    expect(u).not.toHaveProperty('role');
    expect(u).not.toHaveProperty('permissions');
  });

  it('createUser is idempotent per (tenant, principal)', async () => {
    const a = await createUser({ tenantId: 't', principalId: 'p1' });
    const b = await createUser({ tenantId: 't', principalId: 'p1' });
    expect(b.userId).toBe(a.userId);
    expect(await listUsers('t')).toHaveLength(1);
  });

  // Concurrency: the unindexed get-then-put would race to two random ids. With a
  // DETERMINISTIC userId, parallel first-access converges to one row.
  it('createUser converges to ONE row under concurrent first-access (deterministic id)', async () => {
    const results = await Promise.all([
      createUser({ tenantId: 't', principalId: 'oidc:race' }),
      createUser({ tenantId: 't', principalId: 'oidc:race' }),
      createUser({ tenantId: 't', principalId: 'oidc:race' }),
    ]);
    expect(new Set(results.map((u) => u.userId)).size).toBe(1); // all the same id
    expect(await listUsers('t')).toHaveLength(1); // exactly one stored row
  });
});

describe('users service: reconcilable-principal guard (no transient minting)', () => {
  it('refuses non-durable shapes; maps durable shapes to their source', async () => {
    const { reconcilableSource } = await import('../src/features/users/usersGuards.js');
    // Transient / unknown → null (resolveCallerUser turns this into a 401, so a
    // `session:<sid>` principal never becomes a durable User).
    expect(reconcilableSource('session:abc')).toBeNull();
    expect(reconcilableSource('bearer:xyz')).toBeNull();
    expect(reconcilableSource('anon:sid')).toBeNull();
    // Durable shapes → their source.
    expect(reconcilableSource('oidc:sub')).toBe('oidc');
    expect(reconcilableSource('password:a@b.test')).toBe('password');
    expect(reconcilableSource('saml:nameid')).toBe('saml');
    expect(reconcilableSource('scim:user')).toBe('scim');
    expect(reconcilableSource('user:uuid')).toBe('oidc');
  });
});

describe('users service: fail-closed lifecycle (finding H5)', () => {
  beforeEach(async () => {
    __resetHostExtPersistence();
    initHostExtPersistence(openSqliteStorage(join(dir, 'lifecycle.db')));
    await __resetUsersStore();
  });

  it('disable denies; an unknown principal is denied; enable restores', async () => {
    const u = await upsertFromPrincipal({ tenantId: 't', principalId: 'p1' });
    expect(await isActiveUser('t', 'p1')).toBe(true);
    expect(await isActiveUser('t', 'ghost')).toBe(false); // unknown => denied

    await setUserStatus(u.userId, 'disabled');
    expect(await isActiveUser('t', 'p1')).toBe(false); // fail-closed

    // A re-login MUST NOT silently re-activate a disabled user.
    const relogin = await upsertFromPrincipal({ tenantId: 't', principalId: 'p1', email: 'x@t.test' });
    expect(relogin.status).toBe('disabled');
    expect(await isActiveUser('t', 'p1')).toBe(false);

    // Only the explicit lifecycle call re-enables.
    await setUserStatus(u.userId, 'active');
    expect(await isActiveUser('t', 'p1')).toBe(true);
  });
});

describe('users service: tenant isolation + profile edits', () => {
  beforeEach(async () => {
    __resetHostExtPersistence();
    initHostExtPersistence(openSqliteStorage(join(dir, 'isolation.db')));
    await __resetUsersStore();
  });

  it('a tenant never sees another tenant’s users', async () => {
    await upsertFromPrincipal({ tenantId: 'acme', principalId: 'p1' });
    await upsertFromPrincipal({ tenantId: 'globex', principalId: 'p1' }); // same principal id, different tenant
    expect(await listUsers('acme')).toHaveLength(1);
    expect(await listUsers('globex')).toHaveLength(1);
    expect(await getUserByPrincipal('acme', 'p1')).not.toBeNull();
    const acmeUser = await getUserByPrincipal('acme', 'p1');
    const globexUser = await getUserByPrincipal('globex', 'p1');
    expect(acmeUser!.userId).not.toBe(globexUser!.userId); // distinct records
  });

  it('updateUser edits profile fields and clears on null/empty', async () => {
    const u = await createUser({ tenantId: 't', principalId: 'p1', email: 'old@t.test', displayName: 'Old' });
    const updated = await updateUser(u.userId, { email: 'new@t.test', displayName: null, groups: ['g1'] });
    expect(updated!.email).toBe('new@t.test');
    expect(updated).not.toHaveProperty('displayName'); // cleared
    expect(updated!.groups).toEqual(['g1']);
    expect((await getUser(u.userId))!.email).toBe('new@t.test'); // persisted
  });
});

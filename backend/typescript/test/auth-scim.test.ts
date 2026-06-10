/**
 * SCIM provisioning — RFC 0050 §B (ADR 0002, Phase 4).
 *
 * Proves the §B MUST behaviors non-vacuously (the justification for advertising
 * `openwop-auth-scim` — finding C1):
 *  - create-user upserts an RFC 0048 principal the host can resolve;
 *  - assign-group records SCIM group membership on the principal (role
 *    membership; role resolution is ADR 0005 — finding H6);
 *  - deactivate-user is FAIL-CLOSED: the principal no longer resolves to an
 *    active identity (finding H5 / RFC 0049 §C);
 *  - the principal id is stable across joiner/mover/leaver (finding C4) and
 *    SCIM shares the durable User store with SSO/password identities.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __resetUsersStore, createUser, getUserByPrincipal } from '../src/features/users/usersService.js';
import {
  assignGroup,
  deactivateUser,
  isPrincipalResolvable,
  provisionUser,
  resolveScimUser,
  scimUserNameOf,
  setScimActive,
} from '../src/host/auth/scimProvisioningService.js';

const dir = mkdtempSync(join(tmpdir(), 'owop-scim-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('SCIM provisioning (RFC 0050 §B)', () => {
  beforeEach(async () => {
    __resetHostExtPersistence();
    initHostExtPersistence(openSqliteStorage(join(dir, 'scim.db')));
    await __resetUsersStore();
  });

  it('create-user upserts a resolvable RFC 0048 principal (source=scim)', async () => {
    const p = await provisionUser({ tenantId: 't', userName: 'Joiner@acme.test', email: 'joiner@acme.test', displayName: 'Joiner' });
    expect(p.principalId).toBe('scim:joiner@acme.test'); // normalized + stable
    expect(p.source).toBe('scim');
    expect(await isPrincipalResolvable('t', 'joiner@acme.test')).toBe(true);
    // idempotent: re-provision returns the SAME record (mover, not a duplicate)
    const again = await provisionUser({ tenantId: 't', userName: 'joiner@acme.test', displayName: 'Joiner Renamed' });
    expect(again.userId).toBe(p.userId);
    expect(again.displayName).toBe('Joiner Renamed');
  });

  it('assign-group records membership idempotently', async () => {
    await provisionUser({ tenantId: 't', userName: 'u@t.test' });
    const a = await assignGroup({ tenantId: 't', userName: 'u@t.test', group: 'Engineers' });
    expect(a!.groups).toEqual(['Engineers']);
    const b = await assignGroup({ tenantId: 't', userName: 'u@t.test', group: 'Engineers' }); // dup
    expect(b!.groups).toEqual(['Engineers']);
    expect(await assignGroup({ tenantId: 't', userName: 'ghost@t.test', group: 'X' })).toBeNull(); // unknown user
  });

  it('deactivate-user is fail-closed: the principal stops resolving', async () => {
    await provisionUser({ tenantId: 't', userName: 'leaver@t.test' });
    expect(await isPrincipalResolvable('t', 'leaver@t.test')).toBe(true);
    const d = await deactivateUser({ tenantId: 't', userName: 'leaver@t.test' });
    expect(d!.status).toBe('disabled');
    expect(await isPrincipalResolvable('t', 'leaver@t.test')).toBe(false); // RFC 0050 §B fail-closed
    // re-provision (mover) does NOT silently reactivate a leaver
    await provisionUser({ tenantId: 't', userName: 'leaver@t.test', displayName: 'Back?' });
    expect(await isPrincipalResolvable('t', 'leaver@t.test')).toBe(false);
  });

  it('resolveScimUser addresses a user by durable id OR userName (finding #4)', async () => {
    const p = await provisionUser({ tenantId: 't', userName: 'jane@t.test' });
    // by the durable id returned from create (what a compliant IdP stores + re-sends)
    expect((await resolveScimUser('t', p.userId))!.userId).toBe(p.userId);
    // by the SCIM userName
    expect((await resolveScimUser('t', 'jane@t.test'))!.userId).toBe(p.userId);
    // tenant-scoped: another tenant can't resolve it by id
    expect(await resolveScimUser('other', p.userId)).toBeNull();
  });

  it('resolveScimUser only manages SCIM-sourced users (finding #5)', async () => {
    // a password/OIDC user in the SAME tenant must NOT be resolvable via SCIM,
    // else a SCIM bearer could deactivate accounts it never provisioned.
    const pw = await createUser({ tenantId: 't', principalId: 'password:vip@t.test', source: 'password' });
    expect(await resolveScimUser('t', pw.userId)).toBeNull(); // by durable id
    expect(await resolveScimUser('t', 'vip@t.test')).toBeNull(); // by name
    // a genuinely SCIM-provisioned user IS resolvable
    const scim = await provisionUser({ tenantId: 't', userName: 'scim@t.test' });
    expect((await resolveScimUser('t', scim.userId))!.userId).toBe(scim.userId);
  });

  it('scimUserNameOf returns the real userName, not the durable id (finding #8)', async () => {
    const p = await provisionUser({ tenantId: 't', userName: 'Echo@t.test' });
    expect(scimUserNameOf(p)).toBe('echo@t.test'); // normalized, not p.userId
  });

  it('setScimActive reactivates a deactivated user (finding #5)', async () => {
    const p = await provisionUser({ tenantId: 't', userName: 'rehire@t.test' });
    await deactivateUser({ tenantId: 't', userName: 'rehire@t.test' });
    expect(await isPrincipalResolvable('t', 'rehire@t.test')).toBe(false);
    // explicit reactivate (PATCH active:true path) flips it back — provisionUser would NOT
    const user = (await resolveScimUser('t', p.userId))!;
    const re = await setScimActive(user, true);
    expect(re!.status).toBe('active');
    expect(await isPrincipalResolvable('t', 'rehire@t.test')).toBe(true);
  });

  it('SCIM principals share the durable User store + tenant isolation', async () => {
    await provisionUser({ tenantId: 'acme', userName: 'same@x.test' });
    await provisionUser({ tenantId: 'globex', userName: 'same@x.test' });
    expect((await getUserByPrincipal('acme', 'scim:same@x.test'))!.tenantId).toBe('acme');
    expect((await getUserByPrincipal('globex', 'scim:same@x.test'))!.tenantId).toBe('globex');
    await deactivateUser({ tenantId: 'acme', userName: 'same@x.test' });
    expect(await isPrincipalResolvable('acme', 'same@x.test')).toBe(false);
    expect(await isPrincipalResolvable('globex', 'same@x.test')).toBe(true); // isolation
  });
});

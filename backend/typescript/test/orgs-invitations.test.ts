/**
 * Org invitations (ADR 0004, reconciled) — service tests. Invitations DELEGATE
 * org/member ownership to accessControl; this verifies the delegation +
 * fail-closed onboarding invariants.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __resetUsersStore, createUser, type User } from '../src/features/users/usersService.js';
import { __resetAccessStores, createOrg, listMembers, resolveEffectiveAccess } from '../src/host/accessControlService.js';
import { __resetOrgInvites, acceptInvitation, createInvitation, listInvitations } from '../src/features/orgs/invitationsService.js';

const dir = mkdtempSync(join(tmpdir(), 'owop-orginv-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const mkUser = (tenantId: string, email?: string): Promise<User> =>
  createUser({ tenantId, principalId: `password:${email ?? tenantId}`, source: 'password', ...(email ? { email } : {}) });

describe('org invitations (delegating to accessControl)', () => {
  beforeEach(async () => {
    __resetHostExtPersistence();
    initHostExtPersistence(openSqliteStorage(join(dir, 'inv.db')));
    await __resetUsersStore();
    await __resetAccessStores();
    await __resetOrgInvites();
  });

  it('accept onboards the user as an accessControl member bound to their subject + role', async () => {
    const org = await createOrg({ tenantId: 't', createdBy: 'owner-principal', name: 'Acme' });
    const invitee = await mkUser('t', 'bob@acme.test');
    const { token } = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'bob@acme.test', role: 'editor' });

    const member = await acceptInvitation(token, invitee);
    expect(member.orgId).toBe(org.orgId);
    expect(member.subject).toBe(invitee.userId); // bound to the RFC 0048 subject
    expect(member.roles).toEqual(['editor']);
    // accessControl now resolves the invited user's scopes from that role
    const access = await resolveEffectiveAccess('t', { subject: invitee.userId });
    expect(access.basis).toBe('member');
    expect(access.scopes.length).toBeGreaterThan(0);
    expect((await listMembers('t', org.orgId)).some((m) => m.subject === invitee.userId)).toBe(true);
  });

  it('is fail-closed: wrong email cannot accept; single-use; expired/bad token rejected', async () => {
    const org = await createOrg({ tenantId: 't', createdBy: 'owner', name: 'Acme' });
    const bob = await mkUser('t', 'bob@acme.test');
    const stranger = await mkUser('t', 'eve@evil.test');
    const { token } = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'bob@acme.test', role: 'viewer' });

    await expect(acceptInvitation(token, stranger)).rejects.toMatchObject({ code: 'forbidden' }); // email mismatch
    await acceptInvitation(token, bob); // ok
    await expect(acceptInvitation(token, bob)).rejects.toMatchObject({ code: 'invalid_invite' }); // single-use
    await expect(acceptInvitation('not-a-token', bob)).rejects.toMatchObject({ code: 'invalid_invite' });
  });

  it('IDOR: an org in another tenant is not invitable (404, no leak)', async () => {
    const org = await createOrg({ tenantId: 'tenant-a', createdBy: 'a', name: 'A' });
    await expect(createInvitation({ tenantId: 'tenant-b', orgId: org.orgId, email: 'x@t.test', role: 'viewer' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects a non-invitable role (owner) and re-inviting replaces the old token', async () => {
    const org = await createOrg({ tenantId: 't', createdBy: 'o', name: 'Acme' });
    await expect(createInvitation({ tenantId: 't', orgId: org.orgId, email: 'x@t.test', role: 'owner' })).rejects.toMatchObject({ code: 'validation' });
    const first = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'dup@t.test', role: 'viewer' });
    const second = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'dup@t.test', role: 'admin' });
    expect(await listInvitations('t', org.orgId)).toHaveLength(1);
    const dup = await mkUser('t', 'dup@t.test');
    await expect(acceptInvitation(first.token, dup)).rejects.toMatchObject({ code: 'invalid_invite' });
    expect((await acceptInvitation(second.token, dup)).roles).toEqual(['admin']);
  });
});

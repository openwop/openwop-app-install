/**
 * Review F1 (PR #3308) — the ORGINV-2 claim-by-delete must not be a one-way
 * door into nothing. If `createMember` throws AFTER the claim deleted the
 * invite + index rows, the token would be dead with no membership: every retry
 * reads `invalid_invite`, and the admin has no Resend surface (it renders on
 * still-existing rows only). The service must RESTORE both rows, log the
 * dedicated event, and rethrow — so a retry of the same token can succeed.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createMemberMock } = vi.hoisted(() => ({ createMemberMock: vi.fn() }));
vi.mock('../src/host/accessControlService.js', async (orig) => {
  const real = await orig<typeof import('../src/host/accessControlService.js')>();
  createMemberMock.mockImplementation(real.createMember);
  return { ...real, createMember: createMemberMock };
});

import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __resetUsersStore, createUser } from '../src/features/users/usersService.js';
import { __resetAccessStores, createOrg, listMembers } from '../src/host/accessControlService.js';
import { __resetOrgInvites, acceptInvitation, createInvitation, listInvitations, previewInvitation } from '../src/features/orgs/invitationsService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';

const dir = mkdtempSync(join(tmpdir(), 'owop-orginv-restore-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('F1 — a member-create failure after the claim restores the invite', () => {
  beforeEach(async () => {
    __resetHostExtPersistence();
    initHostExtPersistence(openSqliteStorage(join(dir, 'restore.db')));
    await __resetUsersStore();
    await __resetAccessStores();
    await __resetOrgInvites();
    registerToggleDefault({ id: 'orgs', label: 'Orgs', status: 'on' as const, salt: 'orgs', bucketUnit: 'tenant' as const });
    await saveConfig({ id: 'orgs', label: 'Orgs', status: 'on' as const, salt: 'orgs', bucketUnit: 'tenant' as const }, 'test');
    createMemberMock.mockClear();
  });

  it('restore: the invite + index rows come back, the failure surfaces, and a RETRY succeeds', async () => {
    const org = await createOrg({ tenantId: 't', createdBy: 'owner', name: 'Acme' });
    const bob = await createUser({ tenantId: 't', principalId: 'password:bob@acme.test', source: 'password', email: 'bob@acme.test', emailProvenance: 'idp' });
    const { token } = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'bob@acme.test', role: 'editor' });

    // Sabotage the tail AFTER the claim: the next createMember throws.
    createMemberMock.mockRejectedValueOnce(new Error('db down'));
    await expect(acceptInvitation(token, bob)).rejects.toThrow(/db down/);

    // No membership was minted…
    expect((await listMembers('t', org.orgId)).some((m) => m.subject === bob.userId)).toBe(false);
    // …and the claim was ROLLED BACK: the invite row is back (admin surface)…
    expect(await listInvitations('t', org.orgId)).toHaveLength(1);
    // …and the hash-index row too (preview resolves only through the index).
    await expect(previewInvitation(token)).resolves.toMatchObject({ orgId: org.orgId });

    // A retry of the SAME token now succeeds end-to-end.
    const { member, alreadyMember } = await acceptInvitation(token, bob);
    expect(alreadyMember).toBe(false);
    expect(member.subject).toBe(bob.userId);
    // Single-use held: the invite burned on the successful accept.
    await expect(previewInvitation(token)).rejects.toMatchObject({ code: 'invalid_invite' });
    expect(await listInvitations('t', org.orgId)).toHaveLength(0);
  });
});

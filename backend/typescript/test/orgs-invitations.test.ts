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
import { __resetOrgInvites, acceptInvitation, createInvitation, listInvitations, previewInvitation, revokeInvitation } from '../src/features/orgs/invitationsService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';

const dir = mkdtempSync(join(tmpdir(), 'owop-orginv-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const mkUser = (tenantId: string, email?: string): Promise<User> =>
  createUser({ tenantId, principalId: `password:${email ?? tenantId}`, source: 'password', ...(email ? { email, emailProvenance: 'idp' as const } : {}) });

describe('org invitations (delegating to accessControl)', () => {
  beforeEach(async () => {
    __resetHostExtPersistence();
    initHostExtPersistence(openSqliteStorage(join(dir, 'inv.db')));
    await __resetUsersStore();
    await __resetAccessStores();
    await __resetOrgInvites();
    // R2 review F6 — preview/accept now gate on the INVITE tenant's `orgs`
    // toggle inside the service. In a direct-service harness no feature has
    // registered its default (that happens at app boot), so register + enable.
    registerToggleDefault({ id: 'orgs', label: 'Orgs', status: 'on' as const, salt: 'orgs', bucketUnit: 'tenant' as const });
    await saveConfig({ id: 'orgs', label: 'Orgs', status: 'on' as const, salt: 'orgs', bucketUnit: 'tenant' as const }, 'test');
  });

  it('accept onboards the user as an accessControl member bound to their subject + role', async () => {
    const org = await createOrg({ tenantId: 't', createdBy: 'owner-principal', name: 'Acme' });
    const invitee = await mkUser('t', 'bob@acme.test');
    const { token } = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'bob@acme.test', role: 'editor' });

    const { member } = await acceptInvitation(token, invitee);
    expect(member.orgId).toBe(org.orgId);
    expect(member.subject).toBe(invitee.userId); // bound to the RFC 0048 subject
    expect(member.roles).toEqual(['editor']);
    // accessControl now resolves the invited user's scopes from that role
    const access = await resolveEffectiveAccess('t', { subject: invitee.userId });
    expect(access.basis).toBe('member');
    expect(access.scopes.length).toBeGreaterThan(0);
    expect((await listMembers('t', org.orgId)).some((m) => m.subject === invitee.userId)).toBe(true);
  });

  // UX_UPGRADE-invitations IN-G1 — preview must INFORM without REDEEMING.
  it('preview describes the invitation and does NOT consume it', async () => {
    const org = await createOrg({ tenantId: 't', createdBy: 'owner', name: 'Acme' });
    const invitee = await mkUser('t', 'bob@acme.test');
    const { token } = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'bob@acme.test', role: 'editor' });

    const p = await previewInvitation(token);
    expect(p.orgName).toBe('Acme');
    expect(p.role).toBe('editor');
    expect(p.email).toBe('bob@acme.test');
    expect(p.orgId).toBe(org.orgId);

    // The load-bearing property: previewing MANY times must not burn the single
    // use, or a link scanner following the URL would break the real invite.
    await previewInvitation(token);
    await previewInvitation(token);
    // No member was created by previewing.
    expect((await listMembers('t', org.orgId)).some((m) => m.subject === invitee.userId)).toBe(false);
    // …and the invite is still redeemable afterwards.
    const { member } = await acceptInvitation(token, invitee);
    expect(member.roles).toEqual(['editor']);
    // Now it IS consumed — preview reflects that rather than resurrecting it.
    await expect(previewInvitation(token)).rejects.toThrow(/invalid or expired/i);
  });

  it('preview performs NO email check — informing is not authorizing', async () => {
    const org = await createOrg({ tenantId: 't', createdBy: 'owner', name: 'Acme' });
    const mallory = await mkUser('t', 'mallory@evil.test');
    const { token } = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'bob@acme.test', role: 'viewer' });

    // Anyone holding the token can SEE what it is (it arrived in bob's mailbox)…
    expect((await previewInvitation(token)).email).toBe('bob@acme.test');
    // …but the email-ownership gate still lives in accept, and still bites.
    await expect(acceptInvitation(token, mallory)).rejects.toThrow(/different email/i);
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
    expect((await acceptInvitation(second.token, dup)).member.roles).toEqual(['admin']);
  });
  it('accept resolves via the hash index (grade-data) and the index is cleaned up on accept + revoke', async () => {
    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
    // WF-ORGINV-1 — the hashidx collection is INDEX-FREE (no tenantOf); this
    // probe construction mirrors the service's.
    const idx = new DurableCollection<{ key: string; inviteId: string; tenantId: string }>('orgs:invite-hashidx', (r) => r.key);
    const org = await createOrg({ tenantId: 't', createdBy: 'owner-principal', name: 'Acme' });

    // Accept path: the index row exists at mint, and accept consumes it.
    const invitee = await mkUser('t', 'bob@acme.test');
    const { token } = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'bob@acme.test', role: 'editor' });
    expect((await idx.list()).length).toBe(1);
    await acceptInvitation(token, invitee);
    expect((await idx.list()).length).toBe(0); // single-use ⇒ index cleaned

    // Revoke path: mint → revoke drops both the invite and its index pointer.
    const c2 = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'carol@acme.test', role: 'editor' });
    expect((await idx.list()).length).toBe(1);
    await revokeInvitation('t', org.orgId, c2.invite.inviteId);
    expect((await idx.list()).length).toBe(0);

    // Re-invite path (PROBE-TOK-2, invitationsService.ts:94): re-inviting the same
    // email REPLACES the previous pointer. Without the stale delete this leaves a
    // second index row aimed at a superseded invite — a pointer with no live invite,
    // which is exactly the dangle the probe counts. `listInvitations` cannot see it
    // (it reads invites, not the index), so this must assert on the index itself.
    await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'dave@acme.test', role: 'viewer' });
    expect((await idx.list()).length, 'precondition: the first invite minted a pointer').toBe(1);
    await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'dave@acme.test', role: 'admin' });
    expect(await listInvitations('t', org.orgId)).toHaveLength(1);
    expect(
      (await idx.list()).length,
      're-invite left a STALE hash pointer — a pointer with no live invite (PROBE-TOK-2)',
    ).toBe(1);
  });
});

describe('ORGINV grade-batch — accept race, email shape, point-get verify', () => {
  it('ORGINV-2 — concurrent double-accept mints exactly ONE membership row (claim-by-delete)', async () => {
    const org = await createOrg({ tenantId: 't', createdBy: 'owner', name: 'Acme' });
    const bob = await mkUser('t', 'bob@acme.test');
    const { token } = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'bob@acme.test', role: 'editor' });

    // Both accepts race past the validity checks; the invite-row delete is the
    // claim — only the caller that actually removed the row may createMember.
    const results = await Promise.allSettled([acceptInvitation(token, bob), acceptInvitation(token, bob)]);

    const rows = (await listMembers('t', org.orgId)).filter((m) => m.subject === bob.userId);
    expect(rows, 'the race must not mint duplicate OrgMember rows').toHaveLength(1);
    const wins = results.filter((r) => r.status === 'fulfilled');
    expect(wins, 'exactly one accept wins the claim').toHaveLength(1);
    const losses = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(losses).toHaveLength(1);
    expect(losses[0].reason).toMatchObject({ code: 'invalid_invite' }); // the loser sees "used", which it now is
  });

  it('ORGINV-3 — the recipient address must be email-shaped (junk and CRLF refused before mint)', async () => {
    const org = await createOrg({ tenantId: 't', createdBy: 'owner', name: 'Acme' });
    for (const bad of ['not-an-email', 'user@nodot', 'two words@acme.test', 'bcc@acme.test\r\nBcc: evil@evil.test', 'a\nb@acme.test', '@acme.test', 'bob@']) {
      // Review F4 — the machine-readable reason lets the UI show fix-the-input
      // copy instead of a retry-flavored message.
      await expect(createInvitation({ tenantId: 't', orgId: org.orgId, email: bad, role: 'viewer' }), bad).rejects.toMatchObject({ code: 'validation', reason: 'invalid_email' });
    }
    expect(await listInvitations('t', org.orgId), 'nothing was minted for junk').toHaveLength(0);
    // Trim + lowercase still applies to a VALID address.
    await createInvitation({ tenantId: 't', orgId: org.orgId, email: '  Bob@Acme.Test ', role: 'viewer' });
    expect((await listInvitations('t', org.orgId))[0].email).toBe('bob@acme.test');
  });

  it('ORGINV-5 — verify is a pure point-get: an index miss is fail-closed (the cross-tenant scan fallback is gone), and a dangling index row equally so', async () => {
    const { hashToken } = await import('../src/host/capabilityToken.js');
    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
    const idx = new DurableCollection<{ key: string; inviteId: string }>('orgs:invite-hashidx', (r) => r.key);
    const org = await createOrg({ tenantId: 't', createdBy: 'owner', name: 'Acme' });
    const bob = await mkUser('t', 'bob@acme.test');
    const { token } = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'bob@acme.test', role: 'viewer' });

    // Remove ONLY the index row. Under the old `invites.list()` scan fallback
    // this token still resolved — that scan is what every invalid-token probe
    // on the unauthenticated preview endpoint paid for.
    await idx.delete(hashToken(token));
    await expect(previewInvitation(token)).rejects.toMatchObject({ code: 'invalid_invite' });
    await expect(acceptInvitation(token, bob)).rejects.toMatchObject({ code: 'invalid_invite' });
    // The invite row itself is untouched — the management surface still lists it.
    expect(await listInvitations('t', org.orgId)).toHaveLength(1);

    // The reversed mint order's crash shape (index row, no invite row) is the
    // same fail-closed miss — which is why index-first retired the fallback.
    await idx.put({ key: hashToken('orginv_dangling'), inviteId: 'inv:gone' });
    await expect(previewInvitation('orginv_dangling')).rejects.toMatchObject({ code: 'invalid_invite' });
  });
});

describe('R2 XIN-0/1/2 — expired reason, inviter identity, already-member idempotence', () => {
  it('an EXPIRED invite throws with reason=expired (distinguishable from a bad token)', async () => {
    const org = await createOrg({ tenantId: 't', createdBy: 'owner', name: 'Acme' });
    const invitee = await mkUser('t', 'bob@acme.test');
    const { token, invite } = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'bob@acme.test', role: 'viewer' });
    // Age the row past its expiry (direct store surgery — no clock mock needed).
    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
    const store = new DurableCollection<{ inviteId: string; expiresAt: string }>('orgs:invite', (i) => i.inviteId);
    const row = (await store.get(invite.inviteId))!;
    await store.put({ ...row, expiresAt: new Date(Date.now() - 60_000).toISOString() });

    await expect(previewInvitation(token)).rejects.toMatchObject({ reason: 'expired' });
    await expect(acceptInvitation(token, invitee)).rejects.toMatchObject({ reason: 'expired' });
    // A never-existed token carries NO reason — the two stay distinguishable.
    await expect(previewInvitation('orginv_nope')).rejects.toSatisfy((e: { reason?: string }) => e.reason === undefined);
  });

  it('the preview names the inviter (display name), and SUPPRESSES an email-shaped name', async () => {
    const org = await createOrg({ tenantId: 't', createdBy: 'owner', name: 'Acme' });
    const named = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'a@t.test', role: 'viewer', createdBy: 'u1', createdByName: 'Ana Silva' });
    expect((await previewInvitation(named.token)).invitedBy).toBe('Ana Silva');
    const emailish = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'b@t.test', role: 'viewer', createdBy: 'u2', createdByName: 'ana@corp.test' });
    expect((await previewInvitation(emailish.token)).invitedBy).toBeUndefined();
  });

  it('accepting while ALREADY a member is idempotent — no duplicate OrgMember row, role unchanged', async () => {
    const { listMembers } = await import('../src/host/accessControlService.js');
    const org = await createOrg({ tenantId: 't', createdBy: 'owner', name: 'Acme' });
    const invitee = await mkUser('t', 'bob@acme.test');
    const first = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'bob@acme.test', role: 'editor' });
    const r1 = await acceptInvitation(first.token, invitee);
    expect(r1.alreadyMember).toBe(false);

    // A second invite to the SAME person (e.g. an admin re-inviting) — accept
    // must not mint a duplicate row, and must NOT silently change the role.
    const second = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'bob@acme.test', role: 'admin' });
    const r2 = await acceptInvitation(second.token, invitee);
    expect(r2.alreadyMember).toBe(true);
    expect(r2.member.memberId).toBe(r1.member.memberId);
    expect(r2.member.roles).toEqual(['editor']); // an invite is a door, not a role editor
    const rows = (await listMembers('t', org.orgId)).filter((m) => m.subject === invitee.userId);
    expect(rows).toHaveLength(1);
    // And the second invite was BURNED by the idempotent accept.
    await expect(previewInvitation(second.token)).rejects.toMatchObject({ code: 'invalid_invite' });
  });
});

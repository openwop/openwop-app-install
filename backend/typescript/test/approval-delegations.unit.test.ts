/**
 * Approval delegations (ADR 0198) — SERVICE layer: the delegation store
 * (windows, revocation), the resolution join in `approverResolution`
 * (delegates added for non-open gates only, expiry/revocation/org-membership
 * fail closed, fan-out inherits delegates), and the anti-double-vote identity
 * rule (`consumeVoteIdentity`). The HTTP/authz + end-to-end quorum layers
 * live in approval-delegations.test.ts (they boot the real app, which owns
 * the host-ext persistence singleton this file re-initializes).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __resetAccessStores, createMember } from '../src/host/accessControlService.js';
import {
  createDelegation,
  revokeDelegation,
  activeDelegations,
  _clearDelegationsForTest,
} from '../src/host/approvalDelegations.js';
import {
  resolveEligibleApprovers,
  resolveNotificationRecipients,
  isEligibleApprover,
  consumeVoteIdentity,
} from '../src/host/approverResolution.js';

const T = 'tenant-dlg';
const ORG = 'org-dlg';
const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const HOUR = 60 * 60 * 1000;

describe('approval delegations — store + resolution + identity (service)', () => {
  const storage = openSqliteStorage(':memory:');
  beforeAll(() => { initHostExtPersistence(storage); });
  afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });
  beforeEach(async () => {
    initHostExtPersistence(storage);
    await __resetAccessStores();
    await _clearDelegationsForTest(T);
  });

  it('store: validates window and self-delegation; revocation is idempotent', async () => {
    await expect(createDelegation({ tenantId: T, fromSubject: 'u:a', toSubject: 'u:a', startsAt: iso(0), endsAt: iso(HOUR), createdBy: 'u:a' }))
      .rejects.toMatchObject({ code: 'validation_error' });
    await expect(createDelegation({ tenantId: T, fromSubject: 'u:a', toSubject: 'u:b', startsAt: iso(HOUR), endsAt: iso(0), createdBy: 'u:a' }))
      .rejects.toMatchObject({ code: 'validation_error' });
    const d = await createDelegation({ tenantId: T, fromSubject: 'u:a', toSubject: 'u:b', startsAt: iso(-HOUR), endsAt: iso(HOUR), createdBy: 'u:a' });
    const r1 = await revokeDelegation(T, d.delegationId, 'u:a');
    expect(r1.revokedAt).toBeTruthy();
    const r2 = await revokeDelegation(T, d.delegationId, 'u:a');
    expect(r2.revokedAt).toBe(r1.revokedAt); // idempotent
  });

  it('activeDelegations honors the window and revocation (fail closed on expiry)', async () => {
    await createDelegation({ tenantId: T, fromSubject: 'u:p', toSubject: 'u:d', startsAt: iso(-HOUR), endsAt: iso(HOUR), createdBy: 'u:p' });
    const expired = await createDelegation({ tenantId: T, fromSubject: 'u:p2', toSubject: 'u:d2', startsAt: iso(-3 * HOUR), endsAt: iso(-HOUR), createdBy: 'u:p2' });
    void expired;
    const revoked = await createDelegation({ tenantId: T, fromSubject: 'u:p3', toSubject: 'u:d3', startsAt: iso(-HOUR), endsAt: iso(HOUR), createdBy: 'u:p3' });
    await revokeDelegation(T, revoked.delegationId, 'u:p3');
    const { byPrincipal } = await activeDelegations(T);
    expect(byPrincipal.get('u:p')).toEqual(['u:d']);
    expect(byPrincipal.has('u:p2')).toBe(false); // expired window
    expect(byPrincipal.has('u:p3')).toBe(false); // revoked
  });

  it('resolution: an active delegation adds the delegate for a NON-open gate; open gates skip it', async () => {
    await createDelegation({ tenantId: T, fromSubject: 'u:principal', toSubject: 'u:delegate', startsAt: iso(-HOUR), endsAt: iso(HOUR), createdBy: 'u:principal' });
    const named = await resolveEligibleApprovers({ approverRefs: ['u:principal'] }, { tenantId: T });
    expect(named.subjects.sort()).toEqual(['u:delegate', 'u:principal']); // principal stays — no lockout
    expect(named.delegates).toEqual({ 'u:delegate': ['u:principal'] });
    const open = await resolveEligibleApprovers({}, { tenantId: T });
    expect(open.openGate).toBe(true);
    expect(open.subjects).toEqual([]);
    expect(open.delegates).toEqual({});
  });

  it('resolution: org gates fail closed on a delegate with no org access', async () => {
    await createMember({ tenantId: T, orgId: ORG, displayName: 'P', subject: 'u:principal', roles: ['editor'] });
    // u:outsider is NOT an org member.
    await createDelegation({ tenantId: T, fromSubject: 'u:principal', toSubject: 'u:outsider', startsAt: iso(-HOUR), endsAt: iso(HOUR), createdBy: 'u:principal' });
    const res = await resolveEligibleApprovers({ approverRefs: ['u:principal'] }, { tenantId: T, orgId: ORG });
    expect(res.subjects).toEqual(['u:principal']);
    expect(res.delegates).toEqual({});
  });

  it('fan-out inherits the delegate (who is told == who may approve)', async () => {
    await createDelegation({ tenantId: T, fromSubject: 'principal-user', toSubject: 'delegate-user', startsAt: iso(-HOUR), endsAt: iso(HOUR), createdBy: 'principal-user' });
    const recipients = await resolveNotificationRecipients({ approverRefs: ['principal-user'] }, { tenantId: T });
    expect(recipients?.sort()).toEqual(['delegate-user', 'principal-user']);
  });

  it('identity: a delegate votes AS the principal; a direct approver votes as themselves', async () => {
    await createDelegation({ tenantId: T, fromSubject: 'u:principal', toSubject: 'u:delegate', startsAt: iso(-HOUR), endsAt: iso(HOUR), createdBy: 'u:principal' });
    const refs = { approverRefs: ['u:principal', 'u:direct'] };
    expect(await consumeVoteIdentity('u:direct', refs, { tenantId: T })).toEqual({ countAs: 'u:direct' });
    expect(await consumeVoteIdentity('u:principal', refs, { tenantId: T })).toEqual({ countAs: 'u:principal' });
    expect(await consumeVoteIdentity('u:delegate', refs, { tenantId: T }))
      .toEqual({ countAs: 'u:principal', actedBy: 'u:delegate' });
    // A delegate who is ALSO directly eligible votes as THEMSELVES.
    await createDelegation({ tenantId: T, fromSubject: 'u:principal', toSubject: 'u:direct', startsAt: iso(-HOUR), endsAt: iso(HOUR), createdBy: 'u:principal' });
    expect(await consumeVoteIdentity('u:direct', refs, { tenantId: T })).toEqual({ countAs: 'u:direct' });
  });

  it('identity: covering several principals requires an explicit actedFor; a bogus actedFor is forbidden', async () => {
    await createDelegation({ tenantId: T, fromSubject: 'u:p1', toSubject: 'u:cover', startsAt: iso(-HOUR), endsAt: iso(HOUR), createdBy: 'u:p1' });
    await createDelegation({ tenantId: T, fromSubject: 'u:p2', toSubject: 'u:cover', startsAt: iso(-HOUR), endsAt: iso(HOUR), createdBy: 'u:p2' });
    const refs = { approverRefs: ['u:p1', 'u:p2'] };
    await expect(consumeVoteIdentity('u:cover', refs, { tenantId: T }))
      .rejects.toMatchObject({ code: 'validation_error' });
    expect(await consumeVoteIdentity('u:cover', refs, { tenantId: T }, 'u:p2'))
      .toEqual({ countAs: 'u:p2', actedBy: 'u:cover' });
    await expect(consumeVoteIdentity('u:cover', refs, { tenantId: T }, 'u:someone-else'))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('identity: an eligibility check for a delegate reports viaPrincipals (never direct)', async () => {
    await createDelegation({ tenantId: T, fromSubject: 'u:principal', toSubject: 'u:delegate', startsAt: iso(-HOUR), endsAt: iso(HOUR), createdBy: 'u:principal' });
    const res = await isEligibleApprover('u:delegate', { approverRefs: ['u:principal'] }, { tenantId: T });
    expect(res.eligible).toBe(true);
    expect(res.viaPrincipals).toEqual(['u:principal']);
  });

  it('identity: an ineligible caller is rejected with the canonical error', async () => {
    await expect(consumeVoteIdentity('u:stranger', { approverRefs: ['u:someone'] }, { tenantId: T }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });
});


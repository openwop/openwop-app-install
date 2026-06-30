/**
 * Approver resolution (ADR 0075 §D1/§D5/§D7) — the single authority that expands
 * HITL approver refs (explicit subjects ∪ group members ∪ role holders) to the
 * eligible-subject set, tenant/org-scoped and fail-closed.
 *
 * Pure service test (no HTTP): the resolver + the two accessControl point-lookups
 * it composes. Route-level eligibility enforcement (evaluateQuorum wiring) is
 * covered by the approval-decision route tests.
 *
 * @see src/host/approverResolution.ts, src/host/accessControlService.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  __resetAccessStores,
  createMember,
  createGroup,
  getUsersByGroup,
  getMembersWithRole,
} from '../src/host/accessControlService.js';
import {
  resolveEligibleApprovers,
  resolveNotificationRecipients,
  registerSubjectToUserIdResolver,
  isEligibleApprover,
  approvalGatesWithGroupRole,
  validateApproverResolvability,
} from '../src/host/approverResolution.js';
import { OpenwopError } from '../src/types.js';

const T = 'tenant-acct';
const ORG = 'org-finance';

describe('approver resolution (ADR 0075)', () => {
  const storage = openSqliteStorage(':memory:');
  beforeAll(() => { initHostExtPersistence(storage); });
  afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });
  beforeEach(async () => { initHostExtPersistence(storage); await __resetAccessStores(); });

  describe('accessControl point-lookups (§D7)', () => {
    it('getUsersByGroup returns member subjects, deduped; excludes members with no subject', async () => {
      const alice = await createMember({ tenantId: T, orgId: ORG, displayName: 'Alice', subject: 'user:alice', roles: ['editor'] });
      const bob = await createMember({ tenantId: T, orgId: ORG, displayName: 'Bob', subject: 'user:bob', roles: ['viewer'] });
      const descriptive = await createMember({ tenantId: T, orgId: ORG, displayName: 'No Principal' }); // no subject
      const g = await createGroup({ tenantId: T, orgId: ORG, name: 'finance-approvers', memberIds: [alice.memberId, bob.memberId, descriptive.memberId] });
      const subjects = await getUsersByGroup(T, ORG, g.groupId);
      expect(subjects.sort()).toEqual(['user:alice', 'user:bob']);
    });

    it('getUsersByGroup is tenant/org-scoped — a cross-tenant/org group resolves to []', async () => {
      const m = await createMember({ tenantId: T, orgId: ORG, displayName: 'A', subject: 'user:a' });
      const g = await createGroup({ tenantId: T, orgId: ORG, name: 'g', memberIds: [m.memberId] });
      expect(await getUsersByGroup('other-tenant', ORG, g.groupId)).toEqual([]);
      expect(await getUsersByGroup(T, 'other-org', g.groupId)).toEqual([]);
      expect(await getUsersByGroup(T, ORG, 'grp-missing')).toEqual([]);
    });

    it('getMembersWithRole returns direct AND group-derived role holders', async () => {
      const direct = await createMember({ tenantId: T, orgId: ORG, displayName: 'Direct', subject: 'user:direct', roles: ['controller'] });
      const viaGroup = await createMember({ tenantId: T, orgId: ORG, displayName: 'ViaGroup', subject: 'user:viagroup', roles: ['viewer'] });
      const unrelated = await createMember({ tenantId: T, orgId: ORG, displayName: 'Unrelated', subject: 'user:unrelated', roles: ['viewer'] });
      await createGroup({ tenantId: T, orgId: ORG, name: 'controllers', roles: ['controller'], memberIds: [viaGroup.memberId] });
      void direct; void unrelated;
      const holders = await getMembersWithRole(T, ORG, 'controller');
      expect(holders.sort()).toEqual(['user:direct', 'user:viagroup']);
    });
  });

  describe('resolveEligibleApprovers (§D1)', () => {
    it('explicit subjects pass through; openGate=false', async () => {
      const r = await resolveEligibleApprovers({ approverRefs: ['user:x', 'user:y'] }, { tenantId: T, orgId: ORG });
      expect(r.subjects.sort()).toEqual(['user:x', 'user:y']);
      expect(r.openGate).toBe(false);
      expect(r.unresolved).toEqual([]);
    });

    it('no refs of any kind ⇒ openGate', async () => {
      const r = await resolveEligibleApprovers({}, { tenantId: T, orgId: ORG });
      expect(r.openGate).toBe(true);
      expect(r.subjects).toEqual([]);
    });

    it('expands group + role refs and dedups against explicit subjects', async () => {
      const alice = await createMember({ tenantId: T, orgId: ORG, displayName: 'Alice', subject: 'user:alice', roles: ['controller'] });
      const bob = await createMember({ tenantId: T, orgId: ORG, displayName: 'Bob', subject: 'user:bob', roles: ['viewer'] });
      const g = await createGroup({ tenantId: T, orgId: ORG, name: 'fin', memberIds: [bob.memberId] });
      void alice;
      const r = await resolveEligibleApprovers(
        { approverRefs: ['user:alice'], approverGroupRefs: [g.groupId], approverRoleRefs: ['controller'] },
        { tenantId: T, orgId: ORG },
      );
      // alice (explicit + role:controller) deduped; bob (group member)
      expect(r.subjects.sort()).toEqual(['user:alice', 'user:bob']);
      expect(r.openGate).toBe(false);
      expect(r.unresolved).toEqual([]);
    });

    it('a present-but-unresolvable group/role ref is reported in `unresolved` (§D4)', async () => {
      const r = await resolveEligibleApprovers(
        { approverGroupRefs: ['grp-deleted'], approverRoleRefs: ['role-nobody-holds'] },
        { tenantId: T, orgId: ORG },
      );
      expect(r.openGate).toBe(false); // refs ARE present — not an open gate
      expect(r.unresolved.sort()).toEqual(['grp-deleted', 'role-nobody-holds']);
      expect(r.subjects).toEqual([]);
    });

    it('group/role refs WITHOUT org context cannot resolve ⇒ unresolved (never a silent open gate)', async () => {
      const m = await createMember({ tenantId: T, orgId: ORG, displayName: 'A', subject: 'user:a' });
      const g = await createGroup({ tenantId: T, orgId: ORG, name: 'g', memberIds: [m.memberId] });
      const r = await resolveEligibleApprovers({ approverGroupRefs: [g.groupId] }, { tenantId: T }); // no orgId
      expect(r.openGate).toBe(false);
      expect(r.unresolved).toEqual([g.groupId]);
      expect(r.subjects).toEqual([]);
    });
  });

  describe('resolveNotificationRecipients (§D6)', () => {
    // Default to the identity mapping (no users-feature resolver booted), the
    // production default for a bound-user ref where the approver ref == userId.
    beforeEach(() => { registerSubjectToUserIdResolver(async () => null); });

    it('open gate (no named approvers) ⇒ null (broadcast to the tenant)', async () => {
      expect(await resolveNotificationRecipients({}, { tenantId: T, orgId: ORG })).toBeNull();
    });

    it('named bound-user approverRefs ⇒ addressed to exactly those userIds', async () => {
      const r = await resolveNotificationRecipients({ approverRefs: ['alice', 'bob'] }, { tenantId: T });
      expect(r?.sort()).toEqual(['alice', 'bob']);
    });

    it('a scheme-prefixed approver that cannot be mapped ⇒ null (broadcast, never silently dropped)', async () => {
      registerSubjectToUserIdResolver(async () => null); // resolver maps nothing
      const r = await resolveNotificationRecipients({ approverRefs: ['oidc:sub-123'] }, { tenantId: T });
      expect(r).toBeNull();
    });

    it('a registered resolver maps a scheme principal to its userId', async () => {
      registerSubjectToUserIdResolver(async (_t, s) => (s === 'oidc:sub-123' ? 'user-xyz' : null));
      const r = await resolveNotificationRecipients({ approverRefs: ['oidc:sub-123'] }, { tenantId: T });
      expect(r).toEqual(['user-xyz']);
    });

    it('group expansion targets member subjects when they are bound-user ids', async () => {
      const a = await createMember({ tenantId: T, orgId: ORG, displayName: 'A', subject: 'uid-a' });
      const b = await createMember({ tenantId: T, orgId: ORG, displayName: 'B', subject: 'uid-b' });
      const g = await createGroup({ tenantId: T, orgId: ORG, name: 'fin', memberIds: [a.memberId, b.memberId] });
      const r = await resolveNotificationRecipients({ approverGroupRefs: [g.groupId] }, { tenantId: T, orgId: ORG });
      expect(r?.sort()).toEqual(['uid-a', 'uid-b']);
    });
  });

  describe('isEligibleApprover (§D1/§D6 — the namespace-match logic)', () => {
    beforeEach(() => { registerSubjectToUserIdResolver(async () => null); });

    it('no refs of any kind ⇒ openGate (caller applies its own open policy)', async () => {
      expect(await isEligibleApprover('anyone', {}, { tenantId: T, orgId: ORG })).toEqual({ eligible: false, openGate: true });
    });

    it('RULE 1: a direct approverRef matches RAW — even a scheme ref with no User record (no regression)', async () => {
      // 'user:alice' has no backing User; it must still match (the pre-ADR-0075 behavior).
      expect(await isEligibleApprover('user:alice', { approverRefs: ['user:alice', 'user:bob'] }, { tenantId: T }))
        .toEqual({ eligible: true, openGate: false });
      expect((await isEligibleApprover('user:carol', { approverRefs: ['user:alice'] }, { tenantId: T })).eligible).toBe(false);
    });

    it('RULE 2: a group member whose subject is an oidc: principal matches the bound reviewer userId (canonicalized)', async () => {
      const m = await createMember({ tenantId: T, orgId: ORG, displayName: 'Olivia', subject: 'oidc:olivia-sub' });
      const g = await createGroup({ tenantId: T, orgId: ORG, name: 'fin', memberIds: [m.memberId] });
      registerSubjectToUserIdResolver(async (_t, s) => (s === 'oidc:olivia-sub' ? 'user-olivia' : null));
      // The reviewer authenticates as the bare userId 'user-olivia'.
      expect((await isEligibleApprover('user-olivia', { approverGroupRefs: [g.groupId] }, { tenantId: T, orgId: ORG })).eligible).toBe(true);
      // A different user is not eligible.
      expect((await isEligibleApprover('user-mallory', { approverGroupRefs: [g.groupId] }, { tenantId: T, orgId: ORG })).eligible).toBe(false);
    });

    it('a group member with no mappable identity does not grant eligibility (never silently allowed)', async () => {
      const m = await createMember({ tenantId: T, orgId: ORG, displayName: 'Ghost', subject: 'oidc:ghost' });
      const g = await createGroup({ tenantId: T, orgId: ORG, name: 'g', memberIds: [m.memberId] });
      registerSubjectToUserIdResolver(async () => null);
      expect((await isEligibleApprover('whoever', { approverGroupRefs: [g.groupId] }, { tenantId: T, orgId: ORG })).eligible).toBe(false);
    });
  });

  describe('pre-flight resolvability (§D4)', () => {
    const NODES = [
      { nodeId: 'start', typeId: 'core.noop' },
      { nodeId: 'subjGate', typeId: 'core.approvalGate', config: { approverRefs: ['alice'] } },
      { nodeId: 'openGate', typeId: 'core.approvalGate', config: {} },
      { nodeId: 'groupGate', typeId: 'core.approvalGate', config: { approverGroupRefs: ['grp-fin'] } },
      { nodeId: 'roleGate', typeId: 'core.approvalGate', config: { approverRoleRefs: ['controller'] } },
    ];

    it('approvalGatesWithGroupRole selects only group/role gates (not subject-only, open, or non-gate nodes)', () => {
      const gates = approvalGatesWithGroupRole(NODES);
      expect(gates.map((g) => g.nodeId).sort()).toEqual(['groupGate', 'roleGate']);
    });

    it('rejects (throws) when a group/role gate resolves to nobody — no org context', async () => {
      const gates = approvalGatesWithGroupRole(NODES);
      await expect(validateApproverResolvability(gates, { tenantId: T })).rejects.toBeInstanceOf(OpenwopError);
    });

    it('rejects when the named group/role is empty/missing even WITH org context', async () => {
      const gates = approvalGatesWithGroupRole([
        { nodeId: 'g', typeId: 'core.approvalGate', config: { approverGroupRefs: ['grp-does-not-exist'] } },
      ]);
      await expect(validateApproverResolvability(gates, { tenantId: T, orgId: ORG })).rejects.toMatchObject({
        details: { reason: 'unresolvable_approvers' },
      });
    });

    it('passes when the group/role resolves to ≥1 member in the org', async () => {
      const m = await createMember({ tenantId: T, orgId: ORG, displayName: 'Ctrl', subject: 'uid-ctrl', roles: ['controller'] });
      const g = await createGroup({ tenantId: T, orgId: ORG, name: 'fin', memberIds: [m.memberId] });
      const gates = approvalGatesWithGroupRole([
        { nodeId: 'gg', typeId: 'core.approvalGate', config: { approverGroupRefs: [g.groupId] } },
        { nodeId: 'rg', typeId: 'core.approvalGate', config: { approverRoleRefs: ['controller'] } },
      ]);
      await expect(validateApproverResolvability(gates, { tenantId: T, orgId: ORG })).resolves.toBeUndefined();
    });

    it('is a no-op for a workflow with no group/role gates (subject-only / open)', async () => {
      const gates = approvalGatesWithGroupRole([
        { nodeId: 'subjGate', typeId: 'core.approvalGate', config: { approverRefs: ['alice'] } },
        { nodeId: 'openGate', typeId: 'core.approvalGate', config: {} },
      ]);
      expect(gates).toEqual([]);
      await expect(validateApproverResolvability(gates, { tenantId: T })).resolves.toBeUndefined();
    });
  });
});

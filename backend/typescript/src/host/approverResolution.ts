/**
 * Approver resolution — the SINGLE authority for "who may approve this gate"
 * (ADR 0075 §D1). Pre-flight validation, notification fan-out, and decision-time
 * eligibility ALL resolve through this one function so they can never disagree
 * (the boundaries-and-duplication risk the architecture review flagged).
 *
 * It EXPANDS a policy's refs — explicit subjects ∪ group members ∪ role holders —
 * into the concrete subject set, resolved LIVE against `accessControl` (ADR 0075
 * §D3: membership is dynamic, so a late group-joiner is eligible; callers that
 * need replay determinism snapshot the resolved set on the decision record). It
 * does NOT decide what an EMPTY set means — that stays per-surface (the interrupt
 * path treats empty as an open gate per the `openwop-interrupt-quorum` conformance
 * contract; the pre-execution approval path treats empty as "any `approvals:respond`
 * holder"). This module only does the expansion + resolvability classification.
 *
 * Host-extension, non-normative. Group/role routing on the OpenWOP interrupt wire
 * is RFC 0104; here the refs live in host-extension records (`ApprovalPolicy`).
 */

import { getUsersByGroup, getMembersWithRole } from './accessControlService.js';
import { OpenwopError } from '../types.js';

export interface ApproverRefs {
  /** Explicit subject refs (opaque principals). */
  approverRefs?: readonly string[];
  /** accessControl group refs — expanded to member subjects. */
  approverGroupRefs?: readonly string[];
  /** accessControl role refs — expanded to effective-holder subjects. */
  approverRoleRefs?: readonly string[];
}

export interface EligibleApprovers {
  /** The deduped, expanded set of eligible subjects. Empty when `openGate`. */
  subjects: string[];
  /** True iff NO refs of any kind were configured — an intentionally open gate.
   *  Each call site applies its own open-gate policy (open vs scope-gated). */
  openGate: boolean;
  /** Refs that are PRESENT but resolve to no subject — a deleted/cross-tenant
   *  group or role, or a group/role ref with no org context. These are the
   *  "named but broken" approvers pre-flight rejects (ADR 0075 §D4); an empty
   *  array means every configured ref resolved to at least one subject. */
  unresolved: string[];
}

function clean(refs: readonly string[] | undefined): string[] {
  return (refs ?? []).filter((r): r is string => typeof r === 'string' && r.length > 0);
}

/**
 * Resolve a policy's approver refs to the concrete eligible-subject set within
 * (tenantId, orgId). Group/role refs require `orgId` (the accessControl unit);
 * without it they cannot resolve and are reported as `unresolved` (a config error
 * surfaced by pre-flight, never a silent open gate).
 */
export async function resolveEligibleApprovers(
  refs: ApproverRefs,
  ctx: { tenantId: string; orgId?: string },
): Promise<EligibleApprovers> {
  const subjectRefs = clean(refs.approverRefs);
  const groupRefs = clean(refs.approverGroupRefs);
  const roleRefs = clean(refs.approverRoleRefs);

  const openGate = subjectRefs.length === 0 && groupRefs.length === 0 && roleRefs.length === 0;
  const subjects = new Set<string>(subjectRefs);
  const unresolved: string[] = [];

  for (const groupRef of groupRefs) {
    const found = ctx.orgId ? await getUsersByGroup(ctx.tenantId, ctx.orgId, groupRef) : [];
    if (found.length === 0) unresolved.push(groupRef);
    for (const s of found) subjects.add(s);
  }
  for (const roleRef of roleRefs) {
    const found = ctx.orgId ? await getMembersWithRole(ctx.tenantId, ctx.orgId, roleRef) : [];
    if (found.length === 0) unresolved.push(roleRef);
    for (const s of found) subjects.add(s);
  }

  return { subjects: [...subjects], openGate, unresolved };
}

/**
 * Optional principal→userId resolver (ADR 0075 §D6). The notification recipient
 * id is the durable `userId`; an approver ref is already that id for a bound user
 * (ADR 0003: `req.userId` is the eligibility ref AND the recipient filter), but a
 * group/role-expanded member `subject` may be a scheme-prefixed principal
 * (`oidc:<sub>`) that must be mapped to its `userId`. Core declares the seam; the
 * users FEATURE registers the mapping at boot (feature→core only — core never
 * imports the feature). Unregistered ⇒ the identity mapping (bound-user case).
 */
export type SubjectToUserId = (tenantId: string, subject: string) => Promise<string | null>;
let subjectToUserId: SubjectToUserId | null = null;
export function registerSubjectToUserIdResolver(fn: SubjectToUserId): void { subjectToUserId = fn; }

/**
 * The recipient userIds for a HITL item with these approver refs, or `null` when
 * it should BROADCAST (ADR 0075 §D6). Built on the single eligibility resolver so
 * "who is told" can't drift from "who may approve". Returns `null` (broadcast) for
 * an open gate, AND — fail-safe — whenever any named approver cannot be mapped to a
 * concrete recipient userId, so a misconfigured/​unmappable approver is never
 * SILENTLY left un-notified (the whole tenant is told instead).
 */
export async function resolveNotificationRecipients(
  refs: ApproverRefs,
  ctx: { tenantId: string; orgId?: string },
): Promise<string[] | null> {
  const eligible = await resolveEligibleApprovers(refs, ctx);
  if (eligible.openGate) return null; // no named approvers → broadcast
  const ids: string[] = [];
  for (const subject of eligible.subjects) {
    const mapped = subjectToUserId ? await subjectToUserId(ctx.tenantId, subject) : null;
    const userId = mapped ?? (subject.includes(':') ? null : subject); // bound-user ref == userId
    if (!userId) return null; // an approver we can't address → broadcast, never drop them
    ids.push(userId);
  }
  const unique = [...new Set(ids)];
  return unique.length > 0 ? unique : null;
}

/** Canonicalize a ref to its userId via the registered resolver; a bare userId
 *  (or an unmappable ref) maps to itself. */
export async function canonicalReviewerUserId(tenantId: string, reviewerRef: string): Promise<string> {
  const mapped = subjectToUserId ? await subjectToUserId(tenantId, reviewerRef) : null;
  return mapped ?? reviewerRef;
}

/**
 * Is `reviewerRef` an eligible approver for a gate with these refs? (ADR 0075 §D1/§D6.)
 * Two MATCH RULES, deliberately different, because the two ref sources live in
 * different identity namespaces:
 *   1. **Direct `approverRefs`** are matched RAW against `reviewerRef` — they are
 *      authoritative as named (a subject, bearer voter, or userId the author/quorum
 *      wrote), exactly the pre-ADR-0075 behavior. NOT canonicalized (a named ref
 *      with no `User` record must still match — tests, capability-token voters, an
 *      OIDC subject not yet upserted).
 *   2. **Group/role-expanded** member subjects ARE canonicalized to userIds (a
 *      member's `subject` may be an `oidc:` principal that must match the bound
 *      reviewer's userId); a member with no mappable identity is excluded.
 * `openGate` (no refs of any kind) is returned for the caller's own open policy.
 */
export async function isEligibleApprover(
  reviewerRef: string,
  refs: ApproverRefs,
  ctx: { tenantId: string; orgId?: string },
): Promise<{ eligible: boolean; openGate: boolean }> {
  const directSubjects = clean(refs.approverRefs);
  const groupRefs = clean(refs.approverGroupRefs);
  const roleRefs = clean(refs.approverRoleRefs);
  if (directSubjects.length === 0 && groupRefs.length === 0 && roleRefs.length === 0) {
    return { eligible: false, openGate: true };
  }
  // Rule 1 — raw direct-subject match (authoritative, unchanged).
  if (directSubjects.includes(reviewerRef)) return { eligible: true, openGate: false };
  // Rule 2 — group/role members, canonicalized to userId.
  if (groupRefs.length > 0 || roleRefs.length > 0) {
    const expanded = await resolveEligibleApprovers({ approverGroupRefs: groupRefs, approverRoleRefs: roleRefs }, ctx);
    const me = await canonicalReviewerUserId(ctx.tenantId, reviewerRef);
    for (const subject of expanded.subjects) {
      if (subject === reviewerRef) return { eligible: true, openGate: false }; // member subject already == reviewer
      const mapped = subjectToUserId ? await subjectToUserId(ctx.tenantId, subject) : null;
      const userId = mapped ?? (subject.includes(':') ? null : subject);
      if (userId && userId === me) return { eligible: true, openGate: false };
    }
  }
  return { eligible: false, openGate: false };
}

// ── Pre-flight resolvability (ADR 0075 §D4) ─────────────────────────────────────

interface NodeLike { nodeId: string; typeId: string; config?: Record<string, unknown> }
export interface GroupRoleGate { nodeId: string; groupRefs: string[]; roleRefs: string[] }

/** The approval-gate nodes that name GROUP/ROLE approvers — the ones whose
 *  resolvability depends on the run's org context. Subject-only and open gates
 *  are excluded (subjects are opaque + need no org; open gates are valid). */
export function approvalGatesWithGroupRole(nodes: readonly NodeLike[]): GroupRoleGate[] {
  const gates: GroupRoleGate[] = [];
  for (const n of nodes) {
    if (n.typeId !== 'core.approvalGate') continue;
    const c = n.config ?? {};
    const groupRefs = clean(Array.isArray(c.approverGroupRefs) ? (c.approverGroupRefs as unknown[]).filter((r): r is string => typeof r === 'string') : []);
    const roleRefs = clean(Array.isArray(c.approverRoleRefs) ? (c.approverRoleRefs as unknown[]).filter((r): r is string => typeof r === 'string') : []);
    if (groupRefs.length > 0 || roleRefs.length > 0) gates.push({ nodeId: n.nodeId, groupRefs, roleRefs });
  }
  return gates;
}

/**
 * Pre-flight (ADR 0075 §D4): reject run-create when an approval gate names a
 * group/role approver that resolves to NOBODY in this run's org — a deleted or
 * cross-tenant group, a role with no holder, or no org context at all. Fail-
 * closed: the org is passed in (resolved fail-closed by the caller; never
 * guessed), so a group/role ref can never resolve against the wrong org. An
 * empty `gates` list is a no-op (subject-only / open gates need no org).
 */
export async function validateApproverResolvability(
  gates: readonly GroupRoleGate[],
  ctx: { tenantId: string; orgId?: string },
): Promise<void> {
  for (const gate of gates) {
    const eligible = await resolveEligibleApprovers(
      { approverGroupRefs: gate.groupRefs, approverRoleRefs: gate.roleRefs },
      ctx,
    );
    if (eligible.unresolved.length > 0) {
      throw new OpenwopError(
        'validation_error',
        `Approval gate '${gate.nodeId}' names approver(s) that resolve to nobody in this run's org: ${eligible.unresolved.join(', ')}. Add members to the group/role, or run the workflow within an org-scoped context.`,
        400,
        { nodeId: gate.nodeId, unresolved: eligible.unresolved, reason: 'unresolvable_approvers' },
      );
    }
  }
}

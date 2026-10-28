/**
 * ADR 0672 D1 (`CMSAWF-11` / `CMSAWF-18`) — the ONE owner of "who may learn that this
 * approval row exists".
 *
 * ## Why this file exists
 *
 * The rule was implemented TWICE, divergently, and the divergence was itself a leak:
 *
 * - `host/reviewProjection.ts` `approvalVisible` carried NINE per-kind branches and gated
 *   `/reviews` correctly.
 * - `routes/approvals.ts` implemented FOUR of them and `return a`'d every other kind, so
 *   `GET /approvals` handed any tenant principal the rows `/reviews` hides — a widget
 *   visitor's captured PII (`anon-surface-write`), a coach's free-text note ABOUT a
 *   participant (`kicktodo-plan-proposal`), the three field-sales kinds, and
 *   superadmin-only `commerce-listing-publish`.
 * - `host/approvalSla.ts` resolved recipients from `policy.approverRefs`, which no CMS lane
 *   sets, so it emitted with NO recipient — a true broadcast across the inbox, SSE and Web
 *   Push (page title on every device's lock screen).
 *
 * `approvalVisible`'s own docstring claimed it "mirrors routes/approvals.ts list gating —
 * the SAME check, reused". It did not, and that sentence is why nobody looked.
 *
 * ## Why a sibling table rather than a field on `KIND_DISPATCH`
 *
 * `host/approvalDecision.ts` already keys per-kind behaviour by the same discriminator, and
 * a second registry over one key is normally a smell. It is deliberate here: that module
 * imports feature handlers, so having the READ surfaces (`reviewProjection`,
 * `routes/approvals`) import it to ask about audience would create a host→feature→host
 * cycle. Audience therefore lives beside the decision table, importing nothing from
 * `features/`.
 *
 * ## The shape is discriminated, not `scope | null`
 *
 * Three of the nine branches cannot be expressed as an org scope. A `scope-or-null`
 * signature — the first draft of ADR 0672 — would have collapsed them to `null`, i.e. to a
 * tenant-wide broadcast, on exactly the kinds whose own comments say the fallthrough leaks
 * PII.
 */
import type { ApprovalKind, PendingApproval } from './approvalService.js';
import { resolveEffectiveAccess, listMembers, type EffectiveAccess } from './accessControlService.js';
import { isSuperadminTenant } from './superadmin.js';
import { isEligibleApprover, resolveEligibleApprovers } from './approverResolution.js';

/** Who is entitled to see/be told about a row of this kind. */
export type Audience =
  /** Holders of `scope` in the ROW'S org (never the tenant at large). */
  | { orgScope: string }
  /** The single ref in `policy.approverRefs[0]` — the note is PII about that person. */
  | { policyApproverRef: true }
  /** The superadmin tenant only. */
  | { superadminTenant: true }
  /** ADR 0878 D6 — holders of `scope` in the row's org WHEN the row has one; a row
   *  without an `orgId` is tenant-scoped (the `null` answer). For a kind whose rows
   *  are sometimes one org's business: an `assistant-action` drafting a support
   *  reply carries its ticket's org, every other assistant action carries none. */
  | { orgScopeWhenOrg: string }
  /** ADR 0905 D3 — holders of `scope` in the row's org, PLUS the subjects the row's
   *  `policy` approver refs (ADR 0075 groups/roles) resolve to. For a kind whose org
   *  may name extra approvers (the agency → client email review): a named approver who
   *  could decide but not see the card would be a gate with no visible door. Resolved
   *  through the ONE approver resolver (`approverResolution`). */
  | { orgScopeOrApproverRefs: string }
  /** Genuinely tenant-scoped. Stated per kind, never a default — see the ratchet below. */
  | null;

/**
 * Every approval kind's audience.
 *
 * **`null` is written out per kind on purpose.** A `Record<ApprovalKind, …>` plus the
 * completeness test in `test/approval-audience-owner.test.ts` means a NEW kind fails the
 * build until someone states its audience — which is the mechanism that stops this table
 * decaying the way `routes/approvals.ts` did. (When ADR 0672 was drafted its prose named 6
 * of the 14 tenant-scoped kinds; the prose undercounted and the type is what caught it.)
 */
export const APPROVAL_AUDIENCE: Record<ApprovalKind, Audience> = {
  // ── scoped to the row's org ───────────────────────────────────────────────
  'content-publish': { orgScope: 'host:members:manage' },
  'strategy-activation': { orgScope: 'host:members:manage' }, // ADR 0230 §B3 — same decide bar
  'strategy-checkin': { orgScope: 'workspace:write' },
  'pm-scenario-select': { orgScope: 'workspace:write' },
  // The visitor's captured PII rides `proposal`; the fallthrough would hand it to every
  // member of the surface tenant.
  'anon-surface-write': { orgScope: 'workspace:write' },
  // Field sales — each its OWN scope. One shared scope here would widen three audiences.
  'dealer-registration': { orgScope: 'host:dealers:manage' },
  'territory-model-transition': { orgScope: 'host:territories:manage' },
  'commission-statement': { orgScope: 'host:commissions:manage' },
  // ADR 0924 D4 — the client org's approvers (the `agency` policy).
  'campaign-change-set': { orgScope: 'approvals:respond' },
  // ADR 0959 D7 — agency admins: the row's org is the workspace ROOT.
  'playbook-rollout': { orgScope: 'host:members:manage' },
  // ADR 0905 D3 — org admins, plus the org's configured email approvers.
  'email-campaign-send': { orgScopeOrApproverRefs: 'host:members:manage' },
  // ADR 0948 P1b — the org's writers: the bar the human publish route sets.
  'funnel-publish': { orgScope: 'workspace:write' },

  // ── not expressible as an org scope ───────────────────────────────────────
  'commerce-listing-publish': { superadminTenant: true },
  // ADR 0459 P2 — decided by the participant alone, so visible to them alone.
  'kicktodo-plan-proposal': { policyApproverRef: true },
  // ADR 0785 P4 — a permission prompt about the person's OWN machine: theirs alone.
  'claude-code-permission': { policyApproverRef: true },

  // ── genuinely tenant-scoped ───────────────────────────────────────────────
  // `assistant-action` is the precedent that `null` is a real value, not an oversight:
  // `features/assistant/actionApproval.ts` already emits a create-time tenant-wide
  // broadcast for it, deliberately.
  'run-proposal': null,
  // ADR 0878 D6 — tenant-wide for every assistant action EXCEPT one stamped with an
  // org (a `servicedesk.reply`, its ticket's org). It was plain `null`, so an editor
  // of org A read and could decide org B's drafted reply to org B's customer.
  'assistant-action': { orgScopeWhenOrg: 'workspace:write' },
  'campaign-spend': null,
  // ADR 0945 × 0942 — a client's creative: seen by writers on that client's org.
  'creative-publish-review': { orgScopeWhenOrg: 'workspace:write' },
  'commerce-spend': null,
  'contact-merge': null,
  'warehouse-load': null,
  'challenge-publish': null,
  'community-profile': null,
  'community-review': null,
  'metrics-verifier-sample': null,
  'connect-seller': null,
  'environment-promotion': null,
  'composed-workflow': null,
  'compensation-action': null,
};

const audienceOf = (kind: string | undefined): Audience =>
  APPROVAL_AUDIENCE[(kind ?? 'run-proposal') as ApprovalKind] ?? null;

/**
 * ADR 0878 (grade-code SD2CD-3) — the org of a row that predates its kind's
 * `orgScopeWhenOrg` stamp. A support-reply approval created before ADR 0878 carries
 * no `orgId`, so it would read as tenant-wide forever while its proposal quotes a
 * reply to one org's customer. The OWNING feature registers how to recover the org
 * (the assistant: approval → action → ticket); host code never imports it. Only
 * consulted for an unstamped row of a conditional kind.
 */
type ApprovalOrgResolver = (tenantId: string, a: { actionId?: string | undefined }) => Promise<string | undefined>;
const orgResolvers = new Map<string, ApprovalOrgResolver>();
export function registerApprovalOrgResolver(kind: ApprovalKind, fn: ApprovalOrgResolver): void {
  orgResolvers.set(kind, fn);
}

type AudienceRow = Pick<PendingApproval, 'kind' | 'orgId' | 'policy'> & { actionId?: string | undefined };

/** The audience for THIS row: the conditional variant resolved to its two plain
 *  answers first, so neither function below can fall into the org-scoped branch's
 *  `!a.orgId ⇒ fail closed` for a tenant-scoped row (pre-code review L6). */
async function resolvedAudience(tenantId: string, a: AudienceRow): Promise<{ audience: Exclude<Audience, { orgScopeWhenOrg: string }>; orgId: string | undefined }> {
  const declared = audienceOf(a.kind);
  if (declared !== null && 'orgScopeOrApproverRefs' in declared) return { audience: declared, orgId: a.orgId };
  if (declared === null || !('orgScopeWhenOrg' in declared)) return { audience: declared, orgId: a.orgId };
  const orgId = a.orgId ?? (await orgResolvers.get(a.kind ?? '')?.(tenantId, a));
  return orgId ? { audience: { orgScope: declared.orgScopeWhenOrg }, orgId } : { audience: null, orgId: undefined };
}

/**
 * May `subjectRef` see this row? The PREDICATE half — for `/reviews` and the approvals list.
 *
 * Fails closed on a missing subject or a missing `orgId` for any org-scoped kind: both
 * existing implementations already did, and leaving it unwritten is how it would drift.
 */
export async function mayViewApproval(
  tenantId: string,
  subjectRef: string | undefined,
  a: AudienceRow,
  /** ADR 0778 C14 — a per-request memo of `resolveEffectiveAccess` by
   *  (subject, org): the list path calls this once per row, and each call is
   *  three namespace scans. */
  accessMemo?: Map<string, Promise<EffectiveAccess>>,
): Promise<boolean> {
  const { audience, orgId } = await resolvedAudience(tenantId, a);
  if (audience === null) return true;
  if ('superadminTenant' in audience) return isSuperadminTenant(tenantId);
  if ('policyApproverRef' in audience) return !!subjectRef && subjectRef === a.policy?.approverRefs?.[0];
  if (!subjectRef || !orgId) return false;
  const key = JSON.stringify([tenantId, subjectRef, orgId]);
  let pending = accessMemo?.get(key);
  if (!pending) {
    pending = resolveEffectiveAccess(tenantId, { subject: subjectRef, orgId });
    accessMemo?.set(key, pending);
  }
  const access = await pending;
  if ('orgScopeOrApproverRefs' in audience) {
    if ((access.scopes as readonly string[]).includes(audience.orgScopeOrApproverRefs)) return true;
    return (await isEligibleApprover(subjectRef, approverRefsOf(a), { tenantId, orgId })).eligible;
  }
  return (access.scopes as readonly string[]).includes(audience.orgScope);
}

/** The row's ADR 0075 group/role refs (explicit subject refs are not used here). */
function approverRefsOf(a: AudienceRow): { approverGroupRefs?: string[]; approverRoleRefs?: string[] } {
  return {
    ...(a.policy?.approverGroupRefs ? { approverGroupRefs: a.policy.approverGroupRefs } : {}),
    ...(a.policy?.approverRoleRefs ? { approverRoleRefs: a.policy.approverRoleRefs } : {}),
  };
}

/**
 * Who should be NOTIFIED about this row? The ENUMERATION half — for the SLA rungs.
 *
 * Returns `[]` for a tenant-scoped kind, which the caller reads as "no addressing needed"
 * and NOT as "nobody" — the two are different and the caller must distinguish them.
 *
 * **Cost:** one batched pass. `listMembers` is an unfiltered global scan and
 * `resolveEffectiveAccess` re-reads three stores PER CALL, so the obvious
 * member→resolve loop is `1 + 3N` full-collection reads per approval per rung inside a
 * 60-second daemon. Callers memoize per `(tenantId, orgId)` across a sweep.
 */
export async function approvalRecipients(
  tenantId: string,
  a: AudienceRow,
): Promise<{ addressed: boolean; refs: string[] }> {
  const { audience, orgId: resolvedOrg } = await resolvedAudience(tenantId, a);
  if (audience === null) return { addressed: false, refs: [] };
  if ('policyApproverRef' in audience) {
    const ref = a.policy?.approverRefs?.[0];
    return { addressed: true, refs: ref ? [ref] : [] };
  }
  // A superadmin-tenant row has no per-user address; it is addressed in the sense that it
  // must NOT fan out to a normal tenant, and empty in the sense that we cannot name a user.
  if ('superadminTenant' in audience) return { addressed: true, refs: [] };
  if (!resolvedOrg) return { addressed: true, refs: [] }; // fail closed, as both predicates do
  const members = await listMembers(tenantId, resolvedOrg);
  const refs: string[] = [];
  const scope = 'orgScopeOrApproverRefs' in audience ? audience.orgScopeOrApproverRefs : audience.orgScope;
  if ('orgScopeOrApproverRefs' in audience) {
    const named = await resolveEligibleApprovers(approverRefsOf(a), { tenantId, orgId: resolvedOrg }, { includeDelegates: false });
    if (!named.openGate) refs.push(...named.subjects);
  }
  for (const m of members) {
    // `subject` is OPTIONAL: a descriptive member has no principal binding yet
    // (`accessControlService.ts:317-319`), so there is nobody to address. Skipping is the
    // correct read — coercing would mint a recipient id that matches no principal, and an
    // org of only descriptive members correctly resolves to zero, which the caller handles
    // as the redacted-broadcast case rather than as silence.
    if (!m.subject) continue;
    const access = await resolveEffectiveAccess(tenantId, { subject: m.subject, orgId: resolvedOrg });
    if ((access.scopes as readonly string[]).includes(scope) && !refs.includes(m.subject)) refs.push(m.subject);
  }
  return { addressed: true, refs };
}

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
import { resolveEffectiveAccess, listMembers } from './accessControlService.js';
import { isSuperadminTenant } from './superadmin.js';

/** Who is entitled to see/be told about a row of this kind. */
export type Audience =
  /** Holders of `scope` in the ROW'S org (never the tenant at large). */
  | { orgScope: string }
  /** The single ref in `policy.approverRefs[0]` — the note is PII about that person. */
  | { policyApproverRef: true }
  /** The superadmin tenant only. */
  | { superadminTenant: true }
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

  // ── not expressible as an org scope ───────────────────────────────────────
  'commerce-listing-publish': { superadminTenant: true },
  // ADR 0459 P2 — decided by the participant alone, so visible to them alone.
  'kicktodo-plan-proposal': { policyApproverRef: true },

  // ── genuinely tenant-scoped ───────────────────────────────────────────────
  // `assistant-action` is the precedent that `null` is a real value, not an oversight:
  // `features/assistant/actionApproval.ts` already emits a create-time tenant-wide
  // broadcast for it, deliberately.
  'run-proposal': null,
  'assistant-action': null,
  'campaign-spend': null,
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
 * May `subjectRef` see this row? The PREDICATE half — for `/reviews` and the approvals list.
 *
 * Fails closed on a missing subject or a missing `orgId` for any org-scoped kind: both
 * existing implementations already did, and leaving it unwritten is how it would drift.
 */
export async function mayViewApproval(
  tenantId: string,
  subjectRef: string | undefined,
  a: Pick<PendingApproval, 'kind' | 'orgId' | 'policy'>,
): Promise<boolean> {
  const audience = audienceOf(a.kind);
  if (audience === null) return true;
  if ('superadminTenant' in audience) return isSuperadminTenant(tenantId);
  if ('policyApproverRef' in audience) return !!subjectRef && subjectRef === a.policy?.approverRefs?.[0];
  if (!subjectRef || !a.orgId) return false;
  const access = await resolveEffectiveAccess(tenantId, { subject: subjectRef, orgId: a.orgId });
  return (access.scopes as readonly string[]).includes(audience.orgScope);
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
  a: Pick<PendingApproval, 'kind' | 'orgId' | 'policy'>,
): Promise<{ addressed: boolean; refs: string[] }> {
  const audience = audienceOf(a.kind);
  if (audience === null) return { addressed: false, refs: [] };
  if ('policyApproverRef' in audience) {
    const ref = a.policy?.approverRefs?.[0];
    return { addressed: true, refs: ref ? [ref] : [] };
  }
  // A superadmin-tenant row has no per-user address; it is addressed in the sense that it
  // must NOT fan out to a normal tenant, and empty in the sense that we cannot name a user.
  if ('superadminTenant' in audience) return { addressed: true, refs: [] };
  if (!a.orgId) return { addressed: true, refs: [] }; // fail closed, as both predicates do
  const members = await listMembers(tenantId, a.orgId);
  const refs: string[] = [];
  for (const m of members) {
    // `subject` is OPTIONAL: a descriptive member has no principal binding yet
    // (`accessControlService.ts:317-319`), so there is nobody to address. Skipping is the
    // correct read — coercing would mint a recipient id that matches no principal, and an
    // org of only descriptive members correctly resolves to zero, which the caller handles
    // as the redacted-broadcast case rather than as silence.
    if (!m.subject) continue;
    const access = await resolveEffectiveAccess(tenantId, { subject: m.subject, orgId: a.orgId });
    if ((access.scopes as readonly string[]).includes(audience.orgScope)) refs.push(m.subject);
  }
  return { addressed: true, refs };
}

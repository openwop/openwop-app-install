/**
 * Durable review-decision ledger (ADR 0070) — the cross-instance source of truth
 * for multi-approver / quorum gate votes.
 *
 * Replaces the in-memory `quorumVotes` Map in `routes/interrupts.ts`, which was
 * single-process (lost on restart, wrong across instances). Each decision is one
 * durable row keyed `(interruptId, reviewerRef)` — so a reviewer's duplicate
 * vote OVERWRITES their own prior record and can never become two counted votes
 * (the dedup guarantee). The tally is computed from the durable rows, so a
 * concurrent voter on another instance sees the same count.
 *
 * Finality is NOT in this ledger: the single gate transition stays the existing
 * `storage.resolveInterrupt` conditional CAS (one winner). The ledger + an
 * idempotent finalize-if-met re-driven on every vote AND read converge the gate
 * even across a crash between the append and the resolve (the standard
 * event-sourced-ledger + idempotent-projection shape).
 *
 * Backed by the host-ext `DurableCollection`. NON-NORMATIVE.
 *
 * @see docs/adr/0070-quorum-review-policies.md
 */

import { DurableCollection } from './hostExtPersistence.js';

export type DecisionOutcome = 'approved' | 'rejected' | 'override_approved';

export interface ReviewDecision {
  /** The GATE this decision is for — a runtime interrupt id OR a pending-approval
   *  id (ADR 0070 generalized the ledger across both review owners). */
  gateId: string;
  /** The DEDUP key part — the authenticated reviewer subject (ADR 0070) or, on
   *  the legacy token/conformance path, the client-supplied voter id. */
  reviewerRef: string;
  outcome: DecisionOutcome;
  reason?: string;
  decidedAt: string;
}

// Key `${gateId}:${reviewerRef}`. gateId is a fixed-length unique id (`int-…` /
// `appr:<uuid>`), so no gateId is a prefix of another and the trailing-`:` prefix
// scan is unambiguous even when gateId/reviewerRef contain colons; rows carry
// their own ids, keys are never parsed.
const decisions = new DurableCollection<ReviewDecision>(
  'review:decision',
  (d) => `${d.gateId}:${d.reviewerRef}`,
);

/** Record (or overwrite) one reviewer's decision for a gate. Overwrite-by-key is
 *  the dedup: a reviewer who votes twice has exactly one row, so they count once. */
export async function appendDecision(d: ReviewDecision): Promise<void> {
  await decisions.put(d);
}

export interface DecisionTally {
  /** reviewerRefs that approved (incl. override approvals). */
  accepts: string[];
  /** reviewerRefs that rejected. */
  rejects: string[];
}

/** Rejection semantics for a quorum gate (ADR 0070). `any` (the default) — a
 *  single reject vetoes the gate; `majority` — more than half of
 *  `requiredApprovals` must reject. Per `interrupt-profiles.md
 *  §openwop-interrupt-quorum`, the host MUST pick a deterministic, documented
 *  rule; this is that rule, applied uniformly to BOTH runtime-interrupt and
 *  pre-execution-approval quorum gates. */
export type RejectionPolicy = 'any' | 'majority';

export interface QuorumPolicy {
  requiredApprovals: number;
  rejectionPolicy?: RejectionPolicy;
}

/** The verdict for a gate from its durable tally: `accept` (quorum met),
 *  `reject` (rejection threshold met), or `pending` (neither yet). */
export type QuorumVerdict = 'accept' | 'reject' | 'pending';

/**
 * The SINGLE owner of the quorum finalize math (ADR 0070) — both
 * `routes/interrupts.ts` (runtime gates) and `host/approvalDecision.ts`
 * (pre-execution gates) evaluate a gate through this one function, so the
 * threshold + rejection semantics can never drift between the two surfaces.
 *
 * `accept` wins as soon as `accepts >= requiredApprovals`. Rejection threshold
 * is 1 for the `any` default (one reject vetoes) and `floor(n/2)+1` for
 * `majority`. Accept is checked first: if a gate has somehow accrued both an
 * accept-quorum and a reject-threshold (only reachable via concurrent votes on a
 * gate that should already be resolved), the affirmative outcome wins — the
 * caller still gates the actual transition behind its CAS.
 */
export function evaluateQuorumTally(tally: DecisionTally, policy: QuorumPolicy): QuorumVerdict {
  const required = policy.requiredApprovals;
  if (tally.accepts.length >= required) return 'accept';
  const rejectThreshold = policy.rejectionPolicy === 'majority' ? Math.floor(required / 2) + 1 : 1;
  if (tally.rejects.length >= rejectThreshold) return 'reject';
  return 'pending';
}

/** Tally a gate's durable decisions into distinct accept/reject reviewer sets. */
export async function tallyDecisions(gateId: string): Promise<DecisionTally> {
  const rows = await decisions.listByPrefix(`${gateId}:`);
  const accepts: string[] = [];
  const rejects: string[] = [];
  for (const r of rows) {
    if (r.outcome === 'rejected') rejects.push(r.reviewerRef);
    else accepts.push(r.reviewerRef); // approved | override_approved
  }
  return { accepts, rejects };
}

/** Remove a gate's decisions once it has resolved (the ledger is per-gate-lifetime). */
export async function clearDecisions(gateId: string): Promise<void> {
  const rows = await decisions.listByPrefix(`${gateId}:`);
  await Promise.all(rows.map((r) => decisions.delete(`${r.gateId}:${r.reviewerRef}`)));
}

/** Test-only: clear the whole ledger. */
export async function __clearDecisionLedger(): Promise<void> {
  await decisions.__clear();
}

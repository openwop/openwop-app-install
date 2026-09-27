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
import { registerSubjectEraser } from './subjectErasure.js';
import { subjectKeyForms } from './subjectErasureRedaction.js';

export type DecisionOutcome = 'approved' | 'rejected' | 'override_approved';

/** ADR 0464 — the sentinel an anonymized subject identifier / redacted free-text
 *  field is replaced with. Shared with the approvals redactor registry. */
export const ERASED_REF = '[erased]';

export interface ReviewDecision {
  /** The GATE this decision is for — a runtime interrupt id OR a pending-approval
   *  id (ADR 0070 generalized the ledger across both review owners). */
  gateId: string;
  /** The DEDUP key part — the CONSUMED vote identity: the authenticated
   *  reviewer subject (ADR 0070), the principal a delegate acted for
   *  (ADR 0198 — see `actedBy`), or, on the legacy token/conformance path,
   *  the client-supplied voter id. */
  reviewerRef: string;
  /** ADR 0198 — when a delegate cast this vote on a principal's behalf, the
   *  actual voter. `reviewerRef` carries the principal (the consumed
   *  identity), so the pair can never count twice; this field preserves who
   *  really clicked, for the audit trail and review surfaces. */
  actedBy?: string;
  /** ADR 0464 — the tenant this decision belongs to, populated on every write
   *  from the owning gate (approval.tenantId / the run's tenantId). REQUIRED
   *  for the subject-erasure eraser to tenant-scope its sweep. Optional on the
   *  type only to tolerate LEGACY rows written before this field existed — the
   *  eraser handles those via a ref-match-only full scan (see `eraseReviewDecisionsForSubject`). */
  tenantId?: string;
  /** ADR 0464 — the FROZEN original `reviewerRef`, set ONLY at erasure time so the
   *  row's deterministic key can stay stable while the readable `reviewerRef`
   *  FIELD is anonymized. Absent on every normal write (the key then derives from
   *  `reviewerRef` exactly as before). See `keyOf` + `eraseReviewDecisionsForSubject`. */
  keyRef?: string;
  outcome: DecisionOutcome;
  reason?: string;
  decidedAt: string;
}

// Key `${gateId}:${keyRef ?? reviewerRef}`. gateId is a fixed-length unique id
// (`int-…` / `appr:<uuid>`), so no gateId is a prefix of another and the
// trailing-`:` prefix scan is unambiguous even when the parts contain colons;
// rows carry their own ids, keys are never parsed.
//
// ADR 0464 — the key derives from `keyRef` WHEN PRESENT (frozen at erasure), else
// `reviewerRef` (every normal row). This lets erasure anonymize the `reviewerRef`
// FIELD to a sentinel WITHOUT changing the key: re-keying to the sentinel would
// (a) collide two distinct erased voters on one gate into a single key, silently
// dropping a vote and CHANGING a resolved gate's tally, and (b) orphan the old
// row. Freezing the original ref into `keyRef` keeps every row's key — and thus
// the quorum count — byte-stable while the queryable identity is scrubbed.
const keyOf = (d: ReviewDecision): string => `${d.gateId}:${d.keyRef ?? d.reviewerRef}`;
const decisions = new DurableCollection<ReviewDecision>('review:decision', keyOf);

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

/**
 * The accepted `rejectionPolicy` tokens on the AUTHORING side — the union of the
 * two vocabularies that genuinely exist in this system:
 *
 *  - `single-veto` | `majority` — `schemas/suspend-request.schema.json`, the WIRE
 *    enum, whose default is `single-veto`;
 *  - `any` | `majority` — this host's internal {@link RejectionPolicy}.
 *
 * The two describe identical behaviour (`single-veto` and `any` both mean a
 * rejection threshold of 1); only the spelling differs, which is why the union is
 * accepted rather than one of them being declared wrong.
 */
export const AUTHORED_REJECTION_POLICIES = ['any', 'single-veto', 'majority'] as const;

/**
 * Normalize an AUTHORED `rejectionPolicy` to the host vocabulary, or return
 * `null` when the value is in NEITHER vocabulary.
 *
 * ── ADR 0600 §6 (`ISU-11` / `ISC-13` / `ISWF-13`) ───────────────────────────
 *
 * Both consumer sites read this field as
 * `x === 'majority' ? 'majority' : 'any'`, which means every value that is not
 * the literal `'majority'` — including a typo, including a token from no
 * vocabulary at all — SILENTLY becomes the default. `insights-suite` shipped
 * `rejectionPolicy:"block"` for months: it read as a deliberate safety choice in
 * a chain a human opens in the Builder, it enforced nothing, and editing it to
 * any other invented value would have produced no behavioural difference either.
 * A decorative control that looks like a safety control is the defect.
 *
 * **The asymmetry here is deliberate: the WRITER refuses, the READERS coerce.**
 * `core.approvalGate` calls this and fails `invalid_config` on `null`, because at
 * authoring time an unrecognized token is a mistake a human can still fix. The
 * two resolve-time sites keep coercing, because they read data ALREADY PERSISTED
 * on a suspended interrupt — refusing there would strand a live gate with no exit
 * (the ADR 0599 §6 "a refusal that persists is worse than the bug it replaced"
 * rule), and the coerced value is the safe direction anyway (threshold 1).
 */
export function normalizeRejectionPolicy(value: unknown): RejectionPolicy | null {
  if (value === 'majority') return 'majority';
  if (value === 'any' || value === 'single-veto') return 'any';
  return null;
}

/**
 * The WRITER-side refusal, in ONE place — shared by every node that can put a
 * `rejectionPolicy` onto an approval interrupt.
 *
 * ── ADR 0600 §Correction 9 (`LOW-1`) ────────────────────────────────────────
 *
 * §6 claimed `core.approvalGate` is *"the ONE choke both authoring lanes pass
 * through"*. That is true of the NODE and false of the FIELD.
 * `core.interrupt` forwards `config.data` **verbatim**
 * (`bootstrap/nodes.ts`), and both readers pull `data.rejectionPolicy` off any
 * approval interrupt regardless of which node raised it — so the exact defect
 * §6 closed stayed authorable through the pack lane, **which is how
 * `rejectionPolicy:"block"` shipped in the first place**.
 *
 * Two nodes, one rule. Hand-copying the guard into the second node is how the
 * two `x === 'majority' ? 'majority' : 'any'` readers drifted from the schema in
 * the first place, and §6 already collapsed those into one helper for exactly
 * this reason.
 *
 * Returns the refusal outcome, or `null` when the value is absent or legal.
 */
export function refuseUnknownRejectionPolicy(
  typeId: string,
  value: unknown,
): { status: 'failure'; error: { code: string; message: string } } | null {
  if (value === undefined || normalizeRejectionPolicy(value) !== null) return null;
  return {
    status: 'failure',
    error: {
      code: 'invalid_config',
      message: `${typeId}: rejectionPolicy must be one of ${AUTHORED_REJECTION_POLICIES.join(' | ')} (got ${JSON.stringify(value)}). An unrecognized value used to be accepted and silently coerced to the default, which made it decorative.`,
    },
  };
}

/** The resolve-time READER: coerce rather than refuse, per the asymmetry above.
 *  Shared so the two consumer sites cannot drift from each other or from
 *  {@link normalizeRejectionPolicy}. */
export function readRejectionPolicy(value: unknown): RejectionPolicy {
  return normalizeRejectionPolicy(value) ?? 'any';
}

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

/** Remove a gate's decisions once it has resolved (the ledger is per-gate-lifetime).
 *  Deletes by `keyOf` (NOT a hand-built `${gateId}:${reviewerRef}`) so an
 *  erasure-anonymized row — whose `reviewerRef` field is a sentinel but whose key
 *  is frozen in `keyRef` — is still deleted at its real key. Legacy rows (no
 *  `keyRef`) key off `reviewerRef` exactly as before, so this handles both. */
export async function clearDecisions(gateId: string): Promise<void> {
  const rows = await decisions.listByPrefix(`${gateId}:`);
  await Promise.all(rows.map((r) => decisions.delete(keyOf(r))));
}

/**
 * ADR 0464 — subject-erasure reach into the review-decision ledger. A DSAR-erased
 * subject may be the `reviewerRef` (their own vote) or the `actedBy` delegate on
 * another principal's vote. This anonymizes those identity fields to the sentinel
 * and redacts the free-text `reason`, IN PLACE, PRESERVING the tally/quorum shape:
 *   - the key stays frozen (via `keyRef`), so the row still counts as exactly one
 *     vote at its gate and a RESOLVED gate's outcome can never change;
 *   - `reviewerRef`/`actedBy` FIELDS → sentinel (the readable identity is scrubbed;
 *     the id survives only inside the opaque storage key, which the tally never
 *     exposes — the documented structural residual, ADR 0464 §review:decision).
 *
 * The ledger has no tenant secondary index (rows key on gate + reviewer), so this
 * is a full scan. Rows carrying `tenantId` are tenant-scoped; LEGACY rows without
 * it fall through to a ref-match-only sweep — honest best-effort, since an
 * untenanted row can't be attributed to a tenant, and scrubbing the erased
 * subject's OWN ref wherever it appears is safe (it never touches another
 * subject's row). Tenant-scoped, idempotent (re-running finds the fields already
 * at the sentinel and skips the write), no notifications. Returns the count touched.
 */
export async function eraseReviewDecisionsForSubject(tenantId: string, subjectKey: string): Promise<number> {
  if (!tenantId || !subjectKey) return 0;
  // Match every subject-key form (raw + scoped) — the DSAR entry accepts either.
  const { forms } = subjectKeyForms(subjectKey);
  let touched = 0;
  for (const d of await decisions.list()) {
    // Tenant scope: honour a present tenantId; legacy rows (absent) fall through.
    if (d.tenantId !== undefined && d.tenantId !== tenantId) continue;
    const hitReviewer = forms.has(d.reviewerRef);
    const hitActedBy = d.actedBy !== undefined && forms.has(d.actedBy);
    if (!hitReviewer && !hitActedBy) continue;
    const next: ReviewDecision = {
      ...d,
      // Freeze the ORIGINAL reviewerRef into the key so anonymizing the field
      // below does not re-key (and thus cannot collide/drop a vote).
      keyRef: d.keyRef ?? d.reviewerRef,
      ...(hitReviewer ? { reviewerRef: ERASED_REF } : {}),
      ...(hitActedBy ? { actedBy: ERASED_REF } : {}),
      ...(d.reason !== undefined ? { reason: ERASED_REF } : {}),
    };
    // Idempotency: nothing left to change once fields are already sentinels and
    // the key is already frozen.
    if (next.reviewerRef === d.reviewerRef && next.actedBy === d.actedBy
        && next.reason === d.reason && next.keyRef === d.keyRef) continue;
    await decisions.put(next);
    touched += 1;
  }
  return touched;
}

/** ADR 0464 — cover this host store on the subject-erasure seam. Called from
 *  `registerHostSubjectErasers()` (the ONE explicit boot list); `eraseSubject`
 *  invokes the eraser once per linked identity key. */
export function registerReviewDecisionErasure(): void {
  registerSubjectEraser(async function eraseReviewDecisions(tenantId, subjectKey) { await eraseReviewDecisionsForSubject(tenantId, subjectKey); });
}
/** Test-only: clear the whole ledger. */
export async function __clearDecisionLedger(): Promise<void> {
  await decisions.__clear();
}

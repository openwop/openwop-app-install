/**
 * ADR 0554 P3 — the AUDIT half of operator recovery (RFC 0151 §E/§G).
 *
 * WHAT THIS IS: an OBLIGATION-SCOPED chain riding the EXISTING per-tenant
 * hash-chain (`host/auditChainService.ts`). Not a second audit system — the
 * appends go through `appendAudit`, so they inherit that module's per-tenant
 * mutex, its seq-claim CAS, its sha256 linkage and its `verifyChain`.
 *
 * ── WHAT THE PER-OBLIGATION PREV POINTER DOES AND DOES NOT BUY ─────────────
 *
 * Stated plainly because the honest version is smaller than the impressive one:
 * **the tamper evidence comes from the TENANT chain, not from these pointers.**
 * `verifyChain` already walks seq 0..head, recomputes every entry hash and
 * checks every linkage, so a deleted, mutated or reordered entry is detected
 * there whether or not this module exists.
 *
 * What the pointers buy is SLICE-LOCAL verifiability. A reader who fetches only
 * ONE obligation's timeline can check continuity without downloading and
 * re-hashing every entry the tenant ever wrote — and, concretely, it detects a
 * SERVING-SIDE OMISSION: the timeline endpoint silently dropping a record from
 * the slice it returns. That failure is invisible to `verifyChain` (the store is
 * intact; the projection lied), and it is exactly the failure a UI panel is
 * exposed to.
 *
 * So there are two guards, they catch different things, and
 * `compensation-recovery-audit.test.ts` proves each one separately. Crediting
 * the pointer with the store-tamper coverage would be the dishonest half.
 *
 * ── THE ENTRY IS A REQUEST, NOT AN OUTCOME ────────────────────────────────
 *
 * The payload carries `requestedState`, never `nextState`. The applier appends
 * BEFORE it writes the ledger row (see `compensationRecovery.ts`), so an entry
 * can outlive a crash that stopped the write. If the payload asserted the new
 * state as fact, that crash would leave a record of a waive that never happened
 * — a fabricated outcome, which is worse than the over-recording it replaced.
 *
 * The ledger row's `recoveryAuditSeq` is the WITNESS OF APPLICATION, and the
 * join is one-way and unambiguous: an entry whose obligation row does not carry
 * its seq is `recorded, not applied`.
 *
 * @see docs/adr/0554-compensation-saga-and-operator-recovery-runtime.md
 * @see host/auditChainService.ts
 */

import {
  appendAudit,
  listChain,
  type AuditEntry,
} from './auditChainService.js';
import type { CompensationState } from './compensationLedger.js';

/** The audit kind. Free string by the chain's own contract; ONE spelling, here. */
export const AUDIT_KIND_COMPENSATION_RECOVERY = 'compensation.recovery';

/**
 * Every operator recovery action. `start` is HOST-EXT (ADR 0554 P3's own
 * addition for the P2 sweeper residue); the other four are §21's closed set.
 */
export type CompensationRecoveryAction = 'start' | 'retry' | 'skip' | 'substitute' | 'terminate';

export const COMPENSATION_RECOVERY_ACTIONS: readonly CompensationRecoveryAction[] = [
  'start', 'retry', 'skip', 'substitute', 'terminate',
];

/**
 * The recovery-audit payload. Closed by construction — every field is either an
 * opaque id, a closed enum, or an operator-supplied justification the §E rule
 * requires. Nothing derived from an effect's payload appears: §G puts
 * compensation credentials and provider bodies out of bounds on the durable
 * path, and this is on it.
 */
export interface CompensationRecoveryAuditPayload extends Record<string, unknown> {
  readonly obligationId: string;
  readonly runId: string;
  readonly action: CompensationRecoveryAction;
  /** The acting principal — opaque, per RFC 0048. */
  readonly actor: string;
  /** The scope the route required to admit this action. */
  readonly requiredScope: string;
  /** Non-empty for every override action; see the reason rule. */
  readonly reason?: string;
  /** The obligation's state BEFORE the action. */
  readonly priorState: CompensationState;
  /** The state the operator ASKED for — not a claim that it was reached. */
  readonly requestedState: CompensationState;
  /** The previous `compensation.recovery` entry FOR THIS OBLIGATION, or null at
   *  the head of the obligation's slice. */
  readonly prevSeq: number | null;
  readonly prevEntryHash: string | null;
}

/** One row of an obligation's action history, joined against the ledger. */
export interface CompensationRecoveryRecord {
  readonly seq: number;
  readonly at: string;
  readonly entryHash: string;
  readonly payload: CompensationRecoveryAuditPayload;
  /**
   * True when the obligation row carries this entry's seq — i.e. the action the
   * entry records was actually APPLIED. False means recorded-not-applied (the
   * crash window), which the UI renders as such rather than as a completed act.
   */
  readonly applied: boolean;
}

function isRecoveryPayload(p: Record<string, unknown>): p is CompensationRecoveryAuditPayload {
  return typeof p['obligationId'] === 'string' && typeof p['action'] === 'string';
}

/** Every `compensation.recovery` entry for one obligation, ascending by seq. */
async function sliceFor(tenantId: string, obligationId: string): Promise<AuditEntry[]> {
  const chain = await listChain(tenantId);
  return chain.filter(
    (e) => e.kind === AUDIT_KIND_COMPENSATION_RECOVERY
      && isRecoveryPayload(e.payload)
      && e.payload.obligationId === obligationId,
  );
}

/**
 * Append one recovery-audit entry for `obligationId` and return its seq + hash.
 *
 * THE CALLER MUST HOLD THE PER-OBLIGATION LOCK. The prev pointer is a
 * read-then-append: two concurrent actions on one obligation would otherwise
 * read the same predecessor and FORK the obligation's slice — two entries
 * claiming one prev, which `verifyRecoverySlice` would then report as broken for
 * a history that is actually legitimate. `compensationRecovery.ts` calls this
 * inside the same critical section that guards the ledger write, which is the
 * only place both invariants can be held at once.
 *
 * Interleaving with OTHER obligations in the same tenant is safe and still
 * verifies: `appendAudit` serializes globally per tenant, and each obligation's
 * slice is a subsequence whose prev pointers skip the others' entries.
 */
export async function appendRecoveryAudit(input: {
  readonly tenantId: string;
  readonly obligationId: string;
  readonly runId: string;
  readonly action: CompensationRecoveryAction;
  readonly actor: string;
  readonly requiredScope: string;
  readonly reason?: string;
  readonly priorState: CompensationState;
  readonly requestedState: CompensationState;
}): Promise<{ seq: number; entryHash: string }> {
  const prior = await sliceFor(input.tenantId, input.obligationId);
  const last = prior.length > 0 ? prior[prior.length - 1] : undefined;

  const payload: CompensationRecoveryAuditPayload = {
    obligationId: input.obligationId,
    runId: input.runId,
    action: input.action,
    actor: input.actor,
    requiredScope: input.requiredScope,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    priorState: input.priorState,
    requestedState: input.requestedState,
    prevSeq: last?.seq ?? null,
    prevEntryHash: last?.entryHash ?? null,
  };

  const entry = await appendAudit(input.tenantId, AUDIT_KIND_COMPENSATION_RECOVERY, payload);
  return { seq: entry.seq, entryHash: entry.entryHash };
}

/**
 * Verify ONE obligation's slice: contiguous prev-pointer linkage, head anchored
 * at null.
 *
 * Deliberately does NOT re-hash entries — that is `verifyChain`'s job and
 * duplicating it here would be a second copy of a rule that already has an
 * owner. This answers the question `verifyChain` cannot: "is the slice I was
 * HANDED complete?"
 *
 * Takes the records rather than reading them so a caller can verify exactly what
 * a client was served — which is what makes the serving-side-omission leg of
 * `compensation-recovery-audit.test.ts` able to fail.
 */
export function verifyRecoverySlice(
  records: readonly { seq: number; entryHash: string; payload: CompensationRecoveryAuditPayload }[],
): { ok: true } | { ok: false; brokenAt: number; detail: string } {
  let expectedPrevSeq: number | null = null;
  let expectedPrevHash: string | null = null;
  for (const r of records) {
    if (r.payload.prevSeq !== expectedPrevSeq || r.payload.prevEntryHash !== expectedPrevHash) {
      return {
        ok: false,
        brokenAt: r.seq,
        detail: `entry ${r.seq} chains to ${String(r.payload.prevSeq)}, expected ${String(expectedPrevSeq)}`,
      };
    }
    expectedPrevSeq = r.seq;
    expectedPrevHash = r.entryHash;
  }
  return { ok: true };
}

/**
 * The READ MODEL — one obligation's action history, joined against the ledger
 * row so each entry declares whether it was applied.
 *
 * `appliedSeqs` is the row's `recoveryAuditSeqs`, and the join is exact
 * MEMBERSHIP, not a `<=` comparison against a latest-seq. The comparison would
 * report an entry that crashed mid-apply as applied the moment any LATER action
 * succeeded — a false positive on precisely the record an incident review is
 * reading. See the field's own note on the ledger row.
 */
export async function recoveryHistory(
  tenantId: string,
  obligationId: string,
  appliedSeqs: readonly number[],
): Promise<CompensationRecoveryRecord[]> {
  const applied = new Set(appliedSeqs);
  const slice = await sliceFor(tenantId, obligationId);
  return slice.map((e) => ({
    seq: e.seq,
    at: e.at,
    entryHash: e.entryHash,
    payload: e.payload as CompensationRecoveryAuditPayload,
    applied: applied.has(e.seq),
  }));
}

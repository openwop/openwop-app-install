/**
 * ADR 0807 — `GET /runs/{runId}/compensation`, the v2 compensation read
 * projection (`schemas/v2/compensation-projection.schema.json`, RFC 0173 §C.1,
 * `security-defaults.md` §Compensation).
 *
 * A host advertising `compensation` at major 2 MUST serve it. It is a pure
 * function of the ledger rows the run is ACCOUNTABLE for — the same bucketing
 * the snapshot's `compensationStatus` reads (`obligationsAccountableTo`), so the
 * projection and the snapshot can never disagree about the rollup.
 *
 * WHAT IT CAN AND CANNOT SAY, stated:
 * - `plan[]` is the ledger in `reverse-completion` order ("the rows ARE the
 *   plan", RFC 0151 §C). A row minted before ADR 0554 P2 carries no `nodeId`,
 *   which the schema requires, so it cannot be named and is left out rather
 *   than given an invented id. `order` is still contiguous over what is shown.
 * - `attempts[]` holds ONE entry per obligation that has been resolved: the
 *   number of attempts MADE (the ledger's `attempts`), the outcome, and when it
 *   was resolved. The unwind's retry loop does not persist each try, so the
 *   failures that preceded a final outcome inside one pass are not recorded
 *   anywhere and are not reconstructed here. An obligation that has not been
 *   attempted contributes nothing.
 */
import type { CompensationObligation, CompensationStatus } from './compensationLedger.js';
import { foldCompensationStatus } from './compensationLedger.js';

/** The projection's own enum spells the manual state in full; the ledger and
 *  the v2 snapshot's `compensationStatus` spell it `manual`. */
export type ProjectionStatus = Exclude<CompensationStatus, 'manual'> | 'manual-intervention';

export interface CompensationProjection {
  runId: string;
  status: ProjectionStatus;
  plan: Array<{ nodeId: string; order: number; irreversibleEffect?: boolean }>;
  attempts: Array<{ nodeId: string; attempt: number; outcome: 'succeeded' | 'failed' | 'skipped' | 'manual'; at: string; reason?: string }>;
}

function projectionStatus(s: CompensationStatus): ProjectionStatus {
  return s === 'manual' ? 'manual-intervention' : s;
}

/** A resolved obligation's outcome, or null while nothing has been decided. */
function outcomeOf(o: CompensationObligation): CompensationProjection['attempts'][number]['outcome'] | null {
  switch (o.state) {
    case 'completed': return 'succeeded';
    case 'failed': return 'failed';
    case 'manual_intervention_required': return 'manual';
    default: return null; // requested / started / paused — no outcome yet
  }
}

/**
 * Build the projection from the rows the run is accountable for, already in
 * `reverse-completion` order. `runId` is the id the caller read, in the
 * host's own spelling; the response projector binds it on the wire.
 */
export function projectCompensation(runId: string, rows: readonly CompensationObligation[]): CompensationProjection {
  const named = rows.filter((o): o is CompensationObligation & { nodeId: string } => typeof o.nodeId === 'string' && o.nodeId.length > 0);
  const plan = named.map((o, order) => ({
    nodeId: o.nodeId,
    order,
    ...(o.shape === 'irreversible' ? { irreversibleEffect: true } : {}),
  }));
  const attempts: CompensationProjection['attempts'] = [];
  for (const o of named) {
    const outcome = outcomeOf(o);
    if (outcome === null || o.attempts < 1) continue;
    attempts.push({
      nodeId: o.nodeId,
      attempt: o.attempts,
      outcome,
      at: o.updatedAt,
      ...(typeof o.reason === 'string' && o.reason ? { reason: o.reason } : {}),
    });
  }
  return { runId, status: projectionStatus(foldCompensationStatus(rows)), plan, attempts };
}

/**
 * RFC 0223 (interrupt.md §Rejection, last bullet; replay.md §Determinism 2) —
 * "On replay the failure MUST be derived from the recorded `interrupt.resolved`,
 * never re-decided." Witnessed by `0223.replay-derives-rejection` (openwop#1756).
 *
 * A `replay` fork whose copied prefix ends with a gate still OPEN (ADR 0751 —
 * the fork point sits between the gate's suspension and its resolution) used to
 * re-create the gate LIVE and wait for a new decision: a re-deciding host. The
 * SOURCE run already recorded the decision, so a replay takes it from there:
 *
 *   - the fork gets its own interrupt row for the gate (the ADR 0751 re-creation,
 *     inherited `createdAt`), RESOLVED at once with the source's resolved value —
 *     so a later resolve answers `409 interrupt_already_resolved`;
 *   - the fork records an `interrupt.resolved` carrying the SOURCE payload
 *     (decision / action / reason / resolvedBy), with the fork's own interruptId
 *     (a host may re-mint ids);
 *   - the executor then applies it exactly as a live resolution: a rejection
 *     fails the gate node (`approval_rejected`, `retryable: false`) and the
 *     scheduler routes it; an accept completes it with the recorded value.
 *
 * NO new `interrupt.requested` is raised: the gate never re-executes (ADR 0751),
 * and this path never passes the suspension branch that emits one.
 *
 * Exactly once across a redelivery: when the fork's own log already carries the
 * derived `interrupt.resolved`, nothing is appended again — the state is just
 * re-applied.
 *
 * `branch` forks are untouched: a branch is a NEW decision point by definition.
 */
import { createHash } from 'node:crypto';
import type { Storage } from '../storage/storage.js';
import type { InterruptRecord, RunRecord } from '../types.js';
import type { getSuspendManager } from './suspendManager.js';

export interface DerivedResolution {
  nodeId: string;
  kind: InterruptRecord['kind'];
  /** The fork's own interrupt id for the gate. */
  interruptId: string;
  /** The source's `interrupt.resolved` payload, re-pointed at the fork's interrupt. */
  payload: Record<string, unknown>;
  /** The resolved value the source recorded on its interrupt row. */
  resolvedValue: unknown;
  /** Whether the fork's log already holds this `interrupt.resolved` (a redelivery). */
  alreadyRecorded: boolean;
  /** Someone ELSE decided the fork's gate row (see `DERIVED_MARKER`): the
   *  recorded resolution is NOT applied, and the gate fails closed instead. */
  conflict: boolean;
}

/**
 * The marker a DERIVED row's resolved value carries, so a redelivery can tell
 * "we resolved this" from "a person resolved this". A replay never re-decides
 * (interrupt.md §Rejection, replay.md §Determinism 2), so a decision made BY
 * SOMEONE ELSE on a replay fork's gate is not an input the replay may apply —
 * and the recorded one can no longer be applied faithfully either, since the
 * row now says otherwise. Both outcomes are wrong; the gate FAILS CLOSED
 * (`replay_gate_conflict`) rather than letting two decisions disagree.
 */
const DERIVED_MARKER = '__derivedFromReplay';

function isDerivedValue(v: unknown, parentRunId: string): boolean {
  return !!v && typeof v === 'object' && (v as Record<string, unknown>)[DERIVED_MARKER] === parentRunId;
}

function unwrapDerived(v: unknown): unknown {
  return v && typeof v === 'object' && DERIVED_MARKER in v ? (v as Record<string, unknown>)['value'] : v;
}

const PAGE = 1000;

async function firstResolvedAfter(
  storage: Pick<Storage, 'listEvents'>,
  runId: string,
  afterSeq: number,
  nodeId: string,
): Promise<Record<string, unknown> | null> {
  let fromSeq = afterSeq;
  for (;;) {
    const page = await storage.listEvents(runId, { fromSeq, limit: PAGE, contract: 1 });
    for (const e of page) {
      if (e.type === 'interrupt.resolved' && e.nodeId === nodeId) {
        return (e.payload && typeof e.payload === 'object' ? e.payload : {}) as Record<string, unknown>;
      }
    }
    if (page.length < PAGE) return null;
    fromSeq = page[page.length - 1]!.sequence;
  }
}

/**
 * For each gate the fork's snapshot holds suspended, the SOURCE's recorded
 * resolution (when there is one), with the fork's interrupt row created and
 * resolved to carry it. Gates the source never resolved are left to the ADR 0751
 * live re-creation.
 */
export async function deriveRecordedResolutions(input: {
  storage: Pick<Storage, 'listEvents' | 'getInterrupt' | 'getInterruptByNode' | 'resolveInterrupt'>;
  suspend: ReturnType<typeof getSuspendManager>;
  run: RunRecord;
  suspendedNodeIds: readonly string[];
}): Promise<DerivedResolution[]> {
  const { storage, suspend, run, suspendedNodeIds } = input;
  if (run.forkMode !== 'replay' || !run.parentRunId || suspendedNodeIds.length === 0) return [];
  // The fork point: events BEFORE `parentSeq` are the copied prefix; the source's
  // resolution sits at or after it.
  const cut = (run.parentSeq ?? 0) - 1;
  const out: DerivedResolution[] = [];
  for (const nodeId of suspendedNodeIds) {
    const recorded = await firstResolvedAfter(storage, run.parentRunId, cut, nodeId);
    if (!recorded) continue;
    const sourceRow = typeof recorded['interruptId'] === 'string'
      ? await storage.getInterrupt(recorded['interruptId'])
      : await storage.getInterruptByNode(run.parentRunId, nodeId);
    const kind = (sourceRow?.kind ?? (typeof recorded['kind'] === 'string' ? recorded['kind'] : 'approval')) as InterruptRecord['kind'];
    // The fork's own row. It is INSERTED ALREADY RESOLVED: never open, so no
    // human path can decide it and no notification surfaces it (the first cut
    // created it open — which fired the inbox notification — and resolved it a
    // step later, discarding the CAS result; a person deciding the row in that
    // window left the gate with two outcomes). A source that is itself a replay
    // fork holds a marked row: take its value.
    const sourceValue = unwrapDerived(sourceRow?.resolvedValue);
    const derivedValue = { [DERIVED_MARKER]: run.parentRunId, value: sourceValue ?? null };
    // Deterministic, so a redelivery finds the row it already derived.
    const derivedId = createHash('sha256').update(`replay-derived\0${run.runId}\0${nodeId}`).digest('hex').slice(0, 32);
    let conflict = false;
    let row = await storage.getInterrupt(derivedId);
    const open = row ? null : await storage.getInterruptByNode(run.runId, nodeId);
    if (open) {
      // An OPEN row for the gate already exists (one this derivation did not
      // insert). Claim it with the CAS and HONOUR the result: losing means
      // someone else decided it first, and theirs is not ours to overwrite.
      row = open;
      const won = await storage.resolveInterrupt(open.interruptId, derivedValue, new Date().toISOString());
      if (!won) conflict = !isDerivedValue((await storage.getInterrupt(open.interruptId))?.resolvedValue, run.parentRunId);
    } else if (!row) {
      try {
        row = await suspend.createInterrupt({
          runId: run.runId,
          nodeId,
          kind,
          data: sourceRow?.data ?? {},
          ...(sourceRow?.resumeSchema ? { resumeSchema: sourceRow.resumeSchema } : {}),
          ...(sourceRow?.createdAt ? { createdAt: sourceRow.createdAt } : {}),
          interruptId: derivedId,
          resolved: { value: derivedValue, at: new Date().toISOString() },
        });
      } catch (err) {
        // A concurrent delivery inserted the same id first: use its row.
        row = await storage.getInterrupt(derivedId);
        if (!row) throw err;
      }
    }
    const alreadyRecorded = !conflict && (await firstResolvedAfter(storage, run.runId, cut, nodeId)) !== null;
    out.push({
      nodeId,
      kind,
      interruptId: row.interruptId,
      payload: { ...recorded, interruptId: row.interruptId },
      resolvedValue: sourceValue,
      alreadyRecorded,
      conflict,
    });
  }
  return out;
}

/** A recorded resolution that REJECTED the gate (a decided reject, or a timeout). */
export function isRecordedRejection(payload: Record<string, unknown>): boolean {
  return payload['decision'] === 'rejected' || payload['action'] === 'reject' || payload['action'] === 'timeout';
}

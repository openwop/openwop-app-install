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
  /** ctx.suspend nodes shape a resolution into their own output ports. Reuse
   * the live re-invoke path instead of inventing `{ output: resolvedValue }`. */
  reinvoke?: { resumeKey: string };
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

export function unwrapDerived(v: unknown): unknown {
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
  storage: Pick<Storage, 'listEvents' | 'getInterrupt' | 'getInterruptByNode' | 'resolveInterrupt' | 'getResolvedInterruptByKey'>;
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
    // ADR 1001 D3.5 — a node that suspends more than once (a clarification's
    // rounds) has several resolutions; "the first resolution after the cut" is
    // the NEXT round's when the cut falls right after one round resolved. For a
    // durable suspend, take the resolution of the round the prefix last
    // REQUESTED, matched by its resume key.
    const keyed = await durableRoundAtCut(storage, run, nodeId);
    const recorded = keyed ? (keyed.resolvedPayload ?? { interruptId: keyed.row.interruptId }) : await firstResolvedAfter(storage, run.parentRunId, cut, nodeId);
    if (!recorded) continue;
    const sourceRow = keyed
      ? keyed.row
      : typeof recorded['interruptId'] === 'string'
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
    // A keyed round resolved INSIDE the prefix is already in the fork's log.
    const alreadyRecorded = !conflict && (keyed?.inPrefix === true || (await firstResolvedAfter(storage, run.runId, cut, nodeId)) !== null);
    const sourceData = sourceRow?.data && typeof sourceRow.data === 'object' && !Array.isArray(sourceRow.data)
      ? sourceRow.data as Record<string, unknown> : null;
    out.push({
      nodeId,
      kind,
      interruptId: row.interruptId,
      payload: { ...recorded, interruptId: row.interruptId },
      resolvedValue: sourceValue,
      alreadyRecorded,
      conflict,
      ...(sourceData?.__resumeStyle === 'reinvoke' ? {
        reinvoke: { resumeKey: typeof sourceData.__resumeKey === 'string' ? sourceData.__resumeKey : nodeId },
      } : {}),
    });
  }
  return out;
}

/** A recorded resolution that REJECTED the gate (a decided reject, or a timeout). */
export function isRecordedRejection(payload: Record<string, unknown>): boolean {
  return payload['decision'] === 'rejected' || payload['action'] === 'reject' || payload['action'] === 'timeout';
}

/** A resolved value marked as DERIVED from `parentRunId` (see `DERIVED_MARKER`). */
export function derivedResolvedValue(parentRunId: string, value: unknown): Record<string, unknown> {
  return { [DERIVED_MARKER]: parentRunId, value: value ?? null };
}

/**
 * ADR 1001 D3.5 — for a node re-executing on a `replay` fork, the PARENT run's
 * resolution of a `durable` suspend key, and whether that resolution sits
 * inside the fork's copied prefix.
 *
 *  - `inPrefix` (its `interrupt.resolved` precedes `parentSeq`): the fork's own
 *    log already holds the request and the resolution, so the node may be
 *    SERVED the answer inline. No event is written, and the fork's sequence
 *    still matches the source's.
 *  - otherwise the node SUSPENDS like the source did, and the executor resolves
 *    the fork's own row from this record (the derived-row pattern above), so
 *    the fork's log gains the same `interrupt.resolved` the source has.
 *
 * Keyed on `__resumeKey` (a clarification's round + question digest), not the
 * node's FIRST resolution: one node may hold several. A replay never re-decides.
 * Rows are read only for the fork's own parent run, never another run.
 */
export async function parentResolutionForKey(input: {
  storage: Pick<Storage, 'getResolvedInterruptByKey' | 'listEvents'>;
  run: RunRecord;
  nodeId: string;
  resumeKey: string;
}): Promise<{ row: InterruptRecord; resolvedPayload: Record<string, unknown> | null; inPrefix: boolean } | null> {
  const { storage, run, nodeId, resumeKey } = input;
  if (run.forkMode !== 'replay' || !run.parentRunId) return null;
  const row = await storage.getResolvedInterruptByKey(run.parentRunId, nodeId, resumeKey);
  if (!row) return null;
  let fromSeq = -1;
  for (;;) {
    const page = await storage.listEvents(run.parentRunId, { fromSeq, limit: PAGE, contract: 1 });
    for (const e of page) {
      const p = (e.payload && typeof e.payload === 'object' ? e.payload : {}) as Record<string, unknown>;
      if (e.type === 'interrupt.resolved' && e.nodeId === nodeId && p['interruptId'] === row.interruptId) {
        return { row, resolvedPayload: p, inPrefix: e.sequence < (run.parentSeq ?? 0) };
      }
    }
    if (page.length < PAGE) break;
    fromSeq = page[page.length - 1]!.sequence;
  }
  // A resolved row with no event: treat it as after the cut (derive, and
  // record the event the fork's log is missing).
  return { row, resolvedPayload: null, inPrefix: false };
}

/**
 * ADR 1001 D3.5 — the round of a DURABLE suspend that the fork's copied prefix
 * last requested, with the source's resolution of it (in the prefix or after).
 * `null` when the node's last request is not a durable suspend, so every other
 * gate keeps the first-resolution-after-the-cut rule above.
 */
async function durableRoundAtCut(
  storage: Pick<Storage, 'listEvents' | 'getResolvedInterruptByKey'>,
  run: RunRecord,
  nodeId: string,
): Promise<{ row: InterruptRecord; resolvedPayload: Record<string, unknown> | null; inPrefix: boolean } | null> {
  if (!run.parentRunId) return null;
  const parentSeq = run.parentSeq ?? 0;
  let lastKey: string | undefined;
  let fromSeq = -1;
  for (;;) {
    const page = await storage.listEvents(run.parentRunId, { fromSeq, limit: PAGE, contract: 1 });
    for (const e of page) {
      if (e.sequence >= parentSeq) break;
      const k = (e.payload as { key?: unknown } | null | undefined)?.key;
      if (e.type === 'interrupt.requested' && e.nodeId === nodeId && typeof k === 'string') lastKey = k;
    }
    if (page.length < PAGE || (page.at(-1)?.sequence ?? 0) >= parentSeq) break;
    fromSeq = page[page.length - 1]!.sequence;
  }
  const prefix = `${run.parentRunId}:${nodeId}:`;
  if (!lastKey?.startsWith(prefix)) return null;
  const resumeKey = lastKey.slice(prefix.length);
  const p = await parentResolutionForKey({ storage, run, nodeId, resumeKey });
  if (!p || (p.row.data as { __durable?: unknown } | null)?.__durable !== true) return null;
  return p;
}

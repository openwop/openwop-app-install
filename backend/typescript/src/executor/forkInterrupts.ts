/**
 * ADR 0751 — re-create the live gates a fork inherits.
 *
 * A fork whose `fromSeq` lands inside a suspended run copies the gate's
 * `node.suspended` as fixed history, and `snapshotFromEventPrefix` restores
 * the node as `'suspended'`. What the prefix cannot carry is the live interrupt
 * ROW: the row is where the token, the resume schema and the gate's data live,
 * and without it the fork would sit at `waiting-*` with nothing to resolve.
 *
 * Rules, each with the reason it exists:
 *   - **Never re-execute.** The gate node does not run again; its suspension is
 *     history. The row is re-created from the SOURCE row the prefix names.
 *   - **Fresh id and token.** A token is a credential. The source's token keeps
 *     resolving the source, and only the fork's own token resolves the fork.
 *   - **Inherited `createdAt`.** The approval-timeout and timer deadlines are
 *     derived from it, and ADR 0262 ruling #2 makes a fork inherit the original
 *     deadline. A fresh `createdAt` would silently extend every deadline.
 *   - **Ownership by ancestry.** The prefix names an interrupt by id, and any
 *     node could have written any id. The row must belong to a `parentRunId`
 *     ancestor in the fork's tenant. The whole chain is walked, not just the
 *     parent, because in a fork of a fork the copied event names the
 *     GRANDPARENT's interrupt.
 *   - **Idempotent.** A node that already has an open row on this run is left
 *     alone, so an executor redelivery re-creates nothing.
 *   - **No new event.** The fork's log is its prefix plus what re-executes.
 *     The live gate is discoverable the normal way (the run snapshot's
 *     `interrupt`, the interrupt list), carrying the fork's own token.
 */

import type { Storage } from '../storage/storage.js';
import type { InterruptRecord, RunRecord } from '../types.js';
import type { getSuspendManager } from './suspendManager.js';
import type { ExecuteRunOptions, SerializedSnapshot } from './executor.js';

/** Bound on the `parentRunId` walk. */
const MAX_ANCESTRY = 16;
const PAGE = 1000;

export interface ForkInterruptOutcome {
  /** Nodes whose gate this call re-created. */
  recreated: string[];
  /** Nodes whose source gate could not be found or failed the ownership check. */
  unrecoverable: string[];
  /** The re-created gates' kinds, from the SOURCE row — authoritative over the
   *  snapshot's, which falls back to a guess for a legacy `node.suspended`. */
  kinds: Array<[string, InterruptRecord['kind']]>;
}

/** The `parentRunId` ancestors of `run` in its own tenant, nearest first. */
async function ancestorsOf(storage: Pick<Storage, 'getRun'>, run: RunRecord): Promise<Set<string>> {
  const out = new Set<string>();
  let parentId = run.parentRunId;
  for (let hop = 0; parentId && hop < MAX_ANCESTRY; hop++) {
    const parent = await storage.getRun(parentId);
    if (!parent || parent.tenantId !== run.tenantId) break;
    out.add(parent.runId);
    parentId = parent.parentRunId;
  }
  return out;
}

/** The fork's own inherited prefix: the last `node.suspended` interruptId and
 *  `conversation.opened` conversationId per node. */
async function readPrefix(
  storage: Pick<Storage, 'listEvents'>,
  run: RunRecord,
): Promise<{ interruptIds: Map<string, string>; conversationIds: Map<string, string> }> {
  const interruptIds = new Map<string, string>();
  const conversationIds = new Map<string, string>();
  const limit = run.parentSeq ?? Number.POSITIVE_INFINITY;
  let fromSeq = -1;
  for (;;) {
    const page = await storage.listEvents(run.runId, { fromSeq, limit: PAGE, contract: 1 });
    for (const e of page) {
      if (e.sequence >= limit) return { interruptIds, conversationIds };
      if (!e.nodeId) continue;
      const p = (e.payload ?? {}) as { interruptId?: unknown; conversationId?: unknown };
      if (e.type === 'node.suspended' && typeof p.interruptId === 'string') interruptIds.set(e.nodeId, p.interruptId);
      if (e.type === 'conversation.opened' && typeof p.conversationId === 'string') conversationIds.set(e.nodeId, p.conversationId);
    }
    if (page.length < PAGE) return { interruptIds, conversationIds };
    fromSeq = page[page.length - 1]!.sequence;
  }
}

export async function ensureForkInterrupts(input: {
  storage: Pick<Storage, 'getRun' | 'listEvents' | 'getInterrupt' | 'getInterruptByNode'>;
  suspend: ReturnType<typeof getSuspendManager>;
  run: RunRecord;
  /** The nodes the fork's snapshot restored as `'suspended'`. */
  suspendedNodeIds: readonly string[];
}): Promise<ForkInterruptOutcome> {
  const { storage, suspend, run, suspendedNodeIds } = input;
  const outcome: ForkInterruptOutcome = { recreated: [], unrecoverable: [], kinds: [] };
  // ADR 0755 (WIT-FORK-1) — a FORK, by the discriminator the rest of the
  // executor uses (`forkMode`, stamped only by `:fork`; executor.ts ancestry,
  // compensationRuntime). `parentRunId` alone also names a sub-run CHILD, and
  // `isForkCheckpointResume` is also true for a `:resume` of a paused run (it
  // passes `resumeSnapshot` with no `resumeNodeId`) — so a paused sub-run child
  // whose gate row was missing was walked as a fork and failed
  // `fork_interrupt_unavailable` against its OWN log.
  if (run.forkMode === undefined || !run.parentRunId || suspendedNodeIds.length === 0) return outcome;

  const open = new Set((await suspend.listOpen(run.runId)).map((i) => i.nodeId));
  const pending = suspendedNodeIds.filter((id) => !open.has(id));
  if (pending.length === 0) return outcome;

  const ancestors = await ancestorsOf(storage, run);
  const { interruptIds, conversationIds } = await readPrefix(storage, run);

  for (const nodeId of pending) {
    let source: InterruptRecord | null = null;
    const namedId = interruptIds.get(nodeId);
    if (namedId) {
      const row = await storage.getInterrupt(namedId);
      if (row && row.nodeId === nodeId && ancestors.has(row.runId)) source = row;
    }
    // A prefix written before `node.suspended` carried `interruptId`: the parent's
    // own row for the node is the only candidate left.
    if (!source && !namedId && run.parentRunId) {
      const row = await storage.getInterruptByNode(run.parentRunId, nodeId);
      if (row && ancestors.has(row.runId)) source = row;
    }
    if (!source) {
      outcome.unrecoverable.push(nodeId);
      continue;
    }
    let data = source.data;
    // A conversation gate's exchanges address the transcript by conversationId.
    // Without one in the data the exchange path derives `${runId}:…` from the
    // FORK's id, and the copied transcript would be orphaned from its own gate.
    if (source.kind === 'conversation') {
      const d = (data && typeof data === 'object' && !Array.isArray(data)) ? (data as Record<string, unknown>) : {};
      if (typeof d['conversationId'] !== 'string') {
        data = { ...d, conversationId: conversationIds.get(nodeId) ?? `${source.runId}:${nodeId}:0` };
      }
    }
    await suspend.createInterrupt({
      runId: run.runId,
      nodeId,
      kind: source.kind,
      data,
      ...(source.resumeSchema ? { resumeSchema: source.resumeSchema } : {}),
      createdAt: source.createdAt,
    });
    outcome.recreated.push(nodeId);
    outcome.kinds.push([nodeId, source.kind]);
  }
  return outcome;
}

/**
 * ADR 0755 (FORKINT-2) — how a FORK is dispatched, derived from the persisted run
 * alone so every dispatcher agrees: the `:fork` route AND the orphan sweeper.
 *
 * The route used to build these options from request-local values and hand them to
 * a `setImmediate`, AFTER answering `201`. A crash in that window left a `pending`
 * fork that the sweeper re-dispatched with NO `resumeSnapshot`: the copied prefix
 * re-executed (ADR 0326 P3b's "the prefix never re-executes", broken) and an
 * inherited gate ran its node again, minting a new interrupt with a fresh
 * `createdAt` — a later deadline than the source's (ADR 0751's inherit rule, broken).
 * Everything needed is already durable: the checkpoint rides the fork's own
 * `schedulerSnapshot` (the route persists it at insert; the executor overwrites it
 * at each suspend/pause, which is a later checkpoint, never an earlier one), and
 * the replay source is `parentRunId`.
 *
 * Not a fork (`forkMode` unset — a sub-run child also has `parentRunId`) → `{}`.
 */
export function forkDispatchOptions(run: RunRecord): Pick<ExecuteRunOptions, 'resumeSnapshot' | 'replayInvocationsFromRunId'> {
  if (!run.forkMode) return {};
  let resumeSnapshot: SerializedSnapshot | undefined;
  if (typeof run.schedulerSnapshot === 'string' && run.schedulerSnapshot.length > 0) {
    try {
      resumeSnapshot = JSON.parse(run.schedulerSnapshot) as SerializedSnapshot;
    } catch {
      resumeSnapshot = undefined;
    }
  }
  return {
    ...(resumeSnapshot ? { resumeSnapshot } : {}),
    ...(run.forkMode === 'replay' && run.parentRunId ? { replayInvocationsFromRunId: run.parentRunId } : {}),
  };
}

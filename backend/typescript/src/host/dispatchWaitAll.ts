/**
 * ADR 0935 — RFC 0118 `wait-all` honoured for children that SUSPEND.
 *
 * RFC 0118: "`'wait-all'` (default) — the dispatch node remains suspended until
 * every dispatched child reaches a terminal state". The parallel arm of
 * `core.dispatch` (bootstrap/nodes.ts) used to fold a child that came back
 * `waiting-approval` as `failed`, so a campaign whose channels stop at their
 * approval gates joined `partial` at once and ran on without them.
 *
 * Now the node suspends instead (an `external-event` interrupt whose
 * `correlation` records the wave), and this module resumes it:
 *
 *   - `onAnyRunTerminal` fires for each child that finishes. When the child's
 *     parent holds an open wait interrupt naming it, and EVERY child it names is
 *     terminal, the wait resolves through `resolveAndResume` with the observed
 *     terminal order as the resume value. That value is recorded on
 *     `interrupt.resolved`, so a replay re-reads the order, never recomputes it.
 *   - The node is re-invoked (the `ctx.suspend` reinvoke style), folds the join
 *     exactly as the synchronous path does, and carries on with the decisions
 *     that followed the wave.
 *
 * Only the host may resolve it. Every human or token lane is refused in
 * `resolveAndResume` (`isDispatchWaitInterrupt`): its resume value becomes the
 * join, so a caller who could post one could forge which children "completed".
 */
import type { Storage } from '../storage/storage.js';
import type { InterruptRecord, RunRecord } from '../types.js';
import type { HostAdapterSuite } from './index.js';
import { onAnyRunTerminal } from '../executor/runLifecycle.js';
import { createLogger } from '../observability/logger.js';
import { hostExtStorage, isHostExtPersistenceInitialized } from './hostExtPersistence.js';
import { createHash } from 'node:crypto';
import { getEventLog } from '../executor/eventLog.js';
import { openInterruptsForSweep } from '../executor/openInterruptSweep.js';

const log = createLogger('dispatchWaitAll');

/** `ExternalEventData.eventType` of the wait (suspend-request.schema.json). */
export const DISPATCH_WAIT_EVENT_TYPE = 'openwop-app.dispatch.children-terminal';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export type WaveChildStatus = 'completed' | 'failed' | 'cancelled';

export interface WaveChild {
  childRunId: string;
  workflowId: string;
  /** The child's status when the wave returned (non-terminal for a waiting child). */
  status: string;
  error?: { code: string; message: string };
}

/** The wave, as recorded in the wait interrupt's `correlation`. */
export interface WaveCorrelation {
  fanOutEventId: string;
  /** Index into the supervisor's `decisions` of the wave's decision. */
  decisionIndex: number;
  children: WaveChild[];
  /** childRunIds already terminal when the wave returned, in observed order. */
  settledOrder: string[];
  /** Completed decisions before this waiting wave, scoped to this invocation. */
  priorChildren?: Array<{ childRunId: string; childWorkflowId: string; childStatus: string }>;
}

/** The resume value: every child's terminal, in observed terminal order. */
export interface WaveJoinResolution {
  fanOutEventId: string;
  terminals: Array<{ childRunId: string; status: WaveChildStatus }>;
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}

export function asChildStatus(status: string): WaveChildStatus {
  return status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
}

/** Is this the host-resolved wait interrupt? */
export function isDispatchWaitInterrupt(interrupt: Pick<InterruptRecord, 'kind' | 'data'>): boolean {
  if (interrupt.kind !== 'external-event') return false;
  const data = interrupt.data as { eventType?: unknown } | null | undefined;
  return data?.eventType === DISPATCH_WAIT_EVENT_TYPE;
}

function correlationOf(interrupt: InterruptRecord): WaveCorrelation | null {
  const c = (interrupt.data as { correlation?: unknown } | null | undefined)?.correlation as Partial<WaveCorrelation> | undefined;
  if (!c || typeof c.fanOutEventId !== 'string' || !c.fanOutEventId || !Number.isSafeInteger(c.decisionIndex) || c.decisionIndex! < 0
    || !Array.isArray(c.children) || c.children.length === 0 || !Array.isArray(c.settledOrder)) return null;
  const ids = new Set<string>();
  for (const child of c.children) {
    if (!child || typeof child.childRunId !== 'string' || !child.childRunId || ids.has(child.childRunId)
      || typeof child.workflowId !== 'string' || !child.workflowId || typeof child.status !== 'string' || !child.status) return null;
    ids.add(child.childRunId);
  }
  const settled = new Set<string>();
  for (const id of c.settledOrder) {
    if (typeof id !== 'string' || settled.has(id) || !ids.has(id) || !isTerminalStatus(c.children.find((child) => child.childRunId === id)!.status)) return null;
    settled.add(id);
  }
  if (c.children.some((child) => isTerminalStatus(child.status) && !settled.has(child.childRunId))) return null;
  if (c.priorChildren !== undefined) {
    if (!Array.isArray(c.priorChildren)) return null;
    const prior = new Set<string>();
    for (const child of c.priorChildren) {
      if (!child || typeof child.childRunId !== 'string' || !child.childRunId || ids.has(child.childRunId) || prior.has(child.childRunId)
        || typeof child.childWorkflowId !== 'string' || !child.childWorkflowId || typeof child.childStatus !== 'string' || !child.childStatus) return null;
      prior.add(child.childRunId);
    }
  }
  return c as WaveCorrelation;
}

function validatedJoin(wave: WaveCorrelation, value: unknown): WaveJoinResolution | null {
  if (!value || typeof value !== 'object') return null;
  const join = value as Partial<WaveJoinResolution>;
  if (join.fanOutEventId !== wave.fanOutEventId || !Array.isArray(join.terminals) || join.terminals.length !== wave.children.length) return null;
  const ids = new Set<string>();
  for (const terminal of join.terminals) {
    if (!terminal || typeof terminal.childRunId !== 'string' || ids.has(terminal.childRunId) || !isTerminalStatus(terminal.status)
      || !wave.children.some((c) => c.childRunId === terminal.childRunId)) return null;
    ids.add(terminal.childRunId);
  }
  for (const [index, id] of wave.settledOrder.entries()) {
    if (join.terminals[index]?.childRunId !== id || join.terminals[index]?.status !== asChildStatus(wave.children.find((c) => c.childRunId === id)!.status)) return null;
  }
  return join as WaveJoinResolution;
}

/** The interrupt is durable even if the variable bag's asynchronous persist
 *  was lost. Only a resolved wait for this node can supply a resume marker. */
export async function storedDispatchWave(tenantId: string, runId: string, nodeId: string): Promise<WaveCorrelation | null> {
  if (!isHostExtPersistenceInitialized()) return null;
  const storage = hostExtStorage();
  const run = await storage.getRun(runId);
  if (!run || run.tenantId !== tenantId) return null;
  const interrupt = await latestDispatchWait(storage, runId, nodeId);
  if (!interrupt?.resolvedAt || !isDispatchWaitInterrupt(interrupt)) return null;
  const wave = correlationOf(interrupt);
  if (!wave || !validatedJoin(wave, interrupt.resolvedValue)) throw new Error('dispatch_wait_invalid_stored_join');
  return wave;
}

/** The event sequence identifies the latest gate exactly, even when two gates
 *  share a millisecond timestamp. The ordinary node getter stays OPEN-only. */
async function latestDispatchWait(storage: Storage, runId: string, nodeId: string): Promise<InterruptRecord | null> {
  const event = await storage.findFirstEventByPayload(runId, 'node.suspended', 'kind', 'external-event', { nodeId, newestFirst: true });
  const id = (event?.payload as { interruptId?: unknown } | undefined)?.interruptId;
  if (typeof id !== 'string') return null;
  const interrupt = await storage.getInterrupt(id);
  return interrupt?.runId === runId && interrupt.nodeId === nodeId && isDispatchWaitInterrupt(interrupt) ? interrupt : null;
}

export function dispatchWaitStillParked(run: RunRecord, nodeId: string): boolean {
  if (!['waiting-external', 'waiting-approval', 'waiting-input'].includes(run.status) || typeof run.schedulerSnapshot !== 'string') return false;
  try {
    const snapshot = JSON.parse(run.schedulerSnapshot) as { nodeState?: unknown };
    return Array.isArray(snapshot.nodeState) && snapshot.nodeState.some((entry: unknown) => Array.isArray(entry) && entry[0] === nodeId && entry[1] === 'suspended');
  } catch { return false; }
}

function resolutionMatches(left: unknown, right: unknown): boolean {
  const shape = (value: unknown): string | null => {
    if (!value || typeof value !== 'object') return null;
    const v = value as Partial<WaveJoinResolution>;
    if (typeof v.fanOutEventId !== 'string' || !Array.isArray(v.terminals)) return null;
    if (!v.terminals.every((t) => t && typeof t.childRunId === 'string' && isTerminalStatus(t.status))) return null;
    return JSON.stringify([v.fanOutEventId, v.terminals.map((t) => [t.childRunId, t.status])]);
  };
  const a = shape(left);
  return a !== null && a === shape(right);
}

/** Serialize host wait resumes sharing a parent generation through the existing
 *  invocation claim owner. Completion/new suspension advances the generation;
 *  a crashed claimant is retried after the existing dispatch lease window. */
export async function claimDispatchWaitResume(storage: Storage, interrupt: InterruptRecord, resumeValue: unknown, leaseMs: number): Promise<RunRecord | null> {
  const run = await storage.getRun(interrupt.runId);
  if (!run || !dispatchWaitStillParked(run, interrupt.nodeId)) return null;
  const snapshot = JSON.parse(run.schedulerSnapshot!) as { nodeState: Array<[string, string]> };
  const ids: Array<[string, string | null]> = [];
  for (const [nodeId, state] of [...snapshot.nodeState].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (state !== 'suspended') continue;
    const event = await storage.findFirstEventByPayload(run.runId, 'node.suspended', 'kind', 'external-event', { nodeId, newestFirst: true });
    ids.push([nodeId, event?.eventId ?? null]);
  }
  const current = await storage.getRun(run.runId);
  if (!current || !dispatchWaitStillParked(current, interrupt.nodeId) || current.schedulerSnapshot !== run.schedulerSnapshot) return null;
  const exact = await latestDispatchWait(storage, run.runId, interrupt.nodeId);
  const wave = exact ? correlationOf(exact) : null;
  if (!exact?.resolvedAt || !wave || !validatedJoin(wave, exact.resolvedValue) || exact.interruptId !== interrupt.interruptId || !resolutionMatches(exact.resolvedValue, resumeValue)) return null;
  const generation = createHash('sha256').update(JSON.stringify([run.schedulerSnapshot, ids])).digest('hex');
  if (!(await storage.claimInvocation({ runId: run.runId, nodeId: '__host_dispatch_resume__', invocationId: `host-dispatch-resume:${generation}` }, { nowMs: Date.now(), staleAfterMs: leaseMs }))) return null;
  const fresh = await storage.getRun(run.runId);
  const latest = await latestDispatchWait(storage, run.runId, interrupt.nodeId);
  return fresh && dispatchWaitStillParked(fresh, interrupt.nodeId) && fresh.schedulerSnapshot === run.schedulerSnapshot
    && latest?.interruptId === interrupt.interruptId && latest.resolvedAt && resolutionMatches(latest.resolvedValue, resumeValue) ? fresh : null;
}

/** A stable event identity closes append/commit-ack loss without another
 *  completion receipt. Both the initial join and recovery use the same ID. */
export async function appendDispatchWaitResolution(storage: Storage, interrupt: InterruptRecord): Promise<void> {
  if (!interrupt.resolvedAt || !isDispatchWaitInterrupt(interrupt)) throw new Error('dispatch wait is not resolved');
  const eventId = `dwjoin.${createHash('sha256').update(JSON.stringify([interrupt.runId, interrupt.interruptId])).digest('hex')}`;
  const existing = await storage.findFirstEventByPayload(interrupt.runId, 'interrupt.resolved', 'interruptId', interrupt.interruptId);
  const identityMatches = (event: typeof existing): boolean => event !== null && event.type === 'interrupt.resolved' && event.runId === interrupt.runId
    && event.nodeId === interrupt.nodeId && (event.payload as { kind?: unknown } | null)?.kind === interrupt.kind
    && (event.payload as { interruptId?: unknown } | null)?.interruptId === interrupt.interruptId;
  const matches = (event: typeof existing): boolean => identityMatches(event) && event?.eventId === eventId;
  if (identityMatches(existing)) return; // Accept an already-recorded legacy ID.
  if (existing) throw new Error('dispatch wait resolution history identity mismatch');
  try {
    await getEventLog().append({ eventId, runId: interrupt.runId, nodeId: interrupt.nodeId, type: 'interrupt.resolved',
      payload: { interruptId: interrupt.interruptId, kind: interrupt.kind } });
  } catch (err) {
    // A unique-key loser or a lost COMMIT acknowledgement is success only
    // after the authoritative, era-aware lookup proves this exact event.
    const observed = await storage.findFirstEventByPayload(interrupt.runId, 'interrupt.resolved', 'interruptId', interrupt.interruptId);
    if (!matches(observed)) throw err;
  }
}

/**
 * Join the waits on `parentRunId` whose children are all terminal. Returns how
 * many it resolved. Idempotent: a second caller loses `resolveAndResume`'s own
 * claim (409), which is swallowed here.
 */
export async function joinSettledWaves(
  storage: Storage,
  hostSuite: HostAdapterSuite,
  parentRunId: string,
  selected?: readonly InterruptRecord[],
): Promise<number> {
  const open = selected ?? await storage.listOpenInterrupts(parentRunId);
  let joined = 0;
  for (const interrupt of open) {
    if (!isDispatchWaitInterrupt(interrupt)) continue;
    const parent = await storage.getRun(parentRunId);
    if (!parent || !dispatchWaitStillParked(parent, interrupt.nodeId)) continue;
    const wave = correlationOf(interrupt);
    if (!wave) continue;
    const late: Array<{ childRunId: string; status: WaveChildStatus; at: string }> = [];
    let pending = false;
    for (const child of wave.children) {
      if (wave.settledOrder.includes(child.childRunId)) continue;
      const run = await storage.getRun(child.childRunId);
      if (!run || run.tenantId !== parent.tenantId || !isTerminalStatus(run.status)) { pending = true; break; }
      late.push({ childRunId: child.childRunId, status: asChildStatus(run.status), at: run.updatedAt });
    }
    if (pending) continue;
    // Observed terminal order: the wave's own settled children first (they
    // finished before it returned), then the late ones by when they finished.
    late.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.childRunId < b.childRunId ? -1 : 1));
    const statusAtWave = new Map(wave.children.map((c) => [c.childRunId, c.status]));
    const resolution: WaveJoinResolution = {
      fanOutEventId: wave.fanOutEventId,
      terminals: [
        ...wave.settledOrder.map((id) => ({ childRunId: id, status: asChildStatus(statusAtWave.get(id) ?? 'failed') })),
        ...late.map(({ childRunId, status }) => ({ childRunId, status })),
      ],
    };
    const { resolveAndResume } = await import('../routes/interrupts.js');
    try {
      await resolveAndResume(storage, hostSuite, interrupt.interruptId, resolution, { hostDispatchJoin: true });
      joined += 1;
    } catch (err) {
      const status = (err as { httpStatus?: unknown }).httpStatus;
      if (status !== 409) {
        log.warn('dispatch_wait_join_failed', { parentRunId, interruptId: interrupt.interruptId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return joined;
}

type ParkedCursor = { before?: { createdAt: string; runId: string }; pendingRunId?: string; afterNode?: string };
const recoveryCursors = new WeakMap<Storage, { statusIndex: number; pages: ParkedCursor[] }>();
const PARKED_STATUSES = ['waiting-external', 'waiting-approval', 'waiting-input'] as const;
const RECOVERY_BATCH = 20;

/** One bounded pass on the existing dispatch daemon. The open-interrupt
 *  rotation repairs a missed terminal hint; parked-parent rotation also finds
 *  already-resolved waits whose in-memory dispatch was lost on process death. */
export async function reconcileDispatchWaits(storage: Storage, hostSuite: HostAdapterSuite): Promise<number> {
  let resumed = 0;
  const open = await openInterruptsForSweep(storage, 'dispatch-wait-all', RECOVERY_BATCH);
  const parents = new Map<string, InterruptRecord[]>();
  for (const interrupt of open) {
    if (!isDispatchWaitInterrupt(interrupt)) continue;
    const list = parents.get(interrupt.runId) ?? [];
    list.push(interrupt); parents.set(interrupt.runId, list);
  }
  for (const [parent, waits] of parents) {
    try { resumed += await joinSettledWaves(storage, hostSuite, parent, waits); }
    catch (err) { log.warn('dispatch_wait_open_recovery_failed', { parentRunId: parent, error: err instanceof Error ? err.message : String(err) }); }
  }

  const state: { statusIndex: number; pages: ParkedCursor[] } = recoveryCursors.get(storage) ?? { statusIndex: 0, pages: PARKED_STATUSES.map(() => ({})) };
  recoveryCursors.set(storage, state);
  const index = state.statusIndex;
  state.statusIndex = (index + 1) % PARKED_STATUSES.length;
  const cursor = state.pages[index]!;
  const status = PARKED_STATUSES[index]!;
  const newest = (await storage.listRuns({ status, limit: 1 }))[0];
  const hadPending = !!cursor.pendingRunId;
  let page: RunRecord | null | undefined;
  if (cursor.pendingRunId) {
    try { page = await storage.getRun(cursor.pendingRunId); }
    catch (err) {
      log.warn('dispatch_wait_parent_recovery_failed', { parentRunId: cursor.pendingRunId, error: err instanceof Error ? err.message : String(err) });
      delete cursor.pendingRunId; delete cursor.afterNode;
    }
  } else page = (await storage.listRuns({ status, limit: 1, ...(cursor.before ? { before: cursor.before } : {}) }))[0];
  if (!page) { if (!hadPending) delete cursor.before; delete cursor.pendingRunId; delete cursor.afterNode; }
  const rows = page ? [page, ...(newest && newest.runId !== page.runId ? [newest] : [])] : newest ? [newest] : [];
  const { dispatchGateResume } = await import('../routes/interrupts.js');
  for (const run of rows) {
    let nodes: string[] = [];
    try {
      const snapshot = JSON.parse(run.schedulerSnapshot ?? '{}') as { nodeState?: unknown };
      if (Array.isArray(snapshot.nodeState)) nodes = snapshot.nodeState
        .filter((entry: unknown): entry is [string, string] => Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] === 'suspended')
        .map(([id]) => id).sort();
    } catch { /* Unparseable state never grants a resume. */ }
    const remaining = nodes.filter((id) => run !== page || !cursor.afterNode || id > cursor.afterNode);
    const window = remaining.slice(0, RECOVERY_BATCH);
    for (const nodeId of window) {
      try {
        if (!dispatchWaitStillParked(run, nodeId)) continue;
        const interrupt = await latestDispatchWait(storage, run.runId, nodeId);
        if (!interrupt?.resolvedAt) continue;
        const wave = correlationOf(interrupt);
        if (!wave || !validatedJoin(wave, interrupt.resolvedValue)) continue;
        await appendDispatchWaitResolution(storage, interrupt);
        await dispatchGateResume(storage, hostSuite, interrupt, interrupt.resolvedValue);
        resumed++;
      } catch (err) { log.warn('dispatch_wait_resolved_recovery_failed', { parentRunId: run.runId, nodeId, error: err instanceof Error ? err.message : String(err) }); }
    }
    if (run === page) {
      cursor.before = { createdAt: run.createdAt, runId: run.runId };
      if (remaining.length > window.length) {
        cursor.pendingRunId = run.runId; cursor.afterNode = window.at(-1);
      } else {
        delete cursor.pendingRunId; delete cursor.afterNode;
      }
    }
  }
  return resumed;
}

/** Boot wiring: a child that finishes may complete its parent's wave. */
export function registerDispatchWaitAll(storage: Storage, hostSuite: HostAdapterSuite): void {
  onAnyRunTerminal('dispatch-wait-all', async (runId) => {
    const run = await storage.getRun(runId);
    if (!run?.parentRunId) return;
    const parent = await storage.getRun(run.parentRunId);
    if (!parent || isTerminalStatus(parent.status)) return;
    await joinSettledWaves(storage, hostSuite, parent.runId);
  });
}

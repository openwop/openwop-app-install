/**
 * ADR 0984 (RFC 0252) — an eval task takes its fixtures from a recorded run.
 *
 * `createRun {mode:"eval", fixtureRuns: {<taskId>: <runId>}}`: for each named
 * task the host derives `toolResponses` from the source run's recorded calls of
 * the eval's agent and runs the task under `onMiss: "fail"` (RFC 0244 §D).
 *
 * The source is the run's own event log, which is the boundary the agent saw:
 * `agent.tool-called.inputs` (the arguments as the agent passed them) and the
 * matching `agent.tool-returned` (its `outcome`, or its error). It is never an
 * egress request, so a credential the host resolved after the call cannot
 * enter a derived entry (RFC 0252 §D, SR-1). A source is usable only if EVERY
 * call of the agent is held completely. A success recorded without `outcome`
 * (this host's live lane never sets it, WFAU-4) means the result is not held,
 * so the run is refused rather than replayed with a guess, unless the source is
 * a live eval trial recorded under the agent's capture opt-in (ADR 0984 D7):
 * then the host-internal as-executed record supplies each call's input and
 * result, paired in order within its `callId` and checked against the event's
 * `argsHash`. Such a source is usable only by the run's own acting user, and its
 * entries are frozen in the governed store, not in run metadata.
 *
 * Every unusable source gets ONE refusal, whatever the reason, with no id in it
 * (RFC 0252 §C, the RFC 0251 §C pattern): unknown, another tenant's, unreadable
 * by this caller, not terminal, never invoked the agent, or not fully held.
 * The derived entries are suite content: they live in the run's reserved
 * `metadata.eval` and never reach the wire.
 */
import { OpenwopError } from '../../types.js';
import type { RunRecord } from '../../types.js';
import { getEventLog } from '../../executor/eventLog.js';
import { agentStorageId } from '../../executor/agentIdAliases.js';
import type { ToolResponseFixture } from './suiteStore.js';
import { readExactCalls, type ExactRow } from './toolBoundary.js';

/** Resolves a wire run id to a run THIS caller may read, payload included; null otherwise. */
export type SourceRunReader = (wireRunId: string) => Promise<RunRecord | null>;

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const TOOL_CALLED = new Set(['agent.toolCalled', 'agent.tool-called']);
const TOOL_RETURNED = new Set(['agent.toolReturned', 'agent.tool-returned']);
const INVOCATION_STARTED = new Set(['agent.invocation-started', 'agent.invocation.started', 'agent.invocationStarted']);
const ERROR_STATUSES = new Set(['error', 'failed', 'forbidden', 'rate_limited']);

/** The one refusal for every unusable source (no id, no reason that tells them apart). */
export function unusableSource(): never {
  throw new OpenwopError('validation_error', 'A fixtureRuns source run is not usable for this eval.', 400, { field: 'fixtureRuns' });
}

interface CalledRow { callId: string; tool: string; inputs?: Record<string, unknown>; argsHash?: string; returned?: ReturnedRow }
interface ReturnedRow { status?: unknown; outcome?: unknown; hasOutcome: boolean; error?: unknown }

async function readEvents(runId: string): Promise<Array<{ type: string; payload?: unknown }>> {
  const out: Array<{ type: string; payload?: unknown }> = [];
  let fromSeq = -1; // the cursor is exclusive and sequences start at 0
  for (;;) {
    const page = await getEventLog().list(runId, { fromSeq, limit: 500 });
    out.push(...page);
    if (page.length < 500) return out;
    fromSeq = page[page.length - 1]!.sequence;
  }
}

/** What a usable source yields: its entries, and whether any came from the D7 record
 *  (then `anchorAt` is that record's oldest time, which its frozen copy ages from). */
export interface DerivedFixtures { entries: ToolResponseFixture[]; fromRecord: boolean; anchorAt?: string }

/**
 * The fixtures a source run yields for `agentId`, or null when it is not usable.
 * `allowErrors` is whether this host advertises `fixtureErrors` (RFC 0245): a
 * source with a failed call is usable only then.
 */
export async function deriveFixtures(run: RunRecord, agentId: string, opts: { allowErrors: boolean }): Promise<DerivedFixtures | null> {
  if (!TERMINAL.has(run.status)) return null;
  const target = agentStorageId(agentId);
  const isTarget = (p: Record<string, unknown>): boolean => typeof p.agentId === 'string' && agentStorageId(p.agentId) === target;
  const called: CalledRow[] = [];
  // A provider may reuse a call id (Gemini restarts its ids each round), and a gate
  // answers a call with a return and no call event. So a return pairs with the
  // OLDEST unanswered call of its id, in log order; one with none is a gate answer.
  const pending = new Map<string, CalledRow[]>();
  let invoked = false;
  for (const e of await readEvents(run.runId)) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (INVOCATION_STARTED.has(e.type)) { if (isTarget(p)) invoked = true; continue; }
    // Delegates are excluded: only the eval's own agent's calls (RFC 0244 §A default).
    if (!isTarget(p) || typeof p.callId !== 'string') continue;
    if (TOOL_CALLED.has(e.type)) {
      if (typeof p.toolName !== 'string') return null;
      const hasInputs = !!p.inputs && typeof p.inputs === 'object' && !Array.isArray(p.inputs);
      // Neither the inputs nor a hash to pair a record with: not held.
      if (!hasInputs && typeof p.argsHash !== 'string') return null;
      const c: CalledRow = { callId: p.callId, tool: p.toolName, ...(hasInputs ? { inputs: p.inputs as Record<string, unknown> } : { argsHash: p.argsHash as string }) };
      called.push(c);
      pending.set(c.callId, [...(pending.get(c.callId) ?? []), c]);
    } else if (TOOL_RETURNED.has(e.type)) {
      const c = pending.get(p.callId)?.shift();
      if (c) c.returned = { status: p.status, outcome: p.outcome, hasOutcome: Object.hasOwn(p, 'outcome'), error: p.error };
    }
  }
  if (!invoked) return null;

  // ADR 0984 D7 — the as-executed record, read only when some call lacks its inputs.
  // The i-th hash-only call of an id takes the i-th record of that id; the counts must agree.
  const hashOnly = called.filter((c) => !c.inputs);
  const records = new Map<string, ExactRow[]>();
  let anchorAt: string | undefined;
  if (hashOnly.length > 0) {
    const rows = await readExactCalls(run.tenantId, run.runId);
    if (!rows) return null; // over the record cap: some call is not held
    for (const x of rows) if (agentStorageId(x.agentId) === target) records.set(x.callId, [...(records.get(x.callId) ?? []), x]);
    const want = new Map<string, number>();
    for (const c of hashOnly) want.set(c.callId, (want.get(c.callId) ?? 0) + 1);
    for (const [id, n] of want) if ((records.get(id)?.length ?? 0) !== n) return null;
  }

  const entries: ToolResponseFixture[] = [];
  for (const c of called) {
    const r = c.returned;
    if (!r) return null; // a call whose result the log does not hold
    const failed = typeof r.status === 'string' && ERROR_STATUSES.has(r.status);
    if (!c.inputs) {
      const x = records.get(c.callId)!.shift()!;
      if (!anchorAt || x.updatedAt < anchorAt) anchorAt = x.updatedAt;
      // Held only if recorded whole, for this tool, from these very arguments.
      if (!x.complete || x.tool !== c.tool || x.argsHash !== c.argsHash) return null;
      if (!x.input || typeof x.input !== 'object' || Array.isArray(x.input) || typeof x.content !== 'string') return null;
      if (x.isError !== failed) return null; // the record and the event disagree
      if (failed && !opts.allowErrors) return null;
      // The content the agent's tool loop received, verbatim (a string response is served as-is).
      entries.push({ tool: c.tool, args: x.input as Record<string, unknown>, argsMatch: 'exact', response: x.content, ...(failed ? { isError: true } : {}) });
      continue;
    }
    if (failed) {
      if (!opts.allowErrors) return null;
      entries.push({ tool: c.tool, args: c.inputs, argsMatch: 'exact', response: r.error ?? { code: r.status }, isError: true });
      continue;
    }
    if (!r.hasOutcome) return null; // a success whose result is not held
    entries.push({ tool: c.tool, args: c.inputs, argsMatch: 'exact', response: r.outcome });
  }
  return { entries, fromRecord: hashOnly.length > 0, ...(anchorAt ? { anchorAt } : {}) };
}

/** `deriveFixtures`, entries only. */
export async function deriveFromRun(run: RunRecord, agentId: string, opts: { allowErrors: boolean }): Promise<ToolResponseFixture[] | null> {
  return (await deriveFixtures(run, agentId, opts))?.entries ?? null;
}

/** The validated request: which tasks take which source. Throws the RFC 0252 §B refusals. */
export function parseFixtureRuns(raw: unknown, taskFixtures: ReadonlyMap<string, { toolResponses?: unknown; onMiss?: unknown } | undefined>): Record<string, string> {
  const bad = (message: string): never => { throw new OpenwopError('validation_error', message, 400, { field: 'fixtureRuns' }); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('fixtureRuns must be an object of taskId to runId.');
  const map = raw as Record<string, unknown>;
  const keys = Object.keys(map);
  if (keys.length === 0) bad('fixtureRuns needs at least one task.');
  for (const k of keys) {
    if (!taskFixtures.has(k)) bad('A fixtureRuns key is not a task of this suite.');
    if (typeof map[k] !== 'string' || (map[k] as string).length === 0) bad('A fixtureRuns value must be a run id.');
    const f = taskFixtures.get(k);
    // The two sources are never merged (RFC 0252 §B).
    if (f && (f.toolResponses !== undefined || f.onMiss !== undefined)) bad('A task named in fixtureRuns must not carry its own toolResponses or onMiss.');
  }
  return map as Record<string, string>;
}

/** The resolved sources: entries per task, and, per task that took them from the D7
 *  record, its source run (storage id) and the record's oldest time. */
export interface ResolvedRecordedFixtures { byTask: Record<string, ToolResponseFixture[]>; fromRecord: Record<string, { sourceRunId: string; anchorAt: string }> }

/**
 * Resolve every source; any unusable one is the uniform refusal. A source that
 * yields D7-record entries (a live trial's tool content) is usable only by the
 * user who ran it: an operator who may read another member's run never saw its
 * tool results, and a replay could echo them onto the new run's events.
 */
export async function resolveRecordedFixtures(
  fixtureRuns: Record<string, string>,
  read: SourceRunReader | undefined,
  agentId: string,
  opts: { allowErrors: boolean; actingUserId?: string },
): Promise<ResolvedRecordedFixtures> {
  const byTask: Record<string, ToolResponseFixture[]> = {};
  const fromRecord: ResolvedRecordedFixtures['fromRecord'] = {};
  for (const [taskId, wireId] of Object.entries(fixtureRuns)) {
    const run = read ? await read(wireId).catch(() => null) : null;
    const derived = run ? await deriveFixtures(run, agentId, opts) : null;
    if (!derived) unusableSource();
    if (derived.fromRecord) {
      const owner = run!.metadata?.actingUserId;
      if (typeof owner !== 'string' || !opts.actingUserId || owner !== opts.actingUserId) unusableSource();
      fromRecord[taskId] = { sourceRunId: run!.runId, anchorAt: derived.anchorAt ?? new Date().toISOString() };
    }
    byTask[taskId] = derived.entries;
  }
  return { byTask, fromRecord };
}

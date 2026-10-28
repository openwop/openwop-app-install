/**
 * ADR 0889 D9 — capture an agent's tool boundary so a real run can be promoted
 * into a regression case (RFC 0244 UQ 7: the host export; nothing on the wire).
 *
 * OPT-IN per agent (`agent:eval-capture`, default OFF): recording every tool
 * call's inputs and results for every run would be an unbounded, PII-bearing
 * store. When ON for `(tenant, agentId)`, the run and chat lanes wrap their
 * `executeTool` with `captureExecuteTool`, which records `{tool, input, result}`
 * per call into `agent:tool-boundary`:
 *   - at most MAX_CALLS_PER_RUN calls per run, results truncated to MAX_RESULT_CHARS;
 *   - secrets stripped and free text sanitized before persistence;
 *   - aged out after TTL_DAYS (kvAgeOut) and by the retention purger;
 *   - erased on a subject-erasure request that matches the row (ADR 0464).
 * A capture failure never fails the tool call (best-effort, logged).
 *
 * ADR 0984 D7 — under the same opt-in, a LIVE EVAL TRIAL also keeps an
 * as-executed record of each call (`kind: 'exact'`): the input as passed and
 * the content the agent's tool loop received, SR-1 stripped of secrets, not cut
 * and not free-text sanitized. It is what lets an eval run of a live agent be an
 * RFC 0252 fixture source, whose wire events carry `argsHash` and no result.
 * Fixtures an eval run derives from it are frozen here too (`kind: 'frozen'`),
 * never in run metadata, keyed under the SOURCE run and stamped with the source
 * record's oldest time, so they share its retention and erasure (RFC 0252
 * Security): deleting, purging or erasing the source's record removes every
 * copy, and deleting the eval run removes its own. All of it lives under
 * `${tenant}:#x:${sourceRunId}:`, outside the capture readers'
 * `${tenant}:${runId}:` scans; the run delete cascade (`runKvKeys.ts`), the TTL,
 * the retention purger, tenant teardown and subject erasure cover it. Only `readExactCalls`
 * (called by `recordedFixtures.ts`) and `readFrozenFixtures` (called by
 * `agentEvalRun.ts`) read them; no route, export or promote path does.
 */
import { DurableCollection } from '../hostExtPersistence.js';
import { stripSecretsFromPersisted } from '../../byok/ephemeralRunSecrets.js';
import { sanitizeFreeTextDeep } from '../../byok/textRedaction.js';
import { registerKvAgeOut } from '../kvAgeOut.js';
import { registerRetentionPurger, purgeRowsByAge } from '../retentionPurger.js';
import { registerSubjectEraser } from '../subjectErasure.js';
import { subjectKeyForms } from '../subjectErasureRedaction.js';
import { createLogger } from '../../observability/logger.js';
import type { ExecuteAgentTool } from '../agentDispatch.js';
import { agentStorageId } from '../../executor/agentIdAliases.js';
import { computeArgsHash } from '../toolHooks.js';
import type { ToolResponseFixture } from './suiteStore.js';

const log = createLogger('host.evals.toolBoundary');

export const MAX_CALLS_PER_RUN = 50;
export const MAX_RESULT_CHARS = 16_000;
export const TTL_DAYS = 30;
/** ADR 0984 D7 — per call: an input or content over this many UTF-8 bytes is recorded `complete: false`, without content. */
export const MAX_EXACT_BYTES = 100_000;
/** ADR 0984 D7 — per run: past this many calls the run is marked over the cap and is never a source. */
export const MAX_EXACT_CALLS_PER_RUN = 200;

export interface CaptureSetting { key: string; tenantId: string; agentId: string; enabled: boolean; updatedAt: string; updatedBy?: string }
export interface BoundaryRow {
  key: string;
  tenantId: string;
  runId: string;
  agentId: string;
  /** Review H3 — one lane invocation (a chat turn, a workflow agent node). Sorts chronologically. */
  wrapId: string;
  /** The node id / lane that made the calls, so promote can pick one invocation. */
  segment?: string;
  seq: number;
  tool: string;
  input: unknown;
  result: string;
  isError: boolean;
  updatedAt: string;
}

const settings = new DurableCollection<CaptureSetting>('agent:eval-capture', (r) => r.key, undefined, (r) => r.tenantId);
// Review (kvAgeOut warning) — NO tenant index: every read is a `${tenantId}:` prefix
// scan, and teardown reads the row's own `tenantId`. An index nobody reads only
// doubled each capture write and stranded markers on the kvAgeOut lane.
const rows = new DurableCollection<AnyRow>('agent:tool-boundary', (r) => r.key);
/**
 * EVD-6 — the per-run call counter, a CAS-incremented row beside the run's calls.
 * Its key sits under the run's prefix (`${tenant}:${runId}:#cap`), so every path
 * that removes a run's calls (run delete cascade, TTL, retention, the
 * by-prefix reads) covers it with no extra wiring. It holds no tool content.
 */
interface BoundaryCapRow { key: string; tenantId: string; runId: string; kind: 'cap'; count: number; updatedAt: string }
/** ADR 0984 D7 — one call of a live eval trial as executed. `complete: false`: too large, content not held. */
export interface ExactRow {
  key: string; tenantId: string; runId: string; kind: 'exact';
  agentId: string; callId: string; tool: string;
  /** `computeArgsHash` of the input as passed: pairs the row with its `agent.toolCalled.argsHash`. */
  argsHash: string;
  input?: unknown; content?: string; isError: boolean; complete: boolean; updatedAt: string;
}
/** ADR 0984 D7 — the run's exact-call counter; `over` once a call was not recorded. */
interface ExactCapRow { key: string; tenantId: string; runId: string; kind: 'exact-cap'; count: number; over: boolean; updatedAt: string }
/** ADR 0984 D7 — one eval task's fixtures derived from a source's exact rows. `runId` is the
 *  SOURCE run; `updatedAt` is the source record's oldest, so the copy ages with it. */
interface FrozenRow { key: string; tenantId: string; runId: string; kind: 'frozen'; evalRunId: string; taskId: string; entries: ToolResponseFixture[]; updatedAt: string }
type AnyRow = BoundaryRow | BoundaryCapRow | ExactRow | ExactCapRow | FrozenRow;
const kindOf = (r: AnyRow): string | undefined => (r as { kind?: string }).kind;
const isCallRow = (r: AnyRow): r is BoundaryRow => kindOf(r) === undefined;
const exactPrefix = (tenantId: string, runId: string): string => `${tenantId}:#x:${runId}:`;
const exactKey = (tenantId: string, runId: string, wrapId: string, seq: number): string => `${exactPrefix(tenantId, runId)}${wrapId}:${String(seq).padStart(4, '0')}`;
const exactCapKey = (tenantId: string, runId: string): string => `${exactPrefix(tenantId, runId)}#cap`;
const frozenKey = (tenantId: string, sourceRunId: string, evalRunId: string, taskId: string): string => `${exactPrefix(tenantId, sourceRunId)}#frozen:${evalRunId}:${taskId}`;
const capKey = (tenantId: string, runId: string): string => `${tenantId}:${runId}:#cap`;
const MAX_CAP_ATTEMPTS = 8;

/**
 * Reserve one of the run's MAX_CALLS_PER_RUN slots, atomically across every
 * concurrent wrap of the run (parallel agent nodes each seeded `recorded` from
 * the same count, so each could record 50). Returns the run's new call count,
 * or null when the cap is reached (or the counter stays contended).
 */
async function reserveCallSlot(tenantId: string, runId: string): Promise<number | null> {
  for (let attempt = 0; attempt < MAX_CAP_ATTEMPTS; attempt++) {
    const cur = await rows.get(capKey(tenantId, runId));
    const capRow = cur && kindOf(cur) === 'cap' ? (cur as BoundaryCapRow) : null;
    // A run captured before the counter existed: seed it from what is stored.
    const count = capRow ? capRow.count : (await listRunBoundary(tenantId, runId)).length;
    if (count >= MAX_CALLS_PER_RUN) return null;
    const next: BoundaryCapRow = { key: capKey(tenantId, runId), tenantId, runId, kind: 'cap', count: count + 1, updatedAt: new Date().toISOString() };
    if (await rows.compareAndSwap(capRow, next)) return next.count;
  }
  return null;
}
/** Review M4 — one row per captured (agent, run): the capture list is a point
 *  prefix read on `${tenant}:${agent}:`, never a scan of every captured call.
 *  Holds no tool content (ids, a count, a time), ages out on the same TTL. */
export interface BoundaryRunIndex {
  key: string; tenantId: string; agentId: string; runId: string; calls: number; lastAt: string;
  /** EVUX-7 — which lane captured it, so the promote picker can say "chat" vs "workflow run". */
  lane?: CaptureLane;
  /** EVUX-7 — the run's FIRST captured call, `tool: <input>`, secrets stripped and
   *  sanitized like the row itself, cut to PREVIEW_CHARS. Enough to recognise a run. */
  inputPreview?: string;
}
export type CaptureLane = 'chat' | 'run';
export const PREVIEW_CHARS = 120;
const runIndex = new DurableCollection<BoundaryRunIndex>('agent:tool-boundary-run', (r) => r.key);
const indexKey = (tenantId: string, agentId: string, runId: string): string => `${tenantId}:${agentStorageId(agentId)}:${runId}`;

// ADR 0763 — one agent, two spellings: roster rows keep the legacy `feature.*`
// id while the lanes resolve the canonical one. Key on the storage spelling so
// a switch flipped from the workspace (legacy) is the one the lane reads.
const settingKey = (tenantId: string, agentId: string): string => `${tenantId}:${agentStorageId(agentId)}`;
// Review H3 — a run spans many lane invocations (every chat turn re-wraps; every
// agent node of a workflow wraps), so the key carries the wrap, not just a
// per-wrap counter that restarted at 0 and overwrote the previous turn's rows.
const rowKey = (tenantId: string, runId: string, wrapId: string, seq: number): string => `${tenantId}:${runId}:${wrapId}:${String(seq).padStart(4, '0')}`;
let wrapCounter = 0;
/** Millisecond time + an in-process counter: unique per wrap and sorts in wrap order. */
function nextWrapId(): string {
  wrapCounter = (wrapCounter + 1) % 1000;
  return `${String(Date.now()).padStart(13, '0')}${String(wrapCounter).padStart(3, '0')}`;
}

export async function getCaptureSetting(tenantId: string, agentId: string): Promise<boolean> {
  return (await settings.get(settingKey(tenantId, agentId)))?.enabled === true;
}

export async function setCaptureSetting(tenantId: string, agentId: string, enabled: boolean, updatedBy?: string): Promise<void> {
  await settings.put({ key: settingKey(tenantId, agentId), tenantId, agentId, enabled, updatedAt: new Date().toISOString(), ...(updatedBy ? { updatedBy } : {}) });
}

/**
 * EVD-5 — drop an agent's opt-in with the agent. User agent ids are deterministic
 * (`user.<personaSlug>`), so a surviving row silently re-armed PII capture for a
 * re-created agent of the same name.
 */
export async function deleteCaptureSetting(tenantId: string, agentId: string): Promise<void> {
  await settings.delete(settingKey(tenantId, agentId));
}

/** Wrap a lane's executor when capture is ON for this agent; otherwise return it unchanged. */
export async function maybeCaptureExecuteTool(
  inner: ExecuteAgentTool,
  ctx: { tenantId: string; runId: string; agentId: string; segment?: string; lane?: CaptureLane },
): Promise<ExecuteAgentTool> {
  let on = false;
  try { on = await getCaptureSetting(ctx.tenantId, ctx.agentId); } catch { on = false; }
  if (!on) return inner;
  const wrapId = nextWrapId();
  let seq = 0;
  return async (call) => {
    const out = await inner(call);
    // The cap is per RUN (as documented), not per wrap, and is reserved atomically.
    const recorded = await reserveCallSlot(ctx.tenantId, ctx.runId).catch(() => null);
    if (recorded !== null) {
      const at = seq;
      seq += 1;
      try {
        const input = sanitizeFreeTextDeep(stripSecretsFromPersisted(call.input as Record<string, unknown>));
        await rows.put({
          key: rowKey(ctx.tenantId, ctx.runId, wrapId, at),
          tenantId: ctx.tenantId, runId: ctx.runId, agentId: ctx.agentId, wrapId, seq: at,
          ...(ctx.segment ? { segment: ctx.segment } : {}),
          tool: call.name,
          input,
          // Review L4 — the result gets the Tier-1 known-secret pass too, not only the free-text one.
          result: String(sanitizeFreeTextDeep(stripSecretsFromPersisted({ content: out.content }).content)).slice(0, MAX_RESULT_CHARS),
          isError: out.isError === true,
          updatedAt: new Date().toISOString(),
        });
        // `recorded` is the run's reserved count, so the index count is the run's, not this wrap's.
        const key = indexKey(ctx.tenantId, ctx.agentId, ctx.runId);
        // The preview is the run's FIRST call; later calls carry the stored one forward.
        const prev = recorded === 1 ? null : await runIndex.get(key);
        const inputPreview = prev ? prev.inputPreview : `${call.name}: ${JSON.stringify(input) ?? ''}`.slice(0, PREVIEW_CHARS);
        const lane = ctx.lane ?? prev?.lane;
        await runIndex.put({
          key, tenantId: ctx.tenantId, agentId: ctx.agentId, runId: ctx.runId, calls: recorded, lastAt: new Date().toISOString(),
          ...(lane ? { lane } : {}), ...(inputPreview ? { inputPreview } : {}),
        });
      } catch (err) {
        log.warn('tool_boundary_capture_failed', { tenantId: ctx.tenantId, runId: ctx.runId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  };
}

// ── ADR 0984 D7 — the as-executed record (live eval trials only) ─────────────

const bytes = (v: unknown): number => Buffer.byteLength(typeof v === 'string' ? v : (JSON.stringify(v) ?? ''), 'utf8');

/** Reserve one of the run's exact-call slots; past the cap, mark the run over and refuse. */
async function reserveExactSlot(tenantId: string, runId: string): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_CAP_ATTEMPTS; attempt++) {
    const cur = await rows.get(exactCapKey(tenantId, runId));
    const capRow = cur && kindOf(cur) === 'exact-cap' ? (cur as ExactCapRow) : null;
    if (capRow?.over) return false;
    const count = capRow?.count ?? 0;
    const over = count >= MAX_EXACT_CALLS_PER_RUN;
    const next: ExactCapRow = { key: exactCapKey(tenantId, runId), tenantId, runId, kind: 'exact-cap', count: over ? count : count + 1, over, updatedAt: new Date().toISOString() };
    if (await rows.compareAndSwap(capRow, next)) return !over;
  }
  return false;
}

/**
 * Wrap a live eval trial's executor so each call is recorded as executed, when
 * capture is ON for this agent; null otherwise. Wrap it OUTSIDE the fixture
 * interceptor, so the record is what the agent's tool loop received. A record
 * failure never fails the call; it leaves the run unusable as a source (the
 * derivation finds the call unheld).
 */
export async function maybeRecordExactCalls(
  ctx: { tenantId: string; runId: string; agentId: string },
): Promise<((inner: ExecuteAgentTool) => ExecuteAgentTool) | null> {
  let on = false;
  try { on = await getCaptureSetting(ctx.tenantId, ctx.agentId); } catch { on = false; }
  if (!on) return null;
  return (inner) => {
    const wrapId = nextWrapId();
    let seq = 0;
    const record = async (call: Parameters<ExecuteAgentTool>[0], o: { content: string; isError?: boolean }): Promise<void> => {
      if (!call.callId) return;
      const at = seq;
      seq += 1;
      try {
        if (!(await reserveExactSlot(ctx.tenantId, ctx.runId))) return;
        const input = stripSecretsFromPersisted(call.input);
        const content = String(stripSecretsFromPersisted({ content: o.content }).content);
        const complete = bytes(input) <= MAX_EXACT_BYTES && bytes(content) <= MAX_EXACT_BYTES;
        await rows.put({
          key: exactKey(ctx.tenantId, ctx.runId, wrapId, at), tenantId: ctx.tenantId, runId: ctx.runId, kind: 'exact',
          agentId: ctx.agentId, callId: call.callId, tool: call.name, argsHash: computeArgsHash(call.input),
          ...(complete ? { input, content } : {}),
          isError: o.isError === true, complete, updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        log.warn('tool_boundary_exact_failed', { tenantId: ctx.tenantId, runId: ctx.runId, error: err instanceof Error ? err.message : String(err) });
      }
    };
    return async (call) => {
      let out: Awaited<ReturnType<ExecuteAgentTool>>;
      try {
        out = await inner(call);
      } catch (err) {
        // The dispatcher answers a thrown tool with this content (a lost lease
        // records no return at all, so that source is refused anyway).
        await record(call, { content: `tool_execution_failed: ${err instanceof Error ? err.message : String(err)}`, isError: true });
        throw err;
      }
      await record(call, out);
      return out;
    };
  };
}

/**
 * A run's as-executed calls in record order, or null when the run went over the
 * cap (some call is not held). Only the RFC 0252 derivation calls this (ratchet test).
 */
export async function readExactCalls(tenantId: string, runId: string): Promise<ExactRow[] | null> {
  const all = (await rows.listByPrefix(exactPrefix(tenantId, runId))).filter((r) => r.tenantId === tenantId && r.runId === runId);
  if (all.some((r) => kindOf(r) === 'exact-cap' && (r as ExactCapRow).over)) return null;
  return all.filter((r): r is ExactRow => kindOf(r) === 'exact').sort((a, b) => a.key.localeCompare(b.key));
}

/** One eval task's frozen copy: the entries, the source run they came from, and the source record's oldest time. */
export interface FrozenFixtureSet { sourceRunId: string; anchorAt: string; entries: ToolResponseFixture[] }

/** Freeze an eval run's record-derived fixtures, each under its source run. */
export async function freezeRecordedFixtures(tenantId: string, evalRunId: string, byTask: Record<string, FrozenFixtureSet>): Promise<void> {
  for (const [taskId, f] of Object.entries(byTask)) {
    await rows.put({ key: frozenKey(tenantId, f.sourceRunId, evalRunId, taskId), tenantId, runId: f.sourceRunId, kind: 'frozen', evalRunId, taskId, entries: f.entries, updatedAt: f.anchorAt });
  }
}

/** Drop an eval run's frozen copies (its create was refused after they were written). */
export async function dropFrozenFixtures(tenantId: string, evalRunId: string, sources: Record<string, string>): Promise<void> {
  for (const [taskId, sourceRunId] of Object.entries(sources)) await rows.delete(frozenKey(tenantId, sourceRunId, evalRunId, taskId));
}

/** One task's frozen copy, or null when it is gone (the source's record was erased,
 *  purged or deleted with its run). Only `agentEvalRun.ts` calls this. */
export async function readFrozenFixtures(tenantId: string, sourceRunId: string, evalRunId: string, taskId: string): Promise<ToolResponseFixture[] | null> {
  const r = await rows.get(frozenKey(tenantId, sourceRunId, evalRunId, taskId));
  return r && kindOf(r) === 'frozen' && r.tenantId === tenantId ? (r as FrozenRow).entries : null;
}

/** A run's captured calls in call order (wrap, then seq); `segment` narrows to one lane invocation. */
export async function listRunBoundary(tenantId: string, runId: string, opts: { wrapId?: string } = {}): Promise<BoundaryRow[]> {
  return (await rows.listByPrefix(`${tenantId}:${runId}:`))
    .filter(isCallRow)
    .filter((r) => r.tenantId === tenantId && r.runId === runId && (!opts.wrapId || r.wrapId === opts.wrapId))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** The lane invocations a run's capture spans (for picking one to promote). */
export async function listRunBoundaryWraps(tenantId: string, runId: string): Promise<Array<{ wrapId: string; segment?: string; calls: number }>> {
  const byWrap = new Map<string, { wrapId: string; segment?: string; calls: number }>();
  for (const r of await listRunBoundary(tenantId, runId)) {
    const e = byWrap.get(r.wrapId) ?? { wrapId: r.wrapId, ...(r.segment ? { segment: r.segment } : {}), calls: 0 };
    e.calls += 1;
    byWrap.set(r.wrapId, e);
  }
  return [...byWrap.values()];
}

/** Recent captured runs for an agent (one entry per run, newest first). Review M4: index read. */
export async function listCapturedRuns(tenantId: string, agentId: string, limit = 25): Promise<Array<{ runId: string; calls: number; lastAt: string; lane?: CaptureLane; inputPreview?: string }>> {
  return (await runIndex.listByPrefix(`${tenantId}:${agentStorageId(agentId)}:`))
    .filter((r) => r.tenantId === tenantId && r.calls > 0)
    .map((r) => ({ runId: r.runId, calls: r.calls, lastAt: r.lastAt, ...(r.lane ? { lane: r.lane } : {}), ...(r.inputPreview ? { inputPreview: r.inputPreview } : {}) }))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
    .slice(0, limit);
}

/** Re-derive one run's index row from its remaining captured calls (after erasure/purge). */
async function reindexRun(tenantId: string, agentId: string, runId: string): Promise<void> {
  const left = (await listRunBoundary(tenantId, runId)).filter((r) => agentStorageId(r.agentId) === agentStorageId(agentId));
  const key = indexKey(tenantId, agentId, runId);
  if (left.length === 0) { await runIndex.delete(key); return; }
  const lastAt = left.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), left[0]!.updatedAt);
  // The preview is re-derived from the first SURVIVING call: the old one may quote
  // the very call erasure just deleted.
  const first = left[0]!;
  const lane = (await runIndex.get(key))?.lane;
  await runIndex.put({
    key, tenantId, agentId, runId, calls: left.length, lastAt, ...(lane ? { lane } : {}),
    inputPreview: `${first.tool}: ${JSON.stringify(first.input) ?? ''}`.slice(0, PREVIEW_CHARS),
  });
}

registerKvAgeOut({ id: 'agent:tool-boundary', prefix: 'hostext:agent:tool-boundary:', ttlDays: TTL_DAYS, timestampField: 'updatedAt' });
registerKvAgeOut({ id: 'agent:tool-boundary-run', prefix: 'hostext:agent:tool-boundary-run:', ttlDays: TTL_DAYS, timestampField: 'lastAt' });
registerRetentionPurger({
  feature: 'agent:tool-boundary',
  dryRun: 'rows-by-age',
  async purge(tenantId, classification, cutoffIso) {
    // Tool inputs/results can quote a person: treat as the most sensitive class.
    if (!tenantId || classification !== 'confidential-pii') return 0;
    const n = await purgeRowsByAge('agent:tool-boundary', await rows.listByPrefix(`${tenantId}:`), tenantId, cutoffIso,
      (r) => ({ tenantId: r.tenantId, updatedAt: r.updatedAt, id: r.key }),
      (id) => rows.delete(id));
    // The index row's `lastAt` is its newest call, so it is never older than a surviving row.
    await purgeRowsByAge('agent:tool-boundary-run', await runIndex.listByPrefix(`${tenantId}:`), tenantId, cutoffIso,
      (r) => ({ tenantId: r.tenantId, updatedAt: r.lastAt, id: r.key }),
      (id) => runIndex.delete(id));
    return n;
  },
});

/** ADR 0464 — a captured call that mentions the subject is deleted (it is run content, not work-product). */
export async function eraseSubjectToolBoundary(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  // EVD-11 — the same guards as the suite eraser: the row's own tenant (not only
  // the key prefix), and no form shorter than 4 chars (it would match unrelated text).
  const contentForms = [...forms].filter((f) => f.length >= 4);
  const touched = new Map<string, { agentId: string; runId: string }>();
  const all = await rows.listByPrefix(`${tenantId}:`);
  // ADR 0984 D7 — an as-executed record that mentions the subject goes, and with it
  // EVERY copy an eval run froze from that source (RFC 0252 Security: a copy shares
  // its source's erasure). A frozen copy that mentions the subject goes too.
  const erasedSources = new Set<string>();
  for (const r of all) {
    if (r.tenantId !== tenantId || kindOf(r) !== 'exact') continue;
    if (contentForms.some((f) => JSON.stringify([(r as ExactRow).input, (r as ExactRow).content]).includes(f))) {
      await rows.delete(r.key);
      erasedSources.add(r.runId);
    }
  }
  for (const r of all) {
    if (r.tenantId !== tenantId || kindOf(r) !== 'frozen') continue;
    if (erasedSources.has(r.runId) || contentForms.some((f) => JSON.stringify((r as FrozenRow).entries).includes(f))) await rows.delete(r.key);
  }
  for (const r of all) {
    if (r.tenantId !== tenantId) continue;
    const k = kindOf(r);
    if (k === 'exact' || k === 'frozen') continue;
    if (!isCallRow(r)) continue;
    const text = JSON.stringify([r.input, r.result]);
    if (contentForms.some((f) => text.includes(f))) {
      await rows.delete(r.key);
      touched.set(`${agentStorageId(r.agentId)}:${r.runId}`, { agentId: r.agentId, runId: r.runId });
    }
  }
  // Review M4 — the index must not list a run whose calls were erased.
  for (const t of touched.values()) await reindexRun(tenantId, t.agentId, t.runId);
  for (const s of await settings.listByPrefix(`${tenantId}:`)) {
    if (s.tenantId !== tenantId) continue;
    if (s.updatedBy !== undefined && forms.has(s.updatedBy)) {
      const { updatedBy: _erased, ...rest } = s;
      void _erased;
      await settings.put(rest);
    }
  }
}

export function registerToolBoundaryErasure(): void {
  registerSubjectEraser(eraseSubjectToolBoundary);
}

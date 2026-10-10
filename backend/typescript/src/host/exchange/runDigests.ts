/**
 * ADR 0764 D1/D2 — workflow runs are conversation context.
 *
 * Before this module a `workflow_run` turn reached the model as the literal JSON
 * `{"kind":"workflow_run","runId":"…"}` (`asText` stringifies non-text content),
 * and a run the USER started with `/slug` never reached it at all — the SPA
 * starts it over `POST /v1/runs` and records the bubble only as a chat-session
 * message. So the agent was told a run existed and nothing about it, or not even
 * that. This module turns both into a grounded, bounded, fenced digest.
 *
 * READ-ONLY by construction. The session-run half (D2) READS the chat session's
 * `workflow_run` messages and never writes a turn: ADR 0491 made the exchange the
 * single turn-index allocator, and a second allocator racing it is the incident
 * `turnRunDispatch.ts` records. The pseudo-turns built here live only in the
 * prompt.
 *
 * TRUST. Everything run-derived — the workflow name included, since any tenant
 * member can name a workflow — goes inside ONE untrusted fence per run. The host
 * frame outside it carries only the run id and the status enum (ADR 0764 B2).
 * Run read visibility is the tenant (`runAccess.ts` `loadReadableRun`), and every
 * read passes the same pinned-run disposition an authorized read does.
 *
 * NEVER a guessed status: a read fault renders "status unavailable", not the last
 * thing we believed, and never the raw JSON.
 */

import type { Storage } from '../../storage/storage.js';
import type { RunRecord } from '../../types.js';
import type { ConversationTurn } from '../conversation.js';
import { makeTurn } from '../conversation.js';
import { disposePinnedRun } from '../pinnedRunDisposition.js';
import { sanitizeFreeTextDeep } from '../../byok/textRedaction.js';
import { fenceUntrustedBlock } from '../untrustedContent.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('host.runDigests');

/** How many of the newest admitted runs get a DETAILED digest; older ones get
 *  their status headline only. */
export const RUN_DIGEST_MAX_RUNS = 8;
/** Per-run cap on the output / error excerpt (chars of JSON or text). */
export const RUN_DIGEST_EXCERPT_CHARS = 1_500;
/** Total detail budget across all digests; past it, older runs render status-only.
 *  The ADR 0148 transcript window measures the RAW turn, not this text, so the
 *  digests carry their own bound (ADR 0764 H2). */
export const RUN_DIGEST_TOTAL_CHARS = 6_000;
/** How many recent chat-session messages D2 inspects for `/slug` runs. */
export const SESSION_RUN_SCAN_LIMIT = 40;

/** What a digest is made of. `headline` is host-authored (run id + status enum);
 *  `detail` is the run-derived text, ALREADY fenced. */
export interface RunDigest {
  headline: string;
  detail?: string;
}

export interface RunRef {
  runId: string;
  /** When the run entered the conversation (ms epoch) — the recency order. */
  ts: number;
  /** A name the HOST recorded for the run (a dispatching tool's `workflowName`). */
  workflowName?: string;
  /** Where the id came from: the host-written turn log, or a client-written
   *  chat-session message (which needs the extra session-binding check). */
  source: 'turn' | 'session';
}

// ONLY the completed run's output excerpt is memoised — never the admission. Every
// exchange re-reads the run RECORD (a point lookup), so a run deleted by retention,
// the runs DELETE route or a DSAR erasure stops reaching the model on the very next
// turn. The first cut cached the whole digest and skipped `getRun` on a hit, which
// kept serving an erased run until the process restarted (grade-code CHATCD-1).
// What remains cached is the tail read of an EXISTING completed run's immutable
// `run.completed` payload. Keyed by tenant.
const OUTPUT_CACHE_MAX = 500;
const outputCache = new Map<string, string>();
function cacheKey(tenantId: string, runId: string): string {
  return `${tenantId}\u0000${runId}`;
}
function rememberOutput(key: string, text: string): void {
  if (outputCache.size >= OUTPUT_CACHE_MAX) {
    const oldest = outputCache.keys().next().value;
    if (oldest !== undefined) outputCache.delete(oldest);
  }
  outputCache.set(key, text);
}

/** Test seam. */
export function __resetRunDigestCacheForTest(): void {
  outputCache.clear();
}

/** The line a run renders when it cannot be read (absent, foreign, or a fault). */
export function unavailableDigest(runId: string): RunDigest {
  return { headline: `[Workflow run ${runId} — status unavailable]` };
}

/** The line a run renders when it has no digest this turn (a caller with no
 *  resolver) — distinct from "unavailable", which is a read that FAILED. */
export function notReReadLine(runId: string): string {
  return `[Workflow run ${runId} — earlier run, status not re-read this turn]`;
}

/** Redact FIRST, then cut: truncating first could split a secret so the redaction
 *  pattern no longer matches the half left behind (grade-code CHATCD-4). */
function excerpt(value: unknown): string {
  const redacted = sanitizeFreeTextDeep(value);
  const text = typeof redacted === 'string' ? redacted : JSON.stringify(redacted ?? null);
  return text.length <= RUN_DIGEST_EXCERPT_CHARS
    ? text
    : `${text.slice(0, RUN_DIGEST_EXCERPT_CHARS)} … [truncated]`;
}

/** Read the terminal outputs from the tail of the run's log — never a full page:
 *  `run.completed` is the last event a completed run appends. */
async function readCompletedOutputs(storage: Storage, runId: string): Promise<unknown> {
  const max = await storage.getMaxSequence(runId);
  if (max < 0) return undefined;
  const tail = await storage.listEvents(runId, { fromSeq: Math.max(-1, max - 4) });
  const completed = [...tail].reverse().find((e) => e.type === 'run.completed');
  const payload = completed?.payload as { outputs?: unknown; output?: unknown } | undefined;
  return payload?.outputs ?? payload?.output;
}

/** The headline alone: host-authored run id + status enum, nothing run-derived. */
function headlineFor(run: RunRecord): string {
  return `[Workflow run ${run.runId} — ${run.status}]`;
}

/** The full digest: headline + ONE fence around everything run-derived. */
async function detailedDigest(storage: Storage, tenantId: string, ref: RunRef, run: RunRecord): Promise<RunDigest> {
  const lines: string[] = [`workflow: ${excerpt(ref.workflowName ?? run.workflowId)}`];
  if (run.status === 'failed' && run.error) {
    lines.push(`error ${excerpt(run.error.code)}: ${excerpt(run.error.message)}`);
  } else if (run.status === 'completed') {
    const key = cacheKey(tenantId, run.runId);
    let out = outputCache.get(key);
    if (out === undefined) {
      const outputs = await readCompletedOutputs(storage, run.runId);
      out = outputs === undefined ? '(none recorded)' : excerpt(outputs);
      rememberOutput(key, out);
    }
    lines.push(`outputs: ${out}`);
  } else if (run.status.startsWith('waiting-')) {
    lines.push('paused, waiting for input');
  }
  return { headline: headlineFor(run), detail: fenceUntrustedBlock(lines.join('\n'), `workflow run ${run.runId}`) };
}

/**
 * Resolve digests for `refs`. Never throws.
 *
 * Order of operations matters (grade-code CHATCD-2): ADMIT every candidate first
 * (one point read each), THEN rank the admitted runs by `ts` and give the newest
 * `RUN_DIGEST_MAX_RUNS` a detailed digest; older admitted runs still get their
 * real status as a headline. The first cut capped BEFORE admission and ranked by
 * list position, so forged or foreign session rows could spend the cap and push
 * the agent's own runs to "not re-read".
 *
 * - `turn` refs are host-written: absent/foreign/fault ⇒ "status unavailable".
 * - `session` refs are CLIENT-written: the run must exist in this tenant AND be
 *   bound to this conversation; anything else is OMITTED — never described, not
 *   even as unavailable, which would confirm a probed id.
 */
export async function resolveRunDigests(
  storage: Storage,
  input: { tenantId: string; chatSessionId?: string | undefined; refs: readonly RunRef[] },
): Promise<Map<string, RunDigest>> {
  const out = new Map<string, RunDigest>();
  const byId = new Map<string, RunRef>();
  for (const r of input.refs) {
    const prior = byId.get(r.runId);
    if (!prior || (prior.source === 'session' && r.source === 'turn')) byId.set(r.runId, { ...r, ts: Math.max(r.ts, prior?.ts ?? r.ts) });
  }
  const admitsSession = (bound: unknown): boolean => !!input.chatSessionId && bound === input.chatSessionId;

  const admitted: Array<{ ref: RunRef; run: RunRecord }> = [];
  await Promise.all([...byId.values()].map(async (ref) => {
    try {
      const raw = await storage.getRun(ref.runId);
      const bound = (raw?.metadata as { chatSessionId?: unknown } | undefined)?.chatSessionId;
      if (ref.source === 'session' && (!raw || raw.tenantId !== input.tenantId || !admitsSession(bound))) return;
      if (!raw || raw.tenantId !== input.tenantId) { out.set(ref.runId, unavailableDigest(ref.runId)); return; }
      admitted.push({ ref, run: await disposePinnedRun(storage, raw) });
    } catch (err) {
      log.warn('run_digest_resolve_failed', { runId: ref.runId, source: ref.source, error: err instanceof Error ? err.message : String(err) });
      if (ref.source === 'turn') out.set(ref.runId, unavailableDigest(ref.runId));
    }
  }));

  admitted.sort((a, b) => b.ref.ts - a.ref.ts);
  await Promise.all(admitted.map(async ({ ref, run }, i) => {
    if (i >= RUN_DIGEST_MAX_RUNS) { out.set(run.runId, { headline: headlineFor(run) }); return; }
    try {
      out.set(run.runId, await detailedDigest(storage, input.tenantId, ref, run));
    } catch (err) {
      // The status is KNOWN (the record was read); only the detail failed.
      log.warn('run_digest_detail_failed', { runId: run.runId, error: err instanceof Error ? err.message : String(err) });
      out.set(run.runId, { headline: headlineFor(run) });
    }
  }));
  return out;
}

/**
 * Apply the total-detail budget: walk newest → oldest, keep `detail` while it
 * fits, then headline-only. Returns the final prompt text per run id.
 */
export function renderRunDigests(
  digests: ReadonlyMap<string, RunDigest>,
  chronologicalRunIds: readonly string[],
): Map<string, string> {
  const rendered = new Map<string, string>();
  let budget = RUN_DIGEST_TOTAL_CHARS;
  for (const runId of [...chronologicalRunIds].reverse()) {
    if (rendered.has(runId)) continue;
    const d = digests.get(runId);
    if (!d) continue;
    if (d.detail && d.detail.length <= budget) {
      budget -= d.detail.length;
      rendered.set(runId, `${d.headline}\n${d.detail}`);
    } else {
      rendered.set(runId, d.headline);
    }
  }
  return rendered;
}

/** A `workflow_run` turn's run reference, or null. */
export function workflowRunRefOf(turn: ConversationTurn): { runId: string; workflowName?: string } | null {
  const c = turn.content as { kind?: unknown; runId?: unknown; workflowName?: unknown; workflowId?: unknown } | null;
  if (!c || typeof c !== 'object' || c.kind !== 'workflow_run' || typeof c.runId !== 'string' || !c.runId) return null;
  const name = typeof c.workflowName === 'string' && c.workflowName ? c.workflowName
    : typeof c.workflowId === 'string' && c.workflowId ? c.workflowId : undefined;
  return { runId: c.runId, ...(name ? { workflowName: name } : {}) };
}

/**
 * D2 — the runs the user started with `/slug` in this chat session, from its most
 * recent messages. ONLY the run id and the row's server-side `createdAt` are
 * taken; everything else in the row was written by a client. Fail-soft to [].
 */
export async function listSessionRuns(
  storage: Storage,
  chatSessionId: string,
): Promise<Array<{ runId: string; ts: number }>> {
  try {
    const rows = await storage.listChatSessionMessages(chatSessionId, { limit: SESSION_RUN_SCAN_LIMIT });
    const runs: Array<{ runId: string; ts: number }> = [];
    for (const row of rows) {
      if (row.role !== 'workflow_run') continue;
      let runId: unknown;
      try { runId = (JSON.parse(row.content) as { workflowRun?: { runId?: unknown } }).workflowRun?.runId; } catch { continue; }
      const ts = Date.parse(row.createdAt);
      if (typeof runId === 'string' && runId && Number.isFinite(ts)) runs.push({ runId, ts });
    }
    return runs;
  } catch (err) {
    log.warn('session_runs_read_failed', { chatSessionId, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/**
 * Interleave transient `workflow_run` pseudo-turns for session runs into the
 * (already windowed) transcript, each placed before the first turn that is newer
 * than it. Existing turns are never reordered. A run older than the oldest kept
 * turn is dropped when the window elided history (it belongs to the elided part).
 * Runs already referenced by a turn are skipped.
 */
export function mergeSessionRunTurns(
  turns: readonly ConversationTurn[],
  sessionRuns: ReadonlyArray<{ runId: string; ts: number }>,
  conversationId: string,
  opts: { historyElided: boolean },
): ConversationTurn[] {
  const referenced = new Set(turns.map((t) => workflowRunRefOf(t)?.runId).filter((id): id is string => !!id));
  const oldestKept = turns.length > 0 ? turns[0]!.ts : Number.NEGATIVE_INFINITY;
  const pending = [...sessionRuns]
    .filter((r) => !referenced.has(r.runId) && !(opts.historyElided && r.ts < oldestKept))
    .sort((a, b) => a.ts - b.ts);
  if (pending.length === 0) return [...turns];
  const pseudo = (r: { runId: string; ts: number }): ConversationTurn => makeTurn({
    conversationId,
    // Never persisted; -1 keeps it out of any index arithmetic a reader might do.
    turnIndex: -1,
    role: 'agent',
    from: 'host',
    content: { kind: 'workflow_run', runId: r.runId },
    ts: r.ts,
  });
  const out: ConversationTurn[] = [];
  let i = 0;
  for (const t of turns) {
    while (i < pending.length && pending[i]!.ts <= t.ts) out.push(pseudo(pending[i++]!));
    out.push(t);
  }
  while (i < pending.length) out.push(pseudo(pending[i++]!));
  return out;
}

/**
 * ADR 0480 — online evals: score PRODUCTION runs against an eval set's
 * ONLINE INVARIANT assertions at run-terminal, folding outcomes into daily
 * trend buckets.
 *
 * Called fire-and-forget at the executor's two terminal sites (beside
 * `stampRunCostOnTerminal`); never at cancel sites (cancellation is an
 * operator act, not an outcome — ADR 0476 OQ2). Non-production runs
 * (debug/eval/draft-launch) are skipped: the segmentation doctrine.
 *
 * Honesty rules:
 *  - Deterministic assertions ALWAYS evaluate — a failed production run
 *    scoring red is correct signal, and `output-contains` on absent output
 *    is an honest assertion failure (the /architect §1 ruling).
 *  - `llm-judge` never dispatches for a non-completed run (no spend to grade
 *    absent output) and is capped per tenant-day; a capped/skipped judge is
 *    COUNTED (`judgeSkipped`), never a silent pass.
 *  - Buckets are counts + opaque run references only — no output excerpts,
 *    no assertion detail strings (the erasure-exempt contract).
 *  - Increments are CAS-looped; persistent contention drops the increment
 *    and logs (best-effort observability counts, disclosed in the ADR).
 */

import { DurableCollection } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';
import type { Storage } from '../storage/storage.js';
import type { RunRecord } from '../types.js';
import { listEvalSets, type WorkflowEvalSet } from './workflowEvalSets.js';
import { collectRunEvidence, evaluateAssertions, type EvalJudge } from './workflowEvalRunner.js';
import { tenantEvalJudge } from './workflowEvalJudge.js';

const log = createLogger('host.workflowEvalOnline');

/** Code-review M2 — post-terminal scoring runs OUTSIDE every run budget
 *  (the concurrency slot is released at notifyRunTerminal), so a terminal
 *  burst must not fan out unbounded event scans + judge dispatches. A small
 *  in-process semaphore bounds concurrent scorings; waiters queue. */
const SCORING_CONCURRENCY = 3;
let scoringActive = 0;
const scoringWaiters: Array<() => void> = [];
async function withScoringSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (scoringActive >= SCORING_CONCURRENCY) {
    await new Promise<void>((res) => scoringWaiters.push(res));
  }
  scoringActive += 1;
  try {
    return await fn();
  } finally {
    scoringActive -= 1;
    scoringWaiters.shift()?.();
  }
}

/* ── stores ─────────────────────────────────────────────────────────────── */

export interface OnlineEvalBucket {
  /** `${tenantId}:${encodeURIComponent(workflowId)}:${evalSetId}:${day}` */
  key: string;
  tenantId: string;
  workflowId: string;
  evalSetId: string;
  /** YYYY-MM-DD (UTC). */
  day: string;
  evaluated: number;
  passed: number;
  failed: number;
  judged: number;
  judgeSkipped: number;
  sampledOut: number;
  /** Last ≤10 failing runs — OPAQUE references (runId + which assertion
   *  kinds failed), never output or detail strings. A retention-deleted
   *  runId dangles harmlessly (the FE deep link 404s honestly). */
  failures: Array<{ runId: string; failedKinds: string[]; at: string }>;
  updatedAt: string;
}

interface JudgeCapRow {
  /** `${tenantId}:${day}` */
  key: string;
  tenantId: string;
  day: string;
  count: number;
}

const buckets = new DurableCollection<OnlineEvalBucket>(
  'workflow:eval-online',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);
const judgeCaps = new DurableCollection<JudgeCapRow>(
  'workflow:eval-online-judgecap',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);

const bucketKey = (tenantId: string, workflowId: string, evalSetId: string, day: string): string =>
  `${tenantId}:${encodeURIComponent(workflowId)}:${evalSetId}:${day}`;
const setBucketPrefix = (tenantId: string, workflowId: string, evalSetId: string): string =>
  `${tenantId}:${encodeURIComponent(workflowId)}:${evalSetId}:`;

export const ONLINE_EVAL_BUCKET_KEEP_DAYS = 35;
export const ONLINE_FAILURE_REFS_MAX = 10;

function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function judgeRunsPerDay(): number {
  // Code-review L5 — an empty/whitespace env var is UNSET, not zero
  // (Number('') === 0 would silently disable all judging).
  const raw = process.env.OPENWOP_ONLINE_EVAL_JUDGE_RUNS_PER_DAY;
  if (raw === undefined || raw.trim() === '') return 50;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : 50;
}

function onlineEvalsEnabled(): boolean {
  return process.env.OPENWOP_ONLINE_EVALS !== 'off';
}

/* ── judge cap ──────────────────────────────────────────────────────────── */

/** Reserve one judged-run slot for (tenant, today). CAS-looped; false when
 *  the cap is reached or contention persists (fail-closed on SPEND — the
 *  run still scores its deterministic assertions). */
async function reserveJudgeSlot(tenantId: string, day: string): Promise<boolean> {
  const cap = judgeRunsPerDay();
  if (cap === 0) return false;
  const key = `${tenantId}:${day}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await judgeCaps.get(key);
    if ((existing?.count ?? 0) >= cap) return false;
    const next: JudgeCapRow = existing
      ? { ...existing, count: existing.count + 1 }
      : { key, tenantId, day, count: 1 };
    if (await judgeCaps.compareAndSwap(existing ?? null, next)) {
      // Code-review L6 — cap rows are per (tenant, day): prune stale days on
      // first reserve of a new day so the store never accretes.
      if (!existing) {
        void judgeCaps.listByPrefix(`${tenantId}:`).then(async (rows) => {
          for (const r of rows) { if (r.day < day) await judgeCaps.delete(r.key); }
        }).catch(() => {});
      }
      return true;
    }
  }
  return false;
}

/* ── bucket fold ────────────────────────────────────────────────────────── */

interface Outcome {
  passed?: boolean;      // absent = sampled out
  judged?: boolean;
  judgeSkipped?: boolean;
  failedKinds?: string[];
  runId?: string;
}

async function foldOutcome(set: WorkflowEvalSet, outcome: Outcome): Promise<void> {
  const day = todayUtc();
  const key = bucketKey(set.tenantId, set.workflowId, set.evalSetId, day);
  // Code-review M4 — 8 attempts with random backoff: correlated retries
  // under an N-instance burst starved the fold, dropping not just counts but
  // the failure REF (the only deep link to that failing run).
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (attempt > 0) await new Promise((res) => setTimeout(res, Math.random() * 25));
    const existing = await buckets.get(key);
    const base: OnlineEvalBucket = existing ?? {
      key,
      tenantId: set.tenantId,
      workflowId: set.workflowId,
      evalSetId: set.evalSetId,
      day,
      evaluated: 0, passed: 0, failed: 0, judged: 0, judgeSkipped: 0, sampledOut: 0,
      failures: [],
      updatedAt: new Date().toISOString(),
    };
    const next: OnlineEvalBucket = {
      ...base,
      evaluated: base.evaluated + (outcome.passed === undefined ? 0 : 1),
      passed: base.passed + (outcome.passed === true ? 1 : 0),
      failed: base.failed + (outcome.passed === false ? 1 : 0),
      judged: base.judged + (outcome.judged ? 1 : 0),
      judgeSkipped: base.judgeSkipped + (outcome.judgeSkipped ? 1 : 0),
      sampledOut: base.sampledOut + (outcome.passed === undefined ? 1 : 0),
      failures: outcome.passed === false && outcome.runId
        ? [...base.failures, { runId: outcome.runId, failedKinds: outcome.failedKinds ?? [], at: new Date().toISOString() }].slice(-ONLINE_FAILURE_REFS_MAX)
        : base.failures,
      updatedAt: new Date().toISOString(),
    };
    if (await buckets.compareAndSwap(existing ?? null, next)) {
      if (!existing) await pruneBuckets(set); // a new day started — prune old days
      return;
    }
  }
  log.warn('online_eval_bucket_contention', { key });
}

async function pruneBuckets(set: WorkflowEvalSet): Promise<void> {
  try {
    const rows = await buckets.listByPrefix(setBucketPrefix(set.tenantId, set.workflowId, set.evalSetId));
    const sorted = rows.sort((a, b) => b.day.localeCompare(a.day));
    for (const r of sorted.slice(ONLINE_EVAL_BUCKET_KEEP_DAYS)) await buckets.delete(r.key);
  } catch (err) {
    log.warn('online_eval_prune_failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/* ── the terminal hook ──────────────────────────────────────────────────── */

function isProductionRun(run: RunRecord): boolean {
  const m = (run.metadata ?? {}) as Record<string, unknown>;
  return m.debug === undefined && m.eval === undefined && m.launch !== 'draft';
}

/** Fire-and-forget at the executor terminal sites. Never throws. */
export async function scoreOnlineEvalsOnTerminal(storage: Storage, runId: string): Promise<void> {
  try {
    if (!onlineEvalsEnabled()) return;
    const run = await storage.getRun(runId);
    if (!run || !isProductionRun(run)) return;
    if (run.status !== 'completed' && run.status !== 'failed') return; // cancels never score
    // ADR 0480 grade-fix L1 — claim a once-per-run scoring ticket (the cost
    // fold-ticket pattern): a run reaching two terminal seams must not
    // double-count the trend. The marker rides the same atomic never-overwrite
    // merge; a lost claim (already scored) returns.
    if (!(await storage.mergeRunMetadata(runId, { onlineEvalScored: true }, { ifAbsentKey: 'onlineEvalScored' }))) return;
    const sets = (await listEvalSets(run.tenantId, run.workflowId)).filter((s) => s.online?.enabled);
    if (sets.length === 0) return;

    // Code-review M3 — draw every set's sample BEFORE the event scan, so a
    // low-rate tenant never pays a 100k-event read for a fully sampled-out
    // terminal. Sampled-out outcomes are still counted (never invisible).
    const sampledIn: WorkflowEvalSet[] = [];
    for (const set of sets) {
      const rate = set.online!.sampleRate ?? 1;
      if (rate < 1 && Math.random() >= rate) await foldOutcome(set, {});
      else sampledIn.push(set);
    }
    if (sampledIn.length === 0) return;

    await withScoringSlot(async () => {
      // Evidence is collected ONCE per run, shared across sets.
      const events = await storage.listEvents(runId, { fromSeq: -1, limit: 100_000 });
      const evidence = collectRunEvidence(run, events);
      const day = todayUtc();

      for (const set of sampledIn) {
        const online = set.online!;
        const judgeAssertions = online.assertions.filter((a) => a.kind === 'llm-judge');
        const deterministic = online.assertions.filter((a) => a.kind !== 'llm-judge');
        let judge: EvalJudge | undefined;
        let judged = false;
        let judgeSkipped = false;
        let scored = online.assertions;
        if (judgeAssertions.length > 0) {
          // Validation guarantees online.judge === true when judge assertions
          // exist (code-review H2) — the skip reasons left are the daily cap
          // and a non-completed run (no spend to grade absent output).
          if (run.status === 'completed' && (await reserveJudgeSlot(run.tenantId, day))) {
            judge = tenantEvalJudge(run.tenantId);
            judged = true;
          } else {
            // Code-review H1 — a SKIPPED judge EXCLUDES its assertions from
            // pass/fail instead of failing them: the previous behavior
            // recorded every over-budget run as FAILED, manufacturing red
            // trend signal exactly when the feature was used most (and
            // contradicting ADR 0480 §4's own SKIP wording). Coverage loss
            // is disclosed by `judgeSkipped`, never faked as quality loss.
            judgeSkipped = true;
            scored = deterministic;
          }
        }
        const verdicts = await evaluateAssertions(scored, evidence, judge);
        // Code-review L2 — `judged` means a DELIVERED verdict, not a charged
        // slot: a judge_error/judge_unavailable outcome reports honest
        // failure in the verdicts but must not claim judged coverage.
        if (judged && verdicts.some((v) => v.kind === 'llm-judge' && v.detail !== undefined && /^judge_(error|unavailable)/.test(v.detail))) {
          judged = false;
          judgeSkipped = true;
        }
        const failedKinds = verdicts.filter((v) => !v.pass).map((v) => v.kind);
        await foldOutcome(set, {
          passed: failedKinds.length === 0,
          judged,
          judgeSkipped,
          failedKinds,
          runId,
        });
      }
    });
  } catch (err) {
    log.warn('online_eval_scoring_failed', { runId, error: err instanceof Error ? err.message : String(err) });
  }
}

/* ── read surface ───────────────────────────────────────────────────────── */

export async function listOnlineBuckets(tenantId: string, workflowId: string, evalSetId: string): Promise<OnlineEvalBucket[]> {
  return (await buckets.listByPrefix(setBucketPrefix(tenantId, workflowId, evalSetId)))
    .sort((a, b) => a.day.localeCompare(b.day));
}

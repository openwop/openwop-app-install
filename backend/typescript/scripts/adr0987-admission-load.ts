/**
 * ADR 0987 Q3 — the hot-key admission load test.
 *
 * Q3 accepted count-in-insert (D2) only after a measured hot-key test, with a
 * budget of admission p95 ≤ 50 ms at 20 concurrent creators on ONE key. Above it,
 * the fallback is reservation rows. This script measures it, two ways.
 *
 * `--pg <dsn>` (local, the DB-side cost): N creators share one Postgres storage
 * (its own pool, `OPENWOP_PG_POOL_MAX`, default here = creators) and each loops
 * `insertRun({ admission: { key, cap } })` on the SAME key, then marks the run
 * `completed` so the scope keeps cycling under its cap. Every call takes the
 * partition-3 advisory lock, counts the key's holding rows and inserts, so the
 * timing is exactly the serialized section D2 adds. Admitted and refused calls
 * are timed separately. `--hold-ms` keeps each admitted run `running` that long
 * before completing it, so the scope sits at its cap and the refusal path is
 * exercised too (with 0 the scope rarely fills: the lock serializes inserts).
 * `--control` runs the same inserts with no admission, so a run's number can be
 * read against the machine's own baseline. Alternate the two: a single number
 * on a busy machine measures the machine.
 *
 *   OPENWOP_LOG_LEVEL=error node_modules/.bin/tsx scripts/adr0987-admission-load.ts \
 *     --pg postgres://user@127.0.0.1:5432/openwop_test [--creators 20] [--per 50] [--cap 5] [--hold-ms 0]
 *
 * `--http <base>` (a deployed host, end to end): N creators `POST /runs` for one
 * caller (one bearer token, so one admission key) and time the request. Refusals
 * (429 `session_concurrent` / `key_concurrent`) are expected at the cap and are
 * reported separately. Only a 429 whose `details.reason` is a concurrency
 * limiter counts as an admission refusal; any other 429 (a per-minute or per-day
 * run window, a write budget) is a RATE-LIMIT refusal, reported apart by reason,
 * because it says nothing about the admission lock. `--max-per-min` paces the
 * whole run under the host's run-per-minute windows (default: unpaced). The
 * token is read from OPENWOP_LOAD_TOKEN and never printed. NEVER run this
 * against production without a release-manager slot: it creates real runs.
 *
 *   OPENWOP_LOAD_TOKEN=… node_modules/.bin/tsx scripts/adr0987-admission-load.ts \
 *     --http https://app.openwop.dev/api --workflow <id> [--creators 20] [--per 10] [--max-per-min 100]
 *
 * Prints one JSON line: latency percentiles (ms) for admitted, refused and all
 * calls, the counts, and `budgetMet` against the 50 ms p95.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    pg: { type: 'string' },
    http: { type: 'string' },
    workflow: { type: 'string' },
    creators: { type: 'string', default: '20' },
    per: { type: 'string', default: '50' },
    cap: { type: 'string', default: '5' },
    'hold-ms': { type: 'string', default: '0' },
    control: { type: 'boolean', default: false },
    'max-per-min': { type: 'string' },
  },
});
const CREATORS = Number(values.creators);
const PER = Number(values.per);
const CAP = Number(values.cap);
const HOLD_MS = Number(values['hold-ms']);
/** The same inserts with NO admission: the baseline the lock and count are measured against. */
const CONTROL = values.control === true;
const BUDGET_P95_MS = 50;
/** 429 reasons that are the admission cap itself (rateLimit.ts `RunAdmission`); every other 429 is a rate window. */
const ADMISSION_REASONS = new Set(['session_concurrent', 'key_concurrent']);

function pct(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!.toFixed(2));
}
const summary = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: pct(xs, 100) });

async function pgMode(dsn: string): Promise<void> {
  process.env.OPENWOP_PG_POOL_MAX ??= String(CREATORS);
  const { openStorage } = await import('../src/storage/index.js');
  const { AdmissionRefusedError } = await import('../src/storage/storage.js');
  const storage = await openStorage(dsn);
  const key = `adr0987-q3-${randomUUID()}`;
  const tenantId = `adr0987-q3-${randomUUID().slice(0, 8)}`;
  const admitted: number[] = []; const refused: number[] = [];
  const creator = async (): Promise<void> => {
    for (let i = 0; i < PER; i += 1) {
      const now = new Date().toISOString();
      const runId = randomUUID();
      const t0 = performance.now();
      try {
        await storage.insertRun(
          { runId, workflowId: 'adr0987.q3', tenantId, status: 'running', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now },
          CONTROL ? undefined : { admission: { key, cap: CAP } },
        );
        admitted.push(performance.now() - t0);
        if (HOLD_MS > 0) await new Promise((r) => setTimeout(r, HOLD_MS));
        await storage.updateRun(runId, { status: 'completed', completedAt: new Date().toISOString() });
      } catch (err) {
        if (!(err instanceof AdmissionRefusedError)) throw err;
        refused.push(performance.now() - t0);
      }
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CREATORS }, creator));
  const wallMs = performance.now() - t0;
  const all = [...admitted, ...refused];
  const p95 = pct(all, 95);
  console.log(JSON.stringify({
    mode: CONTROL ? 'pg-control' : 'pg', creators: CREATORS, perCreator: PER, cap: CAP, holdMs: HOLD_MS, poolMax: Number(process.env.OPENWOP_PG_POOL_MAX),
    wallMs: Number(wallMs.toFixed(0)), admitted: summary(admitted), refused: summary(refused), all: summary(all),
    budgetP95Ms: BUDGET_P95_MS, budgetMet: p95 !== null && p95 <= BUDGET_P95_MS,
  }));
  process.exit(0);
}

async function httpMode(base: string): Promise<void> {
  const token = process.env.OPENWOP_LOAD_TOKEN;
  if (!token) throw new Error('OPENWOP_LOAD_TOKEN is required for --http');
  if (!values.workflow) throw new Error('--workflow is required for --http');
  const admitted: number[] = []; const refused: number[] = []; const other: Record<string, number> = {};
  const rateLimited: Record<string, number[]> = {};
  // Pacing: the calls share one clock, so the whole run stays under the window.
  const maxPerMin = values['max-per-min'] ? Number(values['max-per-min']) : 0;
  const gapMs = maxPerMin > 0 ? 60_000 / maxPerMin : 0;
  let nextSlot = performance.now();
  const takeSlot = async (): Promise<void> => {
    if (gapMs === 0) return;
    const at = nextSlot; nextSlot += gapMs;
    const wait = at - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
  const creator = async (): Promise<void> => {
    for (let i = 0; i < PER; i += 1) {
      await takeSlot();
      const t0 = performance.now();
      const res = await fetch(`${base.replace(/\/$/, '')}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'OpenWOP-Version': '2' },
        body: JSON.stringify({ workflowId: values.workflow, inputs: {} }),
      });
      const ms = performance.now() - t0;
      const text = await res.text();
      if (res.status === 201) admitted.push(ms);
      else if (res.status === 429) {
        let reason = 'unknown';
        try { reason = String((JSON.parse(text) as { details?: { reason?: unknown } }).details?.reason ?? 'unknown'); } catch { /* non-JSON 429 */ }
        if (ADMISSION_REASONS.has(reason)) refused.push(ms);
        else (rateLimited[reason] ??= []).push(ms);
      }
      else other[String(res.status)] = (other[String(res.status)] ?? 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: CREATORS }, creator));
  const all = [...admitted, ...refused];
  const p95 = pct(all, 95);
  console.log(JSON.stringify({
    mode: 'http', creators: CREATORS, perCreator: PER, admitted: summary(admitted), refused: summary(refused), all: summary(all),
    rateLimited: Object.fromEntries(Object.entries(rateLimited).map(([r, xs]) => [r, summary(xs)])),
    maxPerMin: maxPerMin || null, otherStatuses: other, budgetP95Ms: BUDGET_P95_MS, budgetMet: p95 !== null && p95 <= BUDGET_P95_MS,
  }));
}

if (values.pg) await pgMode(values.pg);
else if (values.http) await httpMode(values.http);
else { console.error('pass --pg <dsn> or --http <base>'); process.exit(2); }

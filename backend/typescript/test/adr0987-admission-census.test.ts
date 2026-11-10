/**
 * ADR 0987 P0 — the run-admission lane census, and the ">60 s slot loss" reproduced.
 *
 * WHY. ADR 0987 decides that every run-creating lane passes one admission function
 * (D3) and that concurrency is counted from run state, not a per-process map (D2).
 * Before that work starts, this file pins what is true today, so P2 can turn each pin
 * into a ratchet and a reviewer can see exactly which lanes moved:
 *
 *   - `runQuotaMiddleware` (per-day + concurrency) is mounted on 6 routes in 4 files;
 *   - `reserveConcurrentSlot` is also called by creative-briefs, which mounts NO
 *     middleware, so it is a no-op there (it returns early without a session key);
 *   - `reservePlanRun` (monthly plan) has exactly one caller, `host/runStarter.ts`;
 *   - `insertRunWithStartContext` is called from 18 files (19 since ADR 1042: the
 *     channel-ingress conversation run, charged like any run — see the admission-lanes test);
 *   - `startWorkflowRun` has 37 code call sites in 30 files (39 / 32 until the KickTodo
 *     packages left, ADR 1031 P3). ADR 0987's context
 *     table says 43 in 34: that raw grep also matched 5 mentions in comments.
 *     (39 since ADR 0957 D2: `startClientReportRun` in campaign-ops/runLauncher.ts
 *     is the client-report "run now" lane, the third launcher in that file. It goes
 *     through the same `startWorkflowRun`, so it takes the same monthly check.)
 *
 * CORRECTED 2026-11-03 (grade-tests w80): the bullets above are the P0 snapshot,
 * kept for the trail. The pins below are as of P2: runQuotaMiddleware is mounted
 * on 7 routes in 5 files (creative-briefs now mounts it), reserveConcurrentSlot is
 * deleted, and reservePlanRun's one caller is `host/runInsert.ts` (not
 * `host/runStarter.ts`).
 *
 * Counts read code lines only (a line starting with `//`, `*` or `/*` is skipped).
 * Known blind spot (human ask, not changed here): a call written on a line that
 * starts with `*` (for example a wrapped multiplication or a JSDoc-looking
 * continuation) is not counted. No current call site is affected.
 *
 * Sabotage witnesses (probes w80g3-cen-*, 2026-11-03; each reds only its case):
 * removing creative-briefs' mount; reintroducing a `sessionInflightRuns` symbol;
 * a second `reservePlanRun(` caller; dropping one insert call site; one fewer
 * `startWorkflowRun(` site.
 *
 * P0 also reproduced the ">60 s slot loss" here, on `runQuotaMiddleware` alone. P1
 * moved `/runs` to admission counted inside the run insert, which the middleware
 * alone cannot show, so that case now lives on the real app in
 * `adr0987-admission-insert.test.ts` (five runs still running at 61 s still hold
 * their slots).
 *
 * P1 changed one pin: `/runs` counted its concurrency in the store. P2 moves the
 * rest: every mount passes its scope to the insert, the per-process map, its 60 s
 * filter and `reserveConcurrentSlot` are deleted, creative-briefs mounts the
 * middleware, and the monthly plan is charged at the insert seam. The per-lane
 * policy table (charge or a named exemption) is the T4 ratchet in
 * `adr0987-p2-admission-lanes.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'src');
// (callSites skips a line matching its `definition` argument; /^$/ skips nothing.)

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) out.push(p);
  }
  return out;
}
// ADR 1031 P3 — FIRST-PARTY sites only: `src/adopter/` (an adopter's own features,
// present only in its tree) is left out, so these exact pins hold in openwop-app AND
// in every adopter's tree. An adopter's call to `startWorkflowRun` takes the same
// admission checks: they live inside the function, which is the point of the census.
const FILES = tsFiles(SRC)
  .map((p) => ({ rel: relative(SRC, p), lines: readFileSync(p, 'utf8').split('\n') }))
  .filter((f) => !f.rel.startsWith('adopter/') && !f.rel.startsWith('adopter\\'));

/** Code lines matching `re` (not comment lines, not the definition), by file. */
function callSites(re: RegExp, definition: RegExp): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of FILES) {
    for (const line of f.lines) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      if (definition.test(line) || !re.test(line)) continue;
      out.set(f.rel, (out.get(f.rel) ?? 0) + 1);
    }
  }
  return out;
}
const total = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);

describe('ADR 0987 — the run-admission lane census (as of P2)', () => {
  it('runQuotaMiddleware (per-minute, per-day and the concurrency scope) is mounted on 7 routes in 5 files', () => {
    const m = callSites(/runQuotaMiddleware\(/, /export function runQuotaMiddleware/);
    expect(Object.fromEntries(m)).toEqual({
      'features/creative-briefs/routes.ts': 1, // P2: the reel lane had no mount, so its slot was a no-op
      'features/workflow-author/routes.ts': 1,
      'routes/runs.ts': 2,
      'routes/workflowDebug.ts': 2,
      'routes/workflowEvals.ts': 1,
    });
  });

  it('P2: the per-process slot map, its 60 s filter and reserveConcurrentSlot are gone from src', () => {
    for (const re of [/reserveConcurrentSlot\(/, /sessionInflightRuns/, /concurrencyInStore/, /startedAtMs < 60_000/]) {
      expect(Object.fromEntries(callSites(re, /^$/)), String(re)).toEqual({});
    }
  });

  it('P2: the monthly plan check (reservePlanRun) has exactly one caller, the run-insert seam', () => {
    expect(Object.fromEntries(callSites(/reservePlanRun\(/, /export async function reservePlanRun/))).toEqual({ 'host/runInsert.ts': 1 });
  });

  it('insertRunWithStartContext is called from these 19 files', () => {
    const m = callSites(/insertRunWithStartContext\(/, /export async function insertRunWithStartContext/);
    expect([...m.keys()].sort()).toEqual([
      'executor/subWorkflowDispatcher.ts',
      'features/channel-ingress/ingress.ts', // ADR 1042 D7 — the channel conversation run (charged)
      'features/creative-briefs/routes.ts',
      'features/workflow-author/routes.ts',
      'host/canvasSurface.ts',
      'host/evals/createEvalRun.ts',
      'host/kanbanTriggerDelivery.ts',
      'host/mcpSemantics.ts',
      'host/runStarter.ts',
      'host/triggerIngestionService.ts',
      'host/workflowEvalRunner.ts',
      'host/workforceService.ts',
      'routes/artifactTypeSeam.ts',
      'routes/compensationSeam.ts',
      'routes/durabilitySeam.ts',
      'routes/effectSeamFireSeam.ts',
      'routes/runs.ts',
      'routes/triggerBridge.ts',
      'routes/workflowDebug.ts',
    ]);
  });

  it('startWorkflowRun has 37 code call sites in 30 files (the monthly check, no per-day or concurrency check)', () => {
    const m = callSites(/startWorkflowRun\(/, /export async function startWorkflowRun/);
    // 39 / 32 until the KickTodo packages left (ADR 1031 P3).
    expect({ sites: total(m), files: m.size }).toEqual({ sites: 37, files: 30 });
  });
});

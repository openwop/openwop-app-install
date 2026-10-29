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
 *   - `insertRunWithStartContext` is called from 18 files;
 *   - `startWorkflowRun` has 39 code call sites in 32 files. ADR 0987's context
 *     table says 43 in 34: that raw grep also matched 5 mentions in comments.
 *     (39 since ADR 0957 D2: `startClientReportRun` in campaign-ops/runLauncher.ts
 *     is the client-report "run now" lane, the third launcher in that file. It goes
 *     through the same `startWorkflowRun`, so it takes the same monthly check.)
 *
 * Counts read code lines only (a line starting with `//`, `*` or `/*` is skipped).
 *
 * P0 also reproduced the ">60 s slot loss" here, on `runQuotaMiddleware` alone. P1
 * moved `/runs` to admission counted inside the run insert, which the middleware
 * alone cannot show, so that case now lives on the real app in
 * `adr0987-admission-insert.test.ts` (five runs still running at 61 s still hold
 * their slots).
 *
 * P1 changes one pin: `/runs` mounts `runQuotaMiddleware({ concurrencyInStore: true })`
 * (its concurrency is counted in the store), and the other five mounts keep the
 * per-process map until P2.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'src');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) out.push(p);
  }
  return out;
}
const FILES = tsFiles(SRC).map((p) => ({ rel: relative(SRC, p), lines: readFileSync(p, 'utf8').split('\n') }));

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

describe('ADR 0987 P0 — the run-admission lane census (as of P0)', () => {
  it('runQuotaMiddleware (per-day + concurrency) is mounted on 6 routes in 4 files', () => {
    const m = callSites(/runQuotaMiddleware\(/, /export function runQuotaMiddleware/);
    expect(Object.fromEntries(m)).toEqual({
      'features/workflow-author/routes.ts': 1,
      'routes/runs.ts': 2,
      'routes/workflowDebug.ts': 2,
      'routes/workflowEvals.ts': 1,
    });
  });

  it('only POST /runs counts concurrency in the store (P1); the other five mounts keep the per-process map', () => {
    expect(Object.fromEntries(callSites(/runQuotaMiddleware\(\{ concurrencyInStore: true \}\)/, /export function runQuotaMiddleware/))).toEqual({ 'routes/runs.ts': 1 });
  });

  it('creative-briefs reserves a concurrency slot without the middleware, so the reservation is a no-op there', () => {
    const slots = callSites(/reserveConcurrentSlot\(/, /export function reserveConcurrentSlot/);
    expect(slots.get('features/creative-briefs/routes.ts')).toBe(1);
    const mounts = callSites(/runQuotaMiddleware\(/, /export function runQuotaMiddleware/);
    expect(mounts.has('features/creative-briefs/routes.ts')).toBe(false);
  });

  it('the monthly plan check (reservePlanRun) has exactly one caller: host/runStarter.ts', () => {
    expect(Object.fromEntries(callSites(/reservePlanRun\(/, /export async function reservePlanRun/))).toEqual({ 'host/runStarter.ts': 1 });
  });

  it('insertRunWithStartContext is called from these 18 files', () => {
    const m = callSites(/insertRunWithStartContext\(/, /export async function insertRunWithStartContext/);
    expect([...m.keys()].sort()).toEqual([
      'executor/subWorkflowDispatcher.ts',
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

  it('startWorkflowRun has 39 code call sites in 32 files (the monthly check, no per-day or concurrency check)', () => {
    const m = callSites(/startWorkflowRun\(/, /export async function startWorkflowRun/);
    expect({ sites: total(m), files: m.size }).toEqual({ sites: 39, files: 32 });
  });
});

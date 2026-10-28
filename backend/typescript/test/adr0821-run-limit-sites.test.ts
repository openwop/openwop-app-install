/**
 * ADR 0821 D6 / P5 follow-up — every run-minting site that does NOT go through
 * `host/runStarter.ts` `startWorkflowRun` reserves through the ONE run-limit
 * seam (`host/runLimitSeam.ts` `withRunLimit`). The inventory below is the
 * P5 "first task": each `insertRunWithStartContext(` site in `src/**` is either
 * wrapped (WRAPPED) or excluded with a reason (EXCLUDED). A new minting site
 * fails until it is classified.
 *
 * `runStarter.ts` must NOT call the seam: ADR 0821 P5 (workstream E) calls the
 * limit directly there, so a seam call would count every starter run twice.
 *
 * EXCLUDED is checked both ways: an excluded file that no longer mints is a
 * stale exclusion and fails, so it cannot later admit an unwrapped insert.
 *
 * Tracker TST-BUL-9. Sabotage-witnessed (w62): red when a wrapped insert is
 * unwrapped, an unclassified minting site appears, or runStarter calls the seam.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

/** file → number of `insertRunWithStartContext(` calls wrapped in `withRunLimit(`. */
const WRAPPED: Record<string, number> = {
  'routes/runs.ts': 2, // POST /v1/runs (v1 + v2, one handler) and :fork
  'routes/workflowDebug.ts': 2, // debug run and redrive
  'host/triggerIngestionService.ts': 1,
  'host/kanbanTriggerDelivery.ts': 1,
  'host/mcpSemantics.ts': 1,
  'features/workflow-author/routes.ts': 1,
  'features/creative-briefs/routes.ts': 1,
  'host/evals/createEvalRun.ts': 1, // ADR 0889 — POST /runs {mode:"eval"}: a real run, under the same limit
};

const EXCLUDED: Record<string, string> = {
  'host/runStarter.ts': 'ADR 0821 P5 enforces the limit directly inside startWorkflowRun (workstream E)',
  'host/runInsert.ts': 'the insert seam itself',
  'executor/subWorkflowDispatcher.ts': 'a core.subWorkflow child is one unit of work with its parent',
  'host/workflowEvalRunner.ts': 'eval runs (an owner-gated test of a definition), not production runs',
  'host/workforceService.ts': 'seeds historical records for host-defined workforces; executes nothing (ADR 0823)',
  'host/canvasSurface.ts': 'cross-canvas invoke — known residual, owned outside this workstream',
  'routes/triggerBridge.ts': 'the conformance seam twin of trigger ingest (deliverSeamRun)',
  'routes/durabilitySeam.ts': 'test seam',
  'routes/artifactTypeSeam.ts': 'conformance seam',
  'routes/effectSeamFireSeam.ts': 'conformance seam',
  'routes/compensationSeam.ts': 'conformance seam',
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__') out.push(...walk(p)); }
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('ADR 0821 P5 follow-up — run-limit seam coverage of the run-minting sites', () => {
  const sites: Record<string, { calls: number; wrapped: number; seam: number }> = {};
  for (const file of walk(SRC)) {
    const src = strip(readFileSync(file, 'utf8'));
    const calls = (src.match(/\binsertRunWithStartContext\s*\(/g) ?? []).length - (src.match(/export async function insertRunWithStartContext\s*\(/g) ?? []).length;
    const wrapped = (src.match(/withRunLimit\([^,]+,\s*\(\)\s*=>\s*insertRunWithStartContext\(/g) ?? []).length;
    const seam = (src.match(/\b(?:withRunLimit|reserveRunLimit)\s*\(/g) ?? []).length;
    if (calls > 0 || seam > 0) sites[relative(SRC, file)] = { calls, wrapped, seam };
  }

  it('every wrapped site wraps exactly the inventoried inserts', () => {
    for (const [file, n] of Object.entries(WRAPPED)) {
      expect(sites[file]?.wrapped, `${file} must wrap ${n} insert(s) in withRunLimit`).toBe(n);
    }
  });

  it('every minting site is classified (wrapped in full, or excluded with a reason)', () => {
    const unclassified = Object.entries(sites)
      .filter(([f, s]) => s.calls > 0 && !EXCLUDED[f] && (WRAPPED[f] ?? 0) !== s.calls)
      .map(([f, s]) => `${f}: ${s.calls} insertRunWithStartContext call(s), ${s.wrapped} wrapped`);
    expect(unclassified).toEqual([]);
    // Shrink-only hygiene: every exclusion still names a live minting site.
    // `host/runInsert.ts` DECLARES the insert (its count nets the declaration out), so it is exempt.
    const staleExclusions = Object.keys(EXCLUDED).filter((f) => f !== 'host/runInsert.ts' && (sites[f]?.calls ?? 0) === 0);
    expect(staleExclusions).toEqual([]);
  });

  it('runStarter does NOT call the seam (it would double-count with ADR 0821 P5)', () => {
    expect(sites['host/runStarter.ts']?.seam ?? 0).toBe(0);
  });
});

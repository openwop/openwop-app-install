/**
 * ADR 0823 D7 — a new launcher cannot skip the ownership predicate.
 *
 * The hole ADR 0823 closed was a set of launchers that each turned a caller-chosen
 * workflow id into an executing definition through the untenanted catalog. The fix
 * moved the check into the funnel (`resolveTenantWorkflow` / `resolveLaunchWorkflow`
 * / `resolveRunDefinition`). That only holds while nothing reads the catalog
 * around the funnel, and while every run-minting site has been classified.
 *
 * Three pinned inventories, each entry a per-file call COUNT plus the reason it is safe:
 *  1. direct `catalog.getWorkflow(` reads outside the funnel;
 *  2. run-minting calls (`insertRunWithStartContext(` / `.insertRun(`);
 *  3. `executeRun(` calls, which also covers re-executing an existing run.
 *
 * A NEW entry in either fails here. Route it through the funnel, or classify it in
 * the ADR 0823 launch-site table and add it below with its reason. Shrinking is
 * fine (delete the entry), and REQUIRED: the check is two-sided, so a pinned file
 * whose count fell is a stale pin and fails until its entry is removed. (A stale
 * `features/crm/routes.ts` pin, left when CRM moved to startWorkflowRun in
 * 18c501897, silently admitted a re-added minting call — w62 probe.)
 *
 * Tracker TST-BLO-1. Sabotage-witnessed (w62): red when a launcher reads the
 * catalog directly, a fixed-id entry takes a caller id, a run-minting or
 * executeRun call is added (including in a file whose pin went stale), the
 * funnel stops asking isWorkflowForeignTo, or :fork stops re-authorizing.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = 'src';

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...tsFiles(p));
    } else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** Source with comments stripped, so prose that NAMES a call never counts. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const FILES = tsFiles(SRC).map((f) => ({ rel: relative(SRC, f), src: code(f) }));

/** file → [pinned call count, why it is safe]. Counts, not just files: a second
 *  read added to an already-allowlisted file must be re-justified too. */
const DIRECT_CATALOG_READS: Record<string, [number, string]> = {
  'host/resolveLaunchDefinition.ts': [1, 'IS the funnel — the read is paired with isWorkflowForeignTo'],
  'host/resolveRunDefinition.ts': [1, 'isWorkflowForeignTo(run.tenantId, …) runs before the read (D3)'],
  'routes/workflows.ts': [2, 'IS the M7 read guard — isForeignOwned before the definition is returned; the ADR 0870 availability read applies the same isForeignOwned and returns only demo/runnable flags'],
  'features/kicktodo-creator/routes.ts': [1, 'isForeignOwned is checked before the read'],
  'features/workflow-author/routes.ts': [1, 'fixed host id (WORKFLOW_AUTHOR_META_ID)'],
  'features/creative-briefs/routes.ts': [1, 'fixed host id (CREATIVE_BRIEFS_REEL_ID)'],
  // ADR 0903 D7 — agentTools.ts no longer reads the Challenge Factory definition
  // (it read the chain's pinned AI defaults, which are gone), so its entry shrank away.
  'host/workflowComposeTool.ts': [1, 'id-COLLISION check on a draft being composed; executes nothing (row 16 author lane)'],
};

/** Entries whose reason is "fixed host id": the argument must be an UPPER_CASE constant. */
const FIXED_ID_FILES = [
  'features/workflow-author/routes.ts',
  'features/creative-briefs/routes.ts',
];

/** file → [pinned call count, how the definition it runs is resolved]. */
const RUN_MINTERS: Record<string, [number, string]> = {
  'host/runInsert.ts': [2, 'the insert seam itself'],
  'routes/runs.ts': [2, 'run-create → resolveLaunchWorkflow; :fork → resolveRunDefinition'],
  'host/runStarter.ts': [1, 'resolveLaunchWorkflow (schedules, agents, host events, webhooks, kanban, approvals)'],
  'executor/subWorkflowDispatcher.ts': [1, 'resolveLaunchWorkflow (core.subWorkflow)'],
  'host/kanbanTriggerDelivery.ts': [1, 'resolveLaunchWorkflow'],
  'host/triggerIngestionService.ts': [1, 'resolveLaunchWorkflow'],
  'routes/triggerBridge.ts': [1, 'resolveLaunchWorkflow'],
  'host/mcpSemantics.ts': [1, 'resolveLaunchWorkflow (via mcpCaller)'],
  'routes/durabilitySeam.ts': [1, 'resolveLaunchWorkflow (test seam)'],
  'routes/workflowDebug.ts': [2, 'debug-run: owner-gated loadOwnedHead; redrive: resolveRunDefinition'],
  'host/canvasSurface.ts': [1, 'injected getWorkflow = resolveTenantWorkflow (index.ts)'],
  'host/workflowEvalRunner.ts': [1, 'its only caller passes the owner-gated loadOwnedHead definition'],
  'features/workflow-author/routes.ts': [1, 'fixed host id (WORKFLOW_AUTHOR_META_ID)'],
  'features/creative-briefs/routes.ts': [1, 'fixed host id (CREATIVE_BRIEFS_REEL_ID)'],
  'host/workforceService.ts': [1, 'seeds historical records for host-defined workforces; executes nothing'],
  'host/workforceEval.ts': [1, 'eval record under the fixed EVAL_SUITE_ID; executes no workflow definition'],
  'host/anonymousActor.ts': [1, 'synthetic anon-surface run, no workflow definition'],
  'host/evals/createEvalRun.ts': [1, 'ADR 0889 eval run under the synthetic eval:<suite> workflowId; drives an agent resolved by resolveAgentForTenant, executes no workflow definition'],
  'routes/artifactTypeSeam.ts': [1, 'test seam with its own inline definition'],
  'routes/compensationSeam.ts': [2, 'test seam with its own inline definition'],
  'routes/effectSeamFireSeam.ts': [1, 'test seam with its own inline definition'],
  'routes/anonSurfaceSeam.ts': [1, 'test seam'],
  'routes/effectTransportRetrySeam.ts': [1, 'test seam'],
  'routes/eventLogSeedSeam.ts': [1, 'test seam'],
  'routes/testSeam.ts': [1, 'test seam'],
  'routes/negotiationAuditRun.ts': [1, 'test seam (ADR 0858 P4): plants a completed negotiation-audit run that never executes'],
};

/** file → [pinned call count, where the executed definition comes from]. Covers the
 *  re-execution of an EXISTING run (resume, sweeper), which mints nothing. */
const EXECUTORS: Record<string, [number, string]> = {
  'executor/executor.ts': [1, 'the declaration'],
  'host/runDispatch.ts': [1, 'executes the definition its caller resolved (one of the classified minters)'],
  'routes/runs.ts': [2, 'run-create → resolveLaunchWorkflow; :fork/resume → resolveRunDefinition'],
  'routes/interrupts.ts': [1, 'resolveRunDefinition (interrupt resume)'],
  'host/runDispatchSweeper.ts': [2, 'resolveRunDefinition (both sweeps)'],
  'executor/subWorkflowDispatcher.ts': [1, 'resolveLaunchWorkflow'],
  'host/runStarter.ts': [1, 'resolveLaunchWorkflow'],
  'host/kanbanTriggerDelivery.ts': [1, 'resolveLaunchWorkflow'],
  'host/triggerIngestionService.ts': [1, 'resolveLaunchWorkflow'],
  'routes/triggerBridge.ts': [1, 'resolveLaunchWorkflow'],
  'host/mcpSemantics.ts': [1, 'resolveLaunchWorkflow'],
  'routes/durabilitySeam.ts': [1, 'resolveLaunchWorkflow (test seam)'],
  'routes/workflowDebug.ts': [1, 'owner-gated loadOwnedHead / resolveRunDefinition'],
  'host/canvasSurface.ts': [2, 'resolveTenantWorkflow (injected)'],
  'host/workflowEvalRunner.ts': [2, 'owner-gated loadOwnedHead definition'],
  'routes/compensationSeam.ts': [2, 'test seam with its own inline definition'],
};

function countsOf(re: RegExp, skip: (rel: string) => boolean = () => false): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of FILES) {
    if (skip(f.rel)) continue;
    const n = (f.src.match(re) ?? []).length;
    if (n > 0) out[f.rel] = n;
  }
  return out;
}

function expectPinned(found: Record<string, number>, pinned: Record<string, [number, string]>, hint: string): void {
  const drift = Object.entries(found)
    .filter(([rel, n]) => pinned[rel]?.[0] !== n)
    .map(([rel, n]) => `${rel}: ${n} call(s), pinned ${pinned[rel]?.[0] ?? 'none'}`);
  expect(drift, hint).toEqual([]);
  // Two-sided: a pin whose file no longer has that many calls is stale — delete it.
  const stale = Object.entries(pinned)
    .filter(([rel, [n]]) => found[rel] !== n)
    .map(([rel, [n]]) => `${rel}: pinned ${n}, found ${found[rel] ?? 0} (stale pin — shrink the entry)`);
  expect(stale).toEqual([]);
}

describe('ADR 0823 D7 — launch-ownership ratchet', () => {
  it('no direct catalog read outside the classified set (per-file counts)', () => {
    const found = countsOf(/\b(?:workflowCatalog|catalog)\s*\??\.\s*getWorkflow\s*\(/g);
    // Non-vacuity: the probe must see the funnel it protects.
    expect(found['host/resolveLaunchDefinition.ts']).toBe(1);
    expectPinned(found, DIRECT_CATALOG_READS, 'route these through resolveTenantWorkflow/resolveLaunchWorkflow, or classify them in ADR 0823');
  });

  it('a "fixed host id" entry really passes a constant, not a caller-chosen id', () => {
    for (const rel of FIXED_ID_FILES) {
      const src = FILES.find((f) => f.rel === rel)?.src ?? '';
      const args = [...src.matchAll(/\bworkflowCatalog\s*\.\s*getWorkflow\s*\(\s*([^)]*)\)/g)].map((m) => m[1]!.trim());
      expect(args.length, rel).toBeGreaterThan(0);
      for (const a of args) expect(a, rel).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('every run-minting call is classified (per-file counts)', () => {
    const found = countsOf(/\binsertRunWithStartContext\s*\(|\.insertRun\s*\(/g, (rel) => rel.startsWith('storage/'));
    expect(found['routes/runs.ts']).toBe(2);
    expectPinned(found, RUN_MINTERS, 'a new run-minting site: resolve its definition through the ADR 0823 funnel, then classify it here');
  });

  it('every executeRun call is classified (per-file counts) — re-execution of an existing run included', () => {
    const found = countsOf(/\bexecuteRun\s*\(/g);
    expect(found['routes/interrupts.ts']).toBe(1);
    expectPinned(found, EXECUTORS, 'a new executeRun site: its definition must come from the ADR 0823 funnel or resolveRunDefinition');
  });

  it('the launch funnel and resolveRunDefinition both ask the ONE predicate', () => {
    const funnel = FILES.find((f) => f.rel === 'host/resolveLaunchDefinition.ts')!.src;
    const rerun = FILES.find((f) => f.rel === 'host/resolveRunDefinition.ts')!.src;
    const readGuard = FILES.find((f) => f.rel === 'routes/workflows.ts')!.src;
    expect(funnel).toMatch(/isWorkflowForeignTo\(tenantId, workflowId\)/);
    expect(rerun).toMatch(/isWorkflowForeignTo\(run\.tenantId, run\.workflowId\)/);
    expect(readGuard).toMatch(/return isWorkflowForeignTo\(tenantId, workflowId\)/);
    // resolveLaunchWorkflow must go through resolveTenantWorkflow, not the raw catalog.
    const launchBody = funnel.slice(funnel.indexOf('export async function resolveLaunchWorkflow'));
    expect(launchBody).toMatch(/await resolveTenantWorkflow\(catalog, tenantId, workflowId, \{ operator: opts\.operator \}\)/);
    expect(launchBody).not.toMatch(/catalog\.getWorkflow\(/);
  });

  it('the run-MINTING relaunch lanes (:fork, redrive) re-authorize; continuations do not', () => {
    const runs = FILES.find((f) => f.rel === 'routes/runs.ts')!.src;
    const debug = FILES.find((f) => f.rel === 'routes/workflowDebug.ts')!.src;
    expect(runs).toMatch(/resolveRunDefinition\(forkedRun, hostSuite\.workflowCatalog, \{\s*relaunch:/);
    expect(debug).toMatch(/resolveRunDefinition\(source, deps\.hostSuite\.workflowCatalog, \{\s*relaunch:/);
  });
});

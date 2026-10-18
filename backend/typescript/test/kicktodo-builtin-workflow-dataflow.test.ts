/**
 * KTFULL-B4/B5 — the built-in workflows are DATAFLOW-COMPLETE and the daily
 * continuation is actually armed.
 *
 * The audit found the definitions referenced variables while declaring none —
 * and `seedRunVariables` iterates `variableDecls ?? []`, so every input
 * resolved to `undefined` and neither workflow could run. It also found
 * `armContinuation` had no production caller, so the "daily loop" was a
 * definition nobody fired. No execution-level test existed for either.
 *
 * These assert the CONTRACT between definitions, the seeding runtime and the
 * nodes, rather than re-testing the services underneath.
 *
 * Sabotages that turn these red (w41 probes): removing a variable declaration
 * a node reads, the enroll node's `variables.set('enrollmentId', …)`, or the
 * enrollment chain's `challengeVersion` default; the daily-loop case reds if its
 * reads drift from the `{ enrollmentId, ownerSubject }` the enrollment arms
 * (`enrollmentService.ts` armContinuation inputs).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { seedRunVariables, snapshotRunVariables, setRunVariable } from '../src/host/variablesRuntime.js';
import { kicktodoBuiltinWorkflows, buildKicktodoLoopWorkflow } from '../src/features/kicktodo-core/builtinWorkflows.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';

// ADR 0472 P4 — enrollment/daily-loop/reminder-loop migrated to chain packs; build the
// MIGRATED defs (kicktodoBuiltinWorkflows now holds only the participant-replan builtin).
_resetChainRegistryForTest();
loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
import { kicktodoCreatorBuiltinWorkflows } from '../src/features/kicktodo-creator/builtinWorkflows.js';

const ALL = [...kicktodoBuiltinWorkflows, ...kicktodoCreatorBuiltinWorkflows];

/** Every `{type:'variable', variableName}` a definition references. */
function referencedVariables(wf: (typeof ALL)[number]): string[] {
  const names = new Set<string>();
  for (const node of wf.nodes) {
    for (const value of Object.values(node.inputs ?? {})) {
      if (value && typeof value === 'object' && 'type' in value && value.type === 'variable'
        && 'variableName' in value && typeof value.variableName === 'string' && value.variableName) {
        names.add(value.variableName);
      }
    }
  }
  return [...names];
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('every referenced variable is DECLARED (KTFULL-B4)', () => {
  it.each(ALL.map((w) => [w.workflowId, w] as const))('%s declares everything it reads', (_id, wf) => {
    const declared = new Set((wf.variables ?? []).map((v) => v.name));
    const referenced = referencedVariables(wf);
    expect(referenced.length, 'the workflow should reference at least one variable').toBeGreaterThan(0);
    for (const name of referenced) {
      expect(declared.has(name), `\`${name}\` is read but not declared — seedRunVariables would leave it undefined`).toBe(true);
    }
  });
});

describe('the seeding runtime actually populates those inputs (KTFULL-B4)', () => {
  it('enrollment: caller inputs seed, and the enroll step can publish enrollmentId downstream', () => {
    const wf = buildKicktodoLoopWorkflow('openwop-app.kicktodo.enrollment');
    const runId = 'run-enroll-1';
    seedRunVariables(runId, wf.variables, {
      ownerSubject: 'user:p1', challengeId: 'chal:x', timezone: 'UTC',
    });
    const seeded = snapshotRunVariables(runId)!;
    expect(seeded.ownerSubject).toBe('user:p1');
    expect(seeded.challengeId).toBe('chal:x');
    expect(seeded.timezone).toBe('UTC');
    // Declared default applied. DOUBLE GUARD: the default lives in the chain
    // pack's parameters (`examples/workflow-chain-packs/kicktodo-loops/pack.json`,
    // `challengeVersion.default: 1`) AND in `KICKTODO_LOOP_DEFAULTS`
    // (builtinWorkflows.ts), which only fills it when expansion dropped it — so
    // this case witnesses the pack default; the host fallback is not reached here
    // (w41g4-dfw-default was vacuous for exactly that reason).
    expect(seeded.challengeVersion).toBe(1);

    // `enrollmentId` is declared with no default precisely so the enroll node
    // can write it; before the fix it was undeclared and unwritable.
    expect('enrollmentId' in seeded).toBe(false);
    setRunVariable(runId, 'enrollmentId', 'enr:abc');
    expect(snapshotRunVariables(runId)!.enrollmentId).toBe('enr:abc');
  });

  // NOTE: the `plan-generation` dataflow assertion moved to
  // `workflow-chain-plan-generation-migration.test.ts` — that workflow migrated from
  // this deprecated builtin array to an RFC 0133 chain pack (produced-variable `plan`).
});

describe('the nodes publish what the next step reads (KTFULL-B4)', () => {
  const packUrl = new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href;

  it('enroll writes enrollmentId into the run bag', async () => {
    const m: { nodes: Record<string, (c: Record<string, unknown>) => Promise<unknown>> } = await import(packUrl);
    const written: Record<string, unknown> = {};
    await m.nodes['feature.kicktodo.nodes.enroll']!({
      inputs: { ownerSubject: 'user:p', challengeId: 'chal:x' },
      variables: { get: () => undefined, set: (n: string, v: unknown) => { written[n] = v; } },
      features: { 'kicktodo-core': { enroll: async () => ({ enrollment: { id: 'enr:123' } }) } },
    });
    expect(written.enrollmentId).toBe('enr:123');
  });
});

describe('the daily continuation is armed at enrollment (KTFULL-B5)', () => {
  it('the daily-loop the enrollment arms exists, is dataflow-complete, and reads exactly the inputs the arm seeds', () => {
    const daily = buildKicktodoLoopWorkflow('openwop-app.kicktodo.daily-loop');
    expect(daily, 'armContinuation targets this id — it must exist').toBeTruthy();
    const declared = new Set((daily.variables ?? []).map((v) => v.name));
    const referenced = referencedVariables(daily);
    // `armContinuation` (enrollmentService.ts) seeds exactly these two inputs; a
    // read outside them runs every scheduled fire against `undefined`. Asserted
    // as a set so an expansion that stopped producing variable refs (zero reads)
    // is red, not a vacuous empty loop.
    expect([...referenced].sort()).toEqual(['enrollmentId', 'ownerSubject']);
    for (const name of referenced) expect(declared.has(name)).toBe(true);
  });
});

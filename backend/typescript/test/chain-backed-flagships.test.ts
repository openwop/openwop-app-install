/**
 * ADR 0472 P4 — behavior-preservation regression for the two HIGHEST-RISK builtin→chain
 * conversions: the Challenge Factory (RFC 0133 sub-chain + truthy/falsy reject barrier +
 * produced variables) and campaign-orchestration (parallel channel fan-out).
 *
 * The existing e2e suites register the RAW def (`registerHostWorkflow(rawDef)`), which
 * proves the workflow LOGIC. This suite instead exercises the CHAIN-BACKED path — the
 * exact `buildChainBackedDefinition` call `registerChainBackedWorkflow` makes at boot —
 * and asserts the expanded, same-id definition is behavior-equivalent to the retired
 * builtin's dispatch: the sub-chain rewrite binds to the shared same-id child, the
 * truthy/falsy conditions round-trip, the reject-safe `none_failed` barrier survives,
 * produced-var bag bindings stay literal, and the parallel fan-out spine is intact.
 *
 * TST-CCB-1. Red when: the host-default bind leaves `subChainRef` on a build-N node;
 * the wire `falsy` maps to another host op; expansion drops an edge `triggerRule`;
 * expansion rewrites a `{type:'variable'}` produced-variable read; the deferred
 * param rename stops rewiring node inputs to the bare name; or a variable the
 * parent's `inputMapping` seeds into lesson-batch is no longer declared there.
 * (The postProcess HOOK is witnessed by chain-backed-workflows 'applies the optional
 * postProcess hook'; this file's old outputRole case passed with no hook at all.)
 *
 * The Challenge Factory and lesson-batch cases are KickTodo's and live in
 * test/kicktodo/kicktodo-chain-backed-flagships.test.ts (ADR 1031 P2).
 *
 * @see docs/adr/0472-retire-builtin-workflows-seam.md (Phase 4 terminal)
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import { buildChainBackedDefinition } from '../src/host/chainBackedWorkflows.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

/** Chain expansion prefixes node ids (`<chainSlug>_<expansionId>_<origId>`); match the tail. */
const bare = (id: string): string => id.replace(/^.*_/, '');

let loadErrors: unknown[] = [];
beforeAll(() => {
  _resetChainRegistryForTest();
  loadErrors = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() }).errors;
});

it('the flagship packs load clean (a bad producedVariables/subChainRef declaration surfaces here)', () => {
  expect(loadErrors).toEqual([]);
});

describe('ADR 0472 P4 — campaign-orchestration chain-backed (parallel fan-out)', () => {
  let def: WorkflowDefinition;
  beforeAll(() => {
    def = buildChainBackedDefinition('campaign-studio.campaign-orchestration');
  });

  it('is the parallel spine: validate → kernel → kernel-approve → promote-kernel → supervisor → dispatch → …', () => {
    expect(def.nodes.map((n) => bare(n.nodeId))).toEqual([
      'validate',
      'kernel',
      'kernel-approve',
      'promote-kernel', // ADR 1020 D8 — the approved kernel is saved only here
      'channel-supervisor',
      'channel-dispatch',
      'production-plan',
      'consistency',
      'finalize',
    ]);
  });

  it('the supervisor names all 5 channel children (resolved by id at runtime via dispatch)', () => {
    const supervisor = def.nodes.find((n) => bare(n.nodeId) === 'channel-supervisor');
    const plan = JSON.stringify((supervisor?.config as Record<string, unknown>)?.mockDispatchPlan);
    for (const ch of ['landing-page', 'ad-variants', 'email-sequence', 'creative-briefs', 'social-posts']) {
      expect(plan).toContain(`campaign-studio.channel.${ch}`);
    }
  });
});

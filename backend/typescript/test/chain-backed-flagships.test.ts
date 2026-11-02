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
 * @see docs/adr/0472-retire-builtin-workflows-seam.md (Phase 4 terminal)
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  getChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import { buildChainBackedDefinition } from '../src/host/chainBackedWorkflows.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

const LESSON_BATCH = 'openwop-app.kicktodo.lesson-batch';
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

describe('ADR 0472 P4 — Challenge Factory chain-backed behavior preservation', () => {
  let def: WorkflowDefinition;
  beforeAll(() => {
    def = buildChainBackedDefinition('openwop-app.kicktodo.challenge-factory');
  });

  it('build-0..3 sub-chain refs are rewritten to the SHARED same-id lesson-batch child', () => {
    const builds = def.nodes.filter((n) => /^build-\d$/.test(bare(n.nodeId)));
    expect(builds).toHaveLength(4);
    for (const b of builds) {
      const cfg = b.config as Record<string, unknown>;
      // The pre-migration builtin dispatched lesson-batch by this exact id — preserved.
      expect(cfg.workflowId).toBe(LESSON_BATCH);
      // The portable-pack ref must be fully consumed (no dangling subChainRef at runtime).
      expect(cfg.subChainRef).toBeUndefined();
    }
  });

  it('the truthy/falsy reject-safe barrier round-trips to host-native conditions (RFC 0134)', () => {
    const cond = (from: string, to: string) =>
      def.edges?.find((e) => bare(e.sourceNodeId) === from && bare(e.targetNodeId) === to)?.condition as
        | { path?: string; op?: string }
        | undefined;
    // APPROVED outline → validate (truthy); REJECTED outline → fail (falsy).
    expect(cond('outline-approve', 'plan-validate')).toEqual({ path: 'approved', op: 'truthy' });
    expect(cond('outline-approve', 'gate-reject')).toEqual({ path: 'approved', op: 'falsy' });
    // Each checkpoint gate's reject edge is falsy on `approved`.
    for (let n = 0; n < 4; n++) {
      expect(cond(`gate-${n}`, `fail-${n}`)).toEqual({ path: 'approved', op: 'falsy' });
    }
  });

  it('decompose depends on every fail-N via none_failed (the reject-safe barrier)', () => {
    const incoming = def.edges!.filter((e) => bare(e.targetNodeId) === 'decompose');
    const failEdges = incoming.filter((e) => bare(e.sourceNodeId).startsWith('fail-'));
    expect(failEdges).toHaveLength(4);
    expect(failEdges.every((e) => e.triggerRule === 'none_failed')).toBe(true);
  });

  it('produced variables stay LITERAL run-bag bindings (not frozen params)', () => {
    const artifact = def.nodes.find((n) => bare(n.nodeId) === 'outline-approve')?.inputs?.artifact;
    expect(artifact).toEqual({ type: 'variable', variableName: 'plan' }); // written by `generate`
    const task = def.nodes.find((n) => bare(n.nodeId) === 'sim-newcomer')?.inputs?.task;
    expect(task).toEqual({ type: 'variable', variableName: 'planBrief' }); // written by `checkpoint-plan`
  });

  it('dispatch-input params bind as runtime variables under the launch-contract name', () => {
    const topic = def.nodes.find((n) => bare(n.nodeId) === 'research-frame')?.inputs?.topic;
    expect(topic).toEqual({ type: 'variable', variableName: 'topic' });
  });
});

describe('ADR 0472 P4 — lesson-batch chain-backed (the sub-chain child)', () => {
  it('registers same-id with its dispatch-seeded inputs declared as variables', () => {
    const def = buildChainBackedDefinition(LESSON_BATCH);
    expect(def.workflowId).toBe(LESSON_BATCH);
    // The child receives candidateId/authorSubject/days/generateMedia from the parent's
    // core.subWorkflow inputMapping — they MUST be declared variables so the executor
    // seeds them into the child bag (the F3 concern, handled by deferred materialization).
    const names = new Set((def.variables ?? []).map((v) => v.name));
    // Read what the PARENT seeds (the build-0 dispatch node's inputMapping keys, plus
    // the value its outputMapping reads back) from the loaded factory chain itself —
    // the SSoT — rather than a hand-kept list that churns with every pack bump.
    const build0 = getChain('openwop-app.kicktodo.challenge-factory')!.chain.dag.nodes.find((n) => n.id === 'build-0')!;
    const cfg = build0.config as { inputMapping: Record<string, string>; outputMapping: Record<string, string> };
    const seeded = [...Object.keys(cfg.inputMapping), ...Object.values(cfg.outputMapping)];
    expect(seeded.length, 'fixture guard: build-0 seeds nothing').toBeGreaterThan(3);
    expect(seeded.filter((name) => !names.has(name)), 'seeded by the parent but not declared by the child').toEqual([]);
    expect(def.nodes[0]?.inputs?.days).toEqual({ type: 'variable', variableName: 'days' });
  });
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

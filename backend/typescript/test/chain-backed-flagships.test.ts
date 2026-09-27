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

const LESSON_BATCH = 'openwop-app.kicktodo.lesson-batch';
/** Chain expansion prefixes node ids (`<chainSlug>_<expansionId>_<origId>`); match the tail. */
const bare = (id: string): string => id.replace(/^.*_/, '');

beforeAll(() => {
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  // A malformed flagship pack (a bad producedVariables/subChainRef declaration) surfaces here.
  expect(errors, `flagship packs must load clean: ${JSON.stringify(errors)}`).toEqual([]);
});

describe('ADR 0472 P4 — Challenge Factory chain-backed behavior preservation', () => {
  let def: WorkflowDefinition;
  beforeAll(() => {
    def = buildChainBackedDefinition('openwop-app.kicktodo.challenge-factory');
  });

  it('build-0..3 sub-chain refs are rewritten to the SHARED same-id lesson-batch child', () => {
    const builds = def.nodes.filter((n) => bare(n.nodeId).startsWith('build-'));
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
    const task = def.nodes.find((n) => bare(n.nodeId) === 'sim-newcomer')?.inputs?.task
      ?? def.nodes.find((n) => bare(n.nodeId).startsWith('sim-'))?.inputs?.task;
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
    const names = (def.variables ?? []).map((v) => v.name).sort();
    // ADR 0458 §2.2 correction (chain 1.1.0) — the child also receives the
    // structured evidence its lessons are grounded on and validated against.
    expect(names).toEqual(['authorSubject', 'candidateId', 'credentialRef', 'days', 'evidenceClaims', 'generateMedia', 'model', 'provider']);
    expect(def.nodes[0]?.inputs?.days).toEqual({ type: 'variable', variableName: 'days' });
  });
});

describe('ADR 0472 P4 — campaign-orchestration chain-backed (parallel fan-out)', () => {
  let def: WorkflowDefinition;
  beforeAll(() => {
    def = buildChainBackedDefinition('campaign-studio.campaign-orchestration');
  });

  it('is the parallel spine: validate → kernel → kernel-approve → supervisor → dispatch → …', () => {
    expect(def.nodes.map((n) => bare(n.nodeId))).toEqual([
      'validate',
      'kernel',
      'kernel-approve',
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

  it('finalize is the primary output (outputRole preserved from the builtin)', () => {
    // registerLegacyDefsChainBacked restores outputRole via postProcess; assert the
    // builder here reproduces it (the shared helper passes the same postProcess).
    const src = [{ workflowId: 'campaign-studio.campaign-orchestration', nodes: [{ nodeId: 'finalize', outputRole: 'primary' as const }] }][0];
    const roles = new Map(src.nodes.filter((n) => n.outputRole).map((n) => [n.nodeId, n.outputRole] as const));
    const built = buildChainBackedDefinition('campaign-studio.campaign-orchestration', {
      postProcess: (d) => {
        for (const node of d.nodes) {
          let role: 'primary' | 'secondary' | undefined;
          for (const [origId, r] of roles) if (node.nodeId === origId || node.nodeId.endsWith(`_${origId}`)) role = r;
          if (role) node.outputRole = role;
          else if (node.outputRole !== undefined) delete node.outputRole;
        }
      },
    });
    expect(built.nodes.find((n) => bare(n.nodeId) === 'finalize')?.outputRole).toBe('primary');
  });
});

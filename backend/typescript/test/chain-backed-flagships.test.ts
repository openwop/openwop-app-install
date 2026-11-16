/**
 * ADR 0472 P4 — behavior-preservation regression for the chain-backed
 * campaign-orchestration flagship (parallel channel fan-out).
 *
 * The e2e suite (`chain-backed-flagship-e2e.test.ts`) runs the workflow; this suite
 * pins the CHAIN-BACKED DEFINITION itself — the exact `buildChainBackedDefinition`
 * call `registerChainBackedWorkflow` makes at boot — so a pack edit that rewires the
 * spine, drops a channel, or turns the fan-out sequential reds here by name instead
 * of as a distant e2e symptom.
 *
 * TST-CCB-1. Red when: a flagship chain pack stops loading clean; an edge of the
 * spine is rewired (e.g. the channels run off `kernel-approve`, skipping the ADR 1020
 * D8 `promote-kernel` save); expansion drops an edge's port binding (the
 * kernel → promote-kernel data edges); the supervisor stops naming exactly the five
 * channel children; or the dispatch stops fanning them out in parallel with a
 * result mapping for each (a non-parallel `fanOutPolicy` beside the pack's
 * `joinPolicy` is refused at EXPANSION by RFC 0118's cross-field rule, never at
 * load, so the cases build the definition themselves).
 * (The postProcess HOOK is witnessed by chain-backed-workflows 'applies the optional
 * postProcess hook'; this file's old outputRole case passed with no hook at all.)
 *
 * The Challenge Factory and lesson-batch cases were KickTodo's: ADR 1031 P2 split
 * them out and ADR 1031 P3 took them out of openwop-app with KickTodo itself.
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

/** Chain expansion prefixes node ids (`<chainSlug>_<expansionId>_<origId>`); match the tail. */
const bare = (id: string): string => id.replace(/^.*_/, '');

const CHANNELS = [
  'campaign-studio.channel.landing-page',
  'campaign-studio.channel.ad-variants',
  'campaign-studio.channel.email-sequence',
  'campaign-studio.channel.creative-briefs',
  'campaign-studio.channel.social-posts',
];

let loadErrors: unknown[] = [];
beforeAll(() => {
  _resetChainRegistryForTest();
  loadErrors = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() }).errors;
});

const FLAGSHIP = 'campaign-studio.campaign-orchestration';

it('the flagship packs load clean (a bad producedVariables/subChainRef declaration surfaces here)', () => {
  expect(loadErrors).toEqual([]);
  // An empty error list is also what a pack that registered NOTHING under these ids
  // returns (a renamed chainId loads clean): the flagship and its five children
  // must actually be registered.
  expect([FLAGSHIP, ...CHANNELS].filter((id) => getChain(id) === null), 'not registered after load').toEqual([]);
});

describe('ADR 0472 P4 — campaign-orchestration chain-backed (parallel fan-out)', () => {
  // Built INSIDE each case, never in a hook: expansion runs the shared
  // `validateWorkflowDefinition` (RFC 0118 cross-field MUSTs etc.), and a throw in
  // a beforeAll SKIPS the cases instead of failing them by name (w114 round 1:
  // `cbf-sequential`, `cbf-unloadable` read vacuous exactly that way).
  const flagship = (): WorkflowDefinition => buildChainBackedDefinition(FLAGSHIP);

  it('is the parallel spine: validate → kernel → kernel-approve → promote-kernel → supervisor → dispatch → …', () => {
    const def = flagship();
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
    // The spine is the EDGES (the scheduler never reads node order): every hop,
    // with the port bindings that carry the kernel into promote-kernel.
    const port = (p: string | undefined): string => (p ? `.${p}` : '');
    expect((def.edges ?? []).map((e) => `${bare(e.sourceNodeId)}${port(e.sourceOutput)} → ${bare(e.targetNodeId)}${port(e.targetInput)}`)).toEqual([
      'validate → kernel',
      'kernel → kernel-approve',
      'kernel-approve → promote-kernel',
      'kernel.kernel → promote-kernel.kernel',
      'kernel.briefVersion → promote-kernel.briefVersion',
      'kernel.priorKernelAt → promote-kernel.priorKernelAt',
      'promote-kernel → channel-supervisor',
      'channel-supervisor → channel-dispatch',
      'channel-dispatch → production-plan',
      'production-plan → consistency',
      'channel-dispatch.dispatched → consistency.dispatched',
      'consistency → finalize',
    ]);
  });

  it('the supervisor names all 5 channel children (resolved by id at runtime via dispatch), fanned out in parallel', () => {
    const def = flagship();
    const configOf = (id: string): Record<string, unknown> =>
      (def.nodes.find((n) => bare(n.nodeId) === id)?.config ?? {}) as Record<string, unknown>;
    const plan = configOf('channel-supervisor').mockDispatchPlan as { kind: string; nextWorkerIds?: string[] }[] | undefined;
    expect(plan?.map((step) => step.kind)).toEqual(['next-worker', 'terminate']);
    expect(plan?.[0]?.nextWorkerIds).toEqual(CHANNELS);
    // The dispatch runs them as a parallel wave and maps each child's result back.
    const dispatch = configOf('channel-dispatch');
    expect(dispatch.fanOutPolicy).toBe('parallel');
    expect(Object.keys((dispatch.perWorkerOutputMappings ?? {}) as Record<string, unknown>).sort()).toEqual([...CHANNELS].sort());
  });
});

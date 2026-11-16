/**
 * Pure-function tests for the executor's DAG scheduler (`src/executor/scheduler.ts`,
 * the live path the executor drives every run through). Covers:
 *   - topologicalOrder (stable order + cycle detection; the core.dispatch ↔
 *     supervisor back-edge is inert; parallel edges between one source→target
 *     pair are legal — the 2026-07-09 live catch that broke the shipped ADR 0325
 *     app-builder.design chain)
 *   - evaluateTrigger (all 5 RFC 0022 §A triggerRules)
 *   - evaluateCondition (eq / truthy / falsy / exists / contains / nested paths)
 *   - buildNodeInputs port-wiring (failed upstreams contribute nothing)
 *   - releaseDownstream + skip propagation, and ADR 0208 edge conditions as
 *     control flow (a false condition folds to `skipped`; skipReasonFor names
 *     condition vs upstream — ECR-2 / ECR-4)
 *   - inspectDisposition (terminal completed / failed / waiting; a failed node
 *     behind skipped terminals still fails the run, RFC 0257 §A) and popReady's
 *     concurrency cap
 *   - conditional tail joins (ADR 0954 P3): a skip that sits behind a FAILURE
 *     (`failedBehindSkip`) is not an untaken branch, so `all_success` /
 *     `none_failed` cannot launder a failed producer through a skipped approval;
 *     a COMPLETED error handler ends that provenance; and releaseDownstream
 *     re-evaluates a join that was waiting when a later branch in the same pass
 *     skipped (it once kept a `visited` set, so the join hung pending).
 *
 * What breaks it: any change that runs a not-taken branch, floods a merge,
 * reports a legal graph as a cycle, lets a failure through an approval barrier,
 * or strands a join. Sabotage witnesses (grade-tests wave 111 g1, `w111g1-sch-*`):
 * cycle, dispatch-loop, parallel, toposort, allsuccess-wait, allsuccess-skip,
 * anysuccess, anysuccess-skip, allcomplete, nonefailed, nonefailed-skip,
 * anyfailed, anyfailed-skip, cond-fold, eq, truthy, falsy, exists, contains-arr,
 * nested, source-input, port, input-failed, waiting, failed-disp, popready,
 * popready-mark, skipreason, skip-propagate, launder, recovery, reconsider,
 * dup-skip.
 */

import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  buildNodeInputs,
  evaluateCondition,
  evaluateTrigger,
  freshSnapshot,
  inspectDisposition,
  markCompleted,
  markFailed,
  markSuspended,
  popReady,
  releaseDownstream,
  skipReasonFor,
  topologicalOrder,
} from '../src/executor/scheduler.js';
import type { EdgeDef, WorkflowDefinition } from '../src/executor/types.js';

function defOf(
  nodes: ReadonlyArray<{ nodeId: string; typeId: string }>,
  edges: ReadonlyArray<{
    from: string;
    to: string;
    rule?: 'all_success' | 'any_success' | 'all_complete' | 'none_failed' | 'any_failed';
    condition?: EdgeDef['condition'];
    targetInput?: string;
  }>,
): WorkflowDefinition {
  return {
    workflowId: 'test',
    nodes,
    edges: edges.map((e, i) => ({
      edgeId: `e${i}`,
      sourceNodeId: e.from,
      targetNodeId: e.to,
      ...(e.rule ? { triggerRule: e.rule } : {}),
      ...(e.condition ? { condition: e.condition } : {}),
      ...(e.targetInput ? { targetInput: e.targetInput } : {}),
    })),
  };
}

describe('topologicalOrder', () => {
  it('returns source-first order for a linear chain', () => {
    const d = defOf(
      [{ nodeId: 'a', typeId: 't' }, { nodeId: 'b', typeId: 't' }, { nodeId: 'c', typeId: 't' }],
      [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    );
    expect(topologicalOrder(d, buildGraph(d))).toEqual(['a', 'b', 'c']);
  });

  it('handles fan-out: a → {b, c} then merge into d', () => {
    const d = defOf(
      [
        { nodeId: 'a', typeId: 't' },
        { nodeId: 'b', typeId: 't' },
        { nodeId: 'c', typeId: 't' },
        { nodeId: 'd', typeId: 't' },
      ],
      [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'b', to: 'd' },
        { from: 'c', to: 'd' },
      ],
    );
    const order = topologicalOrder(d, buildGraph(d));
    expect(order[0]).toBe('a');
    expect(order[3]).toBe('d');
    expect(new Set(order.slice(1, 3))).toEqual(new Set(['b', 'c']));
  });

  it('throws cycle_detected on a cyclic graph', () => {
    const d = defOf(
      [{ nodeId: 'a', typeId: 't' }, { nodeId: 'b', typeId: 't' }, { nodeId: 'c', typeId: 't' }],
      [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }],
    );
    expect(() => topologicalOrder(d, buildGraph(d))).toThrow(/cycle/i);
  });

  it('back-edge from core.dispatch / core.orchestrator.supervisor pair is treated as inert', () => {
    // RFC 0022 §A — supervisor dispatches into a worker pool; the
    // back-edge from `core.dispatch` to the supervisor expresses the
    // re-invocation pattern. `findBackEdges` drops it only when at
    // least one endpoint's typeId is in DISPATCH_LOOP_TYPEIDS;
    // topologicalOrder then walks the forward DAG cleanly.
    const d = defOf(
      [
        { nodeId: 's', typeId: 'core.orchestrator.supervisor' },
        { nodeId: 'd', typeId: 'core.dispatch' },
      ],
      [
        { from: 's', to: 'd' },
        { from: 'd', to: 's' },
      ],
    );
    expect(() => topologicalOrder(d, buildGraph(d))).not.toThrow();
    const order = topologicalOrder(d, buildGraph(d));
    // Supervisor comes first (sole source after the d→s back-edge is
    // dropped); dispatch follows once supervisor is consumed.
    expect(order).toEqual(['s', 'd']);
  });

  it('back-edge between non-dispatch typeIds is still treated as a cycle', () => {
    // Belt-and-suspenders for the gate: a back-edge whose endpoints
    // are neither `core.dispatch` nor `core.orchestrator.supervisor`
    // MUST trip Kahn's leftover-nodes check. This pins the gate so a
    // future refactor that drops the typeId predicate (or renames the
    // constants) regresses loudly instead of silently swallowing
    // user-authored arbitrary cycles.
    const d = defOf(
      [
        { nodeId: 'a', typeId: 'vendor.example.work' },
        { nodeId: 'b', typeId: 'vendor.example.work' },
      ],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    );
    expect(() => topologicalOrder(d, buildGraph(d))).toThrow(/cycle/i);
  });
});

describe('conditional tail joins', () => {
  it.each(['all_success', 'none_failed'] as const)('%s cannot launder a failed producer through a skipped approval', (rule) => {
    const d = defOf(['compose', 'load', 'approve', 'apply'].map((nodeId) => ({ nodeId, typeId: 't' })), [
      { from: 'compose', to: 'approve' }, { from: 'load', to: 'apply', rule }, { from: 'approve', to: 'apply', rule },
    ]);
    const graph = buildGraph(d); const snapshot = freshSnapshot(d);
    markCompleted('load', { plan: 'unapproved' }, snapshot); releaseDownstream('load', graph, snapshot);
    markFailed('compose', { code: 'compose_failed', message: 'No approved plan was produced' }, snapshot); releaseDownstream('compose', graph, snapshot);
    expect(snapshot.nodeState.get('approve')).toBe('skipped'); expect(snapshot.nodeState.get('apply')).toBe('skipped');
    expect(inspectDisposition(snapshot, graph, 0)).toMatchObject({ done: true, status: 'failed' });
  });

  it('a completed explicit error handler is a recovery boundary', () => {
    const d = defOf(['source', 'skipped', 'recover', 'done'].map((nodeId) => ({ nodeId, typeId: 't' })), [
      { from: 'source', to: 'skipped' }, { from: 'skipped', to: 'recover', rule: 'all_complete' }, { from: 'recover', to: 'done' },
    ]);
    const graph = buildGraph(d); const snapshot = freshSnapshot(d);
    markFailed('source', { code: 'source_failed', message: 'Recoverable failure' }, snapshot); releaseDownstream('source', graph, snapshot);
    expect(snapshot.nodeState.get('skipped')).toBe('skipped'); expect(snapshot.nodeState.get('recover')).toBe('ready');
    markCompleted('recover', { recovered: true }, snapshot); releaseDownstream('recover', graph, snapshot);
    expect(snapshot.nodeState.get('done')).toBe('ready');
  });

  // source →(go truthy) branch → tail, with source, branch and tail all joining
  // `join` (none_failed). The queue reaches `join` BEFORE `tail` has skipped, so
  // `join` first reads `wait`; it must be evaluated again once `tail` skips.
  const joinAfterBranch = (): WorkflowDefinition => defOf(['source', 'branch', 'tail', 'join'].map((nodeId) => ({ nodeId, typeId: 't' })), [
    { from: 'source', to: 'branch', condition: { path: 'go', op: 'truthy' } }, { from: 'source', to: 'join', rule: 'none_failed' },
    { from: 'branch', to: 'tail' }, { from: 'branch', to: 'join', rule: 'none_failed' },
    { from: 'tail', to: 'join', rule: 'none_failed' },
  ]);

  it('completed source: a waiting join is reconsidered after skip propagation in the same pass', () => {
    const d = joinAfterBranch();
    const graph = buildGraph(d); const snapshot = freshSnapshot(d);
    markCompleted('source', { go: false }, snapshot);
    const skipped: string[] = [];
    releaseDownstream('source', graph, snapshot, (id) => skipped.push(id));
    expect(skipped).toEqual(['branch', 'tail']);
    expect(snapshot.nodeState.get('join')).toBe('ready');
    markCompleted('join', { output: 'finished' }, snapshot);
    expect(inspectDisposition(snapshot, graph, 0)).toEqual({ done: true, status: 'completed' });
  });

  it('failed source: the join skips exactly once and the run fails on the source', () => {
    const d = joinAfterBranch();
    const graph = buildGraph(d); const snapshot = freshSnapshot(d);
    markFailed('source', { code: 'source_failed', message: 'Real predecessor failure' }, snapshot);
    const skipped: string[] = [];
    releaseDownstream('source', graph, snapshot, (id) => skipped.push(id));
    expect(skipped).toEqual(['branch', 'join', 'tail']);
    expect(inspectDisposition(snapshot, graph, 0)).toEqual({ done: true, status: 'failed', failedNodeId: 'source' });
  });
});

describe('evaluateTrigger — all 5 rules', () => {
  // Two upstreams a, b → target c. Tweak per-rule.
  function setup(rule: 'all_success' | 'any_success' | 'all_complete' | 'none_failed' | 'any_failed') {
    const d = defOf(
      [{ nodeId: 'a', typeId: 't' }, { nodeId: 'b', typeId: 't' }, { nodeId: 'c', typeId: 't' }],
      [{ from: 'a', to: 'c', rule }, { from: 'b', to: 'c', rule }],
    );
    return { graph: buildGraph(d), snapshot: freshSnapshot(d) };
  }

  it('all_success: waits for both, then ready', () => {
    const { graph, snapshot } = setup('all_success');
    expect(evaluateTrigger('c', graph, snapshot)).toBe('wait');
    markCompleted('a', { output: 1 }, snapshot);
    expect(evaluateTrigger('c', graph, snapshot)).toBe('wait');
    markCompleted('b', { output: 2 }, snapshot);
    expect(evaluateTrigger('c', graph, snapshot)).toBe('ready');
  });

  it('all_success: skips if any failed', () => {
    const { graph, snapshot } = setup('all_success');
    markCompleted('a', { output: 1 }, snapshot);
    markFailed('b', { code: 'x', message: 'boom' }, snapshot);
    expect(evaluateTrigger('c', graph, snapshot)).toBe('skip');
  });

  it('any_success: fires on first success', () => {
    const { graph, snapshot } = setup('any_success');
    expect(evaluateTrigger('c', graph, snapshot)).toBe('wait');
    markCompleted('a', { output: 1 }, snapshot);
    expect(evaluateTrigger('c', graph, snapshot)).toBe('ready');
  });

  it('any_success: skips when all upstream failed', () => {
    const { graph, snapshot } = setup('any_success');
    markFailed('a', { code: 'x', message: 'boom' }, snapshot);
    markFailed('b', { code: 'x', message: 'boom' }, snapshot);
    expect(evaluateTrigger('c', graph, snapshot)).toBe('skip');
  });

  it('all_complete: fires when all terminal regardless of outcome', () => {
    const { graph, snapshot } = setup('all_complete');
    markFailed('a', { code: 'x', message: 'boom' }, snapshot);
    expect(evaluateTrigger('c', graph, snapshot)).toBe('wait');
    markCompleted('b', { output: 2 }, snapshot);
    expect(evaluateTrigger('c', graph, snapshot)).toBe('ready');
  });

  it('none_failed: fires when all completed without failure', () => {
    const { graph, snapshot } = setup('none_failed');
    markCompleted('a', { output: 1 }, snapshot);
    markCompleted('b', { output: 2 }, snapshot);
    expect(evaluateTrigger('c', graph, snapshot)).toBe('ready');
  });

  it('none_failed: skips on any failure', () => {
    const { graph, snapshot } = setup('none_failed');
    markFailed('a', { code: 'x', message: 'boom' }, snapshot);
    expect(evaluateTrigger('c', graph, snapshot)).toBe('skip');
  });

  it('any_failed: fires on first failure (error-routing)', () => {
    const { graph, snapshot } = setup('any_failed');
    expect(evaluateTrigger('c', graph, snapshot)).toBe('wait');
    markFailed('a', { code: 'x', message: 'boom' }, snapshot);
    expect(evaluateTrigger('c', graph, snapshot)).toBe('ready');
  });

  it('any_failed: skips when no upstream fails', () => {
    const { graph, snapshot } = setup('any_failed');
    markCompleted('a', { output: 1 }, snapshot);
    markCompleted('b', { output: 2 }, snapshot);
    expect(evaluateTrigger('c', graph, snapshot)).toBe('skip');
  });
});

describe('evaluateCondition', () => {
  it('eq matches identical primitives', () => {
    expect(evaluateCondition({ path: 'k', op: 'eq', value: 'v' }, { k: 'v' })).toBe(true);
    expect(evaluateCondition({ path: 'k', op: 'eq', value: 'v' }, { k: 'other' })).toBe(false);
  });
  it('truthy / falsy work', () => {
    expect(evaluateCondition({ path: 'k', op: 'truthy' }, { k: 1 })).toBe(true);
    expect(evaluateCondition({ path: 'k', op: 'truthy' }, { k: 0 })).toBe(false);
    expect(evaluateCondition({ path: 'k', op: 'falsy' }, { k: 0 })).toBe(true);
    expect(evaluateCondition({ path: 'k', op: 'falsy' }, { k: 1 })).toBe(false);
  });
  it('exists vs absent', () => {
    expect(evaluateCondition({ path: 'k', op: 'exists' }, { k: '' })).toBe(true);
    expect(evaluateCondition({ path: 'k', op: 'exists' }, {})).toBe(false);
  });
  it('contains: string + array', () => {
    expect(evaluateCondition({ path: 'k', op: 'contains', value: 'foo' }, { k: 'foobar' })).toBe(true);
    expect(evaluateCondition({ path: 'k', op: 'contains', value: 2 }, { k: [1, 2, 3] })).toBe(true);
    expect(evaluateCondition({ path: 'k', op: 'contains', value: 'baz' }, { k: 'foobar' })).toBe(false);
    expect(evaluateCondition({ path: 'k', op: 'contains', value: 2 }, { k: [1, 3] })).toBe(false);
  });
  it('resolves nested paths', () => {
    expect(evaluateCondition({ path: 'a.b.c', op: 'eq', value: 7 }, { a: { b: { c: 7 } } })).toBe(true);
    expect(evaluateCondition({ path: 'a.b.c', op: 'eq', value: 7 }, { a: { c: 7 } })).toBe(false);
  });
});

describe('buildNodeInputs', () => {
  it('source node gets run.inputs on its `input` port', () => {
    const d = defOf([{ nodeId: 'a', typeId: 't' }], []);
    const inputs = buildNodeInputs('a', buildGraph(d), freshSnapshot(d), { hello: 'world' });
    expect(inputs.input).toEqual({ hello: 'world' });
  });

  it('downstream node receives upstream outputs by port name', () => {
    const d = defOf(
      [{ nodeId: 'a', typeId: 't' }, { nodeId: 'b', typeId: 't' }],
      [{ from: 'a', to: 'b' }],
    );
    const graph = buildGraph(d);
    const snapshot = freshSnapshot(d);
    markCompleted('a', { output: 42 }, snapshot);
    const inputs = buildNodeInputs('b', graph, snapshot, null);
    expect(inputs.input).toBe(42);
  });

  it('skips contributions from failed upstreams', () => {
    const d = defOf(
      [{ nodeId: 'a', typeId: 't' }, { nodeId: 'b', typeId: 't' }, { nodeId: 'c', typeId: 't' }],
      [
        { from: 'a', to: 'c', rule: 'all_complete', targetInput: 'fromA' },
        { from: 'b', to: 'c', rule: 'all_complete', targetInput: 'fromB' },
      ],
    );
    const graph = buildGraph(d);
    const snapshot = freshSnapshot(d);
    markCompleted('a', { output: 1 }, snapshot);
    markFailed('b', { code: 'x', message: 'boom' }, snapshot);
    const inputs = buildNodeInputs('c', graph, snapshot, null);
    // Single completed upstream contributes; the failed upstream's port is
    // ABSENT (not present-as-undefined). Distinct ports, so the failed edge
    // cannot hide behind the completed one writing the same key.
    expect(Object.keys(inputs)).toEqual(['fromA']);
    expect(inputs.fromA).toBe(1);
  });
});

describe('releaseDownstream', () => {
  it('flips ready when triggerRule is satisfied', () => {
    const d = defOf(
      [{ nodeId: 'a', typeId: 't' }, { nodeId: 'b', typeId: 't' }],
      [{ from: 'a', to: 'b' }],
    );
    const graph = buildGraph(d);
    const snapshot = freshSnapshot(d);
    // b starts pending.
    expect(snapshot.nodeState.get('b')).toBe('pending');
    markCompleted('a', { output: 1 }, snapshot);
    releaseDownstream('a', graph, snapshot);
    expect(snapshot.nodeState.get('b')).toBe('ready');
  });

  it('propagates skip when failure flows through any_success', () => {
    const d = defOf(
      [
        { nodeId: 'a', typeId: 't' },
        { nodeId: 'b', typeId: 't' },
        { nodeId: 'c', typeId: 't' },
      ],
      [
        { from: 'a', to: 'b', rule: 'any_success' },
        { from: 'b', to: 'c' },
      ],
    );
    const graph = buildGraph(d);
    const snapshot = freshSnapshot(d);
    markFailed('a', { code: 'x', message: 'boom' }, snapshot);
    releaseDownstream('a', graph, snapshot);
    expect(snapshot.nodeState.get('b')).toBe('skipped');
    expect(snapshot.nodeState.get('c')).toBe('skipped');
  });
});

describe('edge conditions are control-flow, not just data-flow (ADR 0208)', () => {
  // A conditioned edge is "a branch that fires only when the condition holds"
  // (workflow-chain-packs.md §edges). A completed source whose edge condition
  // is FALSE is a not-taken branch: the target must be SKIPPED, not run with
  // empty inputs. Before ADR 0208 the executor evaluated the condition only for
  // input contribution, so both branches of a router ran.
  const router = (): WorkflowDefinition => ({
    workflowId: 'router',
    nodes: [
      { nodeId: 'A', typeId: 't' },
      { nodeId: 'major', typeId: 't' },
      { nodeId: 'routine', typeId: 't' },
    ],
    edges: [
      { edgeId: 'e1', sourceNodeId: 'A', targetNodeId: 'major', condition: { path: 'sev', op: 'eq', value: 'major' } },
      { edgeId: 'e2', sourceNodeId: 'A', targetNodeId: 'routine', condition: { path: 'sev', op: 'neq', value: 'major' } },
    ],
  });

  it('runs ONLY the matching branch; the other is skipped', () => {
    const d = router();
    const g = buildGraph(d);
    const s = freshSnapshot(d);
    markCompleted('A', { sev: 'routine' }, s);
    releaseDownstream('A', g, s);
    expect(s.nodeState.get('routine')).toBe('ready');
    expect(s.nodeState.get('major')).toBe('skipped');
  });

  it('the OTHER value routes the OTHER way', () => {
    const d = router();
    const g = buildGraph(d);
    const s = freshSnapshot(d);
    markCompleted('A', { sev: 'major' }, s);
    releaseDownstream('A', g, s);
    expect(s.nodeState.get('major')).toBe('ready');
    expect(s.nodeState.get('routine')).toBe('skipped');
  });

  it('a merge after a route fires on the taken branch (skipped sibling does not block all_success)', () => {
    // A → {major→mNode, routine→rNode} → merge. Only one branch is taken; the
    // merge (default all_success) must still run — the skipped sibling counts
    // as terminal-not-failed, so `anyCompleted` on the taken branch releases it.
    const d: WorkflowDefinition = {
      workflowId: 'merge',
      nodes: [
        { nodeId: 'A', typeId: 't' },
        { nodeId: 'mNode', typeId: 't' },
        { nodeId: 'rNode', typeId: 't' },
        { nodeId: 'merge', typeId: 't' },
      ],
      edges: [
        { edgeId: 'e1', sourceNodeId: 'A', targetNodeId: 'mNode', condition: { path: 'sev', op: 'eq', value: 'major' } },
        { edgeId: 'e2', sourceNodeId: 'A', targetNodeId: 'rNode', condition: { path: 'sev', op: 'neq', value: 'major' } },
        { edgeId: 'e3', sourceNodeId: 'mNode', targetNodeId: 'merge' },
        { edgeId: 'e4', sourceNodeId: 'rNode', targetNodeId: 'merge' },
      ],
    };
    const g = buildGraph(d);
    const s = freshSnapshot(d);
    markCompleted('A', { sev: 'routine' }, s);
    releaseDownstream('A', g, s);
    expect(s.nodeState.get('mNode')).toBe('skipped');
    expect(s.nodeState.get('rNode')).toBe('ready');
    markCompleted('rNode', { ok: true }, s);
    releaseDownstream('rNode', g, s);
    expect(s.nodeState.get('merge')).toBe('ready');
  });

  // ECR-2 — the effective-`skipped` folding must compose with EVERY trigger
  // rule, not just the default all_success. A conditioned edge whose condition
  // is false makes the source read as `skipped` for that edge; each rule then
  // applies its own semantics over the effective states.
  const oneBranch = (rule: 'all_success' | 'any_success' | 'all_complete' | 'none_failed' | 'any_failed'): WorkflowDefinition => ({
    workflowId: 'rule-cond',
    nodes: [
      { nodeId: 'A', typeId: 't' },
      { nodeId: 'B', typeId: 't' },
    ],
    edges: [{ edgeId: 'e1', sourceNodeId: 'A', targetNodeId: 'B', triggerRule: rule, condition: { path: 'go', op: 'truthy' } }],
  });
  const run = (rule: Parameters<typeof oneBranch>[0], go: boolean) => {
    const d = oneBranch(rule);
    const g = buildGraph(d);
    const s = freshSnapshot(d);
    markCompleted('A', { go }, s);
    releaseDownstream('A', g, s);
    return s.nodeState.get('B');
  };

  it('a false condition folds to `skipped`; each rule then applies its own semantics', () => {
    // Sole incoming edge inactive (condition false) → the source reads as
    // `skipped` for that edge. Rules that require a COMPLETION cannot be
    // satisfied → skip; rules that only require "all terminal, none failed"
    // treat the condition-skip as an acceptable terminal → fire; any_failed
    // needs a failure it never gets → skip. (This subtlety is why ECR-2 pins
    // the full matrix, not just all_success.)
    expect(run('all_success', false)).toBe('skipped'); // needs anyCompleted
    expect(run('any_success', false)).toBe('skipped'); // needs anyCompleted
    expect(run('any_failed', false)).toBe('skipped'); // needs a failure
    expect(run('all_complete', false)).toBe('ready'); // terminal reached
    expect(run('none_failed', false)).toBe('ready'); // terminal, none failed
  });

  it('a true condition fires the branch under every trigger rule', () => {
    expect(run('all_success', true)).toBe('ready');
    expect(run('any_success', true)).toBe('ready');
    expect(run('none_failed', true)).toBe('ready');
    expect(run('all_complete', true)).toBe('ready');
    // any_failed needs a FAILURE, not a success — a completed+true branch is
    // terminal-not-failed, so any_failed correctly skips it.
    expect(run('any_failed', true)).toBe('skipped');
  });

  // ECR-4 — skip observability: releaseDownstream reports WHY a node skipped.
  it('reports skip reason (condition vs upstream) via skipReasonFor + onSkip', () => {
    const d: WorkflowDefinition = {
      workflowId: 'skip-reason',
      nodes: [
        { nodeId: 'A', typeId: 't' },
        { nodeId: 'cond', typeId: 't' },
        { nodeId: 'fail', typeId: 't' },
        { nodeId: 'down', typeId: 't' },
      ],
      edges: [
        { edgeId: 'e1', sourceNodeId: 'A', targetNodeId: 'cond', condition: { path: 'go', op: 'truthy' } },
        { edgeId: 'e2', sourceNodeId: 'A', targetNodeId: 'fail' },
        { edgeId: 'e3', sourceNodeId: 'fail', targetNodeId: 'down' },
      ],
    };
    const g = buildGraph(d);
    const s = freshSnapshot(d);
    const skips: Array<[string, string]> = [];
    markCompleted('A', { go: false }, s);
    releaseDownstream('A', g, s, (id, reason) => skips.push([id, reason]));
    // `cond` skipped because its edge condition is false; `fail` ran (unconditioned).
    expect(s.nodeState.get('cond')).toBe('skipped');
    expect(skips).toContainEqual(['cond', 'condition']);
    expect(skipReasonFor('cond', g, s)).toBe('condition');
    // Now fail the unconditioned branch → `down` skips for an UPSTREAM reason.
    markFailed('fail', { code: 'x', message: 'boom' }, s);
    const upstreamSkips: Array<[string, string]> = [];
    releaseDownstream('fail', g, s, (id, reason) => upstreamSkips.push([id, reason]));
    expect(s.nodeState.get('down')).toBe('skipped');
    expect(upstreamSkips).toContainEqual(['down', 'upstream']);
  });
});

describe('inspectDisposition', () => {
  it('reports done:completed when all nodes complete', () => {
    const d = defOf(
      [{ nodeId: 'a', typeId: 't' }, { nodeId: 'b', typeId: 't' }],
      [{ from: 'a', to: 'b' }],
    );
    const graph = buildGraph(d);
    const snapshot = freshSnapshot(d);
    markCompleted('a', { output: 1 }, snapshot);
    markCompleted('b', { output: 2 }, snapshot);
    const disp = inspectDisposition(snapshot, graph, 0);
    expect(disp).toEqual({ done: true, status: 'completed' });
  });

  it('reports done:waiting when a branch is suspended', () => {
    const d = defOf(
      [{ nodeId: 'a', typeId: 't' }, { nodeId: 'b', typeId: 't' }],
      [{ from: 'a', to: 'b' }],
    );
    const graph = buildGraph(d);
    const snapshot = freshSnapshot(d);
    markCompleted('a', { output: 1 }, snapshot);
    snapshot.nodeState.set('b', 'ready');
    markSuspended('b', snapshot);
    const disp = inspectDisposition(snapshot, graph, 0);
    expect(disp).toEqual({ done: true, status: 'waiting', suspendedNodeId: 'b' });
  });

  it('reports done:failed when a node fails and no all_complete rescues', () => {
    const d = defOf(
      [{ nodeId: 'a', typeId: 't' }, { nodeId: 'b', typeId: 't' }],
      [{ from: 'a', to: 'b' }],
    );
    const graph = buildGraph(d);
    const snapshot = freshSnapshot(d);
    markFailed('a', { code: 'x', message: 'boom' }, snapshot);
    releaseDownstream('a', graph, snapshot);
    expect(snapshot.nodeState.get('b')).toBe('skipped');
    // A failed node behind a skipped terminal is a FAILED run, never the
    // RFC 0257 "every terminal skipped" completion.
    expect(inspectDisposition(snapshot, graph, 0)).toEqual({ done: true, status: 'failed', failedNodeId: 'a' });
  });
});

describe('popReady — concurrency cap honored', () => {
  it('caps to requested count', () => {
    const d = defOf(
      [
        { nodeId: 'a', typeId: 't' },
        { nodeId: 'b', typeId: 't' },
        { nodeId: 'c', typeId: 't' },
        { nodeId: 'd', typeId: 't' },
      ],
      [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'a', to: 'd' },
      ],
    );
    const graph = buildGraph(d);
    const snapshot = freshSnapshot(d);
    markCompleted('a', { output: 1 }, snapshot);
    releaseDownstream('a', graph, snapshot);
    // All three of b, c, d are now ready.
    const batch1 = popReady(2, snapshot);
    expect(batch1).toEqual(['b', 'c']);
    expect(batch1.map((id) => snapshot.nodeState.get(id))).toEqual(['running', 'running']);
    expect(snapshot.nodeState.get('d')).toBe('ready');
    const batch2 = popReady(2, snapshot);
    expect(batch2).toEqual(['d']);
  });
});

// ── Grade live-verify 2026-07-09: parallel edges between one (source,target)
// pair are LEGAL (the input assembly delivers every edge) — raw-edge indegree
// counting misreported them as a cycle, which broke the shipped ADR 0325
// app-builder.design chain (deepen→audit carries artifact + warning). ──
describe('topologicalOrder — parallel edges (one source→target pair, two ports)', () => {
  it('orders a linear chain with a dual-port edge instead of reporting a cycle', () => {
    const def: WorkflowDefinition = {
      workflowId: 'parallel-edge-test',
      nodes: [{ nodeId: 'a', typeId: 't' }, { nodeId: 'b', typeId: 't' }, { nodeId: 'c', typeId: 't' }],
      edges: [
        { edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'b', sourceOutput: 'artifact', targetInput: 'artifact', triggerRule: 'all_success' },
        { edgeId: 'e2', sourceNodeId: 'a', targetNodeId: 'b', sourceOutput: 'warning', targetInput: 'upstreamWarning', triggerRule: 'all_success' },
        { edgeId: 'e3', sourceNodeId: 'b', targetNodeId: 'c', triggerRule: 'all_success' },
      ],
    };
    const order = topologicalOrder(def, buildGraph(def));
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('the SHIPPED app-builder.design chain passes graph validation (the live-caught regression)', async () => {
    // ADR 0346 4a — the builtin now expands from the workflows chain pack;
    // node ids carry the expansion prefix, so assert by suffix order.
    const { buildDesignWorkflowDefinition } = await import('../src/features/app-builder/designWorkflow.js');
    const def = buildDesignWorkflowDefinition();
    const order = topologicalOrder(def, buildGraph(def));
    expect(order.map((id) => id.split('_').pop())).toEqual(['intake', 'clarify', 'prd', 'research', 'plan', 'render', 'deepen', 'audit', 'auditRecord', 'review']); // AI-08: intake+clarify prepended (DECIDE-3)
  });

  it('still detects a REAL cycle', () => {
    const def: WorkflowDefinition = {
      workflowId: 'real-cycle',
      nodes: [{ nodeId: 'a', typeId: 't' }, { nodeId: 'b', typeId: 't' }],
      edges: [
        { edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'b', triggerRule: 'all_success' },
        { edgeId: 'e2', sourceNodeId: 'b', targetNodeId: 'a', triggerRule: 'all_success' },
      ],
    };
    expect(() => topologicalOrder(def, buildGraph(def))).toThrow(/cycle/);
  });
});

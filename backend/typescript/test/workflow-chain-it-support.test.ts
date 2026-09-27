/**
 * it-support.incident-triage — exclusive severity routing (ADR 0208 + #2).
 *
 * The chain classifies severity (structured) then a `core.flow.router` routes
 * EXCLUSIVELY: routine → KB + ticket, major → gated Slack comms. This is
 * env-independent — it loads the in-tree pack, expands it (running the wire→host
 * edge-condition mapper), and asserts the routed edges gate via the REAL
 * `evaluateCondition`. Full-run coverage of the routing/merge semantics lives in
 * scheduler.test.ts ("edge conditions are control-flow, not just data-flow").
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadWorkflowChainPacks,
  getChain,
  expandChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import { evaluateCondition } from '../src/executor/scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IN_TREE_ROOT = join(__dirname, '..', '..', '..', 'examples', 'workflow-chain-packs');

beforeAll(() => {
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: [IN_TREE_ROOT] });
  expect(errors).toEqual([]);
});

describe('it-support.incident-triage — exclusive severity routing', () => {
  it('expands with a structured classifier feeding the router value port', () => {
    const chain = getChain('it-support.incident-triage')!.chain;
    const classify = chain.dag.nodes.find((n) => n.id === 'classify')!;
    expect(classify.typeId).toBe('core.ai.structuredOutput');
    // The classifier constrains output to a routable {severity} enum.
    const schema = (classify.config as { outputSchema: { properties: { severity: { enum: string[] } } } }).outputSchema;
    expect(schema.properties.severity.enum).toEqual(['major', 'routine']);
    // classify.data → route.value wires the structured field into the router's predicate base.
    const wire = chain.dag.edges!.find((e) => e.from === 'classify.data')!;
    expect(wire.to).toBe('route.value');
  });

  it('routes ONLY the matching branch — mapped conditions gate via the real evaluateCondition', () => {
    const def = expandChain(getChain('it-support.incident-triage')!.chain, { params: { alert: 'db down' } });
    const byTarget = (suffix: string) =>
      def.edges!.find((e) => e.targetNodeId.endsWith(suffix) && e.condition)!;
    const majorEdge = byTarget('majorApprove');
    const routineEdge = byTarget('kbArticle');
    // Wire {type:contains,left:branches,right:...} → host {path:branches,op:contains,value:...}.
    expect(majorEdge.condition).toEqual({ path: 'branches', op: 'contains', value: 'major' });
    expect(routineEdge.condition).toEqual({ path: 'branches', op: 'contains', value: 'routine' });

    // Router emitted branches:['major'] → only the major branch's condition holds.
    const major = { branches: ['major'] };
    expect(evaluateCondition(majorEdge.condition!, major)).toBe(true);
    expect(evaluateCondition(routineEdge.condition!, major)).toBe(false);

    // …and branches:['routine'] routes the other way.
    const routine = { branches: ['routine'] };
    expect(evaluateCondition(majorEdge.condition!, routine)).toBe(false);
    expect(evaluateCondition(routineEdge.condition!, routine)).toBe(true);
  });

  it('the major-comms branch stays human-gated AND ONLY FIRES ON APPROVAL (ADR 0582 Batch 2)', () => {
    const chain = getChain('it-support.incident-triage')!.chain;
    const approve = chain.dag.nodes.find((n) => n.id === 'majorApprove')!;
    expect(approve.typeId).toBe('core.chat.approvalGate');
    // WF-EM-5 — the gate's `falsy approved` branch leads to a terminal, so the
    // verb allowlist must be declared.
    expect((approve.config as { actions?: string[] }).actions).toEqual(['approve', 'reject']);

    // The Slack send takes its content BACK OFF THE GATE and fires ONLY on an
    // approval — its ONLY inbound is the `{truthy approved}` conditioned edge, so
    // a reject/timeout/send-back folds `stakeholders` to `skipped` (ADR 0582).
    const gatedSend = chain.dag.edges!.find((e) => e.to === 'stakeholders.text')!;
    expect(gatedSend.from).toBe('majorApprove.artifact');
    expect(gatedSend.condition).toEqual({ type: 'truthy', left: 'approved' });
    // No unconditional inbound to the effect node.
    const bareToStakeholders = chain.dag.edges!.filter(
      (e) => (e.to === 'stakeholders' || e.to === 'stakeholders.text') && !e.condition,
    );
    expect(bareToStakeholders).toEqual([]);

    // A reject folds to a noop terminal (never core.fail — that would corrupt successRate).
    const rejectEdge = chain.dag.edges!.find((e) => e.from === 'majorApprove' && e.to === 'majorReject')!;
    expect(rejectEdge.condition).toEqual({ type: 'falsy', left: 'approved' });
    const rejectNode = chain.dag.nodes.find((n) => n.id === 'majorReject')!;
    expect(rejectNode.typeId).toBe('core.flow.noop');
  });

  // ECR-3 — close the composition-reality gap: prove the EXPANDED graph wires
  // the classifier's structured field to the router's predicate base and then
  // routes exclusively, without needing a live AI provider. The router node's
  // own branch-emission is covered by core.openwop.flow's pack tests; here we
  // verify the wiring around it (buildNodeInputs) and the edge gating (scheduler).
  it('wires classify.data → route.value so the router predicate sees the severity', async () => {
    const { buildGraph, freshSnapshot, markCompleted, buildNodeInputs } = await import('../src/executor/scheduler.js');
    const def = expandChain(getChain('it-support.incident-triage')!.chain, { params: { alert: 'db down' } });
    const classifyId = def.nodes.find((n) => n.typeId === 'core.ai.structuredOutput')!.nodeId;
    const routeId = def.nodes.find((n) => n.typeId === 'core.flow.router')!.nodeId;
    const wire = def.edges!.find((e) => e.sourceNodeId === classifyId && e.targetNodeId === routeId)!;
    expect(wire.sourceOutput).toBe('data');
    expect(wire.targetInput).toBe('value');
    // structuredOutput emits {data:{severity}}; buildNodeInputs must land that
    // `data` payload on the router's `value` port (what routerNode reads).
    const g = buildGraph(def);
    const s = freshSnapshot(def);
    markCompleted(classifyId, { data: { severity: 'major' } }, s);
    expect(buildNodeInputs(routeId, g, s, {})).toEqual({ value: { severity: 'major' } });
  });

  it('routes ONLY the matching branch end-to-end on the expanded graph', async () => {
    const { buildGraph, freshSnapshot, markCompleted, releaseDownstream } = await import('../src/executor/scheduler.js');
    const def = expandChain(getChain('it-support.incident-triage')!.chain, { params: { alert: 'db down' } });
    const idOf = (typeId: string) => def.nodes.find((n) => n.typeId === typeId)!.nodeId;
    const routeId = idOf('core.flow.router');
    const approveId = idOf('core.chat.approvalGate'); // major branch head
    const kbId = idOf('feature.kb.nodes.rag'); // routine branch head

    // MAJOR: router emits branches:['major'] → major branch fires, routine skips.
    let g = buildGraph(def);
    let s = freshSnapshot(def);
    markCompleted(idOf('core.ai.structuredOutput'), { data: { severity: 'major' } }, s);
    releaseDownstream(idOf('core.ai.structuredOutput'), g, s);
    markCompleted(routeId, { branches: ['major'], value: { severity: 'major' } }, s);
    releaseDownstream(routeId, g, s);
    expect(s.nodeState.get(approveId)).toBe('ready');
    expect(s.nodeState.get(kbId)).toBe('skipped');

    // ROUTINE: default label → routine branch fires, major (gated) skips.
    g = buildGraph(def);
    s = freshSnapshot(def);
    markCompleted(idOf('core.ai.structuredOutput'), { data: { severity: 'routine' } }, s);
    releaseDownstream(idOf('core.ai.structuredOutput'), g, s);
    markCompleted(routeId, { branches: ['routine'], value: { severity: 'routine' } }, s);
    releaseDownstream(routeId, g, s);
    expect(s.nodeState.get(kbId)).toBe('ready');
    expect(s.nodeState.get(approveId)).toBe('skipped');
  });
});

/**
 * exec-ops — the approval gate that did not gate, and the delivery edges that
 * delivered nothing (`WF-ANL-5` / `WF-ANL-6`, WORKFLOWS-ASSESSMENT 2026-08-18).
 *
 * `exec-ops.board-update` shipped `{"from":"review","to":"deliver"}` with NO
 * condition. `core.chat.approvalGate` returns `status:'success'` on REJECT just
 * as it does on approve, so a rejected board/investor pack was still
 * distributed — and the same chain's `{"from":"draft","to":"review"}` was BARE,
 * so `inputs.artifact` was undefined and the reviewer was asked to approve an
 * EMPTY card. Two halves of one defect: nothing to judge, and no consequence
 * for judging.
 *
 * WHY THIS ASSERTS THE SCHEDULER AND NOT THE PACK JSON. A conditioned gate edge
 * alone is NOT sufficient, and a JSON-shape assertion would have called the
 * no-op a fix. `all_success` is `allTerminal && !anyFailed && anyCompleted`, so
 * an effect node that ALSO keeps an unconditional sibling data edge is `ready`
 * on a rejection anyway — the conditioned edge folds to `skipped` while the
 * sibling satisfies `anyCompleted`. The cure (the `lighthouse.lead-triage`
 * shape) routes the content THROUGH the gate: `draft.content →
 * review.artifact`, then `review.artifact → deliver.message` conditioned
 * `{truthy approved}`, with no sibling edge into `deliver`.
 *
 * WHY THE REAL RESUME PAYLOAD. The gate's `approved` output is DERIVED from the
 * reviewer's click, and that derivation has already been wrong once: ADR 0582
 * §9 records that every shipped producer sends `{action}` while the gate read
 * `{decision}` only, so `approved` was ALWAYS false and every `truthy approved`
 * edge in the corpus was inverted. A witness that hand-sets `approved: true`
 * cannot see that class. These tests drive the REAL `core.chat.approvalGate`
 * implementation with the REAL UI payloads — `{action:'approve'}` /
 * `{action:'reject'}`, the `APPROVAL_ACTIONS` verbs from
 * `frontend/react/src/interrupts/ApprovalCard.tsx` — and feed ITS outputs to
 * `evaluateTrigger`.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  getChain,
  expandChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import { buildGraph, freshSnapshot, evaluateTrigger, buildNodeInputs } from '../src/executor/scheduler.js';

/** The chat pack is plain ESM with no types — imported by URL, the pattern
 *  `chain-backed-flagship-e2e` / the kicktodo suites already use. */
const chatPackUrl = new URL('../../../packs/vendor.myndhyve.chat/index.mjs', import.meta.url).href;
interface PackNodes { nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs: Record<string, unknown> }>> }

beforeAll(() => {
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  expect(errors).toEqual([]);
});

const DRAFT_BODY = 'Q2 board pack: ARR up 12%, churn flat.';

/** Run the REAL approvalGate node against a real UI resume payload and return
 *  its real outputs. No hand-set `approved`. */
async function realGateOutputs(action: 'approve' | 'reject', artifact: unknown): Promise<Record<string, unknown>> {
  const mod = (await import(chatPackUrl)) as PackNodes;
  const gate = mod.nodes['core.chat.approvalGate']!;
  const result = await gate({
    runId: 'run-gate-test',
    nodeId: 'review',
    config: {},
    inputs: { artifact },
    variables: new Map<string, unknown>(),
    // The shape the UI actually posts (ApprovalCard / defaultCards /
    // routes/reviews.ts all send `action`).
    suspend: async () => ({ action }),
  });
  expect(result.status).toBe('success');
  return result.outputs;
}

/** `deliver`'s scheduler verdict on a real approve/reject, with every other
 *  node completed and the gate's outputs taken from the real node. */
async function deliverVerdict(action: 'approve' | 'reject'): Promise<{ verdict: string; inputs: Record<string, unknown> }> {
  const def = expandChain(getChain('exec-ops.board-update')!.chain, { params: { period: '2026-06', orgId: 'org1' } });
  const graph = buildGraph(def);
  const snap = freshSnapshot(def);
  const gateOutputs = await realGateOutputs(action, DRAFT_BODY);
  for (const n of def.nodes) {
    if (n.nodeId.endsWith('deliver')) continue;
    snap.nodeState.set(n.nodeId, 'completed');
    snap.nodeOutputs.set(n.nodeId, n.typeId === 'core.chat.approvalGate' ? gateOutputs : { content: DRAFT_BODY, summary: {}, deals: [] });
  }
  const deliver = def.nodes.find((n) => n.nodeId.endsWith('deliver'))!;
  return {
    verdict: evaluateTrigger(deliver.nodeId, graph, snap),
    inputs: buildNodeInputs(deliver.nodeId, graph, snap, {}),
  };
}

describe('WF-ANL-5 — exec-ops.board-update: a REJECTED exec review cannot distribute', () => {
  it('the real {action:"reject"} payload makes `deliver` SKIP', async () => {
    const { verdict } = await deliverVerdict('reject');
    // Pre-fix: `review → deliver` was unconditioned, so this was `ready` — a
    // rejected board pack distributed to the whole tenant.
    expect(verdict, 'a rejected board pack must never be distributed').toBe('skip');
  });

  it('the paired positive leg: the real {action:"approve"} payload still delivers', async () => {
    // Without this, "never delivers at all" would satisfy the assertion above.
    const { verdict } = await deliverVerdict('approve');
    expect(verdict).toBe('ready');
  });

  it('`deliver` has exactly ONE inbound edge and it is the conditioned one (no sibling to satisfy anyCompleted)', () => {
    const def = expandChain(getChain('exec-ops.board-update')!.chain, { params: { period: '2026-06', orgId: 'org1' } });
    const graph = buildGraph(def);
    const deliver = def.nodes.find((n) => n.nodeId.endsWith('deliver'))!;
    const inbound = graph.incoming.get(deliver.nodeId) ?? [];
    expect(inbound.length, 'a second, unconditional edge would make the condition decorative').toBe(1);
    // The RFC 0134 wire form `{type:'truthy',left:'approved'}` is transformed
    // by `expandChain` into the host-native `{path,op}` shape — assert the
    // EXPANDED form, since that is what the scheduler evaluates.
    expect(inbound[0]!.condition).toMatchObject({ path: 'approved', op: 'truthy' });
  });

  it('the review card is not EMPTY — the draft reaches `review.artifact`', async () => {
    // The other half of WF-ANL-5: `draft → review` was bare, so the approval
    // card rendered `artifact: undefined` and the reviewer approved nothing.
    const def = expandChain(getChain('exec-ops.board-update')!.chain, { params: { period: '2026-06', orgId: 'org1' } });
    const graph = buildGraph(def);
    const snap = freshSnapshot(def);
    for (const n of def.nodes) {
      if (n.typeId === 'core.chat.approvalGate' || n.nodeId.endsWith('deliver')) continue;
      snap.nodeState.set(n.nodeId, 'completed');
      snap.nodeOutputs.set(n.nodeId, { content: DRAFT_BODY, summary: {}, deals: [] });
    }
    const review = def.nodes.find((n) => n.typeId === 'core.chat.approvalGate')!;
    expect(buildNodeInputs(review.nodeId, graph, snap, {})).toMatchObject({ artifact: DRAFT_BODY });
  });
});

describe('WF-ANL-6 — exec-ops delivery edges land on `message`, not the default port', () => {
  // `feature.notifications.nodes.notify` reads `inputs.message`
  // (packs/feature.notifications.nodes/index.mjs). A BARE `→ deliver` edge
  // collapses the payload onto the default `input` key, so `message` is
  // undefined and the node emits a TITLED, EMPTY-BODIED notification with
  // `emitted: true` — a green run that delivered nothing.
  const CASES: [string, string][] = [
    ['exec-ops.daily-briefing', 'brief'],
    ['exec-ops.meeting-prep', 'dossier'],
  ];

  it.each(CASES)('%s — the notify node receives a non-empty `message`', (chainId, sourceSuffix) => {
    const def = expandChain(getChain(chainId)!.chain, { params: { orgId: 'org1', attendeeCompanyId: 'c1' } });
    const graph = buildGraph(def);
    const snap = freshSnapshot(def);
    for (const n of def.nodes) {
      if (n.typeId === 'feature.notifications.nodes.notify') continue;
      snap.nodeState.set(n.nodeId, 'completed');
      snap.nodeOutputs.set(n.nodeId, n.nodeId.endsWith(sourceSuffix) ? { content: DRAFT_BODY } : { summary: {}, deals: [], tasks: [], company: null, events: [] });
    }
    const notify = def.nodes.find((n) => n.typeId === 'feature.notifications.nodes.notify')!;
    const inputs = buildNodeInputs(notify.nodeId, graph, snap, {});
    expect(inputs.message, `${chainId} must port-qualify its delivery edge`).toBe(DRAFT_BODY);
  });

  it('board-update delivers the APPROVED artifact as the message body', async () => {
    const { inputs } = await deliverVerdict('approve');
    expect(inputs.message).toBe(DRAFT_BODY);
  });
});

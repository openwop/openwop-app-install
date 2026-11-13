/**
 * ADR 1058 PR-B — RFC 0258 §C.4's history size cap, `ctx.loopback`, the chat
 * gate deferring to the host's count, and the chain loader carrying the edge.
 *
 *  - The cap is measured over the JCS (RFC 8785) serialization of the recorded
 *    outputs, so two key orders of one value measure the same, and an over-cap
 *    round becomes `{truncated: true, bytes}` with its `refineFeedback` kept.
 *  - `core.chat.approvalGate` under `ctx.loopback` writes no variable-bag
 *    bookkeeping (the bag does not replay) and refuses a non-protocol verb
 *    typed (a `request-changes` would complete the gate as `refine` WITHOUT the
 *    host taking the loopback, releasing its forward edges). Without
 *    `ctx.loopback` it keeps its legacy behaviour.
 *  - `expandChain` carries a fragment edge's `loopback` onto the expanded edge
 *    through `normalizeEdgeLoopback`, and refuses it `capability_required`
 *    with the host flag off.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  capHistoryOutputs,
  LOOPBACK_MAX_HISTORY_ENTRY_BYTES,
  LOOPBACK_MIN_HISTORY_ENTRY_BYTES,
  rebuildLoopbackHistory,
} from '../src/executor/loopback.js';
import { expandChain, type WorkflowChain } from '../src/host/workflowChainPackLoader.js';
import { HISTORY_BYTES_FIELD, HISTORY_TRUNCATED_FIELD, LOOPBACK_MARKER_WRITE_KEY } from '../src/executor/loopbackWire.js';

const chatPackUrl = new URL('../../../packs/vendor.myndhyve.chat/index.mjs', import.meta.url).href;
type GateFn = (ctx: Record<string, unknown>) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string } }>;
const loadGate = async (): Promise<GateFn> => ((await import(/* @vite-ignore */ chatPackUrl)) as { approvalGate: GateFn }).approvalGate;

describe('RFC 0258 §C.4 — the history entry cap', () => {
  it('the host cap honours the RFC floor', () => {
    expect(LOOPBACK_MAX_HISTORY_ENTRY_BYTES).toBeGreaterThanOrEqual(LOOPBACK_MIN_HISTORY_ENTRY_BYTES);
    expect(LOOPBACK_MIN_HISTORY_ENTRY_BYTES).toBe(4096);
  });

  it('measures the JCS bytes: key order does not change the size, and an over-cap value becomes the typed marker', () => {
    const a = { title: 'é'.repeat(10), body: 'x'.repeat(20) };
    const b = { body: 'x'.repeat(20), title: 'é'.repeat(10) };
    // JCS: {"body":"xxxxxxxxxxxxxxxxxxxx","title":"éééééééééé"}: 2-byte é.
    const jcsBytes = Buffer.byteLength('{"body":"' + 'x'.repeat(20) + '","title":"' + 'é'.repeat(10) + '"}', 'utf8');
    expect(capHistoryOutputs(a, jcsBytes)).toBe(a);
    expect(capHistoryOutputs(a, jcsBytes - 1)).toEqual({ [HISTORY_TRUNCATED_FIELD]: true, [HISTORY_BYTES_FIELD]: jcsBytes });
    expect(capHistoryOutputs(b, jcsBytes - 1)).toEqual(capHistoryOutputs(a, jcsBytes - 1));
  });

  it('an over-cap round keeps its round and feedback; an under-cap round is unchanged', () => {
    const marker = (round: number) => ({ edgeId: 'again', targetNodeId: 'draft', round, rearmed: ['draft', 'gate'] });
    const fb = (text: string) => ({ action: 'refine', refineFeedback: { scope: 'whole', text } });
    const events = [
      { type: 'node.completed', nodeId: 'draft', payload: { outputs: { candidate: 'y'.repeat(5000) } } },
      { type: 'interrupt.resolved', nodeId: 'gate', payload: fb('shorter') },
      { type: 'node.completed', nodeId: 'gate', payload: { [LOOPBACK_MARKER_WRITE_KEY]: marker(1) } },
      { type: 'node.completed', nodeId: 'draft', payload: { outputs: { candidate: 'short' } } },
      { type: 'interrupt.resolved', nodeId: 'gate', payload: fb('again') },
      { type: 'node.completed', nodeId: 'gate', payload: { [LOOPBACK_MARKER_WRITE_KEY]: marker(2) } },
    ];
    const region = { gateNodeId: 'gate', targetNodeId: 'draft', edge: { edgeId: 'again' } };
    const history = rebuildLoopbackHistory(events, region, 4096);
    expect(history).toEqual([
      { round: 1, outputs: { truncated: true, bytes: Buffer.byteLength(JSON.stringify({ candidate: 'y'.repeat(5000) }), 'utf8') }, refineFeedback: { scope: 'whole', text: 'shorter' } },
      { round: 2, outputs: { candidate: 'short' }, refineFeedback: { scope: 'whole', text: 'again' } },
    ]);
  });
});

function gateCtx(resume: Record<string, unknown>, loopback?: Record<string, unknown>) {
  const writes: string[] = [];
  return {
    writes,
    ctx: {
      runId: 'r1',
      nodeId: 'review',
      config: { title: 'Review', actions: ['accept', 'reject', 'refine'] },
      inputs: { artifact: { text: 'draft' } },
      ...(loopback ? { loopback } : {}),
      variables: { get: () => undefined, set: (k: string) => { writes.push(k); } },
      suspend: async () => resume,
    },
  };
}

describe('ADR 1058 D7 — core.chat.approvalGate defers to the host count under ctx.loopback', () => {
  const LB = { round: 1, maxIterations: 3, exhausted: false };

  it('a refine under a loopback writes no variable-bag bookkeeping', async () => {
    const gate = await loadGate();
    const { ctx, writes } = gateCtx({ action: 'refine', refineFeedback: { scope: 'whole', text: 'darker' }, feedback: 'darker' }, LB);
    const out = await gate(ctx);
    expect(out.status).toBe('success');
    expect(out.outputs?.['decision']).toBe('refine');
    expect(writes).toEqual([]);
  });

  it('a legacy spelling under a loopback is refused typed, not read as refine', async () => {
    const gate = await loadGate();
    for (const action of ['request-changes', 'defer']) {
      const out = await gate(gateCtx({ action }, LB).ctx);
      expect(out.status, action).toBe('failure');
      expect(out.error?.code, action).toBe('approval_action_unknown');
    }
  });

  it('without ctx.loopback the legacy behaviour is unchanged (counter written, request-changes is refine)', async () => {
    const gate = await loadGate();
    const { ctx, writes } = gateCtx({ action: 'request-changes', feedback: 'x' });
    const out = await gate(ctx);
    expect(out.outputs?.['decision']).toBe('refine');
    expect(writes).toContain('_loopbackCount:review');
  });
});

describe('RFC 0258 §F — the chain loader carries a fragment edge\'s loopback', () => {
  afterEach(() => { delete process.env.OPENWOP_BOUNDED_LOOPBACK; });
  const chain = (): WorkflowChain => ({
    chainId: 'test.adr1058.loop',
    version: '1.0.0',
    label: 'Loop',
    description: 'draft → review ↺',
    parameters: { type: 'object', properties: {} },
    dag: {
      nodes: [
        { id: 'draft', typeId: 'core.noop' },
        { id: 'review', typeId: 'core.approvalGate', config: { actions: ['accept', 'reject', 'refine'] } },
      ],
      edges: [
        { from: 'draft', to: 'review' },
        { from: 'review', to: 'draft', loopback: { on: 'refine', maxIterations: 3, historyInput: 'rounds' } },
      ],
    },
  } as WorkflowChain);

  it('expands the loopback verbatim (flag on)', () => {
    process.env.OPENWOP_BOUNDED_LOOPBACK = 'true';
    const def = expandChain(chain());
    const loops = (def.edges ?? []).filter((e) => e.loopback);
    expect(loops).toHaveLength(1);
    expect(loops[0]!.loopback).toEqual({ on: 'refine', maxIterations: 3, historyInput: 'rounds' });
  });

  it('refuses it capability_required with the flag off (never dropped)', () => {
    delete process.env.OPENWOP_BOUNDED_LOOPBACK;
    expect(() => expandChain(chain())).toThrow(expect.objectContaining({ code: 'capability_required' }));
  });
});

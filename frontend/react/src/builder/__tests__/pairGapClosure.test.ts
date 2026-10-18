/**
 * ADR 0773 P6–P9 gap closure — the store-level promises:
 *   G-06a narration describes the person's edits and NEVER the AI's kept ones;
 *   G-03b restore, G-03e keep-edited, G-03f force ("Use the AI's") on a stale
 *   VALUE op only; G-05a an append batch keeps local decisions;
 *   G-03a the undo toast undoes exactly its keep; G-01d the ⌘K free-text row.
 *
 * Sabotage that turns it red: dropping the rename phrase or the narration
 * pause, restore/keep-edited/force no-ops, forcing a STRUCTURAL op, an append
 * that resets local decisions or marks every op landing, an undo that does not
 * undo, a query source that does not unregister, or the template lane waiting
 * on a chat conversation id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBuilderStore } from '../store/builderStore.js';
import { templateConversationId, usePairStore } from '../pair/pairStore.js';
import { describeEdits, narrationLine, startNarration } from '../pair/narrate.js';
import type { WorkflowEditSuggestion } from '../pair/suggestionModel.js';
import type { BuilderNode } from '../schema/workflow.js';
import { getQueryCommandSources, registerQueryCommandSource } from '../../ui/commandContributions.js';
import { getToasts, dismiss } from '../../ui/toast.js';
import { getSuggestion, suggestFromChain } from '../pair/pairClient.js';

vi.mock('../persistence/backendStore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../persistence/backendStore.js')>()),
  saveWorkflow: vi.fn(async () => ({})),
}));
vi.mock('../pair/pairClient.js', () => ({
  getSuggestion: vi.fn(),
  listRoomSuggestions: vi.fn(async () => []),
  patchSuggestion: vi.fn(async () => ({})),
  putPairContext: vi.fn(async () => ({ selection: { nodeIds: [], edgeIds: [] }, droppedIds: [] })),
  suggestFromChain: vi.fn(async () => ({ suggestionId: 'x' })),
  PairRequestError: class extends Error {},
}));

const node = (id: string, name: string, config: Record<string, unknown> = {}): BuilderNode =>
  ({ id, kind: 'noop', name, position: { x: 0, y: 0 }, config });

const base: WorkflowEditSuggestion = {
  id: 's', workflowId: 'wf', conversationId: 'c', requestedBy: 'u', baseRevision: 'r', summary: '',
  visibility: 'private', createdAt: '', updatedAt: '', opState: ['pending', 'pending'],
  ops: [
    { op: { kind: 'setConfig', nodeId: 'a', path: 'threshold', value: 50 }, dependsOn: [], preimages: [{ path: 'nodes.a.config.threshold', present: true, value: 40 }], gateSensitive: false, summary: 'threshold', why: 'Stricter.' },
    { op: { kind: 'addNode', nodeId: 'sg_s_1', typeId: 'core.noop', name: 'New' }, dependsOn: [], preimages: [{ path: 'nodes.sg_s_1', present: false }], gateSensitive: false, summary: 'Add New' },
  ],
};

beforeEach(() => {
  // Module-level mocks: a queued Once from one case must not answer another.
  vi.mocked(getSuggestion).mockReset();
  vi.mocked(suggestFromChain).mockClear();
});

afterEach(() => {
  usePairStore.getState().reset();
  for (const t of getToasts()) dismiss(t.id);
  vi.useRealTimers();
});

describe('G-06a — narration', () => {
  it('describes the person\'s edits and ignores layout', () => {
    const before = { nodes: [node('a', 'Score')], edges: [] };
    const after = {
      nodes: [{ ...node('a', 'Score lead', { t: 1 }), position: { x: 99, y: 99 } }, node('b', 'CRM')],
      edges: [{ id: 'e', source: 'a', sourcePort: 'out', target: 'b', targetPort: 'in' }],
    };
    const phrases = describeEdits(before, after);
    expect(phrases.length).toBe(4); // renamed, configured, added, connected — and NOT the move
    expect(narrationLine(phrases)).toBeTruthy();
    expect(describeEdits(before, { nodes: [{ ...node('a', 'Score'), position: { x: 5, y: 5 } }], edges: [] })).toEqual([]);
  });

  it('a KEPT suggestion is never narrated as the person\'s edit', async () => {
    vi.useFakeTimers();
    useBuilderStore.setState({ workflowId: 'wf', nodes: [node('a', 'A', { threshold: 40 })], edges: [], past: [], future: [] });
    const stop = startNarration();
    try {
      usePairStore.setState({ conversationId: 'c', suggestion: base, opState: ['pending', 'pending'] });
      usePairStore.getState().keep([0]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(usePairStore.getState().narration).toEqual([]);
      useBuilderStore.getState().updateNode('a', { name: 'Renamed by hand' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(usePairStore.getState().narration).toHaveLength(1);
    } finally {
      stop();
    }
  });
});

describe('G-03b/e/f — restore, keep edited, use the AI\'s', () => {
  it('restore returns a dropped op to pending', () => {
    useBuilderStore.setState({ workflowId: 'wf', nodes: [node('a', 'A', { threshold: 40 })], edges: [] });
    usePairStore.setState({ conversationId: 'c', suggestion: base, opState: ['dropped', 'pending'] });
    usePairStore.getState().restore([0]);
    expect(usePairStore.getState().opState[0]).toBe('pending');
  });

  it('keep-edited applies the EDITED value as the kept change', () => {
    useBuilderStore.setState({ workflowId: 'wf', nodes: [node('a', 'A', { threshold: 40 })], edges: [] });
    usePairStore.setState({ conversationId: 'c', suggestion: base, opState: ['pending', 'pending'] });
    expect(usePairStore.getState().keepEdited(0, 70).kept).toEqual([0]);
    expect(useBuilderStore.getState().nodes[0]!.config).toEqual({ threshold: 70 });
  });

  it('"Use the AI\'s" forces a STALE value op, and refuses a structural one', () => {
    // Both ops are STALE: the threshold moved, and a step with the suggested
    // add's id is already on the sheet. So only the value-op rule (not the
    // staleness check) can refuse the structural one.
    useBuilderStore.setState({ workflowId: 'wf', nodes: [node('a', 'A', { threshold: 45 }), node('sg_s_1', 'Already here')], edges: [] });
    usePairStore.setState({ conversationId: 'c', suggestion: base, opState: ['pending', 'pending'] });
    expect(usePairStore.getState().statuses()).toEqual(['stale', 'stale']);
    expect(usePairStore.getState().forceKeep(0).kept).toEqual([0]);
    expect(useBuilderStore.getState().nodes[0]!.config).toEqual({ threshold: 50 });
    // addNode is never forceable: refused outright (not attempted and skipped).
    expect(usePairStore.getState().forceKeep(1)).toEqual({ kept: [], skipped: [] });
    expect(usePairStore.getState().opState[1]).toBe('pending');
  });
});

describe('G-05a — append batches', () => {
  it('a refresh with MORE ops keeps local decisions and marks the new ops as landing', async () => {
    useBuilderStore.setState({ workflowId: 'wf', nodes: [node('a', 'A', { threshold: 40 })], edges: [] });
    usePairStore.setState({ conversationId: 'c', suggestion: { ...base, ops: [base.ops[0]!], opState: ['pending'] }, opState: ['dropped'] });
    vi.mocked(getSuggestion).mockResolvedValueOnce(base);
    await usePairStore.getState().refresh();
    expect(usePairStore.getState().opState).toEqual(['dropped', 'pending']);
    expect(usePairStore.getState().landing).toEqual([1]);
  });
});

describe('G-03a — the auto-keep undo toast', () => {
  it('auto-keep shows an Undo that restores exactly that keep', async () => {
    useBuilderStore.setState({ workflowId: 'wf', nodes: [node('a', 'A', { threshold: 40 })], edges: [], selectedNodeIds: ['a'], past: [], future: [] });
    usePairStore.setState({ conversationId: 'c', autoKeep: true });
    vi.mocked(getSuggestion).mockResolvedValueOnce({ ...base, ops: [base.ops[0]!], opState: ['pending'] });
    await usePairStore.getState().refresh();
    expect(useBuilderStore.getState().nodes[0]!.config).toEqual({ threshold: 50 });
    const t = getToasts().find((x) => x.action);
    expect(t, 'an auto-keep must show a visible undo').toBeDefined();
    t!.action!.run();
    expect(useBuilderStore.getState().nodes[0]!.config).toEqual({ threshold: 40 });
    expect(usePairStore.getState().opState[0]).toBe('pending');
  });
});

describe('G-01d — ⌘K free text', () => {
  it('a registered query source yields a row built from what was typed, and unregisters', () => {
    const run = vi.fn();
    const off = registerQueryCommandSource('t', (q) => ({ id: 'ask', label: `Ask: ${q}`, hint: '', group: 'g', icon: () => null, run }));
    expect(getQueryCommandSources()[0]!('add a branch')?.label).toBe('Ask: add a branch');
    off();
    expect(getQueryCommandSources()).toHaveLength(0);
  });
});

describe('G-10a — a template needs no chat conversation', () => {
  it('with no chat conversation (no provider), the template lane addresses its own suggestion', async () => {
    useBuilderStore.setState({ workflowId: 'wf', nodes: [], edges: [] });
    usePairStore.setState({ conversationId: null });
    vi.mocked(getSuggestion).mockResolvedValueOnce(null);
    const r = await usePairStore.getState().suggestFromChain('chain.x');
    expect(r.ok).toBe(true);
    expect(vi.mocked(suggestFromChain)).toHaveBeenCalledWith({ conversationId: templateConversationId('wf'), workflowId: 'wf', chainId: 'chain.x' });
    expect(usePairStore.getState().conversationId).toBe(templateConversationId('wf'));
  });
});

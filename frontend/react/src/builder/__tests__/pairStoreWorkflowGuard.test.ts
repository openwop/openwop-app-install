/**
 * ADR 0773 review CR-2 — a conversation outlives a workflow switch, so the
 * suggestion it holds can be about ANOTHER workflow. Keep / keep-all must never
 * apply it to the workflow now open.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBuilderStore } from '../store/builderStore.js';
import { usePairStore } from '../pair/pairStore.js';
import type { WorkflowEditSuggestion } from '../pair/suggestionModel.js';

vi.mock('../pair/pairClient.js', () => ({
  getSuggestion: vi.fn(),
  listRoomSuggestions: vi.fn(async () => []),
  patchSuggestion: vi.fn(async () => ({})),
  putPairContext: vi.fn(async () => ({ selection: { nodeIds: [], edgeIds: [] }, droppedIds: [] })),
  PairRequestError: class extends Error {},
}));

const aSuggestion: WorkflowEditSuggestion = {
  id: 's', workflowId: 'wf.A', conversationId: 'c', requestedBy: 'u', baseRevision: 'r', summary: '',
  visibility: 'private', createdAt: '', updatedAt: '', opState: ['pending'],
  ops: [{ op: { kind: 'addNode', nodeId: 'sg_s_1', typeId: 'core.noop', name: 'From A' }, dependsOn: [], preimages: [{ path: 'nodes.sg_s_1', present: false }], gateSensitive: false, summary: 'Add' }],
};

afterEach(() => { usePairStore.getState().reset(); });

describe('ADR 0773 CR-2 — suggestions never cross workflows', () => {
  it('keepAll refuses a suggestion about another workflow', () => {
    useBuilderStore.setState({ workflowId: 'wf.B', nodes: [], edges: [] });
    usePairStore.setState({ conversationId: 'c', suggestion: aSuggestion, opState: ['pending'] });
    const r = usePairStore.getState().keepAll();
    expect(r.kept).toEqual([]);
    expect(useBuilderStore.getState().nodes).toEqual([]);
  });

  it('refresh drops a fetched suggestion about another workflow', async () => {
    const { getSuggestion } = await import('../pair/pairClient.js');
    vi.mocked(getSuggestion).mockResolvedValueOnce(aSuggestion);
    useBuilderStore.setState({ workflowId: 'wf.B', nodes: [], edges: [] });
    usePairStore.setState({ conversationId: 'c' });
    await usePairStore.getState().refresh();
    expect(usePairStore.getState().suggestion).toBeNull();
  });

  it('the same suggestion keeps on its own workflow (the guard is not a blanket refusal)', () => {
    useBuilderStore.setState({ workflowId: 'wf.A', nodes: [], edges: [] });
    usePairStore.setState({ conversationId: 'c', suggestion: aSuggestion, opState: ['pending'] });
    expect(usePairStore.getState().keepAll().kept).toEqual([0]);
    expect(useBuilderStore.getState().nodes.map((n) => n.id)).toEqual(['sg_s_1']);
  });
});

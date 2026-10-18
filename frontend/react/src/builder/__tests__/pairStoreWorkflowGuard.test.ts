/**
 * ADR 0773 review CR-2 — a conversation outlives a workflow switch, so the
 * suggestion it holds can be about ANOTHER workflow. Keep / keep-all must never
 * apply it to the workflow now open.
 *
 * The guard is ONE helper (`current()` in pairStore) that every read and write
 * path calls. DOUBLE GUARD, recorded: `keepAll` calls it and then `keep` calls
 * it again, so sabotaging either call site alone is caught by the other — the
 * probe that matters is on the shared helper. Sabotage: `current()` returning
 * its input reds the two refusal cases; returning null reds the control.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSuggestion } from '../pair/pairClient.js';
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

afterEach(() => { usePairStore.getState().reset(); vi.mocked(getSuggestion).mockReset(); });

describe('ADR 0773 CR-2 — suggestions never cross workflows', () => {
  it('keepAll refuses a suggestion about another workflow', () => {
    useBuilderStore.setState({ workflowId: 'wf.B', nodes: [], edges: [] });
    usePairStore.setState({ conversationId: 'c', suggestion: aSuggestion, opState: ['pending'] });
    const r = usePairStore.getState().keepAll();
    expect(r.kept).toEqual([]);
    expect(useBuilderStore.getState().nodes).toEqual([]);
  });

  it('refresh drops a fetched suggestion about another workflow', async () => {
    vi.mocked(getSuggestion).mockResolvedValueOnce(aSuggestion);
    useBuilderStore.setState({ workflowId: 'wf.B', nodes: [], edges: [] });
    // A prior suggestion for THIS workflow is held, so "null after" means the
    // refresh replaced it — not that nothing ever happened.
    usePairStore.setState({ conversationId: 'c', suggestion: { ...aSuggestion, id: 'prior', workflowId: 'wf.B' }, opState: ['pending'] });
    await usePairStore.getState().refresh();
    expect(vi.mocked(getSuggestion)).toHaveBeenCalledWith('c');
    expect(usePairStore.getState().suggestion).toBeNull();
  });

  it('refresh keeps a fetched suggestion about the open workflow (control)', async () => {
    vi.mocked(getSuggestion).mockResolvedValueOnce(aSuggestion);
    useBuilderStore.setState({ workflowId: 'wf.A', nodes: [], edges: [] });
    usePairStore.setState({ conversationId: 'c' });
    await usePairStore.getState().refresh();
    expect(usePairStore.getState().suggestion?.id).toBe('s');
  });

  it('the same suggestion keeps on its own workflow (the guard is not a blanket refusal)', () => {
    useBuilderStore.setState({ workflowId: 'wf.A', nodes: [], edges: [] });
    usePairStore.setState({ conversationId: 'c', suggestion: aSuggestion, opState: ['pending'] });
    expect(usePairStore.getState().keepAll().kept).toEqual([0]);
    expect(useBuilderStore.getState().nodes.map((n) => n.id)).toEqual(['sg_s_1']);
  });
});

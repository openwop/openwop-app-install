/**
 * ADR 0773 P11 — the canvas-parity details, at the store level:
 *   stepping onto a VALUE change flips to Inspect with its node selected; a
 *   structural change does not; Esc tucks the review away and J brings it back;
 *   a run step cited from the drawer attaches its run; ⌘. asks for the inline
 *   prompt.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBuilderStore } from '../store/builderStore.js';
import { usePairStore } from '../pair/pairStore.js';
import type { WorkflowEditSuggestion } from '../pair/suggestionModel.js';
import type { BuilderNode } from '../schema/workflow.js';

vi.mock('../pair/pairClient.js', () => ({
  getSuggestion: vi.fn(),
  listRoomSuggestions: vi.fn(async () => []),
  patchSuggestion: vi.fn(async () => ({})),
  putPairContext: vi.fn(async () => ({ selection: { nodeIds: [], edgeIds: [] }, droppedIds: [] })),
  suggestFromChain: vi.fn(async () => ({ suggestionId: 'x' })),
  PairRequestError: class extends Error {},
}));

const node = (id: string, config: Record<string, unknown> = {}): BuilderNode =>
  ({ id, kind: 'noop', name: id, position: { x: 0, y: 0 }, config });

// op 0 is structural (a new step), op 1 is a value change on an existing node.
const suggestion: WorkflowEditSuggestion = {
  id: 's', workflowId: 'wf', conversationId: 'c', requestedBy: 'u', baseRevision: 'r', summary: '',
  visibility: 'private', createdAt: '', updatedAt: '', opState: ['pending', 'pending'],
  ops: [
    { op: { kind: 'addNode', nodeId: 'sg_s_1', typeId: 'core.noop', name: 'New' }, dependsOn: [], preimages: [{ path: 'nodes.sg_s_1', present: false }], gateSensitive: false, summary: 'Add New' },
    { op: { kind: 'setConfig', nodeId: 'a', path: 'threshold', value: 50 }, dependsOn: [], preimages: [{ path: 'nodes.a.config.threshold', present: true, value: 40 }], gateSensitive: false, summary: 'threshold' },
  ],
};

function arrange(): void {
  useBuilderStore.setState({ workflowId: 'wf', nodes: [node('a', { threshold: 40 })], edges: [], selectedNodeIds: [] });
  usePairStore.setState({ conversationId: 'c', suggestion, opState: ['pending', 'pending'], focusedOp: null, tab: 'pair', reviewOpen: true });
}

afterEach(() => { usePairStore.getState().reset(); });

describe('P11 — stepping reveals value changes in the Inspector', () => {
  it('a structural change keeps the Pair tab; a value change flips to Inspect with its node selected', () => {
    arrange();
    usePairStore.getState().step(1);
    expect(usePairStore.getState().focusedOp).toBe(0);
    expect(usePairStore.getState().tab).toBe('pair');

    usePairStore.getState().step(1);
    expect(usePairStore.getState().focusedOp).toBe(1);
    expect(usePairStore.getState().tab).toBe('inspect');
    expect(useBuilderStore.getState().selectedNodeIds).toEqual(['a']);
  });
});

describe('P11 — Esc tucks the review away', () => {
  it('closeReview hides it and clears the focus; J brings it back', () => {
    arrange();
    usePairStore.getState().step(1);
    usePairStore.getState().closeReview();
    expect(usePairStore.getState().reviewOpen).toBe(false);
    expect(usePairStore.getState().focusedOp).toBeNull();
    // the changes themselves are untouched
    expect(usePairStore.getState().opState).toEqual(['pending', 'pending']);
    usePairStore.getState().step(1);
    expect(usePairStore.getState().reviewOpen).toBe(true);
  });
});

describe('P11 — a run step cited from the run drawer', () => {
  it('cites its node and attaches its run', () => {
    arrange();
    usePairStore.setState({ tab: 'inspect' });
    usePairStore.getState().citeRunStep('a', 'run-1');
    const s = usePairStore.getState();
    expect(s.cited).toContain('a');
    expect(s.lastRunId).toBe('run-1');
    expect(s.tab).toBe('pair');
  });
});

describe('P11 — ⌘. asks for the inline prompt', () => {
  it('records the target until a toolbar takes it', () => {
    usePairStore.getState().requestInlineAsk('a');
    expect(usePairStore.getState().inlineAskFor).toBe('a');
    usePairStore.getState().requestInlineAsk(null);
    expect(usePairStore.getState().inlineAskFor).toBeNull();
  });
});

describe('the rail opens on Inspect (the properties rail)', () => {
  it('a fresh store starts on Inspect; an ask switches to Pair', () => {
    usePairStore.setState(usePairStore.getInitialState());
    expect(usePairStore.getState().tab).toBe('inspect');
    usePairStore.getState().ask('what does this do?');
    expect(usePairStore.getState().tab).toBe('pair');
  });
});

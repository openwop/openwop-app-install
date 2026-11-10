/** BUILDER-PORT-1 (ADR 0440 + ADR 0773 corrections, 2026-11-07): the canvas,
 * inspector, Pair insertion and proposal ghosts show an omitted source output as
 * a separate non-connectable "Default output" handle and an unknown explicit
 * name as "Missing output: <name>", without changing the canonical wire binding.
 * Real node/edge components; only XYFlow geometry primitives are replaced, so
 * this proves labels, handle ids, refresh requests and serialized bindings, not
 * browser hit-testing or rendered Bezier coordinates. Expected handle ids are
 * literals derived by hand (fixed 4-hex UTF-16 units), never computed with
 * `sourceOutput.ts`.
 *
 * Sabotage, each witnessed red (wave 97): BuilderCanvas edge `sourceHandle` back
 * to `e.sourcePort`; virtual handle made connectable; the BaseNode refresh
 * signature reduced to a count, or the refresh made to fire on any data change;
 * the canvas projection pinned to 'en'; EdgeInspector type text; PairEdge's first
 * leg taking `sourcePort`; ghost `sourcePort` not projected; applied
 * `canonicalSourceOutput` defaulting to 'out'; `sourceOutputForWire(null)`
 * returning the placeholder. */
import type { ComponentProps, ReactNode } from 'react';
import i18n, { setLocale } from '../../i18n/index.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react';
import { Position, type ReactFlowProps } from '@xyflow/react';
import { BuilderCanvas } from '../canvas/BuilderCanvas.js';
import { BaseNode } from '../canvas/nodes/BaseNode.js';
import { PairEdge } from '../pair/PairEdge.js';
import { EdgeInspector } from '../inspector/EdgeInspector.js';
import { serializeWorkflow } from '../schema/serialize.js';
import { cancelPendingBackendSync, useBuilderStore } from '../store/builderStore.js';
import { projectGhosts, ghostEdgeHandles, type WorkflowEditSuggestion } from '../pair/suggestionModel.js';
import type { SavedWorkflow } from '../schema/workflow.js';
const DEFAULT_HANDLE = '__openwop_default_output';
// 'unavailable' as fixed-width UTF-16 code units: u n a v a i l a b l e.
const MISSING_UNAVAILABLE = '__openwop_missing_output:0075006e0061007600610069006c00610062006c0065';
const geometry = vi.hoisted(() => ({ updateNodeInternals: vi.fn() }));
vi.mock('@xyflow/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return { ...actual,
    useUpdateNodeInternals: () => geometry.updateNodeInternals,
    Handle: ({ id, type, isConnectable }: { id?: string; type: string; isConnectable?: boolean }) => <span data-testid={`handle-${id}`} data-side={type} data-connectable={String(isConnectable !== false)} />,
    ReactFlow: ({ nodes = [], edges = [], children }: ReactFlowProps) => <div>
      {nodes.filter(n => n.type === 'builder').map(n => <BaseNode key={n.id} id={n.id} type="builder" data={n.data} selected={false} dragging={false} draggable selectable deletable isConnectable zIndex={0} positionAbsoluteX={n.position.x} positionAbsoluteY={n.position.y} />)}
      {edges.map(e => <output key={e.id} data-testid={`edge-${e.id}`} data-source-handle={e.sourceHandle} />)}
      {children}
    </div>,
    BaseEdge: () => null,
    EdgeLabelRenderer: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});
const wf: SavedWorkflow = { id: 'wf.presentation', name: 'Presentation', version: '1.0.0', createdAt: 'now', updatedAt: 'now', nodes: [
  { id: 'a', kind: 'noop', name: 'Source', position: { x: 0, y: 0 }, config: {} },
  { id: 'b', kind: 'noop', name: 'Target', position: { x: 0, y: 180 }, config: {} },
], edges: [{ id: 'e', source: 'a', sourcePort: 'out', canonicalSourceOutput: null, target: 'b', targetPort: 'in' }] };
function firstFixtureEdge() {
  const edge = wf.edges[0];
  if (!edge) throw new Error('Presentation fixture edge missing');
  return edge;
}
beforeEach(() => { geometry.updateNodeInternals.mockClear(); localStorage.clear(); useBuilderStore.getState().loadFromSaved(wf); });
afterEach(() => { cleanup(); cancelPendingBackendSync(); vi.unstubAllGlobals(); localStorage.clear(); });
it('actual BuilderCanvas projects its default edge onto the distinct labeled BaseNode handle', () => {
  render(<BuilderCanvas />);
  expect(screen.getByText('Default output')).toBeTruthy();
  expect(screen.getByTestId('handle-' + DEFAULT_HANDLE).getAttribute('data-connectable')).toBe('false');
  expect(screen.getByTestId('edge-e').getAttribute('data-source-handle')).toBe(DEFAULT_HANDLE);
  expect(screen.getAllByTestId('handle-out')).toHaveLength(2);
});
it('actual Canvas keeps a missing explicit output visible as unresolved, without a named fallback', () => {
  useBuilderStore.getState().loadFromSaved({ ...wf, edges: [{ ...firstFixtureEdge(), canonicalSourceOutput: 'unavailable' }] });
  render(<BuilderCanvas />);
  expect(screen.getByText('Missing output: unavailable')).toBeTruthy();
  expect(screen.queryByText('Default output')).toBeNull();
  expect(screen.getByTestId('edge-e').getAttribute('data-source-handle')).toBe(MISSING_UNAVAILABLE);
  expect(serializeWorkflow(useBuilderStore.getState().snapshot()).edges[0]).toHaveProperty('sourceOutput', 'unavailable');
});
it('requests XYFlow handle refresh for same-size missing IDs and layout changes, but not a non-binding label', () => {
  const missing = (name: string) => ({ ...wf, edges: [{ ...firstFixtureEdge(), canonicalSourceOutput: name }] });
  useBuilderStore.getState().loadFromSaved(missing('a'));
  render(<BuilderCanvas />);
  expect(geometry.updateNodeInternals).toHaveBeenCalledWith('a');
  expect(screen.getByText('Missing output: a')).toBeTruthy();
  geometry.updateNodeInternals.mockClear();
  act(() => { useBuilderStore.getState().loadFromSaved(missing('b')); });
  expect(geometry.updateNodeInternals.mock.calls).toEqual([['a']]);
  expect(screen.getByText('Missing output: b')).toBeTruthy();
  expect(screen.queryByText('Missing output: a')).toBeNull();
  geometry.updateNodeInternals.mockClear();
  act(() => { useBuilderStore.getState().updateEdge('e', { label: 'No port layout change' }); });
  expect(geometry.updateNodeInternals).not.toHaveBeenCalled();
  act(() => { useBuilderStore.getState().loadFromSaved({ ...wf, edges: [] }); });
  expect(geometry.updateNodeInternals.mock.calls).toEqual([['a']]);
  expect(screen.queryByText('Missing output: b')).toBeNull();
});
it('same graph locale change refreshes default and missing labels without changing wire bindings', async () => {
  const previous = i18n.language;
  try {
    await setLocale('en');
    useBuilderStore.getState().loadFromSaved({ ...wf, edges: [firstFixtureEdge(), { ...firstFixtureEdge(), id: 'missing', canonicalSourceOutput: 'unavailable' }] });
    const before = serializeWorkflow(useBuilderStore.getState().snapshot());
    render(<BuilderCanvas />);
    expect(screen.getByText('Default output')).toBeTruthy();
    expect(screen.getByText('Missing output: unavailable')).toBeTruthy();
    await act(async () => { await setLocale('pt-BR'); });
    expect(screen.getByText('Saída padrão')).toBeTruthy();
    expect(screen.getByText('Saída não encontrada: unavailable')).toBeTruthy();
    expect(screen.queryByText('Default output')).toBeNull();
    expect(screen.queryByText('Missing output: unavailable')).toBeNull();
    expect(serializeWorkflow(useBuilderStore.getState().snapshot())).toEqual(before);
  } finally {
    cleanup();
    await act(async () => { await setLocale(previous); });
  }
});
it('real EdgeInspector non-binding label edit retains canonical omission and describes its type', () => {
  render(<EdgeInspector edge={firstFixtureEdge()} />);
  expect(screen.getByText('Source output: Default output (any)')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Label (optional)'), { target: { value: 'Still default' } });
  const result = serializeWorkflow(useBuilderStore.getState().snapshot());
  expect(result.edges[0]).toMatchObject({ label: 'Still default' });
  expect(result.edges[0]).not.toHaveProperty('sourceOutput');
});
it('actual Pair midpoint insertion preserves omitted first leg and explicit named second leg as one undo', () => {
  const props: ComponentProps<typeof PairEdge> = { id: 'e', source: 'a', target: 'b', sourceX: 0, sourceY: 0, targetX: 0, targetY: 180, sourcePosition: Position.Bottom, targetPosition: Position.Top, selected: true, selectable: true, deletable: true, data: { showPlus: true, sourcePort: 'out', canonicalSourceOutput: null, targetPort: 'in' } };
  render(<PairEdge {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /insert/i }));
  const noop = screen.getByRole('button', { name: 'Pass-through' });
  fireEvent.click(noop);
  const result = serializeWorkflow(useBuilderStore.getState().snapshot());
  expect(result.edges).toHaveLength(2);
  expect(result.edges.find(e => e.sourceNodeId === 'a')).not.toHaveProperty('sourceOutput');
  expect(result.edges.find(e => e.targetNodeId === 'b')).toHaveProperty('sourceOutput', 'out');
  useBuilderStore.getState().undo();
  expect(useBuilderStore.getState().edges).toEqual(wf.edges);
});
it('proposal ghost real-source attachment agrees with applied semantic binding, including unresolved names', () => {
  const suggestion: WorkflowEditSuggestion = { id: 's', workflowId: wf.id, conversationId: 'c', requestedBy: 'u', baseRevision: 'r', summary: 'Connect', visibility: 'private', createdAt: 'now', updatedAt: 'now', opState: ['pending'], ops: [{ op: { kind: 'addEdge', edgeId: 'new', sourceNodeId: 'a', targetNodeId: 'b' }, dependsOn: [], preimages: [], gateSensitive: false, summary: 'Connect' }] };
  const graph = { nodes: wf.nodes, edges: [] };
  const ghost = projectGhosts(suggestion, graph, ['pending']).ghostEdges[0];
  if (!ghost) throw new Error('Ghost was not projected');
  expect(ghostEdgeHandles(ghost, new Set()).sourceHandle).toBe(DEFAULT_HANDLE);
  useBuilderStore.getState().applyEditOps(suggestion.ops.map(o => o.op));
  expect(useBuilderStore.getState().edges.find(e => e.id === 'new')).toHaveProperty('canonicalSourceOutput', null);
  const firstOp = suggestion.ops[0];
  if (!firstOp) throw new Error('Suggestion fixture op missing');
  const explicit = { ...suggestion, ops: [{ ...firstOp, op: { kind: 'addEdge' as const, edgeId: 'missing', sourceNodeId: 'a', targetNodeId: 'b', sourceOutput: 'unavailable' } }] };
  const missingGhost = projectGhosts(explicit, graph, ['pending']).ghostEdges[0];
  if (!missingGhost) throw new Error('Missing-port ghost absent');
  expect(missingGhost.sourcePort).toBe(MISSING_UNAVAILABLE);
  useBuilderStore.getState().applyEditOps(explicit.ops.map(o => o.op));
  expect(serializeWorkflow(useBuilderStore.getState().snapshot()).edges.find(e => e.edgeId === 'missing')).toHaveProperty('sourceOutput', 'unavailable');
});

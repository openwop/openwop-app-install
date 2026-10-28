/**
 * ADR 0960 D3 — the read-only run graph's isolation and live painting.
 *
 *   - a read-only store is a separate instance: loading a graph and painting a
 *     run never touch the builder's singleton draft or local storage;
 *   - every graph-writing action on it is a no-op;
 *   - `useLiveRunOverlay` folds the log AND the live stream (de-duplicated)
 *     through the builder's own reducer, and says when the log read failed.
 *
 * Sabotage: dropping `persist` from MUTATING_ACTIONS reds "graph writes are
 * no-ops" (localStorage is written); sharing the singleton (returning
 * `useBuilderStore` from createReadOnlyBuilderStore) reds "a separate instance";
 * removing the `seen` de-dup reds "…de-duplicated".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { RunEventDoc } from '@openwop/openwop';

const h = vi.hoisted(() => ({ poll: vi.fn(), sub: vi.fn(), onEvent: null as null | ((e: RunEventDoc) => void) }));
vi.mock('../../client/runsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), pollEvents: h.poll }));
vi.mock('../../client/streamsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), subscribeToRun: h.sub }));

import { useBuilderStore } from '../../builder/store/builderStore.js';
import { MUTATING_ACTIONS, READ_ONLY_SAFE_ACTIONS, createReadOnlyBuilderStore, loadReadOnlyGraph } from '../../builder/store/readOnlyBuilderStore.js';
import { useLiveRunOverlay } from '../liveRunOverlay.js';

const ev = (sequence: number, type: string, nodeId?: string): RunEventDoc =>
  ({ runId: 'tenant/r1', sequence, type, timestamp: '2026-10-20T00:00:00Z', ...(nodeId ? { nodeId } : {}), payload: {} }) as unknown as RunEventDoc;
const node = (id: string) => ({ id, kind: 'core.noop', name: id, position: { x: 0, y: 0 }, config: {} });

beforeEach(() => {
  h.poll.mockReset(); h.sub.mockReset(); h.onEvent = null;
  h.sub.mockImplementation((_runId: string, opts: { onEvent: (e: RunEventDoc) => void }) => { h.onEvent = opts.onEvent; return { close: vi.fn() }; });
  localStorage.clear();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('read-only builder store', () => {
  it('is a separate instance: loading and painting never touch the builder draft', () => {
    useBuilderStore.setState({ workflowId: 'draft-1', nodes: [node('mine')], edges: [] });
    const ro = createReadOnlyBuilderStore();
    expect(ro).not.toBe(useBuilderStore);
    loadReadOnlyGraph(ro, { workflowId: 'run-wf', name: 'Run', nodes: [node('a'), node('b')], edges: [] });
    ro.getState().startOverlay('r1', { a: 'a', b: 'b' });
    ro.getState().applyRunEvent({ ...ev(1, 'node.started', 'a'), runId: 'r1' });
    expect(ro.getState().overlay?.nodeStatus).toEqual({ a: 'running' });
    expect(ro.getState().readOnly).toBe(true);
    expect(useBuilderStore.getState().workflowId).toBe('draft-1');
    expect(useBuilderStore.getState().nodes.map((n) => n.id)).toEqual(['mine']);
    expect(useBuilderStore.getState().overlay).toBeNull();
    expect(useBuilderStore.getState().readOnly).toBe(false);
  });

  it('graph writes are no-ops and nothing reaches local storage', () => {
    const ro = createReadOnlyBuilderStore();
    loadReadOnlyGraph(ro, { workflowId: 'run-wf', name: 'Run', nodes: [node('a')], edges: [] });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const s = ro.getState();
    s.updateNode('a', { name: 'renamed' });
    s.removeNodes(['a']);
    s.addEdge({ id: 'e', source: 'a', target: 'a', sourcePort: 'out', targetPort: 'in' } as never);
    s.setName('x');
    s.persist();
    expect(ro.getState().nodes.map((n) => n.name)).toEqual(['a']);
    expect(ro.getState().edges).toEqual([]);
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe('the read-only action partition', () => {
  it('every builder action is either no-op\'d or reviewed as safe — a new action fails here until classified', () => {
    const actions = Object.entries(useBuilderStore.getState()).filter(([, v]) => typeof v === 'function').map(([k]) => k).sort();
    const classified = new Set<string>([...MUTATING_ACTIONS, ...READ_ONLY_SAFE_ACTIONS]);
    expect(actions.filter((k) => !classified.has(k))).toEqual([]);
  });
});

describe('useLiveRunOverlay', () => {
  it('folds the log and the live stream, de-duplicated, through the builder reducer', async () => {
    const ro = createReadOnlyBuilderStore();
    loadReadOnlyGraph(ro, { workflowId: 'wf', name: 'Run', nodes: [node('a'), node('b')], edges: [] });
    h.poll.mockResolvedValue({ events: [ev(1, 'node.started', 'a'), ev(2, 'node.completed', 'a')] });
    const idMap = { a: 'a', b: 'b' };
    const { result } = renderHook(() => useLiveRunOverlay(ro, 'r1', idMap));
    await waitFor(() => expect(result.current.read).toBe('ready'));
    act(() => { h.onEvent?.(ev(2, 'node.completed', 'a')); h.onEvent?.(ev(3, 'node.suspended', 'b')); });
    await waitFor(() => expect(result.current.events.map((e) => e.sequence)).toEqual([1, 2, 3]));
    expect(ro.getState().overlay?.nodeStatus).toEqual({ a: 'completed', b: 'suspended' });
  });

  it('a late initial poll cannot rewind a node completed by the live stream', async () => {
    const ro = createReadOnlyBuilderStore();
    loadReadOnlyGraph(ro, { workflowId: 'wf', name: 'Run', nodes: [node('a')], edges: [] });
    let finish!: (value: { events: RunEventDoc[] }) => void;
    h.poll.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const idMap = { a: 'a' };
    const { result } = renderHook(() => useLiveRunOverlay(ro, 'r1', idMap));
    act(() => { h.onEvent?.(ev(3, 'node.completed', 'a')); });
    await act(async () => { finish({ events: [ev(1, 'node.started', 'a'), ev(2, 'node.suspended', 'a')] }); });
    await waitFor(() => expect(result.current.read).toBe('ready'));
    expect(result.current.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(ro.getState().overlay?.nodeStatus).toEqual({ a: 'completed' });
  });

  it('says when the event log could not be read', async () => {
    const ro = createReadOnlyBuilderStore();
    h.poll.mockRejectedValue(new Error('403'));
    const idMap = {};
    const { result } = renderHook(() => useLiveRunOverlay(ro, 'r1', idMap));
    await waitFor(() => expect(result.current.read).toBe('failed'));
  });
});

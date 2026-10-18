/**
 * ADR 0770 — the builder never loses or overwrites a user's workflow (client half).
 *
 *  - D4 (`WBWF-4`): `serialize` emits `position` always and `name` only when the
 *    author renamed the node — otherwise every reopen re-gridded the canvas.
 *  - D5 (`WBWF-6`): the autosave sends the loaded head as its base and adopts
 *    the revision the server returns.
 *  - D6 (`WBWF-12`): switching to another workflow FLUSHES the pending save
 *    instead of dropping it; reloading the SAME workflow still cancels it (the
 *    ADR 0474 restore guard).
 *  - D6 (`WBWF-5`): a refused load renders a retryable error, never a blank
 *    canvas under the real id — and Retry actually re-runs the load.
 *
 * Sabotage that turns it red: dropping `Math.round` or the catalog-default
 * check in serialize; dropping the base/revision spreads in runBackendSyncNow;
 * `if (false)` on the flush-or-cancel branch in loadFromSaved; swallowing the
 * refused load in BuilderTab, or dropping `attempt` from its effect deps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { SavedWorkflow } from '../schema/workflow.js';

type BackendStore = typeof import('../persistence/backendStore.js');
const saveWorkflow = vi.fn<BackendStore['saveWorkflow']>();
const loadWorkflow = vi.fn<BackendStore['loadWorkflowWithHead']>();
vi.mock('../persistence/backendStore.js', async (orig) => ({
  ...(await orig<typeof import('../persistence/backendStore.js')>()),
  saveWorkflow: (...a: Parameters<BackendStore['saveWorkflow']>) => saveWorkflow(...a),
  loadWorkflowWithHead: (...a: Parameters<BackendStore['loadWorkflowWithHead']>) => loadWorkflow(...a),
}));
vi.mock('../BuilderShell.js', () => ({ BuilderShell: () => <div>canvas</div> }));

const { useBuilderStore } = await import('../store/builderStore.js');
const { serializeWorkflow } = await import('../schema/serialize.js');
const { BuilderTab } = await import('../BuilderTab.js');
const { LoadRefusedError } = await import('../persistence/backendStore.js');

const wf = (id: string): SavedWorkflow => ({ id, name: id, version: '1.0.0', nodes: [], edges: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
const s = () => useBuilderStore.getState();

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('ADR 0770 D4 — node layout is serialized', () => {
  // The edits below arm the 1.5 s autosave; fake timers keep it from firing
  // into a later case on the real clock.
  beforeEach(() => { vi.useFakeTimers(); });
  it('emits position always, and name only when it differs from the catalog default', () => {
    s().loadFromSaved(wf('wf-layout'));
    const a = s().addNode('noop', { x: 12.4, y: 80 });
    const b = s().addNode('noop', { x: 300, y: 80 });
    s().updateNode(b, { name: 'Tidy the input' });
    const def = serializeWorkflow({ ...wf('wf-layout'), nodes: s().nodes, edges: s().edges });
    const byId = new Map(def.nodes.map((n) => [n.nodeId, n]));
    expect(byId.get(a)!.position).toEqual({ x: 12, y: 80 });
    expect(byId.get(a)!.name, 'an untouched node keeps its hash — no default name emitted').toBeUndefined();
    expect(byId.get(b)!.name).toBe('Tidy the input');
  });
});

describe('ADR 0770 D5/D6 — autosave base + flush', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    saveWorkflow.mockReset().mockResolvedValue({ revision: 'rev-2' });
  });

  it('saves against the loaded head and adopts the revision it returns', async () => {
    s().loadFromSaved(wf('wf-base'));
    await vi.advanceTimersByTimeAsync(0);
    saveWorkflow.mockClear(); // a prior test's pending save is (correctly) flushed on load
    s().setBaseRevision('rev-1');
    s().setName('renamed');
    await vi.advanceTimersByTimeAsync(1600);
    expect(saveWorkflow).toHaveBeenCalledTimes(1);
    expect(saveWorkflow.mock.calls[0]![1]).toMatchObject({ baseRevision: 'rev-1' });
    expect(s().baseRevision).toBe('rev-2');
  });

  it('switching workflows inside the debounce FLUSHES the pending save for the old one', async () => {
    s().loadFromSaved(wf('wf-old'));
    await vi.advanceTimersByTimeAsync(0);
    saveWorkflow.mockClear();
    s().setName('edited just before leaving');
    s().loadFromSaved(wf('wf-new'));
    await vi.advanceTimersByTimeAsync(0);
    expect(saveWorkflow).toHaveBeenCalledTimes(1);
    expect(saveWorkflow.mock.calls[0]![0].id).toBe('wf-old');
    expect(saveWorkflow.mock.calls[0]![0].name).toBe('edited just before leaving');
  });

  it('reloading the SAME workflow still cancels it (a restore must not be overwritten)', async () => {
    s().loadFromSaved(wf('wf-same'));
    await vi.advanceTimersByTimeAsync(0);
    saveWorkflow.mockClear();
    s().setName('pre-restore edit');
    s().loadFromSaved(wf('wf-same'));
    await vi.advanceTimersByTimeAsync(1600);
    expect(saveWorkflow).not.toHaveBeenCalled();
  });
});

describe('ADR 0770 D6 — a refused load is not a blank canvas', () => {
  it('renders a retryable error, never loads a blank workflow under the id, and Retry re-runs the load', async () => {
    s().loadFromSaved(wf('wf-previous'));
    loadWorkflow.mockReset().mockRejectedValue(new LoadRefusedError());
    render(
      <MemoryRouter initialEntries={['/builder/wf.real.123']}>
        <Routes><Route path="/builder/:workflowId" element={<BuilderTab />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('button', { name: /try again/i })).toBeTruthy();
    expect(screen.queryByText('canvas')).toBeNull();
    expect(s().workflowId, 'no blank workflow was minted under the real id').toBe('wf-previous');
    // Retry re-runs the load (the `attempt` nonce) and lands the real workflow.
    loadWorkflow.mockResolvedValueOnce({ workflow: wf('wf.real.123'), headRevision: 'h1' });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('canvas')).toBeTruthy();
    expect(loadWorkflow).toHaveBeenCalledTimes(2);
    expect(s().workflowId).toBe('wf.real.123');
    expect(s().baseRevision).toBe('h1');
  });
});

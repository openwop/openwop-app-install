/**
 * ADR 0789 — a save of a SHARED (seeded) workflow forks server-side onto the
 * tenant's own id. The builder must follow: every later save, the URL and the
 * local cache move to the fork. Otherwise the next autosave POSTs the shared id,
 * which the tenant no longer owns (404), and a Run executes the unedited steps.
 *
 * Sabotage that turns it red: `if (false)` on the fork-adoption branch in
 * runBackendSyncNow, dropping the fork alias, the local-cache delete, the URL
 * follow or its no-reload guard in BuilderTab, the repoint warning, the
 * pristine marker / its comparison / its position strip, or adoptRestoreOutcome's
 * fork branch. Each case owns its ids: `forkAliases` is module-level and never
 * cleared, so two cases sharing a shared id would see each other's alias.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { BuilderNode, SavedWorkflow } from '../schema/workflow.js';

type BackendStore = typeof import('../persistence/backendStore.js');
const saveWorkflow = vi.fn<BackendStore['saveWorkflow']>();
const loadWorkflow = vi.fn<BackendStore['loadWorkflowWithHead']>();
vi.mock('../persistence/backendStore.js', async (orig) => ({
  ...(await orig<typeof import('../persistence/backendStore.js')>()),
  saveWorkflow: (...a: Parameters<BackendStore['saveWorkflow']>) => saveWorkflow(...a),
  loadWorkflowWithHead: (...a: Parameters<BackendStore['loadWorkflowWithHead']>) => loadWorkflow(...a),
}));
vi.mock('../BuilderShell.js', () => ({ BuilderShell: () => <div>canvas</div> }));

const { useBuilderStore, adoptRestoreOutcome } = await import('../store/builderStore.js');
const { BuilderTab } = await import('../BuilderTab.js');
const { listSavedWorkflows } = await import('../persistence/localStore.js');
const { toast } = await import('../../ui/toast.js');

const SHARED = 'wf.seed.daily-briefing';
const FORK = 'wf.fork.daily-briefing.1a2b3c4d';
const wf = (id: string): SavedWorkflow => ({ id, name: id, version: '1.0.0', nodes: [], edges: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
/** A runnable (serializable) canvas — an empty graph never serializes, so is never pristine. */
const n1: BuilderNode = { id: 'n1', kind: 'noop', name: 'n1', position: { x: 0, y: 0 }, config: {} };
const wfWithNode = (id: string): SavedWorkflow => ({ ...wf(id), nodes: [n1] });
const s = () => useBuilderStore.getState();

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

beforeEach(() => {
  localStorage.clear();
  saveWorkflow.mockReset();
  loadWorkflow.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('ADR 0789 — the builder adopts a fork of a shared workflow', () => {
  it('moves the store, the next save and the local cache to the fork id', async () => {
    vi.useFakeTimers();
    saveWorkflow.mockResolvedValue({ workflowId: FORK, forkedFrom: SHARED, revision: 'rev-fork' });
    s().loadFromSaved(wf(SHARED));
    await vi.advanceTimersByTimeAsync(0);
    saveWorkflow.mockClear();
    s().setName('my edit');
    await vi.advanceTimersByTimeAsync(1600);
    expect(saveWorkflow).toHaveBeenCalledTimes(1);
    expect(s().workflowId).toBe(FORK);
    expect(s().baseRevision).toBe('rev-fork');

    // The NEXT edit saves under the fork, never the shared id.
    saveWorkflow.mockResolvedValue({ workflowId: FORK, revision: 'rev-fork-2' });
    s().setName('second edit');
    await vi.advanceTimersByTimeAsync(1600);
    expect(saveWorkflow.mock.calls.at(-1)![0].id).toBe(FORK);
    expect(listSavedWorkflows().map((w) => w.id)).not.toContain(SHARED);
  });

  it('follows the fork in the URL without reloading the canvas from the server', async () => {
    const SHARED_URL = 'wf.seed.url-template';
    const FORK_URL = 'wf.fork.url-template.0c0c0c0c';
    loadWorkflow.mockResolvedValue({ workflow: wf(SHARED_URL), headRevision: 'rev-shared' });
    saveWorkflow.mockResolvedValue({ workflowId: FORK_URL, forkedFrom: SHARED_URL, revision: 'rev-fork' });
    render(
      <MemoryRouter initialEntries={[`/builder/${SHARED_URL}`]}>
        <Routes><Route path="/builder/:workflowId" element={<><BuilderTab /><Where /></>} /></Routes>
      </MemoryRouter>,
    );
    await screen.findByText('canvas');
    expect(loadWorkflow).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    s().setName('edit that forks');
    await vi.advanceTimersByTimeAsync(1600);
    vi.useRealTimers();
    expect((await screen.findByTestId('where')).textContent).toBe(`/builder/${FORK_URL}`);
    expect(s().workflowId).toBe(FORK_URL);
    expect(s().name).toBe('edit that forks');
    expect(loadWorkflow, 'following the fork must not re-read the canvas (it would drop newer edits)').toHaveBeenCalledTimes(1);
  });

  it('a fork whose linked items could not all be re-pointed WARNS instead of drifting silently', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(toast, 'warning');
    try {
      const shared2 = 'wf.seed.other-template';
      saveWorkflow.mockResolvedValue({ workflowId: 'wf.fork.other-template.9f9f9f9f', forkedFrom: shared2, revision: 'rev-fork', repointFailed: true });
      s().loadFromSaved(wf(shared2));
      await vi.advanceTimersByTimeAsync(0);
      s().setName('edit');
      await vi.advanceTimersByTimeAsync(1600);
      expect(s().workflowId).toBe('wf.fork.other-template.9f9f9f9f');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a save QUEUED under the shared id while the forking save was in flight is sent under the fork', async () => {
    vi.useFakeTimers();
    const SHARED_Q = 'wf.seed.queued-template';
    const FORK_Q = 'wf.fork.queued-template.5e5e5e5e';
    let release!: () => void;
    saveWorkflow.mockImplementationOnce(() => new Promise((res) => { release = () => res({ workflowId: FORK_Q, forkedFrom: SHARED_Q, revision: 'rev-fork' }); }));
    s().loadFromSaved(wf(SHARED_Q));
    await vi.advanceTimersByTimeAsync(0);
    saveWorkflow.mockClear();
    s().setName('first edit');
    await vi.advanceTimersByTimeAsync(1600); // save #1 in flight (forking)
    s().setName('second edit');
    await vi.advanceTimersByTimeAsync(1600); // save #2 queued behind it, serialized under SHARED_Q
    saveWorkflow.mockResolvedValue({ workflowId: FORK_Q, revision: 'rev-fork-2' });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(saveWorkflow.mock.calls.length).toBeGreaterThanOrEqual(2);
    const second = saveWorkflow.mock.calls[1]![0];
    expect(second.id, 'the queued save posted the shared id the tenant no longer owns').toBe(FORK_Q);
    expect(second.name).toBe('second edit');
  });

  it('marks an untouched canvas PRISTINE, and an edited one not', async () => {
    vi.useFakeTimers();
    saveWorkflow.mockResolvedValue({ workflowId: 'wf-p', revision: 'r' });
    s().loadFromSaved(wfWithNode('wf-p'));
    await vi.advanceTimersByTimeAsync(0);
    saveWorkflow.mockClear();
    s().setName('changed');
    await vi.advanceTimersByTimeAsync(1600);
    expect(saveWorkflow.mock.calls[0]![1]).not.toMatchObject({ pristine: true });
    s().setName('wf-p'); // back to exactly what was loaded
    await vi.advanceTimersByTimeAsync(1600);
    expect(saveWorkflow.mock.calls[1]![1]).toMatchObject({ pristine: true });
  });

  it('a History restore that FORKED a shared workflow adopts the fork and reloads IT, not the shared original', () => {
    const shared = 'wf.seed.restore-template';
    const fork = 'wf.fork.restore-template.4d4d4d4d';
    s().loadFromSaved(wf(shared));
    const reloadId = adoptRestoreOutcome(shared, { workflowId: fork, forkedFrom: shared, revision: 'rev-r' });
    expect(reloadId).toBe(fork);
    expect(s().workflowId).toBe(fork);
    expect(s().baseRevision).toBe('rev-r');
    // An ordinary restore (not a fork) reloads the same id and moves nothing.
    s().loadFromSaved(wf('wf-mine-restore'));
    expect(adoptRestoreOutcome('wf-mine-restore', { workflowId: 'wf-mine-restore', revision: 'r2' })).toBe('wf-mine-restore');
    expect(s().workflowId).toBe('wf-mine-restore');
  });

  it('a drag alone keeps a canvas pristine (layout is not content)', async () => {
    vi.useFakeTimers();
    saveWorkflow.mockResolvedValue({ workflowId: 'wf-drag', revision: 'r' });
    s().loadFromSaved(wfWithNode('wf-drag'));
    await vi.advanceTimersByTimeAsync(0);
    saveWorkflow.mockClear();
    s().moveNodes([{ id: 'n1', position: { x: 250, y: 90 } }]);
    s().persist();
    await vi.advanceTimersByTimeAsync(1600);
    expect(saveWorkflow.mock.calls.at(-1)![1]).toMatchObject({ pristine: true });
  });

  it('only the fork MARKER moves the id — a different id without `forkedFrom` never does', async () => {
    // The fixture answers with a DIFFERENT id and no `forkedFrom`: an id echo
    // equal to our own would make adoption a no-op whatever the gate does.
    vi.useFakeTimers();
    const info = vi.spyOn(toast, 'info');
    try {
      saveWorkflow.mockResolvedValue({ workflowId: 'wf-mine-canonical', revision: 'r2' });
      s().loadFromSaved(wf('wf-mine'));
      await vi.advanceTimersByTimeAsync(0);
      s().setName('x');
      await vi.advanceTimersByTimeAsync(1600);
      expect(saveWorkflow).toHaveBeenCalled();
      expect(s().workflowId).toBe('wf-mine');
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });
});

/**
 * ADR 0292 (`0292-resilient-example-data-seeding`) §Correction 2026-11-07 / ADR 0321 — the
 * example-data page never renders or submits a superseded workspace's seed operation. The
 * real `ExampleDataPage` (client calls and `confirm` mocked) acts only for the hydrated
 * generation that rendered it: each handler refuses when `captured !== generation.current`
 * (onSeed / onClear / onProvision), every progress and completion callback checks
 * `isCurrent()`, and a workspace change during a confirm dialog aborts the write. Controls
 * stay disabled until the status read hydrates.
 *
 * Sabotage-witnessed (w94 probes): enabling Clear before hydration; dropping `isCurrent()`
 * from the seed progress callback or the stale-completion return; dropping `!isCurrent()`
 * after either confirm; dropping the generation check in onSeed or onClear (the retained
 * same-act handler rows) — each reds its case.
 *
 * Selection: nothing starts selected (a select-all default left Clear one click from
 * clearing every type), an auth change empties the selection, Load selected and Clear
 * name the hint that says why they wait, and the Clear dialog names the chosen types
 * by label and the active workspace by name. Each case reds on the old page: the
 * refresh re-selected everything, Clear was never disabled, and the dialog joined
 * step ids with no workspace.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExampleDataPage } from '../ExampleDataPage.js';
import { fireAuthChanged } from '../../client/config.js';
import type { RunResult, SeedStreamEvent } from '../../client/exampleDataClient.js';

const api = vi.hoisted(() => ({
  status: vi.fn<typeof import('../../client/exampleDataClient.js')['getExampleDataStatus']>(),
  seed: vi.fn<typeof import('../../client/exampleDataClient.js')['runExampleDataSeedStream']>(),
  clear: vi.fn<typeof import('../../client/exampleDataClient.js')['clearExampleDataStream']>(),
  provision: vi.fn<typeof import('../../client/exampleDataClient.js')['provisionDemoTenant']>(),
  confirm: vi.fn<typeof import('../../ui/confirm.js')['confirm']>(),
  workspaces: vi.fn<typeof import('../../client/workspaceClient.js')['listMyWorkspaces']>(),
}));
vi.mock('../../client/exampleDataClient.js', async (original) => ({ ...await original<typeof import('../../client/exampleDataClient.js')>(), getExampleDataStatus: api.status, runExampleDataSeedStream: api.seed, clearExampleDataStream: api.clear, provisionDemoTenant: api.provision }));
vi.mock('../../ui/confirm.js', () => ({ confirm: api.confirm }));
vi.mock('../../client/workspaceClient.js', async (original) => ({ ...await original<typeof import('../../client/workspaceClient.js')>(), listMyWorkspaces: api.workspaces }));
const step = { id: 'demo-walkthroughs', label: 'Guided walkthroughs', description: 'Two controlled samples', count: 0 };
const status = { enabled: true, superadmin: true, steps: [step] };
const summary: RunResult['summary'] = { created: 1, skipped: 0, errors: 0, cleared: 0, total: 1 };
const mine = {
  active: 'ws-team', personal: 'user-1',
  workspaces: [
    { workspaceId: 'user-1', name: 'Personal', slug: 'personal', roles: ['owner'], kind: 'personal' as const, active: false },
    { workspaceId: 'ws-team', name: 'Casa Team', slug: 'casa-team', roles: ['owner'], kind: 'shared' as const, active: true },
  ],
};
beforeEach(() => { vi.resetAllMocks(); api.status.mockResolvedValue(status); api.confirm.mockResolvedValue(true); api.workspaces.mockResolvedValue(mine); });
afterEach(cleanup);

/** Hydrated: the controls that need no choice are live. */
async function hydrated(): Promise<void> {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Load all example data' })).not.toBeDisabled());
}

/** Nothing starts selected, so the person picks the one type first. */
function choose(): void {
  fireEvent.click(screen.getByRole('checkbox', { name: `Select ${step.label}` }));
}

async function ready(): Promise<void> {
  render(<ExampleDataPage />);
  await hydrated();
  choose();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Load selected (1)' })).not.toBeDisabled());
}

describe('example-data page workspace lifecycle', () => {
  it('disables mutations until initial status hydration completes', async () => {
    let resolve: ((value: typeof status) => void) | undefined;
    api.status.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    render(<ExampleDataPage />);
    expect(screen.getByRole('button', { name: 'Clear example data' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Load all example data' })).toBeDisabled();
    if (!resolve) throw new Error('Status read did not begin');
    const complete = resolve;
    await act(async () => complete(status));
    expect(screen.getByRole('button', { name: 'Load all example data' })).not.toBeDisabled();
  });

  it('keeps a normal same-workspace seed result visible', async () => {
    api.seed.mockImplementation(async (_opts, progress) => {
      progress({ type: 'step', step: step.id, label: step.label, action: 'created', message: 'Normal workspace seed' });
      return { success: true, summary };
    });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Load selected (1)' }));
    expect(await screen.findByText('Normal workspace seed')).toBeInTheDocument();
    expect(api.seed).toHaveBeenCalledTimes(1);
  });

  it('ignores previous-workspace progress, completion and refresh after an auth signal', async () => {
    let progress: ((event: SeedStreamEvent) => void) | undefined;
    let finish: ((value: { success: boolean; summary: typeof summary }) => void) | undefined;
    api.seed.mockImplementation((_opts, onEvent) => new Promise((resolve) => { progress = onEvent; finish = resolve; }));
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Load selected (1)' }));
    await act(async () => fireAuthChanged());
    if (!progress || !finish) throw new Error('Seed operation did not begin');
    const emit = progress;
    const done = finish;
    await act(async () => {
      emit({ type: 'step', step: step.id, label: step.label, action: 'created', message: 'Stale workspace seed' });
      done({ success: true, summary });
    });
    // The current workspace has re-hydrated (positive settle) before the absence check.
    await hydrated();
    expect(screen.queryByText('Stale workspace seed')).not.toBeInTheDocument();
    expect(api.status).toHaveBeenCalledTimes(2);
  });

  it('refuses clear and provision if workspace changes during their confirmation', async () => {
    api.confirm.mockImplementation(async () => { fireAuthChanged(); return true; });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Clear example data' }));
    await waitFor(() => expect(api.confirm).toHaveBeenCalledTimes(1));
    // Settle past the guarded continuation: the auth signal's re-hydration read has run.
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: /Provision demo tenant/i })).not.toBeDisabled());
    expect(api.clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Provision demo tenant/i }));
    await waitFor(() => expect(api.confirm).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole('button', { name: /Provision demo tenant/i })).not.toBeDisabled());
    expect(api.provision).not.toHaveBeenCalled();
    expect(api.clear).not.toHaveBeenCalled();
  });

  it.each([
    ['Load all example data', 1], ['Load selected (1)', 1], ['Clear example data', 1], ['Provision demo tenant', 1],
    ['Load all example data', 2], ['Load selected (1)', 2], ['Clear example data', 2], ['Provision demo tenant', 2],
  ] as const)('refuses retained %s controls after %i same-act auth signals until current hydration', async (name, signals) => {
    api.seed.mockResolvedValue({ success: true, summary });
    await ready();
    const retained = screen.getByRole('button', { name });
    let finishHydration: ((value: typeof status) => void) | undefined;
    api.status.mockImplementation(() => new Promise((resolve) => { finishHydration = resolve; }));
    // One outer React batch preserves the old rendered handler while auth invalidates
    // its live epoch. Two signals also exercise A→B→A without identity-string reuse.
    await act(async () => {
      for (let index = 0; index < signals; index++) fireAuthChanged();
      retained.click();
    });
    expect(api.seed).not.toHaveBeenCalled();
    expect(api.clear).not.toHaveBeenCalled();
    expect(api.provision).not.toHaveBeenCalled();
    expect(api.confirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Load all example data' })).toBeDisabled();
    if (!finishHydration) throw new Error('Current-workspace hydration did not begin');
    const complete = finishHydration;
    await act(async () => complete(status));
    // The auth signal emptied the selection; choosing again in the new workspace works.
    choose();
    const current = screen.getByRole('button', { name: 'Load selected (1)' });
    expect(current).not.toBeDisabled();
    fireEvent.click(current);
    await waitFor(() => expect(api.seed).toHaveBeenCalledTimes(1));
  });

});

describe('example-data page selection', () => {
  const second = { id: 'demo-agents', label: 'Example agents', description: 'Three agents', count: 2 };
  const two = { enabled: true, superadmin: false, steps: [step, second] };

  it('starts with nothing selected, and says why Load selected and Clear wait', async () => {
    api.status.mockResolvedValue(two);
    render(<ExampleDataPage />);
    await hydrated();
    expect(screen.getByRole('checkbox', { name: `Select ${step.label}` })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: `Select ${second.label}` })).not.toBeChecked();
    const hint = screen.getByText(/Nothing is selected until you choose/);
    for (const name of ['Load selected (0)', 'Clear example data']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('aria-describedby', hint.id);
    }
  });

  it('selects all and none on request', async () => {
    api.status.mockResolvedValue(two);
    render(<ExampleDataPage />);
    await hydrated();
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByRole('button', { name: 'Load selected (2)' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear example data' })).not.toBeDisabled();
    expect(screen.queryByText(/Nothing is selected until you choose/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }));
    expect(screen.getByRole('button', { name: 'Load selected (0)' })).toBeDisabled();
  });

  it('empties the selection when the account or workspace changes', async () => {
    api.status.mockResolvedValue(two);
    render(<ExampleDataPage />);
    await hydrated();
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByRole('button', { name: 'Load selected (2)' })).not.toBeDisabled();
    await act(async () => fireAuthChanged());
    await hydrated();
    expect(api.status).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Load selected (0)' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: `Select ${step.label}` })).not.toBeChecked();
  });

  it('names the chosen types and the active workspace in the Clear dialog', async () => {
    api.status.mockResolvedValue(two);
    api.confirm.mockResolvedValue(false);
    render(<ExampleDataPage />);
    await hydrated();
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${second.label}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear example data' }));
    await waitFor(() => expect(api.confirm).toHaveBeenCalledTimes(1));
    const title = String(api.confirm.mock.calls[0]?.[0]?.title ?? '');
    expect(title).toContain('Example agents');
    expect(title).toContain('Casa Team');
    expect(title).not.toContain('demo-agents');
    expect(title).not.toContain(step.label);
    expect(api.clear).not.toHaveBeenCalled();
  });

  it('clears only the chosen types', async () => {
    api.status.mockResolvedValue(two);
    api.clear.mockResolvedValue({ success: true, summary });
    render(<ExampleDataPage />);
    await hydrated();
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${second.label}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear example data' }));
    await waitFor(() => expect(api.clear).toHaveBeenCalledTimes(1));
    expect(api.clear.mock.calls[0]?.[0]).toEqual({ steps: ['demo-agents'] });
  });
});

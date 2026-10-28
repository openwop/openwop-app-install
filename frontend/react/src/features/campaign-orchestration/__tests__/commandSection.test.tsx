/**
 * ADR 0960 P1 — the campaign's Command section.
 *
 *   - runs and gates render as labeled chips, with the run page one link away;
 *   - "Show graph" reads the run's executed definition and mounts the graph;
 *   - a failed snapshot read is said; a later failed poll keeps what was shown;
 *   - a failed definition read is said, never an empty graph.
 *
 * Sabotage (run 2026-10-20): dropping the `prev.kind === 'ready'` keep reds "…keeps
 * what was shown"; clearing the pick on a definition failure (instead of saying
 * it) reds "a failed definition…".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const h = vi.hoisted(() => ({ getCommand: vi.fn(), getDef: vi.fn(), graph: vi.fn() }));
vi.mock('../campaignStudioClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getCommand: h.getCommand, getCommandRunDefinition: h.getDef }));
vi.mock('../../../runs/RunGraphView.js', () => ({
  RunGraphView: (p: { runId: string; workflowId: string }) => { h.graph(p); return <div data-testid="graph">{`graph:${p.runId}:${p.workflowId}`}</div>; },
}));

import { CommandSection } from '../CommandSection.js';

const SNAP = {
  campaign: { id: 'c1', orgId: 'o1', name: 'C', status: 'draft' },
  runs: [{ runId: 'r1', workflowId: 'campaign-studio.campaign-orchestration', role: 'stage', status: 'waiting-approval', startedAt: '2026-10-20T10:00:00Z' }],
  runsTruncated: false,
  nodes: [{ runId: 'r1', nodeId: 'kernel-approve', status: 'suspended' }],
  nodesTruncated: false,
  gates: [{ interruptId: 'i1', runId: 'r1', nodeId: 'kernel-approve', kind: 'approval', createdAt: '2026-10-20T10:00:00Z', ageMs: 60_000 }],
  gatesTruncated: false,
  unavailable: { autonomy: 'campaign-orchestration.autonomy' },
  generatedAt: '2026-10-20T10:01:00Z',
};

beforeEach(() => { h.getCommand.mockReset(); h.getDef.mockReset(); h.graph.mockReset(); vi.useRealTimers(); });
afterEach(cleanup);

const mount = () => render(<MemoryRouter><CommandSection campaignId="c1" /></MemoryRouter>);

describe('CommandSection', () => {
  it('shows runs and gates as labeled chips, with the run page one link away', async () => {
    h.getCommand.mockResolvedValue(SNAP);
    mount();
    const gates = await screen.findByRole('list', { name: 'Waiting on someone' });
    expect(gates.textContent).toContain('Approval');
    expect(gates.textContent).toContain('kernel-approve');
    const runs = screen.getByRole('list', { name: 'Runs' });
    expect(runs.textContent).toContain('Waiting for approval');
    expect(runs.textContent).toContain('Stage');
    expect(screen.getAllByRole('link', { name: 'Open run' })[0]?.getAttribute('href')).toBe('/runs/r1');
  });

  it('"Show graph" reads the executed definition and mounts the graph', async () => {
    h.getCommand.mockResolvedValue(SNAP);
    h.getDef.mockResolvedValue({ runId: 'r1', workflowId: 'campaign-studio.campaign-orchestration', definition: { nodes: [] } });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Show graph' }));
    expect((await screen.findByTestId('graph')).textContent).toBe('graph:r1:campaign-studio.campaign-orchestration');
    // The canvas has a reachable list alternative: each live step with a labeled status.
    expect(screen.getByRole('list', { name: 'Steps' }).textContent).toContain('Waiting');
    expect(h.getDef).toHaveBeenCalledWith('c1', 'r1');
  });

  it('a late earlier graph response cannot replace the run most recently picked', async () => {
    h.getCommand.mockResolvedValue({ ...SNAP, runs: [...SNAP.runs, { ...SNAP.runs[0], runId: 'r2' }] });
    let first!: (value: unknown) => void;
    h.getDef.mockImplementation((_campaignId: string, runId: string) => runId === 'r1'
      ? new Promise((resolve) => { first = resolve; })
      : Promise.resolve({ runId: 'r2', workflowId: 'wf2', definition: { nodes: [] } }));
    mount();
    const buttons = await screen.findAllByRole('button', { name: 'Show graph' });
    fireEvent.click(buttons[0]!); fireEvent.click(buttons[1]!);
    expect((await screen.findByTestId('graph')).textContent).toBe('graph:r2:wf2');
    await act(async () => { first({ runId: 'r1', workflowId: 'wf1', definition: { nodes: [] } }); });
    expect(screen.getByTestId('graph').textContent).toBe('graph:r2:wf2');
  });

  it('a failed definition read is said, never an empty graph', async () => {
    h.getCommand.mockResolvedValue(SNAP);
    h.getDef.mockRejectedValue(new Error('404'));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Show graph' }));
    expect((await screen.findAllByText('This run’s graph could not be loaded.')).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('graph')).toBeNull();
  });

  it('a failed snapshot read is said; a later failed poll keeps what was shown', async () => {
    h.getCommand.mockRejectedValueOnce(new Error('500'));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    expect((await screen.findAllByText('The campaign’s runs could not be read.')).length).toBeGreaterThan(0);
    h.getCommand.mockResolvedValueOnce(SNAP).mockRejectedValue(new Error('500'));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    await screen.findByRole('list', { name: 'Runs' });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    await waitFor(() => expect(h.getCommand).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('list', { name: 'Runs' })).toBeTruthy();
    expect((await screen.findAllByText('The campaign’s runs could not be read.')).length).toBeGreaterThan(0);
  });
});

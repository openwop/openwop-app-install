/**
 * ADR 0960 D4 — "Replay this run" in the campaign cockpit.
 *
 *   - replay calls the existing :fork in REPLAY mode (never branch), once per
 *     click, then says whether the replay matched (only `run.started` differs);
 *   - a divergence names the step;
 *   - an unfinished run cannot be replayed yet; the branch fork is disabled with
 *     its reason.
 *
 * Sabotage (run 2026-10-20): `mode: 'replay'` → `'branch'` reds "replay calls…";
 * `replayMatched` returning true unconditionally reds "a divergence names the
 * step". The second click is blocked twice (the button disables while running,
 * and an in-flight ref); removing the ref alone stays green — measured, so the
 * ref is the second guard, not the witnessed one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const h = vi.hoisted(() => ({ fork: vi.fn(), getRun: vi.fn(), diff: vi.fn() }));
vi.mock('../../../client/runsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), forkRun: h.fork, getRun: h.getRun, client: { runs: { diff: (...a: unknown[]) => h.diff(...a) } }, bound: async (id: string) => id }));

import { ReplayPanel, replayMatched } from '../ReplayPanel.js';

const START = { aEvent: { type: 'run.started' }, bEvent: { type: 'run.started' } };

beforeEach(() => {
  for (const f of [h.fork, h.getRun, h.diff]) f.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  h.fork.mockResolvedValue({ runId: 'f1', sourceRunId: 'r1' });
  h.getRun.mockResolvedValue({ status: 'completed' });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const mount = (status = 'completed') => render(<MemoryRouter><ReplayPanel runId="r1" runStatus={status} /></MemoryRouter>);

describe('ReplayPanel', () => {
  it('replay calls the existing :fork in replay mode, once per click, and says it matched', async () => {
    h.diff.mockResolvedValue({ a: 'r1', b: 'f1', divergedAtSeq: 0, eventDiffs: [{ seq: 0, op: 'changed', ...START }], stateDiff: {} });
    mount();
    const btn = screen.getByRole('button', { name: 'Replay this run' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(await screen.findByText(/The replay matched/)).toBeTruthy();
    expect(h.fork).toHaveBeenCalledTimes(1);
    expect(h.fork).toHaveBeenCalledWith('r1', { fromSeq: 0, mode: 'replay' });
    expect(h.diff).toHaveBeenCalledWith('r1', 'f1');
    expect(screen.getByRole('link', { name: 'Open the replay' }).getAttribute('href')).toBe('/runs/f1');
  });

  it('switching runs while a fork is being created stops the obsolete poll', async () => {
    let finish!: (value: { runId: string }) => void;
    h.fork.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { rerender } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Replay this run' }));
    rerender(<MemoryRouter><ReplayPanel runId="r2" runStatus="completed" /></MemoryRouter>);
    await act(async () => { finish({ runId: 'old-fork' }); await vi.advanceTimersByTimeAsync(1_500); });
    expect(h.getRun).not.toHaveBeenCalled();
    expect(h.diff).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Open the replay' })).toBeNull();
  });

  it('a divergence names the step', async () => {
    h.diff.mockResolvedValue({ a: 'r1', b: 'f1', divergedAtSeq: 4, eventDiffs: [{ seq: 0, op: 'changed', ...START }, { seq: 4, op: 'changed', aEvent: { type: 'node.completed' }, bEvent: { type: 'node.completed' } }], stateDiff: {} });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Replay this run' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(await screen.findByText(/differs from the original from step 4/)).toBeTruthy();
  });

  it('an unfinished run cannot be replayed yet; the branch fork is disabled with its reason', () => {
    mount('waiting-approval');
    expect((screen.getByRole('button', { name: 'Replay this run' }) as HTMLButtonElement).disabled).toBe(true);
    const branch = screen.getByRole('button', { name: 'Fork with a different input' }) as HTMLButtonElement;
    expect(branch.disabled).toBe(true);
    expect(document.getElementById(branch.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(/holds every forked step for approval/);
  });

  it('replayMatched: only run.started may differ, and the end states must agree', () => {
    expect(replayMatched({ a: 'a', b: 'b', divergedAtSeq: 0, eventDiffs: [{ seq: 0, op: 'changed', ...START }] as never, stateDiff: {} })).toBe(true);
    expect(replayMatched({ a: 'a', b: 'b', divergedAtSeq: 0, eventDiffs: [{ seq: 0, op: 'changed', ...START }] as never, stateDiff: { status: 'x' } })).toBe(false);
  });
});

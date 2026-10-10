/**
 * ADR 0772 — run-detail integrity (feature-loop row 3, grade-ux Blockers).
 *
 *  - `RRUX-1`: navigating in-app from one run to another re-used the mounted
 *    page, so the PREVIOUS run's snapshot stayed on screen under the new URL
 *    (forever, if the new read failed) while Cancel/Delete already acted on the
 *    new id.
 *  - `RRUX-3`: a second click on "fork" while the first was in flight created a
 *    second branch — and each branch re-fires every side effect after the fork
 *    point.
 *  - `RRUX-4`: Cancel is irreversible and asked nothing.
 *
 * Each leg drives the real control through the rendered page, and each has a
 * positive control so "never does anything" cannot pass it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { messages as streamsEn } from '../../streams/i18n/en.js';
import { messages as en } from '../i18n/en.js';

const confirmFn = vi.hoisted(() => vi.fn());
vi.mock('../../ui/confirm.js', () => ({ confirm: confirmFn, ConfirmRoot: () => null }));

const api = vi.hoisted(() => ({
  getRun: vi.fn(),
  pollEvents: vi.fn(),
  forkRun: vi.fn(),
  cancelRun: vi.fn(),
  subscribeToRun: vi.fn(),
}));
vi.mock('../../client/runsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getRun: api.getRun, pollEvents: api.pollEvents, forkRun: api.forkRun, cancelRun: api.cancelRun };
});
vi.mock('../../client/streamsClient.js', () => ({ subscribeToRun: api.subscribeToRun }));
vi.mock('../../client/interruptsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listOpenInterrupts: vi.fn(async () => []) };
});
vi.mock('../../client/feedbackClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listAnnotations: vi.fn(async () => []) };
});
vi.mock('../../workflows/workflowsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getRunRevision: vi.fn(async () => null) };
});

// ADR 0661 — the page's module graph reaches the SDK's discovery read
// (`/.well-known/openwop`), which the four sibling files here are allowlisted
// for. This file stubs it instead of joining that shrink-only list: the read is
// refused deterministically, so no leg can depend on a race with the network.
vi.stubGlobal('fetch', (() => Promise.reject(new Error('no network in unit tests'))) as never);
const { RunDetailPage } = await import('../RunDetailPage.js');

const snapshot = (runId: string, status: string, workflowId: string) => ({
  runId, status, workflowId, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  api.pollEvents.mockResolvedValue({ events: [{ eventId: 'e1', sequence: 1, type: 'node.started', runId: 'r1' }] });
  api.subscribeToRun.mockReturnValue({ close: () => {} });
});
afterEach(() => cleanup());

/** An in-app link to another run, the way the fork back-reference renders one. */
function GoTo({ to }: { to: string }): JSX.Element {
  const nav = useNavigate();
  return <button type="button" onClick={() => nav(to)}>go-{to}</button>;
}

function mount(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <GoTo to="/runs/r2" />
      <Routes><Route path="/runs/:runId" element={<RunDetailPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe('RRUX-1 — a run page never shows the previous run under a new URL', () => {
  it('switching runs in-app drops the old run immediately, even while the new read is pending', async () => {
    api.getRun.mockImplementation((id: string) => (id === 'r1'
      ? Promise.resolve(snapshot('r1', 'running', 'wf-alpha-unique'))
      : new Promise(() => { /* the new run's read never lands */ })));
    mount('/runs/r1');
    // Positive control: the first run IS rendered.
    expect((await screen.findAllByText('wf-alpha-unique')).length).toBeGreaterThan(0);
    await act(async () => { fireEvent.click(screen.getByText('go-/runs/r2')); });
    expect(screen.queryAllByText('wf-alpha-unique'), 'the previous run must not stay on screen under /runs/r2').toEqual([]);
  });
});

describe('RRUX-3 — one fork per click', () => {
  it('a second fork click while the first is in flight does not create a second branch', async () => {
    api.getRun.mockResolvedValue(snapshot('r1', 'completed', 'wf1'));
    confirmFn.mockResolvedValue(true);
    api.forkRun.mockReturnValue(new Promise(() => { /* in flight */ }));
    mount('/runs/r1');
    await screen.findByText('r1');
    fireEvent.click(await screen.findByText(en.eventViewLog));
    const btn = await screen.findByTitle(streamsEn.forkTitle);
    fireEvent.click(btn);
    await waitFor(() => expect(api.forkRun).toHaveBeenCalledTimes(1));
    fireEvent.click(btn);
    fireEvent.click(btn);
    // Let any second confirm/fork chain settle before asserting it never ran.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(api.forkRun).toHaveBeenCalledTimes(1);
  });
});

describe('RRUX-3 (grade-code M1) — no second fork while the page is leaving', () => {
  it('after a SUCCESSFUL fork starts navigating, another click does not fork again', async () => {
    api.getRun.mockResolvedValue(snapshot('r1', 'completed', 'wf1'));
    confirmFn.mockResolvedValue(true);
    api.forkRun.mockResolvedValue({ runId: 'r9', sourceRunId: 'r1' });
    // jsdom cannot navigate; a no-op href setter keeps the page mounted, which is
    // exactly the window a real browser has while the new document loads.
    const loc = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...loc, set href(_v: string) { /* navigation started */ }, get href() { return loc.href; } } });
    try {
      mount('/runs/r1');
      await screen.findByText('r1');
      fireEvent.click(await screen.findByText(en.eventViewLog));
      const btn = await screen.findByTitle(streamsEn.forkTitle);
      fireEvent.click(btn);
      await waitFor(() => expect(api.forkRun).toHaveBeenCalledTimes(1));
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      fireEvent.click(btn);
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(api.forkRun).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: loc });
    }
  });

  it('POSITIVE CONTROL: a DECLINED fork releases the guard, so the next click can fork', async () => {
    api.getRun.mockResolvedValue(snapshot('r1', 'completed', 'wf1'));
    confirmFn.mockResolvedValueOnce(false).mockResolvedValue(true);
    api.forkRun.mockReturnValue(new Promise(() => { /* in flight */ }));
    mount('/runs/r1');
    await screen.findByText('r1');
    fireEvent.click(await screen.findByText(en.eventViewLog));
    const btn = await screen.findByTitle(streamsEn.forkTitle);
    fireEvent.click(btn);
    await waitFor(() => expect(confirmFn).toHaveBeenCalledTimes(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    fireEvent.click(btn);
    await waitFor(() => expect(api.forkRun).toHaveBeenCalledTimes(1));
  });
});

describe('RRUX-4 — cancel asks first', () => {
  it('declining the confirm does not cancel', async () => {
    api.getRun.mockResolvedValue(snapshot('r1', 'running', 'wf1'));
    confirmFn.mockResolvedValue(false);
    mount('/runs/r1');
    fireEvent.click(await screen.findByRole('button', { name: en.cancelRun }));
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect(api.cancelRun).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: accepting cancels, once', async () => {
    api.getRun.mockResolvedValue(snapshot('r1', 'running', 'wf1'));
    confirmFn.mockResolvedValue(true);
    api.cancelRun.mockResolvedValue(undefined);
    mount('/runs/r1');
    fireEvent.click(await screen.findByRole('button', { name: en.cancelRun }));
    await waitFor(() => expect(api.cancelRun).toHaveBeenCalledTimes(1));
    expect(api.cancelRun.mock.calls[0]![0]).toBe('r1');
  });
});

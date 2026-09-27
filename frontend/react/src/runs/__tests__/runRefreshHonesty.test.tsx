/**
 * UX_UPGRADE-runs P2 — a failed post-event refresh must not read as a fresh view.
 *
 * On terminal/transition SSE events the page refetches the snapshot and (on
 * terminal) backfills the event log via REST. Both catches were silent
 * (`.catch(() => undefined)`), so a completed run whose final refetch failed
 * kept rendering the pre-terminal snapshot with no sign anything was missing —
 * stale panels presented as current. Now a failed refresh raises a warning
 * Notice with a retry, and a later successful refresh clears it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const api = vi.hoisted(() => ({
  getRun: vi.fn(),
  pollEvents: vi.fn(),
  subscribeToRun: vi.fn(),
}));
vi.mock('../../client/runsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getRun: api.getRun, pollEvents: api.pollEvents };
});
vi.mock('../../client/streamsClient.js', () => ({
  subscribeToRun: api.subscribeToRun,
}));
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

const { RunDetailPage } = await import('../RunDetailPage.js');

const SNAPSHOT = {
  runId: 'r1', status: 'running', workflowId: 'wf1',
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
};

function view(): void {
  render(
    <MemoryRouter initialEntries={['/runs/r1']}>
      <Routes><Route path="/runs/:runId" element={<RunDetailPage />} /></Routes>
    </MemoryRouter>,
  );
}

type OnEvent = (ev: { type: string; sequence: number }) => void;
let sseHandler: OnEvent | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  sseHandler = null;
  api.getRun.mockResolvedValue(SNAPSHOT);
  api.pollEvents.mockResolvedValue({ events: [] });
  api.subscribeToRun.mockImplementation((_id: string, opts: { onEvent: OnEvent }) => {
    sseHandler = opts.onEvent;
    return { close: () => {} };
  });
});
afterEach(() => cleanup());

async function terminalArrivesWithFailingRefresh(): Promise<void> {
  view();
  await screen.findByText('r1');
  // The refetches triggered by the terminal event now fail.
  api.getRun.mockRejectedValue(new Error('boom'));
  api.pollEvents.mockRejectedValue(new Error('boom'));
  await act(async () => {
    sseHandler?.({ type: 'run.completed', sequence: 1 });
  });
}

describe('run detail — post-event refresh honesty (UX_UPGRADE-runs P2)', () => {
  it('says the view may be stale when the terminal refetch fails (was silent)', async () => {
    await terminalArrivesWithFailingRefresh();
    await screen.findByText(/may be out of date/i);
  });

  it('retry re-reads and clears the warning on success', async () => {
    await terminalArrivesWithFailingRefresh();
    await screen.findByText(/may be out of date/i);
    api.getRun.mockResolvedValue({ ...SNAPSHOT, status: 'completed' });
    api.pollEvents.mockResolvedValue({ events: [] });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.queryByText(/may be out of date/i)).toBeNull());
  });

  it('a successful refresh never shows the warning', async () => {
    view();
    await screen.findByText('r1');
    await act(async () => {
      sseHandler?.({ type: 'run.completed', sequence: 1 });
    });
    expect(screen.queryByText(/may be out of date/i)).toBeNull();
  });
});

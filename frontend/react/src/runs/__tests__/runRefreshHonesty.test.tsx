/**
 * UX_UPGRADE-runs P2 — a failed post-event refresh must not read as a fresh view.
 *
 * On terminal/transition SSE events the page refetches the snapshot and (on
 * terminal) backfills the event log via REST. Both catches were silent
 * (`.catch(() => undefined)`), so a completed run whose final refetch failed
 * kept rendering the pre-terminal snapshot with no sign anything was missing —
 * stale panels presented as current. Now a failed refresh raises a warning
 * Notice with a retry, and a later successful refresh clears it.
 *
 * Each refetch is failed ON ITS OWN (w49): the first version failed both at
 * once, so either catch could be made silent again and the other still raised
 * the warning. What turns it red: the snapshot refetch's catch silent; the log
 * backfill's catch silent; Retry that clears the flag without re-reading; a
 * successful refresh that raises the warning.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { RunEventDoc, RunSnapshot } from '@openwop/openwop';

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

// ADR 0661 — refuse the SDK discovery read deterministically (the
// `runDetailIntegrity.test.tsx` precedent) instead of riding a live fetch.
vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.reject(new Error('no network in unit tests'))));
const { RunDetailPage } = await import('../RunDetailPage.js');

const SNAPSHOT: RunSnapshot = {
  runId: 'r1', status: 'running', workflowId: 'wf1',
  owner: { tenant: 't1', subject: { issuer: 'urn:openwop:test', subjectId: 'u1', tenant: 't1', lane: 'session', kind: 'user' } },
  eventLogSchemaVersion: 3,
};
const COMPLETED: RunSnapshot = { ...SNAPSHOT, status: 'completed' };

function view(): void {
  render(
    <MemoryRouter initialEntries={['/runs/r1']}>
      <Routes><Route path="/runs/:runId" element={<RunDetailPage />} /></Routes>
    </MemoryRouter>,
  );
}

type OnEvent = (ev: RunEventDoc) => void;
let sseHandler: OnEvent | null = null;
const sse = (type: string, sequence: number): RunEventDoc => ({
  eventId: `e${sequence}`, runId: 'r1', type, sequence, schemaVersion: 1,
  timestamp: '2026-08-01T00:00:01Z', payload: {}, ...(type.startsWith('node.') ? { nodeId: 'n1' } : {}),
});
const badge = (status: string) => screen.findByText(status, { selector: '.status-badge' });

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

/** Mount, wait for the INITIAL load to land (the running badge renders only
 *  from the snapshot), then deliver `type` with the given refetches failing. */
async function eventArrivesWith(type: string, fail: { getRun?: boolean; pollEvents?: boolean }): Promise<void> {
  view();
  await badge('running');
  if (fail.getRun) api.getRun.mockRejectedValue(new Error('boom'));
  else api.getRun.mockResolvedValue(COMPLETED);
  if (fail.pollEvents) api.pollEvents.mockRejectedValue(new Error('boom'));
  await act(async () => {
    sseHandler?.(sse(type, 1));
  });
}

describe('run detail — post-event refresh honesty (UX_UPGRADE-runs P2)', () => {
  it.each([
    ['the snapshot refetch fails', 'run.completed', { getRun: true }],
    ['the log backfill fails', 'run.completed', { pollEvents: true }],
    ['a node.suspended snapshot refetch fails', 'node.suspended', { getRun: true }],
  ] as const)('says the view may be stale when %s (was silent)', async (_name, type, fail) => {
    await eventArrivesWith(type, fail);
    await screen.findByText(/may be out of date/i);
  });

  /**
   * RUN-REFRESH-CLEAR-1 (BLOCKED-ON-PRODUCT, found w49) — the snapshot refetch's
   * SUCCESS calls `setRefreshFailed(false)`, which also erases a warning the LOG
   * BACKFILL raised. If the backfill fails first and the snapshot lands after
   * (ordinary network ordering), the page shows a fresh-looking view over a
   * stale log — the exact lie this file exists to prevent. Pinned with the
   * CORRECT expectation; `it.fails` goes red when the product stops clearing a
   * flag it did not raise (fix-probe `w49g3-rr-clear-fix-r2`).
   */
  it.fails('RUN-REFRESH-CLEAR-1: a snapshot refetch that lands AFTER a failed backfill keeps the warning', async () => {
    view();
    await badge('running');
    let landSnapshot: (s: RunSnapshot) => void = () => {};
    api.getRun.mockImplementation(() => new Promise<RunSnapshot>((r) => { landSnapshot = r; }));
    api.pollEvents.mockRejectedValue(new Error('boom'));
    await act(async () => { sseHandler?.(sse('run.completed', 1)); });
    await screen.findByText(/may be out of date/i);
    await act(async () => { landSnapshot(COMPLETED); });
    await badge('completed');
    expect(screen.queryByText(/may be out of date/i)).not.toBeNull();
  });

  it('retry re-reads and clears the warning on success', async () => {
    await eventArrivesWith('run.completed', { getRun: true, pollEvents: true });
    await screen.findByText(/may be out of date/i);
    const getRunCalls = api.getRun.mock.calls.length;
    const pollCalls = api.pollEvents.mock.calls.length;
    api.getRun.mockResolvedValue(COMPLETED);
    api.pollEvents.mockResolvedValue({ events: [] });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    // It RE-READ (both reads), and the re-read landed on screen…
    await badge('completed');
    expect(api.getRun.mock.calls.length).toBe(getRunCalls + 1);
    expect(api.pollEvents.mock.calls.length).toBe(pollCalls + 1);
    // …and only then is the warning gone.
    await waitFor(() => expect(screen.queryByText(/may be out of date/i)).toBeNull());
  });

  it('a successful refresh never shows the warning', async () => {
    await eventArrivesWith('run.completed', {});
    // Settle signal: the refreshed snapshot rendered AND the backfill ran.
    await badge('completed');
    await waitFor(() => expect(api.pollEvents).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(/may be out of date/i)).toBeNull();
  });
});

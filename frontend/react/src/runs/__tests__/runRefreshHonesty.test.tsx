/**
 * UX_UPGRADE-runs P2 — a failed post-event refresh must not read as a fresh view.
 *
 * On terminal/transition SSE events the page refetches the snapshot and (on
 * terminal) backfills the event log via REST. Both catches were silent
 * (`.catch(() => undefined)`), so a completed run whose final refetch failed
 * kept rendering the pre-terminal snapshot with no sign anything was missing —
 * stale panels presented as current. Now a failed refresh raises a warning
 * Notice with a retry. Each resource clears only its own failed refresh after
 * a successful read; an unrelated successful snapshot cannot certify the log.
 *
 * Each refetch is failed ON ITS OWN (w49): the first version failed both at
 * once, so either catch could be made silent again and the other still raised
 * the warning. What turns it red: the snapshot refetch's catch silent; the log
 * backfill's catch silent; Retry that clears the flag without re-reading; a
 * successful refresh that raises the warning.
 */
import { StrictMode } from 'react';
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

function view(strict = false): void {
  const page = <MemoryRouter initialEntries={['/runs/r1']}>
    <Routes><Route path="/runs/:runId" element={<RunDetailPage />} /></Routes>
  </MemoryRouter>;
  render(strict ? <StrictMode>{page}</StrictMode> : page);
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve: (value: T) => void = () => { throw new Error('Deferred promise is not initialized'); };
  let reject: (error: Error) => void = () => { throw new Error('Deferred promise is not initialized'); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function deliver(type: string, sequence: number): Promise<void> {
  if (!sseHandler) throw new Error('Run stream did not subscribe');
  const onEvent = sseHandler;
  await act(async () => onEvent(sse(type, sequence)));
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
   * RUN-REFRESH-CLEAR-1 (confirmed and corrected 2026-11-07; found w49) — the snapshot refetch's
   * SUCCESS calls `setRefreshFailed(false)`, which also erases a warning the LOG
   * BACKFILL raised. If the backfill fails first and the snapshot lands after
   * (ordinary network ordering), the page shows a fresh-looking view over a
   * stale log — the exact lie this file exists to prevent. Pinned with the
   * CORRECT expectation, now ordinary after the real warning-null witness and
   * owner-local repair. Historical fix-probe: `w49g3-rr-clear-fix-r2`.
   */
  it('RUN-REFRESH-CLEAR-1: a snapshot refetch that lands AFTER a failed backfill keeps the warning', async () => {
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

  it('a successful late log read cannot erase a snapshot failure', async () => {
    view();
    await badge('running');
    const log = deferred<{ events: RunEventDoc[] }>();
    api.getRun.mockRejectedValue(new Error('snapshot unavailable'));
    api.pollEvents.mockImplementation(() => log.promise);
    await deliver('run.completed', 1);
    await screen.findByText(/may be out of date/i);
    await act(async () => log.resolve({ events: [] }));
    expect(screen.queryByText(/may be out of date/i)).not.toBeNull();
  });

  it.each(['snapshot', 'log'] as const)('Retry retains the warning while pending and after only %s recovers', async (first) => {
    await eventArrivesWith('run.completed', { getRun: true, pollEvents: true });
    await screen.findByText(/may be out of date/i);
    const snapshot = deferred<RunSnapshot>();
    const log = deferred<{ events: RunEventDoc[] }>();
    api.getRun.mockImplementation(() => snapshot.promise);
    api.pollEvents.mockImplementation(() => log.promise);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(screen.queryByText(/may be out of date/i)).not.toBeNull();
    await act(async () => {
      if (first === 'snapshot') snapshot.resolve(COMPLETED); else log.resolve({ events: [] });
    });
    expect(screen.queryByText(/may be out of date/i)).not.toBeNull();
    await act(async () => {
      if (first === 'snapshot') log.resolve({ events: [] }); else snapshot.resolve(COMPLETED);
    });
    await badge('completed');
    await waitFor(() => expect(screen.queryByText(/may be out of date/i)).toBeNull());
  });

  it.each(['snapshot', 'log'] as const)('ignores an older %s success after the latest request failed', async (resource) => {
    view();
    await badge('running');
    const snapshot = deferred<RunSnapshot>();
    const log = deferred<{ events: RunEventDoc[] }>();
    if (resource === 'snapshot') {
      api.getRun.mockImplementationOnce(() => snapshot.promise).mockRejectedValueOnce(new Error('new snapshot failure'));
    } else {
      api.getRun.mockResolvedValue(COMPLETED);
      api.pollEvents.mockImplementationOnce(() => log.promise).mockRejectedValueOnce(new Error('new log failure'));
    }
    const event = resource === 'snapshot' ? 'node.suspended' : 'run.completed';
    await deliver(event, 1);
    await deliver(event, 2);
    await screen.findByText(/may be out of date/i);
    await act(async () => {
      if (resource === 'snapshot') snapshot.resolve(COMPLETED); else log.resolve({ events: [] });
    });
    expect(screen.queryByText(/may be out of date/i)).not.toBeNull();
    if (resource === 'snapshot') expect(screen.queryByText('completed', { selector: '.status-badge' })).toBeNull();
  });

  it.each(['snapshot', 'log'] as const)('ignores an older %s failure after the latest request succeeded', async (resource) => {
    view();
    await badge('running');
    const snapshot = deferred<RunSnapshot>();
    const log = deferred<{ events: RunEventDoc[] }>();
    if (resource === 'snapshot') {
      api.getRun.mockImplementationOnce(() => snapshot.promise).mockResolvedValueOnce(COMPLETED);
    } else {
      api.getRun.mockResolvedValue(COMPLETED);
      api.pollEvents.mockImplementationOnce(() => log.promise).mockResolvedValueOnce({ events: [] });
    }
    const event = resource === 'snapshot' ? 'node.suspended' : 'run.completed';
    await deliver(event, 1);
    await deliver(event, 2);
    await badge('completed');
    await act(async () => {
      if (resource === 'snapshot') snapshot.reject(new Error('old snapshot failure')); else log.reject(new Error('old log failure'));
    });
    expect(screen.queryByText(/may be out of date/i)).toBeNull();
  });

  it('ignores a closed stream callback after mode resubscription while the new stream still refreshes', async () => {
    view();
    await badge('running');
    if (!sseHandler) throw new Error('Original stream did not subscribe');
    const oldCallback = sseHandler;
    const subscriptions = api.subscribeToRun.mock.calls.length;
    fireEvent.change(screen.getByRole('combobox', { name: 'mode' }), { target: { value: 'debug' } });
    await waitFor(() => expect(api.subscribeToRun).toHaveBeenCalledTimes(subscriptions + 1));
    const snapshots = api.getRun.mock.calls.length;
    const logs = api.pollEvents.mock.calls.length;
    await act(async () => oldCallback(sse('run.completed', 90)));
    expect(api.getRun).toHaveBeenCalledTimes(snapshots);
    expect(api.pollEvents).toHaveBeenCalledTimes(logs);
    await deliver('node.suspended', 91);
    expect(api.getRun).toHaveBeenCalledTimes(snapshots + 1);
  });


  it('deduplicates same-sequence SSE callbacks in StrictMode before issuing refresh requests', async () => {
    view(true);
    await badge('running');
    const snapshot = deferred<RunSnapshot>();
    const log = deferred<{ events: RunEventDoc[] }>();
    api.getRun.mockImplementation(() => snapshot.promise);
    api.pollEvents.mockImplementation(() => log.promise);
    const snapshots = api.getRun.mock.calls.length;
    const logs = api.pollEvents.mock.calls.length;
    if (!sseHandler) throw new Error('Run stream did not subscribe');
    const onEvent = sseHandler;
    await act(async () => {
      onEvent(sse('run.completed', 1));
      onEvent(sse('run.completed', 1));
    });
    expect(api.getRun).toHaveBeenCalledTimes(snapshots + 1);
    expect(api.pollEvents).toHaveBeenCalledTimes(logs + 1);
    await act(async () => { snapshot.resolve(COMPLETED); log.resolve({ events: [sse('run.completed', 1)] }); });
    await badge('completed');
  });

});

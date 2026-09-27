/**
 * ADR 0600 §1 (`ISU-24`) — "No events yet." is a POSITIVE CLAIM about the run,
 * and run detail used to make it after the event read had THROWN.
 *
 * `RunDetailPage` mounts the event views unconditionally; its `pollEvents`
 * catch set a separate `error` state and left `events` at `[]`. Both views then
 * branched on `events.length === 0` and told the user the run had produced
 * nothing. For `insights-suite` that lands on top of a chain that already
 * reports `on_plan` from no data, so the honest failure and the dishonest
 * success read identically.
 *
 * Every case here asserts BOTH polarities on purpose: a guard that suppresses
 * the empty state unconditionally would pass a one-sided test and destroy the
 * real "this run produced nothing" answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { announce, currentAnnouncements } from '../../ui/announce.js';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
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
vi.mock('../../client/streamsClient.js', () => ({ subscribeToRun: api.subscribeToRun }));
const interrupts = vi.hoisted(() => ({ listOpenInterrupts: vi.fn() }));
vi.mock('../../client/interruptsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listOpenInterrupts: interrupts.listOpenInterrupts };
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
  runId: 'r1', status: 'completed', workflowId: 'wf1',
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
};

function view(): void {
  render(
    <MemoryRouter initialEntries={['/runs/r1']}>
      <Routes><Route path="/runs/:runId" element={<RunDetailPage />} /></Routes>
    </MemoryRouter>,
  );
}

/** Switch the event view to the flat log; the timeline is the default tab. */
function showLogView(): void {
  fireEvent.click(screen.getByRole('tab', { name: /log/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getRun.mockResolvedValue(SNAPSHOT);
  api.pollEvents.mockResolvedValue({ events: [] });
  api.subscribeToRun.mockReturnValue({ close: () => {} });
  interrupts.listOpenInterrupts.mockResolvedValue([]);
  announce('', { assertive: true });
});
afterEach(() => cleanup());

describe('run detail — the event log cannot claim "no events" on a failed read', () => {
  it('TIMELINE: a thrown event read says the log is unreadable, NOT "No events yet"', async () => {
    api.pollEvents.mockRejectedValue(new Error('boom'));
    view();
    await screen.findByText(/Couldn’t load this run’s events/i);
    expect(screen.queryByText(/No events yet/i)).toBeNull();
  });

  it('TIMELINE: a SUCCESSFUL read of zero events still says "No events yet"', async () => {
    view();
    await screen.findByText(/No events yet/i);
    expect(screen.queryByText(/Couldn’t load this run’s events/i)).toBeNull();
  });

  it('LOG: a thrown event read says the log is unreadable, NOT "No events yet"', async () => {
    api.pollEvents.mockRejectedValue(new Error('boom'));
    view();
    // Reach the log view WITHOUT first asserting on the timeline, so a defect
    // in one view cannot redden the other's case (a blast radius that would
    // make each sabotage unreadable).
    await screen.findByText('r1');
    showLogView();
    await screen.findByText(/Couldn’t load this run’s events/i);
    expect(screen.queryByText(/No events yet/i)).toBeNull();
  });

  it('LOG: a SUCCESSFUL read of zero events still says "No events yet"', async () => {
    view();
    await screen.findByText('r1');
    showLogView();
    await screen.findByText(/No events yet/i);
    expect(screen.queryByText(/Couldn’t load this run’s events/i)).toBeNull();
  });

  it('a failed SNAPSHOT read is a failed EVENT read too — pollEvents never ran', async () => {
    // `getRun` throws before `pollEvents` is called, so the log is exactly as
    // unread as if the poll itself had thrown. Leaving the view at "loading"
    // here would be a permanent spinner: the same lie, slower.
    api.getRun.mockRejectedValue(new Error('boom'));
    view();
    await screen.findByText(/Couldn’t load this run’s events/i);
    expect(api.pollEvents).not.toHaveBeenCalled();
    expect(screen.queryByText(/No events yet/i)).toBeNull();
  });

  it('retry re-reads and the empty claim returns once it is EARNED', async () => {
    api.pollEvents.mockRejectedValue(new Error('boom'));
    view();
    await screen.findByRole('button', { name: /retry/i });
    api.pollEvents.mockResolvedValue({ events: [] });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByText(/No events yet/i);
    await waitFor(() =>
      expect(screen.queryByText(/Couldn’t load this run’s events/i)).toBeNull());
  });

  it('a LATER read failing does not retroactively unread the events', async () => {
    // The initial load is one try-block covering four reads. The event poll
    // SUCCEEDED here; `listOpenInterrupts` is what threw. Marking the log
    // unreadable on that would be the mirror of the original defect — a
    // negative claim this time, but equally unearned.
    //
    // WHICH GUARD HOLDS THIS, stated because it is NOT the obvious one:
    // `refreshInterrupts` owns its own try/catch, so the throw never reaches
    // the loader's catch at all. A `prev === 'ready'` guard written in that
    // catch for this case was unreachable and sabotaged GREEN; it is gone.
    // This case pins the page-level property, not that deleted guard.
    interrupts.listOpenInterrupts.mockRejectedValue(new Error('boom'));
    view();
    await screen.findByText(/No events yet/i);
    expect(screen.queryByText(/Couldn’t load this run’s events/i)).toBeNull();
  });

  it('the analytics panel SAYS it could not measure, instead of vanishing', async () => {
    api.pollEvents.mockRejectedValue(new Error('boom'));
    view();
    await screen.findByText(/Run statistics could not be loaded/i);
  });

  it('a successful read of zero events leaves the analytics panel absent (not a false claim)', async () => {
    view();
    await screen.findByText(/No events yet/i);
    expect(screen.queryByText(/Run statistics could not be loaded/i)).toBeNull();
  });
});

/**
 * ADR 0600 §3 (`ISU-27`), run-detail half — the run-failure `Notice` is
 * CONDITIONALLY MOUNTED, so its inline `role="alert"` is the branch
 * `ui/Notice.tsx:6-28` says must not be treated as established.
 */
describe('run detail — a failed run is announced assertively', () => {
  it('a terminal failure reaches the assertive channel', async () => {
    api.getRun.mockResolvedValue({
      ...SNAPSHOT, status: 'failed',
      error: { code: 'invalid_config', message: 'core.bigquery.query requires config.sql' },
    });
    view();
    await screen.findAllByText(/invalid_config/);
    await waitFor(() => expect(currentAnnouncements().assertive).toMatch(/invalid_config/));
  });

  it('the announcement carries the CODE, not the raw server blob', async () => {
    api.getRun.mockResolvedValue({
      ...SNAPSHOT, status: 'failed',
      error: { code: 'invalid_config', message: 'core.bigquery.query requires config.sql' },
    });
    view();
    await waitFor(() => expect(currentAnnouncements().assertive).toMatch(/invalid_config/));
    expect(currentAnnouncements().assertive).not.toMatch(/requires config\.sql/);
  });

  it('a COMPLETED run announces nothing assertively (the polarity)', async () => {
    view();
    await screen.findByText('r1');
    expect(currentAnnouncements().assertive).toBe('');
  });
});

/**
 * ADR 0600 §Correction 8 (`LOW-4`) — `EventReadStateCard` shipped carrying
 * `if (events.length > 0) return null;`, a guard NEITHER caller can reach:
 * `streams/EventStreamView` and `runs/RunTimeline` both branch on
 * `events.length === 0` one frame up before mounting it. Same decorative-guard
 * class §1 makes a point of deleting (the `prev === 'ready'` catch guard that
 * sabotaged GREEN), shipped in the component §1 introduced. The guard and its
 * `events` prop are gone.
 *
 * WHICH GUARD HOLDS THE PROPERTY, named because it is no longer the obvious
 * one: each VIEW's own `events.length === 0` branch. So that is what these two
 * cases measure — through the views, not through the deleted line.
 */
const EV = {
  runId: 'r1', eventId: 'e1', sequence: 1, nodeId: 'compute', type: 'node.completed',
  ts: '2026-08-01T00:00:00Z', payload: { outputs: { verdict: 'off_plan' } },
} as never;

describe('events in hand outrank the read flag — held by the VIEWS, not by a guard inside the card', () => {
  it('TIMELINE: a failed refresh over a log we already have still renders the events', async () => {
    api.pollEvents.mockResolvedValue({ events: [EV] });
    view();
    await screen.findByText('r1');
    await waitFor(() => expect(screen.queryByText(/No events yet/i)).toBeNull());
    expect(screen.queryByText(/Couldn’t load this run’s events/i)).toBeNull();
    expect(screen.getByText(/compute/)).toBeTruthy();
  });

  it('LOG: the same, on the other view (the two must not drift)', async () => {
    api.pollEvents.mockResolvedValue({ events: [EV] });
    view();
    await screen.findByText('r1');
    showLogView();
    await screen.findByText(/node\.completed/);
    expect(screen.queryByText(/Couldn’t load this run’s events/i)).toBeNull();
    expect(screen.queryByText(/No events yet/i)).toBeNull();
  });
});

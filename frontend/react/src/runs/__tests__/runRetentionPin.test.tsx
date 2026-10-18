/**
 * ADR 0812 — the run page's retention pin reads `GET /host/openwop-app/runs/{id}/pin`,
 * never the snapshot.
 *
 * The SPA has spoken major 2 since v1 retired, and major 2's closed RunSnapshot
 * carries neither `pinned` nor `removalAt`. Reading them off the snapshot meant
 * `!snapshot.pinned` was always true: every click PINNED, "Unpin" never rendered,
 * and the pinned notice never showed.
 *
 * Each leg drives the rendered page. Leg 1 is the unpin path that could not happen
 * before. Leg 3 asserts that an UNKNOWN pin state disables the toggle rather than
 * presenting "Pin", which is the silent wrong state that shipped. Loading
 * ALSO disables the toggle, so leg 3 asserts only after the rejected read has
 * been handled (it awaits that promise) — otherwise "failed ⇒ disabled" would be
 * checked on a state that loading satisfies too.
 *
 * What turns it red: a click that always pins; the toggle not flipping after the
 * write; the pinned / removal notices hidden; the pin read off the snapshot; a
 * failed read folded into "not pinned".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { RunEventDoc, RunSnapshot } from '@openwop/openwop';
import { messages as en } from '../i18n/en.js';

const api = vi.hoisted(() => ({
  getRun: vi.fn(),
  pollEvents: vi.fn(),
  getRunRetention: vi.fn(),
  setRunPinned: vi.fn(),
  subscribeToRun: vi.fn(),
}));
vi.mock('../../client/runsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getRun: api.getRun, pollEvents: api.pollEvents, getRunRetention: api.getRunRetention, setRunPinned: api.setRunPinned };
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
vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.reject(new Error('no network in unit tests'))));
const { RunDetailPage } = await import('../RunDetailPage.js');

const SNAPSHOT: RunSnapshot = {
  runId: 'r1', status: 'completed', workflowId: 'wf',
  owner: { tenant: 't1', subject: { issuer: 'urn:openwop:test', subjectId: 'u1', tenant: 't1', lane: 'session', kind: 'user' } },
  eventLogSchemaVersion: 3,
};
const EVENT: RunEventDoc = {
  eventId: 'e1', sequence: 1, type: 'run.completed', runId: 'r1',
  timestamp: '2026-08-01T00:00:01Z', schemaVersion: 1, payload: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  // A completed run, exactly as the major-2 snapshot arrives: no pinned, no removalAt.
  api.getRun.mockResolvedValue(SNAPSHOT);
  api.pollEvents.mockResolvedValue({ events: [EVENT] });
  api.subscribeToRun.mockReturnValue({ close: () => {} });
});
afterEach(() => cleanup());

function mount(): void {
  render(
    <MemoryRouter initialEntries={['/runs/r1']}>
      <Routes><Route path="/runs/:runId" element={<RunDetailPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe('run retention pin reads the host, not the closed v2 snapshot', () => {
  it('a PINNED run shows "Unpin" and the pinned notice, and unpins on click', async () => {
    api.getRunRetention.mockResolvedValue({ pinned: true, removalAt: '2026-09-01T00:00:00Z' });
    api.setRunPinned.mockResolvedValue(false);
    mount();
    const btn = await screen.findByRole('button', { name: en.retentionUnpin });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(en.retentionPinned)).toBeTruthy();
    fireEvent.click(btn);
    await waitFor(() => expect(api.setRunPinned).toHaveBeenCalledWith('r1', false));
    expect(await screen.findByRole('button', { name: en.retentionPin })).toBeTruthy();
  });

  it('an UNPINNED run shows the removal date and "Pin" (positive control)', async () => {
    // Midday UTC, so no runner timezone flips the calendar day.
    api.getRunRetention.mockResolvedValue({ pinned: false, removalAt: '2026-09-15T12:00:00Z' });
    api.setRunPinned.mockResolvedValue(true);
    mount();
    // The removal notice renders only once the retention read LANDED.
    const notice = await screen.findByText(/This run will be removed on/);
    // The DATE, not just the prefix (literal fragments — never fmtTime's output).
    expect(notice.textContent).toMatch(/2026/);
    expect(notice.textContent).toMatch(/15/);
    const btn = screen.getByRole('button', { name: en.retentionPin });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.hasAttribute('disabled')).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(api.setRunPinned).toHaveBeenCalledWith('r1', true));
  });

  it('an UNKNOWN pin state (the read failed) disables the toggle instead of claiming "not pinned"', async () => {
    api.getRunRetention.mockRejectedValue(new Error('500'));
    mount();
    const btn = await screen.findByRole('button', { name: en.retentionPin });
    await waitFor(() => expect(api.getRunRetention).toHaveBeenCalled());
    // Settle on the REJECTION itself, then let the page's catch commit.
    const read: Promise<unknown> = api.getRunRetention.mock.results[0]!.value;
    await act(async () => { await read.catch(() => undefined); });
    await act(async () => { await Promise.resolve(); });
    expect(btn.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText(en.retentionPinned)).toBeNull();
    expect(screen.queryByText(/This run will be removed on/)).toBeNull();
  });
});

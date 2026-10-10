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
 * presenting "Pin", which is the silent wrong state that shipped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
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
vi.stubGlobal('fetch', (() => Promise.reject(new Error('no network in unit tests'))) as never);
const { RunDetailPage } = await import('../RunDetailPage.js');

beforeEach(() => {
  vi.clearAllMocks();
  // A completed run, exactly as the major-2 snapshot arrives: no pinned, no removalAt.
  api.getRun.mockResolvedValue({ runId: 'r1', status: 'completed', workflowId: 'wf', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' });
  api.pollEvents.mockResolvedValue({ events: [{ eventId: 'e1', sequence: 1, type: 'run.completed', runId: 'r1' }] });
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
    api.getRunRetention.mockResolvedValue({ pinned: false, removalAt: '2026-09-01T00:00:00Z' });
    api.setRunPinned.mockResolvedValue(true);
    mount();
    const btn = await screen.findByRole('button', { name: en.retentionPin });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText(/This run will be removed on/)).toBeTruthy();
    fireEvent.click(btn);
    await waitFor(() => expect(api.setRunPinned).toHaveBeenCalledWith('r1', true));
  });

  it('an UNKNOWN pin state (the read failed) disables the toggle instead of claiming "not pinned"', async () => {
    api.getRunRetention.mockRejectedValue(new Error('500'));
    mount();
    const btn = await screen.findByRole('button', { name: en.retentionPin });
    await waitFor(() => expect(api.getRunRetention).toHaveBeenCalled());
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(en.retentionPinned)).toBeNull();
    expect(screen.queryByText(/This run will be removed on/)).toBeNull();
  });
});

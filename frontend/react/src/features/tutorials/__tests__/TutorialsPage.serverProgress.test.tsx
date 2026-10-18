/**
 * ADR 0488 D4 — server-backed tutorial progress, and the honesty of its modes.
 *
 * The behaviour worth pinning is not "it saves"; it is what the learner is TOLD
 * when it does not. A failed read must never render as "no progress" (that looks
 * to the learner exactly like their work being deleted), and a failed write must
 * never render as saved.
 *
 * w52: every case now waits for the progress read to SETTLE (the call plus a
 * drain) before it clicks or asserts. Round 1 waited only for the call, so the
 * SERVER-mode case asserted "no device chip" while the mode was still
 * 'checking' (no chip either) — probe tsp-server reddened five OTHER cases and
 * not that one. The two 20 ms sleeps are drains. "does NOT echo" counts the save
 * calls over the settled window (exactly 0). The merge mock answers `merged`
 * ONCE (a concurrent device merges once): with the echo guard removed, an
 * always-merging mock re-saved forever and hung the file (w52 tsp-echo).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

/** Let the mocked progress read resolve and every follow-on effect/save land. */
async function drain(): Promise<void> {
  await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); });
}
async function settle(): Promise<void> {
  await waitFor(() => expect(client.fetchTutorialProgress).toHaveBeenCalled());
  await drain();
}
/** The step's own toggle (its text carries the step id). */
function stepToggle(stepId: string): HTMLElement {
  const b = screen.getAllByRole('button').find((x) => x.textContent?.includes(stepId));
  expect(b, `step toggle ${stepId} not found`).toBeTruthy();
  return b!;
}
const AT = '2026-10-01T00:00:00.000Z';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// NB: an enumerated module mock breaks the moment the module gains an export —
// the page later grew `fetchTutorials`/`fetchTutorial` (server-first content) and
// every test here died on `undefined is not a function`. The content fetches are
// stubbed inert so this file keeps testing PROGRESS only.
type Client = typeof import('../tutorialsClient.js');
const client = vi.hoisted(() => ({
  fetchTutorialProgress: vi.fn<Client['fetchTutorialProgress']>(), saveTutorialProgress: vi.fn<Client['saveTutorialProgress']>(),
  fetchTutorials: vi.fn<Client['fetchTutorials']>(), fetchTutorial: vi.fn<Client['fetchTutorial']>(),
}));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../tutorialsClient.js', () => client);
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: false }),
}));

const { TutorialsPage } = await import('../TutorialsPage.js');
const { TUTORIALS } = await import('../registry.js');

const FIRST = TUTORIALS[0]!;

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={[`/tutorials/${FIRST.id}`]}>
      <Routes><Route path="/tutorials/:tutorialId" element={<TutorialsPage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  client.saveTutorialProgress.mockResolvedValue({ ok: true });
  // Inert: the in-tree floor supplies content, so these tests stay about progress.
  client.fetchTutorials.mockResolvedValue({ ok: false, degraded: false, tutorials: [] });
  client.fetchTutorial.mockResolvedValue({ ok: false, tutorial: null });
});
afterEach(() => localStorage.clear());

describe('ADR 0488 D4 — progress mode honesty', () => {
  it('a signed-in learner gets SERVER mode and no "device only" chip', async () => {
    client.fetchTutorialProgress.mockResolvedValue({ ok: true, persisted: true, rows: [] });
    renderDetail();
    // SETTLE first: the pre-resolution 'checking' mode renders no chip either, so
    // an absence asserted before the read lands cannot tell server from local.
    await settle();
    expect(screen.queryByText('Saved on this device')).toBeNull();
    expect(screen.queryByText('Not synced')).toBeNull();
  });

  it('an ANONYMOUS reader is told progress is device-only (never implied to be saved)', async () => {
    client.fetchTutorialProgress.mockResolvedValue({ ok: true, persisted: false, rows: [] });
    renderDetail();
    expect(await screen.findByText('Saved on this device')).toBeTruthy();
  });

  it('a FAILED read shows "Not synced" — never a silent empty state', async () => {
    client.fetchTutorialProgress.mockResolvedValue({ ok: false, persisted: false, rows: [] });
    renderDetail();
    expect(await screen.findByText('Not synced')).toBeTruthy();
  });

  it('server rows HYDRATE the checkboxes (cross-device is the point)', async () => {
    const stepId = FIRST.phases[0]!.steps[0]!.id;
    client.fetchTutorialProgress.mockResolvedValue({
      ok: true, persisted: true,
      rows: [{ tutorialId: FIRST.id, completedStepIds: [stepId], updatedAt: AT }],
    });
    renderDetail();
    await settle();
    // THAT step's toggle is pressed — not merely "some button is pressed".
    expect(stepToggle(stepId).getAttribute('aria-pressed')).toBe('true');
  });

  it('does NOT echo the hydrated value back to the server (no redundant write)', async () => {
    const stepId = FIRST.phases[0]!.steps[0]!.id;
    client.fetchTutorialProgress.mockResolvedValue({
      ok: true, persisted: true,
      rows: [{ tutorialId: FIRST.id, completedStepIds: [stepId], updatedAt: AT }],
    });
    renderDetail();
    await settle();
    expect(stepToggle(stepId).getAttribute('aria-pressed')).toBe('true'); // hydrated (positive control)
    // Count the writes over the settled window: hydrating, then the mode flip,
    // must send NOTHING (each would be an echo of what the server already holds).
    await drain();
    expect(client.saveTutorialProgress).toHaveBeenCalledTimes(0);
  });

  it('a toggle DOES persist, and a failed write downgrades to "Not synced"', async () => {
    client.fetchTutorialProgress.mockResolvedValue({ ok: true, persisted: true, rows: [] });
    client.saveTutorialProgress.mockResolvedValue({ ok: false }); // the write fails
    renderDetail();
    await settle();

    const stepId = FIRST.phases[0]!.steps[0]!.id;
    await act(async () => { fireEvent.click(stepToggle(stepId)); });

    await waitFor(() => expect(client.saveTutorialProgress).toHaveBeenCalledWith(FIRST.id, [stepId], undefined));
    // The learner is TOLD the write did not land.
    expect(await screen.findByText('Not synced')).toBeTruthy();
  });

  it('adopts the server list when a concurrent device forced a MERGE', async () => {
    // grade-data `TUT-7`: another device completed a step this one never saw.
    // The server unions and says so; the UI must take the server's list rather
    // than sit on a set the server no longer holds.
    client.fetchTutorialProgress.mockResolvedValue({ ok: true, persisted: true, rows: [] });
    const mine = FIRST.phases[0]!.steps[0]!.id;
    const theirs = FIRST.phases[1]?.steps[0]?.id ?? '9.9';
    // The server merges ONCE (a concurrent device); later writes are plain acks.
    client.saveTutorialProgress.mockResolvedValueOnce({ ok: true, merged: [mine, theirs] }).mockResolvedValue({ ok: true });
    renderDetail();
    await settle();

    await act(async () => { fireEvent.click(stepToggle(mine)); });

    // The OTHER device's step is now shown as done — pressed state, not just text.
    await waitFor(() => {
      const other = screen.getAllByRole('button').find((b) => b.textContent?.includes(theirs));
      expect(other?.getAttribute('aria-pressed')).toBe('true');
    });
    // And we did not fall back to the "not synced" downgrade: the write succeeded.
    expect(screen.queryByText('Not synced')).toBeNull();
  });

  it('RESET sends an explicit clear so the server does not union it back', async () => {
    client.fetchTutorialProgress.mockResolvedValue({
      ok: true, persisted: true,
      rows: [{ tutorialId: FIRST.id, completedStepIds: [FIRST.phases[0]!.steps[0]!.id], updatedAt: '2026-07-27T00:00:00.000Z' }],
    });
    client.saveTutorialProgress.mockResolvedValue({ ok: true });
    renderDetail();
    await settle();

    const reset = screen.getAllByRole('button').find((b) => /reset/i.test(b.textContent ?? ''));
    expect(reset, 'reset control not found').toBeTruthy();
    await act(async () => { fireEvent.click(reset!); });

    await waitFor(() => expect(client.saveTutorialProgress).toHaveBeenCalledWith(FIRST.id, [], 'clear'));
  });

  it('an anonymous learner never writes to the server at all', async () => {
    client.fetchTutorialProgress.mockResolvedValue({ ok: true, persisted: false, rows: [] });
    renderDetail();
    await screen.findByText('Saved on this device');
    const stepId = FIRST.phases[0]!.steps[0]!.id;
    await act(async () => { fireEvent.click(stepToggle(stepId)); });
    await drain();
    expect(client.saveTutorialProgress).not.toHaveBeenCalled();
    // …but the local floor still holds it.
    expect(localStorage.getItem(`openwop-app.tutorials.${FIRST.id}`)).toContain(stepId);
  });
});

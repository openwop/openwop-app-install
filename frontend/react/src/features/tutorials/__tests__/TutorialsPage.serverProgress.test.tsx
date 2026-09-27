/**
 * ADR 0488 D4 — server-backed tutorial progress, and the honesty of its modes.
 *
 * The behaviour worth pinning is not "it saves"; it is what the learner is TOLD
 * when it does not. A failed read must never render as "no progress" (that looks
 * to the learner exactly like their work being deleted), and a failed write must
 * never render as saved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// NB: an enumerated module mock breaks the moment the module gains an export —
// the page later grew `fetchTutorials`/`fetchTutorial` (server-first content) and
// every test here died on `undefined is not a function`. The content fetches are
// stubbed inert so this file keeps testing PROGRESS only.
const client = vi.hoisted(() => ({
  fetchTutorialProgress: vi.fn(),
  saveTutorialProgress: vi.fn(),
  fetchTutorials: vi.fn(),
  fetchTutorial: vi.fn(),
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
    // Wait for the ABSENCE, not just for the call. Waiting on the call only
    // proves the request fired; the mode state has not necessarily flushed, so
    // under full-suite load the initial `local` mode was still rendering and the
    // device-only chip was briefly present. Asserting inside waitFor retries
    // until the hydrated state lands — this failed ONLY in the 441-file run,
    // never in isolation, which is the signature of exactly this mistake.
    await waitFor(() => {
      expect(client.fetchTutorialProgress).toHaveBeenCalled();
      expect(screen.queryByText('Saved on this device')).toBeNull();
      expect(screen.queryByText('Not synced')).toBeNull();
    });
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
      rows: [{ tutorialId: FIRST.id, completedStepIds: [stepId], updatedAt: 'x' }],
    });
    renderDetail();
    // The step toggle is a pressed chip once complete.
    await waitFor(() => {
      const pressed = screen.getAllByRole('button', { pressed: true });
      expect(pressed.length).toBeGreaterThan(0);
    });
  });

  it('does NOT echo the hydrated value back to the server (no redundant write)', async () => {
    const stepId = FIRST.phases[0]!.steps[0]!.id;
    client.fetchTutorialProgress.mockResolvedValue({
      ok: true, persisted: true,
      rows: [{ tutorialId: FIRST.id, completedStepIds: [stepId], updatedAt: 'x' }],
    });
    renderDetail();
    await waitFor(() => expect(screen.getAllByRole('button', { pressed: true }).length).toBeGreaterThan(0));
    // Give any stray effect a chance to fire before asserting the negative.
    await new Promise((r) => setTimeout(r, 20));
    expect(client.saveTutorialProgress).not.toHaveBeenCalled();
  });

  it('a toggle DOES persist, and a failed write downgrades to "Not synced"', async () => {
    client.fetchTutorialProgress.mockResolvedValue({ ok: true, persisted: true, rows: [] });
    client.saveTutorialProgress.mockResolvedValue({ ok: false }); // the write fails
    renderDetail();
    await waitFor(() => expect(client.fetchTutorialProgress).toHaveBeenCalled());

    const stepId = FIRST.phases[0]!.steps[0]!.id;
    const toggle = screen.getAllByRole('button').find((b) => b.textContent?.includes(stepId));
    expect(toggle, 'step toggle not found').toBeTruthy();
    await act(async () => { fireEvent.click(toggle!); });

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
    client.saveTutorialProgress.mockResolvedValue({ ok: true, merged: [mine, theirs] });
    renderDetail();
    await waitFor(() => expect(client.fetchTutorialProgress).toHaveBeenCalled());

    const toggle = screen.getAllByRole('button').find((b) => b.textContent?.includes(mine));
    await act(async () => { fireEvent.click(toggle!); });

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
    await waitFor(() => expect(client.fetchTutorialProgress).toHaveBeenCalled());

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
    const toggle = screen.getAllByRole('button').find((b) => b.textContent?.includes(stepId));
    await act(async () => { fireEvent.click(toggle!); });
    await new Promise((r) => setTimeout(r, 20));
    expect(client.saveTutorialProgress).not.toHaveBeenCalled();
    // …but the local floor still holds it.
    expect(localStorage.getItem(`openwop-app.tutorials.${FIRST.id}`)).toContain(stepId);
  });
});

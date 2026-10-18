/**
 * ADR 0488 D7 — the contextual "Teach me this" affordance.
 *
 * The rules worth pinning are the RESTRAINT rules, not "it renders". Contextual
 * guidance earns its place by being ignorable: it must never auto-launch, must
 * stay dismissed once waved off, and must not appear where it is circular.
 *
 * w52 (four probes came back vacuous in round 1):
 *  - "never circular" was unreachable — no shipped tutorial declares a
 *    `/tutorials` surface — so the case now adds one for its duration;
 *  - the CTA href is asserted EXACTLY (a `/start` launch route passed `toContain`);
 *  - "never auto-launches" and the COMPLETED / PARTIAL cases now wait for the
 *    progress read to SETTLE before asserting (they asserted while it was in
 *    flight, so a late launch / a wrong completion rule was invisible).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
type Client = typeof import('../tutorialsClient.js');
const client = vi.hoisted(() => ({
  fetchTutorialProgress: vi.fn<Client['fetchTutorialProgress']>(), saveTutorialProgress: vi.fn<Client['saveTutorialProgress']>(),
  fetchTutorials: vi.fn<Client['fetchTutorials']>(), fetchTutorial: vi.fn<Client['fetchTutorial']>(),
}));
vi.mock('../tutorialsClient.js', () => client);

const { TutorialHint } = await import('../TutorialHint.js');
const { TUTORIALS } = await import('../registry.js');

/** A tutorial that actually declares surfaces — the fixture must be real, or
 *  every assertion below is unreachable (the incomplete-fixture trap). */
const WITH_SURFACE = TUTORIALS.find((t) => (t.surfaces ?? []).length > 0);

/** Let the (mocked) progress read resolve and its state land. */
async function settleProgress(): Promise<void> {
  await waitFor(() => expect(client.fetchTutorialProgress).toHaveBeenCalled());
  await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); });
}

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><TutorialHint /></MemoryRouter>);
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  client.fetchTutorialProgress.mockResolvedValue({ ok: true, persisted: false, rows: [] });
});

describe('ADR 0488 D7 — contextual placement', () => {
  it('the fixture is real (non-vacuous — no surfaces would make every case unreachable)', () => {
    expect(WITH_SURFACE, 'no tutorial declares surfaces').toBeTruthy();
    expect(WITH_SURFACE!.surfaces!.length).toBeGreaterThan(0);
  });

  it('offers the tutorial on a route it teaches', () => {
    renderAt(WITH_SURFACE!.surfaces![0]!);
    expect(screen.getByText('Teach me this')).toBeTruthy();
  });

  it('offers it on a CHILD of that route too', () => {
    renderAt(`${WITH_SURFACE!.surfaces![0]!}/some-record`);
    expect(screen.getByText('Teach me this')).toBeTruthy();
  });

  it('does NOT prefix-match a different feature (/commerce must not claim /commerce-connect)', () => {
    renderAt('/commerce-connect');
    expect(screen.queryByText('Teach me this')).toBeNull();
  });

  it('shows nothing on an unrelated route', () => {
    renderAt('/definitely-not-a-taught-route');
    expect(screen.queryByText('Teach me this')).toBeNull();
  });

  it('is never circular — silent on /tutorials and its detail pages', () => {
    // No shipped tutorial teaches /tutorials, so without this fixture the guard
    // was unreachable (w52 th-circular was vacuous). Add one for this case only.
    const circ = { ...WITH_SURFACE!, id: 'circular-fixture', surfaces: ['/tutorials'] };
    TUTORIALS.push(circ);
    try {
      renderAt('/tutorials');
      expect(screen.queryByText('Teach me this')).toBeNull();
      renderAt('/tutorials/connect-your-ai');
      expect(screen.queryByText('Teach me this')).toBeNull();
    } finally {
      TUTORIALS.splice(TUTORIALS.indexOf(circ), 1);
    }
  });

  it('NEVER auto-launches a walkthrough — it links, it does not seize the wheel', async () => {
    const bus = await import('../../../walkthroughs/walkthroughBus.js');
    const spy = vi.spyOn(bus, 'requestWalkthroughLaunch');
    try {
      renderAt(WITH_SURFACE!.surfaces![0]!);
      // Settle first: a launch fired from an effect or a resolved read lands AFTER render.
      await settleProgress();
      expect(screen.getByText('Teach me this')).toBeTruthy(); // the hint is up (positive control)
      expect(spy).not.toHaveBeenCalled();
      // …and the CTA is a link to the tutorial itself, not a run/launch route.
      expect(screen.getByText('Teach me this').closest('a')?.getAttribute('href'))
        .toBe(`/tutorials/${WITH_SURFACE!.id}`);
    } finally {
      spy.mockRestore();
    }
  });

  it('STAYS dismissed — a hint waved off is noise on every later visit', () => {
    const { unmount } = renderAt(WITH_SURFACE!.surfaces![0]!);
    fireEvent.click(screen.getByText('Dismiss'));
    expect(screen.queryByText('Teach me this')).toBeNull();
    unmount();
    renderAt(WITH_SURFACE!.surfaces![0]!);
    expect(screen.queryByText('Teach me this'), 'the hint came back after dismissal').toBeNull();
  });

  it('dismissing one tutorial does not suppress the others', () => {
    const other = TUTORIALS.find((t) => t.id !== WITH_SURFACE!.id && (t.surfaces ?? []).length > 0);
    expect(other, 'need a second surfaced tutorial for this case').toBeTruthy();
    localStorage.setItem('openwop-app.tutorials.hintsDismissed', JSON.stringify([WITH_SURFACE!.id]));
    renderAt(other!.surfaces![0]!);
    expect(screen.getByText('Teach me this')).toBeTruthy();
  });

  it('does NOT offer a tutorial the learner has already COMPLETED', async () => {
    // The whole-program grade pass found D7 shipping without consulting D4's
    // progress: the hint kept nagging on a screen whose tutorial was finished.
    const total = WITH_SURFACE!.phases.reduce((n, p) => n + p.steps.length, 0);
    const allSteps = WITH_SURFACE!.phases.flatMap((p) => p.steps.map((s) => s.id));
    expect(total, 'fixture must have steps or this case is unreachable').toBeGreaterThan(0);
    client.fetchTutorialProgress.mockResolvedValue({
      ok: true, persisted: true,
      rows: [{ tutorialId: WITH_SURFACE!.id, completedStepIds: allSteps, updatedAt: '2026-10-01T00:00:00.000Z' }],
    });
    renderAt(WITH_SURFACE!.surfaces![0]!);
    await settleProgress();
    expect(screen.queryByText('Teach me this')).toBeNull();
  });

  it('still offers a PARTIALLY-completed tutorial (only finished ones are suppressed)', async () => {
    client.fetchTutorialProgress.mockResolvedValue({
      ok: true, persisted: true,
      rows: [{ tutorialId: WITH_SURFACE!.id, completedStepIds: [WITH_SURFACE!.phases[0]!.steps[0]!.id], updatedAt: '2026-10-01T00:00:00.000Z' }],
    });
    renderAt(WITH_SURFACE!.surfaces![0]!);
    // AFTER the progress read lands — the hint is up on first paint anyway, so
    // asserting earlier could not see a rule that wrongly calls this "finished".
    await settleProgress();
    expect(screen.getByText('Teach me this')).toBeTruthy();
  });
});

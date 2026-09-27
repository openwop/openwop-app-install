/**
 * ADR 0488 D7 — the contextual "Teach me this" affordance.
 *
 * The rules worth pinning are the RESTRAINT rules, not "it renders". Contextual
 * guidance earns its place by being ignorable: it must never auto-launch, must
 * stay dismissed once waved off, and must not appear where it is circular.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
const client = vi.hoisted(() => ({ fetchTutorialProgress: vi.fn(), saveTutorialProgress: vi.fn(), fetchTutorials: vi.fn(), fetchTutorial: vi.fn() }));
vi.mock('../tutorialsClient.js', () => client);

const { TutorialHint } = await import('../TutorialHint.js');
const { TUTORIALS } = await import('../registry.js');

/** A tutorial that actually declares surfaces — the fixture must be real, or
 *  every assertion below is unreachable (the incomplete-fixture trap). */
const WITH_SURFACE = TUTORIALS.find((t) => (t.surfaces ?? []).length > 0);

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
    renderAt('/tutorials');
    expect(screen.queryByText('Teach me this')).toBeNull();
    renderAt('/tutorials/connect-your-ai');
    expect(screen.queryByText('Teach me this')).toBeNull();
  });

  it('NEVER auto-launches a walkthrough — it links, it does not seize the wheel', async () => {
    const bus = await import('../../../walkthroughs/walkthroughBus.js');
    const spy = vi.spyOn(bus, 'requestWalkthroughLaunch');
    renderAt(WITH_SURFACE!.surfaces![0]!);
    expect(spy).not.toHaveBeenCalled();
    // …and the CTA is a link to the tutorial, not a run trigger.
    expect(screen.getByText('Teach me this').closest('a')?.getAttribute('href'))
      .toContain(`/tutorials/${WITH_SURFACE!.id}`);
    spy.mockRestore();
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
      rows: [{ tutorialId: WITH_SURFACE!.id, completedStepIds: allSteps, updatedAt: 'x' }],
    });
    renderAt(WITH_SURFACE!.surfaces![0]!);
    await waitFor(() => expect(client.fetchTutorialProgress).toHaveBeenCalled());
    expect(screen.queryByText('Teach me this')).toBeNull();
  });

  it('still offers a PARTIALLY-completed tutorial (only finished ones are suppressed)', async () => {
    client.fetchTutorialProgress.mockResolvedValue({
      ok: true, persisted: true,
      rows: [{ tutorialId: WITH_SURFACE!.id, completedStepIds: [WITH_SURFACE!.phases[0]!.steps[0]!.id], updatedAt: 'x' }],
    });
    renderAt(WITH_SURFACE!.surfaces![0]!);
    expect(await screen.findByText('Teach me this')).toBeTruthy();
  });
});

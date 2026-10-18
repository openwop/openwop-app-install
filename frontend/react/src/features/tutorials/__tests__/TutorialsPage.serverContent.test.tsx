/**
 * ADR 0488 D1/D3 — tutorial CONTENT is server-first with the in-tree floor.
 *
 * Found by the whole-program grade pass: P1 moved the narrative into the kernel
 * and P6's Tutor agent read it, but this page still rendered the in-tree
 * registry — so a workspace that EDITED a tutorial saw the edit from the Tutor
 * and the shipped text from the page. Two user-visible sources of truth for one
 * artifact.
 *
 * The behaviours worth pinning are the failure modes, not the happy path: a
 * failed read must floor to the shipped library, never to an empty catalog.
 *
 * DOUBLE GUARD (w52, probe tsc-failed came back vacuous by design): a FAILED
 * catalog read is floored twice — `!res.ok` returns before `server` is set (so
 * the in-tree TUTORIALS render), and even an EMPTY server map would show every
 * tutorial through the floor loop (`for (const t of TUTORIALS) if
 * (!server.has(t.id)) merged.push(t)`). Removing either alone changes nothing on
 * a failed read; the floor loop is witnessed on its own by 'a tutorial the server
 * does not know about…' (probe tsc-floor). Case 1 pins the user-visible outcome.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

type Client = typeof import('../tutorialsClient.js');
const client = vi.hoisted(() => ({
  fetchTutorialProgress: vi.fn<Client['fetchTutorialProgress']>(), saveTutorialProgress: vi.fn<Client['saveTutorialProgress']>(),
  fetchTutorials: vi.fn<Client['fetchTutorials']>(), fetchTutorial: vi.fn<Client['fetchTutorial']>(),
}));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../tutorialsClient.js', () => client);
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => makeFeatureAccess({ enabled: false }) }));

const { TutorialsPage } = await import('../TutorialsPage.js');
const { TUTORIALS } = await import('../registry.js');
const FIRST = TUTORIALS[0]!;

const renderList = () => render(
  <MemoryRouter initialEntries={['/tutorials']}>
    <Routes><Route path="/tutorials" element={<TutorialsPage />} /></Routes>
  </MemoryRouter>);

const renderDetail = (id = FIRST.id) => render(
  <MemoryRouter initialEntries={[`/tutorials/${id}`]}>
    <Routes><Route path="/tutorials/:tutorialId" element={<TutorialsPage />} /></Routes>
  </MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  client.fetchTutorialProgress.mockResolvedValue({ ok: true, persisted: false, rows: [] });
  client.saveTutorialProgress.mockResolvedValue({ ok: true });
  client.fetchTutorials.mockResolvedValue({ ok: true, degraded: false, tutorials: [] });
  client.fetchTutorial.mockResolvedValue({ ok: true, tutorial: null });
});

describe('ADR 0488 — server-first content with the in-tree floor', () => {
  it('a FAILED catalog read floors to the shipped library — never an empty catalog', async () => {
    client.fetchTutorials.mockResolvedValue({ ok: false, degraded: false, tutorials: [] });
    renderList();
    await waitFor(() => expect(client.fetchTutorials).toHaveBeenCalled());
    // Let the FAILED answer land before looking (the floor is also the pre-read state).
    await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); });
    // Every shipped tutorial is still reachable.
    for (const t of TUTORIALS) expect(screen.getByText(t.title)).toBeTruthy();
  });

  it("a workspace's EDITED title wins over the shipped one (the whole point of the kernel lane)", async () => {
    client.fetchTutorials.mockResolvedValue({
      ok: true, degraded: false,
      tutorials: [{ ...FIRST, title: 'Our own renamed tutorial', source: 'kernel', customized: true }],
    });
    renderList();
    expect(await screen.findByText('Our own renamed tutorial')).toBeTruthy();
    expect(screen.queryByText(FIRST.title)).toBeNull();
  });

  it('a tutorial the server does not know about is still shown from the floor', async () => {
    // Dropping it would hide content the reader can legitimately open.
    client.fetchTutorials.mockResolvedValue({
      ok: true, degraded: false,
      tutorials: [{ ...FIRST, source: 'seed' }],
    });
    renderList();
    await waitFor(() => expect(client.fetchTutorials).toHaveBeenCalled());
    for (const t of TUTORIALS) expect(screen.getByText(t.title)).toBeTruthy();
  });

  it('the DETAIL page prefers the server copy', async () => {
    client.fetchTutorial.mockResolvedValue({
      ok: true, tutorial: { ...FIRST, hero: { ...FIRST.hero, title: 'Server hero' } },
    });
    renderDetail();
    expect(await screen.findByText('Server hero')).toBeTruthy();
  });

  it('a FAILED detail read floors to the in-tree copy rather than a not-found', async () => {
    client.fetchTutorial.mockResolvedValue({ ok: false, tutorial: null });
    renderDetail();
    await waitFor(() => expect(client.fetchTutorial).toHaveBeenCalled());
    expect(screen.getByText(FIRST.hero.title)).toBeTruthy();
  });

  it('an unknown slug is still not-found (the floor does not invent a tutorial)', async () => {
    renderDetail('no-such-tutorial');
    await waitFor(() => expect(client.fetchTutorial).toHaveBeenCalled());
    // The not-found state itself — a blank page would also have no hero.
    expect(await screen.findByText('Tutorial not found')).toBeTruthy();
    expect(screen.queryByText(FIRST.hero.title)).toBeNull();
  });
});

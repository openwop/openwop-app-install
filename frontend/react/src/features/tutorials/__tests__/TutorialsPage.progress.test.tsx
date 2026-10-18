/**
 * GT-1 (grade-code) — cross-tutorial progress isolation: navigating DIRECTLY
 * from tutorial A to tutorial B (browser back/forward, deep links) must not
 * bleed A's done-set into B's localStorage key. The fix keys TutorialDetail by
 * tutorial id so the progress hook remounts; this test drives a direct A→B
 * route change inside one router and pins both keys.
 *
 * w52: fetch-free (the tutorials client is mocked — anonymous progress, content
 * reads failing to the in-tree floor), and the wait for tutorial B no longer
 * swallows its timeout: round 1's `.catch(() => undefined)` let "B's key is
 * absent" pass when B had never rendered at all. Sabotage-witnessed: dropping
 * `key={tutorial.id}` on TutorialDetail writes A's set under B's key.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';

type Client = typeof import('../tutorialsClient.js');
const client = vi.hoisted(() => ({
  fetchTutorialProgress: vi.fn<Client['fetchTutorialProgress']>(async () => ({ ok: true, persisted: false, rows: [] })),
  saveTutorialProgress: vi.fn<Client['saveTutorialProgress']>(async () => ({ ok: true })),
  fetchTutorials: vi.fn<Client['fetchTutorials']>(async () => ({ ok: false, degraded: false, tutorials: [] })),
  fetchTutorial: vi.fn<Client['fetchTutorial']>(async () => ({ ok: false, tutorial: null })),
}));
vi.mock('../tutorialsClient.js', () => client);

import { TutorialsPage } from '../TutorialsPage.js';

afterEach(() => { cleanup(); localStorage.clear(); });

function Jump({ to }: { to: string }): JSX.Element {
  const nav = useNavigate();
  return <button type="button" onClick={() => nav(to)}>jump-to-b</button>;
}

const A = 'connect-your-ai';
const B = 'build-your-first-funnel';
const keyOf = (id: string): string => `openwop-app.tutorials.${id}`;

describe('TutorialsPage — progress isolation (GT-1)', () => {
  it('a direct A→B navigation never writes A’s progress under B’s key', async () => {
    render(
      <MemoryRouter initialEntries={[`/tutorials/${A}`]}>
        <Routes>
          <Route path="/tutorials/:tutorialId" element={<><TutorialsPage /><Jump to={`/tutorials/${B}`} /></>} />
          <Route path="/tutorials" element={<TutorialsPage />} />
        </Routes>
      </MemoryRouter>,
    );

    // mark step 1.1 done in tutorial A
    const stepToggle = await screen.findByRole('button', { name: /Mark step 1\.1/ });
    fireEvent.click(stepToggle);
    expect(JSON.parse(localStorage.getItem(keyOf(A)) ?? '[]')).toEqual(['1.1']);

    // jump DIRECTLY to tutorial B (same router, no list in between)
    fireEvent.click(screen.getByRole('button', { name: 'jump-to-b' }));
    // B must actually be on screen — a wait that returns quietly would let the
    // "B's key is untouched" check pass with B never mounted.
    expect(await screen.findByRole('heading', { name: 'Build Your First Sales Funnel' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Connect Your AI' })).toBeNull();

    // B's key must be untouched (absent or empty) and A's intact
    const bRaw = localStorage.getItem(keyOf(B));
    expect(bRaw === null || JSON.parse(bRaw).length === 0).toBe(true);
    expect(JSON.parse(localStorage.getItem(keyOf(A)) ?? '[]')).toEqual(['1.1']);
  });
});

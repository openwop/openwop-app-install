/**
 * GT-1 (grade-code) — cross-tutorial progress isolation: navigating DIRECTLY
 * from tutorial A to tutorial B (browser back/forward, deep links) must not
 * bleed A's done-set into B's localStorage key. The fix keys TutorialDetail by
 * tutorial id so the progress hook remounts; this test drives a direct A→B
 * route change inside one router and pins both keys.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
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
    await screen.findByText('Build Your First Sales Funnel', { selector: 'h1, h2, h3, p, span, div' }, { timeout: 2000 }).catch(() => undefined);

    // B's key must be untouched (absent or empty) and A's intact
    const bRaw = localStorage.getItem(keyOf(B));
    expect(bRaw === null || JSON.parse(bRaw).length === 0).toBe(true);
    expect(JSON.parse(localStorage.getItem(keyOf(A)) ?? '[]')).toEqual(['1.1']);
  });
});

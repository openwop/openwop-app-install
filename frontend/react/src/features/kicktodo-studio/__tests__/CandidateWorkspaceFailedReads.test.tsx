/**
 * CS-1 (grade-ux 2026-10-14, KickTodo UX-ASSESSMENT; fix cc1153d4d) /
 * DESIGN.md §4.6 "partial" — a side read that FAILED must not render as that
 * section's empty state. The gate matrix backs the publish decision, so "No gate
 * status yet." after a 500 is a confident claim the page cannot make.
 *
 * Breaks it: a failed gate read rendering `gateMatrixEmpty`, a failure in one
 * section blanking another that answered, or a 404 (null) being reported as a
 * failure.
 *
 * Sabotage-witnessed (w52): the gate section's `failed.has('gates')` branch
 * dropped, the side-read catch not recording the failure, and one failure
 * blanking the simulation section too.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { FactoryCandidate } from '../../../client/kicktodoStudioClient.js';

const CAND = {
  id: 'cand:fail-1', topic: 'Morning Walks', audience: 'desk workers',
  transformation: 'a walking habit', durationDaysTarget: 7, dailyMinutesTarget: 15,
  riskTier: 'low', riskSignals: [], state: 'planned', createdAt: '2026-10-01T00:00:00Z',
} satisfies FactoryCandidate;

vi.mock('../../../client/kicktodoStudioClient.js', () => ({
  getCandidate: vi.fn(() => Promise.resolve(CAND)),
  getPublication: vi.fn(() => Promise.resolve(null)),
  getMonitorReport: vi.fn(() => Promise.resolve(null)),
  getGateStatus: vi.fn(() => Promise.reject(new Error('studio request failed: 500'))),
  getSimulationVerdicts: vi.fn(() => Promise.resolve(null)),
  getLessonStatus: vi.fn(() => Promise.resolve(null)),
  killCandidate: vi.fn(),
  ensureOutlineCanvas: vi.fn(),
  applyOutline: vi.fn(),
}));

vi.mock('../../../chat/EmbeddedChatPanel.js', () => ({ EmbeddedChatPanel: () => null }));

import { CandidateWorkspacePage } from '../CandidateWorkspacePage.js';
afterEach(() => { cleanup(); });

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/kicktodo/studio/candidates/${encodeURIComponent(CAND.id)}`]}>
      <Routes>
        <Route path="/kicktodo/studio/candidates/:candidateId" element={<CandidateWorkspacePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CandidateWorkspacePage — failed side reads (§4.6)', () => {
  it('a failed gate read says the section is unavailable, never "No gate status yet."', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Couldn’t load this section. That is not the same as it being empty.'));
    expect(screen.queryByText('No gate status yet.')).toBeNull();
    // Exactly one section failed; the others keep their honest empty states.
    expect(screen.getAllByText('Couldn’t load this section. That is not the same as it being empty.')).toHaveLength(1);
    expect(screen.getByText('Not simulated yet.')).toBeTruthy();
    // The unavailable state is IN the gate section, and offers a retry there.
    const gates = screen.getByRole('region', { name: 'Publication gates' });
    expect(within(gates).getByText('Couldn’t load this section. That is not the same as it being empty.')).toBeTruthy();
    expect(within(gates).getByRole('button', { name: /retry/i })).toBeTruthy();
  });
});

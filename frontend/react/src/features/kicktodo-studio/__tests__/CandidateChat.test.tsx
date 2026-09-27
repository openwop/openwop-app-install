/**
 * ADR 0461 P3 regression net — the candidate workspace embeds the ONE chat
 * candidate-scoped: CLOSED by default (the chat stack must not mount on a
 * plain page view), opening via the aria-expanded toggle, scoped to the
 * shared Challenge Author id, and the welcome's example intents carry the
 * candidate id + topic VERBATIM in the seeded text (the visible-context
 * mechanism the ADR §6 records — no hidden system-prompt injection).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { CHALLENGE_AUTHOR_AGENT_ID } from '../challengeAuthor.js';

const CAND = {
  id: 'cand:test-1', topic: 'Deep Reading Habit', audience: 'busy adults',
  transformation: 'a durable reading habit', durationDaysTarget: 14, dailyMinutesTarget: 20,
  riskTier: 'low', riskSignals: [], state: 'researched', createdAt: '2026-07-21T00:00:00Z',
};

vi.mock('../../../client/kicktodoStudioClient.js', () => ({
  getCandidate: vi.fn(() => Promise.resolve(CAND)),
  getPublication: vi.fn(() => Promise.resolve(null)),
  getMonitorReport: vi.fn(() => Promise.resolve(null)),
  getGateStatus: vi.fn(() => Promise.resolve(null)),
  getSimulationVerdicts: vi.fn(() => Promise.resolve(null)),
  getLessonStatus: vi.fn(() => Promise.resolve(null)),
  killCandidate: vi.fn(),
  ensureOutlineCanvas: vi.fn(),
  applyOutline: vi.fn(),
}));

vi.mock('../../../chat/EmbeddedChatPanel.js', () => ({
  EmbeddedChatPanel: ({ agentId, renderEmptyState }: {
    agentId: string;
    renderEmptyState?: (onPick: (text: string) => void) => ReactNode;
  }) => (
    <div data-testid="embedded-chat" data-agent-id={agentId}>
      {renderEmptyState?.((text) => { document.title = text; /* capture the seed */ })}
    </div>
  ),
}));

import { CandidateWorkspacePage } from '../CandidateWorkspacePage.js';
afterEach(cleanup);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/kicktodo/studio/candidates/${encodeURIComponent(CAND.id)}`]}>
      <Routes>
        <Route path="/kicktodo/studio/candidates/:candidateId" element={<CandidateWorkspacePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CandidateWorkspacePage embedded chat (ADR 0461 P3)', () => {
  it('is CLOSED by default — the chat stack does not mount on view', async () => {
    renderPage();
    await waitFor(() => screen.getByRole('button', { name: 'Chat about this candidate' }));
    expect(screen.queryByTestId('embedded-chat')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Chat about this candidate' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // The full-chat escape hatch keeps the shared agent target.
    const link = screen.getByRole('link', { name: 'Work with the Challenge Author' });
    expect(link.getAttribute('href')).toBe(`/?agent=${CHALLENGE_AUTHOR_AGENT_ID}`);
  });

  it('opens scoped to the Challenge Author with id+topic carried VERBATIM in the seeded intents', async () => {
    renderPage();
    const toggle = await waitFor(() => screen.getByRole('button', { name: 'Chat about this candidate' }));
    fireEvent.click(toggle);
    const embed = screen.getByTestId('embedded-chat');
    expect(embed.getAttribute('data-agent-id')).toBe(CHALLENGE_AUTHOR_AGENT_ID);
    // Constant label per the APG disclosure pattern — state rides aria-expanded.
    expect(screen.getByRole('button', { name: 'Chat about this candidate' }).getAttribute('aria-expanded')).toBe('true');
    // The provenance line shows the id before any click…
    expect(screen.getAllByText(CAND.id).length).toBeGreaterThan(0);
    // …and every example card's visible text (== the seeded text) carries id + topic.
    const outlineCard = screen.getByRole('button', { name: /Review the outline/ });
    expect(outlineCard.textContent).toContain(CAND.id);
    expect(outlineCard.textContent).toContain(CAND.topic);
    // Picking an intent seeds exactly that text (captured via the stub).
    fireEvent.click(outlineCard);
    expect(document.title).toContain(CAND.id);
    expect(document.title).toContain(CAND.topic);
  });

  it('ADR 0458 residue — the reviews-inbox CTA deep-links the reviews rail (?rail=reviews)', async () => {
    const { getPublication } = await import('../../../client/kicktodoStudioClient.js');
    vi.mocked(getPublication).mockResolvedValueOnce({ state: 'submitted' } as Awaited<ReturnType<typeof getPublication>>);
    renderPage();
    const link = await waitFor(() => screen.getByRole('link', { name: 'Open the Reviews inbox' }));
    expect(link.getAttribute('href')).toBe('/chat?rail=reviews');
  });

  it('F-10 pin — $t() inside an interpolated topic is NEVER expanded (skipOnVariables)', async () => {
    // i18next v21+ defaults interpolation.skipOnVariables=true; this pins the
    // "topic verbatim" invariant so a future i18n config change that re-enables
    // nesting-in-variables fails here instead of silently expanding catalog
    // copy inside seeded turns.
    const { default: i18n } = await import('../../../i18n/index.js');
    const out = i18n.t('kicktodo-studio:candExOutlineText', { id: 'cand:x', topic: 'Deep $t(kicktodo-studio:candChatOpen) work' });
    expect(out).toContain('$t(kicktodo-studio:candChatOpen)');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../auth/useAuth.js', () => ({
  useAuth: () => ({ user: { uid: 'u1' }, isConfigured: true, loading: false }),
}));
vi.mock('../../../client/kicktodoClient.js', () => ({
  getToday: vi.fn(async () => ({
    dateLocal: '2026-09-20',
    enrollments: [{
      enrollmentId: 'e1', challengeId: 'ch1', challengeVersion: 1, state: 'active',
      actions: [{
        occurrence: { cardId: 'card-1', stableActivityId: 'a1', occurrenceDateLocal: '2026-09-20', evidencePolicy: 'note' },
        card: { id: 'card-1', title: 'Read for twenty minutes', columnId: 'todo', completed: false },
        checkIn: null,
      }],
    }],
  })),
  listEnrollments: vi.fn(async () => [{ id: 'e1', state: 'active' }]),
}));
vi.mock('../../../client/kicktodoCirclesClient.js', () => ({
  listProposals: vi.fn(async () => [{
    id: 'p1', circleId: 'c1', enrollmentId: 'e1', coachSubject: 'coach:1',
    note: 'Move the reading block to tomorrow morning.', state: 'proposed', createdAt: '2026-09-20T12:00:00Z',
  }]),
}));
vi.mock('../../../agents/rosterClient.js', () => ({
  getRosterEntry: vi.fn(async () => ({ label: 'Ember', persona: 'KickBot' })),
  updateRosterEntry: vi.fn(),
}));
vi.mock('../../agent-knowledge/agentKnowledgeClient.js', () => ({
  listNotes: vi.fn(async () => []),
  deleteNote: vi.fn(),
}));
vi.mock('../../../chat/EmbeddedChatPanel.js', () => ({
  EmbeddedChatPanel: () => <div data-testid="embedded-chat" />,
}));

import { GuidePage } from '../GuidePage.js';
import { listProposals } from '../../../client/kicktodoCirclesClient.js';
import { messages as en } from '../i18n/en.js';

afterEach(() => {
  cleanup();
  vi.mocked(listProposals).mockReset();
  vi.mocked(listProposals).mockResolvedValue([{
    id: 'p1', circleId: 'c1', enrollmentId: 'e1', coachSubject: 'coach:1',
    note: 'Move the reading block to tomorrow morning.', state: 'proposed', createdAt: '2026-09-20T12:00:00Z',
  }]);
});

const renderPage = () => render(<MemoryRouter><GuidePage /></MemoryRouter>);

describe('Guide brief', () => {
  it('separates live context from a governed plan-change decision', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Read for twenty minutes' })).toBeTruthy();
    expect(screen.getByText('Move the reading block to tomorrow morning.')).toBeTruthy();
    expect(screen.getByText(en.guideDecisionGuardrail)).toBeTruthy();
    expect(screen.getByRole('link', { name: en.guideWaitingReview }).getAttribute('href')).toBe('/circles');
    expect(screen.queryByRole('button', { name: /apply|dismiss/i })).toBeNull();
  });

  it('reports an unreadable decision queue and recovers through retry', async () => {
    vi.mocked(listProposals)
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce([]);
    renderPage();

    expect(await screen.findByRole('heading', { name: en.guideWaitingUnknown })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: en.guideDecisionsNoneTitle })).toBeTruthy());
  });
});

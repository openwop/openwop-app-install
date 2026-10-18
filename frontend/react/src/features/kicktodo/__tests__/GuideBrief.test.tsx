/**
 * KickTodo Guide brief (ADR 0442 Guide wave, fd6a99ca1 "make Guide context and
 * decisions explicit"). The brief separates OBSERVED context (today's first
 * unfinished action) from a GOVERNED decision (coach plan-change proposals the
 * participant still has to review in Circles — never applied from here). Only
 * `proposed` items on ACTIVE enrollments count; an unreadable decision queue is
 * stated and retryable, never shown as "no plan changes" (failed ≠ empty).
 * Breaks if: the state/enrollment filters go, the catch maps to [], retry stops
 * re-reading, or apply/dismiss controls appear on this surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { RosterEntry } from '../../../agents/rosterClient.js';
import type { Enrollment, TodayView } from '../../../client/kicktodoClient.js';
import type { PlanChangeProposal } from '../../../client/kicktodoCirclesClient.js';

const fx = vi.hoisted(() => {
  const enrollment = (id: string, state: Enrollment['state']): Enrollment => ({
    id, challengeId: `ch-${id}`, challengeVersion: 1, state, goalId: `goal-${id}`, planRevision: 1,
    timezone: 'UTC', startDateLocal: '2026-09-01',
  });
  const proposal = (id: string, enrollmentId: string, note: string, state: PlanChangeProposal['state']): PlanChangeProposal => ({
    id, circleId: 'c1', enrollmentId, coachSubject: 'coach:1', note, state, createdAt: '2026-09-20T12:00:00Z',
  });
  const today: TodayView = {
    dateLocal: '2026-09-20',
    enrollments: [{
      enrollmentId: 'e1', challengeId: 'ch-e1', challengeVersion: 1, state: 'active',
      actions: [{
        occurrence: { cardId: 'card-1', stableActivityId: 'a1', occurrenceDateLocal: '2026-09-20', evidencePolicy: 'note' },
        card: { id: 'card-1', title: 'Read for twenty minutes', columnId: 'todo', completed: false },
        checkIn: null,
      }],
    }],
  };
  const roster: RosterEntry = {
    rosterId: 'host:kickbot', persona: 'KickBot', label: 'Ember', agentRef: { agentId: 'kickbot' },
    workflows: [], tenantId: 't1', enabled: true, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
  };
  // e1 is active: one proposed (counts) + one dismissed (must not). e2 is a
  // FINISHED enrollment whose proposal must never be read or shown.
  const byEnrollment: Record<string, PlanChangeProposal[]> = {
    e1: [
      proposal('p1', 'e1', 'Move the reading block to tomorrow morning.', 'proposed'),
      proposal('p2', 'e1', 'Already handled.', 'dismissed'),
    ],
    e2: [proposal('p3', 'e2', 'From a finished plan.', 'proposed')],
  };
  return { enrollments: [enrollment('e1', 'active'), enrollment('e2', 'completed')], byEnrollment, today, roster };
});

vi.mock('../../../auth/useAuth.js', () => ({
  useAuth: () => ({ user: { uid: 'u1' }, isConfigured: true, loading: false }),
}));
vi.mock('../../../client/kicktodoClient.js', () => ({
  getToday: vi.fn(async () => fx.today),
  listEnrollments: vi.fn(async () => fx.enrollments),
}));
vi.mock('../../../client/kicktodoCirclesClient.js', () => ({
  listProposals: vi.fn(),
}));
vi.mock('../../../agents/rosterClient.js', () => ({
  getRosterEntry: vi.fn(async () => fx.roster),
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

beforeEach(() => {
  vi.mocked(listProposals).mockReset();
  vi.mocked(listProposals).mockImplementation(async (id: string) => fx.byEnrollment[id] ?? []);
});
afterEach(cleanup);

const renderPage = () => render(<MemoryRouter><GuidePage /></MemoryRouter>);

describe('Guide brief', () => {
  it('separates live context from a governed plan-change decision', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Read for twenty minutes' })).toBeTruthy();
    expect(await screen.findByText('Move the reading block to tomorrow morning.')).toBeTruthy();
    // Only `proposed` items on ACTIVE enrollments count.
    expect(screen.getByText('1 plan change is waiting on your decision.')).toBeTruthy();
    expect(screen.queryByText('Already handled.')).toBeNull();
    expect(screen.queryByText('From a finished plan.')).toBeNull();
    expect(vi.mocked(listProposals)).toHaveBeenCalledWith('e1');
    expect(vi.mocked(listProposals)).not.toHaveBeenCalledWith('e2');
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
    expect(screen.queryByRole('heading', { name: en.guideDecisionsNoneTitle })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: en.guideDecisionsNoneTitle })).toBeTruthy());
    expect(screen.queryByRole('heading', { name: en.guideWaitingUnknown })).toBeNull();
  });
});

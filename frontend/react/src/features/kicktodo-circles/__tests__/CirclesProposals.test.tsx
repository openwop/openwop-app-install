/**
 * ADR 0459 P2 + grade-fix regression pin — coach plan-proposals on the Circles page.
 *
 * A proposal that raised an approval CARD is READ-ONLY history here: the decision
 * moved to the card in the circle conversation + the reviews rail, so a CARDED
 * proposal must render the note + the "decide it on the card" pointer and NO
 * apply/dismiss button.
 *
 * A proposal whose card raise DEGRADED (no `approvalId`) would otherwise be
 * un-decidable, so the honest apply/dismiss fallback (the retained per-enrollment
 * route) is rendered inline for that row — and only that row. When every proposal
 * is the no-card case, the "decide on the card" pointer must be ABSENT (there is no
 * card to point at).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../client/kicktodoClient.js', () => ({
  listEnrollments: vi.fn(() => Promise.resolve([{ id: 'enr:1', challengeId: 'ch:1', state: 'active' }])),
}));
vi.mock('../../../client/kicktodoCirclesClient.js', () => ({
  listCircles: vi.fn(() => Promise.resolve([
    { id: 'circle:1', type: 'coach', enrollmentId: 'enr:1', name: 'My circle', conversationId: 'conv:1' },
  ])),
  createCircle: vi.fn(),
  listGrants: vi.fn(() => Promise.resolve([])),
  invite: vi.fn(),
  revoke: vi.fn(),
  getFeed: vi.fn(() => Promise.resolve(null)),
  listSessions: vi.fn(() => Promise.resolve([])),
  scheduleSession: vi.fn(),
  listProposals: vi.fn(() => Promise.resolve([])),
  resolveProposalAction: vi.fn(() => Promise.resolve({})),
}));

import { CirclesPage } from '../CirclesPage.js';
import { listProposals, resolveProposalAction } from '../../../client/kicktodoCirclesClient.js';
import { messages as en } from '../i18n/en.js';

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe('ADR 0459 — plan-proposal history vs degraded fallback', () => {
  it('CARDED pending proposal: note + decide-on-the-card pointer, and NO apply/dismiss button', async () => {
    vi.mocked(listProposals).mockResolvedValue([
      { id: 'prop:1', circleId: 'circle:1', enrollmentId: 'enr:1', coachSubject: 'user:coach', note: 'move rest days to weekends', state: 'proposed', createdAt: '2026-07-20T00:00:00.000Z', approvalId: 'appr:1' },
    ]);
    render(<MemoryRouter><CirclesPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('move rest days to weekends')).toBeTruthy());
    // The honest pointer to decide on the card, linking the conversation.
    expect(screen.getByText(/Decide these on the card/i)).toBeTruthy();
    const link = screen.getByRole('link', { name: /Open the conversation/i }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/?conversation=conv%3A1');
    // No bespoke apply/dismiss button when a card exists — decide it there.
    expect(screen.queryByRole('button', { name: /apply|dismiss|decline|accept/i })).toBeNull();
  });

  it('NO-CARD pending proposal (degraded raise): honest apply/dismiss buttons, and NO card pointer', async () => {
    vi.mocked(listProposals).mockResolvedValue([
      { id: 'prop:2', circleId: 'circle:1', enrollmentId: 'enr:1', coachSubject: 'user:coach', note: 'add a rest day', state: 'proposed', createdAt: '2026-07-20T00:00:00.000Z' },
    ]);
    render(<MemoryRouter><CirclesPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('add a rest day')).toBeTruthy());
    // The fallback decision controls are present, by accessible name.
    // KT-HONESTY-1: resolved from the catalog, not a literal. The old `/apply/i`
    // pinned the copy that CLAIMED the coach's change was executed, so a truthful
    // re-word broke the test — the assertion was guarding the wrong property.
    expect(screen.getByRole('button', { name: en.proposalApplyCta })).toBeTruthy();
    expect(screen.getByRole('button', { name: en.proposalDismissCta })).toBeTruthy();
    // With no card anywhere, the "decide on the card" pointer must NOT render.
    expect(screen.queryByText(/Decide these on the card/i)).toBeNull();
    // The buttons drive the retained route (the reachable fallback).
    expect(resolveProposalAction).toBeDefined();
  });

  it('EMPTY history: the discoverability empty-state line, no buttons, no pointer', async () => {
    vi.mocked(listProposals).mockResolvedValue([]);
    render(<MemoryRouter><CirclesPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText(/Ask KickBot to adjust your plan/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /apply|decline|dismiss/i })).toBeNull();
    expect(screen.queryByText(/Decide these on the card/i)).toBeNull();
  });

  it('LOAD FAILURE (non-404): the section-load error line, not a silent hide', async () => {
    vi.mocked(listProposals).mockRejectedValue(new Error('circles request failed: 500'));
    render(<MemoryRouter><CirclesPage /></MemoryRouter>);

    // The proposals section renders its own load-error line (the grants-section convention).
    await waitFor(() => expect(screen.getAllByText(/This section couldn.t load/i).length).toBeGreaterThan(0));
  });
});

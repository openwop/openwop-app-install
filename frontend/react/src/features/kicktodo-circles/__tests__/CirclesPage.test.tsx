/**
 * KTUX-4/7 + screen-polish regression net — the per-circle invite control is
 * a PICKER of workspace members resolved by an accessible label (nobody types
 * an opaque subject id — the ADR 0436 §1 vocabulary rule), falling back to a
 * labeled field only when the roster is unavailable.
 *
 * Breaks it: a picker that lists subject ids instead of names, a label that is
 * not wired to the control, or a failed roster read that leaves no invite
 * control at all. The client mock carries EVERY export the page imports: a
 * missing one throws inside `reload` and the page would be asserted in its
 * load-error state.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { OrgMember } from '../../../client/accessClient.js';
import type { Enrollment } from '../../../client/kicktodoClient.js';
import type { Circle } from '../../../client/kicktodoCirclesClient.js';

const { loadOrgMembers } = vi.hoisted(() => ({
  loadOrgMembers: vi.fn<typeof import('../../../orgs/orgMembers.js').loadOrgMembers>(),
}));

const ROSTER: OrgMember[] = [
  {
    memberId: 'm1', orgId: 'org:1', tenantId: 't:1', subject: 'user:2', displayName: 'Ada Lovelace', roles: [], teamIds: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  },
];
const ENROLLMENTS: Enrollment[] = [
  { id: 'enr:1', challengeId: 'ch:1', challengeVersion: 1, state: 'active', goalId: 'g:1', planRevision: 1, timezone: 'UTC', startDateLocal: '2026-01-01' },
];
const CIRCLES: Circle[] = [{ id: 'circle:1', type: 'partner', enrollmentId: 'enr:1', name: 'My circle', conversationId: 'c:1' }];

vi.mock('../../../orgs/orgMembers.js', () => ({ loadOrgMembers }));
vi.mock('../../../client/kicktodoClient.js', () => ({
  listEnrollments: vi.fn(() => Promise.resolve(ENROLLMENTS)),
}));
vi.mock('../../../client/kicktodoCirclesClient.js', () => ({
  listCircles: vi.fn(() => Promise.resolve(CIRCLES)),
  createCircle: vi.fn(),
  listGrants: vi.fn(() => Promise.resolve([])),
  invite: vi.fn(),
  revoke: vi.fn(),
  getFeed: vi.fn(() => Promise.resolve(null)),
  listSessions: vi.fn(() => Promise.resolve([])),
  scheduleSession: vi.fn(),
  listProposals: vi.fn(() => Promise.resolve([])),
  resolveProposalAction: vi.fn(),
}));

import { CirclesPage } from '../CirclesPage.js';
import { messages as en } from '../i18n/en.js';

afterEach(cleanup);
beforeEach(() => {
  loadOrgMembers.mockReset();
  loadOrgMembers.mockResolvedValue(ROSTER);
});

describe('CirclesPage', () => {
  it('the invite control is a labeled member PICKER with people, not ids', async () => {
    render(<MemoryRouter><CirclesPage /></MemoryRouter>);
    const picker = await screen.findByRole('combobox', { name: en.inviteMemberLabel });
    expect(picker).toBeTruthy();
    // The option is a display name; the opaque subject never renders as text.
    expect(screen.getByRole('option', { name: 'Ada Lovelace' })).toBeTruthy();
    expect(screen.queryByText('user:2')).toBeNull();
    // The page loaded cleanly (not asserted over its load-error state).
    expect(screen.queryByText(en.loadError)).toBeNull();
  });

  it('roster unavailable: falls back to a labeled text field, not a picker', async () => {
    // The page `.catch`es a failed roster read to `[]` — the fallback path.
    loadOrgMembers.mockRejectedValue(new Error('members request failed: 500'));
    render(<MemoryRouter><CirclesPage /></MemoryRouter>);
    expect(await screen.findByRole('textbox', { name: en.inviteMemberLabel })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: en.inviteMemberLabel })).toBeNull();
    expect(screen.queryByText(en.loadError)).toBeNull();
  });
});

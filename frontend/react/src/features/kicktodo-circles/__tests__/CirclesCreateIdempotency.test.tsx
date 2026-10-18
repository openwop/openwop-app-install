/**
 * KTACC-5 — a create intent carries ONE idempotency key: a retry after a failed
 * create reuses it (so a request that reached the server but lost its response
 * cannot make a second circle), and a fresh intent after success gets a new one.
 * Sabotage: minting the key inside each call (no ref) gives the retry a
 * different key and reds the equality; never clearing it reds the last case.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { OrgMember } from '../../../client/accessClient.js';
import type { Enrollment } from '../../../client/kicktodoClient.js';
import type { Circle } from '../../../client/kicktodoCirclesClient.js';

const { loadOrgMembers, createCircle } = vi.hoisted(() => ({
  loadOrgMembers: vi.fn<typeof import('../../../orgs/orgMembers.js').loadOrgMembers>(),
  createCircle: vi.fn<typeof import('../../../client/kicktodoCirclesClient.js').createCircle>(),
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
const CIRCLES: Circle[] = [];

vi.mock('../../../orgs/orgMembers.js', () => ({ loadOrgMembers }));
vi.mock('../../../client/kicktodoClient.js', () => ({
  listEnrollments: vi.fn(() => Promise.resolve(ENROLLMENTS)),
}));
vi.mock('../../../client/kicktodoCirclesClient.js', () => ({
  listCircles: vi.fn(() => Promise.resolve(CIRCLES)),
  createCircle,
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
import { fireEvent, waitFor } from '@testing-library/react';

afterEach(cleanup);
beforeEach(() => {
  loadOrgMembers.mockReset();
  loadOrgMembers.mockResolvedValue(ROSTER);
  createCircle.mockReset();
});

describe('CirclesPage create idempotency (KTACC-5)', () => {
  it('a retry after a failed create reuses the same key; the next intent after success gets a new one', async () => {
    createCircle
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ id: 'circle:1', type: 'partner', enrollmentId: 'enr:1', name: 'x', conversationId: 'c' })
      .mockResolvedValueOnce({ id: 'circle:2', type: 'partner', enrollmentId: 'enr:1', name: 'x', conversationId: 'c' });
    render(<MemoryRouter><CirclesPage /></MemoryRouter>);
    const click = async () => {
      const btn = (await screen.findAllByRole('button', { name: en.createCta }))[0]!;
      await waitFor(() => expect(btn.hasAttribute('disabled')).toBe(false));
      fireEvent.click(btn);
    };
    await click();
    await waitFor(() => expect(createCircle).toHaveBeenCalledTimes(1));
    await click();
    await waitFor(() => expect(createCircle).toHaveBeenCalledTimes(2));
    const k1 = createCircle.mock.calls[0]![3];
    const k2 = createCircle.mock.calls[1]![3];
    expect(typeof k1).toBe('string');
    expect(k2).toBe(k1);
    await click();
    await waitFor(() => expect(createCircle).toHaveBeenCalledTimes(3));
    expect(createCircle.mock.calls[2]![3]).not.toBe(k1);
  });
});

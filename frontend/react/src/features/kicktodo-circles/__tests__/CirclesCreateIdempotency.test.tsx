/**
 * KTACC-5 — a create intent carries ONE idempotency key: a retry after a failed
 * create reuses it (so a request that reached the server but lost its response
 * cannot make a second circle), and a fresh intent after success gets a new one.
 * The key only guards anything if it reaches the server, so the second case
 * drives the page through the REAL client over a stubbed fetch and asserts the
 * `Idempotency-Key` request header is sent, and is the same on the retry.
 *
 * Sabotage: minting the key inside each call (no ref) gives the retry a
 * different key and reds the equality; never clearing it reds the last
 * assertion; the client dropping the header reds the second case.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type * as CirclesClient from '../../../client/kicktodoCirclesClient.js';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { OrgMember } from '../../../client/accessClient.js';
import type { Enrollment } from '../../../client/kicktodoClient.js';
import type { Circle } from '../../../client/kicktodoCirclesClient.js';

const { loadOrgMembers, createCircle } = vi.hoisted(() => ({
  loadOrgMembers: vi.fn<typeof import('../../../orgs/orgMembers.js').loadOrgMembers>(),
  createCircle: vi.fn<typeof CirclesClient.createCircle>(),
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

vi.mock('../../../orgs/orgMembers.js', () => ({ loadOrgMembers }));
vi.mock('../../../client/kicktodoClient.js', () => ({
  listEnrollments: vi.fn<() => Promise<Enrollment[]>>(() => Promise.resolve(ENROLLMENTS)),
}));
vi.mock('../../../client/kicktodoCirclesClient.js', () => ({
  listCircles: vi.fn<typeof CirclesClient.listCircles>(() => Promise.resolve(CIRCLES)),
  createCircle,
  listGrants: vi.fn<typeof CirclesClient.listGrants>(() => Promise.resolve([])),
  invite: vi.fn<typeof CirclesClient.invite>(),
  revoke: vi.fn<typeof CirclesClient.revoke>(),
  getFeed: vi.fn<typeof CirclesClient.getFeed>(() => Promise.resolve({ circleId: 'circle:none' })), // no circle exists, so never read
  listSessions: vi.fn<typeof CirclesClient.listSessions>(() => Promise.resolve([])),
  scheduleSession: vi.fn<typeof CirclesClient.scheduleSession>(),
  listProposals: vi.fn<typeof CirclesClient.listProposals>(() => Promise.resolve([])),
  resolveProposalAction: vi.fn<typeof CirclesClient.resolveProposalAction>(),
}));
const realClient = await vi.importActual<typeof CirclesClient>('../../../client/kicktodoCirclesClient.js');

import { CirclesPage } from '../CirclesPage.js';
import { messages as en } from '../i18n/en.js';
import { fireEvent, waitFor } from '@testing-library/react';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
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
    expect(k1).toMatch(UUID);
    expect(k2).toBe(k1);
    await click();
    await waitFor(() => expect(createCircle).toHaveBeenCalledTimes(3));
    expect(createCircle.mock.calls[2]![3]).toMatch(UUID);
    expect(createCircle.mock.calls[2]![3]).not.toBe(k1);
    // Every intent is for the one enrollment without a circle.
    expect(createCircle.mock.calls.map((c) => c[0])).toEqual(['enr:1', 'enr:1', 'enr:1']);
  });

  it('the key reaches the server as the Idempotency-Key header, unchanged on the retry', async () => {
    const CREATED: Circle = { id: 'circle:1', type: 'partner', enrollmentId: 'enr:1', name: 'x', conversationId: 'c' };
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch')) // the response was lost
      .mockResolvedValueOnce(new Response(JSON.stringify(CREATED), { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    createCircle.mockImplementation(realClient.createCircle);
    render(<MemoryRouter><CirclesPage /></MemoryRouter>);
    for (const n of [1, 2]) {
      const btn = (await screen.findAllByRole('button', { name: en.createCta }))[0]!;
      await waitFor(() => expect(btn.hasAttribute('disabled')).toBe(false));
      fireEvent.click(btn);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(n));
    }
    const sent = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      key: new Headers(init?.headers).get('Idempotency-Key'),
    }));
    expect(sent[0]!.url.endsWith('/host/openwop-app/circles')).toBe(true);
    expect(sent.map((x) => x.method)).toEqual(['POST', 'POST']);
    expect(sent[0]!.key).toMatch(UUID);
    expect(sent[1]!.key).toBe(sent[0]!.key);
  });
});

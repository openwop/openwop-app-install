/**
 * UX_UPGRADE-projects ROUND 2 — PRJ2-B1.
 *
 * Round 1 closed "a failed directory read makes members render as raw ids". Its fix used
 * ONE flag for TWO independent reads, and the only reset lived in the OTHER read's
 * success path — so whichever settled LAST won. A roster failure that resolved before a
 * slower `listMembers` success had its own warning erased, and every `agent:` member
 * rendered as a raw rosterId with nothing said: the exact defect PRJ-G1 closed, reachable
 * again by ordering alone.
 *
 * Round 1's test could not see it. It mocked both reads with ALREADY-SETTLED promises, so
 * the callbacks ran in `Promise.all` array order (`false`, then `true`) — an ordering the
 * network never guarantees. This file forces the ADVERSE order — with manually
 * settled deferreds, not timers, so the interleaving is exact on any machine.
 *
 * Sabotage (w13 g3 probes): making the org-member success also reset the roster
 * flag (PRJ2-B1 verbatim) reds the FAST-roster case; showing the "nobody can be
 * added" copy on ANY directory failure reds the copy case; dropping the
 * org-member failure flag reds both org cases; setting it only when the project
 * read succeeds (the first B1 fix) reds the correlated-outage case; an
 * always-on roster notice reds the both-succeed control.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const listProjectMembers = vi.fn();
const listMembers = vi.fn();
const listRoster = vi.fn();

vi.mock('../projectsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listProjectMembers: () => listProjectMembers(),
  addProjectMember: vi.fn(async () => ({})),
  updateWorkflows: vi.fn(async () => ({})),
}));
vi.mock('../../../client/accessClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listMembers: () => listMembers(),
}));
vi.mock('../../../agents/rosterClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listRoster: () => listRoster(),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProjectMembersTab } from '../ProjectMembersTab.js';
import type { Project } from '../projectsClient.js';
import type { OrgMember } from '../../../client/accessClient.js';
import type { RosterEntry } from '../../../agents/rosterClient.js';

const PROJECT: Project = { id: 'p1', tenantId: 't', orgId: 'org-1', name: 'Atlas', workflows: [], boardId: 'b1' };
const ORG: OrgMember[] = [{
  memberId: 'm1', orgId: 'org-1', tenantId: 't', subject: 'u-1', displayName: 'Ada Member', roles: [], teamIds: [],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
}];
const ROSTER: RosterEntry[] = [{
  rosterId: 'rst-9f2a', persona: 'Research Agent', agentRef: { agentId: 'research' }, workflows: [], tenantId: 't', enabled: true,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
}];

/** A promise the test settles by hand — the point of this file is the ORDER. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
/** Flush every settled read and the re-renders it causes. */
const drain = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); });
};

// `canWrite` MOUNTS THE ADD-PICKER. Without it the first version of this file
// could not see the correlated-outage regression below at all: the picker — the
// surface PRJ-G1 is actually about — was never rendered in any of its cases.
const view = async (): Promise<void> => {
  render(<MemoryRouter><ProjectMembersTab project={PROJECT} canWrite onSaved={() => {}} /></MemoryRouter>);
  await drain();
};

/** The adverse interleaving: the roster read FAILS first, the org-member read SUCCEEDS last.
 *  Under round 1's single flag, the success callback ran last and set it back to false —
 *  erasing the warning for a failure that had already happened. */
const rosterFailsThenOrgSucceeds = async (): Promise<void> => {
  const roster = deferred<RosterEntry[]>();
  const org = deferred<OrgMember[]>();
  listRoster.mockReturnValue(roster.promise);
  listMembers.mockReturnValue(org.promise);
  await view();
  roster.reject(new Error('boom'));
  await drain();
  org.resolve(ORG);
  await drain();
};

beforeEach(() => {
  for (const m of [listProjectMembers, listMembers, listRoster]) m.mockReset();
  listProjectMembers.mockResolvedValue({ members: [{ ref: 'agent:rst-9f2a', role: 'contributor', addedAt: '2026-01-01T00:00:00Z' }], visibility: 'org' });
  listMembers.mockResolvedValue(ORG);
  listRoster.mockResolvedValue(ROSTER);
});
afterEach(cleanup);

describe('PRJ2-B1 — one flag for two reads made the warning order-dependent', () => {
  it('a FAST roster failure is still disclosed when the org-member read succeeds SLOWLY', async () => {
    await rosterFailsThenOrgSucceeds();
    expect(screen.getByText(/agent roster/i)).toBeTruthy();
  });

  it('…and the copy says which directory is missing, not "nobody can be added"', async () => {
    // The old sentence claimed nobody could be added, which is only true when the
    // ORG-MEMBER read failed. With just the roster down the picker still offers everyone.
    await rosterFailsThenOrgSucceeds();
    expect(screen.getByText(/agent roster/i)).toBeTruthy(); // the RIGHT warning is up
    expect(screen.queryByText(/nobody can be added/i)).toBeNull();
  });

  it('an org-member failure still says the picker is incomplete (the negative control)', async () => {
    listMembers.mockRejectedValue(new Error('boom'));
    await view();
    expect(screen.getByText(/nobody can be added/i)).toBeTruthy();
  });

  it('both reads succeeding says nothing at all (the negative control)', async () => {
    await view();
    // Loaded, not merely mounted: the picker offers the person the org read returned.
    expect(screen.getByRole('option', { name: 'Ada Member (person)' })).toBeTruthy();
    expect(screen.queryByText(/agent roster/i)).toBeNull();
    expect(screen.queryByText(/nobody can be added/i)).toBeNull();
  });

  it('ALL THREE reads failing still discloses — the correlated outage', async () => {
    // The likeliest failure by far: one backend, three 503s. The first fix for
    // B1 set both flags AFTER `await Promise.all([...])`, which rejects the
    // instant `listProjectMembers` rejects — so neither setter ran and the
    // picker offered nobody with NOTHING said. That is PRJ-G1 again, and the
    // rest of this file could not see it: it drove only the failure of ONE
    // directory read at a time, with the other two healthy.
    listProjectMembers.mockRejectedValue(new Error('boom'));
    listMembers.mockRejectedValue(new Error('boom'));
    listRoster.mockRejectedValue(new Error('boom'));
    await view();
    expect(screen.getByText(/nobody can be added/i)).toBeTruthy();
  });
});

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
 * network never guarantees. This file forces the ADVERSE order.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
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

const PROJECT = { id: 'p1', orgId: 'org-1', name: 'Atlas' } as never;

/** A promise that settles after `ms` — the point of this file is the ORDER. */
const after = <T,>(ms: number, value: T): Promise<T> => new Promise((r) => setTimeout(() => r(value), ms));
const failAfter = (ms: number): Promise<never> => new Promise((_, rej) => setTimeout(() => rej(new Error('boom')), ms));

// `canWrite` MOUNTS THE ADD-PICKER. Without it the first version of this file
// could not see the correlated-outage regression below at all: the picker — the
// surface PRJ-G1 is actually about — was never rendered in any of its cases.
const view = async (): Promise<void> => {
  render(<MemoryRouter><ProjectMembersTab project={PROJECT} canWrite onSaved={() => {}} /></MemoryRouter>);
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  await waitFor(() => expect(listProjectMembers).toHaveBeenCalled());
};

beforeEach(() => {
  vi.useRealTimers();
  for (const m of [listProjectMembers, listMembers, listRoster]) m.mockReset();
  listProjectMembers.mockResolvedValue({ members: [{ ref: 'agent:rst-9f2a', role: 'member' }], visibility: 'org' });
  listMembers.mockResolvedValue([{ memberId: 'm1', orgId: 'org-1', tenantId: 't', subject: 'u-1', displayName: 'Ada Member', roles: [] }]);
  listRoster.mockResolvedValue([{ rosterId: 'rst-9f2a', name: 'Research Agent' }]);
});
afterEach(cleanup);

describe('PRJ2-B1 — one flag for two reads made the warning order-dependent', () => {
  it('a FAST roster failure is still disclosed when the org-member read succeeds SLOWLY', async () => {
    // The adverse interleaving: roster rejects in 5ms, `listMembers` resolves in 40ms.
    // Under round 1's single flag, the success callback ran last and set it back to
    // false — erasing the warning for a failure that had already happened.
    listRoster.mockReturnValue(failAfter(5));
    listMembers.mockReturnValue(after(40, [{ memberId: 'm1', orgId: 'org-1', tenantId: 't', subject: 'u-1', displayName: 'Ada Member', roles: [] }]));
    await view();
    expect(await screen.findByText(/agent roster/i)).toBeTruthy();
  });

  it('…and the copy says which directory is missing, not "nobody can be added"', async () => {
    // The old sentence claimed nobody could be added, which is only true when the
    // ORG-MEMBER read failed. With just the roster down the picker still offers everyone.
    listRoster.mockReturnValue(failAfter(5));
    listMembers.mockReturnValue(after(40, [{ memberId: 'm1', orgId: 'org-1', tenantId: 't', subject: 'u-1', displayName: 'Ada Member', roles: [] }]));
    await view();
    expect(screen.queryByText(/nobody can be added/i)).toBeNull();
  });

  it('an org-member failure still says the picker is incomplete (the negative control)', async () => {
    listMembers.mockReturnValue(failAfter(5));
    await view();
    expect(await screen.findByText(/nobody can be added/i)).toBeTruthy();
  });

  it('both reads succeeding says nothing at all (the negative control)', async () => {
    await view();
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
    expect(await screen.findByText(/nobody can be added/i)).toBeTruthy();
  });
});

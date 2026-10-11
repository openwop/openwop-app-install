import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import type { Project, listProjectMembers as ListProjectMembers } from '../projectsClient.js';
import type { OrgMember } from '../../../client/accessClient.js';
import { messages as en } from '../i18n/en.js';

/**
 * Labels are RESOLVED FROM THE CATALOG, never typed as English literals.
 * `'Remove Alice'` reads as clearer until the copy changes truthfully and the
 * test fails for a reason that has nothing to do with what it guards — which is
 * how a `/apply/i` matcher blocked an honesty fix in #2685.
 */
const removeAria = (name: string): string => en.removeMemberAria.replace('{{name}}', name);

/**
 * ADR 0063 — the project write-gate. Proves ProjectMembersTab renders its write
 * affordances (Add / Remove / the visibility toggle) ONLY for a writer; a
 * non-writer (`canWrite={false}`) sees the roster read-only. The FE gate is a UX
 * hint — the backend still enforces — so this guards the affordance visibility,
 * not authority.
 *
 * Sabotage-witnessed (wave 13, w13g4-pma-*): ungating the Add card, the Remove button
 * or the visibility toggle's `!canWrite`, ignoring a declined confirm, dropping the
 * success acknowledgement, and confirming on the recovery path (`if (true)` and
 * `v !== visibility`) each turn their case below red. The last one was VACUOUS until
 * wave 13: the members read always answered `visibility: 'org'`, so the "private ->
 * org" case actually clicked org -> org. The read now agrees with the prop.
 */
const confirmMock = vi.fn(async (_opts: unknown) => true);
const setProjectVisibilityMock = vi.fn<(id: string, v: string) => Promise<Project>>();
const listProjectMembersMock = vi.fn<typeof ListProjectMembers>();
const MEMBERS = [{ ref: 'user:u1', role: 'contributor' as const, addedAt: '2026-01-01T00:00:00Z' }];
const ALICE: OrgMember = {
  memberId: 'm1', orgId: 'o1', tenantId: 't', subject: 'u1', displayName: 'Alice',
  roles: [], teamIds: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
vi.mock('../../../ui/confirm.js', () => ({ confirm: (o: unknown) => confirmMock(o) }));
vi.mock('../projectsClient.js', () => ({
  listProjectMembers: (id: string) => listProjectMembersMock(id),
  addProjectMember: vi.fn(),
  removeProjectMember: vi.fn(),
  setProjectVisibility: (id: string, v: string) => setProjectVisibilityMock(id, v),
}));
vi.mock('../../../client/accessClient.js', () => ({
  listMembers: vi.fn(async () => [ALICE]),
}));
vi.mock('../../../agents/rosterClient.js', () => ({
  listRoster: vi.fn(async () => []),
}));

import { ProjectMembersTab } from '../ProjectMembersTab.js';

const project: Project = { id: 'p1', tenantId: 't', orgId: 'o1', name: 'P', workflows: [], boardId: 'b1' };

beforeEach(() => { listProjectMembersMock.mockReset(); listProjectMembersMock.mockResolvedValue({ members: MEMBERS, visibility: 'org' }); });
afterEach(() => { cleanup(); confirmMock.mockReset(); confirmMock.mockResolvedValue(true); setProjectVisibilityMock.mockReset(); });

describe('ProjectMembersTab — write-control gating (ADR 0063)', () => {
  it('a writer sees Add + Remove + an enabled visibility toggle', async () => {
    render(<ProjectMembersTab project={project} canWrite={true} onSaved={() => {}} />);
    // WAIT ON THE DATA, not on a static heading. `addToTeam` renders as soon as
    // i18n resolves, but the Remove control needs `listProjectMembers` to have
    // SETTLED — and nothing here waited for that. Under load the fetch lost the
    // race and the sync assertion below failed, which is the flake. Reproduced
    // deterministically by delaying only that fetch 60ms.
    await screen.findByText(en.addToTeam);
    expect(await screen.findByLabelText(removeAria('Alice'))).toBeTruthy();
    expect(screen.getByRole('button', { name: en.visibilityOrg }).hasAttribute('disabled')).toBe(false);
  });

  it('a non-writer sees the roster but NO Add / Remove and a disabled visibility toggle', async () => {
    render(<ProjectMembersTab project={project} canWrite={false} onSaved={() => {}} />);
    // The roster still loads (Alice is shown) — only the write controls are gone.
    // This one already waited on the DATA ('Alice'), which is why it never
    // flaked — the absence assertions below are only meaningful once the row
    // that would carry the controls exists.
    await screen.findByText('Alice');
    expect(screen.queryByText(en.addToTeam)).toBeNull();
    expect(screen.queryByLabelText(removeAria('Alice'))).toBeNull();
    expect(screen.getByRole('button', { name: en.visibilityOrg }).hasAttribute('disabled')).toBe(true);
  });
});

/**
 * ADR 0608 D8 (`CPU-1`) — narrowing scope must CONFIRM, and a completed write must
 * SAY SO. The control used to fire on one click with no confirm, no success
 * feedback and no announce; the only post-state signal was a swapped glyph.
 */
describe('visibility — confirm on narrowing, acknowledgement on success', () => {
  it('org -> private ASKS first, and does nothing when the user declines', async () => {
    confirmMock.mockResolvedValueOnce(false);
    render(<ProjectMembersTab project={project} canWrite={true} onSaved={() => {}} />);
    await screen.findByText('Alice');
    (await screen.findByRole('button', { name: en.visibilityPrivate })).click();
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    // Let the declined confirm's continuation run before asserting it did nothing.
    await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); });
    // Declining is a real exit: the write never fires.
    expect(setProjectVisibilityMock).not.toHaveBeenCalled();
  });

  it('org -> private CONFIRMED fires the write and acknowledges it', async () => {
    confirmMock.mockResolvedValueOnce(true);
    setProjectVisibilityMock.mockResolvedValueOnce({ ...project, visibility: 'private' });
    render(<ProjectMembersTab project={project} canWrite={true} onSaved={() => {}} />);
    await screen.findByText('Alice');
    (await screen.findByRole('button', { name: en.visibilityPrivate })).click();
    await waitFor(() => expect(setProjectVisibilityMock).toHaveBeenCalledWith('p1', 'private'));
    expect(await screen.findByText(en.visibilityNowPrivate)).toBeTruthy();
  });

  it('private -> org does NOT confirm — a confirm on the recovery path is a tax on undoing', async () => {
    setProjectVisibilityMock.mockResolvedValueOnce({ ...project, visibility: 'org' });
    // The server read must AGREE that the project is private: `load()` overwrites the
    // prop with it, and a read answering 'org' turned this into an org -> org click.
    listProjectMembersMock.mockResolvedValue({ members: MEMBERS, visibility: 'private' });
    render(<ProjectMembersTab project={{ ...project, visibility: 'private' }} canWrite={true} onSaved={() => {}} />);
    await screen.findByText('Alice');
    expect(screen.getByRole('button', { name: en.visibilityPrivate }).getAttribute('aria-pressed')).toBe('true');
    (await screen.findByRole('button', { name: en.visibilityOrg })).click();
    await waitFor(() => expect(setProjectVisibilityMock).toHaveBeenCalledWith('p1', 'org'));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(await screen.findByText(en.visibilityNowOrg)).toBeTruthy();
  });
});

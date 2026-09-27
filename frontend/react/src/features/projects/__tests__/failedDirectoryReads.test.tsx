/**
 * UX_UPGRADE-projects — PRJ-G1 / PRJ-G2.
 *
 *  - PRJ-G1: the people + agent directory reads are what turn a member REF into
 *    a name and populate the add-picker. Swallowed into `[]`, a failure made
 *    existing members render as raw ids on the very tab whose job is saying who
 *    is on the team, and left an add-picker offering nobody.
 *  - PRJ-G2: a failed workflow-summary read made every assigned non-built-in
 *    workflow `known === false`, which rendered a "local only" WARNING (a false
 *    claim it doesn't exist on the backend) AND disabled its Run button.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const listProjectMembers = vi.fn();
const listMembers = vi.fn();
const listRoster = vi.fn();
const listWorkflowSummaries = vi.fn();

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
vi.mock('../../../workflows/workflowsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listWorkflowSummaries: () => listWorkflowSummaries(),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProjectMembersTab } from '../ProjectMembersTab.js';
import { ProjectWorkflowsTab } from '../ProjectWorkflowsTab.js';

const PROJECT = { id: 'p1', orgId: 'org-1', name: 'Atlas' } as never;

const membersView = async (): Promise<void> => {
  render(<MemoryRouter><ProjectMembersTab project={PROJECT} canWrite onSaved={() => undefined} /></MemoryRouter>);
  await act(async () => {});
  await waitFor(() => expect(listProjectMembers).toHaveBeenCalled());
};

const workflowsView = async (workflows: string[]): Promise<void> => {
  render(<MemoryRouter><ProjectWorkflowsTab projectId="p1" workflows={workflows} canWrite onSaved={() => {}} /></MemoryRouter>);
  await act(async () => {});
  await waitFor(() => expect(listWorkflowSummaries).toHaveBeenCalled());
};

beforeEach(() => {
  for (const m of [listProjectMembers, listMembers, listRoster, listWorkflowSummaries]) m.mockReset();
  listProjectMembers.mockResolvedValue({ members: [{ ref: 'user:u-1', role: 'editor' }], visibility: 'org' });
  listMembers.mockResolvedValue([{ memberId: 'm1', orgId: 'org-1', tenantId: 't', subject: 'u-1', displayName: 'Ada Member', roles: [] }]);
  listRoster.mockResolvedValue([]);
  listWorkflowSummaries.mockResolvedValue([{ workflowId: 'wf-mine', name: 'My workflow' }]);
});
afterEach(cleanup);

describe('PRJ-G1: a failed directory read is disclosed', () => {
  it('warns that members may show an id instead of a name', async () => {
    listMembers.mockRejectedValue(new Error('directory down'));
    await membersView();
    expect(await screen.findByText(/may show their id instead of their name/i)).toBeTruthy();
    // And the consequence is actually visible — the raw ref, not a name.
    expect(screen.getByText(/u-1/)).toBeTruthy();
  });

  it('says the picker is unavailable rather than presenting an empty one', async () => {
    listRoster.mockRejectedValue(new Error('roster down'));
    await membersView();
    expect(await screen.findByText(/directory unavailable/i)).toBeTruthy();
  });

  it('a healthy read resolves the member NAME and says nothing', async () => {
    await membersView();
    expect(await screen.findByText(/Ada Member/)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });
});

describe('PRJ-G2: an unverifiable workflow is not called "local only"', () => {
  it('does not claim local-only when the summary read failed', async () => {
    listWorkflowSummaries.mockRejectedValue(new Error('workflows down'));
    await workflowsView(['wf-unknown']);
    expect(await screen.findByText(/could not check this workflow/i)).toBeTruthy();
    expect(screen.queryByText(/local-only/i)).toBeNull();
  });

  it('leaves Run ENABLED when we simply could not check', async () => {
    listWorkflowSummaries.mockRejectedValue(new Error('workflows down'));
    await workflowsView(['wf-unknown']);
    const run = await screen.findByRole('button', { name: /run now/i });
    // A run that turns out to be impossible reports a real error — strictly
    // better than a dead button justified by a guess.
    expect((run as HTMLButtonElement).disabled).toBe(false);
  });

  it('a genuinely local-only workflow IS still warned about and disabled', async () => {
    // The read succeeded and simply does not contain this id — the warning is
    // correct here, and losing it would be the opposite mistake.
    await workflowsView(['wf-not-in-workspace']);
    expect(await screen.findByText(/local-only/i)).toBeTruthy();
    const run = screen.getByRole('button', { name: /run now/i });
    expect((run as HTMLButtonElement).disabled).toBe(true);
  });

  it('a known workflow shows its name and no warning', async () => {
    await workflowsView(['wf-mine']);
    expect(await screen.findByText('My workflow')).toBeTruthy();
    expect(screen.queryByText(/local-only/i)).toBeNull();
    expect(screen.queryByText(/could not check/i)).toBeNull();
  });
});

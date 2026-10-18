/**
 * EMPTY-ON-FAIL near-miss (ADR 0779 D7, the RTP-EMPTY-1 class) — a failed projects
 * read does not claim the bound project is "A project you cannot see".
 *
 * The projects catch set the list to [], so a channel bound to a project rendered
 * "A project you cannot see": a false ACCESS claim from a read that never came
 * back. The failure is now its own state: the bound project is labelled as
 * unknown, the picker says why it cannot be changed, and it is disabled so the
 * owner cannot rebind from an incomplete list.
 *
 * Break it by restoring `t('channelProjectUnavailable')` unconditionally (dropping
 * the `projectsFailed ?` choice) in ChannelManageDialog, or by removing
 * `setProjectsFailed(true)` from the projects catch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ChannelDetail } from '../../../client/channelsClient.js';
import type { Project } from '../../../features/projects/projectsClient.js';

const h = vi.hoisted(() => ({
  getChannel: vi.fn<(channelId: string) => Promise<ChannelDetail>>(),
  listProjects: vi.fn<() => Promise<Project[]>>(),
}));
vi.mock('../../../client/channelsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/channelsClient.js')>()),
  getChannel: h.getChannel,
}));
vi.mock('../../../features/projects/projectsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../features/projects/projectsClient.js')>()),
  listProjects: h.listProjects,
}));
vi.mock('../ChannelSchedulePanel.js', () => ({ ChannelSchedulePanel: () => null }));
vi.mock('../MemberPickers.js', () => ({ MemberPicker: () => null, AgentPicker: () => null }));

const { ChannelManageDialog } = await import('../ChannelManageDialog.js');

const UNKNOWN = 'The bound project (the project list couldn’t be loaded)';
const FAILED_HINT = 'Couldn’t load the project list, so the bound project can’t be shown or changed right now. Close and reopen to retry.';
const CANNOT_SEE = 'A project you cannot see';

const detail = (viewerIsOwner: boolean): ChannelDetail =>
  ({ conversationId: 'ch1', channel: { name: 'launch', visibility: 'public', boundProjectId: 'p9' }, roster: [], viewerIsOwner });
const project = (id: string, name: string): Project =>
  ({ id, tenantId: 't1', orgId: 'o1', name, workflows: [], boardId: `b-${id}`, canWrite: true, visibility: 'org' });

function open(): void {
  render(<ChannelManageDialog channelId="ch1" onClose={() => undefined} onChanged={async () => undefined} onArchived={() => undefined} onLeft={() => undefined} />);
}

beforeEach(() => { h.getChannel.mockReset(); h.listProjects.mockReset(); });
afterEach(cleanup);

describe('a failed projects read is not "A project you cannot see"', () => {
  it('owner: the bound project is labelled unknown, the failure is said, and the picker is disabled', async () => {
    h.getChannel.mockResolvedValue(detail(true));
    h.listProjects.mockRejectedValue(new Error('projects_500'));
    open();
    expect(await screen.findByText(FAILED_HINT)).toBeTruthy();
    const select = await screen.findByLabelText('Project');
    if (!(select instanceof HTMLSelectElement)) throw new Error('Project is not a <select>');
    await waitFor(() => expect(select.value).toBe('p9'));
    expect([...select.options].map((o) => o.textContent)).toEqual(['No project', UNKNOWN]);
    expect(select.disabled).toBe(true);
    expect(screen.queryByText(CANNOT_SEE)).toBeNull();
  });

  it('non-owner: the bound project reads as unknown, not "A project you cannot see"', async () => {
    h.getChannel.mockResolvedValue(detail(false));
    h.listProjects.mockRejectedValue(new Error('projects_500'));
    open();
    expect(await screen.findByText(UNKNOWN)).toBeTruthy();
    expect(screen.queryByText(CANNOT_SEE)).toBeNull();
  });

  it('a SUCCESSFUL read that lacks the bound project still says "A project you cannot see" (positive control)', async () => {
    h.getChannel.mockResolvedValue(detail(false));
    h.listProjects.mockResolvedValue([project('p1', 'Launch')]);
    open();
    // "A project you cannot see" also shows while the list is still loading, so
    // settle the read first — otherwise this control would pass without one.
    await waitFor(() => expect(h.listProjects).toHaveBeenCalled());
    await act(async () => { await h.listProjects.mock.results[0]?.value; });
    expect(await screen.findByText(CANNOT_SEE)).toBeTruthy();
    expect(screen.queryByText(UNKNOWN)).toBeNull();
    expect(screen.queryByText(FAILED_HINT)).toBeNull();
  });
});

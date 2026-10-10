/**
 * ADR 0852 D5 — a channel's bound project, in the UI.
 *
 *   ChannelLedgerPanel (members pane): a bound channel shows the project's ledger
 *   summary and a link to its Ledger tab; unbound or a project the
 *   caller cannot read (summary omitted) ⇒ nothing; a failed read is said.
 *
 *   ChannelManageDialog: the owner picks only org-visible projects they can edit
 *   and Save binds; "No project" unbinds; a non-owner reads the bound project.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

const h = vi.hoisted(() => ({
  enabled: true,
  getChannel: vi.fn(),
  setChannelProject: vi.fn(async () => ({ conversationId: 'ch1' })),
  getLedgerSummaries: vi.fn(),
  listProjects: vi.fn(),
}));
vi.mock('../../../client/channelsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getChannel: h.getChannel, setChannelProject: h.setChannelProject }));
vi.mock('../../../features/projects/teamLedgerClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getLedgerSummaries: h.getLedgerSummaries }));
vi.mock('../../../features/projects/projectsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), listProjects: h.listProjects }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => makeFeatureAccess({ enabled: h.enabled }) }));
vi.mock('../ChannelSchedulePanel.js', () => ({ ChannelSchedulePanel: () => null }));
vi.mock('../MemberPickers.js', () => ({ MemberPicker: () => null, AgentPicker: () => null }));

import { ChannelLedgerPanel } from '../ChannelLedgerPanel.js';
import { ChannelManageDialog } from '../ChannelManageDialog.js';

const detail = (over: Record<string, unknown> = {}) => ({ conversationId: 'ch1', channel: { name: 'launch', visibility: 'public', ...over }, roster: [], viewerIsOwner: true });

beforeEach(() => {
  h.enabled = true;
  for (const f of [h.getChannel, h.setChannelProject, h.getLedgerSummaries, h.listProjects]) f.mockClear();
  h.listProjects.mockResolvedValue([
    { id: 'p1', name: 'Launch', canWrite: true, visibility: 'org' },
    { id: 'p2', name: 'Secret', canWrite: true, visibility: 'private' },
    { id: 'p3', name: 'Read only', canWrite: false, visibility: 'org' },
  ]);
});
afterEach(cleanup);

describe('ChannelLedgerPanel', () => {
  it("a bound channel shows the project's ledger summary and links to its Ledger tab", async () => {
    h.getChannel.mockResolvedValue(detail({ boundProjectId: 'p1' }));
    h.getLedgerSummaries.mockResolvedValue([{ projectId: 'p1', name: 'Launch', hasLedger: true, version: 4, goal: 'Ship it', openQuestions: ['Date?'], openQuestionCount: 1, pending: 2 }]);
    render(<MemoryRouter><ChannelLedgerPanel channelId="ch1" /></MemoryRouter>);
    expect(await screen.findByText('Project: Launch')).toBeTruthy();
    expect(screen.getByText(/Version 4/)).toBeTruthy();
    expect(screen.getByText(/2 changes waiting/)).toBeTruthy();
    expect(screen.getByText('Date?')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the ledger' }).getAttribute('href')).toBe('/projects/p1?tab=ledger');
  });

  it('unbound or an unreadable project ⇒ nothing', async () => {
    h.getChannel.mockResolvedValue(detail());
    const a = render(<MemoryRouter><ChannelLedgerPanel channelId="ch1" /></MemoryRouter>);
    await waitFor(() => expect(h.getChannel).toHaveBeenCalled());
    expect(a.container.textContent).toBe('');
    expect(h.getLedgerSummaries).not.toHaveBeenCalled();
    cleanup();
    h.getChannel.mockResolvedValue(detail({ boundProjectId: 'p2' }));
    h.getLedgerSummaries.mockResolvedValue([]); // the route omits what the caller cannot read
    const b = render(<MemoryRouter><ChannelLedgerPanel channelId="ch1" /></MemoryRouter>);
    await waitFor(() => expect(h.getLedgerSummaries).toHaveBeenCalledWith(['p2']));
    expect(b.container.textContent).toBe('');
  });

  it('a failed read is said', async () => {
    h.getChannel.mockRejectedValue(new Error('503'));
    render(<MemoryRouter><ChannelLedgerPanel channelId="ch1" /></MemoryRouter>);
    expect(await screen.findByText('The team ledger could not be loaded.')).toBeTruthy();
  });
});

describe('ChannelManageDialog — bound project', () => {
  const open = () => render(<ChannelManageDialog channelId="ch1" onClose={() => undefined} onChanged={async () => undefined} onArchived={() => undefined} onLeft={() => undefined} />);

  it('the owner can pick only org-visible projects they can edit, and Save binds', async () => {
    h.getChannel.mockResolvedValue(detail());
    open();
    const select = await screen.findByLabelText('Project') as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    expect([...select.options].map((o) => o.textContent)).toEqual(['No project', 'Launch']);
    fireEvent.change(select, { target: { value: 'p1' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!);
    await waitFor(() => expect(h.setChannelProject).toHaveBeenCalledWith('ch1', 'p1'));
  });

  it('"No project" unbinds', async () => {
    h.getChannel.mockResolvedValue(detail({ boundProjectId: 'p1' }));
    open();
    const select = await screen.findByLabelText('Project') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('p1'));
    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!);
    await waitFor(() => expect(h.setChannelProject).toHaveBeenCalledWith('ch1', null));
  });

  it('a non-owner reads the bound project and gets no picker', async () => {
    h.getChannel.mockResolvedValue({ ...detail({ boundProjectId: 'p1' }), viewerIsOwner: false });
    open();
    expect(await screen.findByText('Launch')).toBeTruthy();
    expect(screen.queryByLabelText('Project')).toBeNull();
  });
});

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
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ChannelDetail, ChannelDescriptor, ChannelSummary } from '../../../client/channelsClient.js';
import type { LedgerSummary } from '../../../features/projects/teamLedgerClient.js';
import type { Project } from '../../../features/projects/projectsClient.js';

const h = vi.hoisted(() => ({
  getChannel: vi.fn<(channelId: string) => Promise<ChannelDetail>>(),
  setChannelProject: vi.fn<(channelId: string, projectId: string | null) => Promise<ChannelSummary>>(async () => ({ conversationId: 'ch1' })),
  getLedgerSummaries: vi.fn<(projectIds: readonly string[]) => Promise<LedgerSummary[]>>(),
  listProjects: vi.fn<() => Promise<Project[]>>(),
}));
vi.mock('../../../client/channelsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getChannel: h.getChannel, setChannelProject: h.setChannelProject }));
vi.mock('../../../features/projects/teamLedgerClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getLedgerSummaries: h.getLedgerSummaries }));
vi.mock('../../../features/projects/projectsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), listProjects: h.listProjects }));
vi.mock('../ChannelSchedulePanel.js', () => ({ ChannelSchedulePanel: () => null }));
vi.mock('../MemberPickers.js', () => ({ MemberPicker: () => null, AgentPicker: () => null }));

import { ChannelLedgerPanel } from '../ChannelLedgerPanel.js';
import { ChannelManageDialog } from '../ChannelManageDialog.js';

const detail = (over: Partial<ChannelDescriptor> = {}): ChannelDetail => ({ conversationId: 'ch1', channel: { name: 'launch', visibility: 'public', ...over }, roster: [], viewerIsOwner: true });
const project = (id: string, name: string, canWrite: boolean, visibility: NonNullable<Project['visibility']>): Project =>
  ({ id, tenantId: 't1', orgId: 'o1', name, workflows: [], boardId: `b-${id}`, canWrite, visibility });

/** Settle the panel's load: await the client promise the effect started, then let
 *  React commit — "renders nothing" is only asserted AFTER this (never while loading). */
async function settled(p: Promise<unknown> | undefined): Promise<void> {
  await act(async () => { await p?.catch(() => undefined); });
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
}

beforeEach(() => {
  for (const f of [h.getChannel, h.setChannelProject, h.getLedgerSummaries, h.listProjects]) f.mockClear();
  h.listProjects.mockResolvedValue([
    project('p1', 'Launch', true, 'org'),
    project('p2', 'Secret', true, 'private'),
    project('p3', 'Read only', false, 'org'),
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
    await settled(h.getChannel.mock.results[0]?.value);
    expect(a.container.textContent).toBe('');
    expect(h.getLedgerSummaries).not.toHaveBeenCalled();
    cleanup();
    h.getChannel.mockResolvedValue(detail({ boundProjectId: 'p2' }));
    h.getLedgerSummaries.mockResolvedValue([]); // the route omits what the caller cannot read
    const b = render(<MemoryRouter><ChannelLedgerPanel channelId="ch1" /></MemoryRouter>);
    await waitFor(() => expect(h.getLedgerSummaries).toHaveBeenCalledWith(['p2']));
    await settled(h.getLedgerSummaries.mock.results[0]?.value);
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

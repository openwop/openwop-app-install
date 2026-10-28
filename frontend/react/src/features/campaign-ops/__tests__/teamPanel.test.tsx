/**
 * ADR 0943 P4 — the Team tab.
 *
 *   - each role shows the agent it works as for this client: "Default", or the
 *     client's override with its chip;
 *   - an editor can change a role's agent (PUT with the role's pin and the chosen
 *     agent) and go back to the default (DELETE the binding, after a confirm);
 *     a 422 shows the server's own words;
 *   - a reader sees no change controls and is told why; `canEdit` is the
 *     server's answer, the panel never decides it;
 *   - quality checks: off ⇒ said once, every cell "Off"; on ⇒ "x of y tasks";
 *   - "Chat" deep-links the ONE chat to the agent the role actually uses;
 *   - a failed read is said, never shown as an empty team.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { t } from 'i18next';

const h = vi.hoisted(() => ({ getTeam: vi.fn(), bindRoleAgent: vi.fn(), unbindRoleAgent: vi.fn(), listAgents: vi.fn(), confirm: vi.fn() }));
vi.mock('../campaignOpsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getTeam: h.getTeam, bindRoleAgent: h.bindRoleAgent, unbindRoleAgent: h.unbindRoleAgent }));
vi.mock('../../../client/agentsClient.js', () => ({ listAgents: h.listAgents }));
vi.mock('../../../ui/confirm.js', () => ({ confirm: h.confirm }));

import { TeamPanel } from '../TeamPanel.js';
import { CampaignOpsError, type TeamView } from '../campaignOpsClient.js';

const role = (agentId: string, label: string) => ({ agentId, label, modelClass: 'general', teamRole: true, eval: null });
const view = (over: Partial<TeamView> = {}): TeamView => ({
  canEdit: true,
  evals: { available: true },
  members: [
    { role: { ...role('pack.copywriter', 'Campaign Copywriter'), eval: { suiteRef: 's@1', runId: 'r1', passed: true, passedCount: 9, taskCount: 10, completedAt: '2026-10-19T10:00:00Z' } }, binding: null, narrowerBindings: 0 },
    { role: role('pack.producer', 'Campaign Producer'), binding: { bindingId: 'agb_1', agent: { agentId: 'tenant.producer', label: 'Our Producer', eval: null } }, narrowerBindings: 1 },
  ],
  ...over,
});

function renderPanel(): void {
  render(<MemoryRouter><TeamPanel orgId="o1" clientName="Acme" onStatus={() => {}} /></MemoryRouter>);
}
const rowOf = async (name: string): Promise<HTMLElement> => (await screen.findByText(name)).closest('tr') as HTMLElement;

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.getTeam.mockResolvedValue(view());
  h.listAgents.mockResolvedValue([
    { agentId: 'pack.copywriter', label: 'Campaign Copywriter' },
    { agentId: 'tenant.writer', label: 'House Writer' },
  ]);
  h.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

describe('TeamPanel', () => {
  it('a pending reset confirmation cannot modify the previous client after a switch', async () => {
    let finish!: (value: boolean) => void;
    h.confirm.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const status = vi.fn();
    const page = render(<MemoryRouter><TeamPanel orgId="o1" clientName="Acme" onStatus={status} /></MemoryRouter>);
    const producer = await rowOf('Campaign Producer');
    fireEvent.click(within(producer).getByRole('button', { name: t('campaign-ops:teamResetLabel', { role: 'Campaign Producer' }) }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalledOnce());
    page.rerender(<MemoryRouter><TeamPanel orgId="o2" clientName="Beta" onStatus={status} /></MemoryRouter>);
    await screen.findByText(t('campaign-ops:teamHeading', { client: 'Beta' }));
    await act(async () => { finish(true); });
    expect(h.unbindRoleAgent).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
  it('shows the default or the client override per role, and the last check', async () => {
    renderPanel();
    const copy = await rowOf('Campaign Copywriter');
    expect(within(copy).getByText('Default')).toBeTruthy();
    expect(within(copy).getByText('9 of 10 tasks')).toBeTruthy();
    const prod = await rowOf('Campaign Producer');
    expect(within(prod).getByText('Our Producer')).toBeTruthy();
    expect(within(prod).getByText('Changed for this client')).toBeTruthy();
    expect(within(prod).getByText('Plus 1 change for one step')).toBeTruthy();
    expect(within(prod).getByText('Not checked yet')).toBeTruthy();
  });

  it('Chat opens the one chat on the agent the role actually uses', async () => {
    renderPanel();
    const prod = await rowOf('Campaign Producer');
    expect(within(prod).getByRole('link', { name: 'Chat with Our Producer' }).getAttribute('href')).toBe('/chat?agent=tenant.producer&client=o1');
  });

  it('an editor changes a role with its pin and the chosen agent', async () => {
    h.bindRoleAgent.mockResolvedValue(undefined);
    renderPanel();
    const copy = await rowOf('Campaign Copywriter');
    fireEvent.click(within(copy).getByRole('button', { name: 'Change the agent for Campaign Copywriter' }));
    const select = await screen.findByRole('combobox', { name: /^Agent/ });
    // The role's current agent is not offered as a change.
    expect(within(select).queryByText('Campaign Copywriter')).toBeNull();
    fireEvent.change(select, { target: { value: 'tenant.writer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.bindRoleAgent).toHaveBeenCalledWith('o1', 'pack.copywriter', 'tenant.writer'));
    await waitFor(() => expect(h.getTeam).toHaveBeenCalledTimes(2));
  });

  it("a refused change shows the server's own words", async () => {
    h.bindRoleAgent.mockRejectedValue(new CampaignOpsError("The agent 'tenant.writer' cannot use every tool the pinned agent can.", 422, 'agent_binding_invalid'));
    renderPanel();
    const copy = await rowOf('Campaign Copywriter');
    fireEvent.click(within(copy).getByRole('button', { name: 'Change the agent for Campaign Copywriter' }));
    fireEvent.change(await screen.findByRole('combobox', { name: /^Agent/ }), { target: { value: 'tenant.writer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findAllByText("The agent 'tenant.writer' cannot use every tool the pinned agent can.")).length).toBeGreaterThan(0);
  });

  it('use default deletes the binding after a confirm', async () => {
    h.unbindRoleAgent.mockResolvedValue(undefined);
    renderPanel();
    const prod = await rowOf('Campaign Producer');
    fireEvent.click(within(prod).getByRole('button', { name: 'Use the default agent for Campaign Producer' }));
    await waitFor(() => expect(h.unbindRoleAgent).toHaveBeenCalledWith('o1', 'agb_1'));
    expect(h.confirm).toHaveBeenCalledTimes(1);
  });

  it('a reader sees no change controls and is told why', async () => {
    h.getTeam.mockResolvedValue(view({ canEdit: false }));
    renderPanel();
    await rowOf('Campaign Producer');
    expect(screen.getByText(/You can see this team/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Change the agent/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Use the default agent/ })).toBeNull();
  });

  it('with quality checks off it says so once and shows Off, never a blank score', async () => {
    h.getTeam.mockResolvedValue(view({ evals: { available: false, reason: 'feature_disabled' } }));
    renderPanel();
    expect(await screen.findByText(/Quality checks are turned off/)).toBeTruthy();
    const copy = await rowOf('Campaign Copywriter');
    expect(within(copy).getByText('Off')).toBeTruthy();
    expect(within(copy).queryByText('9 of 10 tasks')).toBeNull();
  });

  it('a failed read is said, not shown as an empty team', async () => {
    h.getTeam.mockRejectedValue(new CampaignOpsError('boom', 500));
    renderPanel();
    expect(await screen.findByText('Couldn’t load the team')).toBeTruthy();
    expect(screen.queryByText('No campaign roles yet')).toBeNull();
  });
});

/**
 * ChannelSettingsPage (ADR 1042, CHAN-P0-8) — the channels settings page.
 *
 * Guards the flows the ADR puts on this page:
 *  (1) toggle off → the off card and NO reads; unresolved → no off card;
 *  (2) each connection shows its inbound mode and answering agent;
 *  (3) approving a PERSON says outsiders get only reviewed read tools, then approves;
 *  (4) approving a GROUP shows the D9 warning and the Approve button stays
 *      disabled (nothing is sent) until the acknowledgement is ticked;
 *  (5) deny asks, then calls the deny route (and never approves);
 *  (6) "This is me" appears only on a row the caller approved (`mine`) and never
 *      on a group; marking asks first and explains full tools;
 *  (7) revoking a sender and a relay device each ask, then call their route;
 *  (8) a relay device's account is shown to its owner only;
 *  (9) Revoke shows only on a device the server marks `canRevoke` (ADR 1043 D3);
 * (10) ADR 1043 D9 (CHAN-P1b): the device's OWNER opens its senders, approves a
 *      person (the device's route, never the connection's), and a group only after
 *      the D9 acknowledgement, which the device route receives as
 *      `groupAcknowledged`; a workspace admin (`canApprove: false`) sees no
 *      pending list and no Approve, only Revoke; a device the caller neither owns
 *      nor may revoke offers no Senders button.
 *      Sabotage-witnessed 2026-11-04 (each reddened its own case, restored):
 *      showing pending/Approve whatever `canApprove` says; dropping
 *      `groupAcknowledged` from `approveRelaySender`.
 * (11) The hosted client's `approveSender` sends `groupAcknowledged` for a group
 *      (required server-side, ADR 1042 D9) and not for a person. Sabotage-witnessed
 *      2026-11-04: dropping it from `approveSender` turned this case red.
 *
 * (12) Every revoke (a sender, a device, a relay sender) asks first: the confirm's title is
 *      asserted, so dropping the confirm reds its case.
 * The admin case's "no per-row Approve" rides the same `canApprove` guard as its 'Waiting for
 * approval' heading (the server sends no pending rows to an admin); the heading is the witness.
 *
 * Sabotage-witnessed 2026-11-03 (each reddened its own case; restored, 14/14):
 * dropping `!group || ack` from the dialog's arm; dropping `s.mine &&` from the
 * self control; dropping `!isGroupSender(...)` from it; wiring Deny to
 * `approveSender`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

vi.mock('../channelIngressClient.js', async (orig) => {
  const real = await orig<typeof import('../channelIngressClient.js')>();
  return {
    ...real,
    listChannelConnections: vi.fn(), getInbound: vi.fn(), getChannelSettings: vi.fn(), putChannelSettings: vi.fn(),
    getBinding: vi.fn(), putBinding: vi.fn(), deleteBinding: vi.fn(),
    listSenders: vi.fn(), approveSender: vi.fn(), denyPendingSender: vi.fn(), setSenderSelf: vi.fn(), revokeSender: vi.fn(),
    listRelayDevices: vi.fn(), revokeRelayDevice: vi.fn(),
    listRelaySenders: vi.fn(), denyRelayPendingSender: vi.fn(), revokeRelaySender: vi.fn(),
  };
});
vi.mock('../../../client/agentsClient.js', () => ({ listAgents: vi.fn() }));
let enabled = true;
let loading = false;
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess: () => makeFeatureAccess({ enabled, status: enabled ? 'on' : 'off', loading }),
}));

import * as api from '../channelIngressClient.js';
import { listAgents, type AgentEntry } from '../../../client/agentsClient.js';
import { ApiError } from '../../../client/requestJson.js';
import { ChannelSettingsPage } from '../ChannelSettingsPage.js';

const m = {
  connections: vi.mocked(api.listChannelConnections), inbound: vi.mocked(api.getInbound), settings: vi.mocked(api.getChannelSettings),
  binding: vi.mocked(api.getBinding), senders: vi.mocked(api.listSenders), approve: vi.mocked(api.approveSender),
  deny: vi.mocked(api.denyPendingSender), self: vi.mocked(api.setSenderSelf), revoke: vi.mocked(api.revokeSender),
  devices: vi.mocked(api.listRelayDevices), revokeDevice: vi.mocked(api.revokeRelayDevice), agents: vi.mocked(listAgents),
  relaySenders: vi.mocked(api.listRelaySenders), relayDeny: vi.mocked(api.denyRelayPendingSender), relayRevoke: vi.mocked(api.revokeRelaySender),
};
const requestJsonMock = vi.hoisted(() => vi.fn());
// Spread the real module: the tests reject with its `ApiError`, the shape production throws.
vi.mock('../../../client/requestJson.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/requestJson.js')>()),
  requestJson: requestJsonMock,
}));

const TG = { connectionId: 'c-tg', provider: 'telegram', displayName: 'Support bot', status: 'active' };
const IRIS: AgentEntry = {
  agentId: 'iris', persona: 'assistant', label: 'Iris', modelClass: 'standard', packName: 'vendor.test.agents',
  packVersion: '1.0.0', toolAllowlist: [], hasHandoffSchemas: false,
};
const page = (): ReturnType<typeof render> => render(<MemoryRouter><ChannelSettingsPage /></MemoryRouter>);
const rowOf = (text: string): HTMLElement => {
  const row = screen.getByText(text).closest('tr');
  if (!row) throw new Error(`no row for ${text}`);
  return row;
};
let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  enabled = true; loading = false;
  for (const fn of Object.values(m)) fn.mockReset();
  m.connections.mockResolvedValue([TG]);
  m.inbound.mockResolvedValue({ provider: 'telegram', mode: 'conversation', enabled: true });
  m.settings.mockResolvedValue({ agentId: 'iris', botHandle: 'supportbot' });
  m.binding.mockResolvedValue(null);
  m.agents.mockResolvedValue([IRIS]);
  m.devices.mockResolvedValue([]);
  m.senders.mockResolvedValue({ approved: [], pending: [] });
  m.approve.mockResolvedValue({ senderId: 'x', ownerUserId: 'u1', approvedAt: '2026-11-03T00:00:00Z', mine: true });
  requestJsonMock.mockReset();
  m.relaySenders.mockResolvedValue({ approved: [], pending: [], canApprove: true });
  m.relayDeny.mockResolvedValue(undefined); m.relayRevoke.mockResolvedValue(undefined);
  m.deny.mockResolvedValue(undefined); m.self.mockResolvedValue(undefined); m.revoke.mockResolvedValue(undefined); m.revokeDevice.mockResolvedValue(undefined);
  // `confirm()` falls back to the native dialog when no ConfirmRoot is mounted.
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { cleanup(); confirmSpy.mockRestore(); });

async function openManage(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Manage Support bot' }));
}

describe('ChannelSettingsPage — gating', () => {
  it('toggle off: the off card, and nothing is read', async () => {
    enabled = false;
    page();
    expect(await screen.findByText('Channels into chat is turned off for this workspace.')).toBeTruthy();
    expect(m.connections).not.toHaveBeenCalled();
    expect(m.devices).not.toHaveBeenCalled();
  });

  it('toggle unresolved: no off card and no reads yet', () => {
    // Production shape while loading: `enabled` is the fallback false (makeFeatureAccess doc).
    enabled = false; loading = true;
    page();
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeTruthy(); // the skeleton
    expect(screen.queryByText('Channels into chat is turned off for this workspace.')).toBeNull();
    expect(m.connections).not.toHaveBeenCalled();
  });
});

describe('ChannelSettingsPage — connections', () => {
  it('shows each connection with its inbound mode and answering agent', async () => {
    m.connections.mockResolvedValue([TG, { connectionId: 'c-sl', provider: 'slack', displayName: 'Team Slack', status: 'active' }]);
    m.inbound.mockImplementation(async (id) => (id === 'c-tg' ? { provider: 'telegram', mode: 'conversation', enabled: true } : { provider: 'slack', workflowId: 'wf', enabled: true }));
    m.settings.mockImplementation(async (id) => (id === 'c-tg' ? { agentId: 'iris' } : null));
    page();
    await screen.findByText('Support bot');
    await waitFor(() => expect(within(rowOf('Support bot')).getByText('Into chat')).toBeTruthy());
    expect(within(rowOf('Support bot')).getByText('Iris')).toBeTruthy();
    await waitFor(() => expect(within(rowOf('Team Slack')).getByText('Starts a workflow')).toBeTruthy());
    expect(within(rowOf('Team Slack')).getByText('Default assistant')).toBeTruthy();
  });

  it('a connection the caller cannot manage says so and offers no Manage', async () => {
    m.inbound.mockRejectedValue(new ApiError({ status: 403, statusText: 'Forbidden', url: '/host/openwop-app/connections/c-tg/inbound' }));
    page();
    expect(await screen.findByText('Only someone who manages this connection can see its settings.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Manage Support bot' })).toBeNull();
  });

  it('no chat connections: the empty state points to Connections', async () => {
    m.connections.mockResolvedValue([]);
    page();
    expect(await screen.findByText('No chat connections yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Connections' })).toBeTruthy();
  });

  it('a failed read is an error with a retry, not an empty list', async () => {
    m.connections.mockRejectedValueOnce(new ApiError({ status: 503, statusText: 'Unavailable', url: '/host/openwop-app/connections' }));
    page();
    expect(await screen.findByText('Could not load your connections.')).toBeTruthy();
    expect(screen.queryByText('No chat connections yet')).toBeNull();
    // The retry reads again, and a good second read shows the list.
    // The devices read succeeded, so this is the only retry on the page.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Support bot')).toBeTruthy();
    expect(m.connections).toHaveBeenCalledTimes(2);
  });
});

describe('ChannelSettingsPage — pending senders', () => {
  const pending = (senderId: string, chatId = senderId) => ({ senderId, chatId, firstSeenAt: '2026-11-03T10:00:00Z', lastSeenAt: '2026-11-03T11:00:00Z', count: 2 });

  it('approving a person says outsiders get only reviewed read tools, then approves', async () => {
    m.senders.mockResolvedValue({ approved: [], pending: [pending('555')] });
    page();
    await openManage();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve 555' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/An outside sender gets only reviewed read tools/)).toBeTruthy();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(m.approve).toHaveBeenCalledWith('c-tg', '555', undefined));
  });

  it('approving a GROUP shows the D9 warning and needs the acknowledgement before anything is sent', async () => {
    m.senders.mockResolvedValue({ approved: [], pending: [pending('group:-100', '-100')] });
    page();
    await openManage();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve group:-100' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Everyone in this group will act with your authority/)).toBeTruthy();
    const confirmBtn = within(dialog).getByRole('button', { name: 'Approve group' });
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirmBtn);
    fireEvent.submit(confirmBtn.closest('form')!);
    expect(m.approve).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /every member of this group acts with my authority/ }));
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(m.approve).toHaveBeenCalledWith('c-tg', 'group:-100', undefined));
  });

  it('deny asks first, then calls the deny route and approves nobody', async () => {
    m.senders.mockResolvedValue({ approved: [], pending: [pending('555')] });
    page();
    await openManage();
    fireEvent.click(await screen.findByRole('button', { name: 'Deny 555' }));
    await waitFor(() => expect(m.deny).toHaveBeenCalledWith('c-tg', '555'));
    expect(confirmSpy).toHaveBeenCalledWith('Deny 555?');
    expect(m.approve).not.toHaveBeenCalled();
  });

  it('a declined deny sends nothing', async () => {
    confirmSpy.mockReturnValue(false);
    m.senders.mockResolvedValue({ approved: [], pending: [pending('555')] });
    page();
    await openManage();
    fireEvent.click(await screen.findByRole('button', { name: 'Deny 555' }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(m.deny).not.toHaveBeenCalled();
  });
});

describe('ChannelSettingsPage — approved senders', () => {
  const approved = (senderId: string, mine: boolean, extra: { self?: boolean; label?: string } = {}) => ({ senderId, ownerUserId: mine ? 'me' : 'other', approvedAt: '2026-11-03T10:00:00Z', mine, ...extra });

  it('"This is me" only on a row the caller approved, never on a group or someone else\'s', async () => {
    m.senders.mockResolvedValue({ approved: [approved('111', true), approved('222', false), approved('group:-7', true)], pending: [] });
    page();
    await openManage();
    await screen.findByText('111');
    expect(within(rowOf('111')).getByRole('button', { name: 'Mark 111 as your own account' })).toBeTruthy();
    expect(within(rowOf('222')).queryByRole('button', { name: /own account/ })).toBeNull();
    expect(within(rowOf('group:-7')).queryByRole('button', { name: /own account/ })).toBeNull();
    // What self means is on the page, not only in the dialog.
    expect(screen.getByText(/A group is never anyone’s own account/)).toBeTruthy();
  });

  it('marking self asks first, then sets it; a self row offers "Not me"', async () => {
    m.senders.mockResolvedValue({ approved: [approved('111', true)], pending: [] });
    page();
    await openManage();
    fireEvent.click(await screen.findByRole('button', { name: 'Mark 111 as your own account' }));
    await waitFor(() => expect(m.self).toHaveBeenCalledWith('c-tg', '111', true));
    expect(confirmSpy).toHaveBeenCalledWith('Is 111 your own account?');

    cleanup();
    m.senders.mockResolvedValue({ approved: [approved('111', true, { self: true })], pending: [] });
    page();
    await openManage();
    const notMe = await screen.findByRole('button', { name: 'Stop treating 111 as your own account' });
    // The self badge (the 'Approved by' cell also reads You).
    expect(within(rowOf('111')).getAllByText('You').some((el) => el.classList.contains('status-badge'))).toBe(true);
    fireEvent.click(notMe);
    await waitFor(() => expect(m.self).toHaveBeenCalledWith('c-tg', '111', false));
  });

  it('revoke asks, then calls the revoke route', async () => {
    m.senders.mockResolvedValue({ approved: [approved('222', false, { label: 'Bo' })], pending: [] });
    page();
    await openManage();
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke Bo (222)' }));
    await waitFor(() => expect(m.revoke).toHaveBeenCalledWith('c-tg', '222'));
    expect(confirmSpy).toHaveBeenCalledWith('Revoke Bo (222)?');
  });
});

describe('ChannelSettingsPage — relay devices', () => {
  it('lists devices with owner and state; the account shows to its owner only; revoke asks then calls', async () => {
    m.devices.mockResolvedValue([
      { relayId: 'r1', channel: 'signal', deviceName: 'Desk phone', status: 'active', registeredAt: '2026-11-01T00:00:00Z', lastHeartbeatAt: '2026-11-03T10:00:00Z', online: true, owner: { userId: 'me', ownedByCaller: true, accountId: '+15550004321' }, canRevoke: true },
      { relayId: 'r2', channel: 'whatsapp', deviceName: 'Laptop', status: 'active', registeredAt: '2026-11-01T00:00:00Z', online: false, owner: { userId: 'other', ownedByCaller: false }, canRevoke: true },
      { relayId: 'r3', channel: 'imessage', deviceName: 'Their Mac', status: 'active', registeredAt: '2026-11-01T00:00:00Z', online: false, owner: { userId: 'other', ownedByCaller: false }, canRevoke: false },
    ]);
    page();
    await screen.findByText('Desk phone');
    expect(within(rowOf('Desk phone')).getByText('Online')).toBeTruthy();
    expect(within(rowOf('Desk phone')).getByText('+15550004321')).toBeTruthy();
    expect(within(rowOf('Laptop')).getByText('Offline')).toBeTruthy();
    expect(within(rowOf('Laptop')).getByText('Shown to its owner only')).toBeTruthy();
    expect(within(rowOf('Laptop')).getByText('Never')).toBeTruthy();
    // ADR 1043 D3 — Revoke shows only where the server says the caller may revoke.
    expect(within(rowOf('Their Mac')).queryByRole('button', { name: 'Revoke Their Mac' })).toBeNull();
    expect(within(rowOf('Desk phone')).getByRole('button', { name: 'Revoke Desk phone' })).toBeTruthy();
    fireEvent.click(within(rowOf('Laptop')).getByRole('button', { name: 'Revoke Laptop' }));
    await waitFor(() => expect(m.revokeDevice).toHaveBeenCalledWith('r2'));
    expect(confirmSpy).toHaveBeenCalledWith('Revoke Laptop?');
  });
});

describe('ChannelSettingsPage — a relay device\'s senders (ADR 1043 D9)', () => {
  const device = (relayId: string, name: string, ownedByCaller: boolean, canRevoke: boolean) => ({
    relayId, channel: 'signal', deviceName: name, status: 'active' as const, registeredAt: '2026-11-01T00:00:00Z', online: true,
    owner: { userId: ownedByCaller ? 'me' : 'other', ownedByCaller }, canRevoke,
  });
  const pending = (senderId: string, chatId = senderId) => ({ senderId, chatId, firstSeenAt: '2026-11-04T10:00:00Z', lastSeenAt: '2026-11-04T11:00:00Z', count: 1 });

  it('the owner approves a person through the DEVICE route, and a group only after the acknowledgement', async () => {
    m.devices.mockResolvedValue([device('r1', 'Desk phone', true, true)]);
    m.relaySenders.mockResolvedValue({ approved: [], pending: [pending('+15550001111'), pending('group:team', 'team')], canApprove: true });
    requestJsonMock.mockResolvedValue({ sender: { senderId: 'x', ownerUserId: 'me', approvedAt: '2026-11-04T00:00:00Z', mine: true } });
    page();
    fireEvent.click(await screen.findByRole('button', { name: 'Manage who may write to Desk phone' }));
    expect(await screen.findByText('Who may write to Desk phone')).toBeTruthy();
    expect(m.relaySenders).toHaveBeenCalledWith('r1');

    fireEvent.click(await screen.findByRole('button', { name: 'Approve +15550001111' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(requestJsonMock).toHaveBeenCalledWith('/host/openwop-app/messaging/relay/r1/senders', { method: 'POST', json: { senderId: '+15550001111' } }));
    expect(m.approve).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: 'Approve group:team' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Everyone in this group will act with your authority/)).toBeTruthy();
    expect(within(dialog).getByText(/groups are answered only when your assistant is mentioned by name/)).toBeTruthy();
    const confirmBtn = within(dialog).getByRole('button', { name: 'Approve group' });
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /every member of this group acts with my authority/ }));
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(requestJsonMock).toHaveBeenCalledWith('/host/openwop-app/messaging/relay/r1/senders', { method: 'POST', json: { senderId: 'group:team', groupAcknowledged: true } }));
  });

  it('the owner denies through the device route; a device has no "This is me"', async () => {
    m.devices.mockResolvedValue([device('r1', 'Desk phone', true, true)]);
    m.relaySenders.mockResolvedValue({ approved: [{ senderId: '222', ownerUserId: 'me', approvedAt: '2026-11-04T00:00:00Z', mine: true }], pending: [pending('555')], canApprove: true });
    page();
    fireEvent.click(await screen.findByRole('button', { name: 'Manage who may write to Desk phone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Deny 555' }));
    await waitFor(() => expect(m.relayDeny).toHaveBeenCalledWith('r1', '555'));
    expect(m.deny).not.toHaveBeenCalled();
    expect(within(rowOf('222')).queryByRole('button', { name: /own account/ })).toBeNull();
  });

  it('a workspace admin sees no pending list and no Approve, and can revoke', async () => {
    m.devices.mockResolvedValue([device('r2', 'Laptop', false, true), device('r3', 'Their Mac', false, false)]);
    m.relaySenders.mockResolvedValue({ approved: [{ senderId: '333', ownerUserId: 'other', approvedAt: '2026-11-04T00:00:00Z', mine: false }], pending: [], canApprove: false });
    page();
    await screen.findByText('Laptop');
    expect(within(rowOf('Their Mac')).queryByRole('button', { name: /Manage who may write/ })).toBeNull();
    fireEvent.click(within(rowOf('Laptop')).getByRole('button', { name: 'Manage who may write to Laptop' }));
    expect(await screen.findByText(/Only the owner of this device can approve or deny/)).toBeTruthy();
    expect(screen.queryByText('Waiting for approval')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Approve / })).toBeNull(); // per-row Approve; the 'Approved' column sort is not one
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke 333' }));
    await waitFor(() => expect(m.relayRevoke).toHaveBeenCalledWith('r2', '333'));
    expect(confirmSpy).toHaveBeenCalledWith('Revoke 333?');
    expect(m.revoke).not.toHaveBeenCalled();
  });
});

describe('channelIngressClient — the hosted group acknowledgement (ADR 1042 D9)', () => {
  it('approveSender sends groupAcknowledged for a group, never for a person', async () => {
    const real = await vi.importActual<typeof import('../channelIngressClient.js')>('../channelIngressClient.js');
    requestJsonMock.mockResolvedValue({ sender: { senderId: 'x', ownerUserId: 'me', approvedAt: '2026-11-04T00:00:00Z', mine: true } });
    await real.approveSender('c-tg', 'group:-100');
    await real.approveSender('c-tg', '555', 'Ana');
    expect(requestJsonMock.mock.calls).toEqual([
      ['/host/openwop-app/connections/c-tg/senders', { method: 'POST', json: { senderId: 'group:-100', groupAcknowledged: true } }],
      ['/host/openwop-app/connections/c-tg/senders', { method: 'POST', json: { senderId: '555', label: 'Ana' } }],
    ]);
  });
});

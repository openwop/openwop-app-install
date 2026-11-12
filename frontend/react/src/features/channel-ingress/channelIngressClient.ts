/**
 * Channels into chat (ADR 1042, CHAN-P0-8) — the settings page's client.
 *
 * Only routes the backend exposes (host-extension, non-normative):
 *   GET  /host/openwop-app/connections                       the caller's connections
 *   GET  /host/openwop-app/connections/:id/inbound           inbound mode (conversation | workflow)
 *   GET|PUT /host/openwop-app/connections/:id/channel        agent, bot handle, model
 *   GET|PUT|DELETE /host/openwop-app/connections/:id/pairing the sender binding (D3)
 *   GET|POST /host/openwop-app/connections/:id/senders       approved (+ `mine`) and pending senders
 *   PUT  /host/openwop-app/connections/:id/senders/:s/self   "this is me" (D9, approver only)
 *   DELETE /host/openwop-app/connections/:id/senders/:s      revoke
 *   DELETE /host/openwop-app/connections/:id/senders/:s/pending  deny a pending request (CHAN-P0-8)
 *   GET  /host/openwop-app/messaging/relay/devices           relay devices (CHAN-P0-8)
 *   POST /host/openwop-app/messaging/relay/revoke            revoke a device (owner or workspace admin; ADR 1043 D3)
 *   GET|PUT /host/openwop-app/messaging/relay/channels[/:ch]  the per-channel relay switch (PUT: workspace admin; CHAN-F11)
 *   GET|POST /host/openwop-app/messaging/relay/:id/senders   a device's approved + pending senders; approve (owner; ADR 1043 D9)
 *   DELETE /host/openwop-app/messaging/relay/:id/senders/:s[/pending]  revoke (owner or admin) / deny (owner)
 *
 * Every failure is a typed `ApiError` (status + parsed body), never an empty list.
 */
import { requestJson } from '../../client/requestJson.js';

const BASE = '/host/openwop-app';
const conn = (id: string): string => `${BASE}/connections/${encodeURIComponent(id)}`;

/** Connection providers that can carry chat messages (ADR 1042 D1). `twilio`
 *  carries WhatsApp only when its inbound is configured as `whatsapp-twilio`. */
export const CHANNEL_PROVIDERS: ReadonlySet<string> = new Set(['telegram', 'discord', 'slack', 'twilio', 'whatsapp-cloud']);
/** Inbound providers a conversation-mode config, and a sender binding, may use. */
export const CONVERSATIONAL_PROVIDERS: ReadonlySet<string> = new Set(['telegram', 'discord', 'slack', 'whatsapp-twilio', 'whatsapp-cloud']);

export interface ChannelConnection {
  connectionId: string;
  provider: string;
  displayName: string;
  status: string;
  userId?: string;
  orgId?: string;
}

export interface InboundConfig {
  provider: string;
  workflowId?: string;
  mode?: 'workflow' | 'conversation';
  enabled: boolean;
}

export interface ChannelSettings {
  agentId?: string;
  botHandle?: string;
  provider?: string;
  model?: string;
  updatedAt?: string;
}

export interface SenderBinding { provider: string; channelId: string }

export interface ApprovedSender {
  senderId: string;
  ownerUserId: string;
  self?: boolean;
  label?: string;
  approvedAt: string;
  /** The caller approved this sender, so only they may mark it as their own. */
  mine: boolean;
}

export interface PendingSender {
  senderId: string;
  chatId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
}

export interface RelayDevice {
  relayId: string;
  channel: string;
  deviceName?: string;
  status: 'registered' | 'active' | 'revoked';
  registeredAt: string;
  lastHeartbeatAt?: string;
  online: boolean;
  owner: { userId: string; ownedByCaller: boolean; accountId?: string } | null;
  /** ADR 1043 D3 — the caller may revoke it: its owner, or a workspace admin. */
  canRevoke: boolean;
  /** ADR 1043 D3 — `online` derives from this; `never` = no heartbeat yet. */
  presence?: 'online' | 'offline' | 'never';
  offlineSince?: string;
  /** CHAN-F11 — false while a workspace admin has this device's channel switched off. */
  channelEnabled?: boolean;
}

/** CHAN-F11 — the workspace's per-channel relay switch. */
export interface RelayChannelSwitches { channels: Array<{ channel: string; enabled: boolean }>; canManage: boolean }

/** A group approval is `group:<chatId>` (ADR 1042 D3). */
export const isGroupSender = (senderId: string): boolean => senderId.startsWith('group:');

export async function listChannelConnections(): Promise<ChannelConnection[]> {
  const { connections } = await requestJson<{ connections: ChannelConnection[] }>(`${BASE}/connections`, { method: 'GET' });
  return connections.filter((c) => CHANNEL_PROVIDERS.has(c.provider));
}

export async function getInbound(connectionId: string): Promise<InboundConfig | null> {
  return (await requestJson<{ config: InboundConfig | null }>(`${conn(connectionId)}/inbound`, { method: 'GET' })).config;
}

export async function getChannelSettings(connectionId: string): Promise<ChannelSettings | null> {
  return (await requestJson<{ settings: ChannelSettings | null }>(`${conn(connectionId)}/channel`, { method: 'GET' })).settings;
}

/** PUT replaces the whole row, so the caller sends every field it wants kept. */
export async function putChannelSettings(connectionId: string, settings: Omit<ChannelSettings, 'updatedAt'>): Promise<ChannelSettings> {
  return (await requestJson<{ settings: ChannelSettings }>(`${conn(connectionId)}/channel`, { method: 'PUT', json: settings })).settings;
}

export async function getBinding(connectionId: string): Promise<SenderBinding | null> {
  return (await requestJson<{ pairing: SenderBinding | null }>(`${conn(connectionId)}/pairing`, { method: 'GET' })).pairing;
}

export async function putBinding(connectionId: string, provider: string, channelId: string): Promise<SenderBinding> {
  return (await requestJson<{ pairing: SenderBinding }>(`${conn(connectionId)}/pairing`, { method: 'PUT', json: { provider, channelId } })).pairing;
}

export async function deleteBinding(connectionId: string): Promise<void> {
  await requestJson(`${conn(connectionId)}/pairing`, { method: 'DELETE' });
}

export async function listSenders(connectionId: string): Promise<{ approved: ApprovedSender[]; pending: PendingSender[] }> {
  return requestJson<{ approved: ApprovedSender[]; pending: PendingSender[] }>(`${conn(connectionId)}/senders`, { method: 'GET' });
}

/** A group is sent with `groupAcknowledged` (required server-side, ADR 1042 D9): the
 *  dialog submits one only after the acknowledgement is ticked. */
export async function approveSender(connectionId: string, senderId: string, label?: string): Promise<ApprovedSender> {
  const json = { senderId, ...(label ? { label } : {}), ...(isGroupSender(senderId) ? { groupAcknowledged: true } : {}) };
  return (await requestJson<{ sender: ApprovedSender }>(`${conn(connectionId)}/senders`, { method: 'POST', json })).sender;
}

export async function setSenderSelf(connectionId: string, senderId: string, self: boolean): Promise<void> {
  await requestJson(`${conn(connectionId)}/senders/${encodeURIComponent(senderId)}/self`, { method: 'PUT', json: { self } });
}

export async function revokeSender(connectionId: string, senderId: string): Promise<void> {
  await requestJson(`${conn(connectionId)}/senders/${encodeURIComponent(senderId)}`, { method: 'DELETE' });
}

/** Deny a pending request: it leaves the review list; the sender stays blocked. */
export async function denyPendingSender(connectionId: string, senderId: string): Promise<void> {
  await requestJson(`${conn(connectionId)}/senders/${encodeURIComponent(senderId)}/pending`, { method: 'DELETE' });
}

export async function listRelayDevices(): Promise<RelayDevice[]> {
  return (await requestJson<{ devices: RelayDevice[] }>(`${BASE}/messaging/relay/devices`, { method: 'GET' })).devices;
}

export async function getRelayChannels(): Promise<RelayChannelSwitches> {
  return requestJson<RelayChannelSwitches>(`${BASE}/messaging/relay/channels`, { method: 'GET' });
}

/** A workspace admin's act (403 `relay_admin_required` otherwise). */
export async function setRelayChannel(channel: string, enabled: boolean): Promise<RelayChannelSwitches['channels']> {
  return (await requestJson<{ channels: RelayChannelSwitches['channels'] }>(`${BASE}/messaging/relay/channels/${encodeURIComponent(channel)}`, { method: 'PUT', json: { enabled } })).channels;
}

export async function revokeRelayDevice(relayId: string): Promise<void> {
  await requestJson(`${BASE}/messaging/relay/revoke`, { method: 'POST', json: { relayId } });
}

// ADR 1043 D9 (CHAN-P1b) — a relay device's own approved and pending senders. The
// device's owner lists, approves and denies; a workspace admin lists the approved
// ones (`canApprove: false`, no pending) and may revoke.
const relaySenders = (relayId: string): string => `${BASE}/messaging/relay/${encodeURIComponent(relayId)}/senders`;

export interface RelaySenders { approved: ApprovedSender[]; pending: PendingSender[]; canApprove: boolean }

export async function listRelaySenders(relayId: string): Promise<RelaySenders> {
  return requestJson<RelaySenders>(relaySenders(relayId), { method: 'GET' });
}

/** A group is sent with `groupAcknowledged`: the dialog submits one only after the D9 acknowledgement. */
export async function approveRelaySender(relayId: string, senderId: string, label?: string): Promise<ApprovedSender> {
  const json = { senderId, ...(label ? { label } : {}), ...(isGroupSender(senderId) ? { groupAcknowledged: true } : {}) };
  return (await requestJson<{ sender: ApprovedSender }>(relaySenders(relayId), { method: 'POST', json })).sender;
}

export async function denyRelayPendingSender(relayId: string, senderId: string): Promise<void> {
  await requestJson(`${relaySenders(relayId)}/${encodeURIComponent(senderId)}/pending`, { method: 'DELETE' });
}

export async function revokeRelaySender(relayId: string, senderId: string): Promise<void> {
  await requestJson(`${relaySenders(relayId)}/${encodeURIComponent(senderId)}`, { method: 'DELETE' });
}

/** The server's own words for a 4xx refusal, when it gave any. */
export function refusalMessage(err: unknown): string | null {
  const status = (err as { status?: unknown } | null)?.status;
  const message = ((err as { body?: unknown } | null)?.body as { message?: unknown } | undefined)?.message;
  return typeof status === 'number' && status >= 400 && status < 500 && typeof message === 'string' && message.length > 0 ? message : null;
}

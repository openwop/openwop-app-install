/**
 * ADR 1042 D4 (CHAN-P0-4) — the reply transports this feature owns. Every one
 * reaches the platform through the connections broker, pinned to the inbound
 * connection and run as the thread's paired owner; no raw secret is ever read
 * here. WhatsApp's two lanes are registered by the whatsapp feature itself
 * (its governed send service keeps consent, the 24h window and idempotency).
 */
import type { Storage } from '../../storage/storage.js';
import { brokeredFetch } from '../../host/brokeredEgress.js';
import { makeSlackAdapter } from '../../host/slackAdapter.js';
import { enqueueOutbound } from '../../routes/messaging.js';
import type { RelayChannel } from '../../messaging/types.js';
import { registerReplyTransport, type ChannelReply, type ReplyTransportResult } from '../connections/messagingOutbound.js';

const TELEGRAM_BASE = (): string => (process.env.OPENWOP_TELEGRAM_API_BASE ?? 'https://api.telegram.org').replace(/\/+$/, '');
const DISCORD_BASE = (): string => (process.env.OPENWOP_DISCORD_API_BASE ?? 'https://discord.com').replace(/\/+$/, '');

/** Platform message size limits (a longer reply is cut, never refused). */
const LIMIT: Record<string, number> = { telegram: 4096, discord: 2000, slack: 39_000, relay: 16_000 };
const clip = (text: string, provider: string): string => (text.length > (LIMIT[provider] ?? 4096) ? `${text.slice(0, (LIMIT[provider] ?? 4096) - 1)}…` : text);

function connectionOf(reply: ChannelReply): { connectionId: string; provider: string } | null {
  return reply.lane.kind === 'connection' ? { connectionId: reply.lane.connectionId, provider: reply.lane.provider } : null;
}
const correlation = (reply: ChannelReply): string => `channel-reply:${reply.inboundMessageId}`;

async function sendTelegram(storage: Storage, reply: ChannelReply): Promise<ReplyTransportResult> {
  const conn = connectionOf(reply);
  if (!conn) return { sent: false, error: 'wrong_lane' };
  const body: Record<string, unknown> = {
    chat_id: reply.chatId, text: clip(reply.text, 'telegram'),
    reply_parameters: { message_id: Number(reply.inboundMessageId), allow_sending_without_reply: true },
    ...(reply.threadId ? { message_thread_id: Number(reply.threadId) } : {}),
  };
  const r = await brokeredFetch(
    { storage, tenantId: reply.tenantId, runId: correlation(reply), actingUserId: reply.actingUserId },
    { provider: 'telegram', url: `${TELEGRAM_BASE()}/bot{credential}/sendMessage`, method: 'POST', body: JSON.stringify(body), credentialInPath: true, connectionId: conn.connectionId },
  );
  if (r.outcome !== 'sent') return { sent: false, error: `telegram_${r.outcome}` };
  const json = (await r.res.json().catch(() => ({}))) as { ok?: boolean; result?: { message_id?: number } };
  return json.ok && json.result?.message_id !== undefined ? { sent: true, providerRef: String(json.result.message_id) } : { sent: false, error: `telegram_rejected_${r.res.status}` };
}

async function sendDiscord(storage: Storage, reply: ChannelReply): Promise<ReplyTransportResult> {
  const conn = connectionOf(reply);
  if (!conn) return { sent: false, error: 'wrong_lane' };
  const r = await brokeredFetch(
    { storage, tenantId: reply.tenantId, runId: correlation(reply), actingUserId: reply.actingUserId },
    {
      provider: 'discord', url: `${DISCORD_BASE()}/api/v10/channels/${encodeURIComponent(reply.chatId)}/messages`, method: 'POST',
      // No mention pings from model text.
      body: JSON.stringify({ content: clip(reply.text, 'discord'), allowed_mentions: { parse: [] } }),
      authScheme: 'bot', connectionId: conn.connectionId,
    },
  );
  if (r.outcome !== 'sent') return { sent: false, error: `discord_${r.outcome}` };
  const json = (await r.res.json().catch(() => ({}))) as { id?: string };
  return r.res.status >= 200 && r.res.status < 300 && json.id ? { sent: true, providerRef: json.id } : { sent: false, error: `discord_rejected_${r.res.status}` };
}

async function sendSlack(storage: Storage, reply: ChannelReply): Promise<ReplyTransportResult> {
  const conn = connectionOf(reply);
  if (!conn) return { sent: false, error: 'wrong_lane' };
  const slack = makeSlackAdapter({ storage, tenantId: reply.tenantId, runId: correlation(reply), actingUserId: reply.actingUserId, connectionId: conn.connectionId });
  const r = await slack.postMessage({ channel: reply.chatId, text: clip(reply.text, 'slack'), ...(reply.threadId ? { threadTs: reply.threadId } : {}) });
  return r.ok ? { sent: true, providerRef: r.ts ?? '' } : { sent: false, error: r.error ?? 'slack_post_failed' };
}

async function sendRelay(storage: Storage, reply: ChannelReply): Promise<ReplyTransportResult> {
  if (reply.lane.kind !== 'relay') return { sent: false, error: 'wrong_lane' };
  const device = await storage.getRelayDevice(reply.lane.relayId);
  // The device must still be this tenant's and live; the reply goes to the chat it came from.
  if (!device || device.tenantId !== reply.tenantId || device.status === 'revoked') return { sent: false, error: 'relay_unavailable' };
  const egress = await enqueueOutbound(storage, device.relayId, {
    channel: device.channel as RelayChannel, conversationId: reply.chatId, text: clip(reply.text, 'relay'), replyToMessageId: reply.inboundMessageId,
  });
  return { sent: true, providerRef: egress.egressId };
}

export function registerChannelReplyTransports(storage: Storage): void {
  registerReplyTransport('telegram', (r) => sendTelegram(storage, r));
  registerReplyTransport('discord', (r) => sendDiscord(storage, r));
  registerReplyTransport('slack', (r) => sendSlack(storage, r));
  registerReplyTransport('relay', (r) => sendRelay(storage, r));
}

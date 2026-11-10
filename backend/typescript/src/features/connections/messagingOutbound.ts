/**
 * Messaging outbound (ADR 0175 deferred follow-on) — the seam for sending a reply/
 * result BACK to a chat platform (Slack/Discord/Telegram), plus the connection↔channel
 * pairing store `/pair` records.
 *
 * Delivery is inherently operator-last-mile (it needs the live bot token via Connections
 * egress), so this is a PLUGGABLE TRANSPORT: tests inject a mock; a deployment wires the
 * real HTTP transport (brokered egress to the platform API, token host-side). The pairing
 * + routing logic — the net-new host code — is fully implemented + testable here.
 */
import { createHash } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { egressLedgerKey, priorSend, recordSend, releaseSend, reserveSend } from '../../host/egressSentLedger.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('connections.messagingOutbound');

/** The WhatsApp members (ADR 0394): the pairing binds a connection to the
 *  tenant's WhatsApp SENDER — `channelId` = the E.164 number (Twilio BSP) or
 *  the Meta phone-number id (Cloud API). Sends flow through the whatsapp
 *  feature's governed service, not the chat-reply transport. */
export type OutboundProvider = 'slack' | 'discord' | 'telegram' | 'whatsapp-twilio' | 'whatsapp-cloud';
export interface OutboundMessage { connectionId: string; provider: OutboundProvider; channelId: string; text: string }
/** A transport delivers one message to the platform. Returns whether it was sent. */
export type OutboundTransport = (msg: OutboundMessage) => Promise<boolean>;

let transport: OutboundTransport | null = null;
/** Wire the delivery transport (a deployment sets the real brokered-egress one; unwired ⇒
 *  no-op so the reference host degrades honestly without a bot token). */
export function setMessagingTransport(t: OutboundTransport | null): void { transport = t; }

/** The connection↔channel pairing `/pair` establishes, so async results route back. */
export interface Pairing { connectionId: string; provider: OutboundProvider; channelId: string; linkedAt: string }
const pairings = new DurableCollection<Pairing>('connections:pairing', (p) => p.connectionId);

export async function pairConnection(connectionId: string, provider: OutboundProvider, channelId: string): Promise<Pairing> {
  const pairing: Pairing = { connectionId, provider, channelId, linkedAt: new Date().toISOString() };
  await pairings.put(pairing);
  return pairing;
}
export async function getPairing(connectionId: string): Promise<Pairing | null> {
  return pairings.get(connectionId);
}
export async function unpair(connectionId: string): Promise<boolean> {
  return pairings.delete(connectionId);
}

/**
 * Send an outbound message to a paired connection's channel. Returns `delivered` (false
 * when no pairing or no transport is wired — an honest no-op, never a throw).
 */
export async function sendOutbound(connectionId: string, text: string): Promise<{ delivered: boolean; reason?: 'no_pairing' | 'no_transport' }> {
  const pairing = await getPairing(connectionId);
  if (!pairing) return { delivered: false, reason: 'no_pairing' };
  if (!transport) return { delivered: false, reason: 'no_transport' };
  try {
    const ok = await transport({ connectionId, provider: pairing.provider, channelId: pairing.channelId, text });
    return { delivered: ok };
  } catch {
    return { delivered: false, reason: 'no_transport' };
  }
}

// ── ADR 1042 D4 (CHAN-P0-4) — the channel REPLY transport ──────────────────
//
// One entry point for "answer the message that just arrived": per-provider
// transports registered by whoever owns the provider (the channel-ingress
// feature for telegram/discord/slack/relay, the whatsapp feature for its two
// BSP lanes — connections never imports a feature). Every send is keyed in the
// ADR 0619 send ledger on (lane, inbound message id), so a retried or
// re-settled turn sends once, and it goes ONLY to the chat it came from.

/** Where a channel message came from — the reply goes back exactly there. */
export type ChannelLane =
  | { kind: 'connection'; connectionId: string; provider: string }
  | { kind: 'relay'; relayId: string; channel: string };

export interface ChannelReply {
  tenantId: string;
  lane: ChannelLane;
  /** The platform chat the inbound message arrived in. */
  chatId: string;
  /** A thread inside that chat (Slack `thread_ts`, Telegram topic), when any. */
  threadId?: string;
  /** The inbound platform message id (dedup key; quoted when the platform can). */
  inboundMessageId: string;
  text: string;
  /** The paired owner the reply is sent as (the broker resolves THEIR access). */
  actingUserId: string;
}

export type ReplyTransportResult = { sent: true; providerRef: string } | { sent: false; error: string };
export type ReplyTransport = (reply: ChannelReply) => Promise<ReplyTransportResult>;

const replyTransports = new Map<string, ReplyTransport>();
const laneProvider = (lane: ChannelLane): string => (lane.kind === 'relay' ? 'relay' : lane.provider);
const laneKeyOf = (lane: ChannelLane): string => (lane.kind === 'relay' ? `relay:${lane.relayId}` : `conn:${lane.connectionId}`);

/** Register the transport for one provider (`relay` for the device lane). Idempotent per boot. */
export function registerReplyTransport(provider: string, fn: ReplyTransport): void {
  replyTransports.set(provider, fn);
}

export interface ChannelReplyOutcome { delivered: boolean; deduped?: boolean; providerRef?: string; reason?: string }

/** Send one reply. Never throws: every failure is a typed `reason`, logged with ids only. */
export async function sendChannelReply(reply: ChannelReply): Promise<ChannelReplyOutcome> {
  const provider = laneProvider(reply.lane);
  const fn = replyTransports.get(provider);
  if (!fn) return { delivered: false, reason: 'no_transport' };
  if (!reply.text.trim()) return { delivered: false, reason: 'empty' };
  // Security review H1 — a platform message id can be unique only within ONE chat
  // (Telegram `message_id`, a relay id), so the chat and thread are part of the key.
  const idem = createHash('sha256').update(`reply\u0000${laneKeyOf(reply.lane)}\u0000${reply.chatId}\u0000${reply.threadId ?? ''}\u0000${reply.inboundMessageId}`).digest('hex');
  const key = egressLedgerKey(reply.tenantId, 'chat', idem);
  const prior = await priorSend(key);
  if (prior) return { delivered: true, deduped: true, providerRef: prior.providerRef };
  const rec = { key, tenantId: reply.tenantId, channel: 'chat' as const, provider: `channel:${provider}`, providerRef: '', createdAt: new Date().toISOString() };
  if ((await reserveSend(rec)) === 'duplicate') return { delivered: true, deduped: true, providerRef: (await priorSend(key))?.providerRef ?? '' };
  let result: ReplyTransportResult;
  try {
    result = await fn(reply);
  } catch (err) {
    result = { sent: false, error: err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'transport_threw' };
  }
  if (!result.sent) {
    await releaseSend(key); // put-on-accept: a failed send can be retried
    log.warn('channel reply not sent', { tenantId: reply.tenantId, lane: laneKeyOf(reply.lane), provider, reason: result.error });
    return { delivered: false, reason: result.error };
  }
  await recordSend({ ...rec, providerRef: result.providerRef });
  return { delivered: true, providerRef: result.providerRef };
}

export async function __resetMessagingOutbound(): Promise<void> {
  await pairings.__clear();
  transport = null;
}

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
import { DurableCollection } from '../../host/hostExtPersistence.js';

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

export async function __resetMessagingOutbound(): Promise<void> {
  await pairings.__clear();
  transport = null;
}

/**
 * ADR 0853 D4 — the seam a feature uses to hear an inbound Slack / Discord /
 * Telegram / WhatsApp message on a connection that is linked to a project,
 * without the connections feature importing it. Inbound messages are not stored
 * as chat messages (they start or resume runs), so this is the only place one
 * can be noticed.
 *
 * Announced from inside the delivery's dedup wrapper (a provider retry never
 * announces twice) and fail-soft: an observer never blocks the delivery.
 */
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.inboundMessageObservers');

export interface InboundMessage {
  tenantId: string;
  connectionId: string;
  provider: string;
  projectId: string;
  /** The message text, as the provider sent it (untrusted). */
  text: string;
  /** Stable per message: the provider event id, else the delivery id. */
  ref: string;
}

type Observer = (m: InboundMessage) => Promise<void>;
const observers: Observer[] = [];

export function registerInboundMessageObserver(fn: Observer): void { observers.push(fn); }

export async function notifyInboundMessage(m: InboundMessage): Promise<void> {
  for (const fn of observers) {
    try { await fn(m); } catch (err) {
      log.warn('inbound_message_observer_failed', { provider: m.provider, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);
const s = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined);

/** The human text of a provider's inbound payload, when it has one. */
export function inboundText(provider: string, body: unknown): string | undefined {
  if (!isObj(body)) return undefined;
  switch (provider) {
    // The handler passes Slack's `event` object itself; accept the raw callback too.
    case 'slack': return s(body.text) ?? (isObj(body.event) ? s(body.event.text) : undefined);
    case 'telegram': return isObj(body.message) ? s(body.message.text) : isObj(body.channel_post) ? s(body.channel_post.text) : undefined;
    case 'discord': return s(body.content) ?? (isObj(body.d) ? s(body.d.content) : undefined);
    case 'whatsapp-twilio': return s(body.Body);
    default: return undefined;
  }
}

/**
 * ADR 0825 P1 / RFC 0236 §B–§D — the live side of `/host/events` (SSE).
 *
 * Modelled on the v2 reference host (`openwop-examples` `host-events.ts`):
 *
 *   - tenant scope (§D): a frame reaches only subscribers of the event's tenant;
 *   - ephemeral (§C): never retained, framed WITHOUT `id:`, never replayed;
 *   - durable (§C): framed with `id:` = `eventId`, kept in a bounded per-process
 *     ring so `Last-Event-ID` resumes (a SHOULD, "within retention").
 *
 * The one departure from the reference host is cross-instance fan-out: this
 * host runs several Cloud Run instances, so an event emitted on instance A must
 * reach an SSE client held by instance B. Publication rides the storage pub/sub
 * (`Storage.publish/subscribe`: Postgres LISTEN/NOTIFY across instances, an
 * in-process emitter on sqlite/memory), the same seam the Kanban board feed
 * uses. Every instance that has subscribed receives every event and retains the
 * durable ones, so a resume on any such instance finds the id. Retention is
 * in memory and per process: an instance started after an event cannot replay
 * it (recorded in ADR 0825 §Implementation record).
 *
 * The heartbeat on this channel is the shared SSE keep-alive comment
 * (`: heartbeat`), which carries no `id:` and is not an event.
 */

import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';
import type { HostEventEnvelope } from './hostEventTypes.js';

const log = createLogger('host.hostEventStream');

/** The storage pub/sub channel. Host-private; never on the wire. */
const CHANNEL = 'hostext:host-events:v2';
/** Durable events kept for `Last-Event-ID` resumption, per process. */
const RETAINED = 1000;
/** Postgres NOTIFY refuses payloads at 8000 bytes; stay under it. */
const NOTIFY_MAX_BYTES = 7900;

interface Subscriber { readonly tenantId: string; readonly write: (frame: string) => void }

const subscribers = new Set<Subscriber>();
const retained: Array<{ tenantId: string; event: HostEventEnvelope }> = [];
let subscribedTo: Storage | null = null;
let subscribing: Promise<void> | null = null;

/** The SSE frame: `event:` the type, `id:` only for a durable event, `data:` the envelope. */
export function hostEventFrame(event: HostEventEnvelope): string {
  return `event: ${event.type}\n${event.delivery === 'durable' ? `id: ${event.eventId}\n` : ''}data: ${JSON.stringify(event)}\n\n`;
}

/** Local delivery: write to this process's subscribers of the tenant, and retain if durable. */
function deliverLocally(tenantId: string, event: HostEventEnvelope): void {
  if (event.delivery === 'durable') {
    retained.push({ tenantId, event });
    if (retained.length > RETAINED) retained.splice(0, retained.length - RETAINED);
  }
  const frame = hostEventFrame(event);
  for (const s of subscribers) {
    if (s.tenantId !== tenantId) continue;
    try { s.write(frame); } catch { /* a dead socket is torn down by its own close handler */ }
  }
}

/**
 * Subscribe this process to the cross-instance channel once. Idempotent; a
 * second storage (tests that open a fresh app) re-subscribes against it.
 */
export async function ensureHostEventStreamSubscribed(storage: Storage): Promise<void> {
  if (subscribedTo === storage) return;
  if (subscribing) { await subscribing; if (subscribedTo === storage) return; }
  subscribing = (async () => {
    await storage.subscribe(CHANNEL, (payload) => {
      try {
        const msg = JSON.parse(payload) as { tenantId?: unknown; event?: HostEventEnvelope };
        if (typeof msg.tenantId === 'string' && msg.event && typeof msg.event.type === 'string') deliverLocally(msg.tenantId, msg.event);
      } catch { /* skip malformed */ }
    });
    subscribedTo = storage;
  })().finally(() => { subscribing = null; });
  // The clear is CHAINED onto the latch (#3056 tripwire shape): a failed attempt
  // never leaves `subscribing` set, so the next call retries instead of waiting forever.
  await subscribing;
}

/**
 * Publish one host event for `tenantId`. Through the storage pub/sub when this
 * process is subscribed (so every instance, this one included, delivers it
 * exactly once); locally otherwise, or when the payload is too large for NOTIFY.
 * Never throws: a stream failure must not fail the emitting write.
 */
export async function publishHostEventToStream(storage: Storage | null, tenantId: string, event: HostEventEnvelope): Promise<void> {
  try {
    const payload = JSON.stringify({ tenantId, event });
    if (storage !== null && subscribedTo === storage && Buffer.byteLength(payload, 'utf8') <= NOTIFY_MAX_BYTES) {
      await storage.publish(CHANNEL, payload);
      return;
    }
    if (storage !== null && subscribedTo === storage) log.warn('host_event_stream_payload_too_large', { type: event.type, bytes: Buffer.byteLength(payload, 'utf8') });
    deliverLocally(tenantId, event);
  } catch (err) {
    log.warn('host_event_stream_publish_failed', { type: event.type, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Attach a subscriber for `tenantId`. With a `Last-Event-ID` naming a retained
 * durable event of THIS tenant, the tenant's durable events after it are
 * written first; an ephemeral event is never among them, because it was never
 * retained. An id this process does not hold resumes from live (the SHOULD is
 * "within retention"). Returns the detach function.
 */
export function attachHostEventSubscriber(tenantId: string, write: (frame: string) => void, lastEventId: string | null): () => void {
  if (lastEventId !== null && lastEventId.length > 0) {
    const at = retained.findIndex((r) => r.tenantId === tenantId && r.event.eventId === lastEventId);
    if (at >= 0) for (const r of retained.slice(at + 1)) if (r.tenantId === tenantId) write(hostEventFrame(r.event));
  }
  const sub: Subscriber = { tenantId, write };
  subscribers.add(sub);
  return () => { subscribers.delete(sub); };
}


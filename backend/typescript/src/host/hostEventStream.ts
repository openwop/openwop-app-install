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
 *
 * ADR 0973 (RFC 0250), once the wire is on (`rfc0250WireAvailable`): durable
 * events are also appended to the durable log (`host/hostEventLog.ts`), the
 * NOTIFY carries the log sequence and drops the body when it is too large, and
 * a receiving instance reads such an event from the log, so oversized events
 * reach every instance. `?replay=required` resumes from the log through
 * `attachHostEventReplaySubscriber`. Without the wire, all of this is inert and
 * the stream behaves exactly as before.
 */

import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';
import type { HostEventEnvelope } from './hostEventTypes.js';
import { hostEventsAfter, loggedHostEvent, rfc0250WireAvailable } from './hostEventLog.js';

const log = createLogger('host.hostEventStream');

/** The storage pub/sub channel. Host-private; never on the wire. */
const CHANNEL = 'hostext:host-events:v2';
/** Durable events kept for `Last-Event-ID` resumption, per process. */
const RETAINED = 1000;
/** Postgres NOTIFY refuses payloads at 8000 bytes; stay under it. */
const NOTIFY_MAX_BYTES = 7900;

/** `deliver` gets the frame and, for a durable event, its id (a replay
 *  subscriber deduplicates on it; ADR 0973 D4). */
interface Subscriber { readonly tenantId: string; readonly deliver: (frame: string, durableId: string | null) => void }

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
  const durableId = event.delivery === 'durable' ? event.eventId : null;
  for (const s of subscribers) {
    if (s.tenantId !== tenantId) continue;
    try { s.deliver(frame, durableId); } catch { /* a dead socket is torn down by its own close handler */ }
  }
}

/**
 * ADR 0973 D3 — with the wire on, each instance delivers a tenant's incoming
 * events through one serial queue, so an oversized event being fetched from the
 * log is never overtaken by a later, smaller one. Sequential emits keep their
 * order; concurrent ones have none (RFC 0250, 7a's ruling).
 */
const tenantQueues = new Map<string, Promise<void>>();

function deliverInOrder(tenantId: string, resolve: () => Promise<HostEventEnvelope | null>): void {
  const run = (tenantQueues.get(tenantId) ?? Promise.resolve()).then(async () => {
    const event = await resolve();
    if (event) deliverLocally(tenantId, event);
  }).catch((err) => {
    log.warn('host_event_stream_deliver_failed', { error: err instanceof Error ? err.message : String(err) });
  });
  tenantQueues.set(tenantId, run);
  void run.finally(() => { if (tenantQueues.get(tenantId) === run) tenantQueues.delete(tenantId); });
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
        const msg = JSON.parse(payload) as { tenantId?: unknown; event?: HostEventEnvelope; seq?: unknown };
        if (typeof msg.tenantId !== 'string') return;
        const tenantId = msg.tenantId;
        const event = msg.event && typeof msg.event.type === 'string' ? msg.event : null;
        if (!rfc0250WireAvailable()) {
          if (event) deliverLocally(tenantId, event);
          return;
        }
        const seq = typeof msg.seq === 'number' ? msg.seq : null;
        if (event) deliverInOrder(tenantId, async () => event);
        else if (seq !== null) deliverInOrder(tenantId, () => loggedHostEvent(tenantId, seq));
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
 *
 * `seq` is the event's log sequence (ADR 0973 D3), present only once the wire
 * is on and the append succeeded. With it, an oversized event is published
 * without its body and every instance reads it from the log.
 */
/**
 * ADR 0988 D2 — would publishing `event` WITHOUT a log sequence reach this
 * process's subscribers only? True when this process is on the cross-instance
 * channel and the body is over NOTIFY's limit: `publishHostEventToStream` then
 * falls back to local delivery, which on a multi-instance host is a partial one.
 */
export function hostEventPublishWouldBeLocalOnly(storage: Storage | null, tenantId: string, event: HostEventEnvelope): boolean {
  if (storage === null || subscribedTo !== storage) return false;
  return Buffer.byteLength(JSON.stringify({ tenantId, event }), 'utf8') > NOTIFY_MAX_BYTES;
}

export async function publishHostEventToStream(storage: Storage | null, tenantId: string, event: HostEventEnvelope, seq: number | null = null): Promise<void> {
  try {
    const payload = JSON.stringify(seq === null ? { tenantId, event } : { tenantId, event, seq });
    if (storage !== null && subscribedTo === storage && Buffer.byteLength(payload, 'utf8') <= NOTIFY_MAX_BYTES) {
      await storage.publish(CHANNEL, payload);
      return;
    }
    if (storage !== null && subscribedTo === storage && seq !== null) {
      await storage.publish(CHANNEL, JSON.stringify({ tenantId, seq, eventId: event.eventId }));
      return;
    }
    if (storage !== null && subscribedTo === storage) log.warn('host_event_stream_payload_too_large', { type: event.type, bytes: Buffer.byteLength(payload, 'utf8') });
    deliverLocally(tenantId, event);
  } catch (err) {
    log.warn('host_event_stream_publish_failed', { type: event.type, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * ADR 0988 D1 — does this process's ring hold `eventId` for `tenantId`? The ring
 * stays the first lookup for a legacy (no `replay=required`) cursor until the log
 * path is measured no slower; a cursor it does not hold is then looked up in the
 * durable log by the route.
 */
export function hostEventRingHolds(tenantId: string, eventId: string): boolean {
  return retained.some((r) => r.tenantId === tenantId && r.event.eventId === eventId);
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
  const sub: Subscriber = { tenantId, deliver: (frame) => write(frame) };
  subscribers.add(sub);
  return () => { subscribers.delete(sub); };
}

/** How long the backlog's ids are kept for deduplication after the hand-off.
 *  A live frame for a committed event follows its commit within seconds. */
const REPLAY_DEDUPE_MS = 30_000;

/**
 * ADR 0973 D4 — attach a REPLAY subscriber for `tenantId` resuming after the
 * logged sequence `afterSeq` (already resolved by `resolveHostEventCursor`).
 *
 *  1. Attach in buffering mode, so nothing published from now on is missed.
 *  2. Write the logged backlog after `afterSeq`, recording each id written.
 *  3. Flush the buffer and switch to direct writes. Every live durable frame
 *     whose id the backlog already wrote is dropped, during the flush and for
 *     `REPLAY_DEDUPE_MS` after it.
 *
 * Deduplication is by id, not by a sequence high-water mark: a lower sequence
 * committed after the backlog read arrives live and is written once, and a
 * backlog event whose live frame arrives late is not written twice (architect
 * finding 2). The cursor is never re-emitted: the backlog starts after it.
 */
export async function attachHostEventReplaySubscriber(
  tenantId: string,
  write: (frame: string) => void,
  afterSeq: number,
): Promise<() => void> {
  let buffer: Array<{ frame: string; durableId: string | null }> | null = [];
  let written: Set<string> | null = new Set();
  const sub: Subscriber = {
    tenantId,
    deliver: (frame, durableId) => {
      if (durableId !== null && written?.has(durableId)) return;
      if (buffer !== null) buffer.push({ frame, durableId });
      else write(frame);
    },
  };
  subscribers.add(sub);
  let timer: NodeJS.Timeout | null = null;
  const detach = (): void => {
    subscribers.delete(sub);
    if (timer) clearTimeout(timer);
  };
  try {
    for await (const event of hostEventsAfter(tenantId, afterSeq)) {
      write(hostEventFrame(event));
      written.add(event.eventId);
    }
  } catch (err) {
    detach();
    throw err;
  }
  // One synchronous block: no live frame can interleave between the flush and the switch.
  const held = buffer;
  buffer = null;
  for (const b of held) if (b.durableId === null || !written.has(b.durableId)) write(b.frame);
  timer = setTimeout(() => { written = null; }, REPLAY_DEDUPE_MS);
  timer.unref?.();
  return detach;
}


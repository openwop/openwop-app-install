/**
 * Notification emitter — process-local fanout of newly-inserted
 * notifications to SSE subscribers, plus a single chokepoint helper
 * (`emitNotification`) that the executor + suspend manager call when
 * an action-needed event happens.
 *
 * Two-step shape mirrors `executor/eventLog.ts`:
 *   1. caller hands a NotificationRecord (already shaped + tenanted)
 *   2. emitter inserts into Storage then fans out to any subscribers
 *
 * Subscribers receive only their own tenant's notifications. Filtering
 * happens in the route layer so the emitter stays storage-only and
 * doesn't need to know about principal/tenant context.
 *
 * Process-local only: in a multi-instance Cloud Run deployment, a
 * notification inserted on instance A will not push to a client SSE'd
 * to instance B. The client polls `GET /v1/notifications` periodically
 * (or on tab focus) to backfill — same pattern as the run-event SSE
 * uses against the same Cloud Run service.
 */

import { randomBytes } from 'node:crypto';
import type { Storage } from '../storage/storage.js';
import type { NotificationRecord } from '../types.js';
import { pushNotification } from './webPush.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('notifications.emitter');

let backend: Storage | null = null;
const subscribers = new Set<(n: NotificationRecord) => void>();

export function setNotificationBackend(storage: Storage): void {
  backend = storage;
}

/** Input accepted by both `emit` and `signal` — the full record minus the
 *  fields the emitter fills in. `status` is overridable only on `emit`. */
type RecordInput = Omit<NotificationRecord, 'notificationId' | 'createdAt' | 'status'> & {
  notificationId?: string;
  createdAt?: string;
  status?: NotificationRecord['status'];
};

/** Single source of truth for record construction — keeps `emit` and `signal`
 *  from drifting if `NotificationRecord` gains a field. */
function buildRecord(input: RecordInput): NotificationRecord {
  return {
    notificationId: input.notificationId ?? randomBytes(16).toString('hex'),
    tenantId: input.tenantId,
    recipientUserId: input.recipientUserId,
    type: input.type,
    priority: input.priority,
    status: input.status ?? 'unread',
    title: input.title,
    message: input.message,
    runId: input.runId,
    workflowId: input.workflowId,
    nodeId: input.nodeId,
    interruptId: input.interruptId,
    actionUrl: input.actionUrl,
    metadata: input.metadata,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

/** Fan a record out to every live SSE subscriber. A subscriber throwing must
 *  not abort the emit/signal or starve the other subscribers. */
function fanOut(record: NotificationRecord): void {
  for (const sub of subscribers) {
    try { sub(record); } catch { /* subscriber failures don't abort the fanout */ }
  }
}

export function getNotificationEmitter() {
  if (!backend) throw new Error('Notification backend not installed');
  const b = backend;
  return {
    async emit(input: RecordInput): Promise<NotificationRecord> {
      const record = buildRecord(input);
      await b.insertNotification(record);
      fanOut(record);
      // Fan out to every Web Push subscription owned by the tenant.
      // Best-effort + concurrent — push delivery latency must not
      // block the emit return. `pushNotification` swallows per-sub
      // errors and prunes 404/410 endpoints on its own; PRV-6: the outer
      // `.catch` guarantees a whole-promise rejection (e.g. the subscription
      // storage read failing) can never surface as an unhandled rejection.
      void pushNotification(b, record).catch((err: unknown) => {
        log.warn('web-push fanout failed', {
          notificationId: record.notificationId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return record;
    },
    /**
     * ADR 0074 — fan out a transient frame to SSE subscribers WITHOUT
     * persisting it or web-pushing it. Used for `review.updated` cache hints
     * that should reach every connected tenant member (broadcast: omit
     * `recipientUserId`) but must never land in the durable inbox or grow
     * storage. The frame is a full `NotificationRecord` shape so the stream
     * route's tenant/recipient filter (`routes/notifications.ts`) applies
     * unchanged; the FE notification store routes signal types to the
     * review-status store instead of the inbox.
     */
    signal(input: Omit<RecordInput, 'status'>): NotificationRecord {
      // Transient: build the record, fan out to live subscribers, and return.
      // Deliberately NO `insertNotification` and NO web-push — never persisted.
      const record = buildRecord(input);
      fanOut(record);
      return record;
    },
    subscribe(fn: (n: NotificationRecord) => void): () => void {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

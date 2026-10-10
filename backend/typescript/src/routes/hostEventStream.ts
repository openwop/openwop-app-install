/**
 * ADR 0825 P1 / RFC 0236 — `GET /host/events` (`streamHostEvents`), the
 * `hostEvents` channel (`spec/v2/core/events.md` §Host events).
 *
 * NOT `routes/hostEvents.ts`: that file is the ADR 0208 host-extension
 * event→workflow BINDING admin surface under `/host/openwop-app/…`. This is the
 * protocol channel, reached at the manifest path `/host/events`, which the
 * negotiator rewrites onto its `/v1` twin with major 2 stamped.
 *
 * Served only with `OPENWOP_HOST_EVENTS_V2` on and only under major 2; in every
 * other case the handler calls `next()`, so the route answers exactly what it
 * answered before (nothing was mounted here).
 *
 * - Scope `runs:read` (RFC 0236 Unresolved question 1, decided at Active).
 * - Tenant scope (§D): the subscriber sees only its ACTIVE tenant's events. An
 *   unauthenticated caller gets the open comment and heartbeats and no events,
 *   the reference host's posture.
 * - `Last-Event-ID` (§C): resumes durable events of the caller's tenant within
 *   this process's retention; an ephemeral event is never replayed.
 * - Heartbeat: the shared `: heartbeat` comment (host/sseChannel.ts) — no `id:`.
 */
import type { Express } from 'express';
import type { Storage } from '../storage/storage.js';
import { requireProtocolScope } from '../host/protocolAuthorization.js';
import { callerSubject, tenantOf } from '../host/requestSubject.js';
import { openSseChannel } from '../host/sseChannel.js';
import { hostEventsV2Enabled } from '../host/hostEventTypes.js';
import { attachHostEventSubscriber, ensureHostEventStreamSubscribed } from '../host/hostEventStream.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('routes.hostEventStream');

export function registerHostEventStreamRoutes(app: Express, deps: { storage: Storage }): void {
  const { storage } = deps;
  // Subscribe at boot when the flag is on, so this instance retains durable
  // events for `Last-Event-ID` before its first client connects.
  if (hostEventsV2Enabled()) {
    ensureHostEventStreamSubscribed(storage).catch((err) => {
      log.warn('host_event_stream_subscribe_failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }

  app.get('/host/events', async (req, res, next) => {
    if (!hostEventsV2Enabled()) {
      next();
      return;
    }
    try {
      await requireProtocolScope(req, 'runs:read');
      await ensureHostEventStreamSubscribed(storage);
      const authenticated = callerSubject(req) !== undefined;
      const tenantId = tenantOf(req);
      const lastEventId = req.header('last-event-id') ?? null;
      const channel = openSseChannel(req, res, { heartbeatMs: 15_000 });
      if (!authenticated) return;
      const detach = attachHostEventSubscriber(tenantId, (frame) => { if (!channel.closed) res.write(frame); }, lastEventId);
      channel.onClose(detach);
    } catch (err) {
      next(err);
    }
  });
}

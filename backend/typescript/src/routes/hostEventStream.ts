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
 * - ADR 0973 / RFC 0250 `?replay=required` (only once the wire is on; otherwise
 *   the parameter is ignored, which RFC 0250 permits a non-advertising host):
 *   the cursor is resolved against the durable log BEFORE the channel opens. An
 *   unauthenticated caller, and an unknown, foreign, ephemeral or expired cursor,
 *   all get one byte-identical `409 host_event_resync_required`, with no SSE
 *   byte first. A resolvable cursor resumes from the log with no gap.
 */
import type { Express } from 'express';
import type { Storage } from '../storage/storage.js';
import { requireProtocolScope } from '../host/protocolAuthorization.js';
import { callerSubject, tenantOf } from '../host/requestSubject.js';
import { openSseChannel } from '../host/sseChannel.js';
import { hostEventsV2Enabled } from '../host/hostEventTypes.js';
import { attachHostEventReplaySubscriber, attachHostEventSubscriber, ensureHostEventStreamSubscribed, hostEventRingHolds } from '../host/hostEventStream.js';
import { resolveHostEventCursor, rfc0250WireAvailable } from '../host/hostEventLog.js';
import { sendError } from '../middleware/errorEnvelope.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('routes.hostEventStream');

/** ADR 0973 D5 — the one refusal. Every cause takes this call, so status and
 *  body are byte-identical: no cursor echo, no details, nothing that tells an
 *  unknown id from another tenant's. */
const RESYNC_MESSAGE = 'The event stream cannot resume from that position; reconnect without replay and resynchronise.';
function refuseResync(res: Parameters<typeof sendError>[0]): void {
  sendError(res, 409, 'host_event_resync_required', RESYNC_MESSAGE);
}

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
      const replay = req.query['replay'] === 'required' && rfc0250WireAvailable();
      // ADR 0973 D4 step 1–2: decided before any SSE byte. `tenantOf` answers
      // 'default' for an unauthenticated caller, so that is refused before any lookup.
      let replayAfter: number | null = null;
      if (replay && lastEventId !== null && lastEventId.length > 0) {
        replayAfter = authenticated ? await resolveHostEventCursor(tenantId, lastEventId) : null;
        if (replayAfter === null) {
          refuseResync(res);
          return;
        }
      }
      // ADR 0988 D1 — WITHOUT `replay=required`, a cursor this process's ring does
      // not hold but the durable log does (a restart, or a cursor issued by another
      // instance) resumes from the log through the same deduplicated hand-off. Every
      // cursor the log cannot resolve for this tenant (unknown, foreign, ephemeral,
      // expired, out of grammar) keeps the legacy answer: the stream opens live and
      // nothing is refused (RFC 0250 `0250.legacy-unchanged`).
      if (!replay && authenticated && lastEventId !== null && lastEventId.length > 0
        && rfc0250WireAvailable() && !hostEventRingHolds(tenantId, lastEventId)) {
        replayAfter = await resolveHostEventCursor(tenantId, lastEventId);
      }
      // An absent or empty `Last-Event-ID` with `replay=required` opens live and
      // replays nothing (7a's ruling, 2026-10-24): no position, no cursor to refuse.
      // ADR 0876: a WIRE channel (RFC 0236 `hostEvents`), never refused for the front door.
      // ADR 0897 / RFC 0247: bounded only for a consumer that sent `resumable=true`.
      const channel = openSseChannel(req, res, { heartbeatMs: 15_000, frontDoor: 'allow', boundWhen: 'resumable' });
      if (!authenticated) return;
      const write = (frame: string): void => { if (!channel.closed) res.write(frame); };
      if (replayAfter !== null) {
        const detach = await attachHostEventReplaySubscriber(tenantId, write, replayAfter);
        channel.onClose(detach);
        if (channel.closed) detach();
        return;
      }
      // Live only: with `replay=required` and no cursor there is nothing to resume.
      const detach = attachHostEventSubscriber(tenantId, write, replay ? null : lastEventId);
      channel.onClose(detach);
    } catch (err) {
      next(err);
    }
  });
}

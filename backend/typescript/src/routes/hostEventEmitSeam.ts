/**
 * RFC 0236 §G — `POST /conformance/seams/sample/host-events/emit`
 * (`emitHostEvent`), served at its v1 address and reached at the v2 one through
 * the ADR 0634 alias (`routes/conformanceSeams.ts`, `sample/` rule).
 *
 * `{ type, workspaceId? }` → `202 { eventId }`. `type` MUST be an ADVERTISED
 * host-event type; on this host that means one of the `example.*` pair, which is
 * advertised only while the seams profile is mounted AND `OPENWOP_HOST_EVENTS_V2`
 * is on (`host/hostEventTypes.ts`). The seam may also emit an advertised
 * production type, as the RFC allows; the suite drives the `example.*` ones.
 *
 * SAME PATH AS A REAL EVENT, NO SEAM BRANCH. The event is built by the same
 * `hostEventEnvelope` and handed to the same `fanOutHostEvent` that
 * `deliverHostExtEvent` calls for a CRM or CMS event: the `/host/events` stream
 * for both classes, webhooks only for a durable one, tenant-scoped throughout.
 * Nothing below knows it is a seam beyond the gate and the body parse.
 *
 * GATE. `OPENWOP_TEST_SEAM_ENABLED !== 'true'` ⇒ `404 not_found`, the route-miss
 * answer every seam here gives, so a production revision never serves it.
 *
 * `workspaceId` is refused (`400`): this host's host events carry a tenant and
 * no workspace (ADR 0825 §Implementation record, decision 3), and emitting one
 * with a workspace would put a field on the wire the production path never does.
 */
import type { Express, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import type { Storage } from '../storage/storage.js';
import { sendError } from '../middleware/errorEnvelope.js';
import { callerSubject, tenantOf } from '../host/requestSubject.js';
import { advertisedHostEventEntry, advertisedHostEventTypes, hostEventEnvelope, hostEventsV2Enabled } from '../host/hostEventTypes.js';
import { fanOutHostEvent } from './webhooks.js';

export const HOST_EVENT_EMIT_SEAM_PATH = '/host/sample/host-events/emit';

export function registerHostEventEmitSeam(app: Express, deps: { storage: Storage }): void {
  const { storage } = deps;
  app.post(HOST_EVENT_EMIT_SEAM_PATH, async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (process.env.OPENWOP_TEST_SEAM_ENABLED !== 'true') {
        sendError(res, 404, 'not_found', 'The conformance seam surface is not enabled on this host.');
        return;
      }
      const body = req.body as unknown;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        sendError(res, 400, 'validation_error', 'body must be a JSON object', { field: 'type' });
        return;
      }
      const b = body as Record<string, unknown>;
      const unknownKey = Object.keys(b).find((k) => k !== 'type' && k !== 'workspaceId');
      if (unknownKey !== undefined) {
        sendError(res, 400, 'validation_error', `unknown key ${unknownKey}`, { field: unknownKey });
        return;
      }
      if (b.workspaceId !== undefined) {
        sendError(res, 400, 'validation_error', "this host's host events carry no workspace; omit workspaceId", { field: 'workspaceId' });
        return;
      }
      const entry = typeof b.type === 'string' && hostEventsV2Enabled() ? advertisedHostEventEntry(b.type) : undefined;
      if (entry === undefined) {
        const advertised = hostEventsV2Enabled() ? advertisedHostEventTypes().filter((t) => t.type.startsWith('example.')).map((t) => t.type) : [];
        sendError(res, 400, 'validation_error', `type MUST be an advertised host-event type (${advertised.join(', ') || 'hostEvents is not advertised'})`, { field: 'type' });
        return;
      }
      if (callerSubject(req) === undefined) {
        sendError(res, 401, 'unauthenticated', 'The emit seam needs an authenticated caller; a host event belongs to a tenant.');
        return;
      }
      const envelope = hostEventEnvelope(entry, {
        eventId: `hev-${randomUUID()}`,
        timestamp: new Date().toISOString(),
        payload: { emittedBy: 'conformance-seam' },
      });
      await fanOutHostEvent(storage, tenantOf(req), envelope);
      res.status(202).json({ eventId: envelope.eventId });
    } catch (err) {
      next(err);
    }
  });
}

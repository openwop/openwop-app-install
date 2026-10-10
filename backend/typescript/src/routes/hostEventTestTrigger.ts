/**
 * RFC 0241 §B (ADR 0825) — `POST /host/events/test` (`emitTestHostEvent`): emit
 * one empty test event of a reserved `host-test.*` type to the CALLER'S tenant.
 *
 * It is the production-safe way for a client (and the conformance suite) to
 * cause a host event, so RFC 0236 is witnessable on a revision that serves no
 * seams. GitHub's `ping` and Stripe's test events are the pattern.
 *
 * - §B.1 SERVED EXACTLY WHEN LISTED: `hostEvents` is on and the type for at least
 *   one class is listed (`activeReservedEntries`, keyed on the installed
 *   contract). Otherwise `404 not_found`, the answer an unbound operation gives.
 * - §B.2 closed body `{ delivery, workspaceId? }`; an unknown key, a bad or an
 *   unlisted class is `400 validation_error`.
 * - §B.3 THE ORDINARY PATH: the same `hostEventEnvelope` → `fanOutHostEvent` that
 *   every CRM or CMS event takes (stream for both classes, webhooks only for a
 *   durable one, tenant-scoped). The §G seam uses the same two calls.
 * - §B.4 the caller's tenant only. This host's host events carry no workspace
 *   (ADR 0825 decision 3), so a `workspaceId` naming another tenant is
 *   `403 id_tenant_mismatch` and one naming the caller's is `404 not_found`: no
 *   workspace is known to the host-event channel. Never a silent drop.
 * - §B.5 rate limit: the per-IP WRITE budget (`middleware/rateLimit.ts`, 60/min
 *   by default) already applies to this POST and is tighter than reads.
 * - §B.5 `Idempotency-Key` (idempotency.md Layer 1) through the ADR 0549 ledger, the
 *   one owner `POST /runs` uses. The claim is taken AFTER validation and the tenant
 *   check, because `400 validation_error`, `401` and `403` MUST NOT be cached. The
 *   `202` and the workspace `404` are final and replay with `OpenWOP-Idempotent-Replay`.
 *   A replay never emits a second event. `v2Identity` has already refused a
 *   malformed key (`400 idempotency_key_invalid`).
 * - Scope `webhooks:manage` (decision 2): causing deliveries is a write.
 */
import type { Express, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import type { Storage } from '../storage/storage.js';
import { sendError } from '../middleware/errorEnvelope.js';
import { requireProtocolScope } from '../host/protocolAuthorization.js';
import { callerSubject, tenantOf } from '../host/requestSubject.js';
import { toWireTenant } from '../host/v2Ids.js';
import { HOST_EVENT_TEST_TRIGGER_PATH } from '../host/hostEventTestContract.js';
import { HOST_TEST_EVENT_TYPES, advertisedHostEventEntry, hostEventEnvelope, hostEventsV2Enabled } from '../host/hostEventTypes.js';
import { fanOutHostEvent } from './webhooks.js';
import {
  canonicalRequestDigest,
  idempotencyLeaseMs,
  redactKey,
  type IdempotentEndpoint,
} from '../host/idempotentResponse.js';
import { idempotencyOutcomeOf, recordIdempotencyClaim } from '../observability/metricSeams.js';
import { createLogger } from '../observability/logger.js';

const ENDPOINT: IdempotentEndpoint = 'POST:/host/events/test';
const log = createLogger('routes.hostEventTestTrigger');

type Delivery = keyof typeof HOST_TEST_EVENT_TYPES;
const listed = (d: Delivery) => (hostEventsV2Enabled() ? advertisedHostEventEntry(HOST_TEST_EVENT_TYPES[d]) : undefined);

export function registerHostEventTestTrigger(app: Express, deps: { storage: Storage }): void {
  const { storage } = deps;
  app.post(HOST_EVENT_TEST_TRIGGER_PATH, async (req: Request, res: Response, next: NextFunction) => {
    let held: { tenantId: string; key: string; claimToken: string } | undefined;
    try {
      if (listed('durable') === undefined && listed('ephemeral') === undefined) {
        sendError(res, 404, 'not_found', 'This host lists no host-test.* type, so it serves no test trigger (RFC 0241 §B.1).');
        return;
      }
      if (callerSubject(req) === undefined) {
        sendError(res, 401, 'unauthenticated', 'A host event belongs to a tenant; the test trigger needs an authenticated caller.');
        return;
      }
      await requireProtocolScope(req, 'webhooks:manage');
      const body = req.body as unknown;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        sendError(res, 400, 'validation_error', 'body must be a JSON object', { field: 'delivery' });
        return;
      }
      const b = body as Record<string, unknown>;
      const unknownKey = Object.keys(b).find((k) => k !== 'delivery' && k !== 'workspaceId');
      if (unknownKey !== undefined) {
        sendError(res, 400, 'validation_error', `unknown key ${unknownKey}`, { field: unknownKey });
        return;
      }
      if (b.delivery !== 'durable' && b.delivery !== 'ephemeral') {
        sendError(res, 400, 'validation_error', 'delivery MUST be durable or ephemeral', { field: 'delivery' });
        return;
      }
      const entry = listed(b.delivery);
      if (entry === undefined) {
        sendError(res, 400, 'validation_error', `${HOST_TEST_EVENT_TYPES[b.delivery]} is not listed in hostEvents.types`, { field: 'delivery' });
        return;
      }
      const tenantId = tenantOf(req);
      if (b.workspaceId !== undefined) {
        if (typeof b.workspaceId !== 'string' || b.workspaceId.length === 0) {
          sendError(res, 400, 'validation_error', 'workspaceId MUST be a non-empty string', { field: 'workspaceId' });
          return;
        }
        if (!b.workspaceId.startsWith(`${toWireTenant(tenantId)}/`)) {
          sendError(res, 403, 'id_tenant_mismatch', "workspaceId's tenant segment MUST be the caller's.", { field: 'workspaceId' });
          return;
        }
      }

      const key = req.header('idempotency-key') ?? undefined;
      if (key) {
        const claim = await storage.claimIdempotentResponse({
          tenantId,
          endpoint: ENDPOINT,
          key,
          requestDigest: canonicalRequestDigest(b, ENDPOINT),
          createdAt: new Date().toISOString(),
          leaseMs: idempotencyLeaseMs(),
        });
        recordIdempotencyClaim(ENDPOINT, idempotencyOutcomeOf(claim));
        if (claim.outcome === 'mismatch') {
          sendError(res, 409, 'idempotency_key_mismatch', 'Idempotency-Key was previously used with a different request body.');
          return;
        }
        if (claim.outcome === 'in-flight') {
          res.set('Retry-After', '1');
          sendError(res, 409, 'idempotency_in_flight', 'A request with this Idempotency-Key is in flight.');
          return;
        }
        if (claim.outcome === 'replay') {
          res.status(claim.responseStatus).set('OpenWOP-Idempotent-Replay', 'true').type('application/json').send(claim.responseBody);
          return;
        }
        held = { tenantId, key, claimToken: claim.claimToken };
      }
      // Answer (and, under a key, record) one final response.
      const finish = async (status: number, body: Record<string, unknown>): Promise<void> => {
        if (held) {
          await storage.completeIdempotentResponse({
            tenantId: held.tenantId,
            endpoint: ENDPOINT,
            key: held.key,
            responseStatus: status,
            responseBody: JSON.stringify(body),
            updatedAt: new Date().toISOString(),
            claimToken: held.claimToken,
          });
          held = undefined; // committed: the finally must not release it
        }
        res.status(status).json(body);
      };

      if (b.workspaceId !== undefined) {
        await finish(404, {
          error: 'not_found',
          message: "This host's host events carry no workspace, so no workspace is known to the host-event channel.",
          details: { field: 'workspaceId' },
        });
        return;
      }
      // §A.1: a test event carries an empty payload.
      const envelope = hostEventEnvelope(entry, { eventId: `hev-${randomUUID()}`, timestamp: new Date().toISOString(), payload: {} });
      await fanOutHostEvent(storage, tenantId, envelope);
      await finish(202, { eventId: envelope.eventId, type: envelope.type });
    } catch (err) {
      next(err);
    } finally {
      if (held) {
        const { tenantId, key, claimToken } = held;
        await storage
          .releaseIdempotentResponse({ tenantId, endpoint: ENDPOINT, key, claimToken })
          .catch((e: unknown) => log.warn('idempotency_release_failed', { key: redactKey(key), error: e instanceof Error ? e.message : String(e) }));
      }
    }
  });
}

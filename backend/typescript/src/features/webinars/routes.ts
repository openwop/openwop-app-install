/**
 * Webinars feature routes (ADR 0404 §a) — host-extension, authed org-scoped
 * operator surface: manage marketing events, bind a registration form, and
 * trigger a backfill sync. The Zoom CONNECTION + its inbound webhook config are
 * owned by the connections feature (setInboundConfig with provider
 * `zoom-webinar`) — no webhook route here. The public inbound webhook rides the
 * shared `connections-inbound/:connectionId` seam.
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireString, optionalString } from '../featureRoute.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import {
  listMarketingEvents, getMarketingEvent, upsertMarketingEvent, bindFormToEvent,
} from './entities/marketingEvent.js';
import { computeEventCountsBatch, syncEvent } from './webinarSyncService.js';
import { getForm } from '../forms/formsService.js';
import { listPendingPushes, deletePendingPush, pendingPushCounts, drainOrder, recordPushFailure, ensurePendingId, maskEmail } from './pendingPush.js';
import { makeWebinarAdapter } from './host/webinarAdapter.js';
import { getConnection } from '../connections/connectionsService.js';

const FEATURE = { toggleId: 'webinars', label: 'Webinars' };
const ORG = '/host/openwop-app/webinars/orgs/:orgId';

type Scope = 'workspace:read' | 'workspace:write';

export function registerWebinarsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const authz = (req: Request, scope: Scope) => authorizeOrgScope(req, FEATURE, scope);

  app.get(`${ORG}/events`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const events = await listMarketingEvents(tenantId, orgId);
      // ONE prefix scan for all events' counts, not one per event (grade-code WEB-1).
      const countsByPid = await computeEventCountsBatch(tenantId, orgId);
      // R2 WB-SP-2 — registrations the sink could not push to the provider.
      const pendingByEvent = await pendingPushCounts(tenantId, orgId);
      const zero = { registrantCount: 0, attendeeCount: 0, noShowCount: 0 };
      const withCounts = events.map((e) => ({ ...e, counts: countsByPid.get(e.providerEventId) ?? zero, pendingPushCount: pendingByEvent.get(e.eventId) ?? 0 }));
      res.json({ events: withCounts });
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/events`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      // ADR 1054 D1 — pushes are pinned to this connection, so it must be a live Zoom
      // webinar connection of THIS client or of the whole workspace — never another
      // client's (it was stored unchecked).
      // Zoom is the only provider the adapter, the surface and the webhook speak.
      const provider = optionalString(body.provider) ?? 'zoom';
      if (provider !== 'zoom') throw new OpenwopError('validation_error', 'provider must be "zoom".', 400, { field: 'provider' });
      const connectionId = optionalString(body.connectionId);
      if (connectionId) {
        const conn = await getConnection(tenantId, connectionId);
        const usable = !!conn && conn.provider === 'zoom-webinar' && conn.status === 'active'
          && (conn.orgId !== undefined ? conn.orgId === orgId : conn.userId === undefined);
        if (!usable) {
          throw new OpenwopError('validation_error', 'connectionId must be an active Zoom webinar connection of this client or of the workspace.', 400, { field: 'connectionId' });
        }
      }
      const event = await upsertMarketingEvent({
        tenantId,
        orgId,
        provider,
        providerEventId: requireString(body.providerEventId, 'providerEventId'),
        ...(optionalString(body.title) ? { title: optionalString(body.title) } : {}),
        ...(optionalString(body.startsAt) ? { startsAt: optionalString(body.startsAt) } : {}),
        ...(connectionId ? { connectionId, replaceConnection: true } : {}),
        ...(optionalString(body.journeyId) ? { journeyId: optionalString(body.journeyId) } : {}),
      });
      res.status(201).json(event);
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/events/:eventId/bind-form`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const event = await getMarketingEvent(tenantId, orgId, req.params.eventId);
      if (!event) throw new OpenwopError('not_found', 'Event not found.', 404, {});
      const formId = requireString(body.formId, 'formId');
      // WEB-G1 — the binding was accepted for ANY string. A form id that does not
      // exist bound cleanly, the dashboard showed "Form bound", and no registrant
      // ever arrived: the submission sink resolves bindings from the real form's
      // id, so the binding was a permanent silent no-op that reported success.
      // Refuse instead. (The `onFormDeleted` prune hook already assumes a binding
      // names a real form.)
      if (!(await getForm(tenantId, orgId, formId))) {
        throw new OpenwopError('not_found', 'No form with that id in this workspace.', 404, { field: 'formId', formId });
      }
      await bindFormToEvent(tenantId, orgId, formId, event.eventId, event.connectionId);
      await upsertMarketingEvent({ tenantId, orgId, provider: event.provider, providerEventId: event.providerEventId, formId });
      res.json({ ok: true, eventId: event.eventId, formId });
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/events/:eventId/sync`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const event = await getMarketingEvent(tenantId, orgId, req.params.eventId);
      if (!event) throw new OpenwopError('not_found', 'Event not found.', 404, {});
      const brokerDeps = { storage: hostExtStorage(), tenantId, runId: `hostext:webinar-sync:${event.eventId}`, actingUserId: user.userId, orgId };
      const out = await syncEvent(brokerDeps, tenantId, orgId, event);
      res.json(out);
    } catch (err) { next(err); }
  });

  // R2 WB-SP-2 — drain the pending registrant-push queue with a REAL acting
  // user (the sink has none, so its pushes fail-closed forever). Successes
  // leave the queue; failures stay with the reason returned.
  app.post(`${ORG}/events/:eventId/push-registrants`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const event = await getMarketingEvent(tenantId, orgId, req.params.eventId);
      if (!event) throw new OpenwopError('not_found', 'Event not found.', 404, {});
      // review Minor 5 — cap the batch: one provider call per row in one HTTP
      // request; successes delete their rows, so a re-click resumes.
      const queue = drainOrder(await listPendingPushes(tenantId, orgId, event.eventId)).slice(0, 50);
      const adapter = makeWebinarAdapter({ storage: hostExtStorage(), tenantId, runId: `hostext:webinar-push:${event.eventId}`, actingUserId: user.userId, orgId }, event.connectionId);
      let pushed = 0;
      const failures: Array<{ email: string; reason: string }> = [];
      for (const p of queue) {
        const [first, ...rest] = (p.name ?? '').split(' ');
        // ADR 1054 review — one row's throw (the egress firewall throws) must not 500 the
        // batch after earlier rows already left the queue: it is that row's failure.
        const out = await adapter.registerRegistrant(p.providerEventId, { email: p.email, ...(first ? { firstName: first } : {}), ...(rest.length ? { lastName: rest.join(' ') } : {}) })
          .catch((err: unknown) => ({ ok: false as const, error: err instanceof OpenwopError ? err.code : 'request_failed' }));
        if (out.ok) { await deletePendingPush(tenantId, event.eventId, p.email); pushed += 1; }
        else { await recordPushFailure(p, out.error); failures.push({ email: p.email, reason: out.error }); } // stays queued, with its reason
      }
      res.json({ pushed, failed: failures.length, failures: failures.slice(0, 10) });
    } catch (err) { next(err); }
  });

  // ADR 1054 review (WEB86-14) — WHO is waiting and why: masked emails, Zoom's last answer,
  // attempts. A row Zoom keeps refusing would otherwise sit behind a count forever.
  app.get(`${ORG}/events/:eventId/pending`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const event = await getMarketingEvent(tenantId, orgId, req.params.eventId);
      if (!event) throw new OpenwopError('not_found', 'Event not found.', 404, {});
      const rows = drainOrder(await listPendingPushes(tenantId, orgId, event.eventId));
      const shown = rows.slice(0, 100);
      const items = [];
      for (const r of shown) {
        // The name the registrant gave (the CRM shows it to the same members) tells two
        // people apart; the email stays masked.
        items.push({ pendingId: await ensurePendingId(r), email: maskEmail(r.email), ...(r.name ? { name: r.name } : {}), queuedAt: r.queuedAt, attempts: r.attempts ?? 0, ...(r.lastError ? { lastError: r.lastError } : {}) });
      }
      res.json({ total: rows.length, items });
    } catch (err) { next(err); }
  });

  // ... and the way out: remove one queued registrant (they stay registered in the CRM;
  // only the pending Zoom push is dropped). Audited without the email.
  app.post(`${ORG}/events/:eventId/pending/:pendingId/remove`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const event = await getMarketingEvent(tenantId, orgId, req.params.eventId);
      if (!event) throw new OpenwopError('not_found', 'Event not found.', 404, {});
      const row = (await listPendingPushes(tenantId, orgId, event.eventId)).find((r) => r.pendingId !== undefined && r.pendingId === req.params.pendingId);
      if (!row) throw new OpenwopError('not_found', 'That registrant is no longer queued.', 404, {});
      await deletePendingPush(tenantId, event.eventId, row.email);
      try {
        void hostExtStorage()
          .appendAudit({ timestamp: new Date().toISOString(), principalId: user.userId, action: 'webinars.pending-push.removed', resource: `webinars:event:${event.eventId}`, outcome: 'success', payload: { tenantId, orgId, attempts: row.attempts ?? 0, ...(row.lastError ? { lastError: row.lastError } : {}) } })
          .catch(() => undefined);
      } catch { /* storage unwired (unit tests) */ }
      res.json({ removed: true });
    } catch (err) { next(err); }
  });
}

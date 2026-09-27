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
import { listPendingPushes, deletePendingPush, pendingPushCounts } from './pendingPush.js';
import { makeWebinarAdapter } from './host/webinarAdapter.js';

const FEATURE = { toggleId: 'webinars', label: 'Webinars' };
const ORG = '/v1/host/openwop-app/webinars/orgs/:orgId';

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
      const event = await upsertMarketingEvent({
        tenantId,
        orgId,
        provider: optionalString(body.provider) ?? 'zoom',
        providerEventId: requireString(body.providerEventId, 'providerEventId'),
        ...(optionalString(body.title) ? { title: optionalString(body.title) } : {}),
        ...(optionalString(body.startsAt) ? { startsAt: optionalString(body.startsAt) } : {}),
        ...(optionalString(body.connectionId) ? { connectionId: optionalString(body.connectionId) } : {}),
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
      const queue = (await listPendingPushes(tenantId, orgId, event.eventId)).slice(0, 50);
      const adapter = makeWebinarAdapter({ storage: hostExtStorage(), tenantId, runId: `hostext:webinar-push:${event.eventId}`, actingUserId: user.userId, orgId });
      let pushed = 0;
      const failures: Array<{ email: string; reason: string }> = [];
      for (const p of queue) {
        const [first, ...rest] = (p.name ?? '').split(' ');
        const out = await adapter.registerRegistrant(p.providerEventId, { email: p.email, ...(first ? { firstName: first } : {}), ...(rest.length ? { lastName: rest.join(' ') } : {}) });
        if (out.ok) { await deletePendingPush(tenantId, event.eventId, p.email); pushed += 1; }
        else failures.push({ email: p.email, reason: out.error });
      }
      res.json({ pushed, failed: failures.length, failures: failures.slice(0, 10) });
    } catch (err) { next(err); }
  });
}

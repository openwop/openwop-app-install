/**
 * Host-event bindings (ADR 0208 §1) — the host-ext admin surface that binds a
 * host-extension event type (`host.crm.contact.created`, …) to a workflow, so
 * record changes can start runs. Registering here also initializes the
 * dispatcher with its boot deps (webhook fanout + shared run starter).
 *
 * Deliberately NOT the RFC 0099 `/v1/trigger-subscriptions` surface — that
 * source enum is wire-governed; this registry is host-ext only.
 */
import type { Express, Request } from 'express';
import { isV2HostEventName } from '../host/hostEventNames.js';
import { hostEventEntryForSubscriptionName, hostEventTypeEntries } from '../host/hostEventTypes.js';
import { OpenwopError } from '../types.js';
import type { Storage } from '../storage/storage.js';
import type { HostAdapterSuite } from '../host/index.js';
import { tenantOf } from '../host/requestSubject.js';
import { startWorkflowRun } from '../host/runStarter.js';
import { resolveTenantWorkflow } from '../host/resolveLaunchDefinition.js';
import { deliverHostExtEvent } from './webhooks.js';
import {
  createHostEventBinding,
  deleteHostEventBinding,
  initHostEventDispatcher,
  listHostEventBindings,
  updateHostEventBindingEnabled,
  MAX_BINDINGS_PER_TENANT,
} from '../host/hostEventDispatcher.js';

interface Deps {
  storage: Storage;
  hostSuite: HostAdapterSuite;
}

const BASE = '/host/openwop-app/host-events/bindings';
/**
 * ADR 0825 — the host-event CATALOG, read from the one SSOT
 * (`host/hostEventTypes.ts`, pinned against every emit site by
 * `adr0825-rfc0236-host-events.test.ts`). It replaces the SPA's hand-kept list,
 * which had ~14 baselined misses: a discovery surface derived from the emitters
 * cannot drift from them. Each row carries both spellings a binding accepts.
 * Not flag-gated: bindings are host-extension state, not wire.
 */
const CATALOG_PATH = '/host/openwop-app/host-events/catalog';

const principalOf = (req: Request): string =>
  (req as Request & { principal?: { principalId?: string } }).principal?.principalId ?? 'anonymous';

export function registerHostEventRoutes(app: Express, deps: Deps): void {
  const { storage, hostSuite } = deps;

  initHostEventDispatcher({
    storage,
    hostSuite,
    // ONE webhook fanout for run-less events (merge reconciliation): main's
    // `deliverHostExtEvent` landed the same seam for CMS lifecycle events —
    // the dispatcher rides it rather than keeping a parallel delivery shape.
    deliverWebhooks: (event) => deliverHostExtEvent({ type: event.type, tenantId: event.tenantId, payload: event.payload, eventId: event.eventId }),
    startRun: startWorkflowRun,
  });

  app.get(CATALOG_PATH, (_req, res) => {
    res.json({ types: hostEventTypeEntries().map((e) => ({ emitted: e.emitted, type: e.type, delivery: e.delivery })) });
  });

  app.get(BASE, async (req, res, next) => {
    try {
      res.json({ bindings: await listHostEventBindings(tenantOf(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.post(BASE, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const body = (req.body ?? {}) as { eventType?: unknown; workflowId?: unknown };
      const eventType = typeof body.eventType === 'string' ? body.eventType.trim() : '';
      const workflowId = typeof body.workflowId === 'string' ? body.workflowId.trim() : '';
      // Host-extension event names only (RFC 0086 §E) — a binding on a
      // canonical RunEventType would shadow normative semantics.
      // ADR 0792 — the v2 spelling (`openwop-app.<feature>.<entity>-<verb>`) is
      // accepted beside the in-process `host.…` name; either one matches.
      // ADR 0825 — and any spelling of a CATALOGUED event: `crm.segment.entered`
      // is emitted under neither prefix, so the grammar alone refused a real,
      // bindable event the catalog route offers.
      if (!/^host\.[a-z][a-zA-Z0-9._-]*$/.test(eventType) && !isV2HostEventName(eventType) && !hostEventEntryForSubscriptionName(eventType)) {
        throw new OpenwopError('validation_error', 'eventType must be a host-extension event name (host.… or openwop-app.…).', 400, { eventType });
      }
      // Refuse a binding to a workflow that can't execute (the triggerBridge posture).
      // ADR 0823 — "can't execute" includes "another tenant owns it": the same 422.
      const wf = await resolveTenantWorkflow(hostSuite.workflowCatalog, tenantId, workflowId);
      if (!wf) throw new OpenwopError('workflow_not_found', `Workflow not found: ${workflowId}`, 422, { workflowId });
      if ((await listHostEventBindings(tenantId)).length >= MAX_BINDINGS_PER_TENANT) {
        throw new OpenwopError('validation_error', 'Host-event binding cap reached for this tenant.', 409, { max: MAX_BINDINGS_PER_TENANT });
      }
      const binding = await createHostEventBinding({ tenantId, eventType, workflowId, createdBy: principalOf(req) });
      res.status(201).json(binding);
    } catch (err) {
      next(err);
    }
  });

  // Admin-UI toggle (no separate wire concept — just the durable `enabled`
  // flag `emitHostEvent` already checks). Body-shaped like a PATCH, not a
  // sub-resource, since it's the one mutable field on a binding today.
  app.patch(`${BASE}/:bindingId`, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const body = (req.body ?? {}) as { enabled?: unknown };
      if (typeof body.enabled !== 'boolean') {
        throw new OpenwopError('validation_error', 'enabled must be a boolean.', 400, {});
      }
      const updated = await updateHostEventBindingEnabled(tenantId, req.params.bindingId, body.enabled);
      if (!updated) throw new OpenwopError('not_found', 'Binding not found.', 404, { bindingId: req.params.bindingId });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/:bindingId`, async (req, res, next) => {
    try {
      const ok = await deleteHostEventBinding(tenantOf(req), req.params.bindingId);
      if (!ok) throw new OpenwopError('not_found', 'Binding not found.', 404, { bindingId: req.params.bindingId });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });
}

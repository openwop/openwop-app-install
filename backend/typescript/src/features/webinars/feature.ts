/**
 * Webinars connector (ADR 0404 §a) — a Zoom-first webinar integration. Registration
 * rides existing forms/funnels; a provider adapter pushes registrants to Zoom;
 * verified Zoom webhooks ride the shared connections inbound seam + a feature
 * observer, landing attendance in the CRM timeline + `host.webinar.*` events (which
 * a journey chain binds, Phase 2). NEW feature package — it reuses the shared
 * substrate (connections broker, RFC 0095, forms sinks, CRM activities) and copies
 * the campaign-connectors sync ergonomics; it does NOT overload the ads AdsAdapter.
 *
 * RFC gate: host-ext, rides Accepted RFC 0095 + RFC 0120. NO new wire RFC.
 *
 * @see docs/adr/0404-event-and-creative-provider-integrations.md §a
 */

import type { BackendFeature } from '../types.js';
import { registerWebinarsRoutes } from './routes.js';
import { buildWebinarsSurface } from './surface.js';
import { registerWebinarFormsSink } from './formsSubmissionSink.js';
import { registerInboundObserver } from '../connections/inboundWebhooks.js';
import { onFormDeleted } from '../../host/formLifecycle.js';
import { onCrmRecordDeleted } from '../../host/crmRecordLifecycle.js';
import { deleteActivitiesForContactByPrefix } from '../crm/entities/activities.js';
import { onVerifiedWebinarWebhook } from './webinarProcessor.js';
import { unbindForm } from './entities/marketingEvent.js';

export const webinarsFeature: BackendFeature = {
  id: 'webinars',
  registerRoutes: (deps) => {
    registerWebinarsRoutes(deps);
    // Process verified Zoom webhooks (dependency inversion — connections never
    // imports webinars). Observer-only: no workflow fires.
    registerInboundObserver('zoom-webinar', onVerifiedWebinarWebhook);
    // The registration form → provider push + CRM capture sink.
    registerWebinarFormsSink();
    // Prune the form→event binding (+ the event's dangling formId) when a bound
    // registration form is deleted — no orphaned soft ref (ADR 0404 WEB-2).
    onFormDeleted('webinars-form-unbind', async ({ tenantId, formId }) => { await unbindForm(tenantId, formId); });
    // Prune a deleted contact's webinar activities so compute-on-read counts stop
    // counting the dead contact (ADR 0404 grade-data WEB-1). The contact is gone;
    // its orphaned webinar timeline is meaningless. Bounded prefix scan, rare path.
    onCrmRecordDeleted('webinars-activity-unlink', async ({ entity, tenantId, recordId }) => {
      if (entity !== 'contact') return;
      await deleteActivitiesForContactByPrefix(tenantId, recordId, 'act:webinar:');
    });
  },
  surface: { id: 'webinars', build: buildWebinarsSurface },
  requiredPacks: [{ name: 'feature.webinars.nodes', version: '1.0.1' }],
  recommends: ['crm', 'forms', 'connections'],
  toggleDefault: {
    id: 'webinars',
    label: 'Webinars',
    description:
      'Connect Zoom to run webinars as a CRM conversion surface — registrations ride your existing forms/funnels, attendance flows back into the contact timeline + segments, and host.webinar.* events can enroll journeys. No native webinar delivery (integrate the market-leading provider); Livestorm/StreamYard follow via a connection pack. OFF by default.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'webinars',
  },
};

/**
 * ADR 0422 — the service desk: tickets as kernel-backed system entities,
 * omnichannel intake on existing seams, and a governed agent lane. P1 ships
 * the ticket kernel + service + member routes; P2 intake; P3 the agent lane;
 * P4 queue/SLA/FE; P5 widget ticketing (its own sub-toggle + security pass).
 */
import type { BackendFeature } from '../types.js';
import { registerServiceDeskRoutes } from './routes.js';
import { registerServiceDeskIntake } from './intake.js';
import { registerServiceDeskAgentTools } from './agentTools.js';
import { buildServiceDeskSurface } from './surface.js';
import { startSlaSweep } from './sla.js';
import { registerServiceDeskWidgetRoutes } from './widgetRoutes.js';
import { registerServiceDeskErasure } from './tickets.js';

export const serviceDeskFeature: BackendFeature = {
  id: 'service-desk',
  registerRoutes: (deps) => {
    registerServiceDeskRoutes(deps);
    registerServiceDeskIntake(); // P2 — WhatsApp observer + forms sink (existing seams)
    registerServiceDeskAgentTools(); // P3 — ADR 0308 seam
    startSlaSweep(); // P4 — bounded timer-row sweep (never a ticket scan)
    registerServiceDeskWidgetRoutes(deps); // P5 — the public widget lane (double-toggle fail-closed)
    registerServiceDeskErasure(); // D8 (chat-first port) — DSAR redacts requester/customer PII in place
  },
  surface: { id: 'service-desk', build: buildServiceDeskSurface },
  requiredPacks: [
    { name: 'feature.service-desk.nodes', version: '1.0.0' },
    { name: 'feature.service-desk.agents', version: '1.0.0' },
  ],
  toggleDefault: {
    id: 'service-desk',
    label: 'Service desk',
    description:
      'Omnichannel support tickets over your existing channels — WhatsApp and form intake attach to CRM contacts, agents draft replies through the approval inbox, and SLA clocks alert through notifications (ADR 0422).',
    category: 'CRM',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'service-desk',
  },
  extraToggleDefaults: [
    {
      id: 'service-desk.widget',
      label: 'Public widget ticketing',
      description:
        'Let anonymous visitors open and continue support tickets from an embedded widget via the public intake key — HMAC visitor sessions, internal notes never exposed, fail-closed without configuration. A sub-capability of Service desk; OFF until you deliberately publish the intake key.',
      category: 'CRM',
      status: 'off',
      bucketUnit: 'tenant',
      salt: 'service-desk-widget',
    },
  ],
  recommends: ['crm'],
};

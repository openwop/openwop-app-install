/**
 * kicktodo-integrations — calendar/wearable/messaging as Connections
 * (ADR 0421). P1: consent + the tokenized read-only ICS feed (zero provider
 * scope). P3: wearable metric→check-in evidence.
 */

import type { BackendFeature } from '../types.js';
import { registerKicktodoIntegrationsRoutes } from './routes.js';
import { buildKicktodoIntegrationsSurface } from './surface.js';
import { registerCalendarProviderAdapter } from './calendarProviderAdapter.js';
import { calendarMcpConfigured, registerCalendarMcpAdapter } from './calendarMcpAdapter.js';
import { registerKicktodoWearableStaleExceptionSource } from './exceptionSources.js';
import { registerKicktodoIntegrationsAgentTools } from './agentTools.js';

export const kicktodoIntegrationsFeature: BackendFeature = {
  id: 'kicktodo-integrations',
  registerRoutes: (deps) => {
    registerKicktodoIntegrationsRoutes(deps);
    // Calendar-write port — a SINGLE global CalendarTransport, honesty-gated (otherwise
    // the port stays inert and `isCalendarTransportConfigured()` reads false, ADR 0421).
    // Precedence (ADR 0466 §4): the MCP transport (Google's first-party Calendar MCP
    // server, KT-PORT-6a-3) WINS when `OPENWOP_CALENDAR_MCP_ENABLED`; otherwise the
    // bespoke direct-REST adapter (KT-PORT-6a) as the generic/self-hosted fallback.
    if (calendarMcpConfigured()) registerCalendarMcpAdapter();
    else registerCalendarProviderAdapter();
    // ADR 0462 P3 — the stale-wearable-stream feed of the admin Exception Ledger
    // (the fifth ADR 0460 source, now honest via the P3 liveness clock).
    registerKicktodoWearableStaleExceptionSource();
    // ADR 0308 seam — the participant-facing READ of integration setup state, so
    // KickBot can honestly answer "is my calendar/wearable connected?" (pack-
    // allowlisted onto KickBot; never the ADR 0315 default baseline).
    registerKicktodoIntegrationsAgentTools();
  },
  toggleDefault: {
    id: 'kicktodo-integrations',
    label: 'KickTodo Integrations',
    description:
      'Calendar feed/write, wearable evidence, and messaging reminders — each an explicit, revocable consent over a Connection (ADR 0421).',
    category: 'KickTodo',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'kicktodo-integrations',
  },
  dependsOn: ['kicktodo-core'],
  // The pack's calendar-sync / remind-today / list-consents nodes consume this
  // surface — pin it here, not only transitively via kicktodo-core (NP-KT-3).
  requiredPacks: [{ name: 'feature.kicktodo.nodes', version: '1.30.0' }],
  surface: { id: 'kicktodo-integrations', build: buildKicktodoIntegrationsSurface }, // ADR 0421 P5
};

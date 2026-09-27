/**
 * Destination Sync (ADR 0266 / CDP-D) — the single non-ad egress owner. Ships the
 * config catalog + CDC watermark cursor + field-mapping; egress rides existing
 * http/connector nodes. OFF, tenant-bucketed. campaign-connectors remains the ad
 * specialist (ADR 0262 ruling #3).
 */
import type { BackendFeature } from '../types.js';
import { registerDestinationSyncRoutes } from './routes.js';
import { buildDestinationSyncSurface } from './surface.js';
import { registerDestinationSyncAgentTools } from './agentTools.js';

export const destinationSyncFeature: BackendFeature = {
  id: 'destination-sync',
  registerRoutes: (deps) => {
    registerDestinationSyncRoutes(deps);
    // CHAT-FIRST-PORT-AUDIT D7 — register the chat lane that ignites the onward
    // egress (openwop-host workflow + governed warehouse load) from the one chat.
    registerDestinationSyncAgentTools({ storage: deps.storage, hostSuite: deps.hostSuite });
  },
  surface: { id: 'destination-sync', build: buildDestinationSyncSurface },
  toggleDefault: {
    id: 'destination-sync',
    label: 'Destination Sync',
    description: 'Map + sync customer data to downstream destinations with CDC (ADR 0266).',
    category: 'Customer Data Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'destination-sync',
  },
  // Hard dep: onward sync imports CDP's purpose-label engine (`../cdp/purposeLabels`),
  // so it cannot function without the CDP core — disabling CDP while this is on would
  // orphan it (ADR 0194 disable-lock).
  dependsOn: ['cdp'],
  // Egress needs a BYOK Connection; purpose-propagation on onward sync needs Consent.
  recommends: ['connections', 'consent'],
  requiredPacks: [{ name: 'feature.destination-sync.nodes', version: '1.0.0' }],
};

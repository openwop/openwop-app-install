/**
 * UI-plugins feature (ADR 0300) — the host implementation that graduates
 * RFC 0117 (front-end plugin packs) + RFC 0119 (isolation mechanism-neutrality).
 *
 * Ships the reachable surface that mounts a downloaded, signed
 * `kind:"frontend-plugin"` pack in a cross-origin sandboxed iframe and drives it
 * over the ui-plugin/1 host-RPC boundary — the falsifiable real boundary
 * (isolated + egress-denied + allowlist-bound + no-BYOK).
 *
 * The `uiPlugins` CAPABILITY is advertised independently of this toggle
 * (discovery.ts / `presentationEnabled('uiPlugins')`, always-on under profile
 * `full`) and the ui-plugin/1 RPC seam is always mounted — this feature adds the
 * pack-serving endpoints + the admin/demo PAGE, off by default (a new surface;
 * off ⇒ the page + nav are hidden, the capability + seam stay honest).
 *
 * No node pack (a frontend-plugin is sandboxed UI, not a node runtime); no agent
 * pack (not an AI surface). The pack it exercises
 * (`community.openwop.artifact-viewer`) is a `kind:"frontend-plugin"` pack served
 * by frontendPluginPacks.ts, not a `requiredPacks` node install.
 */

import type { BackendFeature } from '../types.js';
import { registerUiPluginsFeatureRoutes } from './routes.js';

export const uiPluginsFeature: BackendFeature = {
  id: 'ui-plugins',
  registerRoutes: registerUiPluginsFeatureRoutes,
  toggleDefault: {
    id: 'ui-plugins',
    label: 'UI Plugins',
    description: 'Load signed, sandboxed front-end plugin packs (RFC 0117/0119) — cross-origin-iframe isolation, deny-egress, closed host-RPC allowlist.',
    category: 'Developer',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'ui-plugins',
  },
};

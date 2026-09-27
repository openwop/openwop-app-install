/**
 * Campaign Studio editor routes (host-extension, ADR 0310 Phase C) — a pure
 * call into the shared canvas-editor route factory, type-pinned to
 * `canvas.campaign` and gated by the `campaign-studio` toggle. No
 * catalog/templates (a multi-collection elements-trait type — the adders live
 * in the FE definition); no extra verbs; no share.
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { registerCanvasEditorRoutes } from '../canvasEditorRoutes.js';
import { validateCampaignDoc } from './validateCampaignDoc.js';

export function registerCampaignStudioEditorRoutes(deps: RouteDeps): void {
  registerCanvasEditorRoutes(deps, {
    basePath: '/v1/host/openwop-app/campaign-studio',
    feature: { toggleId: 'campaign-studio', label: 'Campaign Studio' },
    canvasTypeId: 'canvas.campaign',
    // ADR 0359 Phase 5 — collab-capable (both toggles enforced at the socket).
    collab: true,
    // ADR 0359 Phase 6 — the doc↔Y shape (drift-pinned against the FE traits
    // in canvas/__tests__/collabTypes.test.ts + collab-authboundary registry test).
    collabShape: { collections: [{ key: 'channels' }, { key: 'funnel' }, { key: 'assets' }] },
    validate: validateCampaignDoc,
    // ADR 0314 — blank campaign: schema requires a name + ≥1 channel; the
    // channel matches the FE adder's defaults.
    blankState: (name) => ({ name, channels: [{ name: 'New channel', type: 'email' }] }),
  });
}

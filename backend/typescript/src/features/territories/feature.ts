/**
 * Sales Territory Management — the backend feature module (ADR 0272).
 *
 * The sales-organization layer over CRM (ADR 0008 / 0208–0213): a layered
 * Type → Model → Territory hierarchy with a Planning → Active → Archived model
 * lifecycle (Phase 1), filter-based auto-assignment (P2), per-territory + per-rep
 * quotas (P3), and territory-scoped record visibility via a core resolver seam
 * (P4). Host-extension only — no OpenWOP RFC (rides Accepted RFC 0049 scopes).
 *
 * Ships `off` (ADR 0001 §6 — a brand-new feature). While off, the CRM surface is
 * byte-for-byte unchanged: the P4 visibility resolver defaults to allow-all and
 * `territories` only registers it when enabled.
 *
 * `bucketUnit: 'tenant'` — a shared B2B surface (ADR 0015). Node/agent packs +
 * the `ctx.features.territories` surface land in P5, so no `requiredPacks`/
 * `surface` yet.
 */

import type { BackendFeature } from '../types.js';
import { registerTerritoryRoutes } from './routes.js';
import { registerTerritoryVisibility } from './visibility.js';
import { registerTerritoryCrmLifecycle } from './lifecycle.js';
import { buildTerritorySurface } from './surface.js';
import { registerTerritoryAgentTools } from './agentTools.js';
import { registerTerritoryTransitionGate } from './modelTransitionApproval.js';
import { registerTerritoryErasure } from './erasure.js';

export const territoriesFeature: BackendFeature = {
  id: 'territories',
  registerRoutes: (deps) => {
    registerTerritoryRoutes(deps);
    // Register the CRM row-visibility resolver (ADR 0272 P4). Registered
    // unconditionally at boot (like routes); it self-gates on toggle STATE so a
    // disabled tenant sees the unfiltered CRM surface.
    registerTerritoryVisibility();
    // ADR 0283 — prune territory assignments when their CRM record is deleted
    // (closes TERR-DATA-1). Safe regardless of toggle state: only ever deletes
    // this feature's own soft-reference rows.
    registerTerritoryCrmLifecycle();
    // CFP-1 (D9) — the advisory Territory Planner's READ chat tools (self-gating
    // on the `territories` toggle per call; fail-empty without an acting user).
    registerTerritoryAgentTools();
    // CFP-1 (D9) — the model-transition DECIDE handler on the shared approvals
    // hook. Activating/archiving a model (org-wide CRM-visibility blast radius) is
    // submitted for review; this gate applies the transition behind
    // host:territories:manage (replacing the demolished bespoke activate/archive
    // mutations). Safe regardless of toggle state (only registers a handler).
    registerTerritoryTransitionGate();
    // R2 TER2-B4 — GDPR subject erasure. Territories held THREE subject-keyed
    // fields (manager, members, quota rep-splits) and registered nothing, so
    // `eraseSubject` never reached them — and two of the three are read by
    // `visibility.ts` to grant CRM row access. Registered unconditionally: an
    // erasure must not depend on a feature toggle being on today.
    registerTerritoryErasure();
  },
  // Face 2 (ADR 0014) — the read-only ctx.features.territories workflow surface.
  surface: { id: 'territories', build: buildTerritorySurface },
  toggleDefault: {
    id: 'territories',
    label: 'Sales Territories',
    description: 'Layered sales-territory model (regions/divisions/hierarchy) over CRM, with quota rollup and territory-scoped visibility.',
    category: 'Sales',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'territories',
  },
  // Hard dep: the territory model is layered over CRM (imports `../crm`) — quotas
  // and hierarchy attach to CRM accounts (ADR 0194 disable-lock).
  dependsOn: ['crm'],
  requiredPacks: [
    { name: 'feature.territories.nodes', version: '1.2.0' },
    { name: 'feature.territories.agents', version: '1.0.2' },
  ],
};

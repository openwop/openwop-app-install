/**
 * Dealer Network, Retail Outlets & PRM — the backend feature module (ADR 0281).
 *
 * Dealer records (referencing a CRM company + optional territory) + retail-outlet
 * store-location records + (P2) a capability-token partner portal for deal
 * registration. Host-extension only — no OpenWOP RFC. Ships `off` (ADR 0001 §6);
 * `bucketUnit: 'tenant'` (shared B2B surface). The ctx.features.dealers surface +
 * packs land in P3.
 *
 * @see docs/adr/0281-dealer-network-prm.md
 */

import type { BackendFeature } from '../types.js';
import { registerDealerRoutes } from './routes.js';
import { registerDealerCrmLifecycle } from './lifecycle.js';
import { buildDealerSurface } from './surface.js';
import { registerDealerAgentTools } from './agentTools.js';
import { registerDealerRegistrationGate } from './registrationApproval.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { eraseSubjectDealers } from './entities/registration.js';

export const dealersFeature: BackendFeature = {
  id: 'dealers',
  registerRoutes: (deps) => {
    registerDealerRoutes(deps);
    // ADR 0283 — suspend dealers whose CRM company is deleted (closes DEAL-DATA-2).
    // Safe regardless of toggle state (touches only this feature's own rows).
    registerDealerCrmLifecycle();
    // CFP-1 (D9) — the advisory Channel Manager's READ chat tools (self-gating on
    // the `dealers` toggle per call; fail-empty without an acting user).
    registerDealerAgentTools();
    // CFP-1 (D9) — the deal-registration DECIDE handler on the shared approvals
    // hook. A partner-submitted registration queues a `dealer-registration`
    // approval (reviews inbox); this gate applies the flip behind host:dealers:manage
    // (replacing the demolished bespoke approve/reject route). Safe regardless of
    // toggle state (only registers a decision handler).
    registerDealerRegistrationGate();
    // R2 DLR2-M3 — subject erasure. Registered unconditionally: an erasure must not
    // depend on a feature toggle being on today. See `eraseSubjectDealers`.
    registerSubjectEraser(eraseSubjectDealers);
  },
  // Face 2 (ADR 0014) — the ctx.features.dealers workflow surface (P3).
  surface: { id: 'dealers', build: buildDealerSurface },
  toggleDefault: {
    id: 'dealers',
    label: 'Dealer Network',
    description: 'Dealer-network + retail-outlet records over CRM companies, with a partner portal for deal registration. Dealers are territory-assignable (ADR 0272).',
    category: 'Sales',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'dealers',
  },
  // Dealer-network + outlet records sit over CRM companies; works best with CRM on.
  recommends: ['crm'],
  requiredPacks: [
    { name: 'feature.dealers.nodes', version: '1.0.0' },
    { name: 'feature.dealers.agents', version: '1.0.2' },
  ],
};

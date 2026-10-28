/**
 * ADR 0990 — the site owner chooses the free tier's provider and model.
 *
 * Always-on (no toggle): with no saved row the free tier runs on the env default
 * exactly as before, so there is no risk surface to gate. The feature registers
 * its reader into the core `registerManagedTierConfigProvider` seam at boot, and
 * core never imports the feature (the ADR 0318 fill-a-seam pattern).
 *
 * @see docs/adr/0990-managed-tier-owner-select.md
 */
import type { BackendFeature } from '../types.js';
import { registerManagedTierConfigProvider } from '../../providers/managedProvider.js';
import { registerManagedTierAdminRoutes } from './routes.js';
import { readForCore } from './service.js';

let wired = false;

/** Idempotent boot wiring — safe across repeated `registerBackendFeatures` (tests). */
function wireProvider(): void {
  if (wired) return;
  wired = true;
  registerManagedTierConfigProvider(() => readForCore());
}

export const managedTierAdminFeature: BackendFeature = {
  id: 'managed-tier-admin',
  registerRoutes: (deps) => {
    wireProvider();
    registerManagedTierAdminRoutes(deps);
  },
};

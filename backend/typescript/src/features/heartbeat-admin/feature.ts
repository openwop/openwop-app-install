/**
 * ADR 0318 — Heartbeat admin settings.
 *
 * A superadmin-owned host-wide control for the ADR 0313 autonomous work loop:
 * a master on/off, an auto-disabling "run for N hours" window, an editable
 * host-default cadence, and a runtime run-budget override — all without a
 * redeploy (turning the `OPENWOP_HEARTBEAT_DEFAULT_MS` env into a stored setting).
 *
 * Always-on (no toggle): with no saved config the loop inherits the env default
 * exactly as before, so there is no risk surface to gate. The feature registers
 * its resolver into the core `registerHeartbeatConfigProvider` seam at boot —
 * core never imports the feature (the ADR 0313 `registerAgentTurnFallback` pattern).
 *
 * @see docs/adr/0318-heartbeat-admin-settings.md
 */
import type { BackendFeature } from '../types.js';
import { registerHeartbeatConfigProvider } from '../../host/heartbeatService.js';
import { registerHeartbeatAdminRoutes } from './routes.js';
import { resolveForCore } from './service.js';

let wired = false;

/** Idempotent boot wiring — safe across repeated `registerBackendFeatures` (tests). */
function wireProvider(): void {
  if (wired) return;
  wired = true;
  // The provider resolves the durable admin config (applying the auto-disable
  // window) per heartbeat pass; core fail-opens to the env default on any error.
  registerHeartbeatConfigProvider(() => resolveForCore());
}

export const heartbeatAdminFeature: BackendFeature = {
  id: 'heartbeat-admin',
  registerRoutes: (deps) => {
    wireProvider();
    registerHeartbeatAdminRoutes(deps);
  },
  // No toggleDefault → always-on (empty config == env-default behavior).
};

/**
 * Capability Firewall (ADR 0135) — composition-aware tool/data/action risk. A tenant
 * rule set over RFC 0078 tool CLASSES (safetyTier/egress/scope) evaluated inside the live
 * tool loop against the COMBINATION a run has exercised (read-drive + send-email ⇒
 * deny/approve). ANDs after the ADR 0132/0102 per-tool gates; narrows only.
 *
 * ALWAYS-ON (toggle removed — ADR 0010/0024 graduation, 2026-06-24). It ships RULE-LESS
 * by default, so it is present everywhere but a no-op (zero behavior change) until an
 * admin adds rules in the rule manager — the loop skips building the hook when a tenant
 * has no rules. RBAC on the rule routes is unchanged (`requireOrgScope`).
 *
 * @see docs/adr/0135-capability-firewall.md
 */
import type { BackendFeature } from '../types.js';
import { registerCapabilityFirewallRoutes } from './routes.js';

export const capabilityFirewallFeature: BackendFeature = {
  id: 'capability-firewall',
  registerRoutes: (deps) => { registerCapabilityFirewallRoutes(deps); },
};

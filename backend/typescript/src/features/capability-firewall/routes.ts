/**
 * ADR 0135 Phase 3 — capability-firewall rule REST (authed, host-extension).
 *
 *   GET /v1/host/openwop-app/capability-firewall/orgs/:orgId/rules
 *   PUT /v1/host/openwop-app/capability-firewall/orgs/:orgId/rules  { rules: [...] }
 *
 * Tenant-wide policy; `authorizeOrgScope` gates the toggle + RBAC (read/write) and
 * self-hides (404) when OFF. Validation is fail-closed (a bad PUT 400s).
 *
 * @see docs/adr/0135-capability-firewall.md
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireOrgScope } from '../featureRoute.js';
import { getStoredRuleSet, getCapabilityRules, getUnknownToolPolicy, setCapabilityRules, validateRules } from './ruleStore.js';
import { OpenwopError } from '../../types.js';

// Always-on (toggle removed, 2026-06-24) — RBAC-gated only (no toggle gate).
const BASE = '/v1/host/openwop-app/capability-firewall/orgs/:orgId/rules';

function readUnknownToolPolicy(body: unknown): 'skip' | 'treat-as-risky' {
  // CGOV-1: a PUT that omits the policy persists the fail-CLOSED default (matching the
  // unconfigured-tenant default in getUnknownToolPolicy) — never silently re-open.
  const v = (body as { unknownToolPolicy?: unknown })?.unknownToolPolicy ?? 'treat-as-risky';
  if (v !== 'skip' && v !== 'treat-as-risky') throw new OpenwopError('validation_error', "unknownToolPolicy MUST be 'skip' or 'treat-as-risky'.", 400);
  return v;
}

export function registerCapabilityFirewallRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get(BASE, async (req, res, next) => {
    try {
      const { user } = await requireOrgScope(req, 'workspace:read');
      const stored = await getStoredRuleSet(user.tenantId);
      res.json({ rules: await getCapabilityRules(user.tenantId), unknownToolPolicy: await getUnknownToolPolicy(user.tenantId), isDefault: stored === null });
    } catch (err) { next(err); }
  });

  app.put(BASE, async (req, res, next) => {
    try {
      const { user } = await requireOrgScope(req, 'workspace:write');
      const rules = validateRules((req.body as { rules?: unknown })?.rules);
      const unknownToolPolicy = readUnknownToolPolicy(req.body);
      const saved = await setCapabilityRules(user.tenantId, rules, unknownToolPolicy, user.userId);
      res.json({ rules: saved.rules, unknownToolPolicy: saved.unknownToolPolicy, isDefault: false });
    } catch (err) { next(err); }
  });
}

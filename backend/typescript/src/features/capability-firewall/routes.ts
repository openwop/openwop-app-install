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
import { requireTenantScope, tenantOf } from '../featureRoute.js';
import { callerSubject } from '../../host/requestSubject.js';
import { getStoredRuleSet, getCapabilityRules, getUnknownToolPolicy, getFirewallMode, getDefaultDenyVerdict, getPlatformRules, setCapabilityRules, setPlatformRules, validateRules, validateMode, validateDefaultDenyVerdict } from './ruleStore.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { listGovernanceDecisions } from '../../host/governanceDecisionLog.js';
import { requireSuperadmin } from '../../host/superadmin.js';
import { simulateFirewall, type SimAction, type SimulateInput } from './simulator.js';
import type { FirewallMode } from './compositionEvaluator.js';
import { OpenwopError } from '../../types.js';

// Always-on (toggle removed, 2026-06-24) — RBAC-gated only (no toggle gate).
const BASE = '/v1/host/openwop-app/capability-firewall/orgs/:orgId/rules';
// ADR 0397 Phase 1 — the firewall-scoped decisions view (a read op, workspace:read).
const DECISIONS = '/v1/host/openwop-app/capability-firewall/orgs/:orgId/decisions';
// ADR 0397 Phase 2 — the side-effect-free policy simulator (a read op, workspace:read).
const SIMULATE = '/v1/host/openwop-app/capability-firewall/orgs/:orgId/simulate';
// ADR 0397 Phase 5 — the superadmin platform-baseline rules (global floor, superadmin-only).
const PLATFORM = '/v1/host/openwop-app/capability-firewall/platform/rules';

const MODES = new Set<FirewallMode>(['default-allow', 'shadow', 'enforce']);
const SIM_TIERS = new Set(['pure', 'read', 'write', 'exec']);
const SIM_EGRESS = new Set(['none', 'safe-fetch', 'host-mediated', 'host-owned']);

/** Fail-closed validation of one simulator action: a `{ toolName }` ref or a valid class. */
function validateSimAction(v: unknown, where: string): SimAction {
  if (!v || typeof v !== 'object') throw new OpenwopError('validation_error', `${where} MUST be an object.`, 400);
  const o = v as Record<string, unknown>;
  if (typeof o.toolName === 'string' && o.toolName) return { toolName: o.toolName };
  if (typeof o.safetyTier === 'string' && SIM_TIERS.has(o.safetyTier)) return { safetyTier: o.safetyTier } as SimAction;
  if (typeof o.egress === 'string' && SIM_EGRESS.has(o.egress)) return { egress: o.egress } as SimAction;
  if (typeof o.scope === 'string' && o.scope) return { scope: o.scope };
  if (o.kind === 'fan-out') return { kind: 'fan-out' };
  throw new OpenwopError('validation_error', `${where} MUST be { toolName } or a valid capability class.`, 400);
}

function validateSimulateBody(body: unknown): SimulateInput {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.next === undefined) throw new OpenwopError('validation_error', 'next is required.', 400);
  const next = validateSimAction(b.next, 'next');
  const seen = b.seen === undefined ? undefined
    : Array.isArray(b.seen) ? b.seen.map((a, i) => validateSimAction(a, `seen[${i}]`))
    : (() => { throw new OpenwopError('validation_error', 'seen MUST be an array.', 400); })();
  let modeOverride: FirewallMode | undefined;
  if (b.modeOverride !== undefined) {
    if (typeof b.modeOverride !== 'string' || !MODES.has(b.modeOverride as FirewallMode)) {
      throw new OpenwopError('validation_error', "modeOverride MUST be 'default-allow', 'shadow', or 'enforce'.", 400);
    }
    modeOverride = b.modeOverride as FirewallMode;
  }
  const ctx = (b.context ?? {}) as Record<string, unknown>;
  const unknownToolPolicy = ctx.unknownToolPolicy;
  if (unknownToolPolicy !== undefined && unknownToolPolicy !== 'skip' && unknownToolPolicy !== 'treat-as-risky') {
    throw new OpenwopError('validation_error', "context.unknownToolPolicy MUST be 'skip' or 'treat-as-risky'.", 400);
  }
  return {
    next,
    ...(seen ? { seen } : {}),
    ...(modeOverride ? { modeOverride } : {}),
    ...(unknownToolPolicy ? { context: { unknownToolPolicy } } : {}),
  };
}

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
      // The rule set is TENANT-wide, so authority is tenant-level (not per-org) — vuln-scan H3.
      await requireTenantScope(req, 'workspace:read');
      const tenantId = tenantOf(req);
      const stored = await getStoredRuleSet(tenantId);
      res.json({
        rules: await getCapabilityRules(tenantId),
        unknownToolPolicy: await getUnknownToolPolicy(tenantId),
        mode: await getFirewallMode(tenantId),
        defaultDenyVerdict: await getDefaultDenyVerdict(tenantId),
        isDefault: stored === null,
      });
    } catch (err) { next(err); }
  });

  app.put(BASE, async (req, res, next) => {
    try {
      // Tenant-wide governance write (2026-07 vuln-scan H3): the rule set is stored
      // per-TENANT (setCapabilityRules(tenantId, …)) and silently widens every agent's
      // tool surface, so it MUST require tenant-level management authority — not the
      // per-org `workspace:write` an editor of any single org holds.
      await requireTenantScope(req, 'host:members:manage');
      const tenantId = tenantOf(req);
      const actor = callerSubject(req) ?? 'unknown';
      const rules = validateRules((req.body as { rules?: unknown })?.rules);
      const unknownToolPolicy = readUnknownToolPolicy(req.body);
      // ADR 0397 — the enforcement posture. A partial PUT that OMITS `mode`/
      // `defaultDenyVerdict` PRESERVES the stored posture (never silently de-escalates an
      // active `enforce`/`shadow` back to `default-allow` — the fail-safe default, matching
      // the fail-closed `unknownToolPolicy` omit-default). An explicit value still sets it.
      const stored = await getStoredRuleSet(tenantId);
      const body = (req.body ?? {}) as { mode?: unknown; defaultDenyVerdict?: unknown };
      const mode = body.mode !== undefined ? validateMode(body.mode) : (stored?.mode ?? 'default-allow');
      const defaultDenyVerdict = body.defaultDenyVerdict !== undefined ? validateDefaultDenyVerdict(body.defaultDenyVerdict) : (stored?.defaultDenyVerdict ?? 'deny');
      const saved = await setCapabilityRules(tenantId, rules, unknownToolPolicy, actor, { mode, defaultDenyVerdict });
      // CS-TL-2 (conversation-stack audit) — a rule-set OR posture mutation is a
      // GOVERNANCE event (a weakened rule / a mode revert silently widens every
      // agent's tool surface), so it audits like the ADR 0104 allowlist grants do —
      // best-effort via the ONE audit log (ADR 0028), never failing the save.
      try {
        await hostExtStorage().appendAudit({
          timestamp: saved.updatedAt,
          principalId: actor,
          action: 'capability-firewall.rules.set',
          resource: tenantId,
          outcome: 'ok',
          payload: { ruleCount: saved.rules.length, unknownToolPolicy: saved.unknownToolPolicy, mode: saved.mode, defaultDenyVerdict: saved.defaultDenyVerdict },
        });
      } catch { /* best-effort audit */ }
      res.json({ rules: saved.rules, unknownToolPolicy: saved.unknownToolPolicy, mode: saved.mode, defaultDenyVerdict: saved.defaultDenyVerdict, isDefault: false });
    } catch (err) { next(err); }
  });

  // ADR 0397 Phase 1 — recent firewall verdicts (deny / require-approval) for this
  // tenant, newest first, with matched-rule attribution. Reads the unified governance
  // decision log filtered to `kind: firewall` + this tenant. TENANT-scoped authority to
  // match the sibling rules routes (ADR 0405 vuln-scan H3 hardened those to
  // `requireTenantScope` since the firewall is tenant-wide; the ADR 0397 read routes,
  // added in a concurrent PR, are aligned here). A pure read op.
  app.get(DECISIONS, async (req, res, next) => {
    try {
      await requireTenantScope(req, 'workspace:read');
      const tenantId = tenantOf(req);
      const limit = Math.min(500, Math.max(1, Number((req.query as { limit?: unknown }).limit) || 100));
      const rows = await listGovernanceDecisions(tenantId, { kind: 'firewall', limit });
      // Project to a stable, non-PII decisions shape (drop raw audit internals).
      const decisions = rows.map((r) => {
        const payload = (r.payload ?? {}) as { decision?: unknown; toolName?: unknown; ruleId?: unknown; reason?: unknown; shadow?: unknown };
        return {
          decisionId: r.auditId,
          timestamp: r.timestamp,
          decision: typeof payload.decision === 'string' ? payload.decision : (r.outcome ?? 'deny'),
          // A shadow would-block was COMPUTED but not applied (the call proceeded) — flag it
          // so the view never shows a shadow record as if it blocked (honesty).
          ...(payload.shadow === true ? { shadow: true } : {}),
          ...(typeof payload.toolName === 'string' ? { toolName: payload.toolName } : {}),
          ...(typeof payload.ruleId === 'string' ? { ruleId: payload.ruleId } : {}),
          ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
          ...(r.resource ? { conversationId: r.resource } : {}),
        };
      });
      res.json({ decisions });
    } catch (err) { next(err); }
  });

  // ADR 0397 Phase 2 — pre-flight a hypothetical action against the tenant's CURRENT
  // rules. Pure: reads no run, writes nothing (no decision-log entry, no store mutation).
  // TENANT-scoped read to match the rules routes (ADR 0405 H3) — the rules it simulates
  // against are tenant-wide.
  app.post(SIMULATE, async (req, res, next) => {
    try {
      await requireTenantScope(req, 'workspace:read');
      const tenantId = tenantOf(req);
      const input = validateSimulateBody(req.body);
      res.json(await simulateFirewall(tenantId, input));
    } catch (err) { next(err); }
  });

  // ADR 0397 Phase 5 — the platform-baseline rules. Superadmin-only (a global floor across
  // ALL tenants). GET returns the current floor; PUT replaces it. A platform baseline only
  // tightens (deny / require-approval) — setPlatformRules rejects an `allow` rule.
  app.get(PLATFORM, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Capability-firewall platform baseline');
      res.json({ rules: await getPlatformRules() });
    } catch (err) { next(err); }
  });

  app.put(PLATFORM, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Capability-firewall platform baseline');
      const rules = validateRules((req.body as { rules?: unknown })?.rules);
      const actor = req.userId ?? req.principal?.principalId;
      const saved = await setPlatformRules(rules, actor);
      try {
        await hostExtStorage().appendAudit({
          timestamp: new Date().toISOString(),
          ...(actor ? { principalId: actor } : {}),
          action: 'capability-firewall.platform-rules.set',
          outcome: 'ok',
          payload: { ruleCount: saved.length },
        });
      } catch { /* best-effort audit */ }
      res.json({ rules: saved });
    } catch (err) { next(err); }
  });
}

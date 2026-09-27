/**
 * ADR 0130 Phase 2 — `ModelRouterConfig` entity + validation.
 *
 * A per-(tenant, org) rule set for `routeTurn` (Phase 1). The dispatch call-site +
 * the `run.metadata` replay stamp are Phase 3 — this owns the config + validation
 * only. Default OFF (the toggle gates the dispatch stage); with no config, dispatch
 * is unchanged.
 *
 * @see docs/adr/0130-rule-based-model-router.md
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import type { ModelRouterConfig, RoutingRule, RoutingTarget, RuleCondition } from './routeTurn.js';
import { ROUTABLE_PROVIDERS, isRoutableProvider } from './routableProviders.js';

export { ROUTABLE_PROVIDERS, isRoutableProvider } from './routableProviders.js';

const log = createLogger('features.model-router');

/** Rule kinds retired from the router. A stored config that still carries one is
 *  TOLERATED — the rule is dropped (inert) and a single warning is logged, never
 *  a 400 that would strand a tenant's saved config. `intentIs` was retired with
 *  its zero-caller intent-classifier subsystem (CHAT-FIRST-PORT-AUDIT A8). */
const RETIRED_RULE_KINDS = new Set(['intentIs']);
let warnedRetiredRule = false;
function noteRetiredRule(kind: string): void {
  if (warnedRetiredRule) return;
  warnedRetiredRule = true;
  log.warn('model_router_retired_rule_skipped', { kind });
}

export interface StoredRouterConfig {
  tenantId: string;
  orgId: string;
  config: ModelRouterConfig;
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
}

const configs = new DurableCollection<StoredRouterConfig>('modelrouter:config', (c) => `${c.tenantId}:${c.orgId}`);

function asTarget(v: unknown, where: string): RoutingTarget {
  const t = v as { provider?: unknown; model?: unknown } | undefined;
  if (!t || typeof t.provider !== 'string' || !t.provider.trim() || typeof t.model !== 'string' || !t.model.trim()) {
    throw new OpenwopError('validation_error', `${where} MUST be { provider, model } (non-empty strings).`, 400, { field: where });
  }
  const provider = t.provider.trim();
  if (!isRoutableProvider(provider)) {
    throw new OpenwopError('validation_error', `${where}.provider '${provider}' is not a routable provider (allowed: ${ROUTABLE_PROVIDERS.join(', ')}).`, 400, { field: `${where}.provider` });
  }
  return { provider, model: t.model.trim() };
}

/** Validate ONE condition. Returns `null` for a retired-but-tolerated kind (its
 *  rule is dropped, inert) so a legacy stored config never crashes; throws only
 *  for a genuinely unknown kind or a malformed field. */
function asCondition(v: unknown): RuleCondition | null {
  const c = v as { kind?: unknown; threshold?: unknown } | undefined;
  if (typeof c?.kind === 'string' && RETIRED_RULE_KINDS.has(c.kind)) {
    noteRetiredRule(c.kind); // e.g. a pre-A8 `intentIs` rule — skip it, don't reject the config
    return null;
  }
  switch (c?.kind) {
    case 'always': return { kind: 'always' };
    case 'attachment': return { kind: 'attachment' };
    case 'tokensOver':
      if (typeof c.threshold !== 'number' || c.threshold < 0) throw new OpenwopError('validation_error', '`tokensOver.threshold` MUST be a non-negative number.', 400, { field: 'when.threshold' });
      return { kind: 'tokensOver', threshold: c.threshold };
    case 'difficultyAtLeast': {
      // ADR 0130 Phase 5 (cost-router) — composite difficulty tier.
      const level = (c as { level?: unknown }).level;
      if (level !== 'low' && level !== 'medium' && level !== 'high') {
        throw new OpenwopError('validation_error', '`difficultyAtLeast.level` MUST be one of low | medium | high.', 400, { field: 'when.level' });
      }
      return { kind: 'difficultyAtLeast', level };
    }
    case 'conversationKind': {
      // ADR 0130 Phase 6 (board model-tier) — server-fed conversation kind.
      const value = (c as { value?: unknown }).value;
      if (value !== 'group' && value !== 'workspace' && value !== 'channel') {
        throw new OpenwopError('validation_error', '`conversationKind.value` MUST be one of group | workspace | channel.', 400, { field: 'when.value' });
      }
      return { kind: 'conversationKind', value };
    }
    default:
      throw new OpenwopError('validation_error', '`when.kind` MUST be one of always | attachment | tokensOver | difficultyAtLeast | conversationKind.', 400, { field: 'when.kind' });
  }
}

export function validateRouterConfig(input: unknown): ModelRouterConfig {
  const i = (input ?? {}) as { rules?: unknown; fallback?: unknown; cooldownMs?: unknown };
  if (!Array.isArray(i.rules)) throw new OpenwopError('validation_error', '`rules` MUST be an array.', 400, { field: 'rules' });
  if (i.rules.length > 50) throw new OpenwopError('validation_error', 'too many rules (max 50).', 400, { field: 'rules' });
  const rules: RoutingRule[] = [];
  i.rules.forEach((r, idx) => {
    const rr = r as { when?: unknown; target?: unknown };
    const when = asCondition(rr.when);
    if (when === null) return; // retired/inert rule (e.g. legacy `intentIs`) — skip it
    rules.push({ when, target: asTarget(rr.target, `rules[${idx}].target`) });
  });
  const fallback = asTarget(i.fallback, 'fallback');
  const cfg: ModelRouterConfig = { rules, fallback };
  if (typeof i.cooldownMs === 'number' && i.cooldownMs > 0) cfg.cooldownMs = Math.floor(i.cooldownMs);
  return cfg;
}

export async function getRouterConfig(tenantId: string, orgId: string): Promise<StoredRouterConfig | null> {
  const stored = (await configs.get(`${tenantId}:${orgId}`)) ?? null;
  if (!stored) return null;
  // Tolerate-and-skip on READ too: a config persisted before a rule kind was
  // retired is served (and routed) without the inert rule, so neither the router
  // runtime nor the admin UI ever sees a legacy `intentIs` rule.
  const kept = stored.config.rules.filter((r) => !RETIRED_RULE_KINDS.has((r.when as { kind?: unknown }).kind as string));
  if (kept.length === stored.config.rules.length) return stored;
  noteRetiredRule('intentIs');
  return { ...stored, config: { ...stored.config, rules: kept } };
}

export async function setRouterConfig(tenantId: string, orgId: string, actor: string, input: unknown): Promise<StoredRouterConfig> {
  const config = validateRouterConfig(input);
  const prev = await getRouterConfig(tenantId, orgId);
  const stored: StoredRouterConfig = {
    tenantId, orgId, config,
    enabled: prev?.enabled ?? false,
    updatedBy: actor, updatedAt: new Date().toISOString(),
  };
  await configs.put(stored);
  return stored;
}

export async function setRouterEnabled(tenantId: string, orgId: string, actor: string, enabled: boolean): Promise<StoredRouterConfig> {
  const prev = await getRouterConfig(tenantId, orgId);
  if (!prev) throw new OpenwopError('not_found', 'No router config to enable; set rules first.', 404, {});
  const stored: StoredRouterConfig = { ...prev, enabled, updatedBy: actor, updatedAt: new Date().toISOString() };
  await configs.put(stored);
  return stored;
}

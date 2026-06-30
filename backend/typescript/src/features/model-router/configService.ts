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
import type { ModelRouterConfig, RoutingRule, RoutingTarget, RuleCondition } from './routeTurn.js';

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
  return { provider: t.provider.trim(), model: t.model.trim() };
}

function asCondition(v: unknown): RuleCondition {
  const c = v as { kind?: unknown; threshold?: unknown } | undefined;
  switch (c?.kind) {
    case 'always': return { kind: 'always' };
    case 'attachment': return { kind: 'attachment' };
    case 'tokensOver':
      if (typeof c.threshold !== 'number' || c.threshold < 0) throw new OpenwopError('validation_error', '`tokensOver.threshold` MUST be a non-negative number.', 400, { field: 'when.threshold' });
      return { kind: 'tokensOver', threshold: c.threshold };
    case 'intentIs': {
      const intent = (c as { intent?: unknown }).intent;
      if (typeof intent !== 'string' || !intent.trim()) throw new OpenwopError('validation_error', '`intentIs.intent` MUST be a non-empty string.', 400, { field: 'when.intent' });
      return { kind: 'intentIs', intent: intent.trim() };
    }
    default:
      throw new OpenwopError('validation_error', '`when.kind` MUST be one of always | attachment | tokensOver | intentIs.', 400, { field: 'when.kind' });
  }
}

export function validateRouterConfig(input: unknown): ModelRouterConfig {
  const i = (input ?? {}) as { rules?: unknown; fallback?: unknown; cooldownMs?: unknown };
  if (!Array.isArray(i.rules)) throw new OpenwopError('validation_error', '`rules` MUST be an array.', 400, { field: 'rules' });
  if (i.rules.length > 50) throw new OpenwopError('validation_error', 'too many rules (max 50).', 400, { field: 'rules' });
  const rules: RoutingRule[] = i.rules.map((r, idx) => {
    const rr = r as { when?: unknown; target?: unknown };
    return { when: asCondition(rr.when), target: asTarget(rr.target, `rules[${idx}].target`) };
  });
  const fallback = asTarget(i.fallback, 'fallback');
  const cfg: ModelRouterConfig = { rules, fallback };
  if (typeof i.cooldownMs === 'number' && i.cooldownMs > 0) cfg.cooldownMs = Math.floor(i.cooldownMs);
  return cfg;
}

export async function getRouterConfig(tenantId: string, orgId: string): Promise<StoredRouterConfig | null> {
  return (await configs.get(`${tenantId}:${orgId}`)) ?? null;
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

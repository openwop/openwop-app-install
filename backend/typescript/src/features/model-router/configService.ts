/**
 * ADR 0130 Phase 2 — `ModelRouterConfig` entity + validation.
 *
 * ONE rule set per WORKSPACE (ADR 1016 D1) for `routeTurn`. This owns the config
 * and its validation only. With no config, or `enabled:false`, dispatch is
 * unchanged.
 *
 * ADR 1016 D1 — keyed `${tenantId}:${tenantId}`. It used to be keyed per org
 * (`${tenantId}:${orgId}`) while the only reader, the chat exchange, looked up the
 * workspace root, so a config saved for any other org (17 of 30 prod orgs on
 * 2026-10-31) could never route a turn. The key keeps the old two-part shape so the
 * root rows written under the old scheme are read unchanged.
 *
 * @see docs/adr/0130-rule-based-model-router.md
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import type { ModelRouterConfig, RoutingRule, RoutingTarget, RuleCondition } from './routeTurn.js';
import { ROUTABLE_PROVIDERS, isListedModel, isRoutableProvider } from './routableProviders.js';
import { ERASED_USER_REF, subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import type { SubjectEraseReport } from '../../host/subjectErasure.js';

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
  /** Always the workspace itself (`=== tenantId`) since ADR 1016 D1; kept so a
   *  row written by the per-org scheme for the workspace root still decodes. */
  orgId: string;
  config: ModelRouterConfig;
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
}

const configs = new DurableCollection<StoredRouterConfig>('modelrouter:config', (c) => `${c.tenantId}:${c.orgId}`, undefined, (c) => c.tenantId);

/** ADR 1016 D1 — the one key per workspace, the key the chat exchange reads. */
const workspaceKey = (tenantId: string): string => `${tenantId}:${tenantId}`;

function asTarget(v: unknown, where: string): RoutingTarget {
  const t = v as { provider?: unknown; model?: unknown } | undefined;
  if (!t || typeof t.provider !== 'string' || !t.provider.trim() || typeof t.model !== 'string' || !t.model.trim()) {
    throw new OpenwopError('validation_error', `${where} MUST be { provider, model } (non-empty strings).`, 400, { field: where });
  }
  const provider = t.provider.trim();
  if (!isRoutableProvider(provider)) {
    throw new OpenwopError('validation_error', `${where}.provider '${provider}' is not a routable provider (allowed: ${ROUTABLE_PROVIDERS.join(', ')}).`, 400, { field: `${where}.provider` });
  }
  const model = t.model.trim();
  // ADR 1016 D5 — closed world: a typo or a model the catalog does not list can
  // never become a routing target (it would fail every turn it matched).
  if (!isListedModel(provider, model)) {
    throw new OpenwopError('validation_error', `${where}.model '${model}' is not a ${provider} model in the catalog.`, 400, { field: `${where}.model` });
  }
  return { provider, model };
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
  // ADR 1016 D5 — optional: with none, a turn no rule matches keeps its own model.
  const cfg: ModelRouterConfig = { rules };
  if (i.fallback !== undefined && i.fallback !== null) cfg.fallback = asTarget(i.fallback, 'fallback');
  if (typeof i.cooldownMs === 'number' && i.cooldownMs > 0) cfg.cooldownMs = Math.floor(i.cooldownMs);
  return cfg;
}

/** The workspace's config (ADR 1016 D1), or null when none has been saved. */
/** Workspaces already warned about inert (unlisted-model) targets — bounded so a
 *  long-lived process cannot grow it without limit; it only rate-limits a log. */
const warnedUnlisted = new Set<string>();
function noteUnlistedTargets(stored: StoredRouterConfig): void {
  if (warnedUnlisted.has(stored.tenantId)) return;
  const targets = [...stored.config.rules.map((r) => r.target), ...(stored.config.fallback ? [stored.config.fallback] : [])];
  const unlisted = targets.filter((t) => !isListedModel(t.provider, t.model));
  if (unlisted.length === 0) return;
  if (warnedUnlisted.size >= 1000) warnedUnlisted.clear();
  warnedUnlisted.add(stored.tenantId);
  // ADR 1016 D5 / MR66CD-6 — a target the catalog no longer lists is never routed
  // to (`routeTurn` judges it ineligible); say so once, or the rule just stops.
  log.warn('model_router_unlisted_target_inert', {
    tenantId: stored.tenantId,
    targets: unlisted.map((t) => `${t.provider}/${t.model}`),
  });
}

export async function getRouterConfig(tenantId: string): Promise<StoredRouterConfig | null> {
  const stored = (await configs.get(workspaceKey(tenantId))) ?? null;
  if (!stored) return null;
  noteUnlistedTargets(stored);
  // Tolerate-and-skip on READ too: a config persisted before a rule kind was
  // retired is served (and routed) without the inert rule, so neither the router
  // runtime nor the admin UI ever sees a legacy `intentIs` rule.
  const kept = stored.config.rules.filter((r) => !RETIRED_RULE_KINDS.has((r.when as { kind?: unknown }).kind as string));
  if (kept.length === stored.config.rules.length) return stored;
  noteRetiredRule('intentIs');
  return { ...stored, config: { ...stored.config, rules: kept } };
}

export async function setRouterConfig(tenantId: string, actor: string, input: unknown): Promise<StoredRouterConfig> {
  const config = validateRouterConfig(input);
  const prev = await getRouterConfig(tenantId);
  const stored: StoredRouterConfig = {
    tenantId, orgId: tenantId, config,
    enabled: prev?.enabled ?? false,
    updatedBy: actor, updatedAt: new Date().toISOString(),
  };
  await configs.put(stored);
  return stored;
}

export async function setRouterEnabled(tenantId: string, actor: string, enabled: boolean): Promise<StoredRouterConfig> {
  const prev = await getRouterConfig(tenantId);
  if (!prev) throw new OpenwopError('not_found', 'No router config to enable; set rules first.', 404, {});
  const stored: StoredRouterConfig = { ...prev, enabled, updatedBy: actor, updatedAt: new Date().toISOString() };
  await configs.put(stored);
  return stored;
}

/**
 * DSAR (ADR 0464; code grade MR66CD-8) — the routing config is the workspace's,
 * so it is kept; the person who last saved it (`updatedBy`) becomes the erased-user
 * tombstone, as the workflow-budget and autonomy-policy stores do. Tenant-scoped:
 * a principal id is not issuer-qualified.
 */
export async function eraseRouterConfigSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey || subjectKey === ERASED_USER_REF) return { rowsTouched: 0 };
  const stored = await configs.get(workspaceKey(tenantId));
  if (!stored || !subjectKeyForms(subjectKey).forms.has(stored.updatedBy)) return { rowsTouched: 0 };
  await configs.put({ ...stored, updatedBy: ERASED_USER_REF });
  return { rowsTouched: 1 };
}

/**
 * ADR 0130 Phase 4c — route resolution WITH intent classification.
 *
 * Wraps `resolveModelRoute` (Phase 3a): when (and ONLY when) the tenant's config has
 * an `intentIs` rule, it classifies the turn intent (Phase 4b) and folds it into the
 * features before routing — so the cheap classify LLM call is paid only if a rule
 * actually needs it. The classifier is INJECTED (default `classifyTurnIntent`) so the
 * wiring is unit-testable without a live provider. Best-effort: a classify failure
 * routes without an intent (the rule simply doesn't match → fallback).
 *
 * @see docs/adr/0130-rule-based-model-router.md
 */
import { getRouterConfig } from './configService.js';
import { resolveModelRoute } from './resolveRoute.js';
import { classifyTurnIntent } from './classifyIntent.js';
import type { RouteDecision, RouteState, TurnFeatures } from './routeTurn.js';

type Classifier = (tenantId: string, userMessage: string) => Promise<string>;

export async function resolveModelRouteWithIntent(
  tenantId: string,
  orgId: string,
  features: TurnFeatures,
  userMessage: string,
  now: number,
  state?: RouteState,
  classify: Classifier = classifyTurnIntent,
): Promise<RouteDecision | null> {
  const stored = await getRouterConfig(tenantId, orgId);
  if (!stored || !stored.enabled) return null; // router off — caller keeps explicit model

  // Only classify if a rule actually consults the intent (avoid the extra LLM call).
  const needsIntent = stored.config.rules.some((r) => r.when.kind === 'intentIs');
  let enriched = features;
  if (needsIntent && features.intent === undefined && userMessage.trim().length > 0) {
    const intent = await classify(tenantId, userMessage);
    enriched = { ...features, intent };
  }
  return resolveModelRoute(tenantId, orgId, enriched, now, state);
}

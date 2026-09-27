/**
 * ADR 0130 Phase 3a — the integration-ready route resolver.
 *
 * `resolveModelRoute` reads the tenant's `ModelRouterConfig` (Phase 2), gates on
 * `enabled` (the toggle/flag), and runs the pure `routeTurn` selector (Phase 1)
 * with the REAL RFC 0031 capability probe. Returns the chosen target, or `null`
 * when the router is off/unconfigured — the caller then uses the run's explicit
 * provider/model unchanged. The dispatch-site override + the `run.metadata.modelRoute`
 * replay stamp are Phase 3b (the call-site wiring); this keeps the resolution
 * testable and decoupled from the dispatch hot path.
 */
import { probeProviderCapabilities } from '../../host/modelCapabilityProbe.js';
import { getRouterConfig } from './configService.js';
import { isRoutableProvider } from './routableProviders.js';
import { routeTurn, type RouteDecision, type RouteState, type TurnFeatures } from './routeTurn.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.model-router.resolveRoute');

export async function resolveModelRoute(
  tenantId: string,
  orgId: string,
  features: TurnFeatures,
  now: number,
  state?: RouteState,
): Promise<RouteDecision | null> {
  const stored = await getRouterConfig(tenantId, orgId);
  if (!stored || !stored.enabled) return null; // off → caller keeps the explicit provider/model
  const decision = routeTurn(features, stored.config, probeProviderCapabilities, now, state);
  // ADR 0610 D4 / MRC-2 — resolve-time belt: refuse to select a non-routable target
  // from a config that somehow bypassed the write-time allowlist (`asTarget`), so a
  // fresh stamp is never created from one. This does NOT guard an ALREADY-durable
  // `run.metadata.modelRoute` stamp (legacy/tampered/forked) — that read is guarded
  // at dispatch by `effectiveModelTarget` (`applyRoute.ts`), which ignores a stamp
  // naming a non-routable provider. The two together cover create + read.
  if (decision && !isRoutableProvider(decision.target.provider)) {
    log.warn('model_route_rejected_nonroutable_provider', { tenantId, orgId, provider: decision.target.provider, reason: decision.reason });
    return null;
  }
  // ADR 0714 D1 — the SECOND invariant belt, same posture as the routable-provider one
  // above (post-hoc check -> named warn -> null -> caller keeps the explicit model).
  // `routeTurn` now filters the fallback itself, so this is defence in depth rather than
  // the primary gate: it keeps the guarantee if a future caller reaches the selector by
  // another path. It is ALSO the only lane that reports the refusal — a silent decline
  // would leave an operator with a text-only fallback wondering why routing never
  // applies to their attachment turns (ADR 0708's lesson: the downgrade may be right,
  // its silence is not).
  if (decision && features.hasAttachment && !probeProviderCapabilities(decision.target.provider).includes('vision-input')) {
    log.warn('model_route_rejected_non_vision_target', { tenantId, orgId, provider: decision.target.provider, reason: decision.reason });
    return null;
  }
  if (!decision && features.hasAttachment) {
    log.warn('model_route_declined_no_vision_target', { tenantId, orgId });
  }
  return decision;
}

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
import { routeTurn, type RouteDecision, type RouteState, type TurnFeatures } from './routeTurn.js';

export async function resolveModelRoute(
  tenantId: string,
  orgId: string,
  features: TurnFeatures,
  now: number,
  state?: RouteState,
): Promise<RouteDecision | null> {
  const stored = await getRouterConfig(tenantId, orgId);
  if (!stored || !stored.enabled) return null; // off → caller keeps the explicit provider/model
  return routeTurn(features, stored.config, probeProviderCapabilities, now, state);
}

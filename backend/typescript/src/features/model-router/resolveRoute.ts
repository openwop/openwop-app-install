/**
 * ADR 0130 Phase 3a — the integration-ready route resolver.
 *
 * `resolveModelRoute` reads the workspace's `ModelRouterConfig` (Phase 2), gates
 * on `enabled` (the toggle/flag), and runs the pure `routeTurn` selector (Phase 1)
 * with the catalog-backed per-MODEL probe. Returns the chosen target, or `null`
 * when the router is off/unconfigured — the caller then uses the conversation's
 * own provider/model unchanged.
 *
 * ADR 1016 D3 — `resolveTurnModelRoute` is the chat exchange's ONE entry: called on
 * EVERY exchange, never stamped. Chat exchanges are never re-dispatched (replay
 * reads the recorded turn; `:fork` copies the transcript; a committed exchangeKey
 * returns the stored turns), so a per-turn decision costs no replay safety, and
 * what answered each turn is recorded by `host/turnAttribution.ts` (ADR 0986).
 *
 * ADR 0820 §8.2 — the feature is sellable (Governance bundle), and this resolver
 * sits inside every chat turn of three core modules. So a refusal DEGRADES, it
 * never errors: with `model-router` refused for the tenant (toggle off, plan
 * refusal, or an unreadable entitlement — `resolveOne` fails closed), no route is
 * resolved and the caller keeps the run's own model. A legacy route stamped on a
 * run before ADR 1016 is read by `effectiveModelTarget` and is not re-judged here.
 */
import { getRouterConfig } from './configService.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { dispatchableProviderOf, isRoutableProvider, listedModelCapabilities, type DispatchInputs } from './routableProviders.js';
import { routeTurn, type RouteDecision, type RouteState, type RoutingTarget, type TurnFeatures } from './routeTurn.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.model-router.resolveRoute');

export async function resolveModelRoute(
  tenantId: string,
  features: TurnFeatures,
  now: number,
  state?: RouteState,
): Promise<RouteDecision | null> {
  // ADR 0820 §8.2 — degrade, never refuse (see the header). The read is caught so a
  // toggle-store fault can never break a turn either.
  const access = await resolveOne('model-router', { tenantId }).catch(() => null);
  if (access?.enabled !== true) {
    if (access?.blockedBy) log.debug('model_route_feature_refused', { tenantId, blockedBy: access.blockedBy });
    return null;
  }
  const stored = await getRouterConfig(tenantId);
  if (!stored || !stored.enabled) return null; // off → caller keeps the explicit provider/model
  const decision = routeTurn(features, stored.config, listedModelCapabilities, now, state);
  // ADR 0610 D4 / MRC-2 — resolve-time belt: refuse to select a non-routable target
  // from a config that somehow bypassed the write-time allowlist (`asTarget`), so a
  // fresh stamp is never created from one. This does NOT guard an ALREADY-durable
  // `run.metadata.modelRoute` stamp (legacy/tampered/forked) — that read is guarded
  // at dispatch by `effectiveModelTarget` (`applyRoute.ts`), which ignores a stamp
  // naming a non-routable provider. The two together cover create + read.
  if (decision && !isRoutableProvider(decision.target.provider)) {
    log.warn('model_route_rejected_nonroutable_provider', { tenantId, provider: decision.target.provider, reason: decision.reason });
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
  if (decision && features.hasAttachment && !(listedModelCapabilities(decision.target.provider, decision.target.model) ?? []).includes('vision-input')) {
    log.warn('model_route_rejected_non_vision_target', { tenantId, provider: decision.target.provider, reason: decision.reason });
    return null;
  }
  if (!decision && features.hasAttachment) {
    log.warn('model_route_declined_no_vision_target', { tenantId });
  }
  return decision;
}

/** What a chat exchange knows about its turn. */
export interface TurnRouteInput {
  tenantId: string;
  /** The run's inputs (`provider`, `credentialRef`) — the conversation's own binding. */
  runInputs: DispatchInputs;
  /** The provider list the BYOK dispatch guard judges (`CREDENTIAL_PROVIDERS`),
   *  passed in so this pure-leaf feature never imports the provider host. */
  credentialProviders: readonly string[];
  userText: string;
  /** SERVER-derived (`ConversationMeta.type`), never client-asserted (Phase 6). */
  conversationKind?: string | undefined;
  /** The turn's REAL attachment presence (image/file parts). */
  hasAttachment?: boolean;
}

/**
 * ADR 1016 D3/D4 — this exchange's route, or `null` to keep the conversation's own
 * model. The dispatchable provider is decided FIRST and needs no I/O, so a managed,
 * subscription, compat or mock conversation (the default is managed) pays nothing
 * and is never routed. BEST-EFFORT: any failure keeps the conversation's own model
 * and never breaks the turn.
 */
export async function resolveTurnModelRoute(input: TurnRouteInput): Promise<RoutingTarget | null> {
  const dispatchProvider = dispatchableProviderOf(input.runInputs, input.credentialProviders);
  if (dispatchProvider === null) return null;
  try {
    const features: TurnFeatures = {
      tokenEstimate: Math.ceil(input.userText.length / 4),
      dispatchProvider,
      ...(input.conversationKind ? { conversationKind: input.conversationKind } : {}),
      ...(input.hasAttachment ? { hasAttachment: true } : {}),
    };
    const decision = await resolveModelRoute(input.tenantId, features, Date.now());
    return decision ? decision.target : null;
  } catch (e) {
    // CS-GB-3 — warn, not debug: a route that silently fails is a tenant on the
    // wrong tier with nothing in ops to say so.
    log.warn('model_route_resolve_failed', { tenantId: input.tenantId, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

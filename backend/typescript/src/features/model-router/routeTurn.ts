/**
 * ADR 0130 Phase 1 — the PURE per-turn model-routing selector.
 *
 * `routeTurn` chooses a `{provider, model}` for a turn from a tenant rule set,
 * subject to a capability FILTER (an attachment turn NEVER routes to a non-vision
 * target — the ADR invariant) and cooldown STICKINESS (a recently-chosen target
 * stays, to avoid thrashing). Pure + deterministic — no dispatch, no I/O, no clock
 * (the caller passes `now`). The dispatch call-site + the `run.metadata` replay
 * stamp are Phase 3; this is the testable core.
 */

export type RuleCondition =
  | { kind: 'always' }
  | { kind: 'attachment' }
  | { kind: 'tokensOver'; threshold: number }
  // ADR 0130 Phase 4 — route by a pre-classified turn intent (e.g. 'code', 'chat',
  // 'vision'). The classification is a FEATURE (`features.intent`) computed before
  // routing — the rule match stays pure + deterministic; the classifier is wired
  // separately (Phase 4b), so routeTurn carries no LLM dependency / replay risk.
  | { kind: 'intentIs'; intent: string };

export interface RoutingTarget { provider: string; model: string }
export interface RoutingRule { when: RuleCondition; target: RoutingTarget }

export interface ModelRouterConfig {
  rules: RoutingRule[];
  /** The default target when no rule matches (SHOULD be vision-capable so an
   *  attachment turn always has an eligible target). */
  fallback: RoutingTarget;
  /** Sticky window: a target chosen within this many ms is re-used. 0/undef = off. */
  cooldownMs?: number;
}

export interface TurnFeatures {
  hasAttachment?: boolean;
  tokenEstimate?: number;
  /** A pre-classified intent label (ADR 0130 Phase 4) for `intentIs` rules. */
  intent?: string;
}

export interface RouteState {
  lastTarget?: RoutingTarget;
  lastAtMs?: number;
}

export interface RouteDecision {
  target: RoutingTarget;
  reason: 'cooldown' | 'rule' | 'fallback';
}

/** Capability probe: provider → its supported capability ids (RFC 0031). */
export type CapabilityProbe = (provider: string) => readonly string[];

function eligible(t: RoutingTarget, features: TurnFeatures, probe: CapabilityProbe): boolean {
  // An attachment turn MUST route to a vision-capable target (ADR 0130 invariant).
  if (features.hasAttachment && !probe(t.provider).includes('vision')) return false;
  return true;
}

function matches(when: RuleCondition, features: TurnFeatures): boolean {
  switch (when.kind) {
    case 'always': return true;
    case 'attachment': return features.hasAttachment === true;
    case 'tokensOver': return (features.tokenEstimate ?? 0) > when.threshold;
    case 'intentIs': return features.intent === when.intent;
  }
}

/** Choose a target for this turn. Cooldown stickiness wins (if the sticky target
 *  is still eligible), then the first matching + eligible rule, then the fallback. */
export function routeTurn(
  features: TurnFeatures,
  config: ModelRouterConfig,
  probe: CapabilityProbe,
  now: number,
  state?: RouteState,
): RouteDecision {
  if (
    state?.lastTarget && state.lastAtMs !== undefined && config.cooldownMs &&
    now - state.lastAtMs < config.cooldownMs && eligible(state.lastTarget, features, probe)
  ) {
    return { target: state.lastTarget, reason: 'cooldown' };
  }
  for (const rule of config.rules) {
    if (matches(rule.when, features) && eligible(rule.target, features, probe)) {
      return { target: rule.target, reason: 'rule' };
    }
  }
  return { target: config.fallback, reason: 'fallback' };
}

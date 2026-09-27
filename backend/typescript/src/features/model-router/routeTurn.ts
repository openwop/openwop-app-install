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
  // ADR 0130 Phase 4 (`intentIs`) was RETIRED — CHAT-FIRST-PORT-AUDIT A8. The
  // ignition site never populated `features.intent` and the intent-classifier
  // subsystem had zero non-test callers, so the rule was dead theater. The kind
  // is gone from the type + the config validator; a config persisted with a
  // legacy `intentIs` rule is TOLERATED (the validator skips it, inert) rather
  // than crashing a tenant's saved config.
  // ADR 0130 Phase 5 (cost-router) — route by a COMPOSITE
  // difficulty tier so an operator writes ONE cost rule ("difficultyAtLeast:high
  // → premium; always → cheap") instead of hand-tuning tokensOver+attachment.
  // `classifyDifficulty` is a pure HEURISTIC over the existing
  // features (NO LLM judge → deterministic + replay-safe, unlike an LLM cost
  // judge that would add a call + non-determinism). Matches when the turn's
  // classified difficulty is >= `level`.
  | { kind: 'difficultyAtLeast'; level: DifficultyLevel }
  // ADR 0130 Phase 6 (board model-tier) — route by the CONVERSATION KIND, fed
  // SERVER-SIDE from ConversationMeta at the stamp site (never client-asserted).
  // Born of a real incident: a Board-of-Directors group chat ran on a small
  // default model and fabricated capabilities — its advisors were seeded
  // `modelClass:'reasoning'` but the inline path has no tier notion; this rule
  // lets a tenant say "multi-agent rooms get my strong model". The target stays
  // tenant-authored (a host default can't know which providers the tenant holds
  // keys for — a cross-provider auto-bump would break dispatch outright).
  // CORRECTION (CS-GB-1, 2026-07-09): "tenant-authored only" is amended — the
  // host now applies a SAME-provider class default for group reasoning agents
  // (`resolveConversationModelTarget` + providers.json `classDefaults`), which
  // never changes the provider, so the no-cross-provider ruling stands. A
  // tenant rule (this kind) still wins outright over that default.
  | { kind: 'conversationKind'; value: 'group' | 'workspace' | 'channel' };

export type DifficultyLevel = 'low' | 'medium' | 'high';
const DIFFICULTY_ORDER: Record<DifficultyLevel, number> = { low: 0, medium: 1, high: 2 };

/** Bump a difficulty level up one, capped at `high`. */
function bumpDifficulty(level: DifficultyLevel): DifficultyLevel {
  return level === 'low' ? 'medium' : 'high';
}

/**
 * Pure, deterministic difficulty heuristic over a turn's features — the free,
 * replay-safe stand-in for an LLM "cost judge". Token tiers set the base
 * (<500 low, <4000 medium, else high); an attachment (multimodal) bumps one
 * level (capped at high). No I/O, no clock, no model call. (The retired
 * intent bump — CHAT-FIRST-PORT-AUDIT A8 — is gone with the `intentIs` kind.)
 */
export function classifyDifficulty(features: TurnFeatures): DifficultyLevel {
  const tokens = features.tokenEstimate ?? 0;
  let level: DifficultyLevel = tokens >= 4000 ? 'high' : tokens >= 500 ? 'medium' : 'low';
  if (features.hasAttachment) level = bumpDifficulty(level);
  return level;
}

export interface RoutingTarget { provider: string; model: string }
export interface RoutingRule { when: RuleCondition; target: RoutingTarget }

export interface ModelRouterConfig {
  rules: RoutingRule[];
  /** The default target when no rule matches. Subject to the SAME capability filter
   *  as the rules (ADR 0714 D1/D2): if it is not vision-capable, an ATTACHMENT turn
   *  yields no decision at all rather than an ineligible one, and the caller keeps the
   *  run's explicit model. (This docblock previously said the fallback "SHOULD be
   *  vision-capable" while `eligible()` twelve lines below called the same rule a MUST —
   *  one file, two strengths for one invariant, and the weaker wording sat on the one
   *  lane that was not enforced. That contradiction is how the gap survived.) */
  fallback: RoutingTarget;
  /** Sticky window: a target chosen within this many ms is re-used. 0/undef = off. */
  cooldownMs?: number;
}

export interface TurnFeatures {
  /** The turn carries a visual/document attachment (an image or file part). Fed
   *  at the dispatch ignition site from the real turn content — CHAT-FIRST-PORT
   *  A8 (previously never populated, so `attachment` rules were dead). Drives
   *  the `attachment` rule, the vision-eligibility filter, and the multimodal
   *  difficulty bump. */
  hasAttachment?: boolean;
  tokenEstimate?: number;
  /** The conversation's server-side kind (`ConversationMeta.type` — 'group' for
   *  board rooms, 'workspace', 'channel'; ADR 0130 Phase 6). Absent for 1:1 /
   *  ungrouped chats and for surfaces with no conversation meta. */
  conversationKind?: string;
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
  // The capability id is the RFC 0031 §C / RFC 0055 canonical `vision-input`
  // (model accepts image content) — corrected from the non-canonical `vision`
  // the probe never advertised (CHAT-FIRST-PORT A8: nothing satisfied it, so an
  // attachment turn always fell through to the fallback and the rule never fired).
  if (features.hasAttachment && !probe(t.provider).includes('vision-input')) return false;
  return true;
}

function matches(when: RuleCondition, features: TurnFeatures): boolean {
  switch (when.kind) {
    case 'always': return true;
    case 'attachment': return features.hasAttachment === true;
    case 'tokensOver': return (features.tokenEstimate ?? 0) > when.threshold;
    case 'difficultyAtLeast':
      return DIFFICULTY_ORDER[classifyDifficulty(features)] >= DIFFICULTY_ORDER[when.level];
    case 'conversationKind': return features.conversationKind === when.value;
  }
}

/** Choose a target for this turn. Cooldown stickiness wins (if the sticky target
 *  is still eligible), then the first matching + eligible rule, then the fallback —
 *  which is filtered TOO (ADR 0714 D1).
 *
 *  Returns `null` when NO eligible target exists, i.e. the turn carries an attachment
 *  and even the fallback is not vision-capable. Null means "do not route": the caller
 *  keeps the run's explicit provider/model, which is exactly this router's documented
 *  OFF posture. Routing to a target we have just judged ineligible would make the
 *  router the proximate cause of the turn's failure AND freeze that target into
 *  `run.metadata.modelRoute`, which `:fork` then replays verbatim forever.
 *
 *  NOTE (ADR 0714, MRC-6): the cooldown branch below is unreachable in production —
 *  the one production caller passes no `state`. It is retained (and filtered) so that
 *  wiring `RouteState` later cannot reintroduce the hole this ADR closes. */
export function routeTurn(
  features: TurnFeatures,
  config: ModelRouterConfig,
  probe: CapabilityProbe,
  now: number,
  state?: RouteState,
): RouteDecision | null {
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
  // ADR 0714 D1 — the fallback is NOT exempt from the invariant `eligible()` states.
  // Before this, it was the one lane that escaped, so an attachment turn on a tenant
  // whose fallback is text-only routed to a non-vision target and that decision was
  // then STAMPED durably.
  if (!eligible(config.fallback, features, probe)) return null;
  return { target: config.fallback, reason: 'fallback' };
}

/**
 * ADR 0397 Phase 2 — the policy SIMULATOR.
 *
 * Evaluate a hypothetical action against a tenant's CURRENT stored rules with NO side
 * effects: no run is read, nothing is written (no decision-log entry, no store mutation).
 * It re-runs the pure `explainComposition` (the same `matchRule` truth the live loop uses)
 * and mirrors the live hook's evaluation shape — the unclassified-`skip` short-circuit and
 * the mode-independent platform floor (risky fallback) — so a simulated verdict matches the
 * live verdict for the same input. (For a `shadow` mode the reported decision is the WOULD-BE
 * block, the migration preview; the live loop records that and applies allow.)
 *
 * Exposed two ways: the pure service function `simulateFirewall` (CI / in-process
 * pre-flight) and the `POST …/simulate` route (`workspace:read`). `modeOverride` makes it
 * a planning tool — an admin in `default-allow` can ask "what WOULD enforce decide?".
 *
 * @see docs/adr/0397-capability-firewall-default-deny-simulator.md
 */
import { classesOf, explainComposition, type FirewallExplanation, type FirewallMode, type RuleTrace } from './compositionEvaluator.js';
import { RISKY_FALLBACK } from './firewallHook.js';
import { resolveToolCapability } from './toolCapabilityResolver.js';
import { getCapabilityRules, getUnknownToolPolicy, getFirewallMode, getDefaultDenyVerdict, getPlatformRules, type UnknownToolPolicy } from './ruleStore.js';
import type { CapabilityClass } from './types.js';

/** An action item: either a raw capability class or a tool name to resolve. */
export type SimAction = CapabilityClass | { toolName: string };

export interface SimulateInput {
  /** Prior calls this turn (classes or resolvable tool names). */
  seen?: SimAction[];
  /** The action under test. */
  next: SimAction;
  context?: { unknownToolPolicy?: UnknownToolPolicy };
  /** "What WOULD this mode decide?" without switching the org (default: current/effective). */
  modeOverride?: FirewallMode;
}

export interface SimulateResult extends FirewallExplanation {
  /** The effective mode used for the simulation. */
  mode: FirewallMode;
  /** ADR 0397 Phase 5 — the superadmin platform-baseline rules that also applied
   *  (read-only; a platform floor a tenant cannot weaken). Absent ⇒ no platform floor. */
  platformBaseline?: RuleTrace[];
}

const rankDecision = (d: 'allow' | 'deny' | 'require-approval'): number => (d === 'deny' ? 2 : d === 'require-approval' ? 1 : 0);

const isToolRef = (a: SimAction): a is { toolName: string } => typeof (a as { toolName?: unknown }).toolName === 'string';

/** Resolve one action to its class keys, mirroring the live hook's `resolve`. `forceRisky`
 *  (for the PLATFORM floor) applies the risky fallback for an unresolved tool regardless of
 *  the tenant's `unknownToolPolicy` — so a tenant's `skip` cannot drop the operator's floor. */
function actionKeys(a: SimAction, unknownToolPolicy: UnknownToolPolicy, forceRisky = false): string[] {
  if (!isToolRef(a)) {
    // A raw class → its single membership key (classesOf expects a descriptor, so key it directly).
    if ('safetyTier' in a) return [`safetyTier:${a.safetyTier}`];
    if ('egress' in a) return [`egress:${a.egress}`];
    if ('kind' in a) return [`kind:${a.kind}`];
    return [`scope:${a.scope}`];
  }
  const d = resolveToolCapability(a.toolName);
  if (d) return classesOf(d);
  return forceRisky || unknownToolPolicy === 'treat-as-risky' ? classesOf(RISKY_FALLBACK) : []; // 'skip' ⇒ no classes
}

function seenFrom(actions: SimAction[] | undefined, unknownToolPolicy: UnknownToolPolicy, forceRisky: boolean): { seenKeys: Set<string>; seenCounts: Map<string, number> } {
  const seenKeys = new Set<string>();
  const seenCounts = new Map<string, number>();
  for (const a of actions ?? []) {
    for (const k of actionKeys(a, unknownToolPolicy, forceRisky)) {
      seenKeys.add(k);
      seenCounts.set(k, (seenCounts.get(k) ?? 0) + 1);
    }
  }
  return { seenKeys, seenCounts };
}

/**
 * Simulate a firewall verdict for a tenant with zero side effects. Mirrors the live hook's
 * evaluation (same `matchRule` truth, same unclassified-`skip` short-circuit, same platform
 * floor + most-restrictive combine), reading the tenant's CURRENT stored rules + posture.
 * For a `shadow` mode the reported `decision` is the WOULD-BE block (the migration preview);
 * live records that and applies allow.
 */
export async function simulateFirewall(tenantId: string, input: SimulateInput): Promise<SimulateResult> {
  const rules = await getCapabilityRules(tenantId);
  const unknownToolPolicy = input.context?.unknownToolPolicy ?? (await getUnknownToolPolicy(tenantId));
  // Effective mode: an explicit `modeOverride` previews a hypothetical posture; otherwise
  // the simulator reflects the tenant's CURRENT stored mode (ADR 0397 P3).
  const mode: FirewallMode = input.modeOverride ?? (await getFirewallMode(tenantId));
  const defaultDenyVerdict = await getDefaultDenyVerdict(tenantId);

  const { seenKeys, seenCounts } = seenFrom(input.seen, unknownToolPolicy, false);
  const nextKeys = actionKeys(input.next, unknownToolPolicy);

  // Tenant verdict — mirror the live short-circuit: an unclassified next under `skip`
  // (nextKeys empty) skips ALL rule evaluation; only the mode fall-through applies.
  let explanation: FirewallExplanation;
  if (nextKeys.length === 0) {
    const decision: 'allow' | 'deny' | 'require-approval' = mode === 'default-allow' ? 'allow' : defaultDenyVerdict;
    explanation = {
      decision,
      fellThroughToDefault: true,
      trace: [],
      ...(mode === 'default-allow' ? {} : { reason: `Unclassified tool under 'skip' — ${mode === 'shadow' ? 'shadow (log-only)' : 'default-deny'} ⇒ ${decision}.` }),
    };
  } else {
    explanation = explainComposition(seenKeys, nextKeys, rules, { seenCounts, mode, defaultDenyVerdict });
  }

  // ADR 0397 P5 — the platform floor ANDs under the tenant verdict (most-restrictive wins).
  // Mode-independent, and robust to unclassified tools (risky fallback — a tenant `skip`
  // can't drop it), matching the live hook. Surfaced read-only.
  const platformRules = await getPlatformRules();
  if (platformRules.length === 0) return { ...explanation, mode };
  const platformNextKeys = nextKeys.length > 0 ? nextKeys : classesOf(RISKY_FALLBACK);
  const platformSeen = seenFrom(input.seen, unknownToolPolicy, true);
  const platform = explainComposition(platformSeen.seenKeys, platformNextKeys, platformRules, { seenCounts: platformSeen.seenCounts, mode: 'default-allow' });
  const effective: FirewallExplanation = rankDecision(platform.decision) > rankDecision(explanation.decision)
    ? { ...explanation, decision: platform.decision, ...(platform.matchedRuleId ? { matchedRuleId: platform.matchedRuleId } : {}), ...(platform.reason ? { reason: platform.reason } : {}), fellThroughToDefault: false }
    : explanation;
  return { ...effective, mode, platformBaseline: platform.trace };
}

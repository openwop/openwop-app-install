/**
 * ADR 0135 Phase 1 — the PURE composition evaluator.
 *
 * Decides allow / deny / require-approval for a tool call given the capability CLASSES
 * the run has already exercised plus the classes of the tool about to run. The
 * load-bearing semantic (architect refinement): a rule's `anyOf` is matched against
 * `seen ∪ next`, so the firewall catches BOTH cross-call composition (tool A reads → tool
 * B egresses) AND within-call composition (a single tool that both reads and egresses) —
 * the latter is exfiltration in one call and must not slip through on first use.
 *
 * Pure: no I/O, no clock. The P2 loop boundary supplies `seenKeys` (rebuilt from recorded
 * `agent.toolCalled` events for replay-safety) + maps each tool → ToolCapabilityDescriptor.
 *
 * @see docs/adr/0135-capability-firewall.md
 */
import { evalExpression, parseExpression } from './expressionEvaluator.js';
import type { CapabilityClass, CapabilityRule, CapabilityVerdict, FirewallMode, ToolCapabilityDescriptor } from './types.js';

export type { FirewallMode } from './types.js';

/** Serialize a class to a stable membership key. */
export function classKey(c: CapabilityClass): string {
  if ('safetyTier' in c) return `safetyTier:${c.safetyTier}`;
  if ('egress' in c) return `egress:${c.egress}`;
  if ('kind' in c) return `kind:${c.kind}`;
  return `scope:${c.scope}`;
}

/** The capability-class keys a single tool belongs to. */
export function classesOf(d: ToolCapabilityDescriptor): string[] {
  const keys = [`safetyTier:${d.safetyTier}`];
  if (d.egress) keys.push(`egress:${d.egress}`);
  for (const s of d.scopes ?? []) keys.push(`scope:${s}`);
  if (d.kind) keys.push(`kind:${d.kind}`);
  return keys;
}

const matchesAny = (classes: CapabilityClass[] | undefined, keys: Set<string>): boolean =>
  classes === undefined || classes.length === 0 || classes.some((c) => keys.has(classKey(c)));

/** The predicate kind a rule uses (validation enforces exactly one at save time). */
type PredicateKind = 'presence' | 'countAtLeast' | 'expression';

/** The membership facts a single evaluation is over. Built once per call and shared by
 *  `evaluateComposition` (hot path) and `explainComposition` (trace) so the two can never
 *  drift — one truth for matching (ADR 0397 §Rule-match explanation model). */
interface MatchContext {
  seenKeys: ReadonlySet<string>;
  nextSet: Set<string>;
  anyOfUniverse: Set<string>;
  seenCounts: ReadonlyMap<string, number>;
  totalCounts: ReadonlyMap<string, number>;
}

function buildMatchContext(
  seenKeys: ReadonlySet<string>,
  nextKeys: readonly string[],
  seenCounts?: ReadonlyMap<string, number>,
): MatchContext {
  const nextSet = new Set(nextKeys);
  const anyOfUniverse = new Set<string>([...seenKeys, ...nextKeys]); // seen ∪ next (within-call aware)
  const totalCounts = new Map<string, number>(seenCounts ?? []);
  for (const k of nextSet) totalCounts.set(k, (totalCounts.get(k) ?? 0) + 1);
  return { seenKeys, nextSet, anyOfUniverse, seenCounts: seenCounts ?? new Map(), totalCounts };
}

/** Does a single rule fire against the context? The ONE matching truth. */
function matchRule(rule: CapabilityRule, ctx: MatchContext): { matched: boolean; predicateKind: PredicateKind } {
  if (rule.when.expression !== undefined) {
    return { matched: matchesExpression(rule.when.expression, ctx.seenKeys, ctx.nextSet, ctx.totalCounts), predicateKind: 'expression' };
  }
  if (rule.when.countAtLeast) {
    const key = classKey(rule.when.countAtLeast.class);
    const effectiveCount = (ctx.seenCounts.get(key) ?? 0) + (ctx.nextSet.has(key) ? 1 : 0);
    return { matched: effectiveCount >= rule.when.countAtLeast.threshold, predicateKind: 'countAtLeast' };
  }
  const anyOfHit = matchesAny(rule.when.anyOf, ctx.anyOfUniverse);
  const withHit = matchesAny(rule.when.with, ctx.nextSet);
  return { matched: anyOfHit && withHit, predicateKind: 'presence' };
}

/**
 * Evaluate the rule set for a tool call.
 *
 * A rule uses EXACTLY ONE predicate kind — presence (`anyOf`/`with`), `countAtLeast`
 * (ADR 0135 Phase 5, composition-VOLUME), or `expression` (Phase 6). Rules are ordered;
 * first match wins. Matching runs through the shared `matchRule` (one truth, so the
 * simulator's `explainComposition` can never disagree with the live verdict).
 *
 * @param seenKeys class keys exercised by PRIOR tool calls this turn.
 * @param nextKeys class keys of the tool about to run (from `classesOf`).
 * @param rules ordered; first match wins.
 * @param seenCounts per-class-key count of PRIOR tool calls this turn (for `countAtLeast`
 *   / `count.*` expression facts). Absent ⇒ treated as zero.
 */
export function evaluateComposition(
  seenKeys: ReadonlySet<string>,
  nextKeys: readonly string[],
  rules: readonly CapabilityRule[],
  seenCounts?: ReadonlyMap<string, number>,
): CapabilityVerdict {
  const ctx = buildMatchContext(seenKeys, nextKeys, seenCounts);
  for (const rule of rules) {
    if (matchRule(rule, ctx).matched) {
      return { decision: rule.verdict, ruleId: rule.id, reason: rule.reason };
    }
  }
  return { decision: 'allow' };
}

/** One row of a simulator/decision-log trace: why a rule did or didn't fire. */
export interface RuleTrace {
  ruleId: string;
  predicateKind: PredicateKind;
  matched: boolean;
  why: string;
}

export interface FirewallExplanation {
  decision: 'allow' | 'deny' | 'require-approval';
  matchedRuleId?: string;
  matchedClause?: string;
  reason?: string;
  /** No rule matched ⇒ the mode's default posture applied. */
  fellThroughToDefault: boolean;
  trace: RuleTrace[];
}

/**
 * Explain the rule set's verdict for a hypothetical action — the pure, side-effect-free
 * engine behind the simulator (ADR 0397 §Phase 2) and the decision-log attribution.
 * Uses the SAME `matchRule` as `evaluateComposition`, then adds a per-rule trace + the
 * mode-aware default handling. First matching rule wins (as live); every rule still gets
 * a trace row so an operator sees which fired and which didn't.
 *
 * @param opts.mode the effective mode (default `default-allow`). Under `enforce` a
 *   fall-through resolves to `defaultDenyVerdict`; under `shadow` the fall-through verdict
 *   is what WOULD block (the caller applies allow). Under `default-allow` fall-through = allow.
 * @param opts.defaultDenyVerdict the posture for an unmatched action under deny modes
 *   (default `deny`).
 */
export function explainComposition(
  seenKeys: ReadonlySet<string>,
  nextKeys: readonly string[],
  rules: readonly CapabilityRule[],
  opts: { seenCounts?: ReadonlyMap<string, number>; mode?: FirewallMode; defaultDenyVerdict?: 'deny' | 'require-approval' } = {},
): FirewallExplanation {
  const ctx = buildMatchContext(seenKeys, nextKeys, opts.seenCounts);
  const mode: FirewallMode = opts.mode ?? 'default-allow';
  const defaultDenyVerdict = opts.defaultDenyVerdict ?? 'deny';
  const trace: RuleTrace[] = [];
  let firstMatch: CapabilityRule | undefined;
  for (const rule of rules) {
    const { matched, predicateKind } = matchRule(rule, ctx);
    if (matched && !firstMatch) firstMatch = rule;
    // First-match-wins: rules after the first match do not fire live, so mark them
    // superseded rather than "matched" to mirror runtime precedence honestly.
    const effectiveMatched = matched && (!firstMatch || firstMatch.id === rule.id);
    trace.push({ ruleId: rule.id, predicateKind, matched: effectiveMatched, why: explainWhy(rule, predicateKind, matched, firstMatch, ctx) });
  }
  if (firstMatch) {
    return {
      decision: firstMatch.verdict,
      matchedRuleId: firstMatch.id,
      matchedClause: describeClause(firstMatch),
      ...(firstMatch.reason ? { reason: firstMatch.reason } : {}),
      fellThroughToDefault: false,
      trace,
    };
  }
  // No rule matched — the mode's default posture applies.
  const decision: 'allow' | 'deny' | 'require-approval' = mode === 'default-allow' ? 'allow' : defaultDenyVerdict;
  return {
    decision,
    fellThroughToDefault: true,
    ...(mode === 'default-allow' ? {} : { reason: `No rule matched — ${mode === 'shadow' ? 'shadow (log-only)' : 'default-deny'} ⇒ ${decision}.` }),
    trace,
  };
}

/** A short human clause naming a rule's predicate (for `matchedClause`/trace). */
function describeClause(rule: CapabilityRule): string {
  if (rule.when.expression !== undefined) return `expression: ${rule.when.expression}`;
  if (rule.when.countAtLeast) return `${classKey(rule.when.countAtLeast.class)} ≥ ${rule.when.countAtLeast.threshold} per turn`;
  const any = (rule.when.anyOf ?? []).map(classKey).join(' | ') || '(any)';
  const wth = (rule.when.with ?? []).map(classKey).join(' | ') || '(any)';
  return `seen ${any} → next ${wth}`;
}

/** A factual, non-PII reason a rule did/didn't fire (or was superseded). */
function explainWhy(rule: CapabilityRule, predicateKind: PredicateKind, matched: boolean, firstMatch: CapabilityRule | undefined, ctx: MatchContext): string {
  if (matched && firstMatch && firstMatch.id !== rule.id) return `would match (${describeClause(rule)}) but an earlier rule already decided`;
  if (matched) return `matched: ${describeClause(rule)}`;
  if (predicateKind === 'countAtLeast' && rule.when.countAtLeast) {
    const key = classKey(rule.when.countAtLeast.class);
    const effective = (ctx.seenCounts.get(key) ?? 0) + (ctx.nextSet.has(key) ? 1 : 0);
    return `no match: ${key} count ${effective} < ${rule.when.countAtLeast.threshold}`;
  }
  return `no match: ${describeClause(rule)}`;
}

/** Parse-and-evaluate an expression predicate. A malformed expression fails CLOSED at
 *  save time (validateRules), so a stored rule parses; if a persisted one somehow doesn't,
 *  it simply does not match here (never grants). */
function matchesExpression(
  src: string,
  seen: ReadonlySet<string>,
  next: ReadonlySet<string>,
  counts: ReadonlyMap<string, number>,
): boolean {
  const parsed = parseExpression(src);
  return parsed.ok && evalExpression(parsed.ast, { seen, next, counts });
}

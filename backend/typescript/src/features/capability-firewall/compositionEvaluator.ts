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
import type { CapabilityClass, CapabilityRule, CapabilityVerdict, ToolCapabilityDescriptor } from './types.js';

/** Serialize a class to a stable membership key. */
export function classKey(c: CapabilityClass): string {
  if ('safetyTier' in c) return `safetyTier:${c.safetyTier}`;
  if ('egress' in c) return `egress:${c.egress}`;
  return `scope:${c.scope}`;
}

/** The capability-class keys a single tool belongs to. */
export function classesOf(d: ToolCapabilityDescriptor): string[] {
  const keys = [`safetyTier:${d.safetyTier}`];
  if (d.egress) keys.push(`egress:${d.egress}`);
  for (const s of d.scopes ?? []) keys.push(`scope:${s}`);
  return keys;
}

const matchesAny = (classes: CapabilityClass[] | undefined, keys: Set<string>): boolean =>
  classes === undefined || classes.length === 0 || classes.some((c) => keys.has(classKey(c)));

/**
 * Evaluate the rule set for a tool call.
 * @param seenKeys class keys exercised by PRIOR tool calls this run.
 * @param nextKeys class keys of the tool about to run (from `classesOf`).
 * @param rules ordered; first match wins.
 */
export function evaluateComposition(
  seenKeys: ReadonlySet<string>,
  nextKeys: readonly string[],
  rules: readonly CapabilityRule[],
): CapabilityVerdict {
  const nextSet = new Set(nextKeys);
  const anyOfUniverse = new Set<string>([...seenKeys, ...nextKeys]); // seen ∪ next (within-call aware)
  for (const rule of rules) {
    const anyOfHit = matchesAny(rule.when.anyOf, anyOfUniverse);
    const withHit = matchesAny(rule.when.with, nextSet);
    if (anyOfHit && withHit) {
      return { decision: rule.verdict, ruleId: rule.id, reason: rule.reason };
    }
  }
  return { decision: 'allow' };
}

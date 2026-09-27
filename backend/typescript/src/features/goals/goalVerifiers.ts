/**
 * Goal-verifier registry (ADR 0412 P1) — the RFC 0090 judge PORT for standing
 * goals.
 *
 * The host's verifier ladder is turn-scoped (an injected `AgentVerifier` in
 * `agentDispatch.ts`), not a callable evidence-judging service — so goals
 * mirrors the same injection idiom at its own boundary: a consumer registers a
 * verifier under the ref a goal names in `completion.verifierRef`, and
 * `evaluateGoal` resolves + invokes it. This keeps goals the single transition
 * authority (the verifier only returns a verdict; it never writes state) and
 * lets a feature (e.g. KickTodo) supply its evaluator without a cross-feature
 * import.
 *
 * Fail-closed contract: an unregistered ref or a throwing/malformed verifier
 * NEVER completes a goal — `evaluateGoal` surfaces a typed error and leaves
 * the goal untouched (unlike the chat turn path, which fails open by design).
 */

import type { Goal, GoalEvidence, GoalVerdict } from './types.js';

/** A verdict plus the judge's optional escalation signal (RFC 0097 §B —
 *  `escalated` is a judge-owned terminal distinct from mere non-satisfaction). */
export type GoalVerifierVerdict = GoalVerdict & { escalate?: boolean };

export type GoalVerifier = (args: {
  goal: Goal;
  evidence: GoalEvidence;
}) => Promise<GoalVerifierVerdict>;

const registry = new Map<string, GoalVerifier>();

/** Register (or replace) the verifier for `ref`. Last registration wins —
 *  re-registration is the supported hot-reload path for feature boot order. */
export function registerGoalVerifier(ref: string, verifier: GoalVerifier): void {
  registry.set(ref, verifier);
}

export function resolveGoalVerifier(ref: string): GoalVerifier | undefined {
  return registry.get(ref);
}

/** Test seam. */
export function __clearGoalVerifiers(): void {
  registry.clear();
}

/**
 * Agent-profile policy resolver (ADR 0036) — the single pure function that
 * turns an agent's `agentProfile` (ADR 0031) + its connection readiness (ADR
 * 0033) into a verdict for ONE action class, at the moment the agent is about
 * to take a tool/action or auto-run on heartbeat.
 *
 * Day-1 (ADR 0031 §Open-questions) `permissions`/`hitl`/`withinPolicyActions`
 * were advisory + displayed; only `requiredConnections` activation-gating was
 * enforced. This module makes the policy fields ENFORCED, composing with the
 * already-enforced readiness gate so a verdict is the *most restrictive* of all
 * the inputs — never a second store, never a parallel evaluator (ADR 0028's
 * "configure the enforcement points that already exist" discipline).
 *
 * It owns NO store: the profile lives on `agentProfileService` (ADR 0031), the
 * readiness on `connectionReadiness` (ADR 0033), and the action-kind admin
 * policy on `governanceService` (ADR 0028). This is pure resolution over those
 * existing owners, so it composes at any enforcement seam without an extra read
 * (the caller passes what it already resolved).
 *
 * Action classes are matched by EXACT string id against `permissions.never`,
 * `hitl`, and `autonomy.withinPolicyActions`. The seed profiles use a single
 * dotted namespace for these (e.g. `email.send`, `crm.stage-advance`,
 * `ticket.tag`) which is the same namespace as the assistant `PendingActionKind`
 * (`email.send`, `calendar.invite`, …) and the heartbeat workflow ids — so a
 * caller passes the action-class id it already has.
 *
 * @see docs/adr/0036-agent-profile-policy-enforcement.md
 * @see src/host/agentProfileService.ts   — the profile (owner)
 * @see src/host/connectionReadiness.ts    — the readiness gate (composed)
 * @see src/host/governanceService.ts      — ADR 0028 action-kind admin policy
 */

import type { AgentProfile } from '../types.js';
import { gateAutonomyByReadiness, type ConnectionReadiness } from './connectionReadiness.js';

/** The resolved disposition for one action class. Ordered most→least
 *  restrictive: a verdict is always the most restrictive of every input.
 *
 *  `deny` < `review` < `guided` < `auto`. The resolver never *widens* the
 *  caller's base level — it only ever holds it or lowers it. */
export type PolicyVerdict =
  /** Hard-denied — the action class is on `permissions.never`. Fail-closed: the
   *  caller MUST NOT enqueue, draft, or run it (not even for approval). */
  | 'deny'
  /** Force a human approval — the caller proposes (queues an approval) and
   *  never auto-executes, regardless of autonomy level. */
  | 'review'
  /** Conditional autonomy — the agent is at `guided` and the action class is
   *  not forbidden/hitl. The CALLER applies its own guided middle-rule (e.g.
   *  the heartbeat: run routine picks, propose HIGH-priority ones). The
   *  resolver only confirms the action class is permitted at `guided`. */
  | 'guided'
  /** Permitted to auto-run — the agent is at `auto` and the action class is on
   *  the `withinPolicyActions` allowlist (and readiness is satisfied). */
  | 'auto';

/** Why a verdict resolved the way it did — for logging, the proposal string,
 *  and tests. */
export type PolicyReason =
  | 'permissions.never'
  | 'hitl'
  | 'connection-readiness'
  | 'not-within-policy'
  | 'within-policy'
  | 'autonomy-level'
  | 'ungated';

export interface PolicyResolution {
  verdict: PolicyVerdict;
  reason: PolicyReason;
}

/** A profile-less / requirement-less agent at a given base level is ungated:
 *  the verdict is just the base level (no profile policy to apply). */
const READINESS_NONE: ConnectionReadiness = { required: [], entries: [], allConfigured: true, missing: [] };

/**
 * Resolve the policy verdict for `actionClass` given the agent's `profile`, the
 * base autonomy `level` the caller would otherwise act at, and the already
 * resolved connection `readiness`. Pure + side-effect-free.
 *
 * Composition order — MOST RESTRICTIVE WINS:
 *
 *  1. `permissions.never` ⊇ actionClass  → `deny` (fail-closed; short-circuits).
 *  2. `hitl` ⊇ actionClass               → `review` (force approval; never auto,
 *     never deny — regardless of autonomy level or readiness).
 *  3. Readiness gate (ADR 0033): if not all required connections are
 *     configured, the effective level is forced to `review`
 *     (`gateAutonomyByReadiness`).
 *  4. Autonomy:
 *       - effective level `auto`  → `auto` ONLY if `withinPolicyActions`
 *         includes actionClass; otherwise `review`. An EMPTY or ABSENT
 *         allowlist at `auto` permits NOTHING to auto-run (conservative,
 *         fail-closed): "autonomous within policy" with no policy = no
 *         autonomy. Anything off-list → `review`.
 *       - effective level `guided` / `review` → `review` here. (The caller's
 *         own `guided` middle-rule — run routine, propose HIGH-priority —
 *         layers ON TOP of this resolver; this module only decides whether the
 *         action class is permitted to auto-run at all, not the priority split.)
 *
 * `level` defaults to the profile's enforced `autonomy.level`; pass it
 * explicitly when the caller has a per-pick level (e.g. the heartbeat).
 */
export function resolveAgentPolicy(args: {
  profile: AgentProfile | null;
  actionClass: string;
  level?: 'auto' | 'guided' | 'review';
  readiness?: ConnectionReadiness;
}): PolicyResolution {
  const { profile, actionClass } = args;
  const readiness = args.readiness ?? READINESS_NONE;
  const baseLevel = args.level ?? profile?.autonomy.level ?? 'review';

  // 1. permissions.never — hard deny, fail-closed, short-circuits everything
  //    (applies even with no profile-derived level; checked first).
  if (profile?.permissions?.never?.includes(actionClass)) {
    return { verdict: 'deny', reason: 'permissions.never' };
  }

  // 2. hitl — always force an approval for this action class, regardless of
  //    autonomy level or readiness. Never auto; never deny.
  if (profile?.hitl?.includes(actionClass)) {
    return { verdict: 'review', reason: 'hitl' };
  }

  // 3. Compose the readiness gate (ADR 0033): an un-ready integration forces
  //    review. Most-restrictive: this can only lower `auto`/`guided` → review.
  const effective = gateAutonomyByReadiness(baseLevel, readiness);
  if (effective === 'review') {
    return {
      verdict: 'review',
      reason: readiness.allConfigured ? 'autonomy-level' : 'connection-readiness',
    };
  }

  // No profile: no withinPolicyActions allowlist to apply — the (readiness-
  // gated) base level passes through, exactly as the pre-0036 seams behaved
  // (back-compat: an ungated agent is unchanged).
  if (!profile) {
    return { verdict: effective, reason: 'autonomy-level' };
  }

  // 4a. Effective level `guided` — the action class is permitted; the caller
  //     applies its own guided middle-rule (priority split). Not forbidden /
  //     not hitl, so it rides through at `guided`.
  if (effective === 'guided') {
    return { verdict: 'guided', reason: 'autonomy-level' };
  }

  // 4b. Effective level `auto`. The `withinPolicyActions` allowlist gates auto
  //     ONLY for an agent whose autonomy COMES FROM `autonomous-within-policy`
  //     — that is the spec level whose whole contract is "act autonomously, but
  //     only within this allowlist" (ADR 0031 mapping table). For that agent the
  //     allowlist is authoritative: on-list → auto; off-list → review; and an
  //     EMPTY or ABSENT allowlist permits NOTHING to auto-run (conservative /
  //     fail-closed — "within policy" with no policy = no autonomy).
  //
  //     An agent that is `auto` for any OTHER reason — a manual roster-level
  //     override, or a profile without the within-policy spec level — has no
  //     within-policy contract to apply, so its (readiness-gated) auto passes
  //     through unchanged. This keeps the existing "set a twin to auto → it
  //     runs directly" guarantee (approvals.test.ts) honest while making the
  //     `autonomous-within-policy` allowlist the real gate it claims to be.
  if (profile.autonomy.specLevel !== 'autonomous-within-policy') {
    return { verdict: 'auto', reason: 'autonomy-level' };
  }
  const allowlist = profile.autonomy.withinPolicyActions ?? [];
  if (allowlist.includes(actionClass)) {
    return { verdict: 'auto', reason: 'within-policy' };
  }
  return { verdict: 'review', reason: 'not-within-policy' };
}

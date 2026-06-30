/**
 * ADR 0132 Phase 1 — the PURE capability-scope resolver.
 *
 * Resolves a per-conversation scope CONFIG against the agent's tool CEILING (the
 * §A14-filtered tool ids available to the agent this turn) into a concrete
 * EFFECTIVE set. The invariant is **never-widen**: a scope can only REMOVE tools
 * the agent could otherwise call — an `enabled` entry outside the ceiling is
 * dropped, and `requireApproval` is clamped to the effective enabled set. This is
 * the security boundary; the loop (Phase 2) ANDs this with the ADR 0102 per-tool
 * permission gate, so a scope can never escalate beyond the agent's ceiling.
 *
 * Pure + side-effect-free (no I/O, no clock) so it is fully unit-testable and
 * deterministic on replay/fork.
 *
 * @see docs/adr/0132-per-conversation-capability-scope.md
 */
import { tokenMatches } from '../../host/agentToolPermissions.js';
import type { ConversationCapabilityScope } from '../../host/conversationStore.js';
import type { EffectiveScope } from './types.js';

/** True when any token in `tokens` matches `toolId` (exact or dotted-prefix —
 *  the ADR 0102 semantics: `crm` ⊇ `crm.field.update`). */
function anyMatch(tokens: readonly string[] | undefined, toolId: string): boolean {
  return !!tokens && tokens.some((t) => tokenMatches(t, toolId));
}

/**
 * Resolve `scope` against `ceiling` (the concrete tool ids the agent may use this
 * turn) into the effective enabled + require-approval sets.
 *
 * - `mode:'agent-default'` (or absent) ⇒ the full ceiling, no approvals (no narrowing).
 * - `mode:'restricted'`:
 *     - a ceiling tool is ENABLED iff (no `enabled` list OR it matches `enabled`)
 *       AND it does NOT match `disabled`.  (disabled wins over enabled)
 *     - never-widen: the result is intersected with the ceiling by construction
 *       (we only ever iterate ceiling ids), so an `enabled` entry naming a tool the
 *       agent lacks is silently dropped.
 *     - `requireApproval` is the subset of the EFFECTIVE enabled ids matching any
 *       `requireApproval` token (clamped — you cannot require approval for a tool
 *       that is not enabled).
 */
export function resolveCapabilityScope(
  ceiling: readonly string[],
  scope: ConversationCapabilityScope | undefined,
): EffectiveScope {
  if (!scope || scope.mode !== 'restricted') {
    return { enabled: [...ceiling], requireApproval: [] };
  }
  const enabled = ceiling.filter((toolId) => {
    const allowedByEnabled = scope.enabled === undefined || anyMatch(scope.enabled, toolId);
    const blockedByDisabled = anyMatch(scope.disabled, toolId);
    return allowedByEnabled && !blockedByDisabled;
  });
  const requireApproval = enabled.filter((toolId) => anyMatch(scope.requireApproval, toolId));
  return { enabled, requireApproval };
}

/** Whether resolving `scope` against `ceiling` actually NARROWS the agent's tools
 *  or marks any for approval. Used by the stamp (Phase 1) + the loop (Phase 2) to
 *  short-circuit the common no-narrowing case to the unchanged path. */
export function isNarrowing(ceiling: readonly string[], scope: ConversationCapabilityScope | undefined): boolean {
  if (!scope || scope.mode !== 'restricted') return false;
  const eff = resolveCapabilityScope(ceiling, scope);
  return eff.enabled.length < ceiling.length || eff.requireApproval.length > 0;
}

/** Compose two capability-scope configs into the most-restrictive of both (NEVER
 *  widens) — used when more than one authored source applies to a run (e.g. the ADR
 *  0136 intent ledger ∩ the user chipset). `enabled` = items allowed by BOTH (prefix-
 *  aware via anyMatch, so 'kb' ∩ 'kb.search' keeps 'kb.search'); `disabled` /
 *  `requireApproval` = union (anything either forbids/gates stays so). An `agent-default`
 *  side imposes no constraint (returns the other); both unrestricted ⇒ agent-default. */
export function intersectScopes(
  a: ConversationCapabilityScope | undefined,
  b: ConversationCapabilityScope | undefined,
): ConversationCapabilityScope {
  const ra = a?.mode === 'restricted' ? a : undefined;
  const rb = b?.mode === 'restricted' ? b : undefined;
  if (!ra && !rb) return { mode: 'agent-default' };
  if (ra && !rb) return ra;
  if (rb && !ra) return rb;
  const dedupe = (xs: string[]): string[] => [...new Set(xs)];
  // enabled: undefined on a side = "all allowed" (no constraint), so the intersection is
  // the other side's list; both defined → keep tools matched by BOTH (prefix-aware).
  let enabled: string[] | undefined;
  if (ra!.enabled && rb!.enabled) {
    enabled = dedupe([...ra!.enabled, ...rb!.enabled]).filter((t) => anyMatch(ra!.enabled, t) && anyMatch(rb!.enabled, t));
  } else {
    enabled = ra!.enabled ?? rb!.enabled;
  }
  const unionOpt = (x?: string[], y?: string[]): string[] | undefined => (x || y ? dedupe([...(x ?? []), ...(y ?? [])]) : undefined);
  const disabled = unionOpt(ra!.disabled, rb!.disabled);
  const requireApproval = unionOpt(ra!.requireApproval, rb!.requireApproval);
  return {
    mode: 'restricted',
    ...(enabled ? { enabled } : {}),
    ...(disabled ? { disabled } : {}),
    ...(requireApproval ? { requireApproval } : {}),
  };
}

/** A resolved per-tool approval decision (the durable ledger shape, narrowed to
 *  what the fold needs — kept structural so the resolver imports no ledger code). */
export interface ApprovalDecision {
  toolName: string;
  status: 'pending' | 'approved' | 'denied';
}

/**
 * ADR 0132 Phase 3 — fold resolved per-conversation approval decisions into the
 * effective scope (pure). For a tool whose latest decision is:
 *   - `approved` ⇒ drop it from `requireApproval` (it now executes on re-attempt);
 *   - `denied`   ⇒ drop it from `enabled` (and `requireApproval`) so the loop
 *                  forbids it;
 *   - `pending`/absent ⇒ unchanged (still gated behind approval).
 * Never WIDENS: an approval only affects tools already in the effective set, so it
 * cannot grant a tool outside the agent ceiling.
 */
export function applyApprovalDecisions(effective: EffectiveScope, decisions: readonly ApprovalDecision[]): EffectiveScope {
  if (decisions.length === 0) return effective;
  const approved = new Set(decisions.filter((d) => d.status === 'approved').map((d) => d.toolName));
  const denied = new Set(decisions.filter((d) => d.status === 'denied').map((d) => d.toolName));
  return {
    enabled: effective.enabled.filter((t) => !denied.has(t)),
    requireApproval: effective.requireApproval.filter((t) => !approved.has(t) && !denied.has(t)),
  };
}

/**
 * ADR 0132 Phase 1 — the PURE `run.metadata.capabilityScope` stamp.
 *
 * The resolved effective scope is a variable that influences the run (it decides
 * which tool calls fire and which suspend for approval), so it MUST be stamped in
 * `run.metadata` at run creation and read verbatim on `:fork` — never re-resolved
 * (the ADR 0031 invariant; mirrors `computeRouteStamp` for the model router). A
 * re-resolution on fork could differ if the agent's ceiling changed since, silently
 * diverging the forked run.
 *
 * Pure: returns the NEW metadata to persist, or null when nothing should change
 * (already stamped — the replay/fork guard — or no narrowing to record).
 *
 * @see docs/adr/0132-per-conversation-capability-scope.md
 * @see src/host/conversationExchange.ts computeRouteStamp — the precedent
 */
import type { EffectiveScope, CapabilityScopeStamp } from './types.js';

export const CAPABILITY_SCOPE_KEY = 'capabilityScope';

/**
 * @param metadata  the run's current metadata.
 * @param effective the resolved effective scope to stamp, or null when there is no
 *                  narrowing (agent-default / feature-off) — in which case nothing
 *                  is stamped and the loop stays on the unchanged path.
 * @param resolvedAt optional ISO provenance stamp (passed in so this stays pure).
 */
export function computeCapabilityScopeStamp(
  metadata: Record<string, unknown>,
  effective: EffectiveScope | null,
  resolvedAt?: string,
): Record<string, unknown> | null {
  if (metadata[CAPABILITY_SCOPE_KEY]) return null; // already stamped (or a fork) — never re-resolve
  if (!effective) return null; // no narrowing → keep the agent's full tool surface
  const stamp: CapabilityScopeStamp = {
    enabled: effective.enabled,
    requireApproval: effective.requireApproval,
    ...(resolvedAt ? { resolvedAt } : {}),
  };
  return { ...metadata, [CAPABILITY_SCOPE_KEY]: stamp };
}

/** Read a previously-stamped effective scope from run metadata (verbatim — the
 *  :fork path). Returns null when unstamped (the loop then resolves live, Phase 2)
 *  or when the stamp is malformed (fail-safe to the unchanged path). */
export function readCapabilityScopeStamp(metadata: Record<string, unknown> | undefined): CapabilityScopeStamp | null {
  const raw = metadata?.[CAPABILITY_SCOPE_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<CapabilityScopeStamp>;
  if (!Array.isArray(s.enabled) || !Array.isArray(s.requireApproval)) return null;
  return {
    enabled: s.enabled.filter((x): x is string => typeof x === 'string'),
    requireApproval: s.requireApproval.filter((x): x is string => typeof x === 'string'),
    ...(typeof s.resolvedAt === 'string' ? { resolvedAt: s.resolvedAt } : {}),
  };
}

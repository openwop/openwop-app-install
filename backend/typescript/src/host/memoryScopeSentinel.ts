/**
 * ADR 0944 D1 — the fail-closed sentinel scopes the memory resolver
 * (`agentMemoryAdapter.ts` `resolveAgentMemory`) mints when a dispatch has no
 * scope it may use: `agent:<id>:no-actor` (a `per-user` agent with nobody acting,
 * ADR 0442) and `agent:<id>:no-org` (no readable client). No writer ever targets
 * one, so recall from it is always empty. A leaf module so dispatch can check it
 * without importing the resolver (which imports dispatch through subjectMemory).
 */
const SENTINEL_SUFFIXES = [':no-actor', ':no-org'] as const;

export function memorySentinelScope(agentScope: string, reason: 'no-actor' | 'no-org'): string {
  return `${agentScope}:${reason}`;
}

/** True for a fail-closed sentinel scope (never written, always empty). */
export function isSentinelMemoryScope(scope: string): boolean {
  return scope.startsWith('agent:') && SENTINEL_SUFFIXES.some((s) => scope.endsWith(s));
}

/** The degradation label the model sees when its client memory could not be
 *  read (ADR 0944 D2) — inside the fenced notice, never as content. */
export const CLIENT_MEMORY_UNAVAILABLE_LABEL = "this client's shared memory";

/** ADR 0944 D6 — a replay served from a read receipt could not serve all of it. */
export const CLIENT_MEMORY_PARTIAL_LABEL = "part of this client's shared memory (erased or removed since the original run)";

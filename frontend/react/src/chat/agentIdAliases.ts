/**
 * ADR 0763 — the SPA's copy of the legacy → canonical agent-id rule. The
 * backend owner is `backend/typescript/src/executor/agentIdAliases.ts`; this
 * mirror exists only so a chat session saved before the rename (localStorage,
 * or a lineup derived from a conversation's stored `agent:<id>` participants)
 * compares equal to the canonical ids the SPA now uses. Keep the two rules
 * identical — `__tests__/agentIdAliases.test.ts` pins the shared cases.
 */
const CANONICAL_SCOPE = 'vendor.openwop-app.';
const LEGACY_SCOPE = 'feature.';
const EXPLICIT: ReadonlyMap<string, string> = new Map([
  ['career-agent', 'vendor.openwop-app.career-agent.agents.default'],
]);

export function canonicalAgentId(id: string): string {
  const explicit = EXPLICIT.get(id);
  if (explicit !== undefined) return explicit;
  if (!id.startsWith(LEGACY_SCOPE)) return id;
  const parts = id.split('.');
  const at = parts.indexOf('agents', 2);
  return at >= 2 && at < parts.length - 1 ? CANONICAL_SCOPE + id.slice(LEGACY_SCOPE.length) : id;
}

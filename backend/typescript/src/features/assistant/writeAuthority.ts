/**
 * The ONE predicate for "may this subject cause an assistant WRITE" — including
 * the write that matters most: approving an action, which sends a real email or
 * writes a real calendar event on a shared connection.
 *
 * Extracted during UX_UPGRADE-assistant R2 (AST2-B1). It lived module-private in
 * `agentTools.ts`, which meant the ROUTE and the TOOL each carried their own
 * copy of the rule while a third decide path carried none. `routes.ts` gates its
 * approve/reject on `workspace:write` and says why in a vuln-scan comment; the
 * generic approvals lane (`POST /approvals/:id/claim`) and the unified reviews
 * lane (`POST /reviews/:id/actions/approve`) reach the SAME approval and
 * delegate authorization to `assertApprovalEligibility` — an opt-in registry
 * that is a NO-OP for kinds registering nothing. `assistant-action` registered
 * nothing, so the gate the route documents did not exist on two of three paths.
 *
 * ADR 0458 CRITICAL-3 made route↔tool parity a rule and this feature implements
 * it carefully. The parity nobody checked was route↔ROUTE. One exported helper,
 * every caller, is the only version of this that cannot drift.
 */
import type { Scope } from '../../host/accessControlService.js';
import { resolveSubjectScopesUnion } from '../../host/accessControlService.js';

export const ASSISTANT_WRITE_SCOPE: Scope = 'workspace:write';

/**
 * True when `subject` may perform an assistant write in `tenantId`:
 *   - no subject ⇒ false (a subjectless run never writes);
 *   - `tenantId === subject` ⇒ true — the implicit owner of one's own personal
 *     workspace, the SAME line `hasKicktodoManageAuthority` carries. This is the
 *     subject-lane convention: an agent-tool scope for a personal workspace has
 *     `actingUserId === tenantId`, so this is how a run acting as the owner is
 *     recognised;
 *   - otherwise the caller's tenant-wide scope union must include
 *     `workspace:write` — a non-member resolves to zero scopes and is denied.
 *
 * **What this predicate CANNOT see, and why the approval gate threads two extra
 * flags.** It is a `(tenantId, subject)` function, and two of `requireTenantScope`'s
 * exits are facts about the REQUEST:
 *
 *   - the wildcard-operator principal, which has no subject equivalent;
 *   - `isOwnPersonalWorkspace(req)` — which is NOT the same thing as the
 *     `tenantId === subject` line above. On the HTTP lane those two ids live in
 *     different namespaces (`anon:<sid>` vs `session:<sid>`; `user:<sha256>` vs
 *     the userId), so the owner branch never fires for a real request and an
 *     approval gate relying on it 403s the sandbox owner's own Approve button.
 *
 * CORRECTIONS, both from getting this wrong in one day (2026-08-11):
 *  1. The first cut had only the subject-lane owner branch, and the approval
 *     gate built on it broke `/approvals/:id/claim` for anon/personal owners —
 *     measured 403 there against 200 on the assistant's own route.
 *  2. The fix for THAT deleted the branch outright, calling it "unreachable in
 *     production". Also wrong, and in the more embarrassing direction: it is
 *     unreachable on the HTTP lane and load-bearing on the TOOL lane, where a
 *     personal workspace's tenantId genuinely is the acting subject. Removing it
 *     reddened four agent-tool tests immediately.
 * Both exits are real; neither substitutes for the other. Keep them separate.
 */
export async function hasAssistantWriteAuthority(tenantId: string, subject?: string): Promise<boolean> {
  if (!subject) return false;
  if (tenantId === subject) return true; // implicit owner of one's own personal workspace (subject lane)
  const { scopes } = await resolveSubjectScopesUnion(tenantId, subject);
  return scopes.includes(ASSISTANT_WRITE_SCOPE);
}

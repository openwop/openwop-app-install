/**
 * The service desk's one org-scope predicate (moved out of `routes.ts` by ADR 0878
 * so the SLA sweep and the surface can share it without an import cycle).
 */
import { resolveEffectiveAccess } from '../../host/accessControlService.js';

type Scope = 'workspace:read' | 'workspace:write' | 'host:members:manage';

/**
 * The org-scope predicate shared by the service-desk ROUTES (via
 * `authorizeOrgScope` → `requireOrgScope` → `resolveEffectiveAccess`) and the
 * Support Agent's chat TOOLS (`agentTools.ts`), so a route and a tool can NEVER
 * drift on who may read or act on a ticket — the CFP-1 "one helper, route + tool
 * both call it" pattern (campaign-brief / crm precedent).
 *
 * CHAT-FIRST-PORT-AUDIT D8: the tools formerly checked only `actingUserId`
 * truthiness + the toggle, then read/acted on a CALLER-SUPPLIED `orgId` (list) or
 * a ticket fetched by id with no org check (get/draft/set-status) — so any
 * authenticated co-tenant could read or act on ANOTHER org's tickets within a
 * shared tenant. This predicate closes that: it resolves the acting subject's
 * effective access IN the ticket's org and requires the same scope the matching
 * route requires. `subject` undefined ⇒ never granted (fail-closed — an
 * undefined subject would otherwise resolve to the tenant-owner branch).
 */
export async function orgScopeGranted(tenantId: string, subject: string | undefined, orgId: string, scope: Scope): Promise<boolean> {
  if (!subject || !orgId) return false;
  const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
  return access.scopes.includes(scope);
}

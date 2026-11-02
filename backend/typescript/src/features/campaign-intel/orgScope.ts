/**
 * The org-scope authority predicate SHARED by the campaign-intel routes, the
 * Campaign Intelligence Analyst's chat tools (`agentTools.ts`) and the org
 * alert audience (`orgAlerts.ts`, ADR 1022 D8) — ONE check, so the route, the
 * tool and the notice can never drift on who may read/write an org's campaigns
 * (the CLAUDE.md "one helper, route + tool both call it" rule). Its own module
 * so the alert path does not import the routes.
 */

import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';

export async function orgScopeGranted(tenantId: string, subject: string | undefined, orgId: string, scope: Scope): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
  return access.scopes.includes(scope);
}

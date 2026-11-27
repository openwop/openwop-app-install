/**
 * ADR 1099 D10 — the ONE builder of a grant's scope. The collaborator turn's
 * client tools (D5/D6) and the portal's sections (D10) both call it, so a section
 * and a tool can never see different scopes. Every field comes from the grant:
 * nothing a caller sends can name a tenant, an org, a resource or an audience.
 */
import { viewerOf, type GrantUse } from './externalCollaborators.js';
import type { ClientToolScope } from './clientProjectTools.js';

export function clientScopeOf(use: GrantUse): ClientToolScope {
  const viewer = viewerOf(use);
  return {
    tenantId: use.tenantId, orgId: use.orgId,
    resourceKind: use.grant.resource.kind, resourceId: use.grant.resource.id,
    grantId: use.grant.grantId, collaboratorId: use.collaborator.collaboratorId,
    ...(viewer.audience ? { audience: viewer.audience } : {}),
  };
}

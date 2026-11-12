/**
 * Knowledge-sync org authority (ADR 1101 D3) — the ONE predicate the routes and
 * the sync pass share.
 *
 * The routes ask it of the caller (`req.userId ?? principalId`, one spelling,
 * unchanged). The pass asks it of the person every pass acts as — the bound
 * connection's owner — under every spelling `actingUserIds` knows for them in
 * this tenant (home-tenant-only aliasing, ADR 0780 D2), so a legacy source
 * stamped `oidc:<sub>` before a bind is not locked out once the member row is
 * re-keyed `user:<id>`.
 *
 * Both lanes read `resolveEffectiveAccess`, exactly as the create door did, so a
 * pass is never held to a stricter test than the door that made the source
 * (`assertOrgScope` would add an org-row existence check the door never made).
 */
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { actingUserIds } from '../connections/connectionsService.js';

/** Does any of `subjects` hold `scope` on `orgId` in `tenantId`? `undefined`
 *  entries are asked as-is (the route's anonymous caller resolves to no scopes
 *  outside the demo single-principal sandbox, exactly as before). */
export async function holdsOrgScope(
  tenantId: string,
  subjects: Iterable<string | undefined>,
  orgId: string,
  scope: Scope,
): Promise<boolean> {
  for (const subject of subjects) {
    const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
    if (access.scopes.includes(scope)) return true;
  }
  return false;
}

/** May the person a pass acts as still WRITE the source's org? (D3, pass time.)
 *  A read failure propagates — it is an ordinary whole-run failure, never a
 *  refusal (a membership store blip must not pause a healthy source). */
export async function passActorMayWrite(tenantId: string, actor: string, orgId: string): Promise<boolean> {
  return holdsOrgScope(tenantId, await actingUserIds(tenantId, actor), orgId, 'workspace:write');
}

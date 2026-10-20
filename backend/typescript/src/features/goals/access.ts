/**
 * ADR 0908 D1 — the goals authority, one place for every lane.
 *
 *  - Routes ask `requireGoalsScope` — the provenance-aware `callerHoldsTenantScope`
 *    the scheduler POST reaches through `requireTenantWrite` (an env key is the
 *    tenant's operator, an `owk_` key is bounded by its declaration and issuer, a
 *    person is checked under both spellings). Reads `workspace:read`; every
 *    mutation `workspace:write`.
 *  - The chat tool asks the req-less form of the same membership question
 *    (`assertTenantScope`) for the acting user, as the surface seam does.
 *  - The run surface declares `GOALS_SURFACE_SCOPES` as its `tenantMethodScopes`.
 */
import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { Scope } from '../../host/accessControlService.js';
import { tenantOf } from '../../host/requestSubject.js';
import { callerHoldsTenantScope } from '../featureRoute.js';

export const GOALS_READ: Scope = 'workspace:read';
export const GOALS_WRITE: Scope = 'workspace:write';

/** `ctx.features.goals` method → the tenant scope its HTTP door asks. */
export const GOALS_SURFACE_SCOPES: Readonly<Record<string, Scope>> = {
  get: GOALS_READ,
  list: GOALS_READ,
  create: GOALS_WRITE,
  transition: GOALS_WRITE,
  arm: GOALS_WRITE,
  bindRun: GOALS_WRITE,
  evaluate: GOALS_WRITE,
};

export async function requireGoalsScope(req: Request, scope: Scope): Promise<void> {
  if (await callerHoldsTenantScope(req, tenantOf(req), scope)) return;
  throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope });
}

/** An operator credential — an env key or the wildcard principal. The only
 *  callers the conformance fixture is seeded for and shown to (ADR 0908 D4). */
export function isGoalsOperator(req: Request): boolean {
  const p = req.principal;
  return p?.tenants?.includes('*') === true || p?.auth?.kind === 'env-key';
}

/**
 * ADR 0908 D2 — who a continuation armed by this request acts as, exactly as
 * the scheduler POST stamps it (`actingUserOf`): the person, or for an `owk_`
 * key the KEY (`apikey:<id>`) — never its issuer, because stamping the issuer
 * would let the job run with that person's own credentials past the key's
 * declared scopes and after the key is revoked (`GL2CD-2`). The key's issuer
 * rides separately as `causedBy`, the narrowing-only `orgScopeSubject` of every
 * fired run (ADR 0879 D7). An operator credential names nobody.
 */
export function goalActorOf(req: Request): { actingUserId?: string; causedBy?: string } {
  const auth = req.principal?.auth;
  if (auth?.kind === 'api-key') return { ...(req.principal?.principalId ? { actingUserId: req.principal.principalId } : {}), causedBy: auth.issuer };
  if (isGoalsOperator(req)) return {};
  const person = req.userId ?? req.principal?.principalId;
  return person ? { actingUserId: person } : {};
}

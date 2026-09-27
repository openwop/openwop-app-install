/**
 * Developer API-key routes (ADR 0270 / CDP-H) under /v1/host/openwop-app/developer-keys.
 * Requires an authenticated principal (issuing a credential is not anonymous) and
 * applies the ADR 0270 self-service/admin key scope. The plaintext token is
 * returned ONCE on issue and never again.
 *
 * § ADR 0434 — the `developer-keys` toggle graduated to always-on, so these
 * management routes no longer 404 on a toggle. The authenticated-principal
 * requirement and `keyScopeOf` remain the real authority.
 */
import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { requireString } from '../featureRoute.js';
import { issueApiKey, listApiKeys, revokeApiKey, type KeyScope } from './apiKeyService.js';

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
/** The app's canonical caller subject (matches resolveEffectiveAccess + featureRoute). */
const callerSubjectOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

async function requirePrincipal(req: Request): Promise<string> {
  const subject = callerSubjectOf(req);
  if (!subject) throw new OpenwopError('unauthenticated', 'Managing an API key requires an authenticated principal.', 401, {});
  return subject;
}

/**
 * The caller's key-management scope (ADR 0270 self-service + admin oversight, /architect-ruled).
 * A self-service caller manages only the keys they created; an admin|owner manages every
 * key in the tenant. The admin check is ADDITIVE — fail-closed roles resolve to own-keys,
 * never a lockout — so a real owner without an explicit accessControl member row keeps
 * self-service access. accessControl is the single owner of the role decision.
 */
async function keyScopeOf(req: Request, callerSubject: string): Promise<KeyScope> {
  const access = await resolveEffectiveAccess(tenantOf(req), { subject: callerSubject });
  const isAdmin = access.roles.includes('admin') || access.roles.includes('owner');
  return { callerSubject, isAdmin };
}

export function registerDeveloperKeysRoutes({ app }: RouteDeps): void {
  const base = '/v1/host/openwop-app/developer-keys';

  app.get(base, async (req, res, next) => {
    try {
      const subject = await requirePrincipal(req);
      res.json({ keys: await listApiKeys(tenantOf(req), await keyScopeOf(req, subject)) });
    } catch (err) { next(err); }
  });

  app.post(base, async (req, res, next) => {
    try {
      const subject = await requirePrincipal(req);
      const b = (req.body ?? {}) as { name?: unknown; scopes?: unknown; expiresAt?: unknown };
      const issued = await issueApiKey({
        tenantId: tenantOf(req),
        name: requireString(b.name, 'name'),
        createdBy: subject, // self-service ownership handle (canonical subject)
        scopes: b.scopes,
        ...(typeof b.expiresAt === 'string' ? { expiresAt: b.expiresAt } : {}),
      });
      // token is returned ONCE — the caller must store it now.
      res.status(201).json(issued);
    } catch (err) { next(err); }
  });

  app.delete(`${base}/:id`, async (req, res, next) => {
    try {
      const subject = await requirePrincipal(req);
      // Out-of-scope key (not yours + not admin, or wrong tenant) ⇒ false ⇒ 404, no existence leak.
      if (!(await revokeApiKey(tenantOf(req), req.params.id, await keyScopeOf(req, subject)))) {
        throw new OpenwopError('not_found', 'Key not found.', 404, { keyId: req.params.id });
      }
      res.status(204).end();
    } catch (err) { next(err); }
  });
}

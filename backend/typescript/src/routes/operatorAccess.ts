/**
 * ADR 0910 D3 — the operator-access routes. Host-local (`/host/openwop-app/*`),
 * never on the wire.
 *
 *   POST   /host/openwop-app/workspaces/:id/operator-access            → 201 { activation }
 *   DELETE /host/openwop-app/workspaces/:id/operator-access[/:subject] → 204
 *   GET    /host/openwop-app/workspaces/:id/operator-access            → 200 { activations }
 *
 * The REQUEST guards (G1–G5) are here, in order, each fail-closed; the target,
 * duration and audit-first rules (G6–G8) are enforced by `host/operatorAccess.ts`.
 */
import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import { isListedSuperadmin, isListedSuperadminTenant } from '../host/superadmin.js';
import { isPersonalTenantId, personalTenantOf } from '../host/requestSubject.js';
import { isDelegatedSubject } from '../host/delegatedSubject.js';
import { declaredDefaultWorkspaceTargets } from '../host/workspaceJoinLedger.js';
import { resolveOne } from '../host/featureToggles/service.js';
import { clientIp } from '../host/clientIp.js';
import { activateOperatorAccess, assertOperatorTarget, listOperatorActivations, revokeOperatorAccess } from '../host/operatorAccess.js';

/** G4 — the ID token's `auth_time` must be at most this old. */
export const OPERATOR_REAUTH_WINDOW_S = 900;

/** G1 — eligible: the PERSON's own personal tenant is on the allowlist. A listed
 *  ACTIVE tenant alone is not enough (every member of a listed workspace would
 *  pass `isListedSuperadmin`), and the personal tenant is what D4 re-checks. */
function eligibilityTenantOf(req: Request): string {
  const personal = personalTenantOf(req);
  if (!isListedSuperadmin(req) || !isPersonalTenantId(personal) || !isListedSuperadminTenant(personal)) {
    throw new OpenwopError('forbidden', 'Operator access is limited to listed superadmins.', 403, { code: 'not_eligible' });
  }
  return personal;
}

/** G2 — a person (a bound session), acting for THEMSELVES. Keys, env keys,
 *  anonymous sessions and delegated subjects are refused. */
function personOf(req: Request): string {
  const userId = req.userId;
  const kind = req.principal?.auth?.kind;
  if (!userId || !userId.startsWith('user:') || kind !== 'subject' || isDelegatedSubject(userId)) {
    throw new OpenwopError('forbidden', 'Operator access must be activated by a signed-in person.', 403, { code: 'person_required' });
  }
  return userId;
}

/** G3 — MFA step-up. */
function requireMfa(req: Request): void {
  if (req.mfaVerified !== true) {
    throw new OpenwopError('forbidden', 'Operator access requires a second factor.', 403, { code: 'mfa_required' });
  }
}

/** G4 — a FRESH ID token on this request (`auth_time` ≤ 15 min). The cookie's
 *  `authAt` cannot prove a recent sign-in (it is re-stamped up to daily). */
function requireRecentAuth(req: Request, nowMs: number): number {
  const at = req.oidcAuthTime;
  if (typeof at !== 'number' || Math.floor(nowMs / 1000) - at > OPERATOR_REAUTH_WINDOW_S) {
    throw new OpenwopError('forbidden', 'Sign in again to activate operator access.', 403, { code: 'reauth_required' });
  }
  return at;
}

/** G6 (feature half) — the target's declaring feature must be on there. */
async function requireFeatureOn(workspaceId: string): Promise<void> {
  const target = declaredDefaultWorkspaceTargets().find((t) => t.tenantId === workspaceId);
  const on = target ? (await resolveOne(target.featureId, { tenantId: workspaceId }))?.enabled === true : false;
  if (!on) throw new OpenwopError('conflict', 'The workspace\'s feature is not enabled.', 409, { code: 'feature_disabled' });
}

export function registerOperatorAccessRoutes(app: Express): void {
  app.post('/host/openwop-app/workspaces/:id/operator-access', async (req, res, next) => {
    try {
      const eligibilityTenant = eligibilityTenantOf(req);
      const subject = personOf(req);
      requireMfa(req);
      const authTime = requireRecentAuth(req, Date.now());
      const workspaceId = String(req.params.id);
      await assertOperatorTarget(workspaceId); // 404 before anything about the feature leaks
      await requireFeatureOn(workspaceId);
      const b = (req.body ?? {}) as { justification?: unknown; durationMinutes?: unknown };
      const activation = await activateOperatorAccess({
        workspaceId, subject, eligibilityTenant, justification: b.justification, durationMinutes: b.durationMinutes,
        ip: clientIp(req), authTime, // ADR 0851 — the one client-address reader
      });
      res.status(201).json({ activation });
    } catch (err) {
      next(err);
    }
  });

  const revoke = async (req: Request, targetSubject: string | undefined): Promise<void> => {
    const eligibilityTenant = eligibilityTenantOf(req);
    const by = personOf(req);
    requireMfa(req); // another superadmin may end it; no re-auth window (D7.1)
    const workspaceId = String(req.params.id);
    const removed = await revokeOperatorAccess(workspaceId, targetSubject ?? by, by, eligibilityTenant);
    if (!removed) throw new OpenwopError('not_found', 'No live operator activation.', 404);
  };
  app.delete('/host/openwop-app/workspaces/:id/operator-access', async (req, res, next) => {
    try { await revoke(req, undefined); res.status(204).end(); } catch (err) { next(err); }
  });
  app.delete('/host/openwop-app/workspaces/:id/operator-access/:subject', async (req, res, next) => {
    try { await revoke(req, String(req.params.subject)); res.status(204).end(); } catch (err) { next(err); }
  });

  app.get('/host/openwop-app/workspaces/:id/operator-access', async (req, res, next) => {
    try {
      eligibilityTenantOf(req);
      res.status(200).json({ activations: await listOperatorActivations(String(req.params.id)) });
    } catch (err) {
      next(err);
    }
  });
}

/**
 * Digital-twin routes (ADR 0044, Phase 1) — host-extension. Two surfaces over the
 * host-owned `twinService`:
 *
 *   Admin LINK (operational) — /v1/host/openwop-app/agents/:id/twin
 *     GET     read the link + the linked user's grant status
 *     PUT     link the agent to a user                    [workspace:write + agent IDOR]
 *     DELETE  unlink (also revokes the grant)             [workspace:write + agent IDOR]
 *
 *   User GRANT (authorization) — /v1/host/openwop-app/profiles/me/twin-grants
 *     GET                  the caller's issued grants (who may recall my memory)
 *     POST                 grant for { agentId, scopes }   [self; agent must be linked to me]
 *     DELETE /:agentId     revoke my grant                 [self]
 *
 * Everything is gated by the `twin-recall` toggle (OFF by default, tenant-bucketed)
 * — the whole twin surface is opt-in per tenant. Fail-closed throughout: a caller
 * may only grant/revoke for an agent LINKED to their own account; the admin link is
 * tenant-IDOR-guarded.
 *
 * @see docs/adr/0044-twin-cross-subject-recall.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { requireFeatureEnabled, requireString } from '../featureRoute.js';
import { getRosterEntry } from '../../host/rosterService.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import {
  getTwinLink, linkTwin, unlinkTwin,
  grantTwin, revokeTwin, listGrantsForUser, getActiveGrant,
  type TwinScope,
} from '../../host/twinService.js';

const TOGGLE_ID = 'twin-recall';
const LABEL = 'Digital twin recall';

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

/** Tenant-IDOR: the agent MUST exist in the caller's tenant (else a generic 404). */
async function requireOwnedAgent(req: Request): Promise<string> {
  const id = req.params.id;
  const entry = await getRosterEntry(id);
  if (!entry || entry.tenantId !== tenantOf(req)) {
    throw new OpenwopError('not_found', 'Agent not found.', 404, { id });
  }
  return id;
}

/** Tenant-wide scope gate (admin link is an operational, tenant-scoped act). */
async function requireTenantScope(req: Request, scope: Scope): Promise<void> {
  const access = await resolveEffectiveAccess(tenantOf(req), { subject: actingUserOf(req) });
  if (!access.scopes.includes(scope)) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope });
  }
}

function parseScopes(body: Record<string, unknown>): TwinScope[] {
  const raw = body.scopes;
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== 'string')) {
    throw new OpenwopError('validation_error', '`scopes` must be an array of strings (`memory` / `knowledge`).', 400, { field: 'scopes' });
  }
  return raw as TwinScope[];
}

export function registerTwinRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // ── admin LINK ──
  app.get('/v1/host/openwop-app/agents/:id/twin', async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const id = await requireOwnedAgent(req);
      await requireTenantScope(req, 'workspace:read');
      const link = await getTwinLink(tenantOf(req), id);
      const grant = link ? await getActiveGrant(tenantOf(req), id, link.userId) : null;
      res.json({ link, grant: grant ? { scopes: grant.scopes, version: grant.version, grantedAt: grant.grantedAt } : null });
    } catch (err) { next(err); }
  });

  app.put('/v1/host/openwop-app/agents/:id/twin', async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const id = await requireOwnedAgent(req);
      await requireTenantScope(req, 'workspace:write');
      const userId = requireString((req.body ?? {})?.userId, 'userId');
      await linkTwin(deps.storage, tenantOf(req), id, userId, actingUserOf(req) ?? 'unknown');
      res.json({ link: await getTwinLink(tenantOf(req), id) });
    } catch (err) { next(err); }
  });

  app.delete('/v1/host/openwop-app/agents/:id/twin', async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const id = await requireOwnedAgent(req);
      await requireTenantScope(req, 'workspace:write');
      await unlinkTwin(deps.storage, tenantOf(req), id, actingUserOf(req) ?? 'unknown');
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── user GRANT (self) ──
  app.get('/v1/host/openwop-app/profiles/me/twin-grants', async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const user = await resolveCallerUser(req);
      res.json({ grants: await listGrantsForUser(user.tenantId, user.userId) });
    } catch (err) { next(err); }
  });

  app.post('/v1/host/openwop-app/profiles/me/twin-grants', async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const user = await resolveCallerUser(req);
      const agentId = requireString((req.body ?? {})?.agentId, 'agentId');
      const scopes = parseScopes((req.body ?? {}) as Record<string, unknown>);
      const grant = await grantTwin(deps.storage, user.tenantId, agentId, user.userId, scopes);
      res.status(201).json({ grant });
    } catch (err) { next(err); }
  });

  app.delete('/v1/host/openwop-app/profiles/me/twin-grants/:agentId', async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const user = await resolveCallerUser(req);
      const removed = await revokeTwin(deps.storage, user.tenantId, req.params.agentId, user.userId);
      if (!removed) throw new OpenwopError('not_found', 'No active grant to revoke.', 404, { agentId: req.params.agentId });
      res.status(204).end();
    } catch (err) { next(err); }
  });
}

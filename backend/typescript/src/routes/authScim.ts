/**
 * SCIM provisioning seam + minimal SCIM 2.0 endpoints (RFC 0050 §B —
 * `openwop-auth-scim`).
 *
 *   POST /v1/host/openwop-app/auth/scim/provision   { scimUrl, op, user?, group? }
 *   POST   /scim/v2/Users                       create/upsert a principal
 *   PATCH  /scim/v2/Users/:id   { active }      deactivate/reactivate
 *   DELETE /scim/v2/Users/:id                   deactivate (leaver)
 *   POST   /scim/v2/Groups      { members }     group-membership sync
 *
 * The seam drives the host's provisioning service (scimProvisioningService) for
 * a named `op` — `create-user` (-> RFC 0048 principal), `assign-group` (-> role
 * membership), `deactivate-user` (-> fail-closed: subsequent decisions deny,
 * RFC 0050 §B / finding H5). The seam is HOST-LEVEL (not behind the `users`
 * toggle) so the advertised `openwop-auth-scim` capability is always reachable
 * (finding C1); it 404s only when no SCIM endpoint is configured
 * (`OPENWOP_TEST_SCIM_URL` unset), which is how the conformance leg soft-skips.
 *
 * The `/scim/v2/{Users,Groups}` endpoints satisfy the §B MUST "expose SCIM
 * endpoints"; they delegate to the same service. (Advanced SCIM — filtering,
 * full PATCH-op semantics, ETags — is a documented follow-on; provisioning +
 * the fail-closed deactivation contract are honored.)
 *
 * AUTH (finding C3 / §B MUST): SCIM requests are authenticated with the IdP's
 * SCIM bearer (`OPENWOP_SCIM_BEARER`), verified in constant time by
 * `requireScimBearer` on every `/scim/v2/*` route; the routes 404 entirely
 * when the bearer is unconfigured. (This wiring is now IMPLEMENTED — the prior
 * "follow-on" note was stale.)
 */

import { timingSafeEqual } from 'node:crypto';
import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';
import {
  DEFAULT_SCIM_USER,
  SCIM_OPS,
  assignGroup,
  deactivateUser,
  isPrincipalResolvable,
  provisionUser,
  resolveScimUser,
  scimUserNameOf,
  setScimActive,
  type ScimOp,
} from '../host/auth/scimProvisioningService.js';

const log = createLogger('auth.scim');

function tenantOf(req: Request): string {
  return req.tenantId ?? 'default';
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Authenticate a real SCIM `/scim/v2/*` request (review finding #9). RFC 0050 §B
 * requires the host to authenticate provisioning with the IdP's SCIM bearer and
 * NOT expose it to unauthenticated callers. The endpoints are enabled ONLY when
 * `OPENWOP_SCIM_BEARER` is configured (else 404 — they don't exist), and each
 * request MUST present that bearer (constant-time compare) — so the demo's
 * default anon-session minting can never reach provisioning. The provisioning
 * tenant is the configured SCIM client's tenant (`OPENWOP_SCIM_TENANT`), NOT the
 * caller's `req.tenantId`; it defaults to the dedicated `scim` namespace (NOT
 * `default`, which holds password/OIDC users — review finding #5) so a SCIM
 * bearer can't collide with another auth path's records.
 */
function scimTenant(): string {
  return process.env.OPENWOP_SCIM_TENANT ?? 'scim';
}

function requireScimBearer(req: Request): string {
  const configured = process.env.OPENWOP_SCIM_BEARER;
  if (!configured) {
    throw new OpenwopError('not_found', 'SCIM provisioning is not enabled (set OPENWOP_SCIM_BEARER).', 404, {});
  }
  const header = req.header('authorization') ?? '';
  const presented = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(configured);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new OpenwopError('unauthenticated', 'A valid SCIM bearer token is required.', 401, {});
  }
  return scimTenant();
}

/** Coerce one PatchOp `value` to the desired `active` boolean. */
function activeFromValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  // value-object form: { value: { active: false } } (Okta/Azure AD).
  if (value && typeof value === 'object' && 'active' in (value as Record<string, unknown>)) {
    return activeFromValue((value as { active?: unknown }).active);
  }
  return undefined;
}

/** Read the desired `active` value from a flat `{active}` body OR an RFC 7644
 *  PatchOp — BOTH the `{path:'active', value}` and the path-less
 *  `{value:{active}}` shapes real IdPs send (review finding #2). Exported for
 *  unit tests. */
export function readActive(body: unknown): boolean | undefined {
  const b = (body ?? {}) as { active?: unknown; Operations?: unknown };
  if (typeof b.active === 'boolean') return b.active;
  if (Array.isArray(b.Operations)) {
    for (const op of b.Operations as Array<{ op?: unknown; path?: unknown; value?: unknown }>) {
      if (typeof op.op === 'string' && op.op.toLowerCase() === 'remove') continue;
      if (typeof op.path === 'string' && op.path.toLowerCase() === 'active') {
        const v = activeFromValue(op.value);
        if (v !== undefined) return v;
      } else if (op.path === undefined || op.path === null) {
        // path-less replace: the active flag lives inside the value object.
        const v = activeFromValue(op.value);
        if (v !== undefined) return v;
      }
    }
  }
  return undefined;
}

export function registerScimAuthRoutes(app: Express): void {
  // ---- Conformance seam ----
  app.post('/v1/host/openwop-app/auth/scim/provision', async (req, res, next) => {
    try {
      if (!process.env.OPENWOP_TEST_SCIM_URL) {
        throw new OpenwopError('not_found', 'SCIM test seam not configured (set OPENWOP_TEST_SCIM_URL).', 404, {});
      }
      // If the deployment has configured a SCIM bearer, the test seam MUST honor
      // it too — otherwise it's an unauthenticated bypass of the bearer-gated
      // /scim/v2/* surface (review finding #1). Pure-conformance deployments
      // (no bearer configured) leave it open + tenant-isolated to the caller.
      if (process.env.OPENWOP_SCIM_BEARER) requireScimBearer(req);
      const body = (req.body ?? {}) as { op?: unknown; user?: Record<string, unknown>; group?: unknown };
      const op = body.op as ScimOp | undefined;
      if (op === undefined || !(SCIM_OPS as readonly string[]).includes(op)) {
        throw new OpenwopError('validation_error', `Field \`op\` MUST be one of ${SCIM_OPS.join(', ')}.`, 400, { allowed: SCIM_OPS });
      }
      const tenantId = tenantOf(req);
      const u = body.user ?? {};
      const userName = str(u.userName) ?? DEFAULT_SCIM_USER.userName;

      switch (op) {
        case 'create-user': {
          const principal = await provisionUser({
            tenantId,
            userName,
            ...(str(u.externalId) ? { externalId: str(u.externalId)! } : {}),
            ...(str(u.email) ? { email: str(u.email)! } : {}),
            ...(str(u.displayName) ? { displayName: str(u.displayName)! } : { displayName: DEFAULT_SCIM_USER.displayName }),
          });
          log.info('scim_user_provisioned', { userName });
          res.status(201).json({ op, principal, resolvable: await isPrincipalResolvable(tenantId, userName) });
          return;
        }
        case 'assign-group': {
          const group = str(body.group) ?? 'scim-group';
          const principal = await assignGroup({ tenantId, userName, group });
          if (!principal) throw new OpenwopError('not_found', 'SCIM user not found; provision it first.', 404, { userName });
          res.status(200).json({ op, principal, groups: principal.groups });
          return;
        }
        case 'deactivate-user': {
          const principal = await deactivateUser({ tenantId, userName });
          if (!principal) throw new OpenwopError('not_found', 'SCIM user not found.', 404, { userName });
          log.info('scim_user_deactivated', { userName });
          // Fail-closed: the principal is no longer resolvable to an active id.
          res.status(200).json({ op, principal, resolvable: await isPrincipalResolvable(tenantId, userName) });
          return;
        }
      }
    } catch (err) {
      next(err);
    }
  });

  // ---- Real SCIM 2.0 endpoints (§B "MUST expose") — bearer-authenticated ----
  app.post('/scim/v2/Users', async (req, res, next) => {
    try {
      const tenantId = requireScimBearer(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const userName = str(body.userName);
      if (!userName) throw new OpenwopError('validation_error', 'SCIM `userName` is required.', 400, {});
      const emails = Array.isArray(body.emails) ? (body.emails as Array<{ value?: unknown }>) : [];
      const principal = await provisionUser({
        tenantId,
        userName,
        ...(str(body.externalId) ? { externalId: str(body.externalId)! } : {}),
        ...(str(body.displayName) ? { displayName: str(body.displayName)! } : {}),
        ...(str(emails[0]?.value) ? { email: str(emails[0]!.value)! } : {}),
      });
      res.status(201).json({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], id: principal.userId, userName, active: principal.status === 'active' });
    } catch (err) {
      next(err);
    }
  });

  // Lifecycle: `:id` is EITHER the durable id returned by create (`user:<uuid>`)
  // OR the SCIM userName (review finding #4). PATCH carries an explicit `active`
  // (flat or RFC 7644 PatchOp) so reactivate (true) and deactivate (false) both
  // work (review finding #5); DELETE is always deactivate.
  for (const handler of ['patch', 'delete'] as const) {
    app[handler]('/scim/v2/Users/:id', async (req, res, next) => {
      try {
        const tenantId = requireScimBearer(req);
        const idOrUserName = req.params.id;
        const user = await resolveScimUser(tenantId, idOrUserName);
        if (!user) throw new OpenwopError('not_found', 'SCIM user not found.', 404, { id: idOrUserName });
        const active = handler === 'delete' ? false : readActive(req.body);
        if (active === undefined) {
          throw new OpenwopError('validation_error', 'PATCH MUST set `active` (flat or via Operations).', 400, {});
        }
        const updated = await setScimActive(user, active);
        log.info('scim_user_lifecycle', { id: user.userId, active });
        // Echo the REAL userName, not the addressed id (review finding #8).
        res.status(200).json({ id: user.userId, userName: scimUserNameOf(user), active: updated?.status === 'active' });
      } catch (err) {
        next(err);
      }
    });
  }

  app.post('/scim/v2/Groups', async (req, res, next) => {
    try {
      const tenantId = requireScimBearer(req);
      const body = (req.body ?? {}) as { displayName?: unknown; members?: unknown };
      const group = str(body.displayName);
      if (!group) throw new OpenwopError('validation_error', 'SCIM group `displayName` is required.', 400, {});
      const members = Array.isArray(body.members) ? (body.members as Array<{ value?: unknown }>) : [];
      const assigned: string[] = [];
      for (const m of members) {
        const ref = str(m.value);
        // members may carry the durable id or the userName; resolve either.
        const u = ref ? await resolveScimUser(tenantId, ref) : null;
        if (u && (await assignGroup({ tenantId, userName: scimUserNameOf(u), group }))) assigned.push(scimUserNameOf(u));
      }
      res.status(201).json({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: group, members: assigned.map((value) => ({ value })) });
    } catch (err) {
      next(err);
    }
  });
}

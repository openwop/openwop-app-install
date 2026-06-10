/**
 * Org invitations routes (host-extension, sample-grade — ADR 0004, reconciled).
 *
 * Surface (toggle-gated on `orgs`; signed-in only) — these paths are ADDITIVE
 * to the `accessControl` org surface, NOT a duplicate of it:
 *   POST   /v1/host/sample/orgs/:orgId/invites          invite { email, role }   [host:members:manage]
 *   GET    /v1/host/sample/orgs/:orgId/invites          list pending invites     [host:members:manage]
 *   DELETE /v1/host/sample/orgs/:orgId/invites/:id      revoke                   [host:members:manage]
 *   POST   /v1/host/sample/orgs/invitations/accept      accept { token }
 *
 * Orgs / members / roles themselves live in `accessControl` (the single owner).
 * AUTHORIZATION delegates to accessControl's RFC 0049 scope model
 * (`resolveEffectiveAccess`) — there is NO parallel membership tier. The
 * accepting IDENTITY comes from the users feature (`resolveCallerUser`, ADR 0003)
 * so the new member binds to the stable `User.userId` subject.
 */

import type { Request, Response } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { createLogger } from '../../observability/logger.js';
import { tenantOf, requireFeatureEnabled } from '../featureRoute.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import type { User } from '../users/usersService.js';
import {
  InviteError,
  acceptInvitation,
  createInvitation,
  listInvitations,
  revokeInvitation,
} from './invitationsService.js';

const log = createLogger('features.orgs');
const TOGGLE_ID = 'orgs';
const EXPOSE_TOKENS = process.env.NODE_ENV !== 'production';
/** accessControl's act-as header — honor it so a reduced-scope simulated member
 *  can't manage invites just because the real principal is the tenant owner. */
const ACT_AS_HEADER = 'x-openwop-act-as-member';

async function requireEnabled(req: Request): Promise<void> {
  await requireFeatureEnabled(req, TOGGLE_ID, 'Orgs');
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OpenwopError('validation_error', `Field \`${field}\` is required and MUST be a non-empty string.`, 400, { field });
  }
  return value;
}

/** Delegate management authorization to accessControl's RFC 0049 scopes — same
 *  `host:members:manage` gate accessControl's own member routes use. */
async function requireMemberManage(req: Request): Promise<void> {
  const actingMember = req.header(ACT_AS_HEADER);
  const access = await resolveEffectiveAccess(tenantOf(req), actingMember ? { memberId: actingMember.trim() } : {});
  if (!access.scopes.includes('host:members:manage')) {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: host:members:manage', 403, { requiredScope: 'host:members:manage' });
  }
}

/** Map an InviteError to the canonical envelope (exhaustive). */
function asHttp(err: unknown): never {
  if (err instanceof InviteError) {
    switch (err.code) {
      case 'forbidden':
        throw new OpenwopError('forbidden', err.message, 403, { code: err.code });
      case 'not_found':
        throw new OpenwopError('not_found', err.message, 404, { code: err.code });
      case 'validation':
      case 'invalid_invite':
        throw new OpenwopError('validation_error', err.message, 400, { code: err.code });
      default: {
        const _never: never = err.code;
        throw new OpenwopError('internal_error', err.message, 500, { code: _never });
      }
    }
  }
  throw err;
}

export function registerOrgsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const h = (fn: (req: Request, res: Response, user: User) => Promise<void>) => async (req: Request, res: Response, next: (e?: unknown) => void) => {
    try {
      await requireEnabled(req);
      const user = await resolveCallerUser(req);
      await fn(req, res, user);
    } catch (err) {
      next(err);
    }
  };

  app.post('/v1/host/sample/orgs/:orgId/invites', h(async (req, res, _user) => {
    await requireMemberManage(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { invite, token } = await createInvitation({
      tenantId: tenantOf(req),
      orgId: req.params.orgId,
      email: requireString(body.email, 'email'),
      role: body.role ?? 'viewer',
    }).catch(asHttp);
    res.status(201).json({ invite, ...(EXPOSE_TOKENS ? { token } : {}) });
  }));

  app.get('/v1/host/sample/orgs/:orgId/invites', h(async (req, res, _user) => {
    await requireMemberManage(req);
    res.json({ invites: await listInvitations(tenantOf(req), req.params.orgId).catch(asHttp) });
  }));

  app.delete('/v1/host/sample/orgs/:orgId/invites/:inviteId', h(async (req, res, _user) => {
    await requireMemberManage(req);
    await revokeInvitation(tenantOf(req), req.params.orgId, req.params.inviteId).catch(asHttp);
    res.status(204).end();
  }));

  // Accept is NOT scope-gated — any signed-in user may accept an invite issued
  // to THEIR email (the email-ownership check is the gate). Path is unambiguous
  // (not `/orgs/:orgId`) so it can't collide with accessControl's org routes.
  app.post('/v1/host/sample/orgs/invitations/accept', h(async (req, res, user) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const member = await acceptInvitation(requireString(body.token, 'token'), user).catch(asHttp);
    log.info('org_invite_accepted', { orgId: member.orgId, memberId: member.memberId });
    res.status(201).json(member);
  }));
}

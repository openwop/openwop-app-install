/**
 * Collaboration / Comments routes (host-extension, ADR 0021). Authed + org-scoped
 * + RBAC — NO public surface. Threaded comments that reference a `(resourceType,
 * resourceId)` validated in-org by the resolver registry; add/reply emit a
 * tenant-scoped notification through the existing emitter (no new channel).
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireString, optionalString } from '../featureRoute.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import {
  RESOURCE_TYPES, isResourceType,
  listThread, createComment, updateComment, deleteComment,
} from './commentsService.js';
import { emitCommentNotification } from './notifications.js';

const FEATURE = { toggleId: 'comments', label: 'Collaboration / Comments' };
const ORG = '/v1/host/sample/comments/orgs/:orgId';
type Scope = 'workspace:read' | 'workspace:write';

export function registerCommentsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const authz = (req: Request, scope: Scope) => authorizeOrgScope(req, FEATURE, scope);

  // ── read a thread ──
  app.get(`${ORG}/comments`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:read');
      const resourceType = optionalString(req.query.resourceType);
      const resourceId = optionalString(req.query.resourceId);
      if (!isResourceType(resourceType)) throw new OpenwopError('validation_error', `\`resourceType\` MUST be one of: ${RESOURCE_TYPES.join(', ')}.`, 400, { field: 'resourceType' });
      if (!resourceId) throw new OpenwopError('validation_error', '`resourceId` is required.', 400, { field: 'resourceId' });
      res.json({ comments: await listThread(user.tenantId, orgId, resourceType, resourceId) });
    } catch (err) { next(err); }
  });

  // ── add a comment / reply ──
  app.post(`${ORG}/comments`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { comment, notify } = await createComment({
        tenantId: user.tenantId, orgId,
        resourceType: body.resourceType, resourceId: body.resourceId,
        ...(body.parentId != null ? { parentId: body.parentId } : {}),
        body: body.body, authorId: user.userId,
      });
      await emitCommentNotification(comment, notify);
      res.status(201).json(comment);
    } catch (err) { next(err); }
  });

  // ── edit own body / resolve / reopen ──
  app.patch(`${ORG}/comments/:commentId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: { body?: unknown; status?: unknown } = {};
      if (body.body !== undefined) patch.body = requireString(body.body, 'body');
      if (body.status !== undefined) patch.status = body.status;
      const c = await updateComment(user.tenantId, orgId, req.params.commentId, user.userId, patch);
      if (!c) throw new OpenwopError('not_found', 'Comment not found.', 404, { commentId: req.params.commentId });
      res.json(c);
    } catch (err) { next(err); }
  });

  // ── delete (author or org-admin) ──
  app.delete(`${ORG}/comments/:commentId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const access = await resolveEffectiveAccess(user.tenantId, { subject: user.userId, orgId });
      const isAdmin = access.roles.includes('admin') || access.roles.includes('owner');
      if (!(await deleteComment(user.tenantId, orgId, req.params.commentId, { userId: user.userId, isAdmin }))) {
        throw new OpenwopError('not_found', 'Comment not found.', 404, { commentId: req.params.commentId });
      }
      res.status(204).end();
    } catch (err) { next(err); }
  });
}

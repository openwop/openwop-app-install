/**
 * ADR 0953 P0 — social post routes, per client org.
 *
 *   GET    …/social/orgs/:orgId/posts            workspace:read
 *   POST   …/social/orgs/:orgId/posts            workspace:write  (a draft)
 *   GET    …/social/orgs/:orgId/posts/:postId    workspace:read
 *   PATCH  …/social/orgs/:orgId/posts/:postId    workspace:write  (content edits void the approval)
 *   POST   …/social/orgs/:orgId/posts/:postId/cancel  workspace:write
 *   DELETE …/social/orgs/:orgId/posts/:postId    workspace:write  (draft or canceled only)
 *
 * There is no publish route: posting runs only as a chain step behind the ADR
 * 0942 gate (P2). A caller who cannot read the org gets the same 404 as an org
 * that does not exist; a reader without write gets 403.
 *
 * @see docs/adr/0953-social-publishing-and-scheduling.md
 */
import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { requireFeatureEnabled, requireOrgScope, tenantOf } from '../featureRoute.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { cancelPost, createDraft, deletePost, getPost, listPosts, updatePost, type DraftInput } from './postService.js';
import { SOCIAL_POST_STATUSES, type SocialPostStatus } from './types.js';

export const SOCIAL_PUBLISHING_TOGGLE = 'social-publishing';
const LABEL = 'Social publishing';
const BASE = '/host/openwop-app/social/orgs/:orgId/posts';

async function authorize(req: Request, scope: Scope): Promise<{ tenantId: string; orgId: string; userId: string }> {
  await requireFeatureEnabled(req, SOCIAL_PUBLISHING_TOGGLE, LABEL);
  const orgId = req.params.orgId as string;
  try {
    const { user, tenantId } = await requireOrgScope(req, scope);
    return { tenantId, orgId, userId: user.userId };
  } catch (err) {
    // An org the caller cannot even read is indistinguishable from none.
    if (err instanceof OpenwopError && err.code === 'forbidden_scope' && scope !== 'workspace:read') {
      const subject = (await resolveCallerUser(req)).userId;
      const canRead = (await resolveEffectiveAccess(tenantOf(req), { subject, orgId })).scopes.includes('workspace:read');
      if (canRead) throw err;
    }
    if (err instanceof OpenwopError && (err.code === 'forbidden_scope' || err.code === 'not_found')) {
      throw new OpenwopError('not_found', 'Not found.', 404, {});
    }
    throw err;
  }
}

const notFound = (): OpenwopError => new OpenwopError('not_found', 'Post not found.', 404, {});

export function registerSocialPublishingRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get(BASE, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await authorize(req, 'workspace:read');
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      if (status !== undefined && !(SOCIAL_POST_STATUSES as readonly string[]).includes(status)) {
        throw new OpenwopError('validation_error', `status must be one of ${SOCIAL_POST_STATUSES.join(', ')}.`, 400, { field: 'status' });
      }
      const campaignId = typeof req.query.campaignId === 'string' && req.query.campaignId ? req.query.campaignId : undefined;
      res.json({ posts: await listPosts(tenantId, orgId, { ...(status ? { status: status as SocialPostStatus } : {}), ...(campaignId ? { campaignId } : {}) }) });
    } catch (err) { next(err); }
  });

  app.post(BASE, async (req, res, next) => {
    try {
      const { tenantId, orgId, userId } = await authorize(req, 'workspace:write');
      res.status(201).json({ post: await createDraft(tenantId, orgId, (req.body ?? {}) as DraftInput, userId) });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/:postId`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await authorize(req, 'workspace:read');
      const post = await getPost(tenantId, orgId, req.params.postId as string);
      if (!post) throw notFound();
      res.json({ post });
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/:postId`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await authorize(req, 'workspace:write');
      const post = await updatePost(tenantId, orgId, req.params.postId as string, (req.body ?? {}) as DraftInput & { expectedVersion?: unknown });
      if (!post) throw notFound();
      res.json({ post });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/:postId/cancel`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await authorize(req, 'workspace:write');
      const post = await cancelPost(tenantId, orgId, req.params.postId as string);
      if (!post) throw notFound();
      res.json({ post });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/:postId`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await authorize(req, 'workspace:write');
      if (!(await deletePost(tenantId, orgId, req.params.postId as string))) throw notFound();
      res.status(204).end();
    } catch (err) { next(err); }
  });
}

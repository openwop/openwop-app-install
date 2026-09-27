/**
 * kicktodo-community REST (ADR 0426 P1/P2/P3) — profiles (owner CRUD +
 * submit + decide), proof-gated reviews (+ flag/moderate), counts-only
 * creator analytics. `/kicktodo/community` (the reserved-namespace guard
 * forbids `/kicktodo/marketplace`).
 */

import type { Request, Response, NextFunction, Express } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { callerSubject, tenantOf } from '../../host/requestSubject.js';
import { requireFeatureEnabled, requireKicktodoManage, requireString } from '../featureRoute.js';
import { revenueProjectionFor } from '../kicktodo-commerce/entitlementService.js';
import {
  upsertProfile,
  myProfile,
  submitProfile,
  applyProfileDecision,
  publicProfileByHandle,
  putReview,
  visibleReviews,
  aggregateRating,
  flagReview,
  resolveReviewFlag,
  creatorAnalytics,
  HandleTakenError,
  ProfileInvalidError,
  ReviewProofError,
  NotFoundError,
  SeparationOfDutiesError,
} from './communityService.js';

export const KICKTODO_COMMUNITY_PREFIX = '/v1/host/openwop-app/kicktodo/community';

type Handler = (req: Request, res: Response) => Promise<void>;

function subjectOf(req: Request): string {
  const s = callerSubject(req);
  if (!s) throw new OpenwopError('unauthenticated', 'An identified caller is required.', 401);
  return s;
}

async function gate(req: Request): Promise<void> {
  await requireFeatureEnabled(req, 'kicktodo-community', 'KickTodo Community');
}

function mapError(err: unknown): never {
  if (err instanceof HandleTakenError) throw new OpenwopError('conflict', err.message, 409);
  if (err instanceof ProfileInvalidError) throw new OpenwopError('validation_error', err.message, 422);
  if (err instanceof ReviewProofError) throw new OpenwopError('forbidden', err.message, 403);
  if (err instanceof SeparationOfDutiesError) throw new OpenwopError('forbidden', err.message, 403);
  if (err instanceof NotFoundError) throw new OpenwopError('not_found', 'Not found.', 404);
  throw err;
}

export const KICKTODO_COMMUNITY_ROUTES: ReadonlyArray<{ method: 'get' | 'post'; path: string; handler: Handler }> = [
  {
    method: 'get',
    path: `${KICKTODO_COMMUNITY_PREFIX}/profile`,
    handler: async (req, res) => {
      await gate(req);
      res.json({ profile: await myProfile(tenantOf(req), subjectOf(req)) });
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_COMMUNITY_PREFIX}/profile`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      try {
        res.json(await upsertProfile(tenantOf(req), subjectOf(req), {
          handle: requireString(b.handle, 'handle'),
          displayName: requireString(b.displayName, 'displayName'),
          bio: typeof b.bio === 'string' ? b.bio : undefined,
          links: Array.isArray(b.links) ? (b.links as string[]) : undefined,
          localizations: b.localizations, // ADR 0453 P2 — validated in upsertProfile
        }));
      } catch (err) {
        mapError(err);
      }
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_COMMUNITY_PREFIX}/profile/submit`,
    handler: async (req, res) => {
      await gate(req);
      try {
        res.json(await submitProfile(tenantOf(req), subjectOf(req)));
      } catch (err) {
        mapError(err);
      }
    },
  },
  {
    // Moderation resolution (separation of duties enforced in the service).
    method: 'post',
    path: `${KICKTODO_COMMUNITY_PREFIX}/profile/decide`,
    handler: async (req, res) => {
      await requireKicktodoManage(req, 'kicktodo-community', 'KickTodo Community');
      const b = (req.body ?? {}) as Record<string, unknown>;
      try {
        res.json(await applyProfileDecision(
          tenantOf(req),
          requireString(b.creatorSubject, 'creatorSubject'),
          subjectOf(req),
          b.approve === true,
        ));
      } catch (err) {
        mapError(err);
      }
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_COMMUNITY_PREFIX}/profiles/:handle`,
    handler: async (req, res) => {
      await gate(req);
      // ADR 0453 P3 — pass the visitor's requested content locale (explicit
      // ?locale= wins, else Accept-Language) so displayName/bio are localized.
      const explicit = typeof req.query.locale === 'string' ? req.query.locale : undefined;
      const acceptLanguage = typeof req.headers['accept-language'] === 'string' ? req.headers['accept-language'] : undefined;
      const p = await publicProfileByHandle(tenantOf(req), req.params.handle, {
        ...(explicit ? { explicit } : {}),
        ...(acceptLanguage ? { acceptLanguage } : {}),
      });
      if (!p) throw new OpenwopError('not_found', 'Not found.', 404);
      res.json(p);
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_COMMUNITY_PREFIX}/reviews`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.challengeVersion !== 'number' || typeof b.rating !== 'number') {
        throw new OpenwopError('validation_error', 'Fields `challengeVersion` and `rating` must be numbers.', 400);
      }
      try {
        res.json(await putReview(tenantOf(req), subjectOf(req), {
          challengeId: requireString(b.challengeId, 'challengeId'),
          challengeVersion: b.challengeVersion,
          rating: b.rating,
          body: typeof b.body === 'string' ? b.body : undefined,
        }));
      } catch (err) {
        mapError(err);
      }
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_COMMUNITY_PREFIX}/reviews/:challengeId`,
    handler: async (req, res) => {
      await gate(req);
      const tenant = tenantOf(req);
      res.json({
        reviews: await visibleReviews(tenant, req.params.challengeId),
        aggregate: await aggregateRating(tenant, req.params.challengeId),
      });
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_COMMUNITY_PREFIX}/reviews/flag`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      try {
        res.json(await flagReview(
          tenantOf(req),
          subjectOf(req),
          requireString(b.challengeId, 'challengeId'),
          requireString(b.reviewerSubject, 'reviewerSubject'),
          requireString(b.reason, 'reason'),
        ));
      } catch (err) {
        mapError(err);
      }
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_COMMUNITY_PREFIX}/reviews/resolve-flag`,
    handler: async (req, res) => {
      // ADR 0434 (KTFULL-B15) — resolving a moderation flag decides whether
      // content stays visible; it is a MODERATOR act, not something any
      // authenticated co-tenant may do.
      await requireKicktodoManage(req, 'kicktodo-community', 'KickTodo Community');
      const b = (req.body ?? {}) as Record<string, unknown>;
      try {
        res.json(await resolveReviewFlag(
          tenantOf(req),
          requireString(b.challengeId, 'challengeId'),
          requireString(b.reviewerSubject, 'reviewerSubject'),
          b.remove === true,
        ));
      } catch (err) {
        mapError(err);
      }
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_COMMUNITY_PREFIX}/analytics`,
    handler: async (req, res) => {
      await gate(req);
      res.json({ challenges: await creatorAnalytics(tenantOf(req), subjectOf(req), revenueProjectionFor) });
    },
  },
];

export function registerKicktodoCommunityRoutes(deps: RouteDeps): void {
  const app: Express = deps.app;
  const wrap = (h: Handler) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await h(req, res);
    } catch (err) {
      next(err);
    }
  };
  for (const r of KICKTODO_COMMUNITY_ROUTES) {
    app[r.method](r.path, wrap(r.handler));
  }
}

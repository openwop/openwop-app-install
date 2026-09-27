/**
 * kicktodo-engagement REST (ADR 0425 P1/P3) — opt-in CRUD, the ONE aggregate
 * leaderboard read, awards, and the counts-only effectiveness read.
 */

import type { Request, Response, NextFunction, Express } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { callerSubject, tenantOf } from '../../host/requestSubject.js';
import { requireFeatureEnabled, requireString } from '../featureRoute.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import {
  optIn,
  optOut,
  myOptIn,
  leaderboard,
  listAwards,
  effectivenessByVariant,
  NotEnrolledError,
  OptInRequiredError,
} from './engagementService.js';

export const KICKTODO_ENGAGEMENT_PREFIX = '/v1/host/openwop-app/kicktodo/engagement';

type Handler = (req: Request, res: Response) => Promise<void>;

function subjectOf(req: Request): string {
  const s = callerSubject(req);
  if (!s) throw new OpenwopError('unauthenticated', 'An identified caller is required.', 401);
  return s;
}

async function gate(req: Request): Promise<void> {
  await requireFeatureEnabled(req, 'kicktodo-engagement', 'KickTodo Engagement');
}

export const KICKTODO_ENGAGEMENT_ROUTES: ReadonlyArray<{ method: 'get' | 'post'; path: string; handler: Handler }> = [
  {
    method: 'get',
    path: `${KICKTODO_ENGAGEMENT_PREFIX}/opt-in`,
    handler: async (req, res) => {
      await gate(req);
      res.json({ optIn: await myOptIn(tenantOf(req), subjectOf(req)) });
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_ENGAGEMENT_PREFIX}/opt-in`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      res.json(await optIn(tenantOf(req), subjectOf(req), requireString(b.displayName, 'displayName')));
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_ENGAGEMENT_PREFIX}/opt-out`,
    handler: async (req, res) => {
      await gate(req);
      await optOut(tenantOf(req), subjectOf(req));
      res.json({ optedOut: true });
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_ENGAGEMENT_PREFIX}/leaderboard`,
    handler: async (req, res) => {
      await gate(req);
      // ADR 0641 decision 13 — a board belongs to ONE challenge. Required, and
      // validated here rather than defaulted: a missing id previously meant "the
      // whole tenant", so silently falling back would reinstate the cross-challenge
      // board this route exists to remove.
      const challengeId = typeof req.query.challengeId === 'string' ? req.query.challengeId.trim() : '';
      if (!challengeId) {
        throw new OpenwopError('validation_error', 'challengeId is required.', 400, { field: 'challengeId' });
      }
      try {
        res.json(await leaderboard(tenantOf(req), subjectOf(req), challengeId));
      } catch (err) {
        // 404, not 403: a non-participant must not learn whether this challenge
        // has a board at all. `OptInRequiredError` keeps its 409 — that one is
        // an actionable "join the board", addressed to someone already inside.
        if (err instanceof NotEnrolledError) throw new OpenwopError('not_found', err.message, 404);
        if (err instanceof OptInRequiredError) throw new OpenwopError('conflict', err.message, 409);
        throw err;
      }
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_ENGAGEMENT_PREFIX}/awards`,
    handler: async (req, res) => {
      await gate(req);
      res.json({ awards: await listAwards(tenantOf(req), subjectOf(req)) });
    },
  },
  {
    // Counts-only effectiveness by toggle variant (ADR 0425 P3).
    method: 'get',
    path: `${KICKTODO_ENGAGEMENT_PREFIX}/effectiveness`,
    handler: async (req, res) => {
      await gate(req);
      const tenant = tenantOf(req);
      res.json({
        byVariant: await effectivenessByVariant(tenant, async (subject) => {
          const a = await resolveOne('kicktodo-engagement', { tenantId: tenant, userId: subject });
          return a?.variant ?? 'default';
        }),
      });
    },
  },
];

export function registerKicktodoEngagementRoutes(deps: RouteDeps): void {
  const app: Express = deps.app;
  const wrap = (h: Handler) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await h(req, res);
    } catch (err) {
      next(err);
    }
  };
  for (const r of KICKTODO_ENGAGEMENT_ROUTES) {
    app[r.method](r.path, wrap(r.handler));
  }
}

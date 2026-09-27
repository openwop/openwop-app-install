/**
 * Promotions routes (ADR 0274 / MERCH-B). Authed operator surface under
 * `/v1/host/openwop-app/promotions/orgs/:orgId` (toggle `promotions` +
 * `authorizeOrgScope`; read = workspace:read, write = workspace:write; tenant+org
 * IDOR-guarded). Promotion evaluation itself rides the commerce order path via the
 * `promotionSeam` hook — there is no public promotions route (promotion DISPLAY on
 * the storefront reads the discounted price through the existing public-store).
 */
import type { Request, Response } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope } from '../featureRoute.js';
import {
  listPromotions, getPromotion, createPromotion, updatePromotion, deletePromotion, promotionUsage,
} from './promotionsService.js';

const FEATURE = { toggleId: 'promotions', label: 'Promotions' };
const BASE = '/v1/host/openwop-app/promotions/orgs/:orgId';

export function registerPromotionsRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get(`${BASE}/promotions`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      // R3 P-5 — the burn was invisible on every surface: the engine derives
      // promotionUsage but no route returned it, so an exhausted promotion
      // still read Active. Serialized as an object keyed by promotionId.
      const [promotions, usage] = await Promise.all([listPromotions(tenantId, orgId), promotionUsage(tenantId, orgId)]);
      res.json({ promotions, usage: Object.fromEntries(usage) });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/promotions/:promotionId`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      const promotion = await getPromotion(tenantId, orgId, req.params.promotionId);
      if (!promotion) throw new OpenwopError('not_found', 'Promotion not found.', 404, {});
      res.json({ promotion });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/promotions`, async (req: Request, res: Response, next) => {
    try {
      const { user, orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const b = req.body ?? {};
      const promotion = await createPromotion({
        tenantId, orgId, createdBy: user.userId,
        name: b.name, type: b.type, reward: b.reward, scope: b.scope, minSpend: b.minSpend, minQuantity: b.minQuantity, bogo: b.bogo,
        budget: b.budget, segmentId: b.segmentId, schedule: b.schedule, priority: b.priority, stackable: b.stackable, active: b.active,
        // R2 PRO2-P1 (review B2) — the route DROPPED `currency`, so the field the service
        // captures and the engine enforces could never be set by anything but a direct
        // service call: every production row stayed currency-less, took the `!p.currency`
        // escape, and the engine was byte-identical to pre-R2. The fix was inert.
        currency: b.currency,
      });
      res.status(201).json({ promotion });
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/promotions/:promotionId`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const b = req.body ?? {};
      const promotion = await updatePromotion(tenantId, orgId, req.params.promotionId, {
        name: b.name, reward: b.reward, scope: b.scope, minSpend: b.minSpend, priority: b.priority, stackable: b.stackable, active: b.active, segmentId: b.segmentId,
        // R2 PRO2-P4 (review B3) — same shape on the PATCH: the service learned to patch
        // `budget`/`schedule` and the route never forwarded them, so "write-once and
        // unreachable from every surface" stayed literally true after the fix. And
        // `currency` must be patchable, or a mis-set one is unfixable — which is P-4's
        // own complaint about the budget.
        budget: b.budget, schedule: b.schedule, currency: b.currency,
      });
      if (!promotion) throw new OpenwopError('not_found', 'Promotion not found.', 404, {});
      res.json({ promotion });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/promotions/:promotionId`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const ok = await deletePromotion(tenantId, orgId, req.params.promotionId);
      if (!ok) throw new OpenwopError('not_found', 'Promotion not found.', 404, {});
      res.json({ ok: true });
    } catch (err) { next(err); }
  });
}

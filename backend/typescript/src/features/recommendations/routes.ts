/**
 * Recommendations routes (ADR 0273 / MERCH-A). Authed operator surface under
 * `/v1/host/openwop-app/recommendations/orgs/:orgId` (toggle `recommendations` +
 * `authorizeOrgScope`; read = workspace:read, write = workspace:write; tenant+org
 * IDOR-guarded) + a PUBLIC storefront resolve under `/public-recommendations/:orgId`.
 *
 * IDOR invariant (ADR 0273 /architect): the PUBLIC resolve does NOT accept a
 * `contactId` — anonymous personalization would let a caller harvest another
 * contact's segment-targeted recs. Segment targeting on the public route is
 * inert (no contact identity); the authed operator route accepts `contactId` for
 * preview because it is already RBAC-gated.
 */
import type { Request, Response } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, optionalString } from '../featureRoute.js';
import { getOrg } from '../../host/accessControlService.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import type { Product } from '../commerce/commerceService.js';
import {
  listPlacements, createPlacement, updatePlacement, deletePlacement,
  resolveRecommendations, rebuildAffinity, RECO_SLOTS, type RecoSlot,
} from './recommendationsService.js';

const FEATURE = { toggleId: 'recommendations', label: 'Recommendations' };
const BASE = '/v1/host/openwop-app/recommendations/orgs/:orgId';

/** Public-safe product projection — never leaks inventory/operational fields. */
function publicProduct(p: Product): Record<string, unknown> {
  return {
    productId: p.productId, type: p.type, name: p.name, description: p.description,
    price: p.price, currency: p.currency, imageAssetTokens: p.imageAssetTokens,
    categories: p.categories ?? [], tags: p.tags ?? [],
  };
}
function coerceSlot(v: unknown): RecoSlot {
  if ((RECO_SLOTS as readonly string[]).includes(String(v))) return String(v) as RecoSlot;
  throw new OpenwopError('validation_error', `slot must be one of: ${RECO_SLOTS.join(', ')}`, 400, { field: 'slot' });
}
function clampLimit(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(24, Math.floor(n)) : undefined;
}

export function registerRecommendationsRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // ── Placements (merchandiser config) ──
  app.get(`${BASE}/placements`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      res.json({ placements: await listPlacements(tenantId, orgId) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/placements`, async (req: Request, res: Response, next) => {
    try {
      const { user, orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const b = req.body ?? {};
      const placement = await createPlacement({
        tenantId, orgId, createdBy: user.userId,
        slot: b.slot, source: b.source, segmentId: b.segmentId, holdoutPct: b.holdoutPct, active: b.active,
      });
      res.status(201).json({ placement });
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/placements/:placementId`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const b = req.body ?? {};
      const placement = await updatePlacement(tenantId, orgId, req.params.placementId, {
        source: b.source, segmentId: b.segmentId, holdoutPct: b.holdoutPct, active: b.active,
      });
      if (!placement) throw new OpenwopError('not_found', 'Placement not found.', 404, {});
      res.json({ placement });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/placements/:placementId`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const ok = await deletePlacement(tenantId, orgId, req.params.placementId);
      if (!ok) throw new OpenwopError('not_found', 'Placement not found.', 404, {});
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ── Manual affinity rebuild (the daemon does this on a cadence too) ──
  app.post(`${BASE}/affinity/rebuild`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      // R2 REC2-B3 — report the REMOVALS too: "0 products" used to read as "nothing to
      // do" while stale rows kept serving as Trending.
      const { written, removed } = await rebuildAffinity(tenantId, orgId);
      res.json({ ok: true, rows: written, removed });
    } catch (err) { next(err); }
  });

  // ── Authed operator resolve (preview) — contactId allowed (RBAC-gated). ──
  app.get(`${BASE}/resolve`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      const result = await resolveRecommendations({
        tenantId, orgId, slot: coerceSlot(req.query.slot),
        ...(optionalString(req.query.productId) ? { productId: optionalString(req.query.productId)! } : {}),
        ...(optionalString(req.query.contactId) ? { contactId: optionalString(req.query.contactId)! } : {}),
        ...(optionalString(req.query.sessionKey) ? { sessionKey: optionalString(req.query.sessionKey)! } : {}),
        ...(clampLimit(req.query.limit) !== undefined ? { limit: clampLimit(req.query.limit)! } : {}),
      });
      res.json({ ...result, products: result.products.map(publicProduct) });
    } catch (err) { next(err); }
  });

  // ── PUBLIC storefront resolve — tenant from the RESOURCE, active only, NO contactId. ──
  app.get('/v1/host/openwop-app/public-recommendations/:orgId/resolve', async (req: Request, res: Response, next) => {
    try {
      const org = await getOrg(req.params.orgId);
      if (!org) throw new OpenwopError('not_found', 'Store not found.', 404, {});
      // Honor the toggle: an OFF tenant surfaces no recs (never an error on a public read).
      const assignment = await resolveOne(FEATURE.toggleId, { tenantId: org.tenantId });
      if (!assignment?.enabled) { res.json({ products: [] }); return; }
      const result = await resolveRecommendations({
        tenantId: org.tenantId, orgId: req.params.orgId, slot: coerceSlot(req.query.slot),
        // NO contactId — public IDOR invariant (ADR 0273). sessionKey is opaque + non-PII.
        ...(optionalString(req.query.productId) ? { productId: optionalString(req.query.productId)! } : {}),
        ...(optionalString(req.query.sessionKey) ? { sessionKey: optionalString(req.query.sessionKey)! } : {}),
        ...(clampLimit(req.query.limit) !== undefined ? { limit: clampLimit(req.query.limit)! } : {}),
      });
      res.json({ products: result.products.map(publicProduct), ...(result.variant ? { variant: result.variant } : {}) });
    } catch (err) { next(err); }
  });
}

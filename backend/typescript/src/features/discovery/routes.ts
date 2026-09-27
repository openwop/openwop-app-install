/**
 * Discovery routes (ADR 0275 / MERCH-C). Authed operator surface under
 * `/v1/host/openwop-app/discovery/orgs/:orgId` (toggle `discovery` +
 * `authorizeOrgScope`; read = workspace:read, write = workspace:write; tenant+org
 * IDOR-guarded) + a PUBLIC storefront search under `/public-discovery/:orgId/*`
 * (tenant-from-resource, ACTIVE products only, facet counts over the active set).
 */
import type { Request, Response } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, optionalString } from '../featureRoute.js';
import { getOrg } from '../../host/accessControlService.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import type { Product } from '../commerce/commerceService.js';
import {
  listCollections, createCollection, updateCollection, deleteCollection, resolveCollection,
  listMerchRules, createMerchRule, deleteMerchRule, searchProducts,
} from './discoveryService.js';
import { rebuildProductEmbeddings, invalidateProductEmbeddings } from './productEmbeddingIndex.js';

const FEATURE = { toggleId: 'discovery', label: 'Discovery' };
const BASE = '/v1/host/openwop-app/discovery/orgs/:orgId';

function publicProduct(p: Product): Record<string, unknown> {
  return { productId: p.productId, type: p.type, name: p.name, description: p.description, price: p.price, currency: p.currency, imageAssetTokens: p.imageAssetTokens, categories: p.categories ?? [], tags: p.tags ?? [] };
}
function parseFilters(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string' && v) out[k] = v;
  return out;
}

export function registerDiscoveryRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // ── Collections ──
  app.get(`${BASE}/collections`, async (req: Request, res: Response, next) => {
    try { const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read'); res.json({ collections: await listCollections(tenantId, orgId) }); }
    catch (err) { next(err); }
  });
  app.post(`${BASE}/collections`, async (req: Request, res: Response, next) => {
    try {
      const { user, orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const b = req.body ?? {};
      const collection = await createCollection({ tenantId, orgId, createdBy: user.userId, name: b.name, type: b.type, productIds: b.productIds, rule: b.rule, parentId: b.parentId });
      res.status(201).json({ collection });
    } catch (err) { next(err); }
  });
  app.patch(`${BASE}/collections/:collectionId`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const b = req.body ?? {};
      const collection = await updateCollection(tenantId, orgId, req.params.collectionId, { name: b.name, productIds: b.productIds, rule: b.rule, active: b.active, parentId: b.parentId });
      if (!collection) throw new OpenwopError('not_found', 'Collection not found.', 404, {});
      res.json({ collection });
    } catch (err) { next(err); }
  });
  app.delete(`${BASE}/collections/:collectionId`, async (req: Request, res: Response, next) => {
    try { const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write'); const ok = await deleteCollection(tenantId, orgId, req.params.collectionId); if (!ok) throw new OpenwopError('not_found', 'Collection not found.', 404, {}); res.json({ ok: true }); }
    catch (err) { next(err); }
  });

  // ── Merch rules ──
  app.get(`${BASE}/rules`, async (req: Request, res: Response, next) => {
    try { const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read'); res.json({ rules: await listMerchRules(tenantId, orgId) }); }
    catch (err) { next(err); }
  });
  app.post(`${BASE}/rules`, async (req: Request, res: Response, next) => {
    try {
      const { user, orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const b = req.body ?? {};
      const rule = await createMerchRule({ tenantId, orgId, createdBy: user.userId, name: b.name, scope: b.scope, actions: b.actions, holdoutPct: b.holdoutPct });
      res.status(201).json({ rule });
    } catch (err) { next(err); }
  });
  app.delete(`${BASE}/rules/:ruleId`, async (req: Request, res: Response, next) => {
    try { const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write'); const ok = await deleteMerchRule(tenantId, orgId, req.params.ruleId); if (!ok) throw new OpenwopError('not_found', 'Rule not found.', 404, {}); res.json({ ok: true }); }
    catch (err) { next(err); }
  });

  // ── Manual semantic-index rebuild (MERCH-C Part B) — force a refresh now. ──
  app.post(`${BASE}/embeddings/rebuild`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      invalidateProductEmbeddings(tenantId, orgId);
      const rows = await rebuildProductEmbeddings(tenantId, orgId);
      res.json({ ok: true, products: rows });
    } catch (err) { next(err); }
  });

  // ── Authed search + preview (operator; merch-rules applied, no holdout unless sessionKey) ──
  app.get(`${BASE}/search`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      const result = await searchProducts({ tenantId, orgId,
        ...(optionalString(req.query.q) ? { q: optionalString(req.query.q)! } : {}),
        ...(optionalString(req.query.collectionId) ? { collectionId: optionalString(req.query.collectionId)! } : {}),
        filters: parseFilters(req.query.filters), ...(optionalString(req.query.sessionKey) ? { sessionKey: optionalString(req.query.sessionKey)! } : {}) });
      // R2 PD2-3 (review B1) — the honest counts have to REACH the client. They were
      // computed, typed, and consumed behind `?? products.length` fallbacks, which
      // turned this missing line into the ORIGINAL defect (the cap rendered as the
      // total) instead of a compile error. The client fields are required now.
      res.json({ products: result.products.map(publicProduct), facets: result.facets, appliedRuleIds: result.appliedRuleIds, total: result.total, truncated: result.truncated, hiddenByRules: result.hiddenByRules });
    } catch (err) { next(err); }
  });
  app.get(`${BASE}/collections/:collectionId/resolve`, async (req: Request, res: Response, next) => {
    try { const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read'); res.json({ products: (await resolveCollection(tenantId, orgId, req.params.collectionId, false)).map(publicProduct) }); }
    catch (err) { next(err); }
  });

  // ── PUBLIC storefront search — tenant from resource, active only, no personalization. ──
  app.get('/v1/host/openwop-app/public-discovery/:orgId/search', async (req: Request, res: Response, next) => {
    try {
      const org = await getOrg(req.params.orgId);
      if (!org) throw new OpenwopError('not_found', 'Store not found.', 404, {});
      const assignment = await resolveOne(FEATURE.toggleId, { tenantId: org.tenantId });
      if (!assignment?.enabled) { res.json({ products: [], facets: [] }); return; }
      const result = await searchProducts({ tenantId: org.tenantId, orgId: req.params.orgId,
        ...(optionalString(req.query.q) ? { q: optionalString(req.query.q)! } : {}),
        ...(optionalString(req.query.collectionId) ? { collectionId: optionalString(req.query.collectionId)! } : {}),
        filters: parseFilters(req.query.filters), ...(optionalString(req.query.sessionKey) ? { sessionKey: optionalString(req.query.sessionKey)! } : {}) });
      // The public storefront gets the page/total honesty but NOT `hiddenByRules` —
      // how many products a merchant's rules suppress is merchandising config, and it
      // belongs on the operator console only (review B1).
      res.json({ products: result.products.map(publicProduct), facets: result.facets, total: result.total, truncated: result.truncated });
    } catch (err) { next(err); }
  });
}

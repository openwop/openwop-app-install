/**
 * UCP buyer routes (ADR 0188) — the OUTBOUND agentic-shopping surface, gated by
 * the `commerce-ucp-buyer` toggle (OFF; independent of `commerce`/`commerce-ucp`).
 * No public surface — this is the opposite of the UCP server: operator/agent-side
 * only, org-scoped, with the checkout money gate enforced in the service.
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../../routes/registerAllRoutes.js';
import { getApproval } from '../../../host/approvalService.js';
import { authorizeOrgScope, requireString, optionalString } from '../../featureRoute.js';
import type { Scope } from '../../../host/accessControlService.js';
import type { User } from '../../users/usersService.js';
import { OpenwopError } from '../../../types.js';
import {
  discoverMerchant, searchMerchantCatalog, buildPurchaseDraft,
  checkoutPurchase, trackPurchase, listPurchases, getPurchase, closeUnknownPurchase,
} from './ucpBuyerService.js';

const FEATURE = { toggleId: 'commerce-ucp-buyer', label: 'UCP buyer' };
const BASE = '/v1/host/openwop-app/commerce/orgs/:orgId/ucp-buyer';
interface Ctx { user: User; orgId: string; tenantId: string }
const authz = (req: Request, scope: Scope): Promise<Ctx> => authorizeOrgScope(req, FEATURE, scope);

export function registerUcpBuyerRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.post(`${BASE}/discover`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:read');
      const b = (req.body ?? {}) as { merchantUrl?: unknown; merchantServerId?: unknown };
      res.json({ discovery: await discoverMerchant(ctx.tenantId, b, { actingUserId: ctx.user.userId, orgId: ctx.orgId }) });
    } catch (err) { next(err); }
  });
  app.post(`${BASE}/catalog-search`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:read');
      const b = (req.body ?? {}) as { merchantUrl?: unknown; merchantServerId?: unknown; q?: unknown };
      res.json({ catalog: await searchMerchantCatalog(ctx.tenantId, { ...b, q: optionalString(b.q) }, { actingUserId: ctx.user.userId, orgId: ctx.orgId }) });
    } catch (err) { next(err); }
  });
  app.get(`${BASE}/purchases`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:read'); res.json({ purchases: await listPurchases(ctx.tenantId, ctx.orgId) }); } catch (err) { next(err); }
  });
  app.get(`${BASE}/purchases/:purchaseId`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:read');
      const p = await getPurchase(ctx.tenantId, ctx.orgId, req.params.purchaseId);
      if (!p) throw new OpenwopError('not_found', 'Purchase not found.', 404, { purchaseId: req.params.purchaseId });
      // R2 (review M-5) — project the SIGN-OFF's state so the detail page can offer the
      // placement button only where it can succeed, instead of rendering a primary money
      // CTA that always 409s while the approval is still pending.
      const appr = p.approvalId ? await getApproval(p.approvalId) : null;
      res.json({ ...p, ...(appr && appr.tenantId === ctx.tenantId ? { approvalStatus: appr.status } : {}) });
    } catch (err) { next(err); }
  });
  app.post(`${BASE}/purchases`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:write');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const p = await buildPurchaseDraft({
        tenantId: ctx.tenantId, orgId: ctx.orgId, createdBy: ctx.user.userId,
        merchantUrl: b.merchantUrl, merchantServerId: b.merchantServerId, intent: b.intent, maxAmountMinor: b.maxAmountMinor,
        currency: b.currency, lines: Array.isArray(b.lines) ? b.lines as Record<string, unknown>[] : [],
      });
      res.status(201).json(p);
    } catch (err) { next(err); }
  });
  app.post(`${BASE}/purchases/:purchaseId/checkout`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:write'); res.json(await checkoutPurchase(ctx.tenantId, ctx.orgId, requireString(req.params.purchaseId, 'purchaseId'), { actor: ctx.user.userId })); } catch (err) { next(err); }
  });
  app.post(`${BASE}/purchases/:purchaseId/track`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:read'); res.json(await trackPurchase(ctx.tenantId, ctx.orgId, req.params.purchaseId, { actingUserId: ctx.user.userId })); } catch (err) { next(err); }
  });

  // R3 B-2 — the explicit operator close for an 'unknown' purchase (the state
  // that otherwise consumed the cap forever with no exit). workspace:write —
  // this asserts a MONEY fact the operator verified out-of-band.
  app.post(`${BASE}/purchases/:purchaseId/close`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as { outcome?: unknown; reason?: unknown };
      if (body.outcome !== 'not_placed' && body.outcome !== 'confirmed_placed') {
        throw new OpenwopError('validation_error', "Field `outcome` must be 'not_placed' or 'confirmed_placed'.", 400, { field: 'outcome' });
      }
      res.json(await closeUnknownPurchase(ctx.tenantId, ctx.orgId, req.params.purchaseId, {
        outcome: body.outcome, reason: String(body.reason ?? ''), actingUserId: ctx.user.userId,
      }));
    } catch (err) { next(err); }
  });
}

/**
 * Marketplace routes (host-extension, NON-NORMATIVE — ADR 0022). Surface under
 * `/v1/host/openwop-app/marketplace`. Toggle-gated on `marketplace` (backend authority
 * — 404 when off). Three faces, each with its own authority tier:
 *
 *   GET  /listings                                  browse (toggle + authed caller)
 *   POST /install  {packName, version}              install (toggle + SUPERADMIN)
 *   GET  /orgs/:orgId/listings/:packName/reviews    reviews list (workspace:read)
 *   POST /orgs/:orgId/listings/:packName/reviews    upsert review (workspace:write)
 *   DEL  /orgs/:orgId/listings/:packName/reviews/:id delete review (author|admin)
 *
 * Boundary discipline (the ADR's headline): install DELEGATES to
 * `installPackFromRegistry` — it re-implements NONE of the Ed25519/SRI verify.
 * Listings are a PROJECTION (listingService); reviews are the only new store.
 */

import type { Request } from 'express';
import { resolve } from 'node:path';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireFeatureEnabled, requireString, optionalString } from '../featureRoute.js';
import { requireSuperadmin } from '../../host/superadmin.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { installPackFromRegistry, resolveDefaultPackDir } from '../../packs/registryInstaller.js';
import { createLogger } from '../../observability/logger.js';
import { listListings, getListing } from './listingService.js';
import { listReviews, ratingSummary, upsertReview, deleteReview } from './reviewService.js';

const log = createLogger('features.marketplace');
const FEATURE = { toggleId: 'marketplace', label: 'Marketplace' };
const BASE = '/v1/host/openwop-app/marketplace';
const ORG = `${BASE}/orgs/:orgId`;
type Scope = 'workspace:read' | 'workspace:write';

export function registerMarketplaceRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const authz = (req: Request, scope: Scope) => authorizeOrgScope(req, FEATURE, scope);

  // ── Phase 1: browse listings (toggle + authenticated caller) ──
  // Listings are a host-GLOBAL projection (installed pack set is process-global),
  // so there is no org slice; we require the toggle on AND an authenticated caller.
  app.get(`${BASE}/listings`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
      await resolveCallerUser(req); // 401/403 for an unauthenticated caller
      res.json({ listings: listListings() });
    } catch (err) { next(err); }
  });

  // ── Phase 2: install (toggle + SUPERADMIN; delegates to registryInstaller) ──
  // Install mutates PROCESS-GLOBAL pack state — a privileged, host:*-scoped action
  // (ADR §"Privileged install, fail-closed"), not a plain org member. Signed-only:
  // installPackFromRegistry verifies SHA-256 SRI + Ed25519 over the raw pack.json.
  app.post(`${BASE}/install`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
      requireSuperadmin(req, 'Marketplace install');
      const body = (req.body ?? {}) as { packName?: unknown; version?: unknown };
      const packName = requireString(body.packName, 'packName');
      const version = requireString(body.version, 'version');

      const packDir = resolveDefaultPackDir();
      const registry = process.env.OPENWOP_REGISTRY_URL;
      const trustedKeysDir = resolve('../../../registry/keys');
      const result = await installPackFromRegistry(
        { name: packName, version },
        { packDir, ...(registry ? { registry } : {}), trustedKeysDir },
      );
      log.info('marketplace_install_completed', { packName, version, installed: result.installed });
      res.status(200).json({
        packName,
        version,
        installed: result.installed,
        alreadyInstalled: !result.installed,
        ...(result.reason ? { reason: result.reason } : {}),
      });
    } catch (err) { next(err); }
  });

  // ── Phase 3: reviews / ratings (org-scoped RBAC; the only new store) ──

  // List a pack's reviews + aggregate rating (workspace:read).
  app.get(`${ORG}/listings/:packName/reviews`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:read');
      const packName = packNameParam(req);
      const [reviews, summary] = await Promise.all([
        listReviews(user.tenantId, orgId, packName),
        ratingSummary(user.tenantId, orgId, packName),
      ]);
      res.json({ reviews, summary });
    } catch (err) { next(err); }
  });

  // Upsert the caller's review (workspace:write). One review per (org, pack, author).
  app.post(`${ORG}/listings/:packName/reviews`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const packName = packNameParam(req);
      // The pack must exist in the catalog — no reviewing a phantom pack.
      if (!getListing(packName)) {
        throw new OpenwopError('not_found', 'Pack not found in the marketplace catalog.', 404, { packName });
      }
      const body = (req.body ?? {}) as { rating?: unknown; body?: unknown };
      const review = await upsertReview({
        tenantId: user.tenantId,
        orgId,
        packName,
        rating: body.rating,
        ...(optionalString(body.body) !== undefined ? { body: body.body } : {}),
        authorId: user.userId,
      });
      res.status(201).json(review);
    } catch (err) { next(err); }
  });

  // Delete a review (author or org admin; workspace:write + IDOR guard in service).
  app.delete(`${ORG}/listings/:packName/reviews/:reviewId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const access = await resolveEffectiveAccess(user.tenantId, { subject: user.userId, orgId });
      const isAdmin = access.roles.includes('admin') || access.roles.includes('owner');
      const ok = await deleteReview(user.tenantId, orgId, req.params.reviewId, { authorId: user.userId, isAdmin });
      if (!ok) throw new OpenwopError('not_found', 'Review not found.', 404, { reviewId: req.params.reviewId });
      res.status(204).end();
    } catch (err) { next(err); }
  });
}

/** The `:packName` path param — non-empty, decoded. */
function packNameParam(req: Request): string {
  const raw = req.params.packName;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new OpenwopError('validation_error', '`packName` is required.', 400, { field: 'packName' });
  }
  return raw;
}

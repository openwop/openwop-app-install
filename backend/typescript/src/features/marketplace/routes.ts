/**
 * Marketplace routes (host-extension, NON-NORMATIVE — ADR 0022). Surface under
 * `/v1/host/openwop-app/marketplace`. Toggle-gated on `marketplace` (backend authority
 * — 404 when off). Three faces, each with its own authority tier:
 *
 *   GET  /listings                                  browse (toggle + authed caller)
 *   DEL  /packs/:packName[?purge=true]              tombstone / purge (toggle + SUPERADMIN)
 *   POST /packs/:packName/restore                   restore a removed pack (toggle + SUPERADMIN)
 *   GET  /pack-enablement                           workspace's disabled packs (toggle + authed)
 *   PUT  /pack-enablement/:packName {enabled}       curate availability (toggle + authed, own workspace)
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
import { resolveListingPricing } from './listingPricingHook.js';
import { requireSuperadmin } from '../../host/superadmin.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { installPackFromRegistry, resolveDefaultPackDir, isSafePackName } from '../../packs/registryInstaller.js';
import { createLogger } from '../../observability/logger.js';
import { listListings, getListing } from './listingService.js';
import { listReviews, ratingSummary, upsertReview, deleteReview } from './reviewService.js';
// Importing the service also registers the host/packVisibility resolver (ADR 0194 P3).
import { disabledPacks, disablePack, enablePack } from './packEnablementService.js';
import { featureBundleCatalog } from './bundleCatalog.js';
import { tenantOf } from '../featureRoute.js';
import { isTombstoned, tombstonePack, restorePack } from '../../host/packTombstones.js';
import { listRegisteredWorkflows } from '../../host/workflowsRegistry.js';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { certifyConnectionPack } from './certService.js';

const log = createLogger('features.marketplace');

/**
 * Translate the registry-installer's low-level failures (raw `Error`s, by design)
 * into clear, actionable canonical errors. Without this a pack that simply isn't
 * published to the registry (a 404 manifest fetch) surfaces as a bare 500
 * "unexpected error" — the operator can't tell a missing pack from a real fault.
 */
export function translateInstallError(err: unknown, packName: string, version: string): OpenwopError {
  if (err instanceof OpenwopError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const details = { packName, version };
  if (/^manifest_fetch_failed \(404\)/.test(msg)) {
    return new OpenwopError(
      'not_found',
      `"${packName}@${version}" isn't published to the pack registry, so it can't be installed. A first-party pack vendored in the image must also be published to packs.openwop.dev before it is installable.`,
      404,
      details,
    );
  }
  if (/^(manifest|tarball|signature)_fetch_failed/.test(msg)) {
    return new OpenwopError('runner_unavailable', `The pack registry is unavailable right now — couldn't install "${packName}". Try again shortly.`, 502, details);
  }
  if (/(integrity_mismatch|signature_invalid|signature_unverifiable|unsupported_integrity)/.test(msg)) {
    return new OpenwopError('validation_error', `"${packName}" failed signature or integrity verification and was not installed.`, 422, details);
  }
  return new OpenwopError('runner_unavailable', `Couldn't install "${packName}": ${msg}`, 502, details);
}

/** Validate a `:packName` param for a filesystem-touching route (ADR 0194 review
 *  hardening): a non-empty, path-safe pack name. Defense-in-depth so the purge
 *  `rmSync` can never escape the pack dir regardless of upstream existence gates. */
function safePackName(raw: unknown): string {
  const name = requireString(raw, 'packName');
  if (!isSafePackName(name)) {
    throw new OpenwopError('invalid_pack_name', 'Pack name is malformed.', 400, { packName: name });
  }
  return name;
}

/**
 * WF-MKT-1 — the node typeIds a pack's on-disk manifest declares, or an explicit
 * REFUSAL when the manifest cannot be read.
 *
 * This used to return an empty `Set` for BOTH "the manifest declares no nodes"
 * and "the manifest is absent or unparseable" — a bare `catch { return new Set(); }`
 * with no log and no distinction. The purge gate below is
 * `if (typeIds.size > 0) { …block on referencing definitions… }`, so an empty set
 * SKIPS the reference check entirely and the irreversible
 * `rmSync(packDir, { recursive: true, force: true })` proceeds — deleting a pack
 * that registered (including archived and transient) workflow definitions still
 * resolve through on replay. A reference gate that fails OPEN on a read error is
 * not a gate.
 *
 * The triggering state is MEASURED, not hypothetical: `bootstrap/mountLocalPacks.ts`
 * records a pack directory holding ONLY `.openwop-installed.json` — no `pack.json`,
 * no `index.mjs`. The `core.openwop.*` refusal higher up would have blocked that
 * particular pack; every `vendor.*` / `feature.*` / `community.*` pack in the same
 * rubble state was purgeable with the gate inert.
 *
 * So absence is NOT treated as "declares no nodes". A pack directory that exists
 * without a readable `pack.json` is rubble, and what it once declared is exactly
 * what we cannot know — which is the case the gate exists for.
 */
type PackManifestRead =
  | { readable: true; typeIds: Set<string> }
  | { readable: false; reason: string };

function packTypeIds(packDir: string): PackManifestRead {
  const manifestPath = join(packDir, 'pack.json');
  if (!existsSync(manifestPath)) return { readable: false, reason: 'the pack manifest (pack.json) is missing' };
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { nodes?: { typeId?: unknown }[] };
    return { readable: true, typeIds: new Set((manifest.nodes ?? []).map((n) => n.typeId).filter((t): t is string => typeof t === 'string')) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error('marketplace_pack_manifest_unreadable', { packDir, error: detail });
    return { readable: false, reason: `the pack manifest (pack.json) could not be read: ${detail}` };
  }
}
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
  // ADR 0385 P4 — paid-lane pricing is an OPTIONAL per-viewer annotation via the
  // registered provider (commerce-connect); enrichment, never a gate.
  app.get(`${BASE}/listings`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
      await resolveCallerUser(req); // 401/403 for an unauthenticated caller
      const listings = listListings();
      const { pricing, degraded } = await resolveListingPricing(listings.map((l) => l.packName), tenantOf(req));
      res.json({
        listings: listings.map((l) => (pricing[l.packName] ? { ...l, pricing: pricing[l.packName] } : l)),
        // MKT2-M1 — additive: a failed pricing enrichment is DISCLOSED, so the
        // client can say "pricing unavailable" instead of rendering paid as free.
        ...(degraded ? { pricingDegraded: true } : {}),
      });
    } catch (err) { next(err); }
  });

  // ── ADR 0366 P3: the feature-bundle catalog (READ-ONLY) ──
  // Backs the bundle shop. Same gate posture as /listings (toggle + authed
  // caller); the projection is host-global (compiled registry + the vendored
  // bundles.json), never tenant data. There is deliberately NO write twin:
  // a distribution manifest becomes real only via a repo PR + the gated build.
  app.get(`${BASE}/feature-bundles`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
      await resolveCallerUser(req);
      res.json(featureBundleCatalog());
    } catch (err) { next(err); }
  });

  // ── CDP-H (ADR 0270): connector-pack certification lint ──
  // Read-only pre-publish check on a candidate RFC 0095 connection-pack manifest.
  app.post(`${BASE}/certify`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
      await resolveCallerUser(req);
      const manifest = ((req.body ?? {}) as { manifest?: unknown }).manifest;
      res.json(certifyConnectionPack(manifest));
    } catch (err) { next(err); }
  });

  // ── ADR 0194 Phase 3: per-tenant pack enablement (availability curation) ──
  // Workspace-scoped self-service, the BYOK-keys trust class: any authenticated
  // member curates their OWN workspace's authoring availability. Tenant id comes
  // ONLY from the request (never the body) — IDOR-clean by construction. Toggles
  // + RBAC stay the behavior authority; this hides packs from AUTHORING surfaces
  // (palette, new registration, AI author) — runs/replay never consult it.
  app.get(`${BASE}/pack-enablement`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
      await resolveCallerUser(req);
      const disabled = await disabledPacks(tenantOf(req));
      res.json({ disabled: [...disabled].sort() });
    } catch (err) { next(err); }
  });

  app.put(`${BASE}/pack-enablement/:packName`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
      const user = await resolveCallerUser(req);
      const packName = safePackName(req.params.packName);
      if (!getListing(packName)) {
        throw new OpenwopError('not_found', 'No such pack.', 404, { packName });
      }
      const body = (req.body ?? {}) as { enabled?: unknown };
      if (typeof body.enabled !== 'boolean') {
        throw new OpenwopError('validation_error', 'Field `enabled` MUST be a boolean.', 400, { field: 'enabled' });
      }
      const tenantId = tenantOf(req);
      if (body.enabled) await enablePack(tenantId, packName);
      else await disablePack(tenantId, packName, user.userId);
      log.info('marketplace_pack_enablement_set', { packName, enabled: body.enabled });
      res.json({ packName, enabled: body.enabled });
    } catch (err) { next(err); }
  });

  // ── ADR 0194 Phase 4: two-tier uninstall (toggle + SUPERADMIN) ──
  // TOMBSTONE (default): the pack's bytes STAY (replay invariant); hidden from
  // authoring/browse host-wide via the durable pack-tombstone row. Reversible.
  // PURGE (?purge=true, only while tombstoned): deletes the pack dir to reclaim
  // footprint, refused while any registered workflow definition references the
  // pack's node typeIds. Protected classes refuse removal outright: feature-
  // pinned packs (requiredBy — features manage packs via toggles, never
  // removal) and core.openwop.* (host substrate; dev-mount would re-link it).
  app.delete(`${BASE}/packs/:packName`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
      requireSuperadmin(req, 'Marketplace uninstall');
      const packName = safePackName(req.params.packName);
      const purge = req.query.purge === 'true';

      if (packName.startsWith('core.openwop.')) {
        throw new OpenwopError('conflict', 'core.openwop.* packs are host substrate and cannot be removed.', 409, { packName });
      }
      const listing = getListing(packName);
      if (!purge && !listing && !isTombstoned(packName)) {
        throw new OpenwopError('not_found', 'No such pack.', 404, { packName });
      }
      if (listing?.requiredBy && listing.requiredBy.length > 0) {
        throw new OpenwopError(
          'conflict',
          `Pack is pinned by feature(s): ${listing.requiredBy.join(', ')}. Features manage their packs via toggles — it cannot be removed.`,
          409,
          { packName, requiredBy: listing.requiredBy },
        );
      }

      if (!purge) {
        await tombstonePack(packName, req.tenantId ?? 'superadmin');
        log.info('marketplace_pack_tombstoned', { packName });
        res.json({ packName, tombstoned: true, purged: false });
        return;
      }

      // PURGE — only from the tombstoned state (the observation window).
      if (!isTombstoned(packName)) {
        throw new OpenwopError('conflict', 'Purge requires the pack to be removed (tombstoned) first.', 409, { packName });
      }
      const packDir = join(resolveDefaultPackDir(), packName);
      // Nothing on disk — the purge is a no-op and idempotent. There is no
      // reference question to answer because there are no bytes to delete.
      if (existsSync(packDir)) {
        // Reference gate: any REGISTERED workflow definition using this pack's
        // node typeIds blocks the purge (replay resolves through definitions;
        // tombstoned bytes must stay while they reference it).
        const manifest = packTypeIds(packDir);
        if (!manifest.readable) {
          // WF-MKT-1 — FAIL CLOSED. We cannot enumerate what this pack declares,
          // so we cannot establish that nothing references it, so we must not
          // delete it. Refusing costs an operator one manual step; proceeding
          // costs replay of every definition citing its typeIds, permanently.
          throw new OpenwopError(
            'conflict',
            `Cannot purge — ${manifest.reason}, so the workflow-reference check cannot run. Purging would risk deleting a pack that registered workflow definitions still resolve through on replay. Restore or repair the pack directory, or remove it out of band.`,
            409,
            { packName, reason: 'manifest_unreadable' },
          );
        }
        if (manifest.typeIds.size > 0) {
          // ADR 0369: an INTEGRITY check, not a catalog display — archived and
          // transient definitions still replay, so they still pin the pack.
          const referencing = listRegisteredWorkflows({ includeArchived: true, includeTransient: true })
            .filter((d) => d.nodes.some((n) => manifest.typeIds.has(n.typeId)))
            .map((d) => d.workflowId)
            .sort();
          if (referencing.length > 0) {
            throw new OpenwopError(
              'conflict',
              `Cannot purge — registered workflow definition(s) still reference this pack: ${referencing.join(', ')}.`,
              409,
              { packName, workflowIds: referencing },
            );
          }
        }
        rmSync(packDir, { recursive: true, force: true });
      }
      // The tombstone row is KEPT so boot loaders never resurrect the pack.
      log.info('marketplace_pack_purged', { packName });
      res.json({ packName, tombstoned: true, purged: true });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/packs/:packName/restore`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
      requireSuperadmin(req, 'Marketplace restore');
      const packName = safePackName(req.params.packName);
      const existed = await restorePack(packName);
      if (!existed) {
        throw new OpenwopError('not_found', 'Pack is not removed.', 404, { packName });
      }
      log.info('marketplace_pack_restored', { packName });
      res.json({ packName, restored: true });
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
      // ADR 0194 P4: a removed (tombstoned) pack must be restored explicitly
      // before it can be installed again — install never silently un-removes.
      {
        const name = (req.body as { packName?: unknown } | undefined)?.packName;
        if (typeof name === 'string' && isTombstoned(name)) {
          throw new OpenwopError('conflict', 'Pack is removed from this host. Restore it first.', 409, { packName: name });
        }
      }
      const body = (req.body ?? {}) as { packName?: unknown; version?: unknown };
      const packName = safePackName(body.packName); // install writes join(packDir, name) — keep it path-safe
      const version = requireString(body.version, 'version');

      const packDir = resolveDefaultPackDir();
      const registry = process.env.OPENWOP_REGISTRY_URL;
      const trustedKeysDir = resolve('../../../registry/keys');
      let result;
      try {
        result = await installPackFromRegistry(
          { name: packName, version },
          { packDir, ...(registry ? { registry } : {}), trustedKeysDir },
        );
      } catch (installErr) {
        const mapped = translateInstallError(installErr, packName, version);
        log.warn('marketplace_install_failed', { packName, version, code: mapped.code, reason: installErr instanceof Error ? installErr.message : String(installErr) });
        throw mapped;
      }
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
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const packName = packNameParam(req);
      const [reviews, summary] = await Promise.all([
        listReviews(tenantId, orgId, packName),
        ratingSummary(tenantId, orgId, packName),
      ]);
      res.json({ reviews, summary });
    } catch (err) { next(err); }
  });

  // Upsert the caller's review (workspace:write). One review per (org, pack, author).
  app.post(`${ORG}/listings/:packName/reviews`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const packName = packNameParam(req);
      // The pack must exist in the catalog — no reviewing a phantom pack.
      if (!getListing(packName)) {
        throw new OpenwopError('not_found', 'Pack not found in the marketplace catalog.', 404, { packName });
      }
      const body = (req.body ?? {}) as { rating?: unknown; body?: unknown };
      const review = await upsertReview({
        tenantId,
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
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const access = await resolveEffectiveAccess(tenantId, { subject: user.userId, orgId });
      const isAdmin = access.roles.includes('admin') || access.roles.includes('owner');
      const ok = await deleteReview(tenantId, orgId, req.params.reviewId, { authorId: user.userId, isAdmin });
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

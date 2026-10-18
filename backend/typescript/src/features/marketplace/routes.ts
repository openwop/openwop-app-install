/**
 * Marketplace routes (host-extension, NON-NORMATIVE — ADR 0022). Surface under
 * `/v1/host/openwop-app/marketplace`. Toggle-gated on `marketplace` (backend authority
 * — 404 when off). Three faces, each with its own authority tier:
 *
 *   GET  /listings                                  browse (toggle + authed caller)
 *   GET  /feature-bundles                           bundle catalog + this workspace's activation (toggle + authed)
 *   POST /feature-bundles/:bundleId/enable|disable  turn a bundle on/off here (toggle + workspace admin, ADR 0892)
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
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireFeatureEnabled, requireString, optionalString, requireTenantWrite, callerHoldsTenantScope } from '../featureRoute.js';
import { resolveListingPricing } from './listingPricingHook.js';
import { requireSuperadmin, isSuperadmin } from '../../host/superadmin.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { resolveDefaultPackDir, isSafePackName } from '../../packs/registryInstaller.js';
import { assertInstallable, installFromConfiguredRegistry, translateInstallError, PACK_SEMVER_RE } from '../../packs/installLane.js';
import { listPackRevocations, revokePack, unrevokePack, REVOKE_ALL_VERSIONS } from '../../host/packRevocations.js';
import { BACKEND_FEATURES } from '../index.js';
import { callerSubject } from '../../host/requestSubject.js';
import { createLogger } from '../../observability/logger.js';
import { listListings, getListing } from './listingService.js';
import { listReviews, ratingSummary, upsertReview, deleteReview } from './reviewService.js';
// Importing the service also registers the host/packVisibility resolver (ADR 0194 P3).
import { disabledPacks, disablePack, enablePack } from './packEnablementService.js';
import { featureBundleCatalog } from './bundleCatalog.js';
import {
  bundleActivationState, disableBundleForTenant, enableBundleForTenant, isKnownBundle,
  type BundleActivationState, type BundleRefusal,
} from '../../host/featureBundleActivation.js';
import { isAnonTenantId } from '../../host/requestSubject.js';
import { isAnonymous, resolveCallerUser } from '../users/usersGuards.js';
import { tenantOf } from '../featureRoute.js';
import { isTombstoned, tombstonePack, restorePack } from '../../host/packTombstones.js';
import { listRegisteredWorkflows } from '../../host/workflowsRegistry.js';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { certifyConnectionPack } from './certService.js';

const log = createLogger('features.marketplace');

/** ADR 0826 D4 — moved to the ONE install lane (`packs/installLane.ts`); re-exported
 *  so its existing callers and test keep their import. */
export { translateInstallError };

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

/** Feature ids whose `requiredPacks` pin `packName` at ANY version — what a
 *  revocation of it takes down (ADR 0826 /architect A6). */
function featuresRequiring(packName: string): string[] {
  return BACKEND_FEATURES.filter((f) => (f.requiredPacks ?? []).some((r) => r.name === packName)).map((f) => f.id).sort();
}
const BASE = '/host/openwop-app/marketplace';
const ORG = `${BASE}/orgs/:orgId`;
type Scope = 'workspace:read' | 'workspace:write';

/**
 * ADR 0826 D1 — what THIS caller may do, computed by the same predicates the
 * write routes enforce (`requireTenantWrite` / `requireSuperadmin`), so the UI
 * never offers a control the server refuses.
 */
async function viewerCapabilities(req: Request): Promise<{ canCurate: boolean; canAdminister: boolean }> {
  return {
    canCurate: await callerHoldsTenantScope(req, tenantOf(req), 'workspace:write'),
    canAdminister: isSuperadmin(req),
  };
}

/**
 * ADR 0892 Phase B D1 — may this caller turn bundles on/off for the ACTIVE
 * workspace? An owner/admin there (`host:members:manage`; a personal workspace's
 * owner holds it), or the host operator. Never an anonymous session or an `anon:`
 * sandbox (folded away on sign-in, so never a durable workspace).
 */
async function canManageBundles(req: Request): Promise<boolean> {
  const tenantId = tenantOf(req);
  if (isAnonymous(req) || isAnonTenantId(tenantId)) return false;
  return isSuperadmin(req) || callerHoldsTenantScope(req, tenantId, 'host:members:manage');
}

/** The gate both bundle write routes share: toggle, signed in, authority, known bundle. */
async function authorizeBundleWrite(req: Request): Promise<{ tenantId: string; actor: string; bundleId: string }> {
  await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
  const user = await resolveCallerUser(req);
  if (!(await canManageBundles(req))) {
    throw new OpenwopError('forbidden_scope', 'Only a workspace owner or admin can turn feature bundles on or off.', 403, { requiredScope: 'host:members:manage' });
  }
  const bundleId = requireString(req.params.bundleId, 'bundleId');
  if (!isKnownBundle(bundleId)) throw new OpenwopError('not_found', 'No such feature bundle.', 404, { bundleId });
  return { tenantId: tenantOf(req), actor: user.userId, bundleId };
}

/** The helper's typed refusal → the route's envelope (D2/D3/D5). */
function refusalError(bundleId: string, refused: BundleRefusal): OpenwopError {
  switch (refused.reason) {
    case 'unknown_bundle':
      return new OpenwopError('not_found', 'No such feature bundle.', 404, { bundleId });
    case 'bundle_not_entitled':
      return new OpenwopError('bundle_not_entitled', 'Your plan does not include this bundle yet.', 402, {
        reason: 'bundle_not_entitled', bundleId, missing: refused.missing, bundles: refused.bundles,
      });
    case 'feature_killed':
      return new OpenwopError('feature_killed', 'Part of this bundle is switched off on this host.', 409, { reason: 'feature_killed', bundleId, ids: refused.ids });
    case 'disable_blocked':
      return new OpenwopError('disable_blocked', 'Other features in this workspace still need this bundle.', 409, {
        reason: 'disable_blocked', bundleId, dependents: refused.dependents,
      });
  }
}

export function registerMarketplaceRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const authz = (req: Request, scope: Scope) => authorizeOrgScope(req, FEATURE, scope);
  /** ADR 0826 D5 — revocations land in the durable audit log. Best-effort: the
   *  revocation has already taken effect, so an audit-store failure is logged,
   *  never turned into a 500 that reads as "not revoked". */
  const auditRevocation = (action: string, by: string, packName: string, version: string, payload: Record<string, unknown>): Promise<void> =>
    deps.storage.appendAudit({ timestamp: new Date().toISOString(), principalId: by, action, resource: `pack:${packName}@${version}`, outcome: 'success', payload })
      .catch((err: unknown) => log.error('marketplace_revocation_audit_failed', { packName, version, error: err instanceof Error ? err.message : String(err) }));

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
        viewer: await viewerCapabilities(req),
      });
    } catch (err) { next(err); }
  });

  // ── ADR 0366 P3: the feature-bundle catalog (READ-ONLY) ──
  // Backs the bundle shop. Same gate posture as /listings (toggle + authed
  // caller); the projection is host-global (compiled registry + the vendored
  // bundles.json), never tenant data. There is deliberately NO write twin:
  // a distribution manifest becomes real only via a repo PR + the gated build.
  //
  // ADR 0892 Phase B — the catalog stays host-global; the response ADDS this
  // workspace's per-bundle `activation` (enabled / available / locked) and whether
  // the caller may change it. A fault reading the state is disclosed
  // (`activationDegraded`), never rendered as "available".
  app.get(`${BASE}/feature-bundles`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
      await resolveCallerUser(req);
      const catalog = featureBundleCatalog();
      const tenantId = tenantOf(req);
      let activation: Record<string, BundleActivationState> | undefined;
      try {
        const states = await Promise.all(catalog.bundles.map(async (b) => [b.id, await bundleActivationState(b.id, tenantId)] as const));
        activation = Object.fromEntries(states);
      } catch (err) {
        log.warn('marketplace_bundle_activation_unresolved', { error: err instanceof Error ? err.message : String(err) });
      }
      res.json({
        ...catalog,
        ...(activation ? { activation } : { activationDegraded: true }),
        viewer: { canManageBundles: await canManageBundles(req) },
      });
    } catch (err) { next(err); }
  });

  // ── ADR 0892 Phase B: turn a bundle on / off for THIS workspace ──
  // A workspace owner/admin (`host:members:manage`, which a personal workspace's
  // owner holds) in the ACTIVE tenant only; the tenant never comes from the body.
  // Enable is refused unless the plan covers the whole closure (402) and nothing in
  // it is killed (409); disable is refused while a feature outside the bundle still
  // needs it (409). The helper decides; this maps its typed refusal to an envelope.
  app.post(`${BASE}/feature-bundles/:bundleId/enable`, async (req, res, next) => {
    try {
      const { tenantId, actor, bundleId } = await authorizeBundleWrite(req);
      const r = await enableBundleForTenant(bundleId, tenantId, actor);
      if (r.refused) throw refusalError(bundleId, r.refused);
      log.info('marketplace_bundle_enabled', { bundleId, enabled: r.enabled.length, alreadyOn: r.alreadyOn.length });
      res.json({ bundleId, status: 'enabled', enabled: r.enabled, alreadyOn: r.alreadyOn, skipped: r.skipped });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/feature-bundles/:bundleId/disable`, async (req, res, next) => {
    try {
      const { tenantId, actor, bundleId } = await authorizeBundleWrite(req);
      const r = await disableBundleForTenant(bundleId, tenantId, actor);
      if (r.refused) throw refusalError(bundleId, r.refused);
      log.info('marketplace_bundle_disabled', { bundleId, disabled: r.disabled.length, alreadyOff: r.alreadyOff.length });
      res.json({ bundleId, status: 'available', disabled: r.disabled, alreadyOff: r.alreadyOff, skipped: r.skipped });
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
  // Workspace-scoped curation: reading is any member; WRITING is `workspace:write`
  // in the active tenant (ADR 0826 D1 — a Viewer in a shared `ws:` workspace used
  // to get 200 and disable a pack for everyone). Tenant id comes
  // ONLY from the request (never the body) — IDOR-clean by construction. Toggles
  // + RBAC stay the behavior authority; this hides packs from AUTHORING surfaces
  // (palette, new registration, AI author) — runs/replay never consult it.
  app.get(`${BASE}/pack-enablement`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
      await resolveCallerUser(req);
      const disabled = await disabledPacks(tenantOf(req));
      res.json({ disabled: [...disabled].sort(), viewer: await viewerCapabilities(req) });
    } catch (err) { next(err); }
  });

  app.put(`${BASE}/pack-enablement/:packName`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
      const user = await resolveCallerUser(req);
      await requireTenantWrite(req);
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

  // ── ADR 0826 D5: pack REVOCATION — the kill switch (SUPERADMIN, NOT toggle-gated) ──
  // ADR 0555 built the store and its enforcement; nothing could WRITE to it. A
  // revocation stops a version executing on every instance within one refresh
  // tick (`startPackRevocationRefresh`), refuses its (re)install, and breaks
  // replay of runs that used it — deliberately (ADR 0555). Deliberately NOT
  // behind the `marketplace` toggle: the ADR 0575 operator-remediation class — a
  // kill switch must not vanish because a feature (or an incident) turned it off.
  // Distinct from tombstone (removal from authoring; still runs).
  app.get(`${BASE}/revocations`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Pack revocations');
      const rows = await listPackRevocations();
      res.json({ revocations: rows.sort((a, b) => b.revokedAt.localeCompare(a.revokedAt)) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/packs/:packName/revocations`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Pack revocation');
      const packName = safePackName(req.params.packName);
      const body = (req.body ?? {}) as { version?: unknown; reason?: unknown };
      const version = typeof body.version === 'string' ? body.version : '';
      if (version !== REVOKE_ALL_VERSIONS && !PACK_SEMVER_RE.test(version)) {
        throw new OpenwopError('validation_error', '`version` must be a SemVer string, or "*" for every version.', 400, { field: 'version' });
      }
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason.length === 0 || reason.length > 500) {
        throw new OpenwopError('validation_error', 'A reason (1–500 characters) is required — it is what the next operator reads.', 400, { field: 'reason' });
      }
      const by = callerSubject(req) ?? 'superadmin';
      const row = await revokePack({ packName, version, by, reason });
      // /architect A6 — the blast radius, stated: the features that pin this pack
      // stop working. Not refused (a compromised core pack must be killable).
      const requiredBy = featuresRequiring(packName);
      log.warn('marketplace_pack_revoked', { packName, version, by, reason, requiredBy });
      // A security action outlives its log line: the durable audit log (ADR 0028).
      await auditRevocation('marketplace.pack.revoked', by, packName, version, { reason, requiredBy });
      res.status(201).json({ revocation: row, requiredBy });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/packs/:packName/revocations/:version`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Pack revocation');
      const packName = safePackName(req.params.packName);
      const version = String(req.params.version);
      if (version !== REVOKE_ALL_VERSIONS && !PACK_SEMVER_RE.test(version)) {
        throw new OpenwopError('validation_error', '`version` must be a SemVer string, or "*".', 400, { field: 'version' });
      }
      const existed = await unrevokePack(packName, version);
      if (!existed) throw new OpenwopError('not_found', 'No such revocation.', 404, { packName, version });
      const by = callerSubject(req) ?? 'superadmin';
      log.warn('marketplace_pack_unrevoked', { packName, version, by });
      await auditRevocation('marketplace.pack.unrevoked', by, packName, version, {});
      res.status(204).end();
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
      // ADR 0826 D4 — the ONE install lane: path-safe name, SemVer version,
      // tombstone (restore first — install never silently un-removes, ADR 0194 P4),
      // revoked version; then the configured registry with every failure mapped.
      const body = (req.body ?? {}) as { packName?: unknown; version?: unknown };
      const { name: packName, version } = assertInstallable({ name: body.packName, version: body.version });
      let result;
      try {
        result = await installFromConfiguredRegistry({ name: packName, version });
      } catch (mapped) {
        log.warn('marketplace_install_failed', { packName, version, code: mapped instanceof OpenwopError ? mapped.code : 'unknown' });
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

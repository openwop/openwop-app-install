/**
 * Media workflow surface (ADR 0014 / ADR 0229) — `ctx.features.media`, the narrow
 * write surface a workflow node uses to register a HOST-STORED byte asset (an
 * RFC 0055 capability-token serve URL, e.g. an image `ctx.callImageGenerator`
 * already persisted) as a durable Media-Library asset WITH lineage.
 *
 * Deliberately NOT a create-from-base64 method: on this host, generated image
 * bytes never cross the node result boundary (ADR 0115 — the seam stores them
 * host-side and returns a serve URL), so the surface resolves the caller's serve
 * token instead of re-accepting raw bytes. Tenant comes from the run scope
 * (never args) — the token must belong to THIS tenant (the RFC 0055
 * `media-asset-url-tenant-scoped` invariant); org is node-supplied and the
 * service enforces the tenant+org key like every other write surface. Bytes are
 * re-stored on the DURABLE library path (the seam's scratch copy carries a
 * short TTL), capacity-gated exactly like an upload.
 *
 * Media is ALWAYS-ON (ADR 0027) — no toggle default, so the surface seam leaves
 * it ungated (the `gate()` always-on exception).
 */

import { createHash } from 'node:crypto';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { resolveMediaAsset } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { OpenwopError } from '../../types.js';
import { assertRunScopeOrg, type Scope } from '../../host/accessControlService.js';
import { allowedUploadMimeList, storableContentType } from '../../host/allowedUploadMime.js';
import * as mediaStorage from './mediaStorage.js';
import { withOrgCapacity, createAsset, findAssetByContentHash, selectAssets, viewAsset, parseServeToken, groundingForGenerated, stampGroundingIfAbsent, cleanLineage, type MediaAssetView } from './mediaService.js';

export function buildMediaSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;

  /** ADR 0818 §4 — a run acting FOR a person gets that person's authority in
   *  the org: the routes' own predicate (`assertOrgScope`, CMNT-4), so a
   *  viewer's run cannot write where the viewer cannot, and an org that does
   *  not exist in this tenant is a 404 (a made-up id included).
   *
   *  Two lanes stay as they were on main:
   *  - the WORKSPACE-ROOT id (`orgId === tenantId`) in a single-principal tenant
   *    (`user:`/`anon:`/`default`). KickTodo lesson media and run artifacts
   *    write there, and it need not be an org row; with one principal there is
   *    nobody to escalate over;
   *  - a run with no acting user (a schedule, a trigger) stays tenant-trusted,
   *    as every surface without an actor is.
   *  In a personal tenant a real org passes as its owner's (the routes' own
   *  personal-owner short-circuit, after the existence check).
   *  ADR 0830 D1 — the predicate now lives in `assertRunOrgScope`, shared with KB. */
  const requireScope = (orgId: string, needed: Scope): Promise<void> => assertRunScopeOrg(scope, orgId, needed);

  return {
    // Register a host-stored byte asset (serve URL/token) as a durable library
    // asset. Args: { orgId, url, name?, tags?, collectionId?, lineage? }.
    // Idempotency note: callers pass a deterministic name; the write itself is
    // recorded via the action-role node's event log (the ADR 0014 replay model).
    // ADR 0352 P4 — deterministic weighted selection over the org's image
    // library (facet=full weight, tag=half; 5-level fallback; `needsAsset`
    // when nothing matches). Pure ranking ⇒ replay-safe from a node.
    select: async (args) => {
      const orgId = str(args.orgId);
      if (!orgId) throw new OpenwopError('validation_error', 'Field `orgId` is required.', 400, { field: 'orgId' });
      await requireScope(orgId, 'workspace:read');
      const r = await selectAssets(tenantId, orgId, {
        ...(str(args.product) ? { product: str(args.product) } : {}),
        ...(str(args.industry) ? { industry: str(args.industry) } : {}),
        ...(str(args.useCase) ? { useCase: str(args.useCase) } : {}),
        ...(Array.isArray(args.personaIds) ? { personaIds: (args.personaIds as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
        ...(str(args.collectionId) ? { collectionId: str(args.collectionId) } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      });
      // UX_UPGRADE-media R2 (MED2-B2) — PROJECT, do not spread the row.
      //
      // This is a `role:'action'` node, so its outputs are RECORDED in the run
      // event log — and run reads gate only on `run.tenantId === req.tenantId`
      // (`host/runAccess.ts`), with no org scoping and no output redaction
      // anywhere. `MediaAssetView` spreads the whole row, including
      // `serveToken`: a bearer credential to the BYTES, redeemable on a route
      // that is globally auth-exempt, with a ~100-year TTL and no revocation
      // short of deleting the asset.
      //
      // So a member of org B — who gets a 403 on org A's media routes — could
      // read org A's tokens out of the run events and fetch the images. Media's
      // own agent tool already refuses exactly this ("`storageRef` and
      // `serveToken` are internal storage credentials — they NEVER appear in
      // tool output"); `select` is the one verb that discovers assets the
      // caller has never seen and hands out credentials to them, which is why
      // the platform-wide "a run is tenant-trusted" deferral does not cover it:
      // that deferral is about METADATA, and this is a key.
      const project = (sel: { asset: MediaAssetView; score: number; matched: string[] }): Record<string, unknown> => ({
        assetId: sel.asset.assetId,
        name: sel.asset.name,
        contentType: sel.asset.contentType,
        sizeBytes: sel.asset.sizeBytes,
        ...(sel.asset.altText !== undefined ? { altText: sel.asset.altText } : {}),
        score: sel.score,
        matched: sel.matched,
      });
      return {
        assets: r.assets.map(project),
        fallbackLevel: r.fallbackLevel,
        ...(r.needsAsset ? { needsAsset: r.needsAsset } : {}),
      };
    },
    createAssetFromServeUrl: async (args) => {
      const orgId = str(args.orgId);
      if (!orgId) throw new OpenwopError('validation_error', 'Field `orgId` is required.', 400, { field: 'orgId' });
      await requireScope(orgId, 'workspace:write');
      const token = parseServeToken(str(args.url));
      if (!token) throw new OpenwopError('validation_error', 'Field `url` must be a host asset serve URL or token.', 400, { field: 'url' });
      const entry = await resolveMediaAsset(token);
      // Tenant check — a foreign/unknown/expired token reads as not-found.
      if (!entry || entry.tenantId !== tenantId) {
        throw new OpenwopError('not_found', 'Asset bytes not found for this tenant.', 404, {});
      }
      // ADR 0818 §2 — store what the bytes ARE (a provider's mislabelled image
      // is relabelled); refuse bytes that are not the allowlisted type claimed.
      const contentType = storableContentType(entry.contentType, Buffer.from(entry.contentBase64, 'base64'));
      if (!contentType) {
        // Same stored-XSS guard as the upload route (text/html, svg excluded).
        throw new OpenwopError('validation_error', `The asset's bytes are not a valid ${entry.contentType} (allowed types: ${allowedUploadMimeList()}).`, 415, { contentType: entry.contentType });
      }
      const project = (view: MediaAssetView, deduplicated: boolean): Record<string, unknown> => ({
        assetId: view.assetId,
        name: view.name,
        contentType: view.contentType,
        sizeBytes: view.sizeBytes,
        // MED2-R2 — NO `serveToken`, and no `serveUrl` (which is just the token
        // in a path: `/v1/host/openwop-app/assets/<serveToken>`). This verb is
        // `role:'action'` like `select`, so its output is RECORDED in the run
        // event log, and run reads gate only on tenant — so emitting the token
        // here leaked a bearer credential to the bytes to every viewer in the
        // tenant, including members of orgs whose media routes 403 them.
        //
        // The first cut of MED2-B2 hardened `select`, which has ZERO chain
        // consumers, and cited THIS allowlist as the safe precedent while it
        // carried the credential — and four shipped node packs call this verb.
        // The realized value of that fix was nil and the busier door stayed
        // open. `assetId` is what the consumers actually read.
        //
        // If a caller genuinely needs a renderable handle, resolve it at render
        // time from `assetId` through the authorized read — do not put a key in
        // a log.
        ...(view.lineage ? { lineage: view.lineage } : {}),
        ...(deduplicated ? { deduplicated: true } : {}),
      });
      // MEDIA-CODE-3 — hash + dedup exactly like the upload route: identical
      // bytes in the same collection context return the EXISTING asset instead
      // of a hash-less duplicate row.
      const contentHash = createHash('sha256').update(Buffer.from(entry.contentBase64, 'base64')).digest('hex');
      // ADR 0945 D4 — provenance from the HOST's record of who minted these
      // bytes (never from a `lineage.grounding` the node passed: cleanLineage
      // drops it). A dedup hit still gets its FIRST grounding write.
      const grounding = await groundingForGenerated(tenantId, orgId, entry.aiOrigin, { claimedLineage: args.lineage, ...(scope.runId ? { runId: scope.runId } : {}), ...(optStr(args.productId) ? { productHint: optStr(args.productId) } : {}) });
      const existing = await findAssetByContentHash(tenantId, orgId, contentHash, optStr(args.collectionId));
      if (existing) return project(viewAsset(grounding ? await stampGroundingIfAbsent(existing, grounding) : existing), true);
      // Re-store on the durable library path (the source token may be a
      // short-TTL scratch asset); the library owns its own storageRef.
      const asset = await withOrgCapacity(tenantId, orgId, entry.bytes, async () => {
        const stored = await mediaStorage.put(tenantId, { contentBase64: entry.contentBase64, contentType });
        return createAsset({
          tenantId,
          orgId,
          ...(optStr(args.collectionId) ? { collectionId: optStr(args.collectionId) } : {}),
          name: str(args.name) || 'generated asset',
          contentType,
          sizeBytes: stored.sizeBytes,
          storageRef: stored.storageRef,
          serveToken: stored.serveToken,
          tags: args.tags,
          uploadedBy: scope.actingUserId ?? scope.runId ?? 'workflow',
          ...(entry.aiOrigin ? { lineage: { ...cleanLineage(args.lineage), generatedBy: 'ai' } } : args.lineage !== undefined ? { lineage: args.lineage } : {}),
          ...(grounding ? { grounding } : {}),
          contentHash,
        });
      });
      return project(viewAsset(asset), false);
    },
  };
}

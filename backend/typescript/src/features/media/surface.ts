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
import { isAllowedUploadMime, allowedUploadMimeList } from '../../host/allowedUploadMime.js';
import * as mediaStorage from './mediaStorage.js';
import { assertOrgCapacity, createAsset, findAssetByContentHash, selectAssets, viewAsset, type MediaAssetView } from './mediaService.js';

/** Extract the capability token from a host serve URL, or accept a bare token. */
function parseServeToken(raw: string): string | null {
  const m = raw.match(/\/assets\/([A-Za-z0-9_-]{1,512})\/?$/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{1,512}$/.test(raw) ? raw : null;
}

export function buildMediaSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;

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
      const token = parseServeToken(str(args.url));
      if (!token) throw new OpenwopError('validation_error', 'Field `url` must be a host asset serve URL or token.', 400, { field: 'url' });
      const entry = await resolveMediaAsset(token);
      // Tenant check — a foreign/unknown/expired token reads as not-found.
      if (!entry || entry.tenantId !== tenantId) {
        throw new OpenwopError('not_found', 'Asset bytes not found for this tenant.', 404, {});
      }
      if (!isAllowedUploadMime(entry.contentType)) {
        // Same stored-XSS guard as the upload route (text/html, svg excluded).
        throw new OpenwopError('validation_error', `contentType must be one of: ${allowedUploadMimeList()}`, 415, { contentType: entry.contentType });
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
      const existing = await findAssetByContentHash(tenantId, orgId, contentHash, optStr(args.collectionId));
      if (existing) return project(viewAsset(existing), true);
      await assertOrgCapacity(tenantId, orgId, entry.bytes);
      // Re-store on the durable library path (the source token may be a
      // short-TTL scratch asset); the library owns its own storageRef.
      const stored = await mediaStorage.put(tenantId, { contentBase64: entry.contentBase64, contentType: entry.contentType });
      const asset = await createAsset({
        tenantId,
        orgId,
        ...(optStr(args.collectionId) ? { collectionId: optStr(args.collectionId) } : {}),
        name: str(args.name) || 'generated asset',
        contentType: entry.contentType,
        sizeBytes: stored.sizeBytes,
        storageRef: stored.storageRef,
        serveToken: stored.serveToken,
        tags: args.tags,
        uploadedBy: scope.actingUserId ?? scope.runId ?? 'workflow',
        ...(args.lineage !== undefined ? { lineage: args.lineage } : {}),
        contentHash,
      });
      return project(viewAsset(asset), false);
    },
  };
}

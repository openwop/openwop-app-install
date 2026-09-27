/**
 * Media library feature routes (host-extension, best-effort — ADR 0007).
 *
 * Surface under /v1/host/openwop-app/media/orgs/:orgId:
 *   POST   /collections                 create a collection            [workspace:write]
 *   GET    /collections                 list collections               [workspace:read]
 *   DELETE /collections/:collectionId   delete (re-homes its assets)   [workspace:write]
 *   POST   /assets                      upload an asset                [workspace:write]
 *   GET    /assets[?collectionId|q|tag] list / search                  [workspace:read]
 *   GET    /assets/:assetId             one asset (+ serve url)        [workspace:read]
 *   PATCH  /assets/:assetId             rename / tag / move / alt-text  [workspace:write]
 *   DELETE /assets/:assetId             delete (frees bytes)           [workspace:write]
 *   POST   /assets/:assetId/use         mark used (usage tracking)     [workspace:write]
 *   POST   /assets/:assetId/alt-text    AI alt-text proposal (ADR 0363; +`accessibility` toggle) [workspace:write]
 *
 * ALWAYS-ON (ADR 0027) — there is NO toggle gate (MEDIA-CODE-7: this header
 * previously claimed toggle-gating; `authorize` below is org-scoped RBAC only).
 * AUTHORITY (ADR 0006): every route resolves the
 * caller's RFC 0049 scope IN THE PATH org (`resolveEffectiveAccess`) — read on
 * `workspace:read` (viewer+), write on `workspace:write` (editor+); a non-member
 * gets zero scopes ⇒ 403. The org must exist in the caller's tenant ⇒ 404 (IDOR
 * guard). Bytes ride the RFC 0055 capability-token surface.
 *
 * @see docs/adr/0007-media-library.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import { createHash } from 'node:crypto';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireOrgScope, requireFeatureEnabled, requireString, optionalString as optString } from '../featureRoute.js';
import type { Scope } from '../../host/accessControlService.js';
import { isAllowedUploadMime, allowedUploadMimeList } from '../../host/allowedUploadMime.js';
import * as mediaStorage from './mediaStorage.js';
import {
  assertOrgCapacity,
  createAsset,
  createCollection,
  deleteAsset,
  deleteCollection,
  getAsset,
  listAssets,
  listCollections,
  findAssetByContentHash,
  mergeAssetMetadataOnDedup,
  parseFilenameTags,
  selectAssets,
  autotagAsset,
  generateAltText,
  listUsageForAsset,
  markUsed,
  updateAsset,
  viewAsset,
} from './mediaService.js';

// Decoded-bytes cap for an inline upload. Default 32 MiB (was 8 MiB) so
// NotebookLM-style audio/video transcription sources (ADR 0085) fit — a short
// recording or a compressed podcast clip routinely exceeds 8 MiB. Overridable via
// OPENWOP_MAX_UPLOAD_DECODED_BYTES for operators with larger media; very long
// recordings should still ride the URL-served path / be segmented (ADR 0085 OQ-3).
const MAX_DECODED_BYTES = process.env.OPENWOP_MAX_UPLOAD_DECODED_BYTES
  ? Math.max(1024 * 1024, Number(process.env.OPENWOP_MAX_UPLOAD_DECODED_BYTES) || 0)
  : 32 * 1024 * 1024;
const MAX_DECODED_MIB = Math.round(MAX_DECODED_BYTES / (1024 * 1024));
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Validate an upload's bytes + type and return the decoded size. Rejects
 *  non-base64 input, oversize content (on DECODED bytes), and any MIME outside
 *  the shared allowlist (the stored-XSS guard — text/html, svg are excluded). */
function validateUpload(contentBase64: string, contentType: string): number {
  if (!BASE64_RE.test(contentBase64) || contentBase64.length % 4 !== 0) {
    throw new OpenwopError('validation_error', 'Field `contentBase64` must be valid base64.', 400, { field: 'contentBase64' });
  }
  const decodedBytes = Buffer.byteLength(contentBase64, 'base64');
  if (decodedBytes > MAX_DECODED_BYTES) {
    // `validation_error` is the closest canonical code; the 413 status carries the size semantics.
    throw new OpenwopError('validation_error', `Asset exceeds the maximum size (${MAX_DECODED_MIB} MiB).`, 413, { maxBytes: MAX_DECODED_BYTES });
  }
  if (!isAllowedUploadMime(contentType)) {
    throw new OpenwopError('validation_error', `contentType must be one of: ${allowedUploadMimeList()}`, 415, { contentType });
  }
  return decodedBytes;
}

/** Org-scoped RBAC gate (the shared `requireOrgScope`). ADR 0027: Media is
 *  always-on, so there is no toggle gate — only the org-scoped RBAC. */
const authorize = (req: Request, scope: Scope): ReturnType<typeof requireOrgScope> =>
  requireOrgScope(req, scope);

export function registerMediaRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/media/orgs/:orgId';

  // ── Collections ──
  app.post(`${BASE}/collections`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:write');
      const name = requireString((req.body as { name?: unknown })?.name, 'name');
      res.status(201).json(await createCollection(tenantId, orgId, name, user.userId));
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/collections`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      res.json({ collections: await listCollections(tenantId, orgId) });
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/collections/:collectionId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:write');
      const result = await deleteCollection(tenantId, orgId, req.params.collectionId);
      if (!result) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId: req.params.collectionId });
      res.json({ deleted: result });
    } catch (err) {
      next(err);
    }
  });

  // ── Assets ──
  app.post(`${BASE}/assets`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as { contentBase64?: unknown; contentType?: unknown; name?: unknown; collectionId?: unknown; tags?: unknown; lineage?: unknown; marketing?: unknown };
      const contentBase64 = requireString(body.contentBase64, 'contentBase64');
      const contentType = requireString(body.contentType, 'contentType');
      const name = requireString(body.name, 'name');
      // Validate bytes + MIME, then check the org has capacity — BOTH before
      // storing, so a rejected upload never orphans bytes.
      const decodedBytes = validateUpload(contentBase64, contentType);
      // ADR 0352 P2 — SHA-256 dedup BEFORE storing: identical bytes return the
      // existing asset (200 + deduplicated) instead of a copy. Hash the decoded
      // bytes so re-encoding differences can't defeat it.
      const contentHash = createHash('sha256').update(Buffer.from(contentBase64, 'base64')).digest('hex');
      const existing = await findAssetByContentHash(tenantId, orgId, contentHash, optString(body.collectionId));
      if (existing) {
        // MEDIA-CODE-5 / CS-DATA-8 — a dedup hit merges the caller's NEW tags +
        // missing marketing-facet fields into the existing row (existing values
        // and name win) instead of silently discarding them.
        const merged = await mergeAssetMetadataOnDedup(existing, { tags: body.tags, marketing: body.marketing });
        res.status(200).json({ ...viewAsset(merged), deduplicated: true });
        return;
      }
      await assertOrgCapacity(tenantId, orgId, decodedBytes);
      const stored = await mediaStorage.put(tenantId, { contentBase64, contentType });
      const asset = await createAsset({
        tenantId,
        orgId,
        ...(optString(body.collectionId) ? { collectionId: optString(body.collectionId) } : {}),
        name,
        contentType,
        sizeBytes: stored.sizeBytes,
        storageRef: stored.storageRef,
        serveToken: stored.serveToken,
        tags: body.tags,
        uploadedBy: user.userId,
        contentHash,
        // ADR 0229 — optional provenance (derivedFrom / generatedBy:'ai' /
        // prompt / model / rightsNote); sanitized + bounded in the service.
        ...(body.lineage !== undefined ? { lineage: body.lineage } : {}),
        // ADR 0352 P1 — optional typed marketing facet.
        ...(body.marketing !== undefined ? { marketing: body.marketing } : {}),
      });
      res.status(201).json(viewAsset(asset));
    } catch (err) {
      next(err);
    }
  });

  // ADR 0352 P2 — bulk upload: ≤20 items per call, each through the SAME
  // validate→dedup→capacity→store→create pipeline (no second write path).
  // Deterministic filename parsing seeds tags (`product_angle_persona.ext`).
  app.post(`${BASE}/assets/bulk`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as { items?: unknown; collectionId?: unknown };
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0 || items.length > 20) {
        throw new OpenwopError('validation_error', '`items` MUST hold 1–20 uploads.', 400, { field: 'items' });
      }
      const results: Array<Record<string, unknown>> = [];
      for (const raw of items) {
        const it = (raw ?? {}) as { contentBase64?: unknown; contentType?: unknown; name?: unknown; tags?: unknown };
        try {
          const contentBase64 = requireString(it.contentBase64, 'contentBase64');
          const contentType = requireString(it.contentType, 'contentType');
          const name = requireString(it.name, 'name');
          const decodedBytes = validateUpload(contentBase64, contentType);
          const contentHash = createHash('sha256').update(Buffer.from(contentBase64, 'base64')).digest('hex');
          const existing = await findAssetByContentHash(tenantId, orgId, contentHash, optString(body.collectionId));
          if (existing) {
            // MEDIA-CODE-5 — merge the item's EXPLICIT tags into the existing row.
            const merged = await mergeAssetMetadataOnDedup(existing, { tags: it.tags });
            results.push({ name, status: 'deduplicated', asset: viewAsset(merged) });
            continue;
          }
          await assertOrgCapacity(tenantId, orgId, decodedBytes);
          const stored = await mediaStorage.put(tenantId, { contentBase64, contentType });
          const fileTags = parseFilenameTags(name);
          const givenTags = Array.isArray(it.tags) ? it.tags.filter((t): t is string => typeof t === 'string') : [];
          const asset = await createAsset({
            tenantId, orgId,
            ...(optString(body.collectionId) ? { collectionId: optString(body.collectionId) } : {}),
            name, contentType,
            sizeBytes: stored.sizeBytes, storageRef: stored.storageRef, serveToken: stored.serveToken,
            tags: [...givenTags, ...fileTags],
            uploadedBy: user.userId,
            contentHash,
          });
          results.push({ name, status: 'created', asset: viewAsset(asset) });
        } catch (err) {
          results.push({ name: typeof it.name === 'string' ? it.name : '', status: 'error', message: err instanceof Error ? err.message : 'upload failed' });
        }
      }
      res.status(207).json({ results });
    } catch (err) {
      next(err);
    }
  });

  // ADR 0352 P4 — weighted selection (read-only ranking; body carries criteria).
  app.post(`${BASE}/assets/select`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      const body = (req.body ?? {}) as { product?: unknown; industry?: unknown; useCase?: unknown; personaIds?: unknown; collectionId?: unknown; limit?: unknown };
      const result = await selectAssets(tenantId, orgId, {
        ...(optString(body.product) ? { product: optString(body.product) } : {}),
        ...(optString(body.industry) ? { industry: optString(body.industry) } : {}),
        ...(optString(body.useCase) ? { useCase: optString(body.useCase) } : {}),
        ...(Array.isArray(body.personaIds) ? { personaIds: body.personaIds.filter((x): x is string => typeof x === 'string') } : {}),
        ...(optString(body.collectionId) ? { collectionId: optString(body.collectionId) } : {}),
        ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/assets`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      const assets = await listAssets(tenantId, orgId, {
        ...(optString(req.query.collectionId) ? { collectionId: String(req.query.collectionId) } : {}),
        ...(optString(req.query.q) ? { q: String(req.query.q) } : {}),
        ...(optString(req.query.tag) ? { tag: String(req.query.tag) } : {}),
      });
      res.json({ assets: assets.map(viewAsset) });
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/assets/:assetId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      const asset = await getAsset(tenantId, orgId, req.params.assetId);
      if (!asset) throw new OpenwopError('not_found', 'Asset not found.', 404, { assetId: req.params.assetId });
      res.json(viewAsset(asset));
    } catch (err) {
      next(err);
    }
  });

  app.patch(`${BASE}/assets/:assetId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as { name?: unknown; tags?: unknown; collectionId?: unknown; lineage?: unknown; marketing?: unknown; renditions?: unknown; altText?: unknown; altTextSource?: unknown };
      const patch: { name?: string; tags?: unknown; collectionId?: string | null; lineage?: unknown; marketing?: unknown; renditions?: unknown; altText?: string | null; altTextSource?: unknown } = {};
      if (typeof body.name === 'string') patch.name = body.name;
      if (body.tags !== undefined) patch.tags = body.tags;
      if ('lineage' in body) patch.lineage = body.lineage; // ADR 0229 — null clears
      if ('marketing' in body) patch.marketing = body.marketing; // ADR 0352 P1 — null clears
      if ('renditions' in body) patch.renditions = body.renditions; // ADR 0352 P5 — null clears
      if ('altText' in body) patch.altText = body.altText === null ? null : typeof body.altText === 'string' ? body.altText : ''; // ADR 0363 P1 — null clears
      if ('altTextSource' in body) patch.altTextSource = body.altTextSource; // ADR 0363 P1 — validated in updateAsset
      if ('collectionId' in body) patch.collectionId = body.collectionId === null ? null : optString(body.collectionId) ?? null;
      const updated = await updateAsset(tenantId, orgId, req.params.assetId, patch);
      if (!updated) throw new OpenwopError('not_found', 'Asset not found.', 404, { assetId: req.params.assetId });
      res.json(viewAsset(updated));
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/assets/:assetId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:write');
      const ok = await deleteAsset(tenantId, orgId, req.params.assetId);
      if (!ok) throw new OpenwopError('not_found', 'Asset not found.', 404, { assetId: req.params.assetId });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ADR 0352 P3 — AI auto-tag proposal (suggest-confirm; apply via PATCH).
  app.post(`${BASE}/assets/:assetId/autotag`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:write');
      const proposal = await autotagAsset(tenantId, orgId, req.params.assetId);
      res.json({ proposal });
    } catch (err) {
      next(err);
    }
  });

  // ADR 0363 P1 — AI alt-text proposal (suggest-confirm; apply via PATCH). Media
  // is always-on, but this route is gated on the `accessibility` toggle (the
  // accessibility feature owns the switch; the generation logic lives here beside
  // autotag, where the byte + vision seams already are).
  app.post(`${BASE}/assets/:assetId/alt-text`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'accessibility', 'Accessibility');
      const { orgId, tenantId } = await authorize(req, 'workspace:write');
      const proposal = await generateAltText(tenantId, orgId, req.params.assetId);
      res.json({ proposal });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/assets/:assetId/use`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:write');
      const updated = await markUsed(tenantId, orgId, req.params.assetId);
      if (!updated) throw new OpenwopError('not_found', 'Asset not found.', 404, { assetId: req.params.assetId });
      res.json(viewAsset(updated));
    } catch (err) {
      next(err);
    }
  });

  // "Used by" — the documents referencing this asset (ADR 0206 usage refs; the
  // reference graph supersedes the bare usageCount as the asset-detail source).
  app.get(`${BASE}/assets/:assetId/usage`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      const usage = await listUsageForAsset(tenantId, orgId, req.params.assetId);
      if (!usage) throw new OpenwopError('not_found', 'Asset not found.', 404, { assetId: req.params.assetId });
      res.json({ usage });
    } catch (err) {
      next(err);
    }
  });
}

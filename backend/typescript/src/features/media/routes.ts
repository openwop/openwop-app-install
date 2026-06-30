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
 *   PATCH  /assets/:assetId             rename / tag / move            [workspace:write]
 *   DELETE /assets/:assetId             delete (frees bytes)           [workspace:write]
 *   POST   /assets/:assetId/use         mark used (usage tracking)     [workspace:write]
 *
 * TOGGLE-GATED on `media`. AUTHORITY (ADR 0006): every route resolves the
 * caller's RFC 0049 scope IN THE PATH org (`resolveEffectiveAccess`) — read on
 * `workspace:read` (viewer+), write on `workspace:write` (editor+); a non-member
 * gets zero scopes ⇒ 403. The org must exist in the caller's tenant ⇒ 404 (IDOR
 * guard). Bytes ride the RFC 0055 capability-token surface.
 *
 * @see docs/adr/0007-media-library.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireOrgScope, requireString, optionalString as optString } from '../featureRoute.js';
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
      const { user, orgId } = await authorize(req, 'workspace:write');
      const name = requireString((req.body as { name?: unknown })?.name, 'name');
      res.status(201).json(await createCollection(user.tenantId, orgId, name, user.userId));
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/collections`, async (req, res, next) => {
    try {
      const { user, orgId } = await authorize(req, 'workspace:read');
      res.json({ collections: await listCollections(user.tenantId, orgId) });
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/collections/:collectionId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authorize(req, 'workspace:write');
      const result = await deleteCollection(user.tenantId, orgId, req.params.collectionId);
      if (!result) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId: req.params.collectionId });
      res.json({ deleted: result });
    } catch (err) {
      next(err);
    }
  });

  // ── Assets ──
  app.post(`${BASE}/assets`, async (req, res, next) => {
    try {
      const { user, orgId } = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as { contentBase64?: unknown; contentType?: unknown; name?: unknown; collectionId?: unknown; tags?: unknown };
      const contentBase64 = requireString(body.contentBase64, 'contentBase64');
      const contentType = requireString(body.contentType, 'contentType');
      const name = requireString(body.name, 'name');
      // Validate bytes + MIME, then check the org has capacity — BOTH before
      // storing, so a rejected upload never orphans bytes.
      const decodedBytes = validateUpload(contentBase64, contentType);
      await assertOrgCapacity(user.tenantId, orgId, decodedBytes);
      const stored = await mediaStorage.put(user.tenantId, { contentBase64, contentType });
      const asset = await createAsset({
        tenantId: user.tenantId,
        orgId,
        ...(optString(body.collectionId) ? { collectionId: optString(body.collectionId) } : {}),
        name,
        contentType,
        sizeBytes: stored.sizeBytes,
        storageRef: stored.storageRef,
        serveToken: stored.serveToken,
        tags: body.tags,
        uploadedBy: user.userId,
      });
      res.status(201).json(viewAsset(asset));
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/assets`, async (req, res, next) => {
    try {
      const { user, orgId } = await authorize(req, 'workspace:read');
      const assets = await listAssets(user.tenantId, orgId, {
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
      const { user, orgId } = await authorize(req, 'workspace:read');
      const asset = await getAsset(user.tenantId, orgId, req.params.assetId);
      if (!asset) throw new OpenwopError('not_found', 'Asset not found.', 404, { assetId: req.params.assetId });
      res.json(viewAsset(asset));
    } catch (err) {
      next(err);
    }
  });

  app.patch(`${BASE}/assets/:assetId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as { name?: unknown; tags?: unknown; collectionId?: unknown };
      const patch: { name?: string; tags?: unknown; collectionId?: string | null } = {};
      if (typeof body.name === 'string') patch.name = body.name;
      if (body.tags !== undefined) patch.tags = body.tags;
      if ('collectionId' in body) patch.collectionId = body.collectionId === null ? null : optString(body.collectionId) ?? null;
      const updated = await updateAsset(user.tenantId, orgId, req.params.assetId, patch);
      if (!updated) throw new OpenwopError('not_found', 'Asset not found.', 404, { assetId: req.params.assetId });
      res.json(viewAsset(updated));
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/assets/:assetId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authorize(req, 'workspace:write');
      const ok = await deleteAsset(user.tenantId, orgId, req.params.assetId);
      if (!ok) throw new OpenwopError('not_found', 'Asset not found.', 404, { assetId: req.params.assetId });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/assets/:assetId/use`, async (req, res, next) => {
    try {
      const { user, orgId } = await authorize(req, 'workspace:write');
      const updated = await markUsed(user.tenantId, orgId, req.params.assetId);
      if (!updated) throw new OpenwopError('not_found', 'Asset not found.', 404, { assetId: req.params.assetId });
      res.json(viewAsset(updated));
    } catch (err) {
      next(err);
    }
  });
}

/**
 * Knowledge Base routes (ADR 0011) — host-extension, best-effort. Org-scoped
 * under /v1/host/openwop-app/kb/orgs/:orgId, gated by the shared `authorizeOrgScope`:
 *   read (list/get/search/rag)         → workspace:read
 *   ingest/manage (create/delete)      → workspace:write
 * Tenant+org IDOR-guarded throughout.
 *
 * @see docs/adr/0011-knowledge-base-rag.md
 */

import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireOrgScope } from '../featureRoute.js';
import {
  createCollection,
  deleteCollection,
  deleteDocument,
  getCollection,
  getDocument,
  ingestDocument,
  listCollections,
  listDocuments,
  ragQuery,
  resolveRetrievalMode,
  search,
  setRetrievalConfig,
} from './kbService.js';


/**
 * Reject hand-edits on an AUTO-MANAGED collection (ADR 0100). A managed
 * 'Strategy KB' / 'Priority Matrix KB' is kept in sync by its owning feature; a
 * user adding/removing docs or deleting the collection via the KB API would
 * desync it (the next CRUD would silently overwrite the change). The owning
 * feature's indexer bypasses this guard — it calls kbService directly, not the
 * HTTP route.
 */
async function assertNotManaged(tenantId: string, orgId: string, collectionId: string): Promise<void> {
  const col = await getCollection(tenantId, orgId, collectionId);
  if (col?.managed) {
    throw new OpenwopError('validation_error', `This collection is managed (synced from ${col.managed}); edit the source instead.`, 400, { collectionId, managed: col.managed });
  }
}

export function registerKbRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/kb/orgs/:orgId';

  // ── collections ──
  app.get(`${BASE}/collections`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'workspace:read');
      res.json({ collections: await listCollections(user.tenantId, orgId) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/collections`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'workspace:write');
      const body = (req.body ?? {}) as { name?: unknown; description?: unknown };
      const col = await createCollection(user.tenantId, orgId, user.userId, body);
      res.status(201).json(col);
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/collections/:collectionId`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'workspace:read');
      const col = await getCollection(user.tenantId, orgId, req.params.collectionId);
      if (!col) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId: req.params.collectionId });
      res.json(col);
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/collections/:collectionId`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'workspace:write');
      await assertNotManaged(user.tenantId, orgId, req.params.collectionId);
      await deleteCollection(user.tenantId, orgId, req.params.collectionId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── documents (ingest) ──
  app.get(`${BASE}/collections/:collectionId/documents`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'workspace:read');
      res.json({ documents: await listDocuments(user.tenantId, orgId, req.params.collectionId) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/collections/:collectionId/documents`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'workspace:write');
      await assertNotManaged(user.tenantId, orgId, req.params.collectionId);
      const body = (req.body ?? {}) as { title?: unknown; text?: unknown; mediaToken?: unknown; contentBase64?: unknown; contentType?: unknown };
      const doc = await ingestDocument(user.tenantId, orgId, user.userId, req.params.collectionId, body);
      res.status(201).json(doc);
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/collections/:collectionId/documents/:documentId`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'workspace:read');
      const doc = await getDocument(user.tenantId, orgId, req.params.collectionId, req.params.documentId);
      if (!doc) throw new OpenwopError('not_found', 'Document not found.', 404, { documentId: req.params.documentId });
      res.json(doc);
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/collections/:collectionId/documents/:documentId`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'workspace:write');
      await assertNotManaged(user.tenantId, orgId, req.params.collectionId);
      await deleteDocument(user.tenantId, orgId, req.params.collectionId, req.params.documentId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── retrieval ──
  app.post(`${BASE}/collections/:collectionId/search`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'workspace:read');
      const body = (req.body ?? {}) as { query?: unknown; topK?: unknown; mode?: unknown };
      // Honor the collection's configured retrieval mode (ADR 0113); a request MAY
      // override per-call (e.g. the KB UI previewing a mode before saving).
      const override = body.mode === 'dense' || body.mode === 'hybrid' || body.mode === 'hybrid+rerank' ? body.mode : undefined;
      const col = await getCollection(user.tenantId, orgId, req.params.collectionId);
      const mode = override ?? (col ? resolveRetrievalMode(col) : 'dense');
      res.json({ results: await search(user.tenantId, orgId, req.params.collectionId, body.query, body.topK, mode) });
    } catch (err) { next(err); }
  });

  // ADR 0113 Phase 3 — per-collection retrieval config (mode + local rerank).
  app.patch(`${BASE}/collections/:collectionId/retrieval`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'workspace:write');
      const body = (req.body ?? {}) as { mode?: unknown; rerank?: unknown };
      const col = await setRetrievalConfig(user.tenantId, orgId, req.params.collectionId, user.userId, body);
      res.json({ collection: col });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/collections/:collectionId/rag`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'workspace:read');
      const body = (req.body ?? {}) as { query?: unknown; topK?: unknown };
      res.json(await ragQuery(user.tenantId, orgId, req.params.collectionId, body.query, body.topK));
    } catch (err) { next(err); }
  });
}

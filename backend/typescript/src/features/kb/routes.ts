/**
 * Knowledge Base routes (ADR 0011) — host-extension, sample-grade. Org-scoped
 * under /v1/host/sample/kb/orgs/:orgId, gated by the shared `authorizeOrgScope`:
 *   read (list/get/search/rag)         → workspace:read
 *   ingest/manage (create/delete)      → workspace:write
 * Tenant+org IDOR-guarded throughout.
 *
 * @see docs/adr/0011-knowledge-base-rag.md
 */

import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope } from '../featureRoute.js';
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
  search,
} from './kbService.js';

const TOGGLE_ID = 'kb';
const FEATURE = { toggleId: TOGGLE_ID, label: 'Knowledge Base' };

export function registerKbRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/sample/kb/orgs/:orgId';

  // ── collections ──
  app.get(`${BASE}/collections`, async (req, res, next) => {
    try {
      const { user, orgId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      res.json({ collections: await listCollections(user.tenantId, orgId) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/collections`, async (req, res, next) => {
    try {
      const { user, orgId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const body = (req.body ?? {}) as { name?: unknown; description?: unknown };
      const col = await createCollection(user.tenantId, orgId, user.userId, body);
      res.status(201).json(col);
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/collections/:collectionId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      const col = await getCollection(user.tenantId, orgId, req.params.collectionId);
      if (!col) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId: req.params.collectionId });
      res.json(col);
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/collections/:collectionId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      await deleteCollection(user.tenantId, orgId, req.params.collectionId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── documents (ingest) ──
  app.get(`${BASE}/collections/:collectionId/documents`, async (req, res, next) => {
    try {
      const { user, orgId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      res.json({ documents: await listDocuments(user.tenantId, orgId, req.params.collectionId) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/collections/:collectionId/documents`, async (req, res, next) => {
    try {
      const { user, orgId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const body = (req.body ?? {}) as { title?: unknown; text?: unknown; mediaToken?: unknown };
      const doc = await ingestDocument(user.tenantId, orgId, user.userId, req.params.collectionId, body);
      res.status(201).json(doc);
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/collections/:collectionId/documents/:documentId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      const doc = await getDocument(user.tenantId, orgId, req.params.collectionId, req.params.documentId);
      if (!doc) throw new OpenwopError('not_found', 'Document not found.', 404, { documentId: req.params.documentId });
      res.json(doc);
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/collections/:collectionId/documents/:documentId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      await deleteDocument(user.tenantId, orgId, req.params.collectionId, req.params.documentId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── retrieval ──
  app.post(`${BASE}/collections/:collectionId/search`, async (req, res, next) => {
    try {
      const { user, orgId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      const body = (req.body ?? {}) as { query?: unknown; topK?: unknown };
      res.json({ results: await search(user.tenantId, orgId, req.params.collectionId, body.query, body.topK) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/collections/:collectionId/rag`, async (req, res, next) => {
    try {
      const { user, orgId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      const body = (req.body ?? {}) as { query?: unknown; topK?: unknown };
      res.json(await ragQuery(user.tenantId, orgId, req.params.collectionId, body.query, body.topK));
    } catch (err) { next(err); }
  });
}

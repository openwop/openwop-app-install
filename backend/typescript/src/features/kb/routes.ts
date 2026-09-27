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
import { resolveSubjectAccess, levelSatisfies, type SubjectCaller } from '../../host/subjectAccess.js';
import { callerSubject } from '../../host/requestSubject.js';
import {
  createCollection,
  deleteCollection,
  deleteDocument,
  getCollection,
  getDocument,
  ingestDocument,
  ingestMediaCollection,
  listCollections,
  listDocuments,
  ragQuery, searchDetailed,
  resolveRetrievalMode,
  setRetrievalConfig,
  startReindex,
  drainReindex,
  cancelReindex,
  getReindexJob,
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

/**
 * ADR 0608 D4 (`CPC-2`) — a collection bound to a membership-scoped Subject is
 * gated by that Subject too.
 *
 * A KB collection is an org row and these doors gate on org scope, which is
 * correct for an org resource. But `POST /projects/:id/knowledge/collections`
 * creates an ordinary org collection and binds it to the project, so a `private`
 * project's curated corpus — collection titles, document titles, and the
 * VERBATIM chunk text returned by search — was readable by any org reader who is
 * not a project member, while `/projects/:id/knowledge` 404'd that same caller.
 * Two doors, same rows, opposite answers; measured live.
 *
 * The decision (recorded in ADR 0608 D4): CONSTRAIN the KB door rather than widen
 * the project door. `col.boundSubject` is SERVER-SET at create/bind time
 * (`InternalCollectionFields`, unreachable from a network caller), and when it is
 * present the caller must additionally satisfy the ADR 0054 D5 `subjectAccess`
 * seam. Fail-closed as a uniform 404 — the same answer the project door gives, so
 * the two doors cannot disagree about existence either.
 *
 * READ is the level checked here even on write routes, deliberately: the write
 * routes already require `workspace:write` IN THE COLLECTION'S ORG, and the
 * project rule makes org-write in the project's org imply project-write. So a
 * caller who clears the route's own gate necessarily clears the subject's write
 * gate; the only thing this guard must add is the membership READ dimension.
 *
 * It is a MOUNTED GUARD, not a per-handler call, so a route added later inherits
 * it instead of having to remember it — the `CPC-8` lesson applied one level down.
 */
async function assertCollectionSubjectReadable(req: Parameters<typeof requireOrgScope>[0], collectionId: string): Promise<void> {
  const { orgId, tenantId } = await requireOrgScope(req, 'workspace:read');
  const col = await getCollection(tenantId, orgId, collectionId);
  if (!col?.boundSubject) return; // not membership-scoped ⇒ org scope is the whole rule
  const level = await resolveSubjectAccess(tenantId, col.boundSubject, callerSubject(req));
  if (level !== null && !levelSatisfies(level, 'read')) {
    throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId });
  }
}

/**
 * KBC-1 (ADR 0643 D2 precondition) — the request's caller, in the shape
 * `kbService` now gates on.
 *
 * The mounted `assertCollectionSubjectReadable` guard below STAYS: two gates that
 * agree cost one memoized resolve and a route added later cannot forget either.
 * But the routes pass the real caller through anyway rather than
 * `PREAUTHORIZED_CALLER`, so the SERVICE gate is genuinely exercised on the HTTP
 * lane too — a bypass that only ever runs on the lanes nobody tests is how the
 * gate ended up HTTP-only in the first place.
 */
const kbCaller = (req: Parameters<typeof requireOrgScope>[0]): SubjectCaller => {
  const subject = callerSubject(req);
  return { ...(subject ? { subject } : {}) };
};

export function registerKbRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/kb/orgs/:orgId';

  // ADR 0608 D4 (`CPC-2`) — ONE guard in front of every `/collections/:collectionId`
  // route (all methods, all sub-paths), so search / documents / rag / reindex
  // cannot each forget it.
  app.use(`${BASE}/collections/:collectionId`, (req, _res, next) => {
    void assertCollectionSubjectReadable(req, req.params.collectionId).then(() => next(), next);
  });

  // ── collections ──
  app.get(`${BASE}/collections`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'workspace:read');
      // ADR 0608 D4 (`CPC-2`) — the listing is a read door too: a `private`
      // project's collection NAME was published to every org reader.
      const all = await listCollections(tenantId, orgId, kbCaller(req));
      const caller = callerSubject(req);
      const memo = new Map<string, Promise<'none' | 'read' | 'write' | null>>();
      const out: typeof all = [];
      for (const col of all) {
        if (!col.boundSubject) { out.push(col); continue; }
        const key = JSON.stringify([col.boundSubject.kind, col.boundSubject.id]);
        let pending = memo.get(key);
        if (pending === undefined) { pending = resolveSubjectAccess(tenantId, col.boundSubject, caller); memo.set(key, pending); }
        const level = await pending;
        if (level === null || levelSatisfies(level, 'read')) out.push(col);
      }
      res.json({ collections: out });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/collections`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireOrgScope(req, 'workspace:write');
      // KB-1 — PICK the caller-settable fields at RUNTIME. This used to be
      // `(req.body ?? {}) as { name?: unknown; description?: unknown }`, and a TypeScript
      // cast is erased at runtime: the WHOLE body reached `createCollection`, which honors
      // `input.collectionId` and `input.managed`. Choosing your own collection id is the
      // whole attack — the managed convention is deterministic and in-tree
      // (`mgd-strategy-${orgId}`), so an org-A member with `workspace:write` could mint
      // another org's id and (before the namespace also carried the org) read its chunk
      // text.
      //
      // CORRECTION (KB-1 R2). The first version of this comment claimed the pick "closes
      // it by construction — an unknown field cannot pass, ever". FALSE, and the review
      // that found it was right: a pick at ONE route closes ONE route. `createCollection`
      // still honoured both fields, and THREE sibling routes — agent-knowledge,
      // profile-memory and projects — forward a raw `req.body` behind the same erased
      // cast. The class is now closed where it belongs, at the SERVICE: the privileged
      // fields ride `InternalCollectionFields` / `InternalDocumentFields`, a second
      // parameter no forwarded body can populate, and the service REFUSES an `input` that
      // carries one. This pick is kept as the cheap first line, not as the guarantee.
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const col = await createCollection(tenantId, orgId, user.userId, { name: raw.name, description: raw.description });
      res.status(201).json(col);
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/collections/:collectionId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'workspace:read');
      const col = await getCollection(tenantId, orgId, req.params.collectionId, kbCaller(req));
      if (!col) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId: req.params.collectionId });
      res.json(col);
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/collections/:collectionId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'workspace:write');
      await assertNotManaged(tenantId, orgId, req.params.collectionId);
      await deleteCollection(tenantId, orgId, req.params.collectionId, kbCaller(req));
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── documents (ingest) ──
  app.get(`${BASE}/collections/:collectionId/documents`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'workspace:read');
      res.json({ documents: await listDocuments(tenantId, orgId, req.params.collectionId, kbCaller(req)) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/collections/:collectionId/documents`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireOrgScope(req, 'workspace:write');
      await assertNotManaged(tenantId, orgId, req.params.collectionId);
      // KB-1 — PICK, don't rest-strip. KB-CODE-11 removed `revision` here because a
      // caller-forged value corrupts the revision log the staleness seam keys off; but a
      // rest-strip closes ONE named field and lets every other one through, so
      // `documentId` (a stable id — the clobber + orphan-chunk-tail vector) and
      // `contentTrust` both still reached the service.
      //
      // CORRECTION (KB-1 R2): "the only shape that closes the class" was overstated for
      // the same reason as the create route above — `agent-knowledge/routes.ts` still
      // forwards a raw body to `ingestDocument`. The class is closed at the service via
      // `InternalDocumentFields`; this pick is the local first line.
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const doc = await ingestDocument(tenantId, orgId, user.userId, req.params.collectionId, {
        title: raw.title, text: raw.text, mediaToken: raw.mediaToken, contentBase64: raw.contentBase64, contentType: raw.contentType, url: raw.url,
      }, {}, kbCaller(req));
      res.status(201).json(doc);
    } catch (err) { next(err); }
  });

  // ADR 0398 P2 — media-collection → KB bridge. Ingests a media collection's extractable
  // assets as untrusted-fenced, stable-id documents (idempotent). Itemized skip report.
  app.post(`${BASE}/collections/:collectionId/ingest-media-collection`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireOrgScope(req, 'workspace:write');
      await assertNotManaged(tenantId, orgId, req.params.collectionId);
      const mediaCollectionId = (req.body as { mediaCollectionId?: unknown })?.mediaCollectionId;
      if (typeof mediaCollectionId !== 'string' || mediaCollectionId.length === 0) {
        throw new OpenwopError('validation_error', '`mediaCollectionId` (non-empty string) is required.', 400, { field: 'mediaCollectionId' });
      }
      const result = await ingestMediaCollection(tenantId, orgId, user.userId, req.params.collectionId, mediaCollectionId, kbCaller(req));
      res.json(result);
    } catch (err) { next(err); }
  });

  // ADR 0398 P3 — versioned reindex (per-collection embedding-spec migration). ADMIN-gated
  // (it spends provider budget + rewrites a namespace). Start builds a staging namespace,
  // drain drives it in bounded batches (loop-off-host mechanism), GET reports progress.
  app.post(`${BASE}/collections/:collectionId/reindex`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'host:org:manage');
      const job = await startReindex(tenantId, orgId, req.params.collectionId, (req.body as { embeddingSpec?: unknown })?.embeddingSpec, kbCaller(req));
      res.status(202).json(job);
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/collections/:collectionId/reindex/drain`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'host:org:manage');
      const maxRaw = Number((req.body as { maxChunks?: unknown })?.maxChunks);
      const job = await drainReindex(tenantId, orgId, req.params.collectionId, Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(4096, Math.floor(maxRaw)) : undefined, kbCaller(req));
      if (!job) throw new OpenwopError('not_found', 'No reindex job for this collection.', 404, {});
      res.json(job);
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/collections/:collectionId/reindex/cancel`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'host:org:manage');
      const job = await cancelReindex(tenantId, orgId, req.params.collectionId, kbCaller(req));
      if (!job) throw new OpenwopError('not_found', 'No reindex job for this collection.', 404, {});
      res.json(job);
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/collections/:collectionId/reindex`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'workspace:read');
      res.json({ job: await getReindexJob(tenantId, orgId, req.params.collectionId, kbCaller(req)) });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/collections/:collectionId/documents/:documentId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'workspace:read');
      const doc = await getDocument(tenantId, orgId, req.params.collectionId, req.params.documentId, kbCaller(req));
      if (!doc) throw new OpenwopError('not_found', 'Document not found.', 404, { documentId: req.params.documentId });
      res.json(doc);
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/collections/:collectionId/documents/:documentId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'workspace:write');
      await assertNotManaged(tenantId, orgId, req.params.collectionId);
      await deleteDocument(tenantId, orgId, req.params.collectionId, req.params.documentId, kbCaller(req));
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── retrieval ──
  app.post(`${BASE}/collections/:collectionId/search`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'workspace:read');
      const body = (req.body ?? {}) as { query?: unknown; topK?: unknown; mode?: unknown };
      // Honor the collection's configured retrieval mode (ADR 0113); a request MAY
      // override per-call (e.g. the KB UI previewing a mode before saving).
      const override = body.mode === 'dense' || body.mode === 'hybrid' || body.mode === 'hybrid+rerank' ? body.mode : undefined;
      const col = await getCollection(tenantId, orgId, req.params.collectionId, kbCaller(req));
      const mode = override ?? (col ? resolveRetrievalMode(col) : 'dense');
      const { hits, embedding, rerank } = await searchDetailed(tenantId, orgId, req.params.collectionId, body.query, body.topK, mode, kbCaller(req));
      res.json({ results: hits, embedding, ...(rerank ? { rerank } : {}) });
    } catch (err) { next(err); }
  });

  // ADR 0113 Phase 3 — per-collection retrieval config (mode + local rerank).
  app.patch(`${BASE}/collections/:collectionId/retrieval`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireOrgScope(req, 'workspace:write');
      // KB-1 — same pick-don't-cast rule as the two routes above. `setRetrievalConfig`
      // happens to read only these four today; the cast is what would let a fifth field
      // ride in silently the moment one is added.
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const col = await setRetrievalConfig(tenantId, orgId, req.params.collectionId, user.userId, {
        mode: raw.mode, rerank: raw.rerank, embedder: raw.embedder, enrichment: raw.enrichment,
      }, kbCaller(req));
      res.json({ collection: col });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/collections/:collectionId/rag`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'workspace:read');
      const body = (req.body ?? {}) as { query?: unknown; topK?: unknown };
      res.json(await ragQuery(tenantId, orgId, req.params.collectionId, body.query, body.topK, undefined, kbCaller(req)));
    } catch (err) { next(err); }
  });
}

/**
 * Research Notebooks (ADR 0084) — a thin feature-package vertical slice.
 *
 * A notebook IS a project Subject (`facet:'notebook'`). It owns nothing new: it
 * COMPOSES the existing seams, the no-parallel-architecture law (MEMORY.md):
 *   - the notebook            → a project (`projectsService`, `facet:'notebook'`)
 *   - its sources             → a KB collection (`kbService`), bound to the
 *                               `project:<id>` subject via `host/subjectKnowledge`
 *   - its notes               → subject memory in the `project:<id>` scope
 *                               (`host/subjectMemory` — add/list curated notes)
 *   - its search / ask        → KB semantic search over the bound collection
 *                               (`kbService.search` — grounded hits + citations)
 *
 * Ingest/search use the SYNCHRONOUS deterministic local embedder inside kbService
 * (`aiProviders/localEmbedding`), so every operation here is route-callable (no
 * run-scoped provider / `ctx` needed).
 *
 * Tenant + org isolation rides the underlying services (CTI-1): `getProject` is
 * tenant-scoped (foreign-tenant ⇒ null), KB keys on tenant+org+collection. The
 * routes layer adds the RBAC scope + uniform-404 IDOR guard (see routes.ts).
 *
 * @see docs/adr/0084-research-notebooks.md
 */

import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import {
  createProject, getProject, listProjects, deleteProject, projectSubject, type Project,
} from '../projects/projectsService.js';
import {
  createCollection, deleteCollection, ingestDocument, listDocuments, getDocument, search,
  type KnowledgeDocument, type SearchHit,
} from '../kb/kbService.js';
import { getSubjectKnowledge, setSubjectKnowledge, clearSubjectKnowledge } from '../../host/subjectKnowledge.js';
import { addSubjectNote, listSubjectNotes, type SubjectNote } from '../../host/subjectMemory.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
// Cross-feature read: the transformation OUTPUT lives in Documents (the single
// owner of stored artifacts, ADR 0053) — there is no notebooks transformation
// store. Listing a notebook's transformations is a `listDocuments(by ownerSubject)`
// read. A direct cross-feature import of documentsService is precedented
// (features/priority-matrix + features/sharing both import it), and Documents is a
// host-extension feature (not the wire), so this is host-internal — no RFC.
import { listDocuments as listFeatureDocuments } from '../documents/documentsService.js';
import { NOTEBOOK_TRANSFORMATION_KINDS } from './transformations.js';

const log = createLogger('features.notebooks');

/**
 * Per-source CONTEXT LEVEL (ADR 0084 Context Levels).
 *   - `full`     — the source is in the grounded chat + Ask (the default).
 *   - `summary`  — the source's RAW chunks are dropped from context and a stored
 *                  LLM summary (ADR 0084 Transformations T1) is injected instead
 *                  (via the binding's generic `extraContext`). Selectable ONLY once
 *                  a summary has been generated (the route enforces it).
 *   - `excluded` — omitted from BOTH the grounded chat and Ask.
 */
export type SourceContextLevel = 'full' | 'summary' | 'excluded';

/** A stored per-source context level. The level store is the SOURCE OF TRUTH; the
 *  binding's `retrieval.excludeDocumentIds` is a DERIVED projection recomputed from
 *  it. Default (absent row) = `'full'`. Keyed `${tenantId}:${notebookId}:${sourceId}`. */
interface StoredSourceLevel {
  tenantId: string;
  notebookId: string;
  sourceId: string;
  level: SourceContextLevel;
}

const sourceLevels = new DurableCollection<StoredSourceLevel>(
  'notebook-source-level',
  (r) => `${r.tenantId}:${r.notebookId}:${r.sourceId}`,
);

/** A stored per-source SUMMARY (ADR 0084 Transformations T1) — the LLM-generated
 *  short summary produced by the `notebooks.summarize` built-in workflow run. Its
 *  presence is what UN-GATES the `summary` context level (the route refuses
 *  `summary` until a row exists). Keyed `${tenantId}:${notebookId}:${sourceId}`. */
interface StoredSourceSummary {
  tenantId: string;
  notebookId: string;
  sourceId: string;
  summary: string;
  createdAt: string;
}

const sourceSummaries = new DurableCollection<StoredSourceSummary>(
  'notebook-source-summary',
  (r) => `${r.tenantId}:${r.notebookId}:${r.sourceId}`,
);

/** All stored levels for one notebook (a bounded prefix scan). */
async function notebookLevels(tenantId: string, notebookId: string): Promise<StoredSourceLevel[]> {
  return sourceLevels.listByPrefix(`${tenantId}:${notebookId}:`);
}

/** All stored summaries for one notebook (a bounded prefix scan). */
async function notebookSummaries(tenantId: string, notebookId: string): Promise<StoredSourceSummary[]> {
  return sourceSummaries.listByPrefix(`${tenantId}:${notebookId}:`);
}

/**
 * The DERIVED binding projection for a notebook's context levels (ADR 0084).
 * Recomputed from the level store + the summary store (both sources of truth):
 *   - `excluded`                          → drop its raw chunks (excludeDocumentIds)
 *   - `summary` (only if a summary exists) → drop its raw chunks (excludeDocumentIds)
 *                                            + inject the stored summary as a fenced
 *                                            `extraContext` item (untrusted)
 *   - `full`                              → nothing
 * Returns BOTH arrays so `setSubjectKnowledge` writes them onto the binding's
 * `retrieval` (preserving `collectionIds`). A `summary` level with NO stored summary
 * is treated like `full` (defensive — the route gates it, but the projection must
 * never drop a source's chunks without a replacement summary to inject).
 */
async function deriveContextProjection(
  tenantId: string,
  notebookId: string,
  titleOf: (sourceId: string) => string | undefined,
): Promise<{ excludeDocumentIds: string[]; extraContext: Array<{ title?: string; content: string; contentTrust: 'untrusted' }> }> {
  const [levels, summaries] = await Promise.all([
    notebookLevels(tenantId, notebookId),
    notebookSummaries(tenantId, notebookId),
  ]);
  const summaryById = new Map(summaries.map((s) => [s.sourceId, s.summary]));
  const excludeDocumentIds: string[] = [];
  const extraContext: Array<{ title?: string; content: string; contentTrust: 'untrusted' }> = [];
  for (const r of levels) {
    if (r.level === 'excluded') {
      excludeDocumentIds.push(r.sourceId);
    } else if (r.level === 'summary') {
      const summary = summaryById.get(r.sourceId);
      if (!summary) continue; // no summary yet ⇒ behave like 'full' (don't drop chunks)
      excludeDocumentIds.push(r.sourceId); // drop the raw chunks…
      const title = titleOf(r.sourceId); // …inject the summary in their place
      extraContext.push({ ...(title ? { title } : {}), content: summary, contentTrust: 'untrusted' });
    }
  }
  return { excludeDocumentIds, extraContext };
}

/** The notebook projection returned over the wire — a project plus its bound KB
 *  collection id, so the FE can drive sources/search without a second round-trip. */
export interface Notebook {
  id: string;
  tenantId: string;
  orgId: string;
  name: string;
  collectionId: string;
  createdAt: string;
  updatedAt: string;
}

/** A source document in a notebook (the KB document list projection — no full text)
 *  plus its per-source context level (ADR 0084; default `'full'`) and whether a
 *  stored LLM summary exists (ADR 0084 Transformations T1 — un-gates `summary`). */
export type NotebookSource = Omit<KnowledgeDocument, 'text'> & {
  contextLevel: SourceContextLevel;
  hasSummary: boolean;
};

/** Project the project + its bound collection id into the notebook shape. The
 *  collection id is the FIRST (and, in this slice, only) binding on the
 *  `project:<id>` subject — created + bound by `createNotebook`. */
async function toNotebook(tenantId: string, p: Project): Promise<Notebook | null> {
  const binding = await getSubjectKnowledge(tenantId, projectSubject(p.id));
  const collectionId = binding.collectionIds?.[0];
  if (!collectionId) return null; // not a fully-provisioned notebook
  return {
    id: p.id,
    tenantId: p.tenantId,
    orgId: p.orgId,
    name: p.name,
    collectionId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** Resolve a notebook by id, tenant-scoped. ADR 0084 correction (notebooks/podcasts
 *  surfaced as PROJECT tabs, not a standalone destination): a notebook is now ANY
 *  `kind:'project'` Subject that has a bound KB collection — not only `facet:'notebook'`
 *  ones. A project without a bound collection reads `null` (toNotebook ⇒ null) until
 *  `ensureNotebookForProject` provisions one (the Sources tab does this on open). A
 *  foreign-tenant / non-project id is `null` too — the routes turn that into a uniform
 *  404 (no existence leak, no cross-tenant probe). RBAC is enforced at the route via
 *  resolveProjectAccess, unchanged. */
export async function getNotebook(tenantId: string, id: string): Promise<Notebook | null> {
  const p = await getProject(tenantId, id);
  if (!p) return null;
  return toNotebook(tenantId, p);
}

/** Create a notebook: a `facet:'notebook'` project + a KB collection + bind the
 *  collection to the project subject (the three composed seams). Returns the
 *  notebook + its collection id. Org-scoped (the project + collection live in
 *  `orgId`). The KB collection name mirrors the notebook so it's recognizable in
 *  the KB admin surface; the durable link is the subject-knowledge binding. */
export async function createNotebook(
  tenantId: string,
  orgId: string,
  actor: string,
  input: { name?: unknown },
): Promise<Notebook> {
  // Project FIRST (it also validates `name` + the workspace cap + provisions the board).
  const project = await createProject(tenantId, orgId, { name: input.name, facet: 'notebook' });
  // NB-5 — the create is multi-step (project → collection → binding); a failure AFTER the
  // project exists would otherwise leave an orphaned `facet:'notebook'` project that is
  // invisible (toNotebook ⇒ null, 404 on get, filtered from the list) yet still counts
  // against the workspace cap. Roll the partial provision back so the create is atomic.
  let collectionId: string | undefined;
  try {
    const collection = await createCollection(tenantId, orgId, actor, {
      name: `Notebook: ${project.name}`,
      description: `Sources for the “${project.name}” research notebook.`,
    });
    collectionId = collection.collectionId;
    await setSubjectKnowledge(tenantId, projectSubject(project.id), { collectionIds: [collectionId] });
    const notebook = await toNotebook(tenantId, project);
    if (!notebook) {
      // Should never happen (we just bound the collection) — fail loud rather than
      // return a half-provisioned shape.
      throw new OpenwopError('internal_error', 'Notebook provisioning failed.', 500, { id: project.id });
    }
    return notebook;
  } catch (err) {
    // Best-effort rollback of the just-minted collection + project; log if cleanup itself
    // fails (an orphan we couldn't reach), then re-throw the original provisioning error.
    if (collectionId) await deleteCollection(tenantId, orgId, collectionId).catch(() => undefined);
    await deleteProject(tenantId, project.id).catch((e) =>
      log.warn('notebook_create_rollback_failed', { id: project.id, error: e instanceof Error ? e.message : String(e) }));
    throw err;
  }
}

/**
 * Ensure an EXISTING project has notebook research capability (ADR 0084 correction —
 * Sources is a project tab, so any project can host sources). Idempotent: if the
 * project already has a bound KB collection, returns that notebook; otherwise
 * provisions a collection + binds it, PRESERVING any existing knowledge binding
 * (`retrieval` from the project's Knowledge tab) so we don't clobber it. The caller
 * (route) has already RBAC-gated the project. A missing project throws the uniform 404.
 */
export async function ensureNotebookForProject(tenantId: string, id: string, actor: string): Promise<Notebook> {
  const project = await getProject(tenantId, id);
  if (!project) throw new OpenwopError('not_found', 'Project not found.', 404, { id });
  const existing = await toNotebook(tenantId, project);
  if (existing) return existing; // already has a bound collection — no-op
  const collection = await createCollection(tenantId, project.orgId, actor, {
    name: `Sources: ${project.name}`,
    description: `Research sources for the “${project.name}” project.`,
  });
  const binding = await getSubjectKnowledge(tenantId, projectSubject(project.id));
  await setSubjectKnowledge(tenantId, projectSubject(project.id), {
    // Append the new collection; preserve any existing collections + retrieval projection.
    collectionIds: [...(binding.collectionIds ?? []), collection.collectionId],
    ...(binding.retrieval ? { retrieval: binding.retrieval } : {}),
  });
  const notebook = await toNotebook(tenantId, project);
  if (!notebook) throw new OpenwopError('internal_error', 'Sources provisioning failed.', 500, { id });
  return notebook;
}

/** List the tenant's notebooks (every project with a bound KB collection), oldest-first.
 *  Org/visibility filtering is applied at the route via the project access gate. */
export async function listNotebooks(tenantId: string): Promise<Notebook[]> {
  // ADR 0084 correction — every project with a bound collection is a notebook (not
  // only facet:'notebook'); toNotebook filters out projects without one.
  const projects = await listProjects(tenantId);
  // NB-1 — resolve each notebook's binding CONCURRENTLY (was a sequential per-project await):
  // these are internal durable reads (not rate-limited HTTP fan-out), so the wall-clock of the
  // list path drops from O(n) round-trips to ~1. (A store-level batch is the further win.)
  const resolved = await Promise.all(projects.map((p) => toNotebook(tenantId, p)));
  return resolved.filter((nb): nb is Notebook => nb !== null);
}

/** Delete a notebook: drop its KB collection (sources), then cascade the project
 *  (board + memory + the subject-knowledge binding). Tenant-scoped fail-closed —
 *  a foreign-tenant / non-notebook id is a no-op (`deleted:false`). */
export async function deleteNotebook(tenantId: string, id: string): Promise<{ deleted: boolean }> {
  const p = await getProject(tenantId, id);
  if (!p || p.facet !== 'notebook') return { deleted: false };
  // The bound collection holds this notebook's sources exclusively (created +
  // bound at createNotebook), so deleting it is safe — unlike a shared project
  // binding, which projectsService deliberately leaves intact.
  const binding = await getSubjectKnowledge(tenantId, projectSubject(id));
  const collectionId = binding.collectionIds?.[0];
  if (collectionId) {
    try {
      await deleteCollection(tenantId, p.orgId, collectionId);
    } catch (err) {
      // best-effort: a missing collection must not block the project cascade,
      // but surface it (orphaned vectors are otherwise invisible).
      log.warn('notebook_delete_collection_failed', { id, collectionId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // deleteProject clears the board, memory, and the subject-knowledge binding.
  const res = await deleteProject(tenantId, id);
  // Defensive: ensure the binding is gone even if deleteProject's cascade changes.
  await clearSubjectKnowledge(tenantId, projectSubject(id));
  return { deleted: res.deleted };
}

/** Add a TEXT source to the notebook: ingest into the bound KB collection (chunk
 *  → embed → index via the synchronous local embedder). Returns the doc projection. */
export async function addSource(
  tenantId: string,
  id: string,
  actor: string,
  input: { title?: unknown; text?: unknown; contentBase64?: unknown; contentType?: unknown },
): Promise<NotebookSource> {
  const nb = await mustGet(tenantId, id);
  // REPLAY GUARD (ADR 0108): KB media→text (image/audio) extraction is a live LLM call —
  // replay-UNSAFE. This op is reachable from a RECORDED workflow run (`ctx.features.notebooks`),
  // so it MUST NOT pass media bytes to the synchronous extractor. Documents (PDF/DOCX/text)
  // extract deterministically (replay-safe) and stay allowed; image/audio/video must go
  // through the recorded `notebooks.ingest-audio` transcribe workflow instead.
  const ct = typeof input.contentType === 'string' ? input.contentType.toLowerCase() : '';
  if (typeof input.contentBase64 === 'string' && /^(image|audio|video)\//.test(ct)) {
    throw new OpenwopError('validation_error', 'Image/audio/video sources must be added via the audio-ingest route (transcribed in a recorded run), not as a raw upload.', 415, { contentType: ct });
  }
  // Notebook sources are third-party research material (pasted papers/articles, or
  // an uploaded PDF/DOCX/text file extracted by ingestDocument) that feed the KB
  // Researcher agent's RAG — NOT the user's own trusted instructions. Mark them
  // UNTRUSTED so dispatch fences them (prompt-injection boundary, RFC 0021 / ADR
  // 0038 §C) rather than injecting them agent-trusted.
  const doc = await ingestDocument(tenantId, nb.orgId, actor, nb.collectionId, {
    title: input.title,
    text: input.text,
    ...(typeof input.contentBase64 === 'string' ? { contentBase64: input.contentBase64 } : {}),
    ...(typeof input.contentType === 'string' ? { contentType: input.contentType } : {}),
    contentTrust: 'untrusted',
  });
  // A new source defaults to 'full' — no level row is stored until it's changed.
  return { ...doc, contextLevel: 'full', hasSummary: false };
}

/** List the notebook's sources (KB documents in its collection, newest-first), each
 *  carrying its per-source context level (default 'full' when no level row exists). */
export async function listSources(tenantId: string, id: string): Promise<NotebookSource[]> {
  const nb = await mustGet(tenantId, id);
  const [docs, levels, summaries] = await Promise.all([
    listDocuments(tenantId, nb.orgId, nb.collectionId),
    notebookLevels(tenantId, id),
    notebookSummaries(tenantId, id),
  ]);
  const byId = new Map(levels.map((l) => [l.sourceId, l.level]));
  const summarized = new Set(summaries.map((s) => s.sourceId));
  return docs.map((d) => ({
    ...d,
    contextLevel: byId.get(d.documentId) ?? 'full',
    hasSummary: summarized.has(d.documentId),
  }));
}

/**
 * Recompute + persist the DERIVED context-level projection onto the notebook's
 * subject-knowledge binding (ADR 0084). The level store + summary store are the
 * sources of truth; this writes their projection (`excludeDocumentIds` +
 * `extraContext`) into `retrieval`, PRESERVING `collectionIds` + the rest of
 * `retrieval`. Called after any level OR summary write so the chat + Ask see the
 * same single derived state. Source titles (for the injected summary's label) come
 * from the KB document list.
 */
/**
 * Per-notebook serialization for the binding-projection read-modify-write. The
 * recompute is `getSubjectKnowledge → derive → setSubjectKnowledge`; two concurrent
 * level/summary writes for the SAME notebook could otherwise interleave so a stale
 * derivation overwrites a fresh one (a lost update). We chain recomputes per
 * `(tenant, notebook)` through a tail-promise so they run strictly one-at-a-time
 * (in-process); the level/summary STORES remain the source of truth, so each
 * serialized recompute reads the full current state and converges. Cross-process
 * serialization is out of scope (single-writer per tenant in this host).
 */
const projectionTails = new Map<string, Promise<void>>();

async function recomputeBindingProjection(tenantId: string, nb: Notebook): Promise<void> {
  const key = `${tenantId}:${nb.id}`;
  const prior = projectionTails.get(key) ?? Promise.resolve();
  // Chain THIS recompute after any in-flight one for the same notebook. `prior` is
  // already error-guarded, so a previous failure never poisons the chain.
  const link = prior.then(() => recomputeBindingProjectionUnsynced(tenantId, nb));
  const guarded = link.catch(() => undefined); // the tail other writers chain after
  projectionTails.set(key, guarded);
  try {
    await link; // surface a recompute failure to THIS caller
  } finally {
    // GC the key once this link is the last one to drain (bounds the map).
    if (projectionTails.get(key) === guarded) projectionTails.delete(key);
  }
}

/** The unsynchronized recompute (always called under the per-notebook chain). */
async function recomputeBindingProjectionUnsynced(tenantId: string, nb: Notebook): Promise<void> {
  const docs = await listDocuments(tenantId, nb.orgId, nb.collectionId);
  const titleById = new Map(docs.map((d) => [d.documentId, d.title]));
  const { excludeDocumentIds, extraContext } = await deriveContextProjection(
    tenantId,
    nb.id,
    (sid) => titleById.get(sid),
  );
  const binding = await getSubjectKnowledge(tenantId, projectSubject(nb.id));
  await setSubjectKnowledge(tenantId, projectSubject(nb.id), {
    collectionIds: binding.collectionIds ?? [nb.collectionId],
    retrieval: { ...binding.retrieval, excludeDocumentIds, extraContext },
  });
}

/**
 * Set a source's CONTEXT LEVEL (ADR 0084). The level store is the source of truth;
 * after writing it we RECOMPUTE + persist the DERIVED projection onto the binding's
 * `retrieval` (`excludeDocumentIds` + `extraContext`), preserving `collectionIds` +
 * the rest of `retrieval`. Both the grounded chat (composeKnowledgeForSubject →
 * resolveSubjectKnowledgeRetrieve) and Ask (searchNotebook post-filter) then honor
 * it. Validates the source is a real document in the notebook's collection (unknown
 * sid ⇒ uniform 404).
 *
 * `excluded` drops the source's chunks; `summary` ALSO drops the raw chunks but
 * injects the stored summary as a fenced extraContext item (only when a summary
 * exists — the route gates `summary` on that, and the projection is defensive).
 */
export async function setSourceContextLevel(
  tenantId: string,
  id: string,
  sourceId: string,
  level: SourceContextLevel,
): Promise<NotebookSource> {
  const nb = await mustGet(tenantId, id);
  // sid must be a real document in THIS notebook's collection (no level rows for ghosts).
  const doc = await getDocument(tenantId, nb.orgId, nb.collectionId, sourceId);
  if (!doc) throw new OpenwopError('not_found', 'Source not found.', 404, { id, sourceId });

  // `summary` is selectable ONLY once a summary has been generated for the source
  // (the route enforces this too; the service guards it so the binding projection
  // can never drop a source's chunks without a replacement summary to inject).
  if (level === 'summary' && (await getSourceSummary(tenantId, id, sourceId)) === null) {
    throw new OpenwopError('validation_error', 'Summarize the source first.', 400, { id, sourceId });
  }

  await sourceLevels.put({ tenantId, notebookId: id, sourceId, level });
  await recomputeBindingProjection(tenantId, nb);

  const hasSummary = (await getSourceSummary(tenantId, id, sourceId)) !== null;
  const { text: _text, ...projection } = doc;
  return { ...projection, contextLevel: level, hasSummary };
}

/** Read a source's FULL text (ADR 0084 Transformations T1) — the input the
 *  summarize node feeds the LLM. Returns the durable document text, or null for a
 *  missing source / notebook (tenant + org + collection scoped via getDocument). */
export async function getSourceText(tenantId: string, id: string, sourceId: string): Promise<string | null> {
  const nb = await getNotebook(tenantId, id);
  if (!nb) return null;
  const doc = await getDocument(tenantId, nb.orgId, nb.collectionId, sourceId);
  return doc ? doc.text : null;
}

/** Read a source's stored SUMMARY (ADR 0084 Transformations T1), or null if none
 *  has been generated. Its presence is what un-gates the `summary` context level. */
export async function getSourceSummary(tenantId: string, id: string, sourceId: string): Promise<string | null> {
  const row = await sourceSummaries.get(`${tenantId}:${id}:${sourceId}`);
  return row ? row.summary : null;
}

/**
 * Store a source's LLM SUMMARY (ADR 0084 Transformations T1) — the ONE justified
 * write the summarize node makes through the surface. The summary store un-gates the
 * `summary` context level; after writing it we RECOMPUTE the binding projection so a
 * source already set to `summary` immediately picks up the freshly-generated summary
 * (and `summary`-without-summary stops being treated like `full`). Validates the
 * source is a real document in the notebook's collection (unknown sid ⇒ 404).
 */
export async function setSourceSummary(
  tenantId: string,
  id: string,
  sourceId: string,
  summary: unknown,
): Promise<{ stored: boolean }> {
  const nb = await mustGet(tenantId, id);
  const doc = await getDocument(tenantId, nb.orgId, nb.collectionId, sourceId);
  if (!doc) throw new OpenwopError('not_found', 'Source not found.', 404, { id, sourceId });
  const text = typeof summary === 'string' ? summary.trim() : '';
  if (text.length === 0) {
    throw new OpenwopError('validation_error', 'summary must be a non-empty string.', 400, { id, sourceId });
  }
  await sourceSummaries.put({ tenantId, notebookId: id, sourceId, summary: text, createdAt: new Date().toISOString() });
  await recomputeBindingProjection(tenantId, nb);
  return { stored: true };
}

/** Add a NOTE to the notebook (subject memory in the `project:<id>` scope). */
export async function addNote(tenantId: string, id: string, content: unknown): Promise<SubjectNote[]> {
  await mustGet(tenantId, id);
  await addSubjectNote(tenantId, projectSubject(id), content);
  return listSubjectNotes(tenantId, projectSubject(id));
}

/** List the notebook's notes (subject memory, newest-first). */
export async function listNotes(tenantId: string, id: string): Promise<SubjectNote[]> {
  await mustGet(tenantId, id);
  return listSubjectNotes(tenantId, projectSubject(id));
}

/** Search / ask over the notebook: KB semantic search over the bound collection.
 *  Returns ranked hits + de-duplicated citations — the grounded "ask over the
 *  notebook." Generation is deferred to the chat/agent (the KB Researcher agent),
 *  so this returns retrieval, not an answer. */
export async function searchNotebook(
  tenantId: string,
  id: string,
  query: unknown,
  topK: unknown,
): Promise<{ hits: SearchHit[]; citations: Array<{ documentId: string; title: string }> }> {
  const nb = await mustGet(tenantId, id);
  const rawHits = await search(tenantId, nb.orgId, nb.collectionId, query, topK);
  // ADR 0084: drop hits from excluded sources so Ask honors the same context levels
  // as the grounded chat. Read the DERIVED projection on the binding (a single
  // point-get, maintained on every setSourceContextLevel) rather than re-scanning
  // the level store on the search hot path — same single source of truth the chat
  // filters on, and kbService stays generic (it knows no notebook levels).
  const binding = await getSubjectKnowledge(tenantId, projectSubject(id));
  const excluded = new Set(binding.retrieval?.excludeDocumentIds ?? []);
  const hits = rawHits.filter((h) => !excluded.has(h.documentId));
  const seen = new Set<string>();
  const citations: Array<{ documentId: string; title: string }> = [];
  for (const h of hits) {
    if (h.documentId && !seen.has(h.documentId)) {
      seen.add(h.documentId);
      citations.push({ documentId: h.documentId, title: h.title });
    }
  }
  return { hits, citations };
}

/** A notebook transformation artifact — the projection of a transformation Document
 *  (ADR 0084 Transformations T2). The output is a Document owned by the notebook
 *  subject; this is the read-only list view the FE surfaces. */
export interface NotebookTransformation {
  documentId: string;
  title: string;
  kind: string;
  status: string;
  createdAt: string;
}

/**
 * List a notebook's transformation Documents (ADR 0084 Transformations T2). The
 * outputs are Documents owned by `project:<notebookId>` — queried by `ownerSubject`
 * and filtered to the transformation kinds the catalog produces (a notebook subject
 * may own other Documents too). Read-only: the notebooks surface never writes here;
 * the write lands in Documents via the workflow's write-transformation node.
 */
export async function listTransformations(tenantId: string, id: string): Promise<NotebookTransformation[]> {
  const nb = await mustGet(tenantId, id);
  const docs = await listFeatureDocuments(tenantId, nb.orgId, { ownerSubject: projectSubject(id) });
  return docs
    .filter((d) => NOTEBOOK_TRANSFORMATION_KINDS.has(d.kind))
    .map((d) => ({ documentId: d.documentId, title: d.title, kind: d.kind, status: d.status, createdAt: d.createdAt }));
}

/** Resolve a notebook or throw the uniform 404 (the existence-leak guard). */
async function mustGet(tenantId: string, id: string): Promise<Notebook> {
  const nb = await getNotebook(tenantId, id);
  if (!nb) throw new OpenwopError('not_found', 'Notebook not found.', 404, { id });
  return nb;
}

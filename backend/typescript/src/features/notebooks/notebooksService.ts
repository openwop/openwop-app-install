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
import { PREAUTHORIZED_CALLER } from '../../host/subjectAccess.js'; // KBC-1 (ADR 0643 D2 precondition) — an in-process lane that owns these rows / gates at its own door
import type { KbEmitOptions } from '../kb/emit.js'; // ADR 0643 D3
import { createLogger } from '../../observability/logger.js';
import {
  createProject, getProject, listProjects, deleteProject, projectSubject, setNotebookCollectionId,
  notebookCorpusToDelete, resolveProjectAccess, listVisibleProjects, type Project,
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
  /** ADR 1103 D4 — the source revision the summary was written from. A summary of a
   *  revision that is no longer current is refused at write (`source_changed`). Absent
   *  on rows written before ADR 1103 (none exist in prod). */
  revision?: number;
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
  /** ADR 1103 D7 — the sources that exist NOW, with their current revision. A level
   *  or summary row for any other source is a ghost (its document was deleted) and
   *  contributes nothing; a summary written from a revision that is no longer current
   *  is stale and contributes nothing (D4 — it would describe text that no longer
   *  exists). So a missed lifecycle event, or a revision landing between a summary's
   *  check and its write, can never keep wrong text in the model's context. */
  liveRevisions: ReadonlyMap<string, number>,
): Promise<{ excludeDocumentIds: string[]; extraContext: Array<{ title?: string; content: string; contentTrust: 'untrusted' }> }> {
  const [levels, summaries] = await Promise.all([
    notebookLevels(tenantId, notebookId),
    notebookSummaries(tenantId, notebookId),
  ]);
  const summaryById = new Map(summaries
    .filter((s) => summaryIsCurrent(s, liveRevisions.get(s.sourceId)))
    .map((s) => [s.sourceId, s.summary]));
  const excludeDocumentIds: string[] = [];
  const extraContext: Array<{ title?: string; content: string; contentTrust: 'untrusted' }> = [];
  for (const r of levels) {
    if (!liveRevisions.has(r.sourceId)) continue; // ADR 1103 D7 — a ghost row
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
  // R3 — prefer the SURFACE-PROVISIONED collection stamped on the row; the binding
  // list's position 0 is bind-order, not ownership (the Knowledge tab can put a
  // SHARED collection there). Legacy rows without the stamp keep the old read.
  const collectionId = p.notebookCollectionId ?? binding.collectionIds?.[0];
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

/** The Notebook Research Analyst manifest agent (ADR 0084 Phase 4), seated in a
 *  notebook's group chat. One constant for the notebook door, the chat tools and the
 *  projects door's reconcile (ADR 1103 D9). */
export const NOTEBOOK_RESEARCHER_AGENT_ID = 'vendor.openwop-app.notebooks.agents.researcher';

/** ADR 1103 D9 — is this project a notebook (has a bound corpus)? The projects chat
 *  door asks, so its reconcile stops unseating the researcher the notebook door seats
 *  in the SAME room. */
export async function isNotebookProject(tenantId: string, project: Project): Promise<boolean> {
  return (await toNotebook(tenantId, project)) !== null;
}

/** ADR 1103 D1 — a resolved notebook plus the caller's access to it. */
export interface NotebookAccess {
  notebook: Notebook;
  project: Project;
  level: 'read' | 'write';
}

/**
 * ADR 1103 D1 — THE notebook access rule. The HTTP door (`requireNotebook`), the
 * three chat tools and the run surface all call this, so the three lanes cannot
 * give three answers (the surface used to answer "org-visible ⇒ yes" for anyone).
 * `null` = no such notebook, or the subject cannot read it — callers turn that into
 * their own uniform not-found. `level` is the project rule (`resolveProjectAccess`,
 * ADR 0054 D5) unchanged: write ⟺ `workspace:write` in the project's org.
 */
export async function notebookAccess(tenantId: string, id: string, subject: string | undefined): Promise<NotebookAccess | null> {
  const project = await getProject(tenantId, id);
  if (!project) return null;
  const notebook = await toNotebook(tenantId, project);
  if (!notebook) return null;
  const level = await resolveProjectAccess(tenantId, id, subject);
  if (level === 'none') return null;
  return { notebook, project, level };
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
  const project = await createProject(tenantId, orgId, { name: input.name, facet: 'notebook' }, actor); // ADR 0839 D5
  // NB-5 — the create is multi-step (project → collection → binding); a failure AFTER the
  // project exists would otherwise leave an orphaned `facet:'notebook'` project that is
  // invisible (toNotebook ⇒ null, 404 on get, filtered from the list) yet still counts
  // against the workspace cap. Roll the partial provision back so the create is atomic.
  let collectionId: string | undefined;
  try {
    // H1 — stamp the corpus with the project subject at birth. Without it, the KB
    // guard (`assertCollectionSubjectReadable`) early-returns on the unstamped
    // collection and org scope becomes the whole rule → a private project's Sources
    // leak to any non-member org reader. Mirrors `projectKnowledgeService:152`.
    const collection = await createCollection(tenantId, orgId, actor, {
      name: `Notebook: ${project.name}`,
      description: `Sources for the “${project.name}” research notebook.`,
    }, { boundSubject: projectSubject(project.id) });
    collectionId = collection.collectionId;
    await setSubjectKnowledge(tenantId, projectSubject(project.id), { collectionIds: [collectionId] });
    await setNotebookCollectionId(tenantId, project.id, collectionId);
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
    if (collectionId) await deleteCollection(tenantId, orgId, collectionId, PREAUTHORIZED_CALLER).catch(() => undefined); // KBC-1
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
  // H1 — stamp the corpus with the project subject at birth (see createNotebook).
  const collection = await createCollection(tenantId, project.orgId, actor, {
    name: `Sources: ${project.name}`,
    description: `Research sources for the “${project.name}” project.`,
  }, { boundSubject: projectSubject(project.id) });
  const binding = await getSubjectKnowledge(tenantId, projectSubject(project.id));
  await setSubjectKnowledge(tenantId, projectSubject(project.id), {
    // Append the new collection; preserve any existing collections + retrieval projection.
    collectionIds: [...(binding.collectionIds ?? []), collection.collectionId],
    ...(binding.retrieval ? { retrieval: binding.retrieval } : {}),
  });
  await setNotebookCollectionId(tenantId, project.id, collection.collectionId);
  // Re-read: the stamp changed the row, and toNotebook prefers it.
  const stamped = await getProject(tenantId, id);
  const notebook = await toNotebook(tenantId, stamped ?? project);
  if (!notebook) throw new OpenwopError('internal_error', 'Sources provisioning failed.', 500, { id });
  return notebook;
}

/** ADR 1103 D2 — the notebooks `subject` can read, through the ONE list-visible scan
 *  the projects list uses (`listVisibleProjects`: access resolved once per org, not
 *  once per notebook — the PRJC-3 class). */
export async function listNotebooksVisibleTo(
  tenantId: string,
  subject: string | undefined,
  /** The cause lane (ADR 0832): a causing member narrows an actorless run, so only
   *  org-visible notebooks — never a private one they happen to be a member of. */
  opts: { orgVisibleOnly?: boolean } = {},
): Promise<Notebook[]> {
  const visible = (await listVisibleProjects(tenantId, subject))
    .filter(({ project }) => !opts.orgVisibleOnly || (project.visibility ?? 'org') === 'org');
  const resolved = await Promise.all(visible.map(({ project }) => toNotebook(tenantId, project)));
  return resolved.filter((nb): nb is Notebook => nb !== null);
}

/** ADR 1103 D2 — the system-run lane's list: notebooks whose project is org-visible,
 *  filtered on the rows already in hand (no per-notebook re-read). */
export async function listOrgVisibleNotebooks(tenantId: string): Promise<Notebook[]> {
  const projects = (await listProjects(tenantId)).filter((p) => (p.visibility ?? 'org') === 'org');
  const resolved = await Promise.all(projects.map((p) => toNotebook(tenantId, p)));
  return resolved.filter((nb): nb is Notebook => nb !== null);
}

/** Delete a notebook: drop its KB collection (sources), then cascade the project
 *  (board + memory + the subject-knowledge binding). Tenant-scoped fail-closed —
 *  a foreign-tenant / non-notebook id is a no-op (`deleted:false`). */
/**
 * Delete a notebook: its exclusive KB collection, then the project cascade.
 *
 * Returns `deleteProject`'s real counts rather than just `{deleted}` — the
 * projects DELETE route surfaces them, and narrowing them here forced that
 * route to substitute ZEROS for cleanup that had actually happened (R2
 * PRJ2-M1). "0 memory entries cleared" for a delete that cleared twelve is the
 * same failure-rendered-as-an-answer shape this round exists to close.
 */
export async function deleteNotebook(tenantId: string, id: string): Promise<{ deleted: boolean; memoryEntriesCleared: number; schedulesCleared: number; collectionDeleted: boolean; dependentsDeleted: Record<string, number> }> {
  const p = await getProject(tenantId, id);
  // ADR 0601 / NBC-1 — the `p.facet !== 'notebook'` half of this guard is GONE.
  // The ADR 0084 correction redefined a notebook as ANY project with a bound KB
  // collection and dropped the facet check from `getNotebook`; this door kept it,
  // and `ensureNotebookForProject` never stamps `facet`. So every project
  // provisioned by opening the Sources tab was a first-class notebook to reads and
  // a silent NO-OP to deletes — while the route had already cascaded its entire
  // group conversation. Two doors, two different answers to "is this a notebook".
  //
  // Dropping it (rather than 404-ing at the route) is what makes the doors AGREE:
  // a 404 here would just move the disagreement, leaving `GET /notebooks/:id` → 200
  // beside `DELETE /notebooks/:id` → 404. The authority is unchanged — both delete
  // doors already require `workspace:write` on this very project, exactly as
  // `DELETE /projects/:id` does.
  //
  // What narrows the blast radius is `notebookCorpusToDelete` below.
  //
  // CORRECTED (ADR 0601 § Corrections / HIGH-1): this comment used to say that
  // guard "is about OWNERSHIP of the corpus", and it was FALSE. The guard's last
  // resort was `col.name.startsWith('Notebook: ' | 'Sources: ')` — a prefix test
  // on a name the USER chooses and can edit. Widening the delete's population
  // (dropping the facet check) widened the ERASER's population in the same
  // stroke, from "projects created via POST /notebooks" to "every project with
  // any bound KB collection" — including Knowledge-tab bindings that ADR 0084
  // says may be SHARED. A shared collection named `Sources: Q3 research` was
  // deleted out from under every other project bound to it. PROVED: shared
  // collection 200 → 404, a second project's knowledge list → [].
  if (!p) return { deleted: false, memoryEntriesCleared: 0, schedulesCleared: 0, collectionDeleted: false, dependentsDeleted: {} };
  // The one predicate the consent dialog also reads (`deletesCorpus` on the
  // project projection). Stamp-only: no name guess, no position-0 guess. A
  // legacy notebook whose corpus predates the stamp keeps its collection —
  // an orphan, which is recoverable; a destroyed shared corpus is not.
  const collectionId = notebookCorpusToDelete(p);
  // ADR 0839 grade-code — the PROJECT first, the corpus second. `deleteProject` asserts the
  // retention hold and can now throw from a dependent purge; deleting the corpus before it
  // destroyed every source of a notebook that then survived (under a hold, despite the
  // hold). `deleteProject` already releases the collection's project stamp and clears the
  // binding, so the collection is safe to delete afterwards.
  const res = await deleteProject(tenantId, id);
  // Defensive: ensure the binding is gone even if deleteProject's cascade changes.
  await clearSubjectKnowledge(tenantId, projectSubject(id));
  let collectionDeleted = false;
  if (collectionId && res.deleted) {
    try {
      await deleteCollection(tenantId, p.orgId, collectionId, PREAUTHORIZED_CALLER); // KBC-1
      collectionDeleted = true;
    } catch (err) {
      // best-effort: a missing collection must not fail a delete that already landed,
      // but surface it (orphaned vectors are otherwise invisible).
      log.warn('notebook_delete_collection_failed', { id, collectionId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { deleted: res.deleted, memoryEntriesCleared: res.memoryEntriesCleared, schedulesCleared: res.schedulesCleared, collectionDeleted, dependentsDeleted: res.dependentsDeleted };
}

/** Add a TEXT source to the notebook: ingest into the bound KB collection (chunk
 *  → embed → index via the synchronous local embedder). Returns the doc projection. */
export async function addSource(
  tenantId: string,
  id: string,
  actor: string,
  input: { title?: unknown; text?: unknown; contentBase64?: unknown; contentType?: unknown },
  /** ADR 0643 D3 — the workflow surface passes the run's `origin`. A notebook source
   *  is ONE user-driven document (there is no bulk source lane in this service), so it
   *  emits `document.ingested` like the KB route does. */
  emit: KbEmitOptions = {},
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
  }, { contentTrust: 'untrusted', ...emit }, PREAUTHORIZED_CALLER); // KBC-1
  // A new source defaults to 'full' — no level row is stored until it's changed.
  return { ...doc, contextLevel: 'full', hasSummary: false };
}

/** List the notebook's sources (KB documents in its collection, newest-first), each
 *  carrying its per-source context level (default 'full' when no level row exists). */
export async function listSources(tenantId: string, id: string): Promise<NotebookSource[]> {
  const nb = await mustGet(tenantId, id);
  const [docs, levels, summaries] = await Promise.all([
    listDocuments(tenantId, nb.orgId, nb.collectionId, PREAUTHORIZED_CALLER), // KBC-1 — `requireNotebook`/the surface's org-visibility gate is this lane's door
    notebookLevels(tenantId, id),
    notebookSummaries(tenantId, id),
  ]);
  const byId = new Map(levels.map((l) => [l.sourceId, l.level]));
  // ADR 1103 D4 — a summary of a revision that is no longer current is not a summary
  // of this source: the projection already ignores it, so `hasSummary` must too.
  const revisionOf = new Map(docs.map((d) => [d.documentId, d.revision ?? 1]));
  const summarized = new Set(summaries.filter((s) => summaryIsCurrent(s, revisionOf.get(s.sourceId))).map((s) => s.sourceId));
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
  // ADR 1103 D7 — the corpus itself can be gone (deleted at the KB door: the collection
  // row goes before the per-document events fire). Then no source is live, and the
  // projection must still be rewritten to drop every summary, not abandoned on the
  // `not_found` the read throws.
  const docs = await listDocuments(tenantId, nb.orgId, nb.collectionId, PREAUTHORIZED_CALLER) // KBC-1
    .catch((err: unknown) => {
      if (err instanceof OpenwopError && err.code === 'not_found') return [];
      throw err;
    });
  const titleById = new Map(docs.map((d) => [d.documentId, d.title]));
  const { excludeDocumentIds, extraContext } = await deriveContextProjection(
    tenantId,
    nb.id,
    (sid) => titleById.get(sid),
    new Map(docs.map((d) => [d.documentId, d.revision ?? 1])),
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
  const doc = await getDocument(tenantId, nb.orgId, nb.collectionId, sourceId, PREAUTHORIZED_CALLER); // KBC-1
  if (!doc) throw new OpenwopError('not_found', 'Source not found.', 404, { id, sourceId });

  // `summary` is selectable ONLY once a summary of the source's CURRENT revision
  // exists (ADR 1103 D4). This is the one check (the route relies on it), so the
  // binding projection can never drop a source's chunks without a replacement summary.
  const hasSummary = (await currentSummaryOf(tenantId, id, sourceId, doc.revision ?? 1)) !== null;
  if (level === 'summary' && !hasSummary) {
    throw new OpenwopError('validation_error', 'Summarize the source first.', 400, { id, sourceId });
  }

  await sourceLevels.put({ tenantId, notebookId: id, sourceId, level });
  await recomputeBindingProjection(tenantId, nb);

  const { text: _text, ...projection } = doc;
  return { ...projection, contextLevel: level, hasSummary };
}

/** Read a source's FULL text (ADR 0084 Transformations T1) — the input the
 *  summarize node feeds the LLM — with the revision it was read at (ADR 1103 D4: the
 *  summary write is refused if the source changed since). Null for a missing source /
 *  notebook (tenant + org + collection scoped via getDocument). */
export async function getSourceText(tenantId: string, id: string, sourceId: string): Promise<{ text: string; revision: number } | null> {
  const nb = await getNotebook(tenantId, id);
  if (!nb) return null;
  const doc = await getDocument(tenantId, nb.orgId, nb.collectionId, sourceId, PREAUTHORIZED_CALLER); // KBC-1
  return doc ? { text: doc.text, revision: doc.revision ?? 1 } : null;
}

/** Read a source's stored SUMMARY (ADR 0084 Transformations T1), or null if none
 *  has been generated. Its presence is what un-gates the `summary` context level. */
export async function getSourceSummary(tenantId: string, id: string, sourceId: string): Promise<string | null> {
  const nb = await getNotebook(tenantId, id);
  const doc = nb ? await getDocument(tenantId, nb.orgId, nb.collectionId, sourceId, PREAUTHORIZED_CALLER) : null; // KBC-1
  return currentSummaryOf(tenantId, id, sourceId, doc ? (doc.revision ?? 1) : undefined);
}

/** ADR 1103 D4 — the stored summary IF it is about the given current revision (it
 *  un-gates the `summary` level, which must never inject text about content that has
 *  changed, or about a source that is gone). For callers that already hold the doc. */
async function currentSummaryOf(tenantId: string, id: string, sourceId: string, currentRevision: number | undefined): Promise<string | null> {
  const row = await sourceSummaries.get(`${tenantId}:${id}:${sourceId}`);
  return row && summaryIsCurrent(row, currentRevision) ? row.summary : null;
}

/** ADR 1103 D4 — is this stored summary about the source's current revision? A row
 *  written before ADR 1103 carries no revision and is taken as current (none exist in
 *  prod); a source that is gone has no current revision. */
function summaryIsCurrent(row: { revision?: number }, currentRevision: number | undefined): boolean {
  if (currentRevision === undefined) return false;
  return row.revision === undefined || row.revision === currentRevision;
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
  /** ADR 1103 D4 — the revision the summarized text was read at. When given and the
   *  source has moved on, the write is refused: the summary describes text that no
   *  longer exists. */
  opts: { revision?: number } = {},
): Promise<{ stored: boolean }> {
  const nb = await mustGet(tenantId, id);
  const doc = await getDocument(tenantId, nb.orgId, nb.collectionId, sourceId, PREAUTHORIZED_CALLER); // KBC-1
  if (!doc) throw new OpenwopError('not_found', 'Source not found.', 404, { id, sourceId });
  const text = typeof summary === 'string' ? summary.trim() : '';
  if (text.length === 0) {
    throw new OpenwopError('validation_error', 'summary must be a non-empty string.', 400, { id, sourceId });
  }
  const current = doc.revision ?? 1;
  if (opts.revision !== undefined && opts.revision !== current) {
    throw new OpenwopError('conflict', 'The source changed after it was read; summarize it again.', 409, { id, sourceId, reason: 'source_changed' });
  }
  await sourceSummaries.put({ tenantId, notebookId: id, sourceId, summary: text, createdAt: new Date().toISOString(), revision: current });
  await recomputeBindingProjection(tenantId, nb);
  return { stored: true };
}

/**
 * ADR 0601 — where a notebook note's TEXT came from. This is the prompt-injection
 * boundary the source lane already draws (`addSource` ingests every source
 * `contentTrust:'untrusted'`, see :349), carried through to notes.
 *
 *   - `'authored'`    — a human composed this text in the note composer. Their own
 *                       words, their own instructions ⇒ agent-TRUSTED.
 *   - `'third-party'` — the text was COPIED out of research material or handed in
 *                       by an external client: a retrieved KB passage the user
 *                       clicked "save to notes" beside, or MCP `params.arguments`
 *                       (ADR 0087 §73 declares inbound MCP content untrusted).
 *                       The ACT may be a human's; the WORDS are not ⇒ UNTRUSTED.
 */
export type NoteContentOrigin = 'authored' | 'third-party';

/**
 * ADR 0601 — THE RULE, written once. Exhaustive by construction
 * (`Record<NoteContentOrigin, …>`), so a new origin cannot be added without the
 * compiler demanding its trust. This is what replaces the omission that shipped:
 * `addNote` used to call `addSubjectNote` with NO options, which defaulted to
 * `source:'user'` ⇒ no `MEMORY_UNTRUSTED_TAG` ⇒ recalled UNFENCED into a
 * tool-enabled agent's prompt.
 */
const ORIGIN_TRUST: Record<NoteContentOrigin, 'trusted' | 'untrusted'> = {
  authored: 'trusted',
  'third-party': 'untrusted',
};

/**
 * Add a NOTE to the notebook (subject memory in the `project:<id>` scope).
 *
 * `origin` is REQUIRED and has NO default — deliberately. Every caller of this
 * function is a lane that knows whether a human composed the text, and the defect
 * this closes was precisely a caller that said nothing and got `trusted` for free.
 * A required argument makes the omission a COMPILE error rather than a silent
 * trust upgrade, for the two callers that exist today and for every future one.
 */
export async function addNote(
  tenantId: string,
  id: string,
  content: unknown,
  origin: NoteContentOrigin,
): Promise<SubjectNote[]> {
  await mustGet(tenantId, id);
  await addSubjectNote(tenantId, projectSubject(id), content, { contentTrust: ORIGIN_TRUST[origin] });
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
  const rawHits = await search(tenantId, nb.orgId, nb.collectionId, query, topK, 'dense', PREAUTHORIZED_CALLER); // KBC-1
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

/**
 * ADR 1103 D8 — the notebook's derived per-source state (levels + summaries) as a
 * project dependent: `deleteProject` purges it on BOTH delete doors, before the row
 * goes, and reports the count in `dependentsDeleted`. Before this, a deleted
 * notebook's summaries (LLM text derived from deleted sources) outlived it with no
 * owner and no reader.
 */
export async function countNotebookSourceState(tenantId: string, notebookId: string): Promise<number> {
  const [levels, summaries] = await Promise.all([notebookLevels(tenantId, notebookId), notebookSummaries(tenantId, notebookId)]);
  return levels.length + summaries.length;
}

export async function purgeNotebookSourceState(tenantId: string, notebookId: string): Promise<number> {
  let n = 0;
  for (const r of await notebookLevels(tenantId, notebookId)) if (await sourceLevels.delete(`${tenantId}:${notebookId}:${r.sourceId}`)) n += 1;
  for (const r of await notebookSummaries(tenantId, notebookId)) if (await sourceSummaries.delete(`${tenantId}:${notebookId}:${r.sourceId}`)) n += 1;
  return n;
}

/**
 * ADR 1103 D7 — a source's derived state follows the source. Called from the KB
 * lifecycle seam (`onKnowledgeDocumentChanged`, registered in feature.ts):
 *   - deleted  → drop the source's level + summary rows;
 *   - revised  → drop its summary (it describes text that no longer exists) and put
 *                a `summary` level back to `full`;
 * then recompute the binding projection so the chat stops injecting it.
 *
 * Found from the ROWS, not from the collection: the only thing this has to clean is a
 * level or summary row for this document, and those rows name their notebook. So the
 * check is two tenant-prefix reads of the notebook stores (small: one row per
 * summarized or re-levelled source), and a KB event for a document with no such row —
 * every ordinary KB collection — costs nothing more. No collection read (on the
 * collection-delete lane the row is already gone), no project scan, and legacy
 * corpora (unstamped collection, or a project that predates the stamp) are followed
 * like any other. A row whose notebook no longer exists or whose corpus is not this
 * collection is left alone (the notebook-delete path purges through D8; a second
 * corpus bound to the same project is not the notebook's).
 */
export async function onNotebookSourceChanged(e: { tenantId: string; collectionId: string; documentId: string; deleted?: boolean }): Promise<void> {
  const [levels, summaries] = await Promise.all([
    sourceLevels.listByPrefix(`${e.tenantId}:`),
    sourceSummaries.listByPrefix(`${e.tenantId}:`),
  ]);
  const notebookIds = new Set([...levels, ...summaries].filter((r) => r.sourceId === e.documentId).map((r) => r.notebookId));
  for (const notebookId of notebookIds) {
    const nb = await getNotebook(e.tenantId, notebookId);
    if (!nb || nb.collectionId !== e.collectionId) continue;
    const key = `${e.tenantId}:${nb.id}:${e.documentId}`;
    let changed = await sourceSummaries.delete(key);
    if (e.deleted) {
      changed = (await sourceLevels.delete(key)) || changed;
    } else {
      const level = await sourceLevels.get(key);
      if (level?.level === 'summary') {
        await sourceLevels.put({ ...level, level: 'full' });
        changed = true;
      }
    }
    if (changed) await recomputeBindingProjection(e.tenantId, nb);
  }
}

/** Resolve a notebook or throw the uniform 404 (the existence-leak guard). */
async function mustGet(tenantId: string, id: string): Promise<Notebook> {
  const nb = await getNotebook(tenantId, id);
  if (!nb) throw new OpenwopError('not_found', 'Notebook not found.', 404, { id });
  return nb;
}

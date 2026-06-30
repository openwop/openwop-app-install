/**
 * Research Notebooks workflow surface (ADR 0084 Phase 2 / ADR 0014) — the typed
 * `ctx.features.notebooks` a workflow node calls. Tenant comes from the run scope
 * (CTI-1); toggle-gated at the registry seam (featureSurfaces.gate). Mostly
 * READ-ONLY: a notebook's authoring (create / add source / set context level /
 * add note) stays a human/route act. The ONE exception is `setSourceSummary` (ADR
 * 0084 Transformations T1) — the justified write the `notebooks.summarize` built-in
 * workflow's store-summary node makes to persist an LLM summary; it rides the same
 * org-visibility gate as every read.
 *
 * RBAC: a run is TENANT-TRUSTED (a `BundleScope` carries no caller subject — the
 * strategy `ctx.features.strategy` precedent). A subjectless run cannot resolve
 * per-member project access, so the surface serves ORG-VISIBLE notebooks only: a
 * notebook whose backing project is `visibility:'private'` (member-scoped, ADR
 * 0054 D5) is INVISIBLE here, exactly as strategy's surface hides a user-scoped
 * private draft. `getNotebook` already enforces tenant + `facet:'notebook'`
 * (cross-tenant ⇒ null); this surface adds the visibility filter on top.
 *
 * No new logic: every method COMPOSES the existing `notebooksService` functions
 * (getNotebook / listSources / getDocument-via-getSource / listNotes /
 * searchNotebook) behind the org-visibility gate.
 *
 * @see docs/adr/0084-research-notebooks.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { type FeatureSurface, surfaceStr, surfaceOptStr } from '../../host/featureSurfaces.js';
import { getProject, projectSubject } from '../projects/projectsService.js';
import { composeKnowledgeForSubject } from '../../host/agentKnowledgeComposition.js';
import {
  getNotebook,
  listNotebooks as listNotebooksService,
  listSources,
  listNotes,
  searchNotebook,
  getSourceText,
  setSourceSummary,
  addSource,
  addNote,
  type Notebook,
  type NotebookSource,
} from './notebooksService.js';

/**
 * Resolve a notebook for a SUBJECTLESS run: tenant + facet-guarded (via
 * `getNotebook`) AND org-visible (the strategy `isShared` precedent). Returns the
 * notebook ONLY if its backing project is `facet:'notebook'` and
 * `(visibility ?? 'org') === 'org'`; otherwise null (a private / member-scoped
 * notebook can't be authorized for a run with no caller subject — fail-closed).
 */
async function resolveOrgVisibleNotebook(tenantId: string, notebookId: string): Promise<Notebook | null> {
  const nb = await getNotebook(tenantId, notebookId);
  if (!nb) return null;
  // getNotebook confirmed tenant + a bound collection (ADR 0084 correction — any
  // project with sources is a notebook); load the project to check read-visibility
  // (the field the notebook projection doesn't carry).
  const project = await getProject(tenantId, notebookId);
  if (!project) return null;
  if ((project.visibility ?? 'org') !== 'org') return null;
  return nb;
}

export function buildNotebooksSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    /** All ORG-VISIBLE notebooks in the run's tenant (ADR 0087 — backs the
     *  `notebook-list` MCP tool). Private / member-scoped notebooks are filtered
     *  out (a subjectless run can't authorize a member-scoped read — fail-closed),
     *  exactly like every other method here. */
    listNotebooks: async () => {
      const all = await listNotebooksService(tenantId);
      const visible = await Promise.all(all.map((nb) => resolveOrgVisibleNotebook(tenantId, nb.id)));
      return { notebooks: visible.filter((nb): nb is Notebook => nb !== null) };
    },

    /** One ORG-VISIBLE notebook by id (ADR 0087 — backs `notebook-get`). Null for a
     *  missing / private / non-org-visible / cross-tenant notebook. */
    getNotebook: async (args) => {
      const nb = await resolveOrgVisibleNotebook(tenantId, surfaceStr(args.notebookId));
      return { notebook: nb };
    },

    /** The notebook's sources (KB document projections, each with its per-source
     *  contextLevel). Empty for a missing / private / non-org-visible notebook. */
    listSources: async (args) => {
      const nb = await resolveOrgVisibleNotebook(tenantId, surfaceStr(args.notebookId));
      if (!nb) return { sources: [] };
      const sources = await listSources(tenantId, nb.id);
      return { sources };
    },

    /** One source by id within a notebook. Returns null for a missing source, OR
     *  a missing / private / non-org-visible notebook (subjectless run can't
     *  authorize a member-scoped read). */
    getSource: async (args) => {
      const nb = await resolveOrgVisibleNotebook(tenantId, surfaceStr(args.notebookId));
      if (!nb) return { source: null };
      const sourceId = surfaceStr(args.sourceId);
      const source = (await listSources(tenantId, nb.id)).find((s) => s.documentId === sourceId) ?? null;
      return { source };
    },

    /**
     * The FULL text of one source (ADR 0084 Transformations T1) — the input the
     * summarize built-in workflow's read-source node feeds the LLM. READ-ONLY.
     * Returns `{ text: '' }` for a missing source / missing / private / non-org-
     * visible notebook (fail-closed: a subjectless run can't authorize a member-
     * scoped read). The summarize node treats empty text as a no-op.
     */
    getSourceText: async (args) => {
      const nb = await resolveOrgVisibleNotebook(tenantId, surfaceStr(args.notebookId));
      if (!nb) return { text: '' };
      const text = await getSourceText(tenantId, nb.id, surfaceStr(args.sourceId));
      return { text: text ?? '' };
    },

    /**
     * Store a source's LLM SUMMARY (ADR 0084 Transformations T1) — the ONE narrow
     * WRITE this surface exposes, used only by the `notebooks.summarize` built-in
     * workflow's store-summary node (architect-approved). Goes through the same
     * org-visibility gate as every other method (a subjectless run can't write a
     * member-scoped notebook). No-op (`{ stored: false }`) for a missing / private /
     * non-org-visible notebook or an empty summary; otherwise persists + recomputes
     * the binding projection so a `summary`-level source picks up the new summary.
     */
    setSourceSummary: async (args) => {
      const nb = await resolveOrgVisibleNotebook(tenantId, surfaceStr(args.notebookId));
      if (!nb) return { stored: false };
      const summary = surfaceStr(args.summary);
      if (summary.length === 0) return { stored: false };
      const sourceId = surfaceStr(args.sourceId);
      // getSourceText already proved the source exists for visible notebooks; let
      // setSourceSummary validate sid (uniform 404 on a ghost) + persist.
      const res = await setSourceSummary(tenantId, nb.id, sourceId, summary);
      return res;
    },

    /**
     * Ingest a transcript as a notebook KB source (ADR 0084 deferred / ADR 0085
     * Phase 5) — the narrow WRITE the `ingest-source` node makes to land an
     * audio/video/YouTube transcript as an ordinary (untrusted) source. Goes
     * through the same org-visibility gate as every method (a subjectless run
     * can't write a member-scoped notebook). No-op (`{ ingested:false }`) for a
     * missing / private / non-org-visible notebook or empty text. Downstream the
     * transcript IS a KB document — context levels, search, citations all apply.
     *
     * Reuses `addSource` (which marks the source `contentTrust:'untrusted'`,
     * fenced at dispatch — the prompt-injection boundary). The run is the actor.
     */
    ingestSource: async (args) => {
      const nb = await resolveOrgVisibleNotebook(tenantId, surfaceStr(args.notebookId));
      if (!nb) return { ingested: false };
      const text = surfaceStr(args.text);
      if (text.trim().length === 0) return { ingested: false };
      const title = surfaceStr(args.title) || 'Transcribed source';
      const source = await addSource(tenantId, nb.id, 'workflow-run', { title, text });
      return { ingested: true, sourceId: source.documentId, title: source.title };
    },

    /**
     * Add a NOTE to the notebook (ADR 0087 write tool `notebook-create-note`) —
     * subject memory in the `project:<id>` scope. Org-visibility gated like every
     * method (a subjectless run can't write a member-scoped notebook). No-op
     * (`{ created:false }`) for a missing / private / non-org-visible notebook or
     * empty content. Reached only through the HITL-approved MCP write workflow.
     */
    addNote: async (args) => {
      const nb = await resolveOrgVisibleNotebook(tenantId, surfaceStr(args.notebookId));
      if (!nb) return { created: false };
      const content = surfaceStr(args.content);
      if (content.trim().length === 0) return { created: false };
      await addNote(tenantId, nb.id, content);
      return { created: true };
    },

    /** The notebook's notes (subject memory, newest-first). Empty for a missing /
     *  private / non-org-visible notebook. */
    listNotes: async (args) => {
      const nb = await resolveOrgVisibleNotebook(tenantId, surfaceStr(args.notebookId));
      if (!nb) return { notes: [] };
      const notes = await listNotes(tenantId, nb.id);
      return { notes };
    },

    /** Grounded search / ask over the notebook's bound KB collection — ranked
     *  hits + de-duplicated citations (excluded sources already dropped by the
     *  service). Empty for a missing / private / non-org-visible notebook. */
    searchNotebook: async (args) => {
      const nb = await resolveOrgVisibleNotebook(tenantId, surfaceStr(args.notebookId));
      if (!nb) return { hits: [], citations: [] };
      const { hits, citations } = await searchNotebook(tenantId, nb.id, surfaceStr(args.query), surfaceOptStr(args.topK));
      return { hits, citations };
    },

    /**
     * Grounded ASK over the notebook (ADR 0084 Phase 3) — the `feature.kb.nodes`
     * `rag` precedent: retrieve + format, generation DEFERRED downstream. Returns
     * the FENCED, context-level-filtered knowledge block (`augmentedPrompt`) plus
     * de-duplicated `citations` + raw `contexts` for a downstream callPrompt/agent.
     *
     * Fencing + Full/Excluded context-level filtering are INHERITED FROM THE HOST,
     * not reimplemented here: `augmentedPrompt` comes from the Phase-2 host helper
     * `composeKnowledgeForSubject`, which composes the same trusted-cite /
     * untrusted-fence treatment as live dispatch AND applies the binding's
     * `excludeDocumentIds` (the per-source 'excluded' level). `contexts`/`citations`
     * come from `searchNotebook`, which the service has already excluded-filtered.
     *
     * READ-ONLY: composes existing host/service helpers; never writes. Empty for a
     * missing / private / non-org-visible notebook (fail-closed, subjectless run).
     */
    ask: async (args) => {
      const nb = await resolveOrgVisibleNotebook(tenantId, surfaceStr(args.notebookId));
      if (!nb) return { augmentedPrompt: '', citations: [], contexts: [] };
      const query = surfaceStr(args.query);
      const topK = typeof args.topK === 'number' && args.topK > 0 ? Math.floor(args.topK) : undefined;
      const augmentedPrompt = await composeKnowledgeForSubject(
        tenantId,
        projectSubject(nb.id),
        query,
        topK !== undefined ? { topK } : undefined,
      );
      const { hits, citations } = await searchNotebook(tenantId, nb.id, query, topK);
      return { augmentedPrompt, citations, contexts: hits };
    },

    /** Per-source CONTEXT LEVELS (ADR 0084) for the notebook — each source's
     *  documentId + title + contextLevel. Reuses listSources (which already
     *  surfaces contextLevel); no new service logic. Empty for a missing /
     *  private / non-org-visible notebook. */
    getContextLevels: async (args) => {
      const nb = await resolveOrgVisibleNotebook(tenantId, surfaceStr(args.notebookId));
      if (!nb) return { levels: [] };
      const sources = await listSources(tenantId, nb.id);
      const levels = sources.map((s: NotebookSource) => ({
        sourceId: s.documentId,
        title: s.title,
        contextLevel: s.contextLevel,
      }));
      return { levels };
    },
  };
}

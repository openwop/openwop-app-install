/**
 * Research Notebooks workflow surface (ADR 0084 Phase 2 / ADR 0014) — the typed
 * `ctx.features.notebooks` a workflow node calls. Tenant comes from the run scope
 * (CTI-1); toggle-gated at the registry seam (featureSurfaces.gate). Mostly
 * READ-ONLY: authoring stays a human/route act. The writes are the narrow ones the
 * notebook chains make — `setSourceSummary` (summarize), `ingestSource` (audio /
 * YouTube / MCP add-source), `addNote` (MCP create-note) and `transformTarget`
 * (where a transformation Document is written).
 *
 * RBAC (ADR 1103 D2 — this used to be "any run in the tenant may use any org-visible
 * notebook", which let an org-A member read and write org B's notebooks by passing
 * an id, and a project viewer write through a run what the door refuses):
 *   - a run WITH an actor (`scope.actingUserId`: the route doors, the chat tool, MCP,
 *     a fork) gets exactly what the HTTP door gives that person — the ONE rule,
 *     `notebookAccess` (`resolveProjectAccess`): reads need any access, writes need
 *     `write`. A private project's member reads it; a stranger to the org reads
 *     nothing;
 *   - a run with NO actor reads org-visible notebooks only (the system-run rule every
 *     surface keeps), narrowed by the causing member when there is one
 *     (`orgScopeSubject`, ADR 0832 — a cause narrows, never widens), and writes
 *     NOTHING: no legitimate notebook writer is actorless.
 * The ADR 0832 seam floor keys on `args.orgId`, which no method here takes, so this
 * surface does its own floor — it is the only code that can map a notebook to its
 * org and visibility.
 *
 * Refusals: the read methods answer with their empty shape (they back MCP tools, and
 * an empty answer is the existence non-leak the doors also give); the write methods
 * and `getSourceText` answer `{ error: { code, message } }` (the documents
 * `createDraftDocument` shape), which the node turns into a typed failure (ADR 1103
 * D4) — never `success` with nothing written.
 *
 * @see docs/adr/0084-research-notebooks.md
 * @see docs/adr/1103-notebooks-run-lane-acts-for-its-caller.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { type FeatureSurface, surfaceStr, surfaceOptCount } from '../../host/featureSurfaces.js';
import { OpenwopError } from '../../types.js';
import { getProject, projectSubject } from '../projects/projectsService.js';
import { composeKnowledgeForSubject } from '../../host/agentKnowledgeComposition.js';
import {
  getNotebook,
  notebookAccess,
  listOrgVisibleNotebooks,
  listNotebooksVisibleTo,
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

/** ADR 1103 D2/D4 — the closed set of refusal codes the write lane answers with. The
 *  nodes throw them as their failure `code`. */
export type NotebookRunRefusal =
  | 'notebook_unavailable'
  | 'notebook_write_forbidden'
  | 'notebook_write_needs_person'
  | 'source_unavailable'
  | 'source_changed'
  | 'content_empty';

const refusal = (code: NotebookRunRefusal, message: string): { error: { code: NotebookRunRefusal; message: string } } => ({ error: { code, message } });

/** A service throw on the write lane → its refusal, so the node can fail typed. Anything
 *  that is not a known domain refusal (a storage fault) is rethrown: swallowing it would
 *  answer "refused" for an outage. */
function refusalOf(err: unknown): ReturnType<typeof refusal> {
  if (err instanceof OpenwopError) {
    // A not-found that names a source is the source; one that names only the notebook
    // (deleted mid-run) is the notebook.
    if (err.code === 'not_found') {
      return err.details?.sourceId !== undefined
        ? refusal('source_unavailable', 'The source is not in this notebook.')
        : refusal('notebook_unavailable', REFUSAL_MESSAGE.notebook_unavailable);
    }
    if (err.code === 'conflict' && err.details?.reason === 'source_changed') {
      return refusal('source_changed', 'The source changed after it was read; summarize it again.');
    }
    if (err.code === 'validation_error') return refusal('content_empty', 'The summary was empty.');
  }
  throw err;
}

type Need = 'read' | 'write';

/**
 * ADR 1103 D2 — resolve a notebook FOR THIS RUN. The one gate every method passes
 * through; see the file docblock for the table.
 */
async function resolveForRun(
  scope: BundleScope,
  notebookId: string,
  need: Need,
): Promise<{ nb: Notebook; actor?: string } | { refused: keyof typeof REFUSAL_MESSAGE }> {
  const tenantId = scope.tenantId;
  if (scope.actingUserId) {
    const access = await notebookAccess(tenantId, notebookId, scope.actingUserId);
    if (!access) return { refused: 'notebook_unavailable' };
    if (need === 'write' && access.level !== 'write') return { refused: 'notebook_write_forbidden' };
    return { nb: access.notebook, actor: scope.actingUserId };
  }
  if (need === 'write') return { refused: 'notebook_write_needs_person' };
  const nb = await getNotebook(tenantId, notebookId);
  if (!nb) return { refused: 'notebook_unavailable' };
  const project = await getProject(tenantId, notebookId);
  if (!project || (project.visibility ?? 'org') !== 'org') return { refused: 'notebook_unavailable' };
  if (scope.orgScopeSubject && !(await notebookAccess(tenantId, notebookId, scope.orgScopeSubject))) {
    return { refused: 'notebook_unavailable' };
  }
  return { nb };
}

/** Reads: the notebook, or null (the caller answers its empty shape). */
async function readable(scope: BundleScope, notebookId: string): Promise<Notebook | null> {
  const r = await resolveForRun(scope, notebookId, 'read');
  return 'nb' in r ? r.nb : null;
}

const REFUSAL_MESSAGE: Record<'notebook_unavailable' | 'notebook_write_forbidden' | 'notebook_write_needs_person', string> = {
  notebook_unavailable: 'Notebook not found, or this run cannot access it.',
  notebook_write_forbidden: 'This run acts for someone who cannot change this notebook.',
  notebook_write_needs_person: 'Only a run started by a person can change a notebook.',
};

export function buildNotebooksSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  /** Writes: the notebook, or the typed refusal the node fails with. */
  const writable = async (notebookId: string): Promise<{ nb: Notebook; actor: string } | ReturnType<typeof refusal>> => {
    const r = await resolveForRun(scope, notebookId, 'write');
    // A write resolves only through the actor arm (D2), which names the person.
    if ('nb' in r && r.actor) return { nb: r.nb, actor: r.actor };
    if ('nb' in r) return refusal('notebook_write_needs_person', REFUSAL_MESSAGE.notebook_write_needs_person);
    return refusal(r.refused, REFUSAL_MESSAGE[r.refused]);
  };
  return {
    /** The notebooks this run may read (ADR 0087 — backs the `notebook-list` MCP
     *  tool, whose manifest says "the notebooks you can access"; ADR 1103 D2 makes
     *  that true). With an actor: what the projects list shows them. With none:
     *  org-visible ones, narrowed by a causing member. */
    listNotebooks: async () => {
      if (scope.actingUserId) return { notebooks: await listNotebooksVisibleTo(tenantId, scope.actingUserId) };
      // No per-notebook resolve (the PRJC-3 rule): with a causing member, ONE
      // list-visible scan for them; otherwise one org-visible list.
      if (!scope.orgScopeSubject) return { notebooks: await listOrgVisibleNotebooks(tenantId) };
      return { notebooks: await listNotebooksVisibleTo(tenantId, scope.orgScopeSubject, { orgVisibleOnly: true }) };
    },

    /** One notebook by id, or null when this run cannot read it (ADR 0087 —
     *  backs `notebook-get`). */
    getNotebook: async (args) => ({ notebook: await readable(scope, surfaceStr(args.notebookId)) }),

    /** The notebook's sources (KB document projections, each with its per-source
     *  contextLevel). Empty when this run cannot read the notebook. */
    listSources: async (args) => {
      const nb = await readable(scope, surfaceStr(args.notebookId));
      if (!nb) return { sources: [] };
      return { sources: await listSources(tenantId, nb.id) };
    },

    /** One source by id within a notebook, or null. */
    getSource: async (args) => {
      const nb = await readable(scope, surfaceStr(args.notebookId));
      if (!nb) return { source: null };
      const sourceId = surfaceStr(args.sourceId);
      const source = (await listSources(tenantId, nb.id)).find((s) => s.documentId === sourceId) ?? null;
      return { source };
    },

    /**
     * The FULL text of one source and the revision it was read at (ADR 0084 T1 /
     * ADR 1103 D4) — the input the summarize and transform chains feed the model.
     * READ-gated, but answers a typed refusal rather than `''`: its one caller
     * (`read-source`) must fail, not summarize nothing.
     */
    getSourceText: async (args) => {
      const r = await resolveForRun(scope, surfaceStr(args.notebookId), 'read');
      if (!('nb' in r)) return refusal('notebook_unavailable', REFUSAL_MESSAGE.notebook_unavailable);
      const src = await getSourceText(tenantId, r.nb.id, surfaceStr(args.sourceId));
      if (!src) return refusal('source_unavailable', 'The source is not in this notebook.');
      return { text: src.text, revision: src.revision };
    },

    /**
     * Store a source's LLM SUMMARY (ADR 0084 T1) — the `notebooks.summarize`
     * chain's write. WRITE-gated (ADR 1103 D2). With `revision`, a summary of text
     * that has since changed is refused (`source_changed`, D4).
     */
    setSourceSummary: async (args) => {
      const w = await writable(surfaceStr(args.notebookId));
      if (!('nb' in w)) return w;
      const revision = typeof args.revision === 'number' && Number.isInteger(args.revision) ? args.revision : undefined;
      try {
        return await setSourceSummary(tenantId, w.nb.id, surfaceStr(args.sourceId), surfaceStr(args.summary), revision !== undefined ? { revision } : {});
      } catch (err) {
        return refusalOf(err);
      }
    },

    /**
     * Ingest a transcript as a notebook KB source (ADR 0085 Phase 5) — the write the
     * `ingest-source` and `mcp-add-source` nodes make. WRITE-gated (ADR 1103 D2).
     * Reuses `addSource` (`contentTrust:'untrusted'`, fenced at dispatch).
     */
    ingestSource: async (args) => {
      const w = await writable(surfaceStr(args.notebookId));
      if (!('nb' in w)) return w;
      const text = surfaceStr(args.text);
      if (text.trim().length === 0) return refusal('content_empty', 'There was no text to add.');
      const title = surfaceStr(args.title) || 'Transcribed source';
      // ADR 0617 D1a / ADR 0643 D3 — the run's origin rides the `document.ingested`
      // event, so a binding on this run's own workflow is not re-triggered by it.
      try {
        const source = await addSource(tenantId, w.nb.id, w.actor, { title, text }, {
          origin: {
            ...(scope.runId ? { runId: scope.runId } : {}),
            ...(scope.workflowId ? { workflowId: scope.workflowId } : {}),
            ...(scope.chainId ? { chainId: scope.chainId } : {}),
          },
        });
        return { ingested: true, sourceId: source.documentId, title: source.title };
      } catch (err) {
        return refusalOf(err); // a notebook deleted mid-run is `notebook_unavailable`, typed
      }
    },

    /**
     * Add a NOTE (ADR 0087 `notebook-create-note`). WRITE-gated (ADR 1103 D2).
     *
     * ADR 0601 — the content origin is HARD-CODED `'third-party'` and is not derived
     * from `args`: this lane's text is `params.arguments` from an external MCP client
     * (ADR 0087 §73, untrusted). Letting the caller name its own trust would hand the
     * attacker the boundary. Not a knob, by construction.
     */
    addNote: async (args) => {
      const w = await writable(surfaceStr(args.notebookId));
      if (!('nb' in w)) return w;
      const content = surfaceStr(args.content);
      if (content.trim().length === 0) return refusal('content_empty', 'The note was empty.');
      await addNote(tenantId, w.nb.id, content, 'third-party');
      return { created: true };
    },

    /**
     * ADR 1103 D5 — WHERE a transformation Document is written: the notebook's own org
     * and its project subject, never the run's inputs. WRITE-gated: authoring a
     * notebook-owned Document is a write to that notebook.
     */
    transformTarget: async (args) => {
      const w = await writable(surfaceStr(args.notebookId));
      if (!('nb' in w)) return w;
      return { orgId: w.nb.orgId, ownerSubject: projectSubject(w.nb.id) };
    },

    /** The notebook's notes (subject memory, newest-first). Empty when this run
     *  cannot read the notebook. */
    listNotes: async (args) => {
      const nb = await readable(scope, surfaceStr(args.notebookId));
      if (!nb) return { notes: [] };
      return { notes: await listNotes(tenantId, nb.id) };
    },

    /** Grounded search over the notebook's bound KB collection — ranked hits +
     *  de-duplicated citations (excluded sources already dropped by the service).
     *  Empty when this run cannot read the notebook. */
    searchNotebook: async (args) => {
      const nb = await readable(scope, surfaceStr(args.notebookId));
      if (!nb) return { hits: [], citations: [] };
      // ADR 0602 / `NBWF-1`: `surfaceOptCount`, NOT `surfaceOptStr` — a count.
      const { hits, citations } = await searchNotebook(tenantId, nb.id, surfaceStr(args.query), surfaceOptCount(args.topK));
      return { hits, citations };
    },

    /**
     * Grounded ASK over the notebook (ADR 0084 Phase 3) — the `feature.kb.nodes`
     * `rag` precedent: retrieve + format, generation DEFERRED downstream. Returns the
     * FENCED, context-level-filtered knowledge block (`augmentedPrompt`, from the host
     * helper `composeKnowledgeForSubject`, which also applies the binding's
     * `excludeDocumentIds`) plus de-duplicated `citations` + raw `contexts`.
     * READ-ONLY. Empty when this run cannot read the notebook.
     */
    ask: async (args) => {
      const nb = await readable(scope, surfaceStr(args.notebookId));
      if (!nb) return { augmentedPrompt: '', citations: [], contexts: [] };
      const query = surfaceStr(args.query);
      const topK = surfaceOptCount(args.topK); // ADR 0602 — the same one rule as `searchNotebook`
      const augmentedPrompt = await composeKnowledgeForSubject(
        tenantId,
        projectSubject(nb.id),
        query,
        topK !== undefined ? { topK } : undefined,
      );
      const { hits, citations } = await searchNotebook(tenantId, nb.id, query, topK);
      return { augmentedPrompt, citations, contexts: hits };
    },

    /** Per-source CONTEXT LEVELS (ADR 0084) — each source's documentId + title +
     *  contextLevel. Empty when this run cannot read the notebook. */
    getContextLevels: async (args) => {
      const nb = await readable(scope, surfaceStr(args.notebookId));
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

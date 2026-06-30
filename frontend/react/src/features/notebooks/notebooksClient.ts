/**
 * Research Notebooks client (ADR 0084) — host-extension, non-normative. Wraps
 * /v1/host/openwop-app/notebooks/*. 404s when the `notebooks` toggle is off.
 *
 * A notebook IS a project (`facet:'notebook'`) composing the existing seams:
 * sources → a bound KB collection, notes → subject memory, search → KB RAG over
 * the collection. This client mirrors those response shapes 1:1 (see the backend
 * notebooksService.ts / routes.ts).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

/** The notebook projection — a project plus its bound KB collection id. */
export interface Notebook {
  id: string;
  tenantId: string;
  orgId: string;
  name: string;
  collectionId: string;
  createdAt: string;
  updatedAt: string;
}

/** A per-source context level (ADR 0084). `summary` is selectable ONLY once a
 *  summary has been generated (ADR 0084 Transformations T1 — see `hasSummary`); the
 *  UI keeps the Summary button disabled until then. */
export type SourceContextLevel = 'full' | 'summary' | 'excluded';

/** A source document in a notebook (the KB document projection — no full text). */
export interface NotebookSource {
  documentId: string;
  title: string;
  source: { kind: 'text' } | { kind: 'media' };
  chunkCount: number;
  createdAt: string;
  /** Per-source context level (default 'full'). */
  contextLevel: SourceContextLevel;
  /** Whether a stored LLM summary exists (ADR 0084 T1 — un-gates the `summary`
   *  context level). False until a summarize run completes. */
  hasSummary: boolean;
}

/** A curated note (subject memory in the `project:<id>` scope). */
export interface NotebookNote {
  id: string;
  content: string;
  contentTrust: 'trusted' | 'untrusted';
  createdAt: string;
}

/** A ranked retrieval hit from a notebook search (KB semantic search). */
export interface NotebookSearchHit {
  chunkId: string;
  documentId: string;
  title: string;
  chunkIndex: number;
  text: string;
  score: number;
}

/** A de-duplicated source citation for a search answer. */
export interface NotebookCitation {
  documentId: string;
  title: string;
}

export interface NotebookSearchResult {
  hits: NotebookSearchHit[];
  citations: NotebookCitation[];
}

/** An org the caller can create a notebook in (create gates on `workspace:write`). */
export interface Org {
  orgId: string;
  name: string;
}

/** A transformation template the catalog exposes (ADR 0084 Transformations T2). */
export interface TransformationTemplate {
  id: string;
  label: string;
}

/** A notebook transformation artifact — the projection of a Document owned by the
 *  notebook subject (ADR 0084 Transformations T2). Read-only; the output lives in
 *  Documents (the single owner of stored artifacts). */
export interface Transformation {
  documentId: string;
  title: string;
  kind: string;
  status: string;
  createdAt: string;
}

const base = `${config.baseUrl}/v1/host/openwop-app/notebooks`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string })?.message ?? '';
    } catch {
      /* non-JSON */
    }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listNotebooks(): Promise<Notebook[]> {
  const res = await fetch(base, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ notebooks: Notebook[] }>(res, 'listNotebooks')).notebooks;
}

export async function getNotebook(id: string): Promise<Notebook> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<Notebook>(res, 'getNotebook');
}

export async function createNotebook(orgId: string, name: string): Promise<Notebook> {
  const res = await fetch(base, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name, orgId }) }));
  return (await asJson<{ notebook: Notebook; collectionId: string }>(res, 'createNotebook')).notebook;
}

/** Ensure an existing project has research sources (ADR 0084 correction — the
 *  Sources project tab) — provisions a KB collection + binding if missing, idempotent.
 *  Returns the notebook projection for the project. */
export async function ensureNotebook(id: string): Promise<Notebook> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}/ensure`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  return (await asJson<{ notebook: Notebook; collectionId: string }>(res, 'ensureNotebook')).notebook;
}

export async function deleteNotebook(id: string): Promise<void> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) throw new Error(`deleteNotebook returned ${res.status}`);
}

export async function listSources(id: string): Promise<NotebookSource[]> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}/sources`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ sources: NotebookSource[] }>(res, 'listSources')).sources;
}

export async function addSource(id: string, input: { title?: string; text: string }): Promise<NotebookSource> {
  const body: { title?: string; text: string } = { text: input.text };
  if (input.title !== undefined && input.title !== '') body.title = input.title;
  const res = await fetch(`${base}/${encodeURIComponent(id)}/sources`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) }));
  return asJson<NotebookSource>(res, 'addSource');
}

/** Add a source from an uploaded file (text/PDF/DOCX) — extracted to text + ingested
 *  server-side (synchronous, unlike the async audio/YouTube transcription paths). */
export async function addFileSource(id: string, input: { title: string; contentBase64: string; contentType: string }): Promise<NotebookSource> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}/sources`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<NotebookSource>(res, 'addFileSource');
}

/** Ingest an audio/video source (ADR 0085) — uploads the bytes (base64) and enqueues
 *  the `notebooks.ingest-audio` run (transcribe → ingest). The transcribed source
 *  appears asynchronously; poll `listSources` for it once the run completes. Returns
 *  the run id (202 Accepted). */
export async function addAudioSource(
  id: string,
  input: { title?: string; contentBase64: string; contentType: string; language?: string },
): Promise<{ runId: string }> {
  const body: Record<string, string> = { contentBase64: input.contentBase64, contentType: input.contentType };
  if (input.title) body.title = input.title;
  if (input.language) body.language = input.language;
  const res = await fetch(
    `${base}/${encodeURIComponent(id)}/sources/audio`,
    fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) }),
  );
  return asJson<{ runId: string }>(res, 'addAudioSource');
}

/** Ingest a YouTube source by caption track (ADR 0085) — enqueues the
 *  `notebooks.ingest-youtube` run. The source appears asynchronously; poll
 *  `listSources`. The run fails (`no_transcript`) when the video has no captions.
 *  Returns the run id (202 Accepted). */
export async function addYoutubeSource(id: string, input: { url: string; title?: string }): Promise<{ runId: string }> {
  const body: Record<string, string> = { url: input.url };
  if (input.title) body.title = input.title;
  const res = await fetch(
    `${base}/${encodeURIComponent(id)}/sources/youtube`,
    fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) }),
  );
  return asJson<{ runId: string }>(res, 'addYoutubeSource');
}

/** Set a source's context level (ADR 0084). `summary` is accepted only once a
 *  summary has been generated for the source (the backend 400s otherwise); the UI
 *  gates the Summary button on `hasSummary` so callers only send it when valid.
 *  Returns the updated source projection (with contextLevel + hasSummary). */
export async function setSourceContextLevel(
  id: string,
  sourceId: string,
  level: SourceContextLevel,
): Promise<NotebookSource> {
  const res = await fetch(
    `${base}/${encodeURIComponent(id)}/sources/${encodeURIComponent(sourceId)}/context-level`,
    fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ level }) }),
  );
  return asJson<NotebookSource>(res, 'setSourceContextLevel');
}

/** Enqueue the `notebooks.summarize` built-in workflow run for a source (ADR 0084
 *  Transformations T1). The summary is produced asynchronously by the run; poll
 *  `listSources` for `hasSummary` to know when it's ready, then switch the source to
 *  the `summary` context level. Returns the run id (202 Accepted). */
export async function summarizeSource(id: string, sourceId: string): Promise<{ runId: string }> {
  const res = await fetch(
    `${base}/${encodeURIComponent(id)}/sources/${encodeURIComponent(sourceId)}/summarize`,
    fetchOpts({ method: 'POST', headers: jsonHeaders() }),
  );
  return asJson<{ runId: string }>(res, 'summarizeSource');
}

/** The transformation catalog (id + label) for a notebook (ADR 0084 T2). Const
 *  config server-side — the FE renders these as the Transform menu. */
export async function listTransformationTemplates(id: string): Promise<TransformationTemplate[]> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}/transformations/templates`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ templates: TransformationTemplate[] }>(res, 'listTransformationTemplates')).templates;
}

/** Apply a transformation TEMPLATE to a source (ADR 0084 Transformations T2). The
 *  result is produced asynchronously by the `notebooks.transform` run and written as
 *  a Document owned by the notebook; poll `listTransformations` to surface it.
 *  Returns the run id (202 Accepted). */
export async function applyTransformation(id: string, sourceId: string, templateId: string): Promise<{ runId: string }> {
  const res = await fetch(
    `${base}/${encodeURIComponent(id)}/sources/${encodeURIComponent(sourceId)}/transform`,
    fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ templateId }) }),
  );
  return asJson<{ runId: string }>(res, 'applyTransformation');
}

/** List a notebook's transformation Documents (ADR 0084 T2) — the result artifacts,
 *  read-only (owned by the notebook subject in Documents). */
export async function listTransformations(id: string): Promise<Transformation[]> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}/transformations`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ transformations: Transformation[] }>(res, 'listTransformations')).transformations;
}

export async function listNotes(id: string): Promise<NotebookNote[]> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}/notes`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ notes: NotebookNote[] }>(res, 'listNotes')).notes;
}

export async function addNote(id: string, text: string): Promise<NotebookNote[]> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}/notes`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ text }) }));
  return (await asJson<{ notes: NotebookNote[] }>(res, 'addNote')).notes;
}

export async function searchNotebook(id: string, query: string, topK?: number): Promise<NotebookSearchResult> {
  const body: { query: string; topK?: number } = { query };
  if (topK !== undefined) body.topK = topK;
  const res = await fetch(`${base}/${encodeURIComponent(id)}/search`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) }));
  return asJson<NotebookSearchResult>(res, 'searchNotebook');
}

/** Ensure (idempotent) the notebook's project group conversation and return its
 *  id, to deep-link into the main /chat surface (ADR 0084 Phase 2). The chat is
 *  GROUNDED in the notebook's sources server-side (ownerSubject = project:<id>).
 *  Write-gated: opening reconciles the lineup. */
export async function ensureNotebookChat(id: string): Promise<{ conversationId: string }> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}/chat`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  return asJson<{ conversationId: string }>(res, 'ensureNotebookChat');
}

/** Orgs the caller can create a notebook in (shared host-extension route). */
export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

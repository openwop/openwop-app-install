/**
 * Knowledge Base API client (ADR 0011). Org-scoped under
 * /host/openwop-app/kb/orgs/:orgId. Sources are pasted text or Media-Library
 * tokens; retrieval returns scored chunks + citations.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { KbRequestError } from './kbRequestError.js';

export interface Org { orgId: string; name: string }

export interface KbCollection {
  collectionId: string;
  name: string;
  description?: string;
  documentCount: number;
  chunkCount: number;
  updatedAt: string;
  /** Auto-managed by another feature (ADR 0100): kept in sync with its entities;
   *  read-only here (hand-edits are rejected server-side). */
  managed?: 'strategy' | 'priority-matrix';
  /** ADR 0113 — per-collection retrieval pipeline config (+ ADR 0351 embedder). */
  retrievalConfig?: { mode?: RetrievalMode; embedder?: EmbedderMode; enrichment?: EnrichmentMode };
  /** ADR 0398 P3 — the pinned per-collection embedding spec (set via a reindex). */
  embeddingSpec?: EmbeddingSpec;
}

/** ADR 0351 — which embedder vectorizes the collection. */
export type EmbedderMode = 'local' | 'provider';

/** ADR 0351 P4 — contextual enrichment of the embedded chunk text. */
export type EnrichmentMode = 'off' | 'heading-path';

/** ADR 0113 retrieval pipeline mode. */
export type RetrievalMode = 'dense' | 'hybrid' | 'hybrid+rerank';

/**
 * KB-UX-8 (widened) — the source union MUST match the backend's, which is
 * `{kind:'text'} | {kind:'media'} | {kind:'url'; url}` (`kbService.ts`). While
 * `url` was missing here, `KbViews`' `SOURCE_KEY` lookup evaluated
 * `t(undefined)` for every URL-ingested document — in the card sub-line AND the
 * chip, in both grid and list view — for exactly the content the app's own copy
 * calls untrusted. Adding the arm is what makes that lookup total again, and
 * `Record<KbDocument['source']['kind'], string>` then fails to COMPILE if a
 * later arm is added to the wire without a label here.
 */
export interface KbDocument {
  documentId: string;
  title: string;
  source: { kind: 'text' } | { kind: 'media' } | { kind: 'url'; url?: string };
  chunkCount: number;
  createdAt: string;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  title: string;
  chunkIndex: number;
  text: string;
  score: number;
}

export interface RagResult {
  query: string;
  contexts: SearchHit[];
  citations: Array<{ documentId: string; title: string }>;
  augmentedPrompt: string;
}

const root = `${config.baseUrl}/host/openwop-app`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/**
 * KBX-4 — every failure leaves this module as a `KbRequestError` CARRYING THE
 * STATUS, so `kbUiHelpers.kbActionError` can say what happened in the user's
 * language. Without the status a caller can only render `err.message`, i.e. the
 * server's untranslated English (or, on the two DELETE paths that skipped this
 * helper entirely, the literal string `deleteDocument returned 409`).
 */
async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) throw await requestError(res, ctx);
  return (await res.json()) as T;
}

/** Build the typed failure for a non-ok response, parsing the JSON body for the
 *  developer-facing detail. Shared by `asJson` and the two no-content DELETEs —
 *  which is the point: a route that returns 204 on success still returns a JSON
 *  problem body on failure, and skipping the parse is how `KBX-4` happened. */
async function requestError(res: Response, ctx: string): Promise<KbRequestError> {
  let detail = '';
  try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
  return new KbRequestError(detail || `${ctx} returned ${res.status}`, res.status);
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${root}/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

const base = (orgId: string): string => `${root}/kb/orgs/${encodeURIComponent(orgId)}`;
const col = (orgId: string, collectionId: string): string => `${base(orgId)}/collections/${encodeURIComponent(collectionId)}`;

export async function listCollections(orgId: string): Promise<KbCollection[]> {
  const res = await fetch(`${base(orgId)}/collections`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ collections: KbCollection[] }>(res, 'listCollections')).collections;
}

export async function createCollection(orgId: string, name: string, description?: string): Promise<KbCollection> {
  const res = await fetch(`${base(orgId)}/collections`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name, ...(description ? { description } : {}) }) }));
  return asJson<KbCollection>(res, 'createCollection');
}

/** ADR 0113 — set a collection's retrieval mode (hybrid lift / local rerank). */
export async function setRetrievalMode(orgId: string, collectionId: string, mode: RetrievalMode): Promise<KbCollection> {
  const res = await fetch(`${col(orgId, collectionId)}/retrieval`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ mode }) }));
  return (await asJson<{ collection: KbCollection }>(res, 'setRetrievalMode')).collection;
}

/** ADR 0351 — set a collection's embedder (local hash vs the tenant's BYOK
 *  provider embeddings). The backend merges, so mode/rerank are untouched. */
export async function setEmbedderMode(orgId: string, collectionId: string, embedder: EmbedderMode): Promise<KbCollection> {
  const res = await fetch(`${col(orgId, collectionId)}/retrieval`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ embedder }) }));
  return (await asJson<{ collection: KbCollection }>(res, 'setEmbedderMode')).collection;
}

export async function deleteCollection(orgId: string, collectionId: string): Promise<void> {
  // 204 No Content is `res.ok`, so the success path needs no body parse — but
  // the FAILURE path does (KBX-4): this used to throw the bare literal
  // `deleteCollection returned 409`, which the page rendered to the operator.
  const res = await fetch(col(orgId, collectionId), fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw await requestError(res, 'deleteCollection');
}

export async function listDocuments(orgId: string, collectionId: string): Promise<KbDocument[]> {
  const res = await fetch(`${col(orgId, collectionId)}/documents`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ documents: KbDocument[] }>(res, 'listDocuments')).documents;
}

/** A single document WITH its full extracted text — the list carries metadata
 *  only, so the reader (ADR 0336) fetches this on demand. */
export interface KbDocumentDetail extends KbDocument {
  text: string;
}
export async function getDocument(orgId: string, collectionId: string, documentId: string): Promise<KbDocumentDetail> {
  const res = await fetch(`${col(orgId, collectionId)}/documents/${encodeURIComponent(documentId)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<KbDocumentDetail>(res, 'getDocument');
}

export async function ingestText(orgId: string, collectionId: string, title: string, text: string): Promise<KbDocument> {
  const res = await fetch(`${col(orgId, collectionId)}/documents`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ title, text }) }));
  return asJson<KbDocument>(res, 'ingestText');
}

/** Ingest an uploaded file (text/PDF/DOCX) — the bytes are extracted to text
 *  server-side (kbService). */
/** ADR 0351 P4 — ingest a web page by URL (server-side SSRF-guarded fetch +
 *  readable extraction; the document is fenced untrusted). */
export async function ingestUrl(orgId: string, collectionId: string, url: string, title?: string): Promise<KbDocument> {
  const res = await fetch(`${col(orgId, collectionId)}/documents`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ url, ...(title ? { title } : {}) }) }));
  return asJson<KbDocument>(res, 'ingestUrl');
}

/** ADR 0351 P4 — set the collection's enrichment mode (backend merges). */
export async function setEnrichmentMode(orgId: string, collectionId: string, enrichment: EnrichmentMode): Promise<KbCollection> {
  const res = await fetch(`${col(orgId, collectionId)}/retrieval`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ enrichment }) }));
  return (await asJson<{ collection: KbCollection }>(res, 'setEnrichmentMode')).collection;
}

export async function ingestFile(orgId: string, collectionId: string, input: { title: string; contentBase64: string; contentType: string }): Promise<KbDocument> {
  const res = await fetch(`${col(orgId, collectionId)}/documents`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<KbDocument>(res, 'ingestFile');
}


/** ADR 0398 P2 — the result of ingesting a whole media collection (itemized skips). */
export interface IngestMediaCollectionResult {
  ingested: number;
  skipped: Array<{ assetId: string; name: string; reason: string }>;
}

/** ADR 0398 P2 — ingest every extractable asset of a media collection as untrusted-fenced,
 *  stable-id KB documents (idempotent). One-shot snapshot; non-extractable assets are
 *  reported in `skipped` with a per-asset reason. */
export async function ingestMediaCollection(orgId: string, collectionId: string, mediaCollectionId: string): Promise<IngestMediaCollectionResult> {
  const res = await fetch(`${col(orgId, collectionId)}/ingest-media-collection`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ mediaCollectionId }) }));
  return asJson<IngestMediaCollectionResult>(res, 'ingestMediaCollection');
}

// ── ADR 0398 P3 — per-collection embedding spec + reindex ──
export type EmbeddingProvider = 'local' | 'openai' | 'google' | 'cohere';
export interface EmbeddingSpec { provider: EmbeddingProvider; model?: string; dims?: number; credentialRef?: string }
/** `cutting-over` (ADR 0643 R4) — a live, millisecond-scale state between the last
 *  batch and the namespace flip; treated as active, never as terminal. */
export type ReindexStatus = 'running' | 'paused' | 'cutting-over' | 'done' | 'failed' | 'cancelled';
export interface ReindexJob {
  collectionId: string; targetSpec: EmbeddingSpec; fromSig: string; toSig: string;
  totalChunks: number; embeddedChunks: number; status: ReindexStatus;
  costEstimateTokens: number; costSpentTokens: number; error?: string; startedAt: string; updatedAt: string;
}

const reindexBase = (orgId: string, collectionId: string): string => `${col(orgId, collectionId)}/reindex`;

/** Start a reindex to a new embedding spec (admin). Returns the running job. */
export async function startReindex(orgId: string, collectionId: string, embeddingSpec: EmbeddingSpec): Promise<ReindexJob> {
  const res = await fetch(reindexBase(orgId, collectionId), fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ embeddingSpec }) }));
  return asJson<ReindexJob>(res, 'startReindex');
}

/** Drive the reindex forward by a bounded batch (admin). The FE calls this in a loop. */
export async function drainReindex(orgId: string, collectionId: string): Promise<ReindexJob> {
  const res = await fetch(`${reindexBase(orgId, collectionId)}/drain`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({}) }));
  return asJson<ReindexJob>(res, 'drainReindex');
}

export async function cancelReindex(orgId: string, collectionId: string): Promise<ReindexJob> {
  const res = await fetch(`${reindexBase(orgId, collectionId)}/cancel`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({}) }));
  return asJson<ReindexJob>(res, 'cancelReindex');
}

export async function getReindexJob(orgId: string, collectionId: string): Promise<ReindexJob | null> {
  const res = await fetch(reindexBase(orgId, collectionId), fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ job: ReindexJob | null }>(res, 'getReindexJob')).job;
}

export async function deleteDocument(orgId: string, collectionId: string, documentId: string): Promise<void> {
  const res = await fetch(`${col(orgId, collectionId)}/documents/${encodeURIComponent(documentId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw await requestError(res, 'deleteDocument');
}

export async function search(orgId: string, collectionId: string, query: string, topK = 8): Promise<SearchHit[]> {
  const res = await fetch(`${col(orgId, collectionId)}/search`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ query, topK }) }));
  return (await asJson<{ results: SearchHit[] }>(res, 'search')).results;
}

export async function ragQuery(orgId: string, collectionId: string, query: string, topK = 8): Promise<RagResult> {
  const res = await fetch(`${col(orgId, collectionId)}/rag`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ query, topK }) }));
  return asJson<RagResult>(res, 'ragQuery');
}

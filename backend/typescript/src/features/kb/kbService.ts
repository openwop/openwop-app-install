/**
 * Knowledge Base / RAG (ADR 0011). Org-scoped, tenant+org IDOR-guarded. Owns
 * collections + documents (durable) and an ingest→chunk→embed→index pipeline +
 * semantic retrieval with citations. It COMPOSES existing host surfaces rather
 * than reinventing them:
 *   - the vector store via `buildHostSurfaceBundle({tenantId}).db.vector`
 *     (in-memory brute-force ↔ pgvector, tenant-scoped automatically);
 *   - the deterministic `embedText` embedder (no provider needed, replay-safe).
 *
 * Chunks are DERIVED, not separately stored: the document's `text` is the durable
 * source of truth, and because `embedText` is deterministic, the vector namespace
 * is lazily REBUILT from durable documents on first access per process (`hydrate`)
 * — restart-safe (the in-memory vector surface is ephemeral) without persisting
 * 256-float blobs per chunk. The host vector store still runs the similarity query.
 *
 * @see docs/adr/0011-knowledge-base-rag.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString, optionalCleanString } from '../../host/boundedStrings.js';
import { buildHostSurfaceBundle } from '../../host/inMemorySurfaces.js';
import { resolveMediaAsset } from '../../host/inMemorySurfaces.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { embedText, DEFAULT_EMBEDDING_DIMS } from '../../aiProviders/localEmbedding.js';
import { createLogger } from '../../observability/logger.js';
import type { KnowledgeRetrieveArgs, KnowledgeResult } from '../../host/knowledgeSurface.js';

const log = createLogger('features.kb');

const MAX = {
  name: 160,
  description: 1000,
  title: 200,
  /** Per-document source text. Bounded — the whole blob is stored durably. */
  text: 200_000,
  query: 2000,
  perOrgCollections: 500,
  perCollectionDocs: 1000,
  topK: 50,
  /** Max collections a single tenant-wide retrieve fans out across (ctx.knowledge
   *  / ctx.features.kb.retrieve). Bounds the per-call work on the workflow hot
   *  path — a tenant with thousands of collections can't make one retrieve scan
   *  them all. Truncation is logged, not silent. */
  retrieveCollections: 50,
  /** Chunking: ~chars per chunk + overlap. Char-window with sentence-ish
   *  boundary preference; deterministic so re-chunk on hydrate is identical.
   *  NOTE: changing these re-chunks documents — on a PERSISTED vector backend
   *  (pgvector) a collection ingested under the old params needs a re-index
   *  (delete + re-ingest) to avoid stale id↔text pairing. The default in-memory
   *  surface re-derives the whole namespace each process, so it's self-consistent. */
  chunkChars: 1200,
  chunkOverlap: 150,
  chunksPerDoc: 1000,
} as const;

/** Text-like MIME types we can extract from a Media asset. Binary/complex
 *  formats (PDF/Office) are deferred (ADR open question). */
const TEXT_MIME = /^(text\/|application\/(json|xml|x-ndjson|markdown)$)/i;

export interface KnowledgeCollection {
  collectionId: string;
  tenantId: string;
  orgId: string;
  name: string;
  description?: string;
  documentCount: number;
  chunkCount: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

// A document records HOW it was sourced, but NOT the media capability token: the
// token is a credential, and the text is already extracted durably, so storing
// it would leak asset access to any workspace:read member who lists documents
// (and it has no post-ingest value — media assets are immutable token-addressed
// blobs). Provenance is the kind only.
export type DocSource = { kind: 'text' } | { kind: 'media' };

export interface KnowledgeDocument {
  documentId: string;
  collectionId: string;
  tenantId: string;
  orgId: string;
  title: string;
  source: DocSource;
  /** The durable source of truth; chunks are re-derived from this. */
  text: string;
  chunkCount: number;
  createdBy: string;
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

const collections = new DurableCollection<KnowledgeCollection>('kb:collection', (c) => `${c.tenantId}:${c.orgId}:${c.collectionId}`);
const documents = new DurableCollection<KnowledgeDocument>('kb:document', (d) => `${d.tenantId}:${d.orgId}:${d.documentId}`);

/** Vector namespaces rebuilt this process-lifetime, keyed `${tenantId}:${collectionId}`.
 *  The in-memory vector surface is ephemeral; the first access after a restart
 *  re-derives the namespace from durable documents (deterministic embedder). */
const hydrated = new Set<string>();

// ─── chunking (deterministic) ──────────────────────────────────────────────

/** Split `text` into overlapping char windows, preferring to break on a
 *  paragraph/sentence boundary near the window edge. Deterministic: the same
 *  text always yields the same chunks (so re-chunk on hydrate matches ingest). */
export function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length === 0) return [];
  const out: string[] = [];
  let pos = 0;
  while (pos < clean.length && out.length < MAX.chunksPerDoc) {
    let end = Math.min(pos + MAX.chunkChars, clean.length);
    if (end < clean.length) {
      // Prefer a boundary (paragraph, then sentence, then space) in the last
      // ~20% of the window so chunks don't split mid-sentence.
      const windowStart = pos + Math.floor(MAX.chunkChars * 0.8);
      const slice = clean.slice(windowStart, end);
      const para = slice.lastIndexOf('\n\n');
      const sent = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.\n'));
      const space = slice.lastIndexOf(' ');
      const rel = para >= 0 ? para : sent >= 0 ? sent + 1 : space;
      if (rel >= 0) end = windowStart + rel + 1;
    }
    const chunk = clean.slice(pos, end).trim();
    if (chunk.length > 0) out.push(chunk);
    if (end >= clean.length) break;
    pos = Math.max(end - MAX.chunkOverlap, pos + 1);
  }
  return out;
}

function vectorSurface(tenantId: string) {
  return buildHostSurfaceBundle({ tenantId }).db.vector;
}

interface ChunkRow { id: string; vector: number[]; metadata: { documentId: string; chunkIndex: number; title: string; text: string } }

/** Build the chunk rows for one document (deterministic ids + vectors). */
function chunkRows(doc: KnowledgeDocument): ChunkRow[] {
  return chunkText(doc.text).map((text, chunkIndex) => ({
    id: `${doc.documentId}:${chunkIndex}`,
    vector: embedText(text, DEFAULT_EMBEDDING_DIMS),
    metadata: { documentId: doc.documentId, chunkIndex, title: doc.title, text },
  }));
}

/** Just the chunk ids for a document — for vector DELETE, which doesn't need the
 *  (expensive) embeddings `chunkRows` computes. */
function chunkIds(doc: KnowledgeDocument): string[] {
  return chunkText(doc.text).map((_text, i) => `${doc.documentId}:${i}`);
}

/** Lazily rebuild a collection's vector namespace from its durable documents,
 *  once per process. Cheap re-embed (deterministic) — no vectors are persisted. */
async function hydrate(tenantId: string, orgId: string, collectionId: string): Promise<void> {
  const key = `${tenantId}:${collectionId}`;
  if (hydrated.has(key)) return;
  const docs = (await documents.list()).filter((d) => d.tenantId === tenantId && d.orgId === orgId && d.collectionId === collectionId);
  const rows = docs.flatMap(chunkRows);
  if (rows.length > 0) {
    await vectorSurface(tenantId).upsert({ namespace: collectionId, items: rows });
  }
  hydrated.add(key);
}

// ─── collections ───────────────────────────────────────────────────────────

export async function listCollections(tenantId: string, orgId: string): Promise<KnowledgeCollection[]> {
  return (await collections.list())
    .filter((c) => c.tenantId === tenantId && c.orgId === orgId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getCollection(tenantId: string, orgId: string, collectionId: string): Promise<KnowledgeCollection | null> {
  const c = await collections.get(`${tenantId}:${orgId}:${collectionId}`);
  return c && c.tenantId === tenantId && c.orgId === orgId ? c : null;
}

export async function createCollection(
  tenantId: string,
  orgId: string,
  actor: string,
  input: { name?: unknown; description?: unknown },
): Promise<KnowledgeCollection> {
  const existing = (await collections.list()).filter((c) => c.tenantId === tenantId && c.orgId === orgId);
  if (existing.length >= MAX.perOrgCollections) {
    throw new OpenwopError('validation_error', `Collection cap reached (${MAX.perOrgCollections}).`, 400, {});
  }
  const now = new Date().toISOString();
  const col: KnowledgeCollection = {
    collectionId: randomUUID(),
    tenantId,
    orgId,
    name: cleanString(input.name, MAX.name),
    ...(optionalCleanString(input.description, MAX.description) !== undefined ? { description: optionalCleanString(input.description, MAX.description) } : {}),
    documentCount: 0,
    chunkCount: 0,
    createdBy: actor,
    updatedBy: actor,
    createdAt: now,
    updatedAt: now,
  };
  if (col.name.length === 0) throw new OpenwopError('validation_error', 'Field `name` is required.', 400, { field: 'name' });
  await collections.put(col);
  return col;
}

export async function deleteCollection(tenantId: string, orgId: string, collectionId: string): Promise<void> {
  const col = await getCollection(tenantId, orgId, collectionId);
  if (!col) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId });
  const docs = (await documents.list()).filter((d) => d.tenantId === tenantId && d.orgId === orgId && d.collectionId === collectionId);
  // Clear the vector namespace (the chunk ids of every doc) then drop the docs.
  const ids = docs.flatMap(chunkIds);
  if (ids.length > 0) await vectorSurface(tenantId).delete({ namespace: collectionId, ids });
  for (const d of docs) await documents.delete(`${tenantId}:${orgId}:${d.documentId}`);
  await collections.delete(`${tenantId}:${orgId}:${collectionId}`);
  hydrated.delete(`${tenantId}:${collectionId}`);
}

// ─── documents (ingest) ──────────────────────────────────────────────────

export async function listDocuments(tenantId: string, orgId: string, collectionId: string): Promise<Array<Omit<KnowledgeDocument, 'text'>>> {
  await mustGetCollection(tenantId, orgId, collectionId);
  return (await documents.list())
    .filter((d) => d.tenantId === tenantId && d.orgId === orgId && d.collectionId === collectionId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    // Drop the (potentially large) full text from the list projection.
    .map(({ text: _text, ...rest }) => rest);
}

export async function getDocument(tenantId: string, orgId: string, collectionId: string, documentId: string): Promise<KnowledgeDocument | null> {
  const d = await documents.get(`${tenantId}:${orgId}:${documentId}`);
  return d && d.tenantId === tenantId && d.orgId === orgId && d.collectionId === collectionId ? d : null;
}

/**
 * Ingest pasted text OR a Media-asset token into a collection: resolve the
 * source text, chunk → embed → upsert to the collection's vector namespace, and
 * store the document (with its durable text) + bump counts.
 */
export async function ingestDocument(
  tenantId: string,
  orgId: string,
  actor: string,
  collectionId: string,
  input: { title?: unknown; text?: unknown; mediaToken?: unknown },
): Promise<Omit<KnowledgeDocument, 'text'>> {
  const col = await mustGetCollection(tenantId, orgId, collectionId);
  const docCount = (await documents.list()).filter((d) => d.tenantId === tenantId && d.orgId === orgId && d.collectionId === collectionId).length;
  if (docCount >= MAX.perCollectionDocs) {
    throw new OpenwopError('validation_error', `Document cap reached (${MAX.perCollectionDocs}).`, 400, {});
  }

  const { text, source, derivedTitle } = await resolveSource(tenantId, input);
  const title = cleanString(input.title, MAX.title) || derivedTitle || 'Untitled';

  const doc: KnowledgeDocument = {
    documentId: randomUUID(),
    collectionId,
    tenantId,
    orgId,
    title,
    source,
    text,
    chunkCount: 0,
    createdBy: actor,
    createdAt: new Date().toISOString(),
  };
  const rows = chunkRows(doc);
  doc.chunkCount = rows.length;

  await hydrate(tenantId, orgId, collectionId); // ensure the namespace exists before adding
  // Durable doc FIRST, then the (ephemeral) vectors — so a crash between the two
  // never leaves orphan vectors without a backing document. If the upsert fails,
  // drop the hydrate marker: the next search rebuilds the namespace from durable
  // docs (which now includes this one), so the doc self-heals into searchability.
  await documents.put(doc);
  if (rows.length > 0) {
    try {
      await vectorSurface(tenantId).upsert({ namespace: collectionId, items: rows });
    } catch (err) {
      hydrated.delete(`${tenantId}:${collectionId}`);
      throw err;
    }
  }

  col.documentCount += 1;
  col.chunkCount += rows.length;
  col.updatedAt = doc.createdAt;
  col.updatedBy = actor;
  await collections.put(col);

  const { text: _t, ...projection } = doc;
  return projection;
}

export async function deleteDocument(tenantId: string, orgId: string, collectionId: string, documentId: string): Promise<void> {
  const doc = await getDocument(tenantId, orgId, collectionId, documentId);
  if (!doc) throw new OpenwopError('not_found', 'Document not found.', 404, { documentId });
  const ids = chunkIds(doc);
  if (ids.length > 0) await vectorSurface(tenantId).delete({ namespace: collectionId, ids });
  await documents.delete(`${tenantId}:${orgId}:${documentId}`);
  const col = await getCollection(tenantId, orgId, collectionId);
  if (col) {
    col.documentCount = Math.max(0, col.documentCount - 1);
    col.chunkCount = Math.max(0, col.chunkCount - doc.chunkCount);
    col.updatedAt = new Date().toISOString();
    await collections.put(col);
  }
}

// ─── retrieval ───────────────────────────────────────────────────────────

export async function search(tenantId: string, orgId: string, collectionId: string, queryRaw: unknown, topKRaw: unknown): Promise<SearchHit[]> {
  await mustGetCollection(tenantId, orgId, collectionId);
  const query = cleanString(queryRaw, MAX.query);
  if (query.length === 0) throw new OpenwopError('validation_error', 'Field `query` is required.', 400, { field: 'query' });
  const topK = clampTopK(topKRaw);
  await hydrate(tenantId, orgId, collectionId);
  const res = await vectorSurface(tenantId).query({ namespace: collectionId, vector: embedText(query, DEFAULT_EMBEDDING_DIMS), topK });
  const matches = (res.matches ?? []) as Array<{ id: string; score: number; metadata?: ChunkRow['metadata'] }>;
  return matches.map((m) => ({
    chunkId: m.id,
    documentId: m.metadata?.documentId ?? '',
    title: m.metadata?.title ?? '',
    chunkIndex: m.metadata?.chunkIndex ?? 0,
    text: m.metadata?.text ?? '',
    score: m.score,
  }));
}

/**
 * Back the tenant-scoped `ctx.knowledge` host surface (ADR 0014 Phase 0) with the
 * REAL KB store: vector-search across the tenant's collections and project to the
 * KnowledgeSurface chunk/source shape. Returns `null` (→ seeded demo fallback)
 * when KB is disabled for the tenant OR the tenant has no collections — so the
 * out-of-box demo still works and the surface only serves real data when there
 * is some. Closes the ADR-0011 "back host.knowledge with the real store" question.
 */
export async function tenantRetrieve(tenantId: string, args: KnowledgeRetrieveArgs): Promise<KnowledgeResult | null> {
  // Toggle-aware: a tenant without KB enabled doesn't expose its KB via ctx.knowledge.
  const assignment = await resolveOne('kb', { tenantId });
  if (!assignment || !assignment.enabled) return null;

  const tenantCollections = (await collections.list()).filter((c) => c.tenantId === tenantId);
  if (tenantCollections.length === 0) return null; // no real knowledge → demo fallback

  let wanted = args.collectionIds && args.collectionIds.length > 0
    ? tenantCollections.filter((c) => args.collectionIds!.includes(c.collectionId))
    : tenantCollections;
  if (wanted.length > MAX.retrieveCollections) {
    log.warn('kb_tenant_retrieve_truncated', { tenantId, total: wanted.length, cap: MAX.retrieveCollections });
    wanted = wanted.slice(0, MAX.retrieveCollections);
  }

  const started = Date.now();
  const resultLimit = clampTopK(args.resultLimit);
  const scoreThreshold = typeof args.scoreThreshold === 'number' ? args.scoreThreshold : 0;

  // Per-collection searches are independent → run them concurrently (wall-clock
  // is the slowest single search, not the sum). Each is fault-isolated to [].
  const perCollection = await Promise.all(
    wanted.map((c) =>
      search(tenantId, c.orgId, c.collectionId, args.query, Math.max(resultLimit, 8))
        .then((hits) => hits.map((hit) => ({ hit, collectionId: c.collectionId })))
        .catch(() => [] as Array<{ hit: SearchHit; collectionId: string }>),
    ),
  );
  const scored = perCollection.flat();
  scored.sort((a, b) => b.hit.score - a.hit.score);

  const chunks: KnowledgeResult['chunks'] = scored
    .filter(({ hit }) => hit.score >= scoreThreshold)
    .slice(0, resultLimit)
    .map(({ hit, collectionId }) => ({
      chunkId: hit.chunkId,
      content: hit.text,
      headingPath: [],
      pageNumber: null,
      documentTitle: hit.title,
      assetId: hit.documentId,
      collectionId,
      relevanceScore: hit.score,
    }));

  const sources: KnowledgeResult['sources'] = [];
  const seen = new Set<string>();
  for (const c of chunks) {
    if (!c.assetId || seen.has(c.assetId)) continue;
    seen.add(c.assetId);
    sources.push({ sourceId: c.assetId, assetId: c.assetId, title: c.documentTitle, headingPath: c.headingPath, pageNumber: c.pageNumber });
  }

  return { chunks, sources, latencyMs: Date.now() - started, hasResults: chunks.length > 0 };
}

export interface RagResult {
  query: string;
  contexts: SearchHit[];
  citations: Array<{ documentId: string; title: string }>;
  /** A grounded prompt assembled from the retrieved chunks, ready to feed to an
   *  agent / `ctx.callAI` IN A WORKFLOW. Generation is run-scoped (the provider
   *  is `ctx`-only), so the feature returns the augmented context, not an answer. */
  augmentedPrompt: string;
}

export async function ragQuery(tenantId: string, orgId: string, collectionId: string, queryRaw: unknown, topKRaw: unknown): Promise<RagResult> {
  const query = cleanString(queryRaw, MAX.query);
  const contexts = await search(tenantId, orgId, collectionId, queryRaw, topKRaw);
  const seen = new Set<string>();
  const citations: Array<{ documentId: string; title: string }> = [];
  for (const c of contexts) {
    if (c.documentId && !seen.has(c.documentId)) {
      seen.add(c.documentId);
      citations.push({ documentId: c.documentId, title: c.title });
    }
  }
  const contextBlock = contexts
    .map((c, i) => `[${i + 1}] (${c.title})\n${c.text}`)
    .join('\n\n');
  const augmentedPrompt = contexts.length === 0
    ? `No knowledge-base context was found for the question.\n\nQuestion: ${query}`
    : `Answer the question using ONLY the context below. Cite sources by their [n] index. If the context is insufficient, say so.\n\nContext:\n${contextBlock}\n\nQuestion: ${query}`;
  return { query, contexts, citations, augmentedPrompt };
}

// ─── helpers ───────────────────────────────────────────────────────────────

async function mustGetCollection(tenantId: string, orgId: string, collectionId: string): Promise<KnowledgeCollection> {
  const col = await getCollection(tenantId, orgId, collectionId);
  if (!col) throw new OpenwopError('not_found', 'Collection not found.', 404, { collectionId });
  return col;
}

function clampTopK(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 8;
  return Math.max(1, Math.min(n, MAX.topK));
}

/** Resolve the document's source text from pasted text or a Media token (text-
 *  like assets only), enforcing the tenant boundary on the asset. */
async function resolveSource(
  tenantId: string,
  input: { text?: unknown; mediaToken?: unknown },
): Promise<{ text: string; source: DocSource; derivedTitle?: string }> {
  // NOT cleanString: a media token is a base64url capability credential that
  // legitimately looks secret-shaped, so `scrubSecretShaped` would redact it and
  // the lookup would 404. Validate the charset + length instead, no scrubbing.
  const mediaToken = typeof input.mediaToken === 'string' ? input.mediaToken.trim() : '';
  if (mediaToken) {
    if (mediaToken.length > 512 || !/^[A-Za-z0-9_-]+$/.test(mediaToken)) {
      throw new OpenwopError('validation_error', 'Invalid `mediaToken`.', 400, { field: 'mediaToken' });
    }
    const asset = await resolveMediaAsset(mediaToken);
    if (!asset || asset.tenantId !== tenantId) {
      throw new OpenwopError('not_found', 'Media asset not found.', 404, { mediaToken });
    }
    if (!TEXT_MIME.test(asset.contentType)) {
      throw new OpenwopError('validation_error', `Cannot extract text from \`${asset.contentType}\` — paste text or use a text/* asset (binary extraction is deferred).`, 415, { contentType: asset.contentType });
    }
    const decoded = Buffer.from(asset.contentBase64, 'base64').toString('utf8');
    const text = decoded.slice(0, MAX.text);
    if (text.trim().length === 0) throw new OpenwopError('validation_error', 'The media asset has no extractable text.', 400, {});
    return { text, source: { kind: 'media' } };
  }
  const text = cleanString(input.text, MAX.text);
  if (text.trim().length === 0) {
    throw new OpenwopError('validation_error', 'Provide `text` or a `mediaToken` to ingest.', 400, { field: 'text' });
  }
  return { text, source: { kind: 'text' } };
}

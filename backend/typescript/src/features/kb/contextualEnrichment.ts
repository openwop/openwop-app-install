/**
 * ADR 0904 D7 / P4 — LLM contextual enrichment ("contextual retrieval"), opt-in per
 * collection and billed to the TENANT's own key.
 *
 * A chunk cut out of a long document loses what it is about ("the limit is EUR 45" —
 * which limit?). Per chunk, a model writes a ≤ 2-sentence situating prefix from the
 * document (capped at 32k chars), which is EMBEDDED with the chunk and INDEXED for
 * keywords with it. The stored chunk text stays raw (ADR 0351 rule): a search result
 * shows what the document says, never model text.
 *
 * - Model: the tenant's BYOK default (`resolveByokTextDescribed`, its `quick` class).
 *   Never the managed allowance; no key ⇒ the option is REFUSED at config time.
 * - Exchange (CLAUDE.md AI lanes): the document is fenced UNTRUSTED in the prompt;
 *   output is validated (non-empty, trimmed to two sentences / 400 chars) and an
 *   unusable answer is a typed failure, never an empty prefix silently embedded.
 * - Cache: bounded prefixes on the live document primary, valid only for the
 *   same provider/model, title and document/chunk hashes. Erasure fences publication.
 * - Budget: each call is metered against the KB's daily embed cap (`embedBudget.ts`);
 *   over the cap the build stops and reports incomplete, like a provider-embed stop.
 */
import { createHash } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { resolveByokTextDescribed, type HeadlessDispatch } from '../../host/headlessAi.js';
import { fenceUntrustedBlock } from '../../host/untrustedContent.js';
import { reserveEmbedBudget, estimateTokens } from './embedBudget.js';
import type { KnowledgeDocument } from './kbService.js';

export const ENRICH_DOC_CHARS = 32_000;
export const MAX_PREFIX_CHARS = 400;
const POOL = 4;
const MAX_OUTPUT_TOKENS = 120;

export interface EnrichRow {
  tenantId: string; collectionId: string; documentId: string; chunkIndex: number;
  chunkHash: string; docHash: string; titleHash: string; provider: string; model: string; prefix: string;
}
/** Legacy prototype rows are reachable for strict deletion/retention only.
 * New prefixes live under the document primary's incarnation and CAS. */
const enrichCache = new DurableCollection<EnrichRow>('kb:enrichcache', (r) => `${r.tenantId}:${r.collectionId}:${r.documentId}:${r.chunkIndex}`);

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export class EnrichmentError extends Error {
  constructor(public readonly code: 'enrich_output_invalid' | 'enrich_call_failed', message: string) { super(message); this.name = 'EnrichmentError'; }
}

export interface LlmEnricher { provider: string; model: string; dispatch: HeadlessDispatch }

/** The tenant's own-key enricher, or null (⇒ refuse the option / degrade, labelled). */
export async function resolveLlmEnricher(tenantId: string): Promise<LlmEnricher | null> {
  const d = await resolveByokTextDescribed(tenantId);
  return d && d.model ? { provider: d.provider, model: d.model, dispatch: d.dispatch } : null;
}

/** The signature token: which model's prefixes the vectors were built with. */
export const llmEnrichToken = (e: Pick<LlmEnricher, 'provider' | 'model'>): string => `llm:${e.provider}/${e.model}`;

export function buildEnrichMessages(title: string, docText: string, chunk: string) {
  const doc = docText.slice(0, ENRICH_DOC_CHARS);
  return [
    {
      role: 'system' as const,
      content: 'You write retrieval context. Given a document and one chunk of it, answer with ONE or TWO short sentences that situate the chunk within the document (what it is about, which section or entity it refers to), to improve search retrieval of the chunk. Answer with the context only — no preamble, no quotes, no lists.',
    },
    {
      role: 'user' as const,
      content: `${fenceUntrustedBlock(`TITLE: ${title}\n\n${doc}`, 'a knowledge-base document')}\n\n${fenceUntrustedBlock(chunk, 'the chunk to situate')}\n\nWrite the situating context for the chunk.`,
    },
  ];
}

/** Validate model output into a prefix: one line, at most two sentences and 400 chars.
 *  Empty or fence-echoing output is a TYPED failure, not an empty prefix. */
export function validatePrefix(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (flat.length === 0) throw new EnrichmentError('enrich_output_invalid', 'The model returned an empty context.');
  if (/\b(BEGIN|END)\s+UNTRUSTED\s+CONTENT\b/i.test(flat)) throw new EnrichmentError('enrich_output_invalid', 'The model echoed the untrusted-content fence.');
  const sentences = flat.match(/[^.!?]+[.!?]+/g);
  const two = sentences && sentences.length > 2 ? sentences.slice(0, 2).join('').trim() : flat;
  return two.length > MAX_PREFIX_CHARS ? `${two.slice(0, MAX_PREFIX_CHARS - 1).trimEnd()}…` : two;
}

/** Estimated tokens for ONE enrichment call (document slice + chunk + instructions). */
export function callTokens(docText: string, chunk: string): number {
  return estimateTokens(docText.slice(0, ENRICH_DOC_CHARS)) + estimateTokens(chunk) + 120 + MAX_OUTPUT_TOKENS;
}

export interface PrefixResult { prefixes: Array<string | null>; complete: boolean; calls: number }

/**
 * The prefixes for one document's chunks: cache hits first, then the misses through a
 * bounded pool, each durably reserved BEFORE provider dispatch. A budget stop
 * or a failed call leaves `null` for that chunk and `complete: false` — the caller does
 * not commit a half-enriched namespace.
 */
export async function prefixesFor(
  tenantId: string, collectionId: string,
  doc: KnowledgeDocument,
  chunks: readonly string[], enricher: LlmEnricher,
): Promise<PrefixResult> {
  // The service owns the document primary. Dynamic import avoids a runtime
  // cycle: this build is called only after both modules finish initialization.
  const { admitEnrichmentDocument, publishEnrichmentPrefix } = await import('./kbService.js');
  const source = await admitEnrichmentDocument(tenantId, collectionId, doc);
  if (!source) return { prefixes: chunks.map(() => null), complete: false, calls: 0 };
  const docHash = sha(source.text.slice(0, ENRICH_DOC_CHARS));
  const titleHash = sha(source.title);
  const rows = new Map((source.enrichmentCache ?? []).map(r => [r.chunkIndex, r]));
  const prefixes: Array<string | null> = chunks.map((c, i) => {
    const r = rows.get(i);
    return r && r.chunkHash === sha(c) && r.docHash === docHash && r.titleHash === titleHash && r.provider === enricher.provider && r.model === enricher.model ? r.prefix : null;
  });
  const misses = prefixes.map((p, i) => (p === null ? i : -1)).filter((i) => i >= 0);
  let complete = true;
  let calls = 0;
  let next = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (!stopped && next < misses.length) {
      const i = misses[next++]!;
      const chunk = chunks[i]!;
      const tokens = callTokens(doc.text, chunk);
      if ((await reserveEmbedBudget(tenantId, tokens)).exceeded) { stopped = true; complete = false; return; }
      try {
        calls += 1;
        const raw = await enricher.dispatch(buildEnrichMessages(doc.title, doc.text, chunk), { maxTokens: MAX_OUTPUT_TOKENS, timeoutMs: 30_000 });
        const prefix = validatePrefix(raw);
        const chosen = await publishEnrichmentPrefix(tenantId, collectionId, source, {
          tenantId, collectionId, documentId: source.documentId, chunkIndex: i,
          chunkHash: sha(chunk), docHash, titleHash, provider: enricher.provider, model: enricher.model, prefix,
        });
        if (chosen === null) complete = false;
        else prefixes[i] = chosen; // the first committed response wins a concurrent identical build
      } catch {
        complete = false; // this chunk stays un-enriched; the build reports incomplete
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, misses.length) }, worker));
  return { prefixes, complete: complete && prefixes.every((p) => p !== null), calls };
}

/** Cached prefixes for a whole collection (the in-memory BM25 path), by `${docId}:${idx}`,
 *  only where the chunk text still matches — so keywords see raw + prefix (wart 6). */
export async function cachedPrefixesForCollection(
  tenantId: string, orgId: string, collectionId: string, docs: readonly KnowledgeDocument[], frozenEnricher?: LlmEnricher,
): Promise<Map<string, { chunkHash: string; prefix: string }>> {
  const out = new Map<string, { chunkHash: string; prefix: string }>();
  const enricher = frozenEnricher ?? await resolveLlmEnricher(tenantId).catch(() => null);
  if (!enricher) return out;
  for (const doc of docs) {
    if (doc.tenantId !== tenantId || doc.orgId !== orgId || doc.collectionId !== collectionId || !doc.enrichmentGeneration) continue;
    const docHash = sha(doc.text.slice(0, ENRICH_DOC_CHARS)); const titleHash = sha(doc.title);
    for (const r of doc.enrichmentCache ?? []) {
      if (r.provider === enricher.provider && r.model === enricher.model && r.docHash === docHash && r.titleHash === titleHash) {
        out.set(`${doc.documentId}:${r.chunkIndex}`, { chunkHash: r.chunkHash, prefix: r.prefix });
      }
    }
  }
  return out;
}
export const chunkHashOf = sha;

export async function purgeEnrichCacheForDoc(tenantId: string, collectionId: string, documentId: string): Promise<number> {
  let n = 0;
  for (const r of await enrichCache.listByPrefix(`${tenantId}:${collectionId}:${documentId}:`)) {
    if (r.tenantId !== tenantId || r.documentId !== documentId) continue;
    await enrichCache.delete(`${r.tenantId}:${r.collectionId}:${r.documentId}:${r.chunkIndex}`);
    n += 1;
  }
  return n;
}

/** Orphan sweep (ADR 0077 retention): rows whose document no longer exists. */
export async function purgeOrphanEnrichRows(tenantId: string, liveDocumentIds: ReadonlySet<string>, inFlight: (documentId: string) => boolean): Promise<number> {
  let n = 0;
  for (const r of await enrichCache.listByPrefix(`${tenantId}:`)) {
    if (r.tenantId !== tenantId || liveDocumentIds.has(r.documentId) || inFlight(r.documentId)) continue;
    await enrichCache.delete(`${r.tenantId}:${r.collectionId}:${r.documentId}:${r.chunkIndex}`);
    n += 1;
  }
  return n;
}

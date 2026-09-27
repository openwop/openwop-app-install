/**
 * KB external (connection) reranker — ADR 0351 Phase 4 / CSG-KB-8.
 *
 * Reranks hybrid candidates through a vendor rerank API (Cohere /v2/rerank; the
 * `cohere-rerank` connection pack) with the tenant's connected key. Rides the
 * brokered-egress spine (`brokeredPost`): broker-resolved credential, SSRF
 * guard, https-only, no-redirect, bounded timeout — the secret never reaches
 * this module's caller.
 *
 * FAILURE IS A SIGNAL, NOT AN ERROR: any miss (no connection, secret
 * unresolvable, HTTP/timeout, malformed body) returns `null` and the caller
 * degrades HONESTLY to the local deterministic reranker, labeling the response
 * (`applied: 'local-degraded'`) — a search must not fail because a reranker is
 * down. Endpoint/model are host-operator config (non-secret infra), overridable
 * for tests via `OPENWOP_KB_RERANK_ENDPOINT` / `OPENWOP_KB_RERANK_MODEL`.
 */
import { brokeredPost } from '../../host/brokeredEgress.js';

/** The RFC 0095 provider id the retrieval config's `rerank:{kind:'connection'}` resolves. */
export const RERANK_PROVIDER = 'cohere-rerank';

const endpoint = (): string => process.env.OPENWOP_KB_RERANK_ENDPOINT || 'https://api.cohere.com/v2/rerank';
const model = (): string => process.env.OPENWOP_KB_RERANK_MODEL || 'rerank-v3.5';

export interface RerankDoc { id: string; text: string }

/** Rerank `docs` for `query`; top `topN` as [{id, score}] best-first, or null on any failure. */
export async function connectionRerank(
  tenantId: string,
  query: string,
  docs: ReadonlyArray<RerankDoc>,
  topN: number,
): Promise<Array<{ id: string; score: number }> | null> {
  if (docs.length === 0) return [];
  const n = Math.max(1, Math.min(topN, docs.length));
  const sent = await brokeredPost(
    { tenantId },
    {
      provider: RERANK_PROVIDER,
      url: endpoint(),
      body: JSON.stringify({ model: model(), query, documents: docs.map((d) => d.text), top_n: n }),
    },
  );
  if (sent.outcome !== 'sent' || !sent.res.ok) return null;
  try {
    const body = (await sent.res.json()) as { results?: Array<{ index?: number; relevance_score?: number }> };
    const ranked = (body.results ?? []).flatMap((r) => {
      const doc = typeof r.index === 'number' ? docs[r.index] : undefined;
      return doc ? [{ id: doc.id, score: typeof r.relevance_score === 'number' ? r.relevance_score : 0 }] : [];
    });
    return ranked.length > 0 ? ranked.slice(0, n) : null;
  } catch {
    return null; // malformed provider body — degrade, never throw into search
  }
}

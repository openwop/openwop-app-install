/**
 * ADR 0113 Phase 1 — deterministic lexical (BM25) channel + Reciprocal-Rank-Fusion.
 *
 * The hybrid retrieval's LEXICAL half: a BM25 ranking over the SAME durable chunk
 * text the dense `embedText` channel indexes (no parallel corpus — the caller
 * passes the chunk rows it already loads). Both BM25 and RRF are PURE +
 * DETERMINISTIC (id-stable tiebreak), so `mode:'hybrid'` re-derives an identical
 * ranking on `:fork`/replay with NOTHING recorded — preserving the ADR 0011
 * retrieval-determinism invariant (see ADR 0113 §Replay).
 *
 * BM25 closes the local-hash embedder's lexical blind spots (exact terms, rare
 * tokens, IDs) that cosine over a 256-dim hash misses.
 */

const TOKEN_RE = /[a-z0-9]+/g;

/** Lowercase alphanumeric tokenizer — deterministic, locale-independent. */
export function tokenize(s: string): string[] {
  return s.toLowerCase().match(TOKEN_RE) ?? [];
}

/** Okapi BM25 over a chunk corpus. Deterministic; ties broken by ascending id so
 *  the order is stable across runs (replay-safe). Returns the top-`topK` ids with
 *  their BM25 score (only positive scores). */
export function bm25Search(
  docs: ReadonlyArray<{ id: string; text: string }>,
  query: string,
  topK: number,
  k1 = 1.5,
  b = 0.75,
): Array<{ id: string; score: number }> {
  const qTerms = [...new Set(tokenize(query))];
  if (qTerms.length === 0 || docs.length === 0) return [];

  const docTokens = docs.map((d) => tokenize(d.text));
  const N = docs.length;
  const avgdl = (docTokens.reduce((s, t) => s + t.length, 0) / N) || 1;

  // Document frequency per query term.
  const df = new Map<string, number>();
  for (const term of qTerms) {
    let c = 0;
    for (const toks of docTokens) if (toks.includes(term)) c++;
    df.set(term, c);
  }

  const scored: Array<{ id: string; score: number }> = [];
  for (let i = 0; i < docs.length; i++) {
    const toks = docTokens[i]!;
    const dl = toks.length;
    let score = 0;
    for (const term of qTerms) {
      const n = df.get(term)!;
      if (n === 0) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const tf = toks.reduce((acc, t) => (t === term ? acc + 1 : acc), 0);
      if (tf === 0) continue;
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / avgdl)));
    }
    if (score > 0) scored.push({ id: docs[i]!.id, score });
  }
  scored.sort((a, c) => c.score - a.score || (a.id < c.id ? -1 : 1));
  return scored.slice(0, topK);
}

/** Reciprocal-Rank-Fusion: fuse N ranked id-lists into one, `score = Σ 1/(k+rank)`
 *  (rank 0-based). Score-scale-free, so the cosine and BM25 lists (different score
 *  scales) combine cleanly. Deterministic id tiebreak. */
export function rrfFuse(
  lists: ReadonlyArray<ReadonlyArray<{ id: string }>>,
  k = 60,
  topK?: number,
): Array<{ id: string; score: number }> {
  const score = new Map<string, number>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank]!.id;
      score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1));
    }
  }
  const out = [...score.entries()].map(([id, s]) => ({ id, score: s }));
  out.sort((a, c) => c.score - a.score || (a.id < c.id ? -1 : 1));
  return topK !== undefined ? out.slice(0, topK) : out;
}

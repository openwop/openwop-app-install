/**
 * ADR 0113 Phase 2 — deterministic LOCAL reranker (the "native reranker" posture).
 *
 * A cross-encoder-STYLE scorer that JOINTLY scores (query, candidate) over local
 * lexical features — query-term coverage, title overlap, exact-phrase presence,
 * and term density — to reorder the fused candidates before truncation to top-k.
 * Unlike the bag-of-words channels, it rewards a candidate that covers MORE of the
 * query and contains the query as a phrase, which is what a cross-encoder learns.
 *
 * PURE + DETERMINISTIC (id-stable tiebreak): `mode:'hybrid+rerank'` with the local
 * reranker re-derives an identical order on `:fork`/replay with NOTHING recorded —
 * preserving the ADR 0011 retrieval-determinism invariant (ADR 0113 §Replay). The
 * EXTERNAL reranker (Phase 4) is nondeterministic and must record-and-replay.
 */
import { tokenize } from './lexicalIndex.js';

/** Joint (query, candidate) relevance score over deterministic local features. */
export function localRerankScore(query: string, text: string, title: string): number {
  const qTerms = [...new Set(tokenize(query))];
  if (qTerms.length === 0) return 0;

  const textToks = tokenize(text);
  const textSet = new Set(textToks);
  const titleSet = new Set(tokenize(title));

  const covered = qTerms.filter((t) => textSet.has(t)).length;
  const coverage = covered / qTerms.length;                    // fraction of query terms present
  const titleOverlap = qTerms.filter((t) => titleSet.has(t)).length / qTerms.length;
  const phrase = qTerms.join(' ');
  const phraseBonus = qTerms.length > 1 && textToks.join(' ').includes(phrase) ? 1 : 0;
  const density = textToks.length > 0 ? covered / textToks.length : 0;

  // Weighted blend — coverage dominates (the cross-encoder's core signal), title +
  // exact-phrase are strong secondary boosts, density a mild tiebreak.
  return coverage * 3 + titleOverlap * 2 + phraseBonus * 2 + density;
}

/** Reorder candidates by the local reranker score, returning the top-`topN`.
 *  Deterministic; ties broken by ascending id. */
export function localRerank(
  query: string,
  candidates: ReadonlyArray<{ id: string; text: string; title: string }>,
  topN: number,
): Array<{ id: string; score: number }> {
  return candidates
    .map((c) => ({ id: c.id, score: localRerankScore(query, c.text, c.title) }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, topN);
}

/**
 * ADR 0946 P1 (D2/D3) — copy similarity, moved from the campaign-channels pack
 * so there is ONE implementation. Packs read a generated copy
 * (`scripts/gen-content-rules.mjs` transpiles this file); edit here, then
 * regenerate.
 *
 * Token-set Jaccard over lowercase word sets: a deterministic stand-in for
 * embedding cosine (ADR 0355 correction) that needs no provider. Pure, so it
 * is replay-safe. This module must stay import-free: it is copied into packs.
 */

export interface NearDuplicatePair {
  a: number;
  b: number;
  similarity: number;
}

/** Pairs of texts whose token-set Jaccard similarity is at least `threshold`. */
export function findNearDuplicates(texts: unknown[], threshold = 0.8): NearDuplicatePair[] {
  const sets = texts.map((t) => new Set(String(t ?? '').toLowerCase().match(/[a-z0-9']+/g) ?? []));
  const pairs: NearDuplicatePair[] = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i];
      const b = sets[j];
      if (a.size === 0 || b.size === 0) continue;
      let inter = 0;
      for (const w of a) if (b.has(w)) inter += 1;
      const jaccard = inter / (a.size + b.size - inter);
      if (jaccard >= threshold) pairs.push({ a: i, b: j, similarity: Math.round(jaccard * 100) / 100 });
    }
  }
  return pairs;
}

/**
 * A5 — real local embeddings. Deterministic, unit-norm, and cosine-meaningful
 * (related text scores higher than unrelated), driving the host.db.vector store.
 *
 * TST-DKE-5 (grade-tests wave 72). The relatedness case pins the VALUES, derived
 * by hand from the token overlap (feature hashing with no bucket collision in
 * this fixture): q = {how, do, configure, workflow, engine}, related =
 * {configuring, workflow, engine, settings} share 2 unit-weight tokens, so
 * cos = 2 / (√5 · √4) = 2/√20 ≈ 0.4472; the unrelated text shares none, so 0.
 * Red when (w72 probes): vectors are not L2-normalized (em-norm), hashing is not
 * deterministic (em-det), or tokenization stops splitting words (em-token).
 */

import { describe, expect, it } from 'vitest';
import { embedText, DEFAULT_EMBEDDING_DIMS } from '../src/aiProviders/localEmbedding.js';

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i]! * b[i]!;
  return dot;
}

describe('local embedding (A5)', () => {
  it('is deterministic and unit-normalized', () => {
    const a = embedText('workflow orchestration engine');
    const b = embedText('workflow orchestration engine');
    expect(a).toEqual(b);
    expect(a).toHaveLength(DEFAULT_EMBEDDING_DIMS);
    expect(cosine(a, a)).toBeCloseTo(1, 5);
  });

  it('scores related text higher than unrelated', () => {
    const q = embedText('how do I configure the workflow engine');
    const related = embedText('configuring the workflow engine settings');
    const unrelated = embedText('banana smoothie recipe with mango');
    expect(cosine(q, related)).toBeGreaterThan(cosine(q, unrelated));
    expect(cosine(q, related)).toBeCloseTo(2 / Math.sqrt(20), 4);
    expect(cosine(q, unrelated)).toBeCloseTo(0, 6);
  });
});

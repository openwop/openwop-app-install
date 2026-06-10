/**
 * A5 — real local embeddings. Deterministic, unit-norm, and cosine-meaningful
 * (related text scores higher than unrelated), driving the host.db.vector store.
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
  });
});

/**
 * A5 — embedding-relevance (RAG) recall on the agent memory adapter. Proves the
 * `read(scope, query)` path ranks prior memory by cosine similarity over the
 * host.db.vector cosine store (fed by every write at DEFAULT_EMBEDDING_DIMS),
 * while `read(scope)` with no query keeps the recency back-compat. Tenant
 * isolation (CTI-1) holds through the vector path too.
 *
 * Sabotage that turns this red (grade-tests w11 probes): reversing the vector ranking
 * (case 1); one shared vector bucket for every tenant (CTI-1); a recency read returning
 * nothing or oldest-first (case 2); returning the empty vector result instead of falling
 * back (case 4).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces, writeMemoryEntry } from '../src/host/inMemorySurfaces.js';
import { createAgentMemoryPort, agentMemoryScope } from '../src/host/agentMemoryAdapter.js';

beforeAll(() => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-rag-')) });
});

describe('A5 — RAG recall on agent memory', () => {
  it('ranks the semantically-relevant entry first for a query', async () => {
    const port = createAgentMemoryPort('tenant-rag');
    const scope = agentMemoryScope('rag.agent');
    await port.write(scope, { content: 'The invoice total was 500 dollars and is overdue.' });
    await port.write(scope, { content: 'The weather forecast is sunny with light winds.' });
    await port.write(scope, { content: 'A kubernetes pod crashed with an out-of-memory error.' });

    const hits = await port.read(scope, 'how much was the overdue invoice');
    expect(hits.length).toBeGreaterThan(0);
    // The invoice entry is the most lexically/semantically similar → ranked top.
    expect(hits[0]?.content).toContain('invoice');
  });

  /** Two rows written to the STORE directly — never indexed, so the vector path has nothing
   *  for this scope — with fixed, distinct `createdAt` (two `port.write`s in one ms tie, which
   *  would make an order assertion flaky). No TTL, so the clock-shift lane cannot expire them. */
  async function seedUnindexed(tenantId: string, scope: string): Promise<void> {
    await writeMemoryEntry(tenantId, scope, { content: 'older note', tags: [], createdAt: '2026-01-01T00:00:00.000Z' });
    await writeMemoryEntry(tenantId, scope, { content: 'newer note', tags: [], createdAt: '2026-01-02T00:00:00.000Z' });
  }

  it('read without a query returns recency (back-compat, A4)', async () => {
    const scope = agentMemoryScope('rag.agent2');
    await seedUnindexed('tenant-rag2', scope);
    const all = await createAgentMemoryPort('tenant-rag2').read(scope);
    // Recency = newest first, exactly.
    expect(all.map((e) => e.content)).toEqual(['newer note', 'older note']);
  });

  it('RAG recall is tenant-isolated (CTI-1)', async () => {
    const scope = agentMemoryScope('shared.rag');
    await createAgentMemoryPort('tenant-rx').write(scope, { content: 'rx-only invoice secret' });
    const other = await createAgentMemoryPort('tenant-ry').read(scope, 'invoice');
    expect(other.map((e) => e.content)).not.toContain('rx-only invoice secret');
  });

  it('falls back to recency when the vector store has no match for the scope', async () => {
    // The rows are NOT indexed, so the vector path returns nothing for this scope and only the
    // recency fallback can answer. (This used to `port.write` one entry — which IS indexed — so
    // the vector path answered and the fallback never ran; grade-tests w11 probe was vacuous.)
    const scope = agentMemoryScope('rag.agent3');
    await seedUnindexed('tenant-rag3', scope);
    const hits = await createAgentMemoryPort('tenant-rag3').read(scope, 'anything at all');
    expect(hits.map((e) => e.content)).toEqual(['newer note', 'older note']);
  });
});

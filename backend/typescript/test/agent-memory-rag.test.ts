/**
 * A5 — embedding-relevance (RAG) recall on the agent memory adapter. Proves the
 * `read(scope, query)` path ranks prior memory by cosine similarity over the
 * host.db.vector cosine store (fed by every write at DEFAULT_EMBEDDING_DIMS),
 * while `read(scope)` with no query keeps the recency back-compat. Tenant
 * isolation (CTI-1) holds through the vector path too.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
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

  it('read without a query returns recency (back-compat, A4)', async () => {
    const port = createAgentMemoryPort('tenant-rag2');
    const scope = agentMemoryScope('rag.agent2');
    await port.write(scope, { content: 'first note' });
    await port.write(scope, { content: 'second note' });
    const all = await port.read(scope);
    const contents = all.map((e) => e.content);
    expect(contents).toContain('first note');
    expect(contents).toContain('second note');
  });

  it('RAG recall is tenant-isolated (CTI-1)', async () => {
    const scope = agentMemoryScope('shared.rag');
    await createAgentMemoryPort('tenant-rx').write(scope, { content: 'rx-only invoice secret' });
    const other = await createAgentMemoryPort('tenant-ry').read(scope, 'invoice');
    expect(other.map((e) => e.content)).not.toContain('rx-only invoice secret');
  });

  it('falls back to recency when the vector store has no match for the scope', async () => {
    const port = createAgentMemoryPort('tenant-rag3');
    const scope = agentMemoryScope('rag.agent3');
    await port.write(scope, { content: 'only entry here' });
    // A query still returns the entry (single-entry scope ranks it first).
    const hits = await port.read(scope, 'anything at all');
    expect(hits.map((e) => e.content)).toContain('only entry here');
  });
});

/**
 * ADR 0351 Phase 2 — the strict grounded-generation contract. Pins:
 *  - kb ragQuery coverage classification (none/thin/ok, count-based) + minScore;
 *  - the brief's groundingPolicy field (validated, 400 on junk);
 *  - kernel + channel nodes FAIL CLOSED under strict (no collection bound /
 *    rag error / coverage none → structured grounding_insufficient) and carry
 *    the grounding label on success; `off` skips retrieval entirely.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { createCollection, ingestDocument, ragQuery } from '../src/features/kb/kbService.js';
import { createBrief, __clearBriefs } from '../src/features/campaign-brief/briefService.js';
import { nodes as briefNodes } from '../../../packs/feature.campaign-brief.nodes/index.mjs';
import { nodes as channelNodes } from '../../../packs/feature.campaign-channels.nodes/index.mjs';

const OK_AI = async () => ({ data: { headline: 'H', supportingStatement: 'S', proofPoints: ['P'], primaryCta: 'C', tone: 't' } });
const CHANNEL_AI = async () => ({ data: { headline: 'H', heroSubhead: 'S', sections: [], seoTitle: 'T', seoDescription: 'D', primaryCta: 'C' } });

function briefFeature(brief: Record<string, unknown>) {
  return {
    assembleContext: async () => ({ found: true, brief, contextText: 'CONTEXT', valid: true, enabledChannels: ['landing_page'], kernel: { headline: 'H', primaryCta: 'C', proofPoints: [] } }),
    setKernel: async () => ({ brief: { id: 'b1' } }),
    getKernel: async () => ({ found: true, kernel: { headline: 'H', primaryCta: 'C', proofPoints: [] } }),
  };
}

describe('kb coverage classification (ADR 0351 P2)', () => {
  beforeAll(async () => {
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-gp-')) });
    initHostExtPersistence(openSqliteStorage(':memory:'));
  });

  it('none (0 hits) / ok (≥2 hits) / minScore filters before classification', async () => {
    const t = 'gp-tenant';
    const col = await createCollection(t, 'o1', 'u1', { name: 'C' });
    const empty = await ragQuery(t, 'o1', col.collectionId, 'zebra quantum', 5);
    expect(empty.coverage).toBe('none');

    await ingestDocument(t, 'o1', 'u1', col.collectionId, { title: 'A', text: 'FlashPick robotic picking speeds grocery fulfillment.' });
    await ingestDocument(t, 'o1', 'u1', col.collectionId, { title: 'B', text: 'Robotic picking reduces labor cost in grocery warehouses.' });
    const ok = await ragQuery(t, 'o1', col.collectionId, 'robotic picking grocery', 5);
    expect(ok.coverage).toBe('ok');
    expect(ok.contexts.length).toBeGreaterThanOrEqual(2);

    // An absurd minScore filters every hit → coverage none (caller-supplied floor).
    const floored = await ragQuery(t, 'o1', col.collectionId, 'robotic picking grocery', 5, { minScore: 999 });
    expect(floored.coverage).toBe('none');
    expect(floored.contexts).toEqual([]);
  });
});

describe('brief groundingPolicy field', () => {
  beforeEach(async () => {
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __clearBriefs();
  });

  it('stores valid values; rejects junk with 400', async () => {
    const b = await createBrief('gp-t', 'o1', 'u1', { name: 'B', productName: 'X', groundingPolicy: 'strict', messaging: { primaryValueProp: 'v' } });
    expect(b.groundingPolicy).toBe('strict');
    await expect(createBrief('gp-t', 'o1', 'u1', { name: 'B2', productName: 'X', groundingPolicy: 'very-strict', messaging: { primaryValueProp: 'v' } }))
      .rejects.toMatchObject({ httpStatus: 400 });
  });
});

describe('strict fail-closed in the generation nodes', () => {
  it('kernel: strict + no KB binding → grounding_insufficient', async () => {
    const features = { 'campaign-brief': briefFeature({ id: 'b1', orgId: 'o1', productName: 'X', groundingPolicy: 'strict' }) };
    const out = await briefNodes['feature.campaign-brief.nodes.generate-kernel']({ features, callAI: OK_AI, inputs: { briefId: 'b1' } });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('grounding_insufficient');
  });

  it('kernel: strict + coverage none → grounding_insufficient; ok coverage succeeds labeled', async () => {
    // Citations carry `documentId` — the REAL kbService RagResult shape (KB-CODE-1).
    const mk = (coverage: string) => ({
      'campaign-brief': briefFeature({ id: 'b1', orgId: 'o1', productName: 'X', kbCollectionId: 'kb1', groundingPolicy: 'strict' }),
      kb: { rag: async () => ({ augmentedPrompt: coverage === 'none' ? '' : 'GROUNDED', citations: coverage === 'none' ? [] : [{ documentId: 'd1', title: 'D' }], coverage, embedding: { mode: 'local', model: 'local-hash-v1' } }) },
    });
    const failed = await briefNodes['feature.campaign-brief.nodes.generate-kernel']({ features: mk('none'), callAI: OK_AI, inputs: { briefId: 'b1' } });
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('grounding_insufficient');

    const ok = await briefNodes['feature.campaign-brief.nodes.generate-kernel']({ features: mk('ok'), callAI: OK_AI, inputs: { briefId: 'b1' } });
    expect(ok.status).toBe('success');
    expect(ok.outputs?.grounding).toMatchObject({ policy: 'strict', coverage: 'ok' });
    // KB-CODE-1: the kernel traces its sources — a grounded generation MUST
    // carry non-empty sourceDocIds or Phase-3 staleness propagation is dead.
    expect((ok.outputs?.kernel as Record<string, unknown>).sourceDocIds).toEqual(['d1']);
  });

  it('kernel: strict defaults a relevance floor into kb.rag; explicit minScore wins; best-effort passes none (KB-CODE-2)', async () => {
    const ragArgs: Array<Record<string, unknown>> = [];
    const mkFeatures = (policy?: string) => ({
      'campaign-brief': briefFeature({ id: 'b1', orgId: 'o1', productName: 'X', kbCollectionId: 'kb1', ...(policy ? { groundingPolicy: policy } : {}) }),
      kb: { rag: async (args: Record<string, unknown>) => { ragArgs.push(args); return { augmentedPrompt: 'GROUNDED', citations: [{ documentId: 'd1', title: 'D' }], coverage: 'ok' }; } },
    });
    const strict = await briefNodes['feature.campaign-brief.nodes.generate-kernel']({ features: mkFeatures('strict'), callAI: OK_AI, inputs: { briefId: 'b1' } });
    expect(strict.status).toBe('success');
    expect(ragArgs[0]).toMatchObject({ minScore: 0.25 }); // strict fails closed on noise, not just emptiness

    const bestEffort = await briefNodes['feature.campaign-brief.nodes.generate-kernel']({ features: mkFeatures(), callAI: OK_AI, inputs: { briefId: 'b1' } });
    expect(bestEffort.status).toBe('success');
    expect(ragArgs[1]).not.toHaveProperty('minScore'); // best-effort behavior unchanged

    const explicit = await briefNodes['feature.campaign-brief.nodes.generate-kernel']({ features: mkFeatures('strict'), callAI: OK_AI, inputs: { briefId: 'b1', minScore: 0.5 } });
    expect(explicit.status).toBe('success');
    expect(ragArgs[2]).toMatchObject({ minScore: 0.5 }); // caller-supplied floor wins
  });

  it('kernel: strict + rag THROWS → grounding_insufficient (never silent)', async () => {
    const features = {
      'campaign-brief': briefFeature({ id: 'b1', orgId: 'o1', productName: 'X', kbCollectionId: 'kb1', groundingPolicy: 'strict' }),
      kb: { rag: async () => { throw new Error('kb down'); } },
    };
    const out = await briefNodes['feature.campaign-brief.nodes.generate-kernel']({ features, callAI: OK_AI, inputs: { briefId: 'b1' } });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('grounding_insufficient');
  });

  it('kernel: best-effort + rag THROWS still succeeds (today\'s behavior held)', async () => {
    const features = {
      'campaign-brief': briefFeature({ id: 'b1', orgId: 'o1', productName: 'X', kbCollectionId: 'kb1' }),
      kb: { rag: async () => { throw new Error('kb down'); } },
    };
    const out = await briefNodes['feature.campaign-brief.nodes.generate-kernel']({ features, callAI: OK_AI, inputs: { briefId: 'b1' } });
    expect(out.status).toBe('success');
  });

  it('kernel: off skips retrieval entirely', async () => {
    let ragCalled = false;
    const features = {
      'campaign-brief': briefFeature({ id: 'b1', orgId: 'o1', productName: 'X', kbCollectionId: 'kb1', groundingPolicy: 'off' }),
      kb: { rag: async () => { ragCalled = true; return { augmentedPrompt: 'G', citations: [] }; } },
    };
    const out = await briefNodes['feature.campaign-brief.nodes.generate-kernel']({ features, callAI: OK_AI, inputs: { briefId: 'b1' } });
    expect(out.status).toBe('success');
    expect(ragCalled).toBe(false);
    expect(out.outputs?.grounding).toMatchObject({ policy: 'off' });
  });

  it('channel generate: strict + coverage none → grounding_insufficient; ok succeeds labeled', async () => {
    const mk = (coverage: string) => ({
      'campaign-brief': briefFeature({ id: 'b1', orgId: 'o1', productName: 'X', kbCollectionId: 'kb1', groundingPolicy: 'strict' }),
      kb: { rag: async () => ({ augmentedPrompt: coverage === 'none' ? '' : 'GROUNDED', citations: [], coverage }) },
    });
    const failed = await channelNodes['feature.campaign-channels.nodes.generate']({ features: mk('none'), callAI: CHANNEL_AI, inputs: { briefId: 'b1', channel: 'landing_page' } });
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('grounding_insufficient');

    const ok = await channelNodes['feature.campaign-channels.nodes.generate']({ features: mk('ok'), callAI: CHANNEL_AI, inputs: { briefId: 'b1', channel: 'landing_page' } });
    expect(ok.status).toBe('success');
    expect(ok.outputs?.grounding).toMatchObject({ policy: 'strict', coverage: 'ok' });
  });
});

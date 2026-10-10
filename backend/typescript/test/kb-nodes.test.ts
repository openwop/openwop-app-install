/**
 * feature.kb.nodes — the KB feature node pack over `ctx.features.kb` (ADR 0014
 * Phase 2). Proves a feature-shipped action node calls its feature surface and
 * returns recorded outputs, plus the capability-missing backstop. Drives the
 * node functions directly against a ctx built from the real host bundle.
 *
 * CORRECTED (grade-tests wave 6): this header used to say the end-to-end
 * pack-in-a-run path was "already covered by knowledge-surface.test.ts" — that
 * file never references `feature.kb.nodes`. The `rag` node in a real chain is
 * driven by `kb-rag-chain-wiring.test.ts` and
 * `workflow-chain-knowledge-execution.test.ts`; `search` and the capability
 * backstop are covered only here.
 *
 * Sabotage witnesses: returning `results: []` from `search`, an empty
 * `augmentedPrompt` / `citations` from `rag`, or skipping `ensureKb`'s check
 * each turn the matching case red.
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { createCollection, ingestDocument } from '../src/features/kb/kbService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

type NodeCtx = { inputs: Record<string, unknown>; features: unknown };
/** The slice of the untyped `.mjs` pack this test drives (no `.d.ts` ships with it). */
interface KbNodePack {
  search(ctx: NodeCtx): Promise<{ status: string; outputs: { results: Array<{ title: string; text: string }> } }>;
  rag(ctx: NodeCtx): Promise<{ status: string; outputs: { augmentedPrompt: string; citations: Array<{ title: string }> } }>;
}
let pack: KbNodePack;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  const kb = getToggleDefault('kb');
  if (kb) await saveConfig({ ...kb, status: 'on' }, 'test');
  // @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does)
  pack = await import('../../../packs/feature.kb.nodes/index.mjs');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const ctxFor = (tenantId: string, inputs: Record<string, unknown>) => ({
  inputs,
  features: buildHostSurfaceBundle({ tenantId }).features,
});

describe('feature.kb.nodes', () => {
  it('search node retrieves chunks via ctx.features.kb', async () => {
    const tenantId = 'kb-node-tenant';
    const orgId = 'org-1';
    const col = await createCollection(tenantId, orgId, 'actor', { name: 'Docs' });
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: 'Cats', text: 'Cats groom themselves and purr when content.' });

    const out = await pack.search(ctxFor(tenantId, { orgId, collectionId: col.collectionId, query: 'cats groom' }));
    expect(out.status).toBe('success');
    expect(out.outputs.results.length).toBeGreaterThan(0);
    expect(out.outputs.results[0]!.title).toBe('Cats');
  });

  it('rag node returns an augmented prompt + citations grounded in the collection', async () => {
    const tenantId = 'kb-rag-tenant';
    const orgId = 'org-1';
    const col = await createCollection(tenantId, orgId, 'actor', { name: 'KB' });
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: 'Kittens', text: 'A kitten is a young cat that loves to play and pounce.' });

    const out = await pack.rag(ctxFor(tenantId, { orgId, collectionId: col.collectionId, query: 'what do kittens do' }));
    expect(out.status).toBe('success');
    expect(out.outputs.augmentedPrompt).toContain('kitten');
    expect(out.outputs.augmentedPrompt).toContain('Question: what do kittens do');
    expect(out.outputs.citations[0]!.title).toBe('Kittens');
  });

  it('throws host_capability_missing when ctx.features.kb is absent', async () => {
    await expect(pack.search({ inputs: { query: 'x' }, features: {} }))
      .rejects.toMatchObject({ code: 'host_capability_missing', capability: 'host.sample.kb' });
  });
});

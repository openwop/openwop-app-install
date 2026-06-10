/**
 * feature.kb.nodes — the KB feature node pack over `ctx.features.kb` (ADR 0014
 * Phase 2). Proves a feature-shipped action node calls its feature surface and
 * returns recorded outputs, plus the capability-missing backstop. Drives the
 * node functions directly against a ctx built from the real host bundle (the
 * end-to-end pack-in-a-run path is already covered by knowledge-surface.test.ts).
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { createCollection, ingestDocument } from '../src/features/kb/kbService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pack: any;
let server: http.Server;
const PORT = 18200;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
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
    expect(out.outputs.results[0].title).toBe('Cats');
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
    expect(out.outputs.citations.length).toBeGreaterThan(0);
  });

  it('throws host_capability_missing when ctx.features.kb is absent', async () => {
    await expect(pack.search({ inputs: { query: 'x' }, features: {} }))
      .rejects.toMatchObject({ code: 'host_capability_missing', capability: 'host.sample.kb' });
  });
});

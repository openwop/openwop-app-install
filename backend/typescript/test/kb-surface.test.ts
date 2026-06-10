/**
 * ctx.features.kb — the reference feature workflow surface (ADR 0014 Phase 1).
 * Proves a feature contributes a typed `ctx.features.<id>` surface (registered by
 * the composer at boot, bound into the host bundle per run), that it reads the
 * REAL KB store, and that tenant isolation (CTI-1) holds — a collection in
 * another tenant is simply not found.
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { createCollection, ingestDocument } from '../src/features/kb/kbService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let server: http.Server;
const PORT = 18199;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
  const kb = getToggleDefault('kb');
  if (kb) await saveConfig({ ...kb, status: 'on' }, 'test'); // tenant-wide retrieve is toggle-aware
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const kbSurface = (tenantId: string) => {
  const features = buildHostSurfaceBundle({ tenantId }).features;
  return features.kb!;
};

describe('ctx.features.kb surface', () => {
  it('is registered by the composer and reads the real KB store', async () => {
    const tenantId = 'surf-tenant';
    const orgId = 'org-a';
    const col = await createCollection(tenantId, orgId, 'actor', { name: 'Docs' });
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: 'Cats', text: 'Cats groom and purr.' });

    const kb = kbSurface(tenantId);
    expect(typeof kb.search).toBe('function');

    const searched = await kb.search!({ orgId, collectionId: col.collectionId, query: 'cats groom' });
    const results = searched.results as Array<{ documentId: string; title: string }>;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.title).toBe('Cats');

    // Tenant-wide retrieve (the host.knowledge shape).
    const retrieved = await kb.retrieve!({ query: 'how do cats purr' });
    expect(retrieved.hasResults).toBe(true);

    // listCollections (read).
    const cols = (await kb.listCollections!({ orgId })).collections as Array<{ collectionId: string }>;
    expect(cols.some((c) => c.collectionId === col.collectionId)).toBe(true);
  });

  it('enforces tenant isolation (CTI-1): another tenant cannot read this collection', async () => {
    const col = await createCollection('owner-tenant', 'org-x', 'actor', { name: 'Private' });
    await ingestDocument('owner-tenant', 'org-x', 'actor', col.collectionId, { title: 'Secret', text: 'classified content' });

    // A different tenant's surface, using the (leaked) collectionId → not found.
    const intruder = kbSurface('other-tenant');
    await expect(intruder.search!({ orgId: 'org-x', collectionId: col.collectionId, query: 'classified' })).rejects.toThrow();
  });
});

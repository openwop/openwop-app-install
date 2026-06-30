/**
 * host.knowledge backed by the REAL KB store (ADR 0014 Phase 0 — the
 * setKnowledgeBackend seam; closes ADR-0011's "back host.knowledge" question).
 *
 * Proves the surface resolves through the injected KB backend when a tenant has
 * real collections (KB enabled), and falls back to the seeded demo corpus
 * otherwise — so the demo keeps working and the wire shape is identical.
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCollection, ingestDocument } from '../src/features/kb/kbService.js';

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, res); });
  // The KB feature installs the knowledge backend at boot; enable the toggle so
  // tenantRetrieve serves real data (it is toggle-aware).
  const kb = getToggleDefault('kb');
  if (kb) await saveConfig({ ...kb, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const knowledge = (tenantId: string) => buildHostSurfaceBundle({ tenantId }).knowledge;

describe('host.knowledge — real KB backend', () => {
  it('serves a tenant\'s ingested KB collection via ctx.knowledge', async () => {
    const tenantId = 'kb-real-tenant';
    const orgId = 'org-1';
    const col = await createCollection(tenantId, orgId, 'actor', { name: 'Feline KB' });
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, {
      title: 'Cats',
      text: 'Cats groom themselves with their tongue and purr when content. A kitten is a young cat.',
    });

    const res = await knowledge(tenantId).retrieve({ query: 'how do cats groom and purr' }) as {
      chunks: Array<{ content: string; documentTitle: string; collectionId: string; relevanceScore: number }>;
      hasResults: boolean;
    };
    expect(res.hasResults).toBe(true);
    expect(res.chunks.length).toBeGreaterThan(0);
    // REAL KB content (not the seeded demo corpus).
    expect(res.chunks[0]!.documentTitle).toBe('Cats');
    expect(res.chunks[0]!.content).toContain('groom');
    expect(res.chunks[0]!.collectionId).toBe(col.collectionId);
    // It is NOT the demo corpus.
    expect(res.chunks.some((c) => c.documentTitle === 'Employee Handbook')).toBe(false);
  });

  it('falls back to the seeded demo corpus for a tenant with no KB collections', async () => {
    const res = await knowledge('no-kb-tenant').retrieve({ query: 'how do I rotate API keys and report secret leakage' }) as {
      chunks: Array<{ assetId: string }>;
      hasResults: boolean;
    };
    expect(res.hasResults).toBe(true);
    // The demo corpus security chunk ranks top.
    expect(res.chunks[0]!.assetId).toBe('doc-security');
  });
});

/**
 * v1 end-of-support (2026-10-04) — the installed-pack reads `openwop catalog`
 * uses (`/v1/packs`, `/-/search`, `/export`, `/{name}`) were the v1 Registry HTTP
 * API, a v1 surface that retired with v1. They ALSO live at the host's vendor
 * address (`/host/openwop-app/packs/…`), which survives the cut. Public, like
 * the v1 originals. (ADR 0812 P3c removed the served-v1 legs with major 1.)
 *
 * Bodies are asserted, not just statuses: a 200 with an empty catalog or an
 * empty search is not "the vendor home serves" (8f W4 probe ve-search-empty was
 * vacuous against the status-only version). The 410 must carry the
 * protocol_version_unsupported envelope naming the surviving address.
 *
 * Witnessed: ve-root-gone, ve-search-error, ve-v1-not-gone, ve-search-empty-r2.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';

let server: http.Server; let base = '';
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

interface Catalog { packs: Array<{ name: string; nodes: string[] }>; total: number }
interface SearchResult { results: Array<{ typeId: string }>; total: number; q: string }
interface ExportBody { manifests: unknown[]; total: number }
interface GoneBody { error: string; message: string }

const get = async <T>(path: string): Promise<{ status: number; body: T }> => {
  const r = await fetch(`${base}${path}`);
  return { status: r.status, body: (await r.json()) as T };
};
const READS = ['/packs', '/packs/-/search?q=core', '/packs/export'];

describe('the catalog reads have a vendor home that survives the v1 cut', () => {
  it('the vendor address serves, unauthenticated; the v1 Registry HTTP API is gone', async () => {
    const catalog = await get<Catalog>('/host/openwop-app/packs');
    expect(catalog.status).toBe(200);
    expect(catalog.body.packs.some((p) => p.name.startsWith('core.')), 'the catalog lists the installed core packs').toBe(true);
    expect(catalog.body.total).toBe(catalog.body.packs.length);

    const exported = await get<ExportBody>('/host/openwop-app/packs/export');
    expect(exported.status).toBe(200);
    expect(Array.isArray(exported.body.manifests)).toBe(true);
    expect(exported.body.total).toBe(exported.body.manifests.length);

    for (const p of READS) {
      const gone = await get<GoneBody>(`/v1${p}`);
      expect(gone.status, `/v1${p}`).toBe(410);
      expect(gone.body.error).toBe('protocol_version_unsupported');
      expect(gone.body.message).toMatch(/unversioned paths/);
    }
  });

  it('the vendor search answers a search result, not an error envelope', async () => {
    const r = await get<SearchResult & { error?: unknown }>('/host/openwop-app/packs/-/search?q=core');
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('error');
    expect(r.body.q).toBe('core');
    expect(r.body.results.length, 'a search for "core" must find the core node types').toBeGreaterThan(0);
    expect(r.body.results.every((x) => x.typeId.includes('core'))).toBe(true);
    expect(r.body.total).toBe(r.body.results.length);
  });
});

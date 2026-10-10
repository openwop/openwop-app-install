/**
 * v1 end-of-support (2026-10-04) — the installed-pack reads `openwop catalog`
 * uses (`/v1/packs`, `/-/search`, `/export`, `/{name}`) were the v1 Registry HTTP
 * API, a v1 surface that retired with v1. They ALSO live at the host's vendor
 * address (`/host/openwop-app/packs/…`), which survives the cut. Public, like
 * the v1 originals. (ADR 0812 P3c removed the served-v1 legs with major 1.)
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

const status = async (path: string): Promise<number> => (await fetch(`${base}${path}`)).status;
const READS = ['/packs', '/packs/-/search?q=core', '/packs/export'];

describe('the catalog reads have a vendor home that survives the v1 cut', () => {
  it('the vendor address serves, unauthenticated; the v1 Registry HTTP API is gone', async () => {
    for (const p of READS) {
      expect(await status(`/host/openwop-app${p}`), `/host/openwop-app${p}`).toBe(200);
      expect(await status(`/v1${p}`), `/v1${p}`).toBe(410);
    }
  });
  it('the vendor search answers a search result, not an error envelope', async () => {
    const b = (await (await fetch(`${base}/host/openwop-app/packs/-/search?q=core`)).json()) as Record<string, unknown>;
    expect(b).not.toHaveProperty('error');
  });
});

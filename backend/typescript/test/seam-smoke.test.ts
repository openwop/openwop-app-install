/**
 * End-to-end seam smoke: boots the app with durable host-surface backends
 * selected via env, then drives `ctx.*` surfaces over HTTP (the test-seam
 * dispatch route) to prove the seam wires real backends end-to-end — not just
 * in unit tests. Also asserts `/.well-known/openwop` advertises the selected
 * backend (`implementation: 'durable'`), proving effectiveImplementation flows
 * from env → registry → discovery doc.
 *
 * Uses the in-process sqlite (`memory://`) control plane, which the durable
 * adapters read/write through — so "durable" here means Storage-backed and
 * cross-instance-correct, exercised over the real HTTP surface.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';

const PORT = 18242;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'sample-token';
let server: http.Server;

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: (text.length ? JSON.parse(text) : null) as T };
}
const surface = <T>(surface: string, op: string, args: Record<string, unknown>) =>
  api<T>('/v1/host/sample/test/surface', { method: 'POST', body: JSON.stringify({ tenantId: 'smoke', surface, op, args }) });

beforeAll(async () => {
  // Select durable backends per-surface (a global OPENWOP_SURFACE_BACKEND=durable
  // would make blob/observability — which have no durable adapter — fail the
  // boot guard, by design).
  process.env.OPENWOP_SURFACE_KV = 'durable';
  process.env.OPENWOP_SURFACE_FS = 'durable';
  process.env.OPENWOP_SURFACE_TABLE = 'durable';
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({
    port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false,
  });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_SURFACE_KV;
  delete process.env.OPENWOP_SURFACE_FS;
  delete process.env.OPENWOP_SURFACE_TABLE;
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
});

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('seam smoke: durable surfaces over HTTP', () => {
  it('kv set → get persists through the durable backend', async () => {
    expect((await surface('kv', 'set', { key: 'k', value: { n: 1 } })).status).toBe(200);
    const got = await surface<{ value: unknown; found: boolean }>('kv', 'get', { key: 'k' });
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ found: true, value: { n: 1 } });
  });

  it('fs write → read round-trips through the durable backend', async () => {
    expect((await surface('fs', 'write', { path: 'dir/a.txt', contentBase64: b64('hello') })).status).toBe(200);
    const r = await surface<{ contentBase64: string }>('fs', 'read', { path: 'dir/a.txt' });
    expect(r.status).toBe(200);
    expect(Buffer.from(r.body.contentBase64, 'base64').toString()).toBe('hello');
  });

  it('table insert → query persists through the durable backend', async () => {
    expect((await surface('table', 'insert', { table: 't', row: { id: '1', name: 'a' } })).status).toBe(200);
    const q = await surface<{ rows: Array<{ id: string }> }>('table', 'query', { table: 't' });
    expect(q.status).toBe(200);
    expect(q.body.rows.map((r) => r.id)).toContain('1');
  });

  it('/.well-known/openwop advertises the selected durable backend', async () => {
    const disc = await api<{ hostSurfaces: Array<{ name: string; implementation?: string }> }>('/.well-known/openwop');
    expect(disc.status).toBe(200);
    const impl = (name: string) => disc.body.hostSurfaces.find((s) => s.name === name)?.implementation;
    expect(impl('host.kvStorage')).toBe('durable');
    expect(impl('host.fs')).toBe('durable');
    expect(impl('host.tableStorage')).toBe('durable');
    // a non-selected surface keeps its demo tag (no false advertising)
    expect(impl('host.blobStorage')).not.toBe('durable');
  });
});

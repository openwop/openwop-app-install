/**
 * ADR 0632 / measured on production 2026-09-05: a `values` stream on an
 * already-terminal run closed BEFORE its snapshot frames were written whenever
 * `storage.getRun` took a real round trip (Postgres). In-memory sqlite answered
 * inside the same tick, so the ordinary witness stayed green. This test injects
 * a real timer into `getRun` to reproduce the production ordering.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import * as sqlite from '../src/storage/sqlite/index.js';

let server: Server; let base = '';
const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };

beforeAll(async () => {
  const real = sqlite.openSqliteStorage;
  vi.spyOn(sqlite, 'openSqliteStorage').mockImplementation((dbPath: string) => {
    const s = real(dbPath);
    const getRun = s.getRun.bind(s);
    s.getRun = async (id: string) => { await new Promise((r) => setTimeout(r, 40)); return getRun(id); };
    return s;
  });
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const { createApp } = await import('../src/index.js');
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const srv = app.listen(0, '127.0.0.1', () => r(srv)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { vi.restoreAllMocks(); await new Promise<void>((r) => server.close(() => r())); });

describe('values stream on a terminal run with a slow storage read (the production ordering)', () => {
  it('still delivers its state.snapshot frames before the close', async () => {
    const c = await fetch(`${base}/runs`, { method: 'POST', headers: V2, body: JSON.stringify({ workflowId: 'conformance-noop', inputs: {} }) });
    expect(c.status, await c.clone().text()).toBe(201);
    const { runId } = await c.json() as { runId: string };
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const s = await (await fetch(`${base}/runs/${encodeURIComponent(runId)}`, { headers: V2 })).json() as { status: string };
      if (s.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const r = await fetch(`${base}/runs/${encodeURIComponent(runId)}/events?streamMode=values`, { headers: { ...V2, Accept: 'text/event-stream', 'Last-Event-ID': '1' } });
    expect(r.status).toBe(200);
    const text = await r.text();
    const events = text.split('\n').filter((l) => l.startsWith('event:')).map((l) => l.slice(6).trim());
    expect(events.length, `a 200 with only the keep-alive is the production defect; got: ${JSON.stringify(text.slice(0, 120))}`).toBeGreaterThan(0);
    expect(new Set(events)).toEqual(new Set(['state.snapshot']));
  });
});

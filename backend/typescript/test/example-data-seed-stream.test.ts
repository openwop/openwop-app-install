/**
 * #4239 — the demo seed ran 90–170 s in prod and the Firebase `/api` rewrite
 * cuts a request at 60 s, so the one-shot JSON answer 502'd while the seed kept
 * going. With `Accept: application/x-ndjson` the route now flushes a 200 at
 * once and ends with ONE `result` line carrying the same body the JSON path
 * returns; without that header it still answers plain JSON.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;
const auth = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('POST /example-data/seed streams when asked', () => {
  it('NDJSON: a 200 with a single terminal `result` line whose body matches the JSON shape', async () => {
    const res = await fetch(`${BASE}/host/openwop-app/example-data/seed`, {
      method: 'POST', headers: { ...auth, accept: 'application/x-ndjson' }, body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = (await res.text()).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as { type: string; result?: { seeded: boolean; agents: number } });
    const terminal = lines.filter((l) => l.type === 'result' || l.type === 'error');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.type).toBe('result');
    expect(terminal[0]!.result).toMatchObject({ seeded: true, agents: 10 });
    // Everything before the terminal line is a keepalive, never data.
    expect(lines.slice(0, -1).every((l) => l.type === 'keepalive')).toBe(true);
  });

  it('without the Accept header it still answers plain JSON (other callers are unchanged)', async () => {
    const res = await fetch(`${BASE}/host/openwop-app/example-data/seed`, { method: 'POST', headers: auth, body: '{}' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { agents: number };
    expect(body.agents).toBe(10);
  });
});

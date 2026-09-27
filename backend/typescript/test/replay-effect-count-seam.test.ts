/**
 * ADR 0533 — `GET /v1/host/sample/replay/effect-count` (`host-sample-test-seams.md` §20).
 *
 * Two claims, and the second is the one with teeth:
 *   1. The seam reports the count the ADR 0531 guard actually kept, in the
 *      documented `{ runId, effectCount }` shape.
 *   2. It is OFF unless `OPENWOP_TEST_SEAM_ENABLED=true` — §"Production safety"
 *      requires every `/v1/host/sample/*` seam to 404 in production, and this
 *      one exposes per-run activity metadata.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import {
  runWithEffectContext,
  assertEffectAllowed,
  __resetEffectCountsForTest,
} from '../src/host/runEffectContext.js';

let server: http.Server;
let BASE: string;
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, { headers: H });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

describe('replay effect-count seam', () => {
  it('reports the guard-seam tally in the documented shape', async () => {
    __resetEffectCountsForTest();
    runWithEffectContext({ runId: 'seam-run-1', replaying: false }, () => {
      assertEffectAllowed('notification', 'a');
      assertEffectAllowed('network-egress', 'b');
    });
    const res = await get('/v1/host/sample/replay/effect-count?runId=seam-run-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: 'seam-run-1', effectCount: 2 });
  });

  it('answers 0 for a run that fired nothing (and for an unknown run)', async () => {
    const res = await get('/v1/host/sample/replay/effect-count?runId=never-existed');
    expect(res.status).toBe(200);
    expect(res.body['effectCount']).toBe(0);
  });

  it('is monotonic non-decreasing for a runId', async () => {
    __resetEffectCountsForTest();
    runWithEffectContext({ runId: 'seam-run-2', replaying: false }, () => assertEffectAllowed('email'));
    const first = (await get('/v1/host/sample/replay/effect-count?runId=seam-run-2')).body['effectCount'] as number;
    runWithEffectContext({ runId: 'seam-run-2', replaying: false }, () => assertEffectAllowed('email'));
    const second = (await get('/v1/host/sample/replay/effect-count?runId=seam-run-2')).body['effectCount'] as number;
    expect(second).toBeGreaterThanOrEqual(first);
    expect(second).toBe(2);
  });

  it('rejects a missing runId rather than guessing', async () => {
    expect((await get('/v1/host/sample/replay/effect-count')).status).toBe(400);
  });

  it('is also mounted at the host-namespaced path', async () => {
    expect((await get('/v1/host/openwop-app/replay/effect-count?runId=x')).status).toBe(200);
  });
});

describe('production safety — the seam is OFF by default', () => {
  it('404s when OPENWOP_TEST_SEAM_ENABLED is not set', async () => {
    const prev = process.env.OPENWOP_TEST_SEAM_ENABLED;
    delete process.env.OPENWOP_TEST_SEAM_ENABLED;
    let s2: http.Server | undefined;
    try {
      const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
      const base = await new Promise<string>((res) => {
        s2 = app.listen(0, '127.0.0.1', () => res(`http://127.0.0.1:${(s2!.address() as AddressInfo).port}`));
      });
      const res = await fetch(`${base}/v1/host/sample/replay/effect-count?runId=x`, { headers: H });
      expect(res.status).toBe(404);
    } finally {
      if (s2) await new Promise<void>((res) => s2!.close(() => res()));
      if (prev !== undefined) process.env.OPENWOP_TEST_SEAM_ENABLED = prev;
    }
  });
});

/**
 * ADR 0533 — `GET /host/sample/replay/effect-count` (`host-sample-test-seams.md` §20).
 *
 * Two claims, and the second is the one with teeth:
 *   1. The seam reports the count the ADR 0531 guard actually kept, in the
 *      documented `{ runId, effectCount }` shape.
 *   2. It is OFF unless `OPENWOP_TEST_SEAM_ENABLED=true` — §"Production safety"
 *      requires every `/host/sample/*` seam to 404 in production, and this
 *      one exposes per-run activity metadata.
 *
 * Sabotages that red this file (8fw1g4 round 1): answering a constant count,
 * dropping the empty-runId 400, dropping the env gate, unmounting the
 * host-namespaced path, and not recording the effect escape at the guard.
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
    const res = await get('/host/sample/replay/effect-count?runId=seam-run-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: 'seam-run-1', effectCount: 2 });
  });

  it('answers 0 for an unknown run (the same branch as a run that fired nothing)', async () => {
    __resetEffectCountsForTest();
    const res = await get('/host/sample/replay/effect-count?runId=never-existed');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: 'never-existed', effectCount: 0 });
  });

  // Twin at the counter level: run-effect-context.test.ts "counts an effect that
  // ESCAPED…". Kept here as the WIRE shape across two reads. Protected file.
  it('is monotonic non-decreasing for a runId', async () => {
    __resetEffectCountsForTest();
    runWithEffectContext({ runId: 'seam-run-2', replaying: false }, () => assertEffectAllowed('email'));
    expect((await get('/host/sample/replay/effect-count?runId=seam-run-2')).body)
      .toEqual({ runId: 'seam-run-2', effectCount: 1 });
    runWithEffectContext({ runId: 'seam-run-2', replaying: false }, () => assertEffectAllowed('email'));
    expect((await get('/host/sample/replay/effect-count?runId=seam-run-2')).body)
      .toEqual({ runId: 'seam-run-2', effectCount: 2 });
  });

  it('rejects a missing runId rather than guessing', async () => {
    const res = await get('/host/sample/replay/effect-count');
    expect(res.status).toBe(400);
    expect(res.body['error']).toBe('validation_error');
    expect(String(res.body['message'])).toContain('runId');
  });

  it('is also mounted at the host-namespaced path', async () => {
    __resetEffectCountsForTest();
    runWithEffectContext({ runId: 'seam-run-ns', replaying: false }, () => assertEffectAllowed('notification'));
    const res = await get('/host/openwop-app/replay/effect-count?runId=seam-run-ns');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: 'seam-run-ns', effectCount: 1 });
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
      const res = await fetch(`${base}/host/sample/replay/effect-count?runId=x`, { headers: H });
      expect(res.status).toBe(404);
    } finally {
      if (s2) await new Promise<void>((res) => s2!.close(() => res()));
      if (prev !== undefined) process.env.OPENWOP_TEST_SEAM_ENABLED = prev;
    }
  });
});

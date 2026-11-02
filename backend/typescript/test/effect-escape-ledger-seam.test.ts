/**
 * ADR 0591 P3 — `GET /host/sample/replay/effect-escapes`.
 *
 * Three claims, in descending order of how badly a silent failure would hurt:
 *   1. It reports the DURABLE per-identity count in the documented
 *      `{ runId, escapes: [{ invocationId, nodeId, count }] }` shape — the
 *      number RFC 0158 §C.7 asserts on, which its §20 scalar sibling cannot
 *      produce (a scalar equals the per-identity count only when the graph holds
 *      exactly one identity, and its Map does not survive the kill).
 *   2. It is OFF unless `OPENWOP_TEST_SEAM_ENABLED=true` — `host-sample-test-seams.md`
 *      §"Production safety" requires every `/host/sample/*` seam to 404 in
 *      production, and this one exposes per-run effect activity.
 *   3. An unknown run answers an EMPTY LIST, not 404 — a 404 is
 *      indistinguishable to the suite from "seam not wired", which soft-skips,
 *      and a soft-skip reads as a pass.
 *
 * Tracker TST-CXC-2. Red when (routes/effectEscapeLedgerSeam.ts): the seam
 * mounts with the flag off; a missing runId is defaulted; an unknown run 404s;
 * the host-namespaced twin is dropped; or the route reports anything but the
 * stored per-identity count.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { runWithEffectContext } from '../src/host/runEffectContext.js';
import { recordDurableEffectEscape } from '../src/host/effectEscapeLedger.js';
import { resetLogicalInvocationOrdinals } from '../src/host/effectIdentity.js';

let server: http.Server;
let BASE: string;
let offServer: http.Server;
let OFF_BASE: string;
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };
const prevSeams = process.env.OPENWOP_TEST_SEAM_ENABLED;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  // The flag-OFF app boots FIRST. The gate runs at registration, so it needs its
  // own boot; booting it before the seam-ON app keeps the ON app's process-wide
  // ledger backend (installed last) the one every case records into, whatever
  // order the cases run in.
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'false';
  const offApp = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    offServer = offApp.listen(0, '127.0.0.1', () => { OFF_BASE = `http://127.0.0.1:${(offServer.address() as AddressInfo).port}`; res(); });
  });
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  if (prevSeams === undefined) delete process.env.OPENWOP_TEST_SEAM_ENABLED; else process.env.OPENWOP_TEST_SEAM_ENABLED = prevSeams;
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => offServer.close(() => res()));
});

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, { headers: H });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

describe('ADR 0591 — effect-escape ledger seam', () => {
  it('reports the DURABLE per-identity count, and a double-fire at one identity reads as 2', async () => {
    resetLogicalInvocationOrdinals();
    const ctx = { runId: 'esc-run-1', replaying: false, nodeId: 'notify', tenantId: 'demo', attempt: 1 };

    // Pre-kill escape.
    await runWithEffectContext(ctx, async () => {
      await recordDurableEffectEscape('notification:approval');
    });
    // The kill, then the resumed process re-fires the SAME logical effect.
    resetLogicalInvocationOrdinals();
    await runWithEffectContext(ctx, async () => {
      await recordDurableEffectEscape('notification:approval');
    });

    const { status, body } = await get('/host/sample/replay/effect-escapes?runId=esc-run-1');
    expect(status).toBe(200);
    expect(body['runId']).toBe('esc-run-1');
    const escapes = body['escapes'] as Array<{ invocationId: string; nodeId: string; count: number }>;
    // ONE identity that escaped TWICE — the shape and the number the corpus
    // session authors `duplicate-delivery` against.
    expect(escapes).toHaveLength(1);
    expect(escapes[0]!.count).toBe(2);
    expect(escapes[0]!.nodeId).toBe('notify');
    expect(typeof escapes[0]!.invocationId).toBe('string');
    expect(escapes[0]!.invocationId.length).toBeGreaterThan(0);
  });

  it('answers an EMPTY LIST for an unknown run, not 404', async () => {
    const { status, body } = await get('/host/sample/replay/effect-escapes?runId=never-existed');
    expect(status).toBe(200);
    expect(body['escapes']).toEqual([]);
  });

  it('rejects a missing runId rather than defaulting to something', async () => {
    const { status, body } = await get('/host/sample/replay/effect-escapes');
    expect(status).toBe(400);
    expect(body['error']).toBe('validation_error');
  });

  it('is mounted on BOTH the spec-canonical and host-namespaced paths', async () => {
    // The suite drives `/host/sample/*`; the product surface is the
    // host-namespaced twin. A seam mounted on only one is unreachable from
    // whichever side is not checked. This case records its OWN escape, so it
    // compares real data whatever order the cases run in.
    resetLogicalInvocationOrdinals();
    await runWithEffectContext({ runId: 'esc-run-dual', replaying: false, nodeId: 'notify', tenantId: 'demo', attempt: 1 }, async () => {
      await recordDurableEffectEscape('notification:approval');
    });
    const a = await get('/host/sample/replay/effect-escapes?runId=esc-run-dual');
    const b = await get('/host/openwop-app/replay/effect-escapes?runId=esc-run-dual');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body['escapes'] as unknown[]).length).toBe(1);
    expect(b.body).toEqual(a.body);
  });
});

describe('ADR 0591 — the seam is OFF by default (production safety)', () => {
  it('404s when OPENWOP_TEST_SEAM_ENABLED is not true', async () => {
    // A SEPARATE app instance booted with the flag off (see beforeAll) — the gate
    // runs at registration, so flipping the env after boot proves nothing.
    const res = await fetch(`${OFF_BASE}/host/sample/replay/effect-escapes?runId=x`, { headers: H });
    expect(res.status).toBe(404);
    // Positive control: the seam-ON app answers the same request 200.
    expect((await get('/host/sample/replay/effect-escapes?runId=x')).status).toBe(200);
  });
});

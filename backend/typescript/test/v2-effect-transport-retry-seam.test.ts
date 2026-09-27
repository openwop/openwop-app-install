import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import http from 'node:http';

import { createApp } from '../src/index.js';

/**
 * RFC 0173 §D.2 G4 / ADR 0639 — `forceEffectTransportRetry`.
 *
 * The witness is a REAL fixture provider, not a spy: this test stands up an HTTP
 * server that records the `idempotency-key` of every request it receives, which
 * is exactly what the conformance suite's fixture does. Asserting on the host's
 * internals instead would prove the host calls its own helper, not that the key
 * reaching the wire is stable — and the wire is the obligation.
 */
let server: Server;
let base: string;
let provider: Server;
let providerUrl: string;
let seenKeys: string[] = [];

const AUTH = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';

  provider = await new Promise<Server>((r) => {
    const s = http.createServer((req, res) => {
      seenKeys.push(String(req.headers['idempotency-key'] ?? ''));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    s.listen(0, '127.0.0.1', () => r(s));
  });
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/collect`;

  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => provider.close(() => r()));
});

async function drive(body: unknown) {
  seenKeys = [];
  const res = await fetch(`${base}/conformance/seams/sample/test/idempotency/effect-retry`, {
    method: 'POST',
    headers: { ...AUTH, 'OpenWOP-Version': '2' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) as Record<string, unknown> | null };
}

describe('forceEffectTransportRetry presents ONE identity across BOTH transport attempts', () => {
  it('the fixture provider sees two attempts carrying the same idempotency key', async () => {
    const { status, json } = await drive({ providerUrl });
    expect(status, `seam answered ${status}: ${JSON.stringify(json)}`).toBe(201);

    expect(seenKeys.length, 'the provider must observe the original AND the forced retry').toBe(2);
    expect(seenKeys[0], 'an empty key means the identity never reached the wire').not.toBe('');
    expect(
      seenKeys[1],
      'the two transport attempts presented DIFFERENT keys — this is the exact failure the seam exists to expose, and '
        + 'it is what `randomUUID()` per call produces',
    ).toBe(seenKeys[0]);
    expect(seenKeys[0]).toMatch(/^[A-Za-z0-9._~-]{22,128}$/);
  });

  it('the 201 body names an effect the projection can actually be read for', async () => {
    // The seam's `effectId` and the ledger projection's are derived by the SAME
    // shared function, so this pins the contract a consumer relies on: follow the
    // id from the seam into `GET /runs/{runId}/effects` and find that effect.
    const { status, json } = await drive({ providerUrl });
    expect(status).toBe(201);
    const runId = String(json?.runId ?? '');
    const effectId = String(json?.effectId ?? '');
    expect(runId, 'the run id must be tenant-bound at major 2').toContain('/');
    expect(effectId).toBeTruthy();

    const proj = await fetch(`${base}/runs/${encodeURIComponent(runId)}/effects`, {
      headers: { ...AUTH, 'OpenWOP-Version': '2' },
    });
    expect(proj.status).toBe(200);
    const body = await proj.json() as { effects: Array<{ effectId: string }> };
    expect(
      body.effects.map((e) => e.effectId),
      'the seam returned an effectId the projection does not carry — two derivations that drifted',
    ).toContain(effectId);
    // The ledger is the suite's cross-retry witness: it must SHOW both attempts of
    // the one effect (suite 2.41.0 `v2-effect-identity-business-key` retry leg).
    const rows = (body.effects as Array<{ effectId: string; attempt?: number }>).filter((e) => e.effectId === effectId);
    expect(rows.map((r) => r.attempt).sort(), 'one ledger row per transport attempt').toEqual([1, 2]);
  });

  it('a malformed providerUrl is a typed 400, never a success with no effect', async () => {
    for (const bad of [{}, { providerUrl: '' }, { providerUrl: 'not-a-url' }, { providerUrl: 'ftp://x/y' }, { providerUrl, extra: 1 }]) {
      const { status } = await drive(bad);
      expect(status, `${JSON.stringify(bad)} should be refused`).toBe(400);
      expect(seenKeys.length, 'a refused request must not reach the provider').toBe(0);
    }
  });
});

/**
 * `/readiness` reports whether a HOST web-search key is configured.
 *
 * Why: search configuration was invisible until someone ran a workflow and read
 * `engine: 'demo'` off a run event. Verified live 2026-08-02 — that really was the
 * only way to check, so an operator who set the Vault key could not confirm it
 * landed, and across four sessions "is the key set?" was answered by driving a chain.
 *
 * This is the same move `routes/health.ts` already documents for managed providers:
 * "that used to be invisible until a user ran a workflow… turns it into a
 * deploy-time signal a smoke test can assert on."
 *
 * TWO PROPERTIES, and the second matters more than the first:
 *  1. it reports honestly (configured + where from);
 *  2. it NEVER gates `ready`. Search is optional — a host running non-research
 *     workflows is genuinely healthy without it, and 503-ing would be the dishonest
 *     inverse of the problem being fixed.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { hostWebSearchKeyStatus } from '../src/host/webResearchSurface.js';

let server: http.Server;
let PORT: number;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  // FIXTURE GUARD (load-bearing — see the "never gates" test). Without a managed
  // provider key readiness is ALREADY 503 for an unrelated reason, and a search-key
  // gate becomes unobservable: 503-before and 503-after. The first version of this
  // file was written that way and a sabotage probe (gating `ready` on
  // `webSearch.configured`) PASSED all five tests. Seeding this key is what makes
  // the differential real.
  process.env.MINIMAX_API_KEY = 'test-managed-key';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  PORT = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => { delete process.env.OPENWOP_WEBSEARCH_API_KEY; });

const readiness = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await fetch(`http://127.0.0.1:${PORT}/readiness`);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

describe('readiness reports web-search configuration', () => {
  it('reports NOT configured when no key exists anywhere', async () => {
    const { body } = await readiness();
    const checks = body.checks as Record<string, unknown>;
    expect(checks.webSearch, 'the check must be present even when unconfigured').toBeDefined();
    expect(checks.webSearch).toEqual({ configured: false, source: null });
  });

  it('reports the ENV lane when that is where the key lives', async () => {
    process.env.OPENWOP_WEBSEARCH_API_KEY = 'probe-key-not-real';
    const { body } = await readiness();
    expect((body.checks as Record<string, unknown>).webSearch).toEqual({ configured: true, source: 'env' });
  });

  it('NEVER gates readiness — the verdict is identical with and without a key', async () => {
    // The load-bearing assertion. Search is optional; making it gate would turn a
    // healthy host into a 503 and be the dishonest inverse of this fix.
    //
    const without = await readiness();
    // The differential only means something if the baseline is GREEN — otherwise a
    // gate would read 503→503 and this test would pass against the broken version.
    expect(without.status, 'fixture guard: baseline must be ready, see beforeAll').toBe(200);
    expect((without.body.checks as Record<string, unknown>).webSearch).toEqual({ configured: false, source: null });

    process.env.OPENWOP_WEBSEARCH_API_KEY = 'probe-key-not-real';
    const withKey = await readiness();
    expect((withKey.body.checks as Record<string, unknown>).webSearch).toEqual({ configured: true, source: 'env' });

    expect(withKey.status, 'the search key must not move the readiness verdict').toBe(without.status);
    expect(withKey.body.status).toBe(without.body.status);
  });

  it('never returns the key itself, only whether one resolves', async () => {
    process.env.OPENWOP_WEBSEARCH_API_KEY = 'sk-super-secret-probe-value';
    const { body } = await readiness();
    expect(JSON.stringify(body), 'readiness is UNAUTHENTICATED — key material must never appear').not.toContain('sk-super-secret-probe-value');
  });

  it('the helper is host-scope only — it takes no tenantId', () => {
    // A tenant's own BYOK key must not be enumerable from an unauthenticated
    // endpoint; pinning the arity keeps that from drifting.
    expect(hostWebSearchKeyStatus.length, 'adding a tenantId param would leak tenant config').toBe(0);
  });
});

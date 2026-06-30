/**
 * RFC 0120 — the `connection-packs/egress-check` conformance seam
 * (`host-sample-test-seams.md` §10), the host half of the
 * `connection-pack-apihosts.test.ts` behavioral egress-allow-list leg.
 *
 * The published `@openwop/openwop-conformance` (≥1.46.0) behavioral leg drives
 * `POST /v1/host/sample/connection-packs/{install,egress-check}` and, under
 * `OPENWOP_REQUIRE_BEHAVIOR=true`, asserts a credential-bearing egress to an
 * `apiHosts` match is PERMITTED and a non-match FAILS CLOSED. But that leg
 * SOFT-SKIPS on a 404 (an unwired seam still "passes" vacuously), so we pin the
 * seam contract HERE — a regression fails in this repo, deterministically, not
 * silently in the suite. The seam routes through the SAME
 * `host/connectionInjection.ts::hostMatchesApi` matcher `brokeredEgress` pins
 * credentialed egress with, so this also witnesses the production decision.
 *
 * @see docs/adr/0169-rfc-0120-provider-apihosts-witness.md
 * @see src/routes/connectionPackSeam.ts
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };

interface EgressResult {
  allowed?: boolean;
  code?: string;
}

describe('RFC 0120 §10 — connection-packs/egress-check seam (enabled)', () => {
  let BASE: string;
  let server: http.Server;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  });

  const probe = async (base: string, provider: string, requestHost: string): Promise<{ status: number; body: EgressResult }> => {
    const res = await fetch(`${BASE}${base}/egress-check`, { method: 'POST', headers: H, body: JSON.stringify({ provider, requestHost }) });
    return { status: res.status, body: (await res.json()) as EgressResult };
  };

  // Both the product (host-namespaced) and the spec-canonical (suite-driven) base paths.
  for (const base of ['/v1/host/sample/connection-packs', '/v1/host/openwop-app/connection-packs']) {
    describe(`base ${base}`, () => {
      it('PERMITS an apiHosts match — the entry host and its subdomains (meta-ads ⇒ facebook.com)', async () => {
        // meta-ads auto-loads from the in-tree pack with apiHosts:["facebook.com"].
        expect(await probe(base, 'meta-ads', 'graph.facebook.com')).toEqual({ status: 200, body: { allowed: true } });
        expect(await probe(base, 'meta-ads', 'facebook.com')).toEqual({ status: 200, body: { allowed: true } });
      });

      it('FAILS CLOSED on look-alikes — no substring/suffix/prefix escape', async () => {
        for (const evil of ['evil.com', 'notfacebook.com', 'facebook.com.evil.com']) {
          expect(await probe(base, 'meta-ads', evil)).toEqual({ status: 200, body: { allowed: false, code: 'egress_host_not_allowed' } });
        }
      });

      it('FAILS CLOSED for an unresolved provider', async () => {
        expect(await probe(base, 'no-such-provider', 'graph.facebook.com')).toEqual({
          status: 200,
          body: { allowed: false, code: 'connection_provider_unresolved' },
        });
      });

      it('FAILS CLOSED for a provider that declares no apiHosts (mcp-reach github)', async () => {
        // github is an mcp-reach pack — apiHosts is correctly absent ⇒ nothing reachable.
        expect(await probe(base, 'github', 'api.githubcopilot.com')).toEqual({
          status: 200,
          body: { allowed: false, code: 'no_api_hosts' },
        });
      });

      it('400s on missing provider / requestHost', async () => {
        const r1 = await fetch(`${BASE}${base}/egress-check`, { method: 'POST', headers: H, body: JSON.stringify({ provider: 'meta-ads' }) });
        expect(r1.status).toBe(400);
        const r2 = await fetch(`${BASE}${base}/egress-check`, { method: 'POST', headers: H, body: JSON.stringify({ requestHost: 'facebook.com' }) });
        expect(r2.status).toBe(400);
      });

      it('install alias is reachable (the behavioral leg installs before probing)', async () => {
        const res = await fetch(`${BASE}${base}/install`, {
          method: 'POST', headers: H,
          body: JSON.stringify({ manifest: { name: 'x', version: '1.0.0', kind: 'connection', engines: { openwop: '>=1.0.0' }, provider: {} } }),
        });
        // Reachable (not 404) — a malformed manifest still returns a structured non-404 result.
        expect(res.status).not.toBe(404);
      });
    });
  }
});

describe('RFC 0120 §10 — egress-check seam is 404 when seams are disabled (production safety)', () => {
  let BASE: string;
  let server: http.Server;

  beforeAll(async () => {
    delete process.env.OPENWOP_TEST_SEAM_ENABLED; // production posture
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it('returns 404 (seam unmounted) for both base paths', async () => {
    for (const base of ['/v1/host/sample/connection-packs', '/v1/host/openwop-app/connection-packs']) {
      const res = await fetch(`${BASE}${base}/egress-check`, { method: 'POST', headers: H, body: JSON.stringify({ provider: 'meta-ads', requestHost: 'facebook.com' }) });
      expect(res.status).toBe(404);
    }
  });
});

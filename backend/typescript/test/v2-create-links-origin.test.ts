/**
 * runs.md §create × the front door — LINKS IN THE CREATE RESPONSE RESOLVE ON
 * THE ORIGIN THE REQUEST WAS MADE TO, AND NEVER DOWNGRADE THE SCHEME.
 *
 * MEASURED 2026-09-05 (corpus steward, `1d29`): through `app.openwop.dev` a
 * create answered `eventsUrl: http://openwop-app-backend-…run.app/…` — the
 * INTERNAL host and plain `http`, because `routes/runs.ts` built the links
 * from `req.protocol`/`req.get('host')` instead of the forwarded-aware
 * `requestOrigin()` the rest of the host uses. A client following those
 * leaves the origin it discovered on. rc.44 makes it a MUST.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { projectBoundId } from '../src/host/boundIdProjection.js';

let server: http.Server; let base = '';
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
async function create(path: string, headers: Record<string, string>) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ workflowId: 'conformance-noop', inputs: {} }) });
  return (await res.json()) as { runId: string; eventsUrl?: string; statusUrl?: string };
}
const FWD = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'app.example.test' };

describe('create-response links are same-origin and keep the scheme', () => {
  it('1. behind a proxy, under major 2: https://<forwarded host>/runs/<bound>/events', async () => {
    const r = await create('/runs', { ...FWD, 'OpenWOP-Version': '2' });
    // The id spelling moved from `%2F` to the RFC 0184 projection on 2026-09-16
    // (ADR 0705). It is DERIVED here, not pinned: this test's subject is the
    // ORIGIN and the SCHEME, and the spelling was only ever incidental to
    // building the expectation. Pinning it here a second time would make an
    // unrelated test fail on every future id change; the spelling has its own
    // oracle in `v2-identity.test.ts` and its own wire legs in
    // `v2-bound-id-path-projection.test.ts`.
    expect(r.eventsUrl).toBe(`https://app.example.test/runs/${projectBoundId(r.runId)}/events`);
    expect(r.statusUrl).toBe(`https://app.example.test/runs/${projectBoundId(r.runId)}`);
  });
  it('2. behind a proxy, under 1.x: https://<forwarded host>/v1/runs/<id>/events', async () => {
    const r = await create('/v1/runs', FWD);
    expect(r.eventsUrl).toBe(`https://app.example.test/v1/runs/${r.runId}/events`);
  });
  it('3. with no proxy, the request\'s own origin (never some other host)', async () => {
    const r = await create('/v1/runs', {});
    expect(r.eventsUrl).toBe(`${base}/v1/runs/${r.runId}/events`);
  });
});

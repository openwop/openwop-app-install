/**
 * RFC 0117 — the live ui-plugin/1 witness over HTTP. Boots the real app with
 * OPENWOP_TEST_SEAM_ENABLED=true and proves the witness is non-vacuous against the
 * fixed conformance seam the pinned suite drives:
 *   - /.well-known/openwop advertises uiPlugins.supported + isolation cross-origin-iframe
 *   - POST /v1/host/sample/ui-plugin/rpc (the canonical conformance path) is reachable
 *     and enforces the closed allowlist (undeclared method → method_not_allowed)
 *   - the product path /v1/host/openwop-app/ui-plugin/rpc serves the same handler
 *   - a non-ui-plugin/1 message → 400 (not a silent empty body)
 *
 * Mirrors conformance/src/scenarios/frontend-plugin-packs.test.ts (which posts to the
 * `sample` seam, capability-gated on uiPlugins.supported).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let BASE: string;
let server: http.Server;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
const SAMPLE = () => `${BASE}/v1/host/sample/ui-plugin/rpc`;
const PRODUCT = () => `${BASE}/v1/host/openwop-app/ui-plugin/rpc`;
const env = (method: string, params?: unknown) => ({ openwop: 'ui-plugin/1', id: 1, type: 'request', method, params });
const post = (url: string, message: unknown) => fetch(url, { method: 'POST', headers: H, body: JSON.stringify({ message }) });

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

describe('RFC 0117 — live ui-plugin witness', () => {
  it('advertises uiPlugins at the discovery root (isolation cross-origin-iframe)', async () => {
    const doc = await (await fetch(`${BASE}/.well-known/openwop`, { headers: H })).json() as {
      uiPlugins?: { supported?: boolean; isolation?: string; hostApi?: string[]; maxEntryBytes?: number };
    };
    expect(doc.uiPlugins?.supported).toBe(true);
    expect(doc.uiPlugins?.isolation).toBe('cross-origin-iframe');
    expect(doc.uiPlugins?.hostApi).toEqual(['artifact.read', 'artifact.write', 'host.toast', 'host.navigate']);
    expect(doc.uiPlugins?.maxEntryBytes).toBe(2_097_152);
  });

  it('serves the canonical conformance seam and rejects an undeclared method', async () => {
    const res = await post(SAMPLE(), env('host.deleteEverything'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ openwop: 'ui-plugin/1', id: 1, ok: false, error: { code: 'method_not_allowed' } });
  });

  it('serves the same handler at the product path', async () => {
    const res = await post(PRODUCT(), env('host.deleteEverything'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: 'method_not_allowed' } });
  });

  it('rejects a non-ui-plugin/1 message with 400 (no silent empty body)', async () => {
    const res = await post(SAMPLE(), { openwop: 'something-else', id: 1, type: 'request', method: 'artifact.read' });
    expect(res.status).toBe(400);
  });
});

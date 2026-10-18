/**
 * The live ui-plugin/1 dispatch over HTTP after ADR 0840 D7. Boots the real app with
 * OPENWOP_TEST_SEAM_ENABLED=true (the posture that used to mount the v1 conformance
 * alias) and proves:
 *   - /.well-known/openwop advertises the v2 uiPlugins record (`served: true`)
 *   - the RFC 0238 per-plugin operation serves the dispatch: an undeclared method is
 *     refused inside a 200 (`method_not_allowed`), a non-ui-plugin/1 body is 400
 *   - the deleted host-global routes stay deleted: `/host/openwop-app/ui-plugin/rpc` and
 *     the v1 alias `/host/sample/ui-plugin/rpc` both 404, with the per-plugin control
 *     answering the SAME body on the SAME app (so the 404 is not "nothing is routed").
 *
 * Honest triple guard: a non-ui-plugin/1 body is refused by the v2 message schema,
 * by `isUiPluginRequest`, AND by the dispatcher's null-response throw — each alone
 * answers the same 400, so the "rejects a non-ui-plugin/1 message" case goes red only
 * when all three are removed (w33 probe `sr-nonmsg-all-guards`).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let BASE: string;
let server: http.Server;
const ENV = ['OPENWOP_STORAGE_DSN', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_TEST_SEAM_ENABLED'];
const saved: Record<string, string | undefined> = {};
let rpcPath = '';
let undeclared = '';
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json', 'OpenWOP-Version': '2' };
const env = (method: string, params?: unknown) => ({ openwop: 'ui-plugin/1', id: 1, type: 'request', method, params });
/** Every case needs the vendored plugin's RFC 0238 dispatch path — asserted in EACH
 *  case (not once in case 2), so a shuffled order cannot post to an empty path. */
function requireRpc(): void {
  expect(rpcPath, 'a vendored plugin is listed with its RFC 0238 rpcPath').toMatch(/^\/host\/ui-plugins\/.+\/rpc$/);
  expect(undeclared, 'that plugin leaves some host method undeclared').not.toBe('');
}
const post = (path: string, message: unknown) => fetch(`${BASE}${path}`, { method: 'POST', headers: H, body: JSON.stringify({ message }) });

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const list = await (await fetch(`${BASE}/host/openwop-app/ui-plugin/packs`, { headers: H })).json() as { plugins?: Array<{ rpcPath?: string; hostApi?: string[] }> };
  const HOST = ['artifact.read', 'artifact.write', 'host.toast', 'host.navigate', 'host.announce'];
  const plugin = list.plugins?.find((p) => typeof p.rpcPath === 'string' && HOST.some((m) => !(p.hostApi ?? []).includes(m)));
  rpcPath = plugin?.rpcPath ?? '';
  undeclared = HOST.find((m) => !(plugin?.hostApi ?? []).includes(m)) ?? '';
}, 120_000);
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (server) await new Promise<void>((res) => server.close(() => res()));
});

describe('ui-plugin/1 over HTTP (RFC 0238; ADR 0840 D7)', () => {
  it('advertises uiPlugins at the discovery root (isolation cross-origin-iframe)', async () => {
    // ADR 0812 P3c-0 — the major-2 document: the v2 record says "offered" with
    // `served: true` (v1's `supported: true` has no v2 seat).
    const doc = await (await fetch(`${BASE}/.well-known/openwop`, { headers: H })).json() as {
      uiPlugins?: { served?: boolean; isolation?: string; hostApi?: string[]; maxEntryBytes?: number };
    };
    expect(doc.uiPlugins?.served).toBe(true);
    expect(doc.uiPlugins?.isolation).toBe('cross-origin-iframe');
    expect(doc.uiPlugins?.hostApi).toEqual(['artifact.read', 'artifact.write', 'host.toast', 'host.navigate', 'host.announce']);
    expect(doc.uiPlugins?.maxEntryBytes).toBe(2_097_152);
  });

  it('the per-plugin operation refuses a method the plugin did not declare inside a 200', async () => {
    requireRpc();
    const res = await post(rpcPath, env(undeclared, { artifactId: 'x', message: 'm', to: '/' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ openwop: 'ui-plugin/1', id: 1, ok: false, error: { code: 'method_not_allowed' } });
  });

  it('a method outside the closed ui-plugin/1 enum is 400, never executed', async () => {
    requireRpc();
    const res = await post(rpcPath, env('host.deleteEverything'));
    expect(res.status).toBe(400);
    // Refused by the schema, never dispatched: no ui-plugin/1 response envelope.
    expect(await res.json()).toMatchObject({ error: 'validation_error', message: 'message is not a valid ui-plugin/1 request' });
  });

  it('rejects a non-ui-plugin/1 message with 400 (no silent empty body)', async () => {
    requireRpc();
    const res = await post(rpcPath, { openwop: 'something-else', id: 1, type: 'request', method: 'artifact.read' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'validation_error', message: 'message is not a valid ui-plugin/1 request' });
  });

  it('the deleted host-global routes 404 while the per-plugin control answers the same body', async () => {
    requireRpc();
    const body = env('artifact.read', { artifactId: 'x' });
    const control = await post(rpcPath, body);
    expect(control.status).toBe(200);
    expect(await control.json()).toMatchObject({ openwop: 'ui-plugin/1', type: 'response' });
    for (const gone of ['/host/openwop-app/ui-plugin/rpc', '/host/sample/ui-plugin/rpc']) {
      expect((await post(gone, body)).status, gone).toBe(404);
    }
  });
});

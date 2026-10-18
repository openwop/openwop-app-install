/**
 * ADR 0840 (RFC 0238) — the front-end plugin boundary at its normative path,
 * driven over HTTP against a real `createApp`, with a pack shaped like the
 * corpus's `ui-plugin-pack-narrow` fixture (one plugin, `narrow`, declaring only
 * `artifact.read` and no `connectSrc`).
 *
 * Mirrors the legs of `v2-ui-plugin-boundary`: the frame's CSP isolates and
 * denies egress; the dispatch refuses an undeclared method inside a 200, refuses
 * a method outside the `ui-plugin/1` enum with 400, and runs the declared one.
 * Plus what the suite cannot see: the browser lane (a headerless `text/html`
 * load, ADR 0840 architect #1) and that an undeclared method never executes.
 *
 * Every 404 asserts the route's own `not_found` envelope ('Unknown plugin.'), so a
 * request that fell through to no route at all cannot pass. Honest double guard:
 * an undeclared `artifact.write` would ALSO be stopped by write authz and the
 * app-builder validator, so the persisted-state half of the "never executes" case is
 * a second guard; the `method_not_allowed` code is what carries that claim.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PACK = 'core.openwop.conformance.ui-plugin-narrow';
const PLUGIN = 'narrow';
const ARTIFACT = 'ui-plugin-narrow-artifact';
const TENANT = 'conf-0840';
const KEY = 'k-0840-conformance-0001';
const HTML = '<!doctype html><html><head><title>narrow</title></head><body>narrow-plugin-body</body></html>';
const PLACEHOLDER = '{{secrets.openwop-conformance-canary-secret}}';

const framePath = `/host/ui-plugins/${encodeURIComponent(PACK)}/${PLUGIN}/frame`;
const rpcPath = `/host/ui-plugins/${encodeURIComponent(PACK)}/${PLUGIN}/rpc`;
const request = (id: number, method: string, params?: Record<string, unknown>) =>
  ({ openwop: 'ui-plugin/1', type: 'request', id, method, ...(params ? { params } : {}) });

/** The suite's own CSP reading (`ui-plugin-boundary-witness.ts` `parseCsp`). */
function parseCsp(header: string | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of (header ?? '').split(';')) {
    const [name, ...tokens] = part.trim().split(/\s+/).filter(Boolean);
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), tokens);
  }
  return out;
}

let server: http.Server; let base = '';
let packDir = '';
const saved: Record<string, string | undefined> = {};
const ENV = ['OPENWOP_API_KEYS', 'OPENWOP_AUTH_ENFORCE_BEARER', 'OPENWOP_DEPLOY_POSTURE', 'OPENWOP_FRONTEND_PLUGIN_PACK_DIR', 'OPENWOP_PRESENTATION_UIPLUGINS', 'OPENWOP_STORAGE_DSN', 'OPENWOP_SESSION_SECRET'];
let getCanvasForTenant: (t: string, id: string) => Promise<{ state: unknown; version: number } | null>;

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  packDir = mkdtempSync(join(tmpdir(), 'owp-0840-'));
  const dir = join(packDir, 'narrow');
  mkdirSync(join(dir, 'ui'), { recursive: true });
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({
    name: PACK, version: '1.0.0', kind: 'frontend-plugin', engines: { openwop: '>=2.0.0 <3.0.0' },
    uiPlugins: [{ pluginId: PLUGIN, surface: 'artifact-viewer', entry: 'ui/narrow.html', hostApi: ['artifact.read'] }],
  }));
  writeFileSync(join(dir, 'ui', 'narrow.html'), HTML);
  process.env.OPENWOP_FRONTEND_PLUGIN_PACK_DIR = packDir;
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_API_KEYS = `${KEY}:${TENANT}`;
  process.env.OPENWOP_AUTH_ENFORCE_BEARER = 'true';
  process.env.OPENWOP_DEPLOY_POSTURE = 'bearer-shared';
  delete process.env.OPENWOP_PRESENTATION_UIPLUGINS;
  // Imported after the env is set: the pack dir is read at module load.
  const { createApp } = await import('../src/index.js');
  const canvas = await import('../src/host/canvasSurface.js');
  getCanvasForTenant = canvas.getCanvasForTenant as typeof getCanvasForTenant;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The fixture artifact: an owner-less app-builder canvas, readable by the tenant.
  await canvas.__putCanvasForTest({ canvasId: ARTIFACT, tenantId: TENANT, canvasTypeId: 'canvas.app-builder', state: { note: PLACEHOLDER }, version: 1 });
}, 120_000);

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (server) await new Promise<void>((r) => server.close(() => r()));
  rmSync(packDir, { recursive: true, force: true });
});

const asProtocol = { authorization: `Bearer ${KEY}`, 'openwop-version': '2' };
const getFrame = (headers: Record<string, string> = asProtocol, path = framePath) => fetch(`${base}${path}`, { headers });
/** The routes' own refusal — not a fall-through to no route. */
async function expectUnknownPlugin(r: Response): Promise<void> {
  expect(r.status).toBe(404);
  expect(await r.json()).toMatchObject({ error: 'not_found', message: 'Unknown plugin.' });
}
const rpc = (message: unknown, path = rpcPath) => fetch(`${base}${path}`, {
  method: 'POST', headers: { ...asProtocol, 'content-type': 'application/json' }, body: JSON.stringify(message === undefined ? {} : { message }),
});

describe('ADR 0840 §B — the frame document', () => {
  it('serves the plugin HTML with an isolating, deny-egress CSP header', async () => {
    const r = await getFrame();
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await r.text()).toContain('narrow-plugin-body');
    const csp = parseCsp(r.headers.get('content-security-policy'));
    const sandbox = csp.get('sandbox') ?? [];
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
    expect(csp.get('default-src')).toEqual(["'none'"]);
    expect(csp.has('connect-src')).toBe(false);
  });

  it('an unknown plugin is 404', async () => {
    await expectUnknownPlugin(await getFrame(asProtocol, `/host/ui-plugins/${encodeURIComponent(PACK)}/nope/frame`));
  });

  it('a browser load (Accept: text/html, no OpenWOP-Version) gets the plugin, never the SPA shell', async () => {
    // The iframe `src` load. ADR 0646 would read this as the page's; a document
    // operation is the protocol's (architect #1). Resolved from the vendored path
    // manifest by operationId, which carries it since the 2.45.23 pin.
    const { DOCUMENT_OPERATION_IDS, isDocumentOperationPath } = await import('../src/middleware/protocolVersion.js');
    expect(DOCUMENT_OPERATION_IDS).toContain('getUiPluginFrame');
    expect(isDocumentOperationPath(framePath), 'the vendored manifest must name getUiPluginFrame').toBe(true);
    const r = await getFrame({ authorization: `Bearer ${KEY}`, accept: 'text/html,application/xhtml+xml' });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('narrow-plugin-body');
    expect(parseCsp(r.headers.get('content-security-policy')).get('sandbox')).toContain('allow-scripts');
  });
});

describe('ADR 0840 §C — the per-plugin dispatch', () => {
  it('runs the declared method (the control): artifact.read of the fixture artifact', async () => {
    const r = await rpc(request(1, 'artifact.read', { artifactId: ARTIFACT }));
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; result?: { payload?: unknown } };
    expect(body.ok).toBe(true);
    // The stored reference stays unresolved (RFC 0238 §C.6).
    expect(JSON.stringify(body.result?.payload)).toContain(PLACEHOLDER);
  });

  it('refuses methods the plugin did not declare, inside a 200, and never executes them', async () => {
    for (const [id, method, params] of [[2, 'artifact.write', { artifactId: ARTIFACT, version: '1', payload: { note: 'x' } }], [3, 'host.navigate', { to: '/' }]] as const) {
      const r = await rpc(request(id, method, params));
      expect(r.status, method).toBe(200);
      expect(await r.json(), method).toMatchObject({ openwop: 'ui-plugin/1', type: 'response', id, ok: false, error: { code: 'method_not_allowed' } });
    }
    const c = await getCanvasForTenant(TENANT, ARTIFACT);
    expect(c?.version).toBe(1);
    expect(JSON.stringify(c?.state)).toContain(PLACEHOLDER);
  });

  it('a method outside the ui-plugin/1 enum is 400 validation_error', async () => {
    const r = await rpc(request(4, 'host.exec'));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error?: string }).error).toBe('validation_error');
  });

  it('a body without a message is 400 validation_error', async () => {
    const r = await rpc(undefined);
    expect(r.status).toBe(400);
    // The schema validator would also 400 an absent message (a double guard); the
    // explicit check is what names the problem, so the message text is the claim.
    expect(await r.json()).toMatchObject({ error: 'validation_error', message: "body must carry a 'message' (ui-plugin/1 request)" });
  });

  it('an unknown plugin is 404, whatever the body', async () => {
    await expectUnknownPlugin(await rpc(request(5, 'host.exec'), `/host/ui-plugins/${encodeURIComponent(PACK)}/nope/rpc`));
  });
});

describe('ADR 0840 D4 — the v2 discovery record', () => {
  it('advertises uiPlugins with served: true and the cross-origin-iframe isolation the witness gates on', async () => {
    const r = await fetch(`${base}/.well-known/openwop`, { headers: { 'openwop-version': '2.0' } });
    const doc = await r.json() as { uiPlugins?: Record<string, unknown> };
    expect(doc.uiPlugins).toMatchObject({ served: true, isolation: 'cross-origin-iframe', witness: 'witnessable-gated' });
    expect(doc.uiPlugins).not.toHaveProperty('supported');
  });
});

describe('ADR 0840 — the facet gates both operations', () => {
  it('with uiPlugins not presented, the frame and the dispatch are 404', async () => {
    process.env.OPENWOP_PRESENTATION_UIPLUGINS = 'off';
    try {
      await expectUnknownPlugin(await getFrame());
      await expectUnknownPlugin(await rpc(request(6, 'artifact.read', { artifactId: ARTIFACT })));
    } finally {
      delete process.env.OPENWOP_PRESENTATION_UIPLUGINS;
    }
  });
});

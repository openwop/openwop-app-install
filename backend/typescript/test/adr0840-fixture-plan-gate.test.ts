/**
 * ADR 0840 D6 correction — the RFC 0238 fixture artifact under a NARROWED plan.
 *
 * Production narrows plans and puts app-builder on a paid tier; the conformance
 * tenant is billing-exempt for limits only (ADR 0821), so the fixture's
 * `artifact.read` hit the app-builder paywall and the suite's control leg failed
 * (`artifact_not_found`). The fix exempts exactly the operator-trusted fixture
 * artifact, in its trusted tenant. These tests pin both halves: the fixture reads,
 * and every other app-builder canvas in that tenant is still paywalled.
 *
 * Plus the global-key guard: canvas ids are global, so `ensureCanvasForTenant` must
 * refuse an id another tenant owns instead of moving that row into the caller.
 *
 * TST-BWB-5 (grade-tests w62): red when the plan exemption is dropped (the fixture is
 * paywalled) or widened to every canvas (the paid canvas reads), when
 * `ensureCanvasForTenant` loses its own-tenant early return, or loses its foreign-owner
 * refusal. That refusal is backed by `putIfAbsent` (which also fails on a taken id), so the
 * refusal alone is witnessed by the half `putIfAbsent` cannot give: no index marker for
 * the id in the caller's tenant (no phantom canvas in its list).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PACK = 'core.openwop.conformance.ui-plugin-narrow';
const TENANT = 'conf-0840-plan';
const KEY = 'k-0840-plan-0000000001';
const PAYWALLED = 'paywalled-app-canvas';
const ENV = ['OPENWOP_UI_PLUGIN_OPERATOR_TRUST', 'OPENWOP_UI_PLUGIN_OPERATOR_PACKS_DIR', 'OPENWOP_FRONTEND_PLUGIN_PACK_DIR', 'OPENWOP_API_KEYS',
  'OPENWOP_AUTH_ENFORCE_BEARER', 'OPENWOP_DEPLOY_POSTURE', 'OPENWOP_BILLING_PLAN_FEATURES'];
const saved: Record<string, string | undefined> = {};
let fixtures = ''; let emptyPacks = '';
let server: http.Server; let base = '';
let canvas: typeof import('../src/host/canvasSurface.js');

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  fixtures = mkdtempSync(join(tmpdir(), 'owp-0840-plan-'));
  emptyPacks = mkdtempSync(join(tmpdir(), 'owp-0840-plan-packs-'));
  mkdirSync(join(fixtures, 'ui'));
  const html = '<!doctype html><body>n</body>';
  const manifestBytes = Buffer.from(JSON.stringify({
    name: PACK, version: '1.0.0', kind: 'frontend-plugin', engines: { openwop: '>=2.0.0 <3.0.0' },
    uiPlugins: [{ pluginId: 'narrow', surface: 'artifact-viewer', entry: 'ui/narrow.html', hostApi: ['artifact.read'] }],
  }));
  writeFileSync(join(fixtures, 'ui', 'narrow.html'), html);
  writeFileSync(join(fixtures, 'ui-plugin-pack-narrow.json'), manifestBytes);
  const { canonicalStatement, __resetOperatorTrustedPacksForTest } = await import('../src/features/ui-plugins/operatorTrustedPacks.js');
  const keys = generateKeyPairSync('ed25519');
  const statement = canonicalStatement({ pack: PACK, version: '1.0.0', manifestSha256: sha(manifestBytes), entries: { 'ui/narrow.html': sha(html) } });
  process.env.OPENWOP_UI_PLUGIN_OPERATOR_TRUST = JSON.stringify([{
    pack: PACK, tenant: TENANT,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    signature: sign(null, Buffer.from(statement, 'utf8'), keys.privateKey).toString('base64'),
  }]);
  process.env.OPENWOP_UI_PLUGIN_OPERATOR_PACKS_DIR = fixtures;
  process.env.OPENWOP_FRONTEND_PLUGIN_PACK_DIR = emptyPacks;
  __resetOperatorTrustedPacksForTest();
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_API_KEYS = `${KEY}:${TENANT}`;
  process.env.OPENWOP_AUTH_ENFORCE_BEARER = 'true';
  process.env.OPENWOP_DEPLOY_POSTURE = 'bearer-shared';
  // The production shape: app-builder is a paid feature, the tenant is on free.
  process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing'], pro: ['billing', 'app-builder'] });
  const { createApp } = await import('../src/index.js');
  canvas = await import('../src/host/canvasSurface.js');
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { getToggleDefault } = await import('../src/host/featureToggles/registry.js');
  const { saveConfig } = await import('../src/host/featureToggles/service.js');
  const billing = getToggleDefault('billing');
  if (billing) await saveConfig({ ...billing, status: 'on' }, 'test');
  await canvas.__putCanvasForTest({ canvasId: PAYWALLED, tenantId: TENANT, canvasTypeId: 'canvas.app-builder', state: { note: 'x' }, version: 1 });
}, 120_000);

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (server) await new Promise<void>((r) => server.close(() => r()));
  for (const d of [fixtures, emptyPacks]) rmSync(d, { recursive: true, force: true });
});

const read = (artifactId: string) => fetch(`${base}/host/ui-plugins/${encodeURIComponent(PACK)}/narrow/rpc`, {
  method: 'POST',
  headers: { authorization: `Bearer ${KEY}`, 'openwop-version': '2', 'content-type': 'application/json' },
  body: JSON.stringify({ message: { openwop: 'ui-plugin/1', type: 'request', id: 1, method: 'artifact.read', params: { artifactId } } }),
});

describe('ADR 0840 D6 — the fixture artifact under a narrowed plan', () => {
  it('the trusted tenant reads the fixture artifact although its plan lacks app-builder', async () => {
    const r = await read('ui-plugin-narrow-artifact');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
  });

  it('every other app-builder canvas in that tenant is still paywalled (ADR 0821)', async () => {
    const r = await read(PAYWALLED);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: false, error: { code: 'artifact_not_found' } });
  });
});

describe('ensureCanvasForTenant — canvas ids are global keys', () => {
  it('refuses an id another tenant owns, and leaves that row where it is', async () => {
    await canvas.__putCanvasForTest({ canvasId: 'owned-elsewhere', tenantId: 'tenant-a', canvasTypeId: 'canvas.app-builder', state: { mine: true }, version: 3 });
    await expect(canvas.ensureCanvasForTenant('tenant-b', 'owned-elsewhere', { canvasTypeId: 'canvas.app-builder' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await canvas.getCanvasForTenant('tenant-b', 'owned-elsewhere')).toBeNull();
    expect((await canvas.listCanvasesForTenant('tenant-b')).map((c) => c.canvasId), 'no phantom canvas in the caller\'s list').not.toContain('owned-elsewhere');
    expect(await canvas.getCanvasForTenant('tenant-a', 'owned-elsewhere')).toMatchObject({ state: { mine: true }, version: 3 });
  });

  it('still creates once and returns the same row for its own tenant', async () => {
    const a = await canvas.ensureCanvasForTenant('tenant-c', 'fresh-id', { canvasTypeId: 'canvas.app-builder', initialState: { v: 1 } });
    const b = await canvas.ensureCanvasForTenant('tenant-c', 'fresh-id', { canvasTypeId: 'canvas.app-builder', initialState: { v: 2 } });
    expect(a).toMatchObject({ version: 1, state: { v: 1 } });
    expect(b).toMatchObject({ version: 1, state: { v: 1 } });
  });
});

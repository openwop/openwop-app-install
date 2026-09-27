/**
 * ADR 0305 Phase E — canvas version history. ROUTE-level over the app-builder
 * feature routes + the host.canvas snapshot mechanics: capture-on-save
 * (throttled, distinct-version deduped), list/get IDOR guards, non-destructive
 * restore (new head version + forced restore capture).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCanvasForTenant, snapshotCanvas, listCanvasVersions, updateCanvasForTenant, restoreCanvasVersion, getCanvasForTenant, getCanvasVersion, sweepExpiredCanvasIdem } from '../src/host/canvasSurface.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'app-builder']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client(): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
async function orgOwner(): Promise<{ c: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const tenantId = `org:test-ab-hist-${Date.now()}-${n++}`;
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `abh-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { c, orgId: org.body.orgId, tenantId };
}

const state = (label: string) => ({ name: label, screens: [{ id: 'home', name: 'Home', components: [{ type: 'text', props: { text: label } }] }] });
const AB = (orgId: string) => `/v1/host/openwop-app/app-builder/orgs/${encodeURIComponent(orgId)}`;

describe('canvas version history (ADR 0305 Phase E)', () => {
  it('editor saves capture snapshots (throttled), restore is non-destructive and force-captured', async () => {
    const { c, orgId, tenantId } = await orgOwner();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.app-builder', name: 'H', initialState: state('v1') });

    // Save 1 → captured. Save 2 immediately → throttled away (30s window).
    const s1 = await c.patch(`${AB(orgId)}/canvases/${canvas.canvasId}`, { state: state('v2'), expectedVersion: 1 });
    expect(s1.status, JSON.stringify(s1.body)).toBe(200);
    const s2 = await c.patch(`${AB(orgId)}/canvases/${canvas.canvasId}`, { state: state('v3'), expectedVersion: 2 });
    expect(s2.status).toBe(200);

    const list1 = await c.get(`${AB(orgId)}/canvases/${canvas.canvasId}/versions`);
    expect(list1.status).toBe(200);
    expect(list1.body.versions).toHaveLength(1); // second save throttled
    const captured = list1.body.versions[0];
    expect(captured.version).toBe(2);

    // Full snapshot fetch.
    const one = await c.get(`${AB(orgId)}/canvases/${canvas.canvasId}/versions/${captured.versionId}`);
    expect(one.status).toBe(200);
    expect(one.body.snapshot.name).toBe('v2');

    // Restore → NEW head version (non-destructive) + forced capture in history.
    const restore = await c.post(`${AB(orgId)}/canvases/${canvas.canvasId}/versions/${captured.versionId}/restore`);
    expect(restore.status).toBe(200);
    expect(restore.body.newVersion).toBe(4); // v3 (head 3) + restore write = 4
    const head = await c.get(`${AB(orgId)}/canvases/${canvas.canvasId}`);
    expect(head.body.state.name).toBe('v2'); // restored content
    expect(head.body.version).toBe(4);
    const list2 = await c.get(`${AB(orgId)}/canvases/${canvas.canvasId}/versions`);
    // Grade pass F7: restore force-captures the PRE-restore head too (v3 —
    // otherwise up to 30s of throttled work would vanish from history), then
    // the restore point (v4): original capture + head capture + restore capture.
    expect(list2.body.versions.length).toBe(3);
    expect(list2.body.versions[0].version).toBe(4);
  });

  it('IDOR guards: cross-tenant list/get/restore 404 (no existence leak)', async () => {
    const a = await orgOwner();
    const victim = await createCanvasForTenant(a.tenantId, { canvasTypeId: 'canvas.app-builder', name: 'V', initialState: state('secret') });
    await snapshotCanvas({ tenantId: a.tenantId, canvasId: victim.canvasId, state: state('secret'), version: 1 }, 'seed', { force: true });
    const vid = (await listCanvasVersions(a.tenantId, victim.canvasId))[0]!.versionId;

    const b = await orgOwner(); // different tenant
    expect((await b.c.get(`${AB(b.orgId)}/canvases/${victim.canvasId}/versions`)).status).toBe(404);
    expect((await b.c.get(`${AB(b.orgId)}/canvases/${victim.canvasId}/versions/${vid}`)).status).toBe(404);
    expect((await b.c.post(`${AB(b.orgId)}/canvases/${victim.canvasId}/versions/${vid}/restore`)).status).toBe(404);
  });

  it('a STALE save is a typed 409 (grade pass F1 — was a 500 through the envelope), and concurrent saves never lose an update (F5)', async () => {
    const { c, orgId, tenantId } = await orgOwner();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.app-builder', name: 'X', initialState: state('v1') });
    // Stale expectedVersion → 409 with the typed code (the editor's conflict UX contract).
    const ok = await c.patch(`${AB(orgId)}/canvases/${canvas.canvasId}`, { state: state('v2'), expectedVersion: 1 });
    expect(ok.status).toBe(200);
    const stale = await c.patch(`${AB(orgId)}/canvases/${canvas.canvasId}`, { state: state('rogue'), expectedVersion: 1 });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body.error).toBe('canvas_version_conflict');
    // CAS: two same-basis concurrent service-level writes — exactly one wins.
    const results = await Promise.allSettled([
      updateCanvasForTenant(tenantId, canvas.canvasId, state('a'), { expectedVersion: 2 }),
      updateCanvasForTenant(tenantId, canvas.canvasId, state('b'), { expectedVersion: 2 }),
    ]);
    const wins = results.filter((r) => r.status === 'fulfilled').length;
    const conflicts = results.filter((r) => r.status === 'rejected' && String((r.reason as Error).message).includes('conflict')).length;
    expect(wins).toBe(1);
    expect(conflicts).toBe(1);
  });

  it('DELETE cascades versions + share links; cross-tenant delete is a uniform 404 (grade pass DATA-3)', async () => {
    const { c, orgId, tenantId } = await orgOwner();
    const sharingToggle = getToggleDefault('sharing');
    if (sharingToggle) await saveConfig({ ...sharingToggle, status: 'on' }, 'test');
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.app-builder', name: 'D', initialState: state('v1') });
    await snapshotCanvas({ tenantId, canvasId: canvas.canvasId, state: state('v1'), version: 1 }, 'u', { force: true });
    const mint = await c.post(`/v1/host/openwop-app/sharing/orgs/${encodeURIComponent(orgId)}/links`, { resourceType: 'app_builder_canvas', resourceId: canvas.canvasId });
    expect(mint.status, JSON.stringify(mint.body)).toBe(201);
    const token = mint.body.token as string;

    // Cross-tenant delete → uniform 404; nothing removed.
    const b = await orgOwner();
    expect((await b.c.del(`${AB(b.orgId)}/canvases/${canvas.canvasId}`)).status).toBe(404);
    expect((await listCanvasVersions(tenantId, canvas.canvasId)).length).toBe(1);

    // Owner delete → 204; canvas, versions, and the share link are all gone.
    expect((await c.del(`${AB(orgId)}/canvases/${canvas.canvasId}`)).status).toBe(204);
    expect((await c.get(`${AB(orgId)}/canvases/${canvas.canvasId}`)).status).toBe(404);
    expect((await listCanvasVersions(tenantId, canvas.canvasId)).length).toBe(0);
    const anon = client();
    expect((await anon.get(`/v1/host/openwop-app/shared/${encodeURIComponent(token)}`)).status).toBe(404);
  });

  it('snapshot dedup + cap: same-version capture is idempotent; history caps at 50', async () => {
    const tenantId = `org:test-ab-cap-${Date.now()}`;
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.app-builder', name: 'C', initialState: state('x') });
    // Same-version double capture → one row.
    await snapshotCanvas({ tenantId, canvasId: canvas.canvasId, state: state('x'), version: 1 }, 'u', { force: true });
    await snapshotCanvas({ tenantId, canvasId: canvas.canvasId, state: state('x'), version: 1 }, 'u', { force: true });
    expect((await listCanvasVersions(tenantId, canvas.canvasId)).length).toBe(1);
    // 60 distinct versions → capped at 50, newest kept.
    for (let v = 2; v <= 61; v += 1) {
      await snapshotCanvas({ tenantId, canvasId: canvas.canvasId, state: state(`s${v}`), version: v }, 'u', { force: true });
    }
    const rows = await listCanvasVersions(tenantId, canvas.canvasId);
    expect(rows.length).toBe(50);
    expect(rows[0]?.version).toBe(61);
  });
});

// ── ADR 0333 grade pass — canvas data-integrity hardening (DATA-D6/7/8) ──
describe('canvas data-integrity hardening (DATA-D6/7/8)', () => {
  const okSnap = state('base');

  it('DATA-D6: restore validates the snapshot — errors reject 422 (nothing mutated), warnings restore + echo, no-validator restores', async () => {
    const tenantId = `org:test-d6-${Date.now()}`;
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.app-builder', name: 'V', initialState: okSnap });
    await snapshotCanvas({ tenantId, canvasId: canvas.canvasId, state: okSnap, version: 1 }, 'tester', { force: true });
    const vid = (await listCanvasVersions(tenantId, canvas.canvasId))[0]!.versionId;
    const before = await getCanvasForTenant(tenantId, canvas.canvasId);
    const countBefore = (await listCanvasVersions(tenantId, canvas.canvasId)).length;

    // errors → 422, and NOTHING mutated (no head bump, no forced pre-restore capture)
    const reject = (): { errors: { path: string; message: string }[]; warnings: { path: string; message: string }[] } => ({ errors: [{ path: 'x', message: 'drifted' }], warnings: [] });
    await expect(restoreCanvasVersion(tenantId, canvas.canvasId, vid, 'tester', { validate: reject })).rejects.toMatchObject({ httpStatus: 422, code: 'validation_error' });
    expect((await getCanvasForTenant(tenantId, canvas.canvasId))!.version).toBe(before!.version);
    expect((await listCanvasVersions(tenantId, canvas.canvasId)).length).toBe(countBefore);

    // warnings → restores anyway + echoes them
    const warn = (): { errors: { path: string; message: string }[]; warnings: { path: string; message: string }[] } => ({ errors: [], warnings: [{ path: 'y', message: 'heads up' }] });
    const res = await restoreCanvasVersion(tenantId, canvas.canvasId, vid, 'tester', { validate: warn });
    expect(res!.warnings).toEqual([{ path: 'y', message: 'heads up' }]);

    // no validator → restores fine (back-compat), no warnings key
    const res2 = await restoreCanvasVersion(tenantId, canvas.canvasId, vid, 'tester');
    expect(res2!.newVersion).toBeGreaterThan(before!.version);
    expect(res2!.warnings).toBeUndefined();
  });

  it('DATA-D7: idem sweep drops stale ephemeral rows, EXEMPTS from-artifact, keeps fresh', async () => {
    const tenantId = `org:test-d7-${Date.now()}`;
    const fa1 = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.app-builder', idempotencyKey: 'from-artifact:keep-me', initialState: okSnap });
    const ep1 = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.app-builder', idempotencyKey: 'plain-ephemeral', initialState: okSnap });

    // Sweep as if 100 days in the future → every existing idem row is past TTL.
    const future = Date.now() + 100 * 24 * 60 * 60 * 1000;
    expect(await sweepExpiredCanvasIdem(future)).toBeGreaterThanOrEqual(1);

    // from-artifact row EXEMPT → still dedups to the same canvas.
    const fa2 = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.app-builder', idempotencyKey: 'from-artifact:keep-me', initialState: state('fa2') });
    expect(fa2.canvasId).toBe(fa1.canvasId);
    // ephemeral row swept → a re-create with the same key mints a NEW canvas.
    const ep2 = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.app-builder', idempotencyKey: 'plain-ephemeral', initialState: state('ep2') });
    expect(ep2.canvasId).not.toBe(ep1.canvasId);

    // A fresh row survives a present-time sweep → still dedups.
    const fr1 = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.app-builder', idempotencyKey: 'fresh-keep', initialState: okSnap });
    await sweepExpiredCanvasIdem(Date.now());
    const fr2 = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.app-builder', idempotencyKey: 'fresh-keep', initialState: state('fr2') });
    expect(fr2.canvasId).toBe(fr1.canvasId);
  });

  it('DATA-D8: listCanvasVersions returns light metadata (no snapshot); the full snapshot is still fetchable', async () => {
    const tenantId = `org:test-d8-${Date.now()}`;
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.app-builder', name: 'P', initialState: okSnap });
    await snapshotCanvas({ tenantId, canvasId: canvas.canvasId, state: state('captured'), version: 1 }, 'tester', { force: true });
    const rows = await listCanvasVersions(tenantId, canvas.canvasId);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toHaveProperty('versionId');
    expect(rows[0]).toHaveProperty('version');
    expect(rows[0]).not.toHaveProperty('snapshot'); // the projection dropped the blob
    // On-demand full read still carries the snapshot.
    const full = await getCanvasVersion(tenantId, canvas.canvasId, rows[0]!.versionId);
    expect((full!.snapshot as { name?: string }).name).toBe('captured');
  });
});

/**
 * ADR 0310 Phase B — slides editor routes. ROUTE-level over the shared
 * canvas-editor factory bound to `canvas.slides`: toggle gate (404 when off),
 * catalog (fixed-schema type — empty component list + the 6 layout templates),
 * type pinning (an app-builder canvas is a uniform 404 on the slides routes),
 * editor-doc validation (id/name identity fields + schema caps → 422),
 * optimistic-concurrency saves with snapshot capture, and delete.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCanvasForTenant } from '../src/host/canvasSurface.js';
import { persistRunArtifact } from '../src/host/runArtifactStore.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
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
  const tenantId = `org:test-slides-ed-${Date.now()}-${n++}`;
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `sled-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { c, orgId: org.body.orgId, tenantId };
}

const deck = (label: string) => ({
  title: label,
  theme: 'default',
  slides: [
    { id: 'cover', name: 'Cover', layout: 'title', title: label, subtitle: 'Sub' },
    { id: 'points', name: 'Points', layout: 'title-bullets', title: 'Key points', bullets: ['a', 'b'] },
  ],
});
const SL = (orgId: string) => `/v1/host/openwop-app/slides/orgs/${encodeURIComponent(orgId)}`;

describe('slides editor routes (ADR 0310 Phase B)', () => {
  it('is toggle-gated: 404 while slides is off, then serves the catalog', async () => {
    const { c, orgId } = await orgOwner();
    // slides defaults ON (2026-07-09) — set off explicitly to test the gate.
    const d0 = getToggleDefault('slides');
    await saveConfig({ ...d0!, status: 'off' }, 'test');
    const off = await c.get(`${SL(orgId)}/catalog`);
    expect(off.status).toBe(404);

    // ADR 0319 — one toggle per canvas type; the editor gates on `slides` now.
    const d = getToggleDefault('slides');
    expect(d).toBeTruthy();
    await saveConfig({ ...d!, status: 'on' }, 'test');

    const cat = await c.get(`${SL(orgId)}/catalog`);
    expect(cat.status).toBe(200);
    expect(cat.body.canvasTypeId).toBe('canvas.slides');
    expect(cat.body.components).toHaveLength(12); // ADR 0328 P3 — the closed slide-block catalog
    expect(cat.body.templates).toHaveLength(6);
    expect(cat.body.templates.map((t: { id: string }) => t.id)).toContain('quote');
  });

  it('rejects a spoofed USER ownerSubject on from-artifact (403 — the F13 guard)', async () => {
    const { c, orgId } = await orgOwner();
    const res = await c.post(`${SL(orgId)}/canvases/from-artifact`, {
      artifactKey: 'run-x:node-y',
      ownerSubject: { kind: 'user', id: 'someone-else' },
    });
    expect(res.status).toBe(403);
  });

  // Grade pass GC-CV-8: the service idempotency (canvasFromArtifact.test) proven
  // at the ROUTE level — opening the same run artifact twice over HTTP returns
  // ONE working copy, never a duplicate.
  it('from-artifact is idempotent at the route: re-opening yields the same canvasId', async () => {
    const { c, orgId, tenantId } = await orgOwner();
    const artifactKey = `run-${Date.now()}-${n}:node-1`;
    // The ARTIFACT schema is positional (no per-slide id/name — those are the
    // editor's identity fields); the producer emits that shape.
    const artifactDeck = { title: 'Seed', slides: [{ layout: 'title', title: 'Seed', subtitle: 'Sub' }] };
    await persistRunArtifact({
      tenantId, runId: artifactKey.split(':')[0]!, nodeId: 'node-1', role: 'deliverable', now: new Date().toISOString(),
      output: { artifact: { artifactTypeId: 'canvas.slides', payload: artifactDeck, title: 'Seed' } },
    });
    const first = await c.post(`${SL(orgId)}/canvases/from-artifact`, { artifactKey });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.canvasTypeId).toBe('canvas.slides');
    const second = await c.post(`${SL(orgId)}/canvases/from-artifact`, { artifactKey });
    expect(second.status).toBe(201);
    expect(second.body.canvasId).toBe(first.body.canvasId);
  });

  it('pins the canvas type: an app-builder canvas is a uniform 404 on slides routes', async () => {
    const { c, orgId, tenantId } = await orgOwner();
    const foreign = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.app-builder', name: 'A', initialState: { name: 'A', screens: [] } });
    const res = await c.get(`${SL(orgId)}/canvases/${foreign.canvasId}`);
    expect(res.status).toBe(404);
    const patch = await c.patch(`${SL(orgId)}/canvases/${foreign.canvasId}`, { state: deck('x'), expectedVersion: 1 });
    expect(patch.status).toBe(404);
  });

  it('validates the editor doc: schema caps + identity fields reject with 422', async () => {
    const { c, orgId, tenantId } = await orgOwner();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.slides', name: 'D', initialState: deck('v1') });

    const badLayout = await c.patch(`${SL(orgId)}/canvases/${canvas.canvasId}`, { state: { title: 'x', slides: [{ id: 's1', name: 'S', layout: 'holo-deck' }] }, expectedVersion: 1 });
    expect(badLayout.status).toBe(422);

    const missingId = await c.patch(`${SL(orgId)}/canvases/${canvas.canvasId}`, { state: { title: 'x', slides: [{ layout: 'title' }] }, expectedVersion: 1 });
    expect(missingId.status).toBe(422);

    const dupIds = await c.patch(`${SL(orgId)}/canvases/${canvas.canvasId}`, { state: { title: 'x', slides: [{ id: 's1', name: 'S', layout: 'title' }, { id: 's1', name: 'T', layout: 'blank' }] }, expectedVersion: 1 });
    expect(dupIds.status).toBe(422);

    const tooManyBullets = await c.patch(`${SL(orgId)}/canvases/${canvas.canvasId}`, { state: { title: 'x', slides: [{ id: 's1', name: 'S', layout: 'title-bullets', bullets: Array.from({ length: 13 }, (_, i) => `b${i}`) }] }, expectedVersion: 1 });
    expect(tooManyBullets.status).toBe(422);

    const unknownField = await c.patch(`${SL(orgId)}/canvases/${canvas.canvasId}`, { state: { title: 'x', slides: [{ id: 's1', name: 'S', layout: 'blank', script: 'alert(1)' }] }, expectedVersion: 1 });
    expect(unknownField.status).toBe(422);
  });

  it('saves with optimistic concurrency, captures a version, and deletes', async () => {
    const { c, orgId, tenantId } = await orgOwner();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.slides', name: 'D', initialState: deck('v1') });

    const save = await c.patch(`${SL(orgId)}/canvases/${canvas.canvasId}`, { state: deck('v2'), expectedVersion: 1 });
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    expect(save.body.newVersion).toBe(2);
    expect(save.body.warnings).toEqual([]);

    const stale = await c.patch(`${SL(orgId)}/canvases/${canvas.canvasId}`, { state: deck('v3'), expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code ?? stale.body.error).toBe('canvas_version_conflict');

    const versions = await c.get(`${SL(orgId)}/canvases/${canvas.canvasId}/versions`);
    expect(versions.status).toBe(200);
    expect(versions.body.versions).toHaveLength(1);

    const del = await c.del(`${SL(orgId)}/canvases/${canvas.canvasId}`);
    expect(del.status).toBe(204);
    const gone = await c.get(`${SL(orgId)}/canvases/${canvas.canvasId}`);
    expect(gone.status).toBe(404);
  });

  // ADR 0314 — the Documents creation gallery's blank create.
  it('POST /canvases creates a validated blank deck carrying name + a REAL projectId, and round-trips', async () => {
    const { c, orgId } = await orgOwner();
    // The projectId must resolve to THIS org (grade pass DATA-CV) — create a real one.
    const proj = getToggleDefault('projects');
    if (proj) await saveConfig({ ...proj, status: 'on' }, 'test');
    const project = await c.post('/v1/host/openwop-app/projects', { orgId, name: 'Launch' });
    expect(project.status, JSON.stringify(project.body)).toBe(201);
    const projectId = project.body.id;

    const r = await c.post(`${SL(orgId)}/canvases`, { name: 'Board pitch', projectId });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.canvasTypeId).toBe('canvas.slides');
    expect(r.body.name).toBe('Board pitch');
    expect(r.body.projectId).toBe(projectId);
    // The blank passes the slides validator: one title slide seeded with the name.
    expect(r.body.state.title).toBe('Board pitch');
    expect(r.body.state.slides).toHaveLength(1);
    expect(r.body.state.slides[0].layout).toBe('title');

    const got = await c.get(`${SL(orgId)}/canvases/${r.body.canvasId}`);
    expect(got.status).toBe(200);
    expect(got.body.version).toBe(1);
  });

  it('POST /canvases keeps the F13 spoof guard: a foreign user ownerSubject is 403', async () => {
    const { c, orgId } = await orgOwner();
    const r = await c.post(`${SL(orgId)}/canvases`, { name: 'X', ownerSubject: { kind: 'user', id: 'user:someone-else' } });
    expect(r.status).toBe(403);
  });

  // Grade pass DATA-CV: a projectId/ownerSubject must RESOLVE (not a free tag).
  it('POST /canvases rejects a dangling projectId (404), not a stored dangling reference', async () => {
    const { c, orgId } = await orgOwner();
    const r = await c.post(`${SL(orgId)}/canvases`, { name: 'X', projectId: 'proj-does-not-exist' });
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    const r2 = await c.post(`${SL(orgId)}/canvases`, { name: 'Y', ownerSubject: { kind: 'project', id: 'proj-nope' } });
    expect(r2.status).toBe(404);
  });

  // ADR 0328 Phase 0+1 — the export verb mints a real downloadable asset.
  it('POST /canvases/:id/export mints a pptx capability-token download (and validates format)', async () => {
    const { c, orgId } = await orgOwner();
    const created = await c.post(`${SL(orgId)}/canvases`, { name: 'Deck', initialState: { title: 'Deck', slides: [{ id: 's1', name: 'S1', layout: 'title', title: 'Deck', notes: 'hello' }] } });
    expect(created.status).toBe(201);
    const bad = await c.post(`${SL(orgId)}/canvases/${created.body.canvasId}/export`, { format: 'docx' });
    expect(bad.status).toBe(400);
    const res = await c.post(`${SL(orgId)}/canvases/${created.body.canvasId}/export`, { format: 'pptx' });
    expect(res.status).toBe(201);
    expect(res.body.assetToken).toBeTruthy();
    expect(res.body.serveUrl).toContain('/assets/');
    expect(res.body.fileName).toBe('deck.pptx');
    const pdf = await c.post(`${SL(orgId)}/canvases/${created.body.canvasId}/export`, { format: 'pdf' });
    expect(pdf.status).toBe(201);
    expect(pdf.body.fileName).toBe('deck.pdf');
  });

  // Grade pass GC-CV: an optional idempotency key dedups a retried create.
  it('POST /canvases dedups a retry carrying the same idempotencyKey', async () => {
    const { c, orgId } = await orgOwner();
    const key = `k-${Date.now()}-${n}`;
    const a = await c.post(`${SL(orgId)}/canvases`, { name: 'Once', idempotencyKey: key });
    const b = await c.post(`${SL(orgId)}/canvases`, { name: 'Once', idempotencyKey: key });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.canvasId).toBe(a.body.canvasId);
  });
});

// ── ADR 0328 Phase 4 — the present-remote capability + public routes. ──────
describe('present remote (ADR 0328 P4)', () => {
  it('mints behind the org gate, serves the outline publicly, accepts commands, and 404s bad tokens uniformly', async () => {
    const { c, orgId } = await orgOwner();
    const created = await c.post(`${SL(orgId)}/canvases`, { name: 'Show' });
    expect(created.status).toBe(201);
    // Blank create ignores caller state — PATCH the real deck in.
    const patched = await c.patch(`${SL(orgId)}/canvases/${created.body.canvasId}`, {
      state: {
        title: 'Show',
        slides: [
          { id: 's1', name: 'Opening', layout: 'title', title: 'Show', notes: 'welcome them' },
          { id: 's2', name: 'Hidden', layout: 'blank', skip: true },
        ],
      },
    });
    expect(patched.status).toBe(200);
    const minted = await c.post(`${SL(orgId)}/canvases/${created.body.canvasId}/present-remote`);
    expect(minted.status).toBe(201);
    expect(minted.body.token).toMatch(/^v1\./);
    expect(new Date(minted.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // The outline is public — the token IS the credential (no cookie sent).
    const pub = client();
    const outline = await pub.get(`/v1/host/openwop-app/present/${encodeURIComponent(minted.body.token)}/outline`);
    expect(outline.status).toBe(200);
    expect(outline.body.title).toBe('Show');
    expect(outline.body.frames).toEqual([
      { name: 'Opening', notes: 'welcome them' },
      { name: 'Hidden', skip: true },
    ]);

    // Commands validate; a good one is accepted (202 — fan-out is async).
    const badCmd = await pub.post(`/v1/host/openwop-app/present/${encodeURIComponent(minted.body.token)}/command`, { action: 'launch' });
    expect(badCmd.status).toBe(400);
    const cmd = await pub.post(`/v1/host/openwop-app/present/${encodeURIComponent(minted.body.token)}/command`, { action: 'next' });
    expect(cmd.status).toBe(202);
    const pos = await pub.post(`/v1/host/openwop-app/present/${encodeURIComponent(minted.body.token)}/state`, { current: 1 });
    expect(pos.status).toBe(202);

    // Bad/expired tokens are a uniform 404 on every route.
    for (const path of ['outline', 'command', 'state', 'events'] as const) {
      const method = path === 'outline' || path === 'events' ? 'get' : 'post';
      const r = await pub[method](`/v1/host/openwop-app/present/not-a-token/${path}`, method === 'post' ? { action: 'next', current: 0 } : undefined);
      expect(r.status, path).toBe(404);
    }
  });

  it('does not mint for a caller outside the org', async () => {
    const { c, orgId } = await orgOwner();
    const created = await c.post(`${SL(orgId)}/canvases`, { name: 'Mine' });
    const outsider = await orgOwner();
    const r = await outsider.c.post(`${SL(orgId)}/canvases/${created.body.canvasId}/present-remote`);
    expect([403, 404]).toContain(r.status);
  });

  // SL-5 (grade pass 2026-07-10) — the present SSE route's teardown over real
  // HTTP: opening /events subscribes; destroying the socket must unsubscribe
  // (the #1594 B3 onClose wiring). The disconnect-DURING-the-awaited-subscribe
  // race leg stays unit-reasoned in the route (fault injection there would
  // mock the very ordering under test); this pins the normal path.
  it('the events SSE unsubscribes when the client disconnects', async () => {
    const { __presentNavSubscriberCountForTests } = await import('../src/host/presentRemote.js');
    const { c, orgId } = await orgOwner();
    const created = await c.post(`${SL(orgId)}/canvases`, { name: 'SSE show' });
    const minted = await c.post(`${SL(orgId)}/canvases/${created.body.canvasId}/present-remote`);
    expect(minted.status).toBe(201);
    const before = __presentNavSubscriberCountForTests();

    // Open the SSE stream raw (fetch would buffer; use http directly).
    const { get } = await import('node:http');
    const url = new URL(`${BASE}/v1/host/openwop-app/present/${encodeURIComponent(minted.body.token)}/events`);
    const req2 = get(url, { headers: { accept: 'text/event-stream' } });
    await new Promise<void>((resolve, reject) => {
      req2.on('response', (res) => { expect(res.statusCode).toBe(200); resolve(); });
      req2.on('error', reject);
    });
    // Subscription becomes live shortly after headers.
    await new Promise((r) => setTimeout(r, 150));
    expect(__presentNavSubscriberCountForTests()).toBe(before + 1);

    req2.destroy(); // client walks away mid-stream
    for (let i = 0; i < 40 && __presentNavSubscriberCountForTests() > before; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(__presentNavSubscriberCountForTests()).toBe(before);
  });

  // GC-SL-3 (grade pass 2026-07-10) — the token grants nav CONTROL, so
  // minting requires workspace:write: a viewer-role member reads the deck
  // but cannot mint a remote for it.
  it('a viewer-role member cannot mint (write-scoped), though they can read the canvas', async () => {
    const tenantId = `org:test-slides-ed-${Date.now()}-${n++}`;
    const owner = client();
    expect((await owner.post('/v1/host/openwop-app/test/login', { email: `sled-own-${n}@acme.test`, tenantId })).status).toBe(201);
    const viewer = client();
    const vLogin = await viewer.post('/v1/host/openwop-app/test/login', { email: `sled-view-${n}@acme.test`, tenantId });
    expect(vLogin.status).toBe(201);
    const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
    const orgId: string = org.body.orgId;
    const add = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, {
      displayName: 'RO', subject: vLogin.body.user.userId, roles: ['viewer'],
    });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    const created = await owner.post(`${SL(orgId)}/canvases`, { name: 'Deck' });
    expect(created.status).toBe(201);
    expect((await viewer.get(`${SL(orgId)}/canvases/${created.body.canvasId}`)).status).toBe(200);
    expect((await viewer.post(`${SL(orgId)}/canvases/${created.body.canvasId}/present-remote`)).status).toBe(403);
  });
});

// ── ADR 0328 Phase 7 — .pptx import (text fidelity) + share wiring. ────────
describe('pptx import (ADR 0328 P7)', () => {
  it('roundtrips: a deck exported by our own exporter imports with titles, bullets, and notes', async () => {
    const { renderDeckToPptx } = await import('../src/features/slides/export/slidesExport.js');
    const buf = await renderDeckToPptx({
      title: 'Roundtrip',
      theme: 'default',
      slides: [
        { layout: 'title', title: 'Roundtrip', subtitle: 'The import test', notes: 'welcome everyone' },
        { layout: 'title-bullets', title: 'Points', bullets: ['Alpha', 'Beta'] },
      ],
    });
    const { c, orgId } = await orgOwner();
    const res = await c.post(`${SL(orgId)}/canvases/import`, { fileBase64: Buffer.from(buf).toString('base64'), name: 'Imported' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.canvasTypeId).toBe('canvas.slides');
    const got = await c.get(`${SL(orgId)}/canvases/${res.body.canvasId}`);
    expect(got.status).toBe(200);
    const slides = got.body.state.slides as { title?: string; bullets?: string[]; notes?: string }[];
    expect(slides.length).toBe(2);
    expect(slides[0]?.title).toBe('Roundtrip');
    expect(slides[0]?.notes).toContain('welcome everyone');
    expect(slides[1]?.bullets).toEqual(expect.arrayContaining(['Alpha', 'Beta']));
  });

  // SL-G8 (round 3) — skip reasons are CODED data; the legacy strings are
  // DERIVED from them through skipText, so the two wire fields cannot drift.
  it('SL-G8: parsePptx returns coded reasons and derives the legacy strings from them', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<p:sld><p:pic/><a:t>Only text came over</a:t></p:sld>');
    const buf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    const { parsePptx, skipText } = await import('../src/features/slides/import/pptxImport.js');
    const out = await parsePptx(buf);
    expect(out.skippedCoded).toEqual([{ code: 'rich-content', slide: 1 }]);
    expect(out.skipped).toEqual(out.skippedCoded.map(skipText));
    expect(out.skipped[0]).toBe('slide 1: images/charts/tables are not imported (text only)');
  });

  it('SL-G8: the import route DUAL-EMITS skipped + skippedCoded (older clients keep their wire)', async () => {
    const { storeMediaAsset } = await import('../src/host/inMemorySurfaces.js');
    const { renderDeckToPptx } = await import('../src/features/slides/export/slidesExport.js');
    const { c, orgId } = await orgOwner();
    const png = Buffer.alloc(256, 7);
    const { url } = await storeMediaAsset('t-est', { contentBase64: png.toString('base64'), contentType: 'image/png' });
    const buf = await renderDeckToPptx({
      title: 'Pic deck',
      theme: 'default',
      slides: [{ layout: 'image', title: 'Has a picture', imageUrl: url }],
    });
    const res = await c.post(`${SL(orgId)}/canvases/import`, { fileBase64: Buffer.from(buf).toString('base64'), name: 'Pic' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.skippedCoded).toEqual([{ code: 'rich-content', slide: 1 }]);
    expect(res.body.skipped).toEqual(['slide 1: images/charts/tables are not imported (text only)']);
  });

  it('rejects garbage and oversized uploads honestly', async () => {
    const { c, orgId } = await orgOwner();
    const bad = await c.post(`${SL(orgId)}/canvases/import`, { fileBase64: Buffer.from('not a zip').toString('base64') });
    expect(bad.status).toBe(422);
    const missing = await c.post(`${SL(orgId)}/canvases/import`, {});
    expect(missing.status).toBe(400);
  });

  // GC-SL-1/GC-SL-7 — the decompression-bomb regression pin: a tiny COMPRESSED
  // upload whose slide part inflates past the 5 MB per-entry cap must refuse
  // (422), not commit the memory. 6 MB of one repeated byte compresses to a
  // few KB, so this sails under the route's 15 MB base64 cap.
  // GC-SL-4 (grade pass 2026-07-10) — the pre-flight size estimate refuses an
  // over-cap deck BEFORE the render commits the buffer: embedded media are
  // what blow the cap (each reference embeds a copy), so 45 slides × a ~800 KB
  // asset ≈ 35 MiB estimated > the 25 MiB cap ⇒ 413 mentioning the estimate.
  it('export refuses pre-render when embedded media would exceed the cap (estimate 413)', async () => {
    const { storeMediaAsset } = await import('../src/host/inMemorySurfaces.js');
    const { exportSlides } = await import('../src/features/slides/export/slidesExport.js');
    const bytes = Buffer.alloc(800 * 1024, 7);
    const { url } = await storeMediaAsset('t-est', { contentBase64: bytes.toString('base64'), contentType: 'image/png' });
    const deck = {
      title: 'Heavy',
      slides: Array.from({ length: 45 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, layout: 'image', title: `S${i}`, imageUrl: url })),
    };
    const err = await exportSlides('t-est', deck, 'pptx').then(() => null, (e: unknown) => e);
    expect(err).toBeTruthy();
    expect((err as { httpStatus?: number }).httpStatus).toBe(413);
    expect(String((err as Error).message)).toContain('estimated');
  });

  // SL-6 (grade pass 2026-07-10) — the jszip-internals tripwire: the
  // pre-decompress size guard reads jszip's private `_data.uncompressedSize`.
  // If a jszip upgrade drops that field the bomb guard silently degrades to
  // post-decompress checks; this fails loud instead.
  it('jszip still exposes the structural uncompressed size the bomb guard reads (upgrade tripwire)', async () => {
    const { default: JSZip } = await import('jszip');
    const { __uncompressedSizeOfForTests } = await import('../src/features/slides/import/pptxImport.js');
    const zip = new JSZip();
    const body = 'x'.repeat(12345);
    zip.file('probe.xml', body, { compression: 'DEFLATE' });
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const reloaded = await JSZip.loadAsync(buf);
    expect(__uncompressedSizeOfForTests(reloaded.file('probe.xml')!)).toBe(body.length);
  });

  it('refuses a zip whose slide part inflates past the decompression budget (bomb pin)', async () => {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    const bomb = `<p:sp><a:p><a:t>${'A'.repeat(6 * 1024 * 1024)}</a:t></a:p></p:sp>`;
    zip.file('ppt/slides/slide1.xml', bomb, { compression: 'DEFLATE' });
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(buf.length).toBeLessThan(1024 * 1024); // the whole point: tiny on the wire
    const { c, orgId } = await orgOwner();
    const res = await c.post(`${SL(orgId)}/canvases/import`, { fileBase64: buf.toString('base64') });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(String(res.body?.message ?? '')).toContain('too large');
  });
});

describe('share wiring + per-frame analytics (ADR 0328 P7)', () => {
  it('mints a slides_canvas link, resolves the deck publicly, records frame views, and reports them to the owner', async () => {
    const { c, orgId } = await orgOwner();
    // sharing rides its own toggle.
    const sharing = getToggleDefault('sharing');
    if (sharing) await saveConfig({ ...sharing, status: 'on' }, 'test');
    const created = await c.post(`${SL(orgId)}/canvases`, { name: 'Shared deck' });
    expect(created.status).toBe(201);
    const link = await c.post(`/v1/host/openwop-app/sharing/orgs/${encodeURIComponent(orgId)}/links`, {
      resourceType: 'slides_canvas', resourceId: created.body.canvasId,
    });
    expect(link.status, JSON.stringify(link.body)).toBe(201);

    const pub = client();
    const shared = await pub.get(`/v1/host/openwop-app/shared/${link.body.token}`);
    expect(shared.status).toBe(200);
    expect(shared.body.resourceType).toBe('slides_canvas');
    expect(shared.body.resource.kind).toBe('slides_canvas');
    expect(Array.isArray(shared.body.resource.deck.slides)).toBe(true);

    // The public viewer reports frame views; the owner reads the tallies.
    expect((await pub.post(`/v1/host/openwop-app/shared/${link.body.token}/frame-view`, { frame: 0 })).status).toBe(204);
    expect((await pub.post(`/v1/host/openwop-app/shared/${link.body.token}/frame-view`, { frame: 0 })).status).toBe(204);
    expect((await pub.post(`/v1/host/openwop-app/shared/${link.body.token}/frame-view`, { frame: 1 })).status).toBe(204);
    expect((await pub.post(`/v1/host/openwop-app/shared/${link.body.token}/frame-view`, { frame: -1 })).status).toBe(400);
    // Grade pass: frame indexes are bounded by the largest legal deck (100).
    expect((await pub.post(`/v1/host/openwop-app/shared/${link.body.token}/frame-view`, { frame: 100 })).status).toBe(400);
    expect((await pub.post(`/v1/host/openwop-app/shared/not-a-token/frame-view`, { frame: 0 })).status).toBe(404);

    const views = await c.get(`/v1/host/openwop-app/sharing/orgs/${encodeURIComponent(orgId)}/links/${link.body.token}/frame-views`);
    expect(views.status).toBe(200);
    expect(views.body.frames).toEqual([{ frame: 0, count: 2 }, { frame: 1, count: 1 }]);

    // Grade pass (DATA blocker): deleting the canvas cascades link purge AND
    // the frame-view rows — nothing orphans.
    const { _frameViewCountForToken } = await import('../src/features/sharing/sharingService.js');
    expect(await _frameViewCountForToken(link.body.token)).toBe(2); // frames 0 and 1
    const del = await c.del(`${SL(orgId)}/canvases/${created.body.canvasId}`);
    expect(del.status).toBe(204);
    expect(await _frameViewCountForToken(link.body.token)).toBe(0);
  });
});

describe('R2 SL-SP-1 — the PUBLIC share payload is the AUDIENCE projection, on the WIRE', () => {
  it('speaker notes and skipped-slide content never leave the server; positional indices survive', async () => {
    const { c, orgId } = await orgOwner();
    const sharing = getToggleDefault('sharing');
    if (sharing) await saveConfig({ ...sharing, status: 'on' }, 'test');
    const created = await c.post(`${SL(orgId)}/canvases`, { name: 'Backstage deck' });
    expect(created.status).toBe(201);
    // Author a deck with notes on every slide and a fully-authored SKIPPED slide.
    const patched = await c.patch(`${SL(orgId)}/canvases/${created.body.canvasId}`, {
      baseRevision: created.body.revision,
      state: {
        title: 'Backstage deck', theme: 'default',
        slides: [
          { id: 'cover', name: 'Cover', layout: 'title', title: 'Public headline', notes: 'SECRET cover notes' },
          { id: 'hidden', name: 'Hidden', layout: 'title', title: 'RETRACTED slide content', notes: 'SECRET hidden notes', skip: true },
          { id: 'end', name: 'End', layout: 'title', title: 'Public end', notes: 'SECRET end notes' },
        ],
      },
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const link = await c.post(`/v1/host/openwop-app/sharing/orgs/${encodeURIComponent(orgId)}/links`, {
      resourceType: 'slides_canvas', resourceId: created.body.canvasId,
    });
    expect(link.status).toBe(201);

    const shared = await client().get(`/v1/host/openwop-app/shared/${link.body.token}`);
    expect(shared.status).toBe(200);
    // The WHOLE response — not just the rendered DOM — must be backstage-free.
    const raw = JSON.stringify(shared.body);
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain('RETRACTED');
    // The skipped slide survives as a positional stub (the frame-view analytics
    // contract is pinned to RAW deck indices — compacting would corrupt it).
    const slides = shared.body.resource.deck.slides as Array<Record<string, unknown>>;
    expect(slides).toHaveLength(3);
    expect(slides[1]).toEqual({ skip: true });
    // The visible slides keep their audience content.
    expect(slides[0]!.title).toBe('Public headline');
    expect(slides[2]!.title).toBe('Public end');
  });
});

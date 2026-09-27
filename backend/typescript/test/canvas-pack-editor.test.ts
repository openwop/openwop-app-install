/**
 * ADR 0310 Phase D — Tier-1 FE-less canvas packs. End-to-end over the witness
 * pack (packs/community.openwop.canvas-checklist): the artifact-type pack
 * loader parses the `x-openwop-app.canvas` vendor extension (catalog + editor
 * hints), the `canvas-packs` feature registers generic editor routes for the
 * pack type, the catalog route carries the hints (`editor`), and saves are
 * validated by the PACK'S OWN artifact schema. Plus loader isolation: a
 * malformed extension never blocks the artifact type itself.
 */

import http from 'node:http';
import { cpSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadArtifactTypePacks } from '../src/host/artifactTypePackLoader.js';
import { getPackCanvasType } from '../src/host/canvasPackTypes.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCanvasForTenant } from '../src/host/canvasSurface.js';
import { collabCanvasType } from '../src/host/collab/collabRegistry.js';
import { createMember } from '../src/host/accessControlService.js';

// TIMEOUT CLIFF — this file's `beforeAll` does MORE than the ~10s `createApp`
// boot the global `hookTimeout: 30_000` was sized for: it also generates an
// ed25519 keypair, writes and SIGNS a fixture pack, and only then boots. Measured
// unloaded, the whole file costs ~21-24s — a 1.3x margin on a 30s hook budget,
// which is not a margin. It went red in a full run purely because a PARALLEL
// SESSION was running its own backend suite on the same machine.
//
// Per-file rather than raising the global: 537 of the ~540 boot-in-hook files
// really are ~10s, and giving all of them a 2-minute budget would turn every
// genuinely stuck hook into a two-minute hang. The outliers pay for themselves.
//
// The rule, third recurrence now: A HOOK OR TEST WHOSE HONEST COST SITS WITHIN
// ONE ORDER OF MAGNITUDE OF ITS TIMEOUT IS A SCHEDULED FLAKE — it is waiting for
// a busy machine, not for a bug.
vi.setConfig({ hookTimeout: 120_000 });


let BASE: string;
let server: http.Server;

const TYPE = 'canvas.checklist';
const REPO_PACK = join(process.cwd(), '..', '..', 'packs', 'community.openwop.canvas-checklist');

let prevPackDir: string | undefined;
beforeAll(async () => {
  // Deterministic pack surface: an empty main pack dir + a fixture root
  // holding ONLY the witness pack (copied from the repo's vendored packs/).
  const packRoot = mkdtempSync(join(tmpdir(), 'owp-canvas-pack-'));
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'owp-canvas-pack-fixture-'));
  cpSync(REPO_PACK, join(fixtureRoot, 'community.openwop.canvas-checklist'), { recursive: true });
  // An EVIL pack claiming a first-party canvas type id — the poisoning probe.
  mkdirSync(join(fixtureRoot, 'evil-pack'));
  writeFileSync(join(fixtureRoot, 'evil-pack', 'pack.json'), JSON.stringify({
    name: 'evil.canvas.pack',
    version: '1.0.0',
    kind: 'artifact-type',
    artifactTypes: [{
      artifactTypeId: 'canvas.slides',
      schema: { type: 'object' },
      'x-openwop-app.canvas': {
        catalog: [{ type: 'evil-widget', label: 'Evil', category: 'display' }],
        editor: { collections: [{ key: 'items', label: 'X', max: 5, adders: [{ id: 'a', label: 'A', defaults: {} }], fields: [] }] },
      },
    }],
  }));
  prevPackDir = process.env.OPENWOP_PACK_DIR;
  process.env.OPENWOP_PACK_DIR = packRoot;
  process.env.OPENWOP_ARTIFACT_TYPE_PACKS_DIR = fixtureRoot;

  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const { createApp } = await import('../src/index.js');
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'canvas-packs']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  // See chainpack-signature: process.env outlives a FILE inside a vitest worker,
  // and `resolveDefaultPackDir()` reads OPENWOP_PACK_DIR at call time. Leaving it
  // set pointed every later file in this worker at THIS test's temp pack dir.
  if (prevPackDir === undefined) delete process.env.OPENWOP_PACK_DIR;
  else process.env.OPENWOP_PACK_DIR = prevPackDir;
});

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
  const tenantId = `org:test-cvpack-${Date.now()}-${n++}`;
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `cvp-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { c, orgId: org.body.orgId, tenantId };
}

const BASEP = (orgId: string) => `/v1/host/openwop-app/canvas-packs/${TYPE}/orgs/${encodeURIComponent(orgId)}`;
const deck = { title: 'Groceries', items: [{ text: 'Milk', done: false, priority: 'high' }] };

describe('canvas packs (ADR 0310 Phase D)', () => {
  it('the loader registered the witness pack type + editor hints', () => {
    const t = getPackCanvasType(TYPE);
    expect(t).toBeTruthy();
    expect(t!.packName).toBe('community.openwop.canvas-checklist');
    expect(t!.editor?.docNameKey).toBe('title');
    expect(t!.editor?.collections[0]).toMatchObject({ key: 'items', label: 'Items', max: 200, min: 1, itemLabelField: 'text' });
  });

  it('serves the catalog with the editor hints for the pack type', async () => {
    const { c, orgId } = await orgOwner();
    const cat = await c.get(`${BASEP(orgId)}/catalog`);
    expect(cat.status).toBe(200);
    expect(cat.body.canvasTypeId).toBe(TYPE);
    expect(cat.body.editor.collections).toHaveLength(1);
    expect(cat.body.editor.collections[0].adders[0].label).toBe('Checklist item');
  });

  it("validates saves with the pack's own artifact schema (422) and round-trips a clean save", async () => {
    const { c, orgId, tenantId } = await orgOwner();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: TYPE, name: 'G', initialState: deck });

    const badEnum = await c.patch(`${BASEP(orgId)}/canvases/${canvas.canvasId}`, { state: { items: [{ text: 'x', priority: 'urgent' }] }, expectedVersion: 1 });
    expect(badEnum.status).toBe(422);
    const unknownField = await c.patch(`${BASEP(orgId)}/canvases/${canvas.canvasId}`, { state: { items: [{ text: 'x', script: 'alert(1)' }] }, expectedVersion: 1 });
    expect(unknownField.status).toBe(422);
    const empty = await c.patch(`${BASEP(orgId)}/canvases/${canvas.canvasId}`, { state: { items: [] }, expectedVersion: 1 });
    expect(empty.status).toBe(422); // minItems 1

    const save = await c.patch(`${BASEP(orgId)}/canvases/${canvas.canvasId}`, { state: { ...deck, items: [...deck.items, { text: 'Bread' }] }, expectedVersion: 1 });
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    expect(save.body.newVersion).toBe(2);

    const del = await c.del(`${BASEP(orgId)}/canvases/${canvas.canvasId}`);
    expect(del.status).toBe(204);
  });

  it('pins the type: a slides canvas is a uniform 404 on the pack routes', async () => {
    const { c, orgId, tenantId } = await orgOwner();
    const foreign = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.slides', name: 'S', initialState: { title: 'S', slides: [{ layout: 'title' }] } });
    expect((await c.get(`${BASEP(orgId)}/canvases/${foreign.canvasId}`)).status).toBe(404);
  });

  it('a pack claiming a HOST canvas type cannot poison its catalog (code-review HIGH)', async () => {
    // The evil pack was placed in the fixture root BEFORE boot (beforeAll),
    // claiming canvas.slides with a catalog + editor. The loader stashes it,
    // but the canvas-packs feature skips it (host-owned at feature time), so:
    const { listCanvasComponents } = await import('../src/host/canvasComponentCatalog.js');
    const slidesCatalog = listCanvasComponents('canvas.slides');
    expect(slidesCatalog.some((c) => c.type === 'evil-widget')).toBe(false);
    // ...and no editor routes exist under the pack namespace for the host id.
    const { c, orgId } = await orgOwner();
    const res = await c.get(`/v1/host/openwop-app/canvas-packs/canvas.slides/orgs/${encodeURIComponent(orgId)}/catalog`);
    expect(res.status).toBe(404);
  });

  // ADR 0314 — the Documents creation gallery enumerates pack types + creates blanks.
  it('lists the served pack types (title from the artifact type) and never the evil claim', async () => {
    const { c, orgId } = await orgOwner();
    const r = await c.get(`/v1/host/openwop-app/canvas-packs/orgs/${encodeURIComponent(orgId)}/types`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.types).toEqual([{ canvasTypeId: TYPE, title: 'Checklist' }]);
  });

  it('POST /canvases derives a blank from the editor hints that the PACK SCHEMA accepts', async () => {
    const { c, orgId } = await orgOwner();
    const r = await c.post(`${BASEP(orgId)}/canvases`, { name: 'Groceries' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.canvasTypeId).toBe(TYPE);
    // docNameKey='title' seeds the name; `items` min=1 floor seeds the first
    // adder's defaults — which the pack's own schema (required text) accepts.
    expect(r.body.state.title).toBe('Groceries');
    expect(r.body.state.items).toEqual([{ text: 'New item', done: false }]);
  });

  it('isolates a malformed canvas extension — the artifact type still registers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-bad-canvas-pack-'));
    mkdirSync(join(dir, 'bad-pack'));
    writeFileSync(join(dir, 'bad-pack', 'pack.json'), JSON.stringify({
      name: 'bad.canvas.pack',
      version: '1.0.0',
      kind: 'artifact-type',
      artifactTypes: [{
        artifactTypeId: 'canvas.badpack',
        schema: { type: 'object' },
        'x-openwop-app.canvas': { editor: { collections: 'not-an-array' } },
      }],
    }));
    const out = loadArtifactTypePacks({ roots: [dir] });
    expect(out.registered).toContain('canvas.badpack');
    expect(out.errors.some((e) => e.message.includes('x-openwop-app.canvas rejected'))).toBe(true);
    expect(getPackCanvasType('canvas.badpack')).toBeUndefined();
  });
});

/**
 * `CPKC-2` — the two crux invariants of the pack-canvas surface, as NEGATIVE tests.
 *
 * Both are protections by OMISSION, which is the kind that disappears quietly:
 *
 *  (a) **Collab exclusion.** The chassis registers a collab room only when a caller
 *      passes `collab: true` (`canvasEditorRoutes.ts:176`). Pack canvases deliberately
 *      do not — an untrusted, pack-defined document shape has no business driving a
 *      live CRDT room. Nothing asserted the absence, so adding the flag would look
 *      like a feature and silently cross a trust boundary.
 *
 *  (b) **The ADR 0610 read gate.** Pack canvases register through the same chassis as
 *      first-party types, so they inherit the subject-access gate in `loadCanvas` — but
 *      that inheritance was, again, asserted for other types only.
 */
describe('CPKC-2 — the pack-canvas trust boundary, asserted negatively', () => {
  it('(a) a pack canvas type is ABSENT from the collab registry — no live room for an untrusted shape', () => {
    expect(getPackCanvasType(TYPE), 'control: the pack type IS served as an editor').toBeTruthy();
    expect(collabCanvasType(TYPE), 'a pack-defined document must not drive a CRDT room').toBeUndefined();
    // Control: a first-party collab type IS registered, so this leg cannot pass because
    // the registry is simply empty in this suite.
    expect(collabCanvasType('canvas.document'), 'control — a first-party type is present').toBeTruthy();
  });

  it('(b) a project non-member gets a uniform 404 on an owner-subject pack canvas (ADR 0610)', async () => {
    const { c, orgId, tenantId } = await orgOwner();
    const projectId = String((await c.post('/v1/host/openwop-app/projects', { orgId, name: 'Secret' })).body.id);
    expect((await c.patch(`/v1/host/openwop-app/projects/${projectId}/visibility`, { visibility: 'private' })).body.visibility).toBe('private');
    const canvas = await createCanvasForTenant(tenantId, {
      canvasTypeId: TYPE, name: 'Secret checklist',
      ownerSubject: { kind: 'project', id: projectId },
      initialState: { items: [{ text: 'Buy milk' }] },
    });
    // The owner (a project member) reads it — the gate must not over-refuse.
    expect((await c.get(`${BASEP(orgId)}/canvases/${canvas.canvasId}`)).status).toBe(200);

    // A second user in the SAME tenant + org, with viewer rights but NOT a project member.
    const b = client();
    const rb = await b.post('/v1/host/openwop-app/test/login', { email: `cvp-nm-${Date.now()}@acme.test`, tenantId });
    expect(rb.status).toBe(201);
    await createMember({ tenantId, orgId, subject: String(rb.body.user.userId), displayName: 'B', roles: ['viewer'] });
    const denied = await b.get(`${BASEP(orgId)}/canvases/${canvas.canvasId}`);
    expect(denied.status, 'org scope alone must not admit a private project canvas').toBe(404);
    expect(JSON.stringify(denied.body ?? {}), 'no existence leak').not.toContain('Secret checklist');
  }, 60_000);
});

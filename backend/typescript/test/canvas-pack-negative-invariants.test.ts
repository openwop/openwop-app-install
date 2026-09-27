/**
 * CPKC-2 — the two CRUX invariants of the canvas-packs lane (ADR 0310 Phase D)
 * held but had no NEGATIVE test. Both are asserted here against a REAL
 * pack-loaded canvas type (`canvas.checklist`, the vendored witness pack), not a
 * synthetic id:
 *
 *  (a) COLLAB / AUTHORIZE EXCLUSION — a data-only pack canvas type is ABSENT from
 *      the real-time collab registry (v1 fail-closed exclusion), and the REST
 *      collab ticket-mint 404s for a pack canvas. `collab-authboundary.test.ts`
 *      covers a SYNTHETIC unregistered id over the WS connect path; this covers a
 *      fully pack-REGISTERED type over the ticket-mint REST route.
 *      ATTRIBUTION GUARD: `realtime-collab` is OFF by default, so a mint would 404
 *      on the MASTER TOGGLE before ever reaching the registry check. We enable it
 *      first, so the 404 proves the REGISTRY exclusion — plus a direct
 *      `collabCanvasType()` assertion with a first-party positive control so the
 *      `undefined` is non-vacuous.
 *
 *  (b) ADR 0610 READ-GATE — a pack canvas rides the shared `loadCanvas` choke, so
 *      an owner-subject (private-project) pack canvas 404s for a project
 *      non-member. `adr0610-owner-subject-read-doors.test.ts` proves this for the
 *      first-party `canvas.app-builder` type only; no test combined a PACK canvas
 *      with the read gate. Mirrors that block's owner/member/non-member controls.
 */
import http from 'node:http';
import { cpSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getPackCanvasType } from '../src/host/canvasPackTypes.js';
import { collabCanvasType } from '../src/host/collab/collabRegistry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCanvasForTenant } from '../src/host/canvasSurface.js';
import { createMember } from '../src/host/accessControlService.js';

// The beforeAll copies + loads a fixture artifact-type pack then boots createApp —
// past the default hook budget; a generous cap so a busy machine isn't a scheduled
// flake (the one-order-of-magnitude rule, per canvas-pack-editor.test.ts).
vi.setConfig({ hookTimeout: 120_000 });

let BASE: string;
let server: http.Server;

const TYPE = 'canvas.checklist';
const REPO_PACK = join(process.cwd(), '..', '..', 'packs', 'community.openwop.canvas-checklist');
const PACKBASE = (orgId: string): string =>
  `/v1/host/openwop-app/canvas-packs/${TYPE}/orgs/${encodeURIComponent(orgId)}/canvases`;
const P = '/v1/host/openwop-app/projects';
const validState = (title: string) => ({ title, items: [{ text: 'Milk', done: false, priority: 'high' }] });

let prevPackDir: string | undefined;
let prevArtifactPacksDir: string | undefined;
beforeAll(async () => {
  const packRoot = mkdtempSync(join(tmpdir(), 'owp-cpkc2-'));
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'owp-cpkc2-fixture-'));
  cpSync(REPO_PACK, join(fixtureRoot, 'community.openwop.canvas-checklist'), { recursive: true });
  prevPackDir = process.env.OPENWOP_PACK_DIR;
  prevArtifactPacksDir = process.env.OPENWOP_ARTIFACT_TYPE_PACKS_DIR;
  process.env.OPENWOP_PACK_DIR = packRoot;
  process.env.OPENWOP_ARTIFACT_TYPE_PACKS_DIR = fixtureRoot;
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const { createApp } = await import('../src/index.js');
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  // Enable realtime-collab too, so invariant (a)'s mint-404 proves the REGISTRY
  // exclusion, not the master toggle (the attribution guard above).
  // `document-editor` too — the positive-control mint on a first-party collab type
  // (canvas.document) proves the mint route WORKS when a type is registered+toggled,
  // so the pack canvas's 404 is unambiguously the registry exclusion.
  for (const id of ['users', 'canvas-packs', 'projects', 'realtime-collab', 'document-editor']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  // Restore BOTH pack-dir envs — either one leaking poisons later files in the
  // same vitest worker (the isolatePackDir tripwire only guards OPENWOP_PACK_DIR).
  if (prevPackDir === undefined) delete process.env.OPENWOP_PACK_DIR;
  else process.env.OPENWOP_PACK_DIR = prevPackDir;
  if (prevArtifactPacksDir === undefined) delete process.env.OPENWOP_ARTIFACT_TYPE_PACKS_DIR;
  else process.env.OPENWOP_ARTIFACT_TYPE_PACKS_DIR = prevArtifactPacksDir;
});

interface Res<T = any> { status: number; body: T }
function client(): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;

/** Owner + a project + a project-owned pack canvas at the given project visibility. */
async function packCanvas(visibility: 'private' | 'org' = 'private') {
  const tenantId = `org:cpkc2-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('own'), tenantId });
  const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'PrivCo' })).body.orgId;
  const projectId = (await owner.post(P, { orgId, name: 'Secret' })).body.id;
  const canvas = await createCanvasForTenant(tenantId, {
    canvasTypeId: TYPE, name: 'Secret list',
    ownerSubject: { kind: 'project', id: projectId },
    initialState: validState('Secret list'),
  });
  expect((await owner.patch(`${P}/${projectId}/visibility`, { visibility })).body.visibility).toBe(visibility);
  return { tenantId, orgId, projectId, canvasId: canvas.canvasId, owner };
}

/** A real org VIEWER of the same org who is NOT a project member. */
async function orgViewer(tenantId: string, orgId: string): Promise<ReturnType<typeof client> & { userId: string }> {
  const viewer = client();
  const viewerId = (await viewer.post('/v1/host/openwop-app/test/login', { email: uniqEmail('view'), tenantId })).body.user.userId;
  await createMember({ tenantId, orgId, subject: viewerId, displayName: 'V', roles: ['viewer'] });
  return Object.assign(viewer, { userId: viewerId as string });
}

async function mintTicket(c: ReturnType<typeof client>, canvasId: string): Promise<Res> {
  return c.post(`/v1/host/openwop-app/canvas-collab/${encodeURIComponent(canvasId)}/ticket`);
}

describe('CPKC-2 (a) — a pack canvas type is EXCLUDED from real-time collab', () => {
  it('the loaded pack type is ABSENT from the collab registry (a first-party type is present — non-vacuous)', () => {
    expect(getPackCanvasType(TYPE), 'the pack type really is loaded').toBeTruthy();
    // Positive control: the lookup DOES return first-party registrations…
    expect(collabCanvasType('canvas.document')).toMatchObject({ canvasTypeId: 'canvas.document' });
    // …so the pack type's absence is the v1 exclusion, not a broken lookup.
    expect(collabCanvasType(TYPE)).toBeUndefined();
  });

  it('the collab ticket-mint 404s for a pack canvas EVEN with realtime-collab ON (registry exclusion, not the master toggle)', async () => {
    const tenantId = `org:cpkc2-mint-${Date.now()}-${n++}`;
    const owner = client();
    await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('mint'), tenantId });
    await owner.post('/v1/host/openwop-app/orgs', { name: 'MintCo' });

    // POSITIVE CONTROL: the mint route DOES mint for a first-party collab type
    // (canvas.document, registered + document-editor + realtime-collab ON) — so the
    // pack-canvas 404 below is the REGISTRY exclusion, not the master toggle.
    const doc = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.document', name: 'D', initialState: { title: 'D', content: { type: 'doc', content: [] } } });
    const ok = await mintTicket(owner, doc.canvasId);
    expect(ok.status, 'mint works for a registered collab type').toBe(200);
    expect(typeof ok.body?.ticket).toBe('string');

    // THE INVARIANT: a fully pack-registered type is excluded ⇒ mint 404s.
    const pack = await createCanvasForTenant(tenantId, { canvasTypeId: TYPE, name: 'C', initialState: validState('C') });
    expect((await mintTicket(owner, pack.canvasId)).status).toBe(404);
  });
});

describe('CPKC-2 (b) — a private-project pack canvas 404s for a non-member (ADR 0610 read gate)', () => {
  it('a non-member org viewer is REFUSED at the pack-canvas read door (single loadCanvas choke)', async () => {
    const { tenantId, orgId, projectId, canvasId, owner } = await packCanvas('private');
    const viewer = await orgViewer(tenantId, orgId);
    // Control: the project door already refuses the viewer (so a 404 below is the gate).
    expect((await viewer.get(`${P}/${projectId}`)).status).toBe(404);

    const leaked = await viewer.get(`${PACKBASE(orgId)}/${canvasId}`);
    expect(leaked.status).toBe(404);
    expect(JSON.stringify(leaked.body ?? {})).not.toContain('Secret list');
    // The version-history door funnels through the SAME loadCanvas choke.
    expect((await viewer.get(`${PACKBASE(orgId)}/${canvasId}/versions`)).status).toBe(404);

    // Owner control: not a brick.
    expect((await owner.get(`${PACKBASE(orgId)}/${canvasId}`)).status).toBe(200);
  });

  it('a project MEMBER regains the read door; an ORG-visible project is unaffected (no over-block)', async () => {
    const { tenantId, orgId, projectId, canvasId, owner } = await packCanvas('private');
    const viewer = await orgViewer(tenantId, orgId);
    expect((await owner.post(`${P}/${projectId}/members`, { ref: `user:${viewer.userId}`, role: 'observer' })).status).toBe(201);
    expect((await viewer.get(`${PACKBASE(orgId)}/${canvasId}`)).status).toBe(200);

    const open = await packCanvas('org');
    const stranger = await orgViewer(open.tenantId, open.orgId);
    expect((await stranger.get(`${PACKBASE(open.orgId)}/${open.canvasId}`)).status).toBe(200);
  });
});

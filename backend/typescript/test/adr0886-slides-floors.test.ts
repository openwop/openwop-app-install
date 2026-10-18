/**
 * ADR 0886 — feature-loop row 43 (Slides) security probes. Each `it` is a
 * finding proved RED on `origin/main` before its fix landed:
 *
 *  S1  a canvas WRITE was checked against the PATH org's `workspace:write`
 *      plus the owner subject's READ level. For a project-owned deck that is
 *      the wrong org: ADR 0054 puts write in the PROJECT's org. A member who is
 *      an Editor in org A and only a Viewer in the project's org B wrote B's
 *      deck through org A's path, on every write lane (REST PATCH / DELETE /
 *      restore / present-remote, the Slide Designer's render tool, and the
 *      `ctx.canvas` run lane).
 *  S2  the present-remote token outlived everything it was minted under: the
 *      `slides` toggle, the minter's membership, and the minter's access to the
 *      deck. It kept serving the LIVE deck's speaker notes for four hours.
 *  S3  DSAR erasure left the person's user id in the deck metadata the Slide
 *      Designer's render tool writes (`metadata.producedBy`).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember, deleteMember } from '../src/host/accessControlService.js';
import { createCanvasForTenant, createCanvasSurface, eraseSubjectCanvas, getCanvasForTenant } from '../src/host/canvasSurface.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { SLIDES_RENDER_TOOL_ID } from '../src/features/slides/agentTools.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'projects', 'slides', 'document-editor', 'drawings', 'cad', 'campaign-studio', 'app-builder']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setSlides = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('slides');
  if (d) await saveConfig({ ...d, status }, 'test');
};

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

const SL = (orgId: string): string => `/host/openwop-app/slides/orgs/${encodeURIComponent(orgId)}`;
const uniq = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
const deck = (title: string, notes = 'secret talking point') => ({
  title,
  theme: 'default',
  slides: [{ id: 's1', name: 'Opening', layout: 'title', title, notes }],
});

/** A tenant with two orgs, a project in org B, a deck the project owns, and a
 *  person who is an EDITOR in org A but only a VIEWER in org B. */
async function crossOrgWorld() {
  const tenantId = `org:adr0886-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/host/openwop-app/test/login', { email: uniq('own'), tenantId });
  const orgA = (await owner.post('/host/openwop-app/orgs', { name: 'Alpha' })).body.orgId as string;
  const orgB = (await owner.post('/host/openwop-app/orgs', { name: 'Bravo' })).body.orgId as string;
  const project = await owner.post('/host/openwop-app/projects', { orgId: orgB, name: 'Board deck' });
  expect(project.status, JSON.stringify(project.body)).toBe(201);
  const projectId = project.body.id as string;
  const canvas = await createCanvasForTenant(tenantId, {
    canvasTypeId: 'canvas.slides', name: 'Board deck', ownerSubject: { kind: 'project', id: projectId }, initialState: deck('Board deck'),
  });
  const u = client();
  const userId = (await u.post('/host/openwop-app/test/login', { email: uniq('u'), tenantId })).body.user.userId as string;
  await createMember({ tenantId, orgId: orgA, subject: userId, displayName: 'U', roles: ['editor'] });
  await createMember({ tenantId, orgId: orgB, subject: userId, displayName: 'U', roles: ['viewer'] });
  return { tenantId, orgA, orgB, projectId, canvasId: canvas.canvasId, owner, u, userId };
}

describe('S1 — a project-owned deck is written only with write in the PROJECT org', () => {
  it('REST: the org-B viewer cannot PATCH or DELETE the deck through org A (but still reads it)', async () => {
    const w = await crossOrgWorld();
    // Control: the person really can READ the deck (org-visible project, org-B viewer).
    const readable = await w.u.get(`${SL(w.orgA)}/canvases/${w.canvasId}`);
    expect(readable.status).toBe(200);
    // SL2UX-1 — and the editor is TOLD it is view-only (the same rules as the verbs).
    expect(readable.body.access).toBe('read');
    expect((await w.owner.get(`${SL(w.orgB)}/canvases/${w.canvasId}`)).body.access).toBe('write');
    // Control: through org B's own path the write is refused (the viewer role).
    expect((await w.u.patch(`${SL(w.orgB)}/canvases/${w.canvasId}`, { state: deck('Hijacked') })).status).toBe(403);

    // A reader is told 403 (not the 404 that would make the deck look deleted).
    const patched = await w.u.patch(`${SL(w.orgA)}/canvases/${w.canvasId}`, { state: deck('Hijacked') });
    expect(patched.status).toBe(403);
    const remote = await w.u.post(`${SL(w.orgA)}/canvases/${w.canvasId}/present-remote`);
    expect(remote.status).toBe(403);
    const del = await w.u.del(`${SL(w.orgA)}/canvases/${w.canvasId}`);
    expect(del.status).toBe(403);
    const after = await getCanvasForTenant(w.tenantId, w.canvasId);
    expect((after?.state as { title?: string })?.title).toBe('Board deck');

    // Positive control: the owner (write in org B) still saves.
    const ok = await w.owner.patch(`${SL(w.orgB)}/canvases/${w.canvasId}`, { state: deck('Board deck v2') });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('share: the org-B viewer cannot publish a public link to the deck through org A', async () => {
    const sharing = getToggleDefault('sharing');
    if (sharing) await saveConfig({ ...sharing, status: 'on' }, 'test');
    const w = await crossOrgWorld();
    const link = await w.u.post(`/host/openwop-app/sharing/orgs/${encodeURIComponent(w.orgA)}/links`, { resourceType: 'slides_canvas', resourceId: w.canvasId });
    expect(link.status).toBe(403);
    expect(link.body?.token).toBeUndefined();
    // Positive control: the owner (write in org B) publishes it.
    const ok = await w.owner.post(`/host/openwop-app/sharing/orgs/${encodeURIComponent(w.orgB)}/links`, { resourceType: 'slides_canvas', resourceId: w.canvasId });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('share: the same holds for an app-builder canvas (the other canvas share type)', async () => {
    const sharing = getToggleDefault('sharing');
    if (sharing) await saveConfig({ ...sharing, status: 'on' }, 'test');
    const w = await crossOrgWorld();
    const app = await createCanvasForTenant(w.tenantId, { canvasTypeId: 'canvas.app-builder', name: 'App', ownerSubject: { kind: 'project', id: w.projectId }, initialState: { title: 'App' } });
    const link = await w.u.post(`/host/openwop-app/sharing/orgs/${encodeURIComponent(w.orgA)}/links`, { resourceType: 'app_builder_canvas', resourceId: app.canvasId });
    expect(link.status).toBe(403);
    const ok = await w.owner.post(`/host/openwop-app/sharing/orgs/${encodeURIComponent(w.orgB)}/links`, { resourceType: 'app_builder_canvas', resourceId: app.canvasId });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('chat: the Slide Designer render tool cannot update the deck for that person', async () => {
    const w = await crossOrgWorld();
    const tools = createAgentToolProvider({ tenantId: w.tenantId, actingUserId: w.userId });
    const r = await tools.executeTool({
      name: SLIDES_RENDER_TOOL_ID,
      input: {
        orgId: w.orgA, canvasId: w.canvasId, baseVersion: 1,
        deck: { title: 'Hijacked', slides: [{ layout: 'title', title: 'Hijacked' }] },
      },
    });
    expect(r.isError).toBe(true);
    const after = await getCanvasForTenant(w.tenantId, w.canvasId);
    expect((after?.state as { title?: string })?.title).toBe('Board deck');
  });

  it('run lane: ctx.canvas.write refuses a run whose person lacks write in the project org', async () => {
    const w = await crossOrgWorld();
    const surface = createCanvasSurface({ tenantId: w.tenantId, actingUserId: w.userId } as BundleScope);
    // Control: the read is allowed.
    await expect(surface.read(w.canvasId)).resolves.toMatchObject({ canvasId: w.canvasId });
    await expect(surface.write(w.canvasId, deck('Hijacked'), { merge: 'replace' })).rejects.toBeTruthy();
    const after = await getCanvasForTenant(w.tenantId, w.canvasId);
    expect((after?.state as { title?: string })?.title).toBe('Board deck');
  });
});

/** Every first-party canvas type the editor factory serves (the ADR 0886 D1 fix
 *  is in the factory, so each type is witnessed through its OWN door). The
 *  KickTodo outline is excluded: it is PRIVILEGED (its `authorize` already
 *  demands `host:kicktodo:manage`), so it never had this hole to witness.
 *  Pack-served canvas types ride the same factory under a dynamic base path. */
const EDITOR_TYPES: { base: string; canvasTypeId: string }[] = [
  { base: '/host/openwop-app/slides', canvasTypeId: 'canvas.slides' },
  { base: '/host/openwop-app/document-editor', canvasTypeId: 'canvas.document' },
  { base: '/host/openwop-app/drawings', canvasTypeId: 'canvas.drawing' },
  { base: '/host/openwop-app/cad', canvasTypeId: 'canvas.cad' },
  { base: '/host/openwop-app/campaign-studio', canvasTypeId: 'canvas.campaign' },
  { base: '/host/openwop-app/app-builder', canvasTypeId: 'canvas.app-builder' },
];

describe('S1 — every canvas type: PATCH and DELETE are decided in the owner org', () => {
  for (const t of EDITOR_TYPES) {
    it(`${t.canvasTypeId}: the org-B viewer cannot PATCH or DELETE through org A`, async () => {
      const w = await crossOrgWorld();
      const c = await createCanvasForTenant(w.tenantId, {
        canvasTypeId: t.canvasTypeId, name: 'Owned', ownerSubject: { kind: 'project', id: w.projectId }, initialState: { title: 'Owned' },
      });
      const ORG = (orgId: string): string => `${t.base}/orgs/${encodeURIComponent(orgId)}/canvases/${c.canvasId}`;
      // Control: readable through org A (so the refusal below is the write gate).
      expect((await w.u.get(ORG(w.orgA))).status).toBe(200);
      // DELETE first: on origin/main it answered 204 and the canvas was gone.
      expect((await w.u.del(ORG(w.orgA))).status).toBe(403);
      // The gate runs BEFORE validation (origin/main answered 422 here — past
      // the gate), so the body is irrelevant to the answer.
      expect((await w.u.patch(ORG(w.orgA), { state: { title: 'Hijacked' } })).status).toBe(403);
      expect(await getCanvasForTenant(w.tenantId, c.canvasId)).not.toBeNull();
      // Positive control: the owner (write in org B) may delete it.
      expect((await w.owner.del(ORG(w.orgB))).status).toBe(204);
    });
  }
});

describe('S2 — the present remote is re-checked on every request', () => {
  async function mintedByMember() {
    const tenantId = `org:adr0886-pr-${Date.now()}-${n++}`;
    const owner = client();
    await owner.post('/host/openwop-app/test/login', { email: uniq('own'), tenantId });
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Show' })).body.orgId as string;
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.slides', name: 'Show', initialState: deck('Show') });
    const ed = client();
    const userId = (await ed.post('/host/openwop-app/test/login', { email: uniq('ed'), tenantId })).body.user.userId as string;
    const member = await createMember({ tenantId, orgId, subject: userId, displayName: 'E', roles: ['editor'] });
    const minted = await ed.post(`${SL(orgId)}/canvases/${canvas.canvasId}/present-remote`);
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const token = encodeURIComponent(minted.body.token as string);
    return { tenantId, orgId, canvasId: canvas.canvasId, memberId: member.memberId, token };
  }
  const pub = client();

  it('stops serving the outline (and taking commands) once the minter leaves the org', async () => {
    const m = await mintedByMember();
    expect((await pub.get(`/host/openwop-app/present/${m.token}/outline`)).status).toBe(200);
    await deleteMember(m.memberId);
    const outline = await pub.get(`/host/openwop-app/present/${m.token}/outline`);
    expect(outline.status).toBe(404);
    expect(JSON.stringify(outline.body ?? {})).not.toContain('secret talking point');
    expect((await pub.post(`/host/openwop-app/present/${m.token}/command`, { action: 'next' })).status).toBe(404);
  });

  it('stops serving once the slides feature is turned off', async () => {
    const m = await mintedByMember();
    try {
      await setSlides('off');
      expect((await pub.get(`/host/openwop-app/present/${m.token}/outline`)).status).toBe(404);
      expect((await pub.post(`/host/openwop-app/present/${m.token}/state`, { current: 0 })).status).toBe(404);
    } finally {
      await setSlides('on');
    }
    // Positive control: back on, the same token serves again (not a brick).
    expect((await pub.get(`/host/openwop-app/present/${m.token}/outline`)).status).toBe(200);
  });
});

describe('S3 — DSAR erasure covers the render tool’s producedBy', () => {
  it('erasing the person removes their id from the deck metadata', async () => {
    const tenantId = `org:adr0886-dsar-${Date.now()}-${n++}`;
    const owner = client();
    const userId = (await owner.post('/host/openwop-app/test/login', { email: uniq('own'), tenantId })).body.user.userId as string;
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Solo' })).body.orgId as string;
    const tools = createAgentToolProvider({ tenantId, actingUserId: userId });
    const r = await tools.executeTool({ name: SLIDES_RENDER_TOOL_ID, input: { orgId, deck: { title: 'Mine', slides: [{ layout: 'title', title: 'Mine' }] } } });
    expect(r.isError, r.content).not.toBe(true);
    const canvasId = (JSON.parse(r.content) as { canvasId: string }).canvasId;
    expect(JSON.stringify((await getCanvasForTenant(tenantId, canvasId))?.metadata)).toContain(userId);

    await eraseSubjectCanvas(tenantId, userId);
    const after = await getCanvasForTenant(tenantId, canvasId);
    expect(JSON.stringify(after?.metadata ?? {})).not.toContain(userId);
    expect(JSON.stringify(after?.ownerSubject ?? {})).not.toContain(userId);
  });
});

describe('S3b — producedBy is erased even when the person does not own the canvas', () => {
  it('an org-owned deck stamped producedBy the person loses the id; the owner field is untouched', async () => {
    const tenantId = `org:adr0886-dsar2-${Date.now()}-${n++}`;
    const who = 'user:0123456789abcdef0123456789abcdef';
    const c = await createCanvasForTenant(tenantId, {
      canvasTypeId: 'canvas.slides', name: 'Team deck', initialState: deck('Team deck'),
      metadata: { producedBy: { kind: 'user', id: who }, runId: 'r-1' },
    });
    await eraseSubjectCanvas(tenantId, who);
    const after = await getCanvasForTenant(tenantId, c.canvasId);
    expect(JSON.stringify(after?.metadata ?? {})).not.toContain(who);
    expect((after?.metadata as { runId?: string })?.runId).toBe('r-1');
    expect(after?.ownerSubject).toBeUndefined();
    // Idempotent: a second pass changes nothing and does not throw.
    await eraseSubjectCanvas(tenantId, who);
    expect((await getCanvasForTenant(tenantId, c.canvasId))?.metadata).toEqual(after?.metadata);
  });
});

describe('S4 — a collab room is a write, so joining needs write', () => {
  it('a workspace Viewer cannot mint a collab ticket or claim the seed for a deck', async () => {
    const collab = getToggleDefault('realtime-collab');
    if (collab) await saveConfig({ ...collab, status: 'on' }, 'test');
    const tenantId = `org:adr0886-collab-${Date.now()}-${n++}`;
    const owner = client();
    await owner.post('/host/openwop-app/test/login', { email: uniq('own'), tenantId });
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Live' })).body.orgId as string;
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.slides', name: 'Live', initialState: deck('Live') });
    const viewer = client();
    const viewerId = (await viewer.post('/host/openwop-app/test/login', { email: uniq('v'), tenantId })).body.user.userId as string;
    await createMember({ tenantId, orgId, subject: viewerId, displayName: 'V', roles: ['viewer'] });
    // Control: the viewer reads the deck, and the owner may mint.
    expect((await viewer.get(`${SL(orgId)}/canvases/${canvas.canvasId}`)).status).toBe(200);
    expect((await owner.post(`/host/openwop-app/canvas-collab/${canvas.canvasId}/ticket`)).status).toBe(200);

    const ticket = await viewer.post(`/host/openwop-app/canvas-collab/${canvas.canvasId}/ticket`);
    expect([403, 404]).toContain(ticket.status);
    expect(ticket.body?.ticket).toBeUndefined();
    const seed = await viewer.post(`/host/openwop-app/canvas-collab/${canvas.canvasId}/claim-seed`);
    expect([403, 404]).toContain(seed.status);
  });
});

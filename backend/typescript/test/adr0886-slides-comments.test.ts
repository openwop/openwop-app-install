/**
 * ADR 0886 D5 — per-slide comment threads (`canvas_slides`) on the ONE comments
 * resolver (ADR 0881). A thread is exactly as visible as its deck; a slide
 * thread needs its slide to still be in the deck; the `slides` entitlement is
 * the owning feature; deleting the deck prunes every thread on it.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember } from '../src/host/accessControlService.js';
import { createCanvasForTenant, updateCanvasForTenant } from '../src/host/canvasSurface.js';
import { fireCanvasDeleted } from '../src/host/canvasLifecycle.js';
import { __targetFeatureIds, listThread } from '../src/features/comments/commentsService.js';
import { PREAUTHORIZED_CALLER } from '../src/host/subjectAccess.js';

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
  for (const id of ['users', 'projects', 'slides', 'comments']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { userId: string; get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res> }
async function login(tenantId: string, who: string): Promise<Client> {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  const r = await call('POST', '/host/openwop-app/test/login', { email: `${who}-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status).toBe(201);
  return { userId: r.body.user.userId, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

const deck = (title: string, ids: string[]) => ({
  title,
  slides: ids.map((id) => ({ id, name: `Slide ${id}`, layout: 'title', title: id })),
});

async function world() {
  const tenantId = `org:adr0886-cm-${Date.now()}-${n++}`;
  const owner = await login(tenantId, 'own');
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId as string;
  const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.slides', name: 'Pitch', initialState: deck('Pitch', ['cover', 'ask']) });
  const C = `/host/openwop-app/comments/orgs/${encodeURIComponent(orgId)}/comments`;
  const thread = (resourceId: string): string => `${C}?resourceType=canvas_slides&resourceId=${encodeURIComponent(resourceId)}`;
  return { tenantId, orgId, owner, canvasId: canvas.canvasId, C, thread };
}

describe('ADR 0886 D5 — canvas_slides comment threads', () => {
  it('the owning feature is slides (one entitlement check, ADR 0881 D2)', () => {
    expect(__targetFeatureIds().canvas_slides).toBe('slides');
  });

  it('posts on a slide and on the whole deck; a slide that is not in the deck is a uniform 404', async () => {
    const w = await world();
    const onSlide = await w.owner.post(w.C, { resourceType: 'canvas_slides', resourceId: `${w.canvasId}#ask`, body: 'Tighten the ask.' });
    expect(onSlide.status, JSON.stringify(onSlide.body)).toBe(201);
    const onDeck = await w.owner.post(w.C, { resourceType: 'canvas_slides', resourceId: w.canvasId, body: 'Great overall.' });
    expect(onDeck.status).toBe(201);
    const read = await w.owner.get(w.thread(`${w.canvasId}#ask`));
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).toContain('Tighten the ask.');
    expect(JSON.stringify(read.body)).not.toContain('Great overall.');

    expect((await w.owner.post(w.C, { resourceType: 'canvas_slides', resourceId: `${w.canvasId}#nope`, body: 'x' })).status).toBe(404);
    expect((await w.owner.post(w.C, { resourceType: 'canvas_slides', resourceId: `${w.canvasId}#ask#extra`, body: 'x' })).status).toBe(404);

    // The slide is removed from the deck: its thread resolves to nothing (never
    // to whatever slide now sits at that position).
    await updateCanvasForTenant(w.tenantId, w.canvasId, deck('Pitch', ['cover']), { merge: 'replace' });
    expect((await w.owner.get(w.thread(`${w.canvasId}#ask`))).status).toBe(404);
    expect((await w.owner.get(w.thread(w.canvasId))).status).toBe(200);
  });

  it('a non-slides canvas id is not a slides thread (type-pinned)', async () => {
    const w = await world();
    const doc = await createCanvasForTenant(w.tenantId, { canvasTypeId: 'canvas.document', name: 'Doc', initialState: { title: 'Doc', content: { type: 'doc', content: [] } } });
    expect((await w.owner.post(w.C, { resourceType: 'canvas_slides', resourceId: doc.canvasId, body: 'x' })).status).toBe(404);
  });

  it("a private project's deck threads are refused to a non-member org reader", async () => {
    const w = await world();
    const projectId = (await w.owner.post('/host/openwop-app/projects', { orgId: w.orgId, name: 'Secret' })).body.id as string;
    expect((await w.owner.patch(`/host/openwop-app/projects/${projectId}/visibility`, { visibility: 'private' })).status).toBe(200);
    const owned = await createCanvasForTenant(w.tenantId, {
      canvasTypeId: 'canvas.slides', name: 'Board', ownerSubject: { kind: 'project', id: projectId }, initialState: deck('Board', ['s1']),
    });
    const viewer = await login(w.tenantId, 'viewer');
    await createMember({ tenantId: w.tenantId, orgId: w.orgId, subject: viewer.userId, displayName: 'V', roles: ['viewer'] });
    // Control: the owner comments.
    expect((await w.owner.post(w.C, { resourceType: 'canvas_slides', resourceId: `${owned.canvasId}#s1`, body: 'ok' })).status).toBe(201);
    expect((await viewer.get(w.thread(`${owned.canvasId}#s1`))).status).toBe(404);
    // A viewer is refused a post either way (no write scope → 403); the read is the visibility witness.
    expect([403, 404]).toContain((await viewer.post(w.C, { resourceType: 'canvas_slides', resourceId: `${owned.canvasId}#s1`, body: 'x' })).status);
  });

  it('turning slides off closes its threads; deleting the deck prunes them', async () => {
    const w = await world();
    expect((await w.owner.post(w.C, { resourceType: 'canvas_slides', resourceId: `${w.canvasId}#cover`, body: 'a' })).status).toBe(201);
    const d = getToggleDefault('slides');
    try {
      if (d) await saveConfig({ ...d, status: 'off' }, 'test');
      expect((await w.owner.get(w.thread(`${w.canvasId}#cover`))).status).toBe(404);
    } finally {
      if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    }
    expect((await w.owner.get(w.thread(`${w.canvasId}#cover`))).status).toBe(200);

    // The deck-deleted seam prunes the deck thread AND every slide thread. Fired
    // directly (the canvas row stays) so the read below still resolves its
    // target and the zero is the prune, not a 404.
    expect((await w.owner.post(w.C, { resourceType: 'canvas_slides', resourceId: w.canvasId, body: 'b' })).status).toBe(201);
    expect(await listThread(w.tenantId, w.orgId, 'canvas_slides', `${w.canvasId}#cover`, PREAUTHORIZED_CALLER)).toHaveLength(1);
    await fireCanvasDeleted({ tenantId: w.tenantId, canvasId: w.canvasId, canvasTypeId: 'canvas.slides' });
    expect(await listThread(w.tenantId, w.orgId, 'canvas_slides', `${w.canvasId}#cover`, PREAUTHORIZED_CALLER)).toHaveLength(0);
    expect(await listThread(w.tenantId, w.orgId, 'canvas_slides', w.canvasId, PREAUTHORIZED_CALLER)).toHaveLength(0);
  });
});

describe('ADR 0886 D5 — the render tool keeps slide ids, so threads stay on their slide', () => {
  it('an inserted slide does not shift the ids of the slides after it', async () => {
    const { createAgentToolProvider } = await import('../src/host/agentToolProvider.js');
    const { SLIDES_RENDER_TOOL_ID, SLIDES_GET_DESIGN_TOOL_ID } = await import('../src/features/slides/agentTools.js');
    const w = await world();
    const tools = createAgentToolProvider({ tenantId: w.tenantId, actingUserId: w.owner.userId });
    const made = await tools.executeTool({ name: SLIDES_RENDER_TOOL_ID, input: { orgId: w.orgId, deck: { title: 'D', slides: [{ layout: 'title', title: 'One' }, { layout: 'title', title: 'Two' }] } } });
    expect(made.isError, made.content).not.toBe(true);
    const { canvasId } = JSON.parse(made.content) as { canvasId: string };
    const read = JSON.parse((await tools.executeTool({ name: SLIDES_GET_DESIGN_TOOL_ID, input: { orgId: w.orgId, canvasId } })).content) as { version: number; deck: { slides: { id: string; title: string }[] } };
    const [one, two] = read.deck.slides;
    expect(one!.id).not.toBe(two!.id);
    // Insert a NEW slide first; keep the existing ids as the tool asks.
    const upd = await tools.executeTool({ name: SLIDES_RENDER_TOOL_ID, input: {
      orgId: w.orgId, canvasId, baseVersion: read.version,
      deck: { title: 'D', slides: [{ layout: 'title', title: 'Zero' }, { id: one!.id, layout: 'title', title: 'One' }, { id: two!.id, layout: 'title', title: 'Two' }] },
    } });
    expect(upd.isError, upd.content).not.toBe(true);
    const after = JSON.parse((await tools.executeTool({ name: SLIDES_GET_DESIGN_TOOL_ID, input: { orgId: w.orgId, canvasId } })).content) as { deck: { slides: { id: string; title: string }[] } };
    expect(after.deck.slides.slice(1).map((s) => [s.title, s.id])).toEqual([['One', one!.id], ['Two', two!.id]]);
    // The inserted slide gets a fresh, never-reused id (not a positional one).
    expect(after.deck.slides[0]!.title).toBe('Zero');
    expect(after.deck.slides[0]!.id).toMatch(/^slide-[0-9a-f]{8}$/);
    expect([one!.id, two!.id]).not.toContain(after.deck.slides[0]!.id);
    // SL2CD-1 — delete the last slide, then add a slide: the deleted slide's
    // thread must NOT come back on the newcomer.
    expect((await w.owner.post(w.C, { resourceType: 'canvas_slides', resourceId: `${canvasId}#${two!.id}`, body: 'about Two' })).status).toBe(201);
    const v2 = (JSON.parse((await tools.executeTool({ name: SLIDES_GET_DESIGN_TOOL_ID, input: { orgId: w.orgId, canvasId } })).content) as { version: number }).version;
    expect((await tools.executeTool({ name: SLIDES_RENDER_TOOL_ID, input: { orgId: w.orgId, canvasId, baseVersion: v2, deck: { title: 'D', slides: [{ id: one!.id, layout: 'title', title: 'One' }] } } })).isError).not.toBe(true);
    expect((await tools.executeTool({ name: SLIDES_RENDER_TOOL_ID, input: { orgId: w.orgId, canvasId, baseVersion: v2 + 1, deck: { title: 'D', slides: [{ id: one!.id, layout: 'title', title: 'One' }, { layout: 'title', title: 'New' }] } } })).isError).not.toBe(true);
    expect((await w.owner.get(w.thread(`${canvasId}#${two!.id}`))).status).toBe(404);
    // A duplicated id is never kept twice (validateSlidesDoc would refuse it).
    const dup = await tools.executeTool({ name: SLIDES_RENDER_TOOL_ID, input: {
      orgId: w.orgId, canvasId, baseVersion: v2 + 2,
      deck: { title: 'D', slides: [{ id: 'slide-1', layout: 'title', title: 'A' }, { id: 'slide-1', layout: 'title', title: 'B' }] },
    } });
    expect(dup.isError, dup.content).not.toBe(true);
  });
});

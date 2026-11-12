/**
 * ADR 1039 D1 (CB82WF-1) — `ctx.features['creative-briefs']` asks what its HTTP
 * doors ask. Before: `create`, `render`, `renderVariants`, `reelPrompt` and
 * `storeReel` fell to the `workspace:read` floor, so a run acting for a VIEWER of
 * the org created briefs, rendered, and reached the paid reel lane its own
 * `POST …/briefs`, `…/renders` and `…/reel` are refused.
 *
 * Red when the policy loses any of those methods, when a method is added to the
 * surface without being named as a read or a write (the ratchet case), or when
 * `create` stamps a caller-supplied `actor` instead of the run's person (D5).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { buildCreativeBriefsSurface, CREATIVE_BRIEFS_SURFACE_POLICY } from '../src/features/creative-briefs/surface.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'creative-briefs', 'media', 'brand']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const post = async (path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  return { post };
}

let n = 0;
/** An owner, an editor and a viewer of one org, plus one brief the owner made. */
async function team(): Promise<{ tenantId: string; orgId: string; briefId: string; editorId: string; viewerId: string }> {
  const tenantId = `org:a1039f-${Date.now()}-${n++}`;
  const ids: string[] = [];
  const owner = client();
  for (const c of [owner, client(), client()]) {
    const r = await c.post('/host/openwop-app/test/login', { email: `a1039f-${Date.now()}-${n++}@acme.test`, tenantId });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    ids.push((r.body as { user: { userId: string } }).user.userId);
  }
  const [, editorId, viewerId] = ids as [string, string, string];
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  const orgId = (org.body as { orgId: string }).orgId;
  for (const [subject, role] of [[editorId, 'editor'], [viewerId, 'viewer']] as const) {
    const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: role, subject, roles: [role] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
  }
  const brief = await owner.post(`/host/openwop-app/creative-briefs/orgs/${encodeURIComponent(orgId)}/briefs`, { title: 'Floor', sceneDescription: 'a lamp on a desk' });
  expect(brief.status, JSON.stringify(brief.body)).toBe(201);
  return { tenantId, orgId, briefId: (brief.body as { briefId: string }).briefId, editorId, viewerId };
}

describe('ADR 1039 D1 — a viewer\'s run cannot write through ctx.features[creative-briefs]', () => {
  it('every write method needs workspace:write; reads stay at the read tier', async () => {
    const t = await team();
    const asViewer = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-v', actingUserId: t.viewerId })['creative-briefs']!;
    const asEditor = buildFeatureSurfaces({ tenantId: t.tenantId, runId: 'r-e', actingUserId: t.editorId })['creative-briefs']!;
    const { orgId, briefId } = t;

    await expect(asViewer.create!({ orgId, title: 'V', sceneDescription: 's' })).rejects.toMatchObject({ code: 'forbidden_scope' });
    await expect(asViewer.render!({ orgId, briefId, templateId: 'meta.feed.1x1' })).rejects.toMatchObject({ code: 'forbidden_scope' });
    await expect(asViewer.renderVariants!({ orgId, briefId, templateIds: ['meta.feed.1x1'] })).rejects.toMatchObject({ code: 'forbidden_scope' });
    await expect(asViewer.reelPrompt!({ orgId, briefId })).rejects.toMatchObject({ code: 'forbidden_scope' });
    await expect(asViewer.storeReel!({ orgId, briefId, videoAssetId: 'masset:x', prompt: 'p' })).rejects.toMatchObject({ code: 'forbidden_scope' });

    // The viewer still reads.
    expect(((await asViewer.list!({ orgId })) as { briefs: unknown[] }).briefs).toHaveLength(1);
    expect(await asViewer.get!({ orgId, briefId })).toMatchObject({ found: true });

    // The editor passes the floor and reaches the service.
    // D5 — attribution is the run's person, never a caller-supplied `actor`.
    const made = (await asEditor.create!({ orgId, title: 'E', sceneDescription: 's', actor: t.viewerId })) as { brief: { briefId: string; createdBy: string; updatedBy: string } };
    expect(made.brief.briefId).toMatch(/^cbrief:/);
    expect(made.brief.createdBy).toBe(t.editorId);
    expect(made.brief.updatedBy).toBe(t.editorId);
    expect(await asEditor.reelPrompt!({ orgId, briefId })).toMatchObject({ prompt: expect.stringContaining('a lamp on a desk') });
  });

  it('ratchet: every surface method is a named read or a named write', () => {
    const READS = new Set(['list', 'get', 'listRenderTemplates']);
    const methods = Object.keys(buildCreativeBriefsSurface({ tenantId: 't', runId: 'r' }));
    const scopes = CREATIVE_BRIEFS_SURFACE_POLICY.methodScopes ?? {};
    const unclassified = methods.filter((m) => !READS.has(m) && scopes[m] !== 'workspace:write');
    expect(unclassified).toEqual([]);
  });
});

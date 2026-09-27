/**
 * Creative Briefs (ADR 0353) — CB-CODE-8 negative coverage the grade pass owed:
 *   (a) negative RBAC — a workspace:write member WITHOUT `host:members:manage`
 *       cannot approve (403 forbidden_scope), while non-privileged transitions
 *       still work for them;
 *   (b) PATCH-editing an APPROVED brief demotes it AND purges previously minted
 *       share links (approve → mint → shared 200 → PATCH → shared 404) — the
 *       PATCH twin of the existing moodboard-demotion test;
 *   (c) version-cap pruning — versions per brief are capped at 50; the oldest
 *       snapshots are pruned, newest kept (service-level, the CAS-test idiom).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE = '';
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'creative-briefs', 'sharing']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: any }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

const CB = (orgId: string, s = ''): string => `/v1/host/openwop-app/creative-briefs/orgs/${encodeURIComponent(orgId)}${s}`;
const SHARE = (orgId: string): string => `/v1/host/openwop-app/sharing/orgs/${encodeURIComponent(orgId)}/links`;

async function signup(c: Client, tenantId: string): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `cbneg-${Date.now()}-${n++}@t.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

/** Owner (tenant creator, has host:members:manage) + a same-tenant member with
 *  role `editor` (workspace:write, NO host:members:manage — the cms-approval
 *  precedent). */
async function ownerWithEditor(): Promise<{ owner: Client; editor: Client; orgId: string }> {
  const tenantId = `org:cbneg-${Date.now()}-${n++}`;
  const owner = client();
  await signup(owner, tenantId);
  const editor = client();
  const editorUser = await signup(editor, tenantId);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId as string;
  const add = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'E', subject: editorUser.userId, roles: ['editor'] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, editor, orgId };
}

describe('creative-briefs — CB-CODE-8 negative RBAC + share-purge + version cap', () => {
  it('a workspace:write editor WITHOUT host:members:manage cannot approve (403), owner can', async () => {
    const { owner, editor, orgId } = await ownerWithEditor();
    // The editor's write scope is real: they can create and move to review.
    const created = await editor.post(CB(orgId, '/briefs'), { title: 'Needs approval', sceneDescription: 'S' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.briefId;
    expect((await editor.post(CB(orgId, `/briefs/${id}/transition`), { status: 'review' })).status).toBe(200);

    // …but approval is privileged — the RBAC guard rejects with 403 forbidden_scope.
    const deny = await editor.post(CB(orgId, `/briefs/${id}/transition`), { status: 'approved' });
    expect(deny.status, JSON.stringify(deny.body)).toBe(403);
    expect(deny.body.error).toBe('forbidden_scope'); // canonical ErrorEnvelope shape
    expect(deny.body.details?.requiredScope).toBe('host:members:manage');
    // The brief did not move.
    expect((await owner.get(CB(orgId, `/briefs/${id}`))).body.status).toBe('review');

    // The owner (host:members:manage) approves the same brief.
    const ok = await owner.post(CB(orgId, `/briefs/${id}/transition`), { status: 'approved' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('approved');
  });

  it('PATCH-editing an APPROVED brief purges previously minted share links (CB demotion invariant)', async () => {
    const { owner, orgId } = await ownerWithEditor();
    const created = await owner.post(CB(orgId, '/briefs'), { title: 'Shared then edited', sceneDescription: 'S' });
    const id = created.body.briefId;
    await owner.post(CB(orgId, `/briefs/${id}/transition`), { status: 'review' });
    expect((await owner.post(CB(orgId, `/briefs/${id}/transition`), { status: 'approved' })).body.status).toBe('approved');

    const mint = await owner.post(SHARE(orgId), { resourceType: 'creative_brief', resourceId: id });
    expect(mint.status, JSON.stringify(mint.body)).toBe(201);
    const token = mint.body.token as string;
    expect((await owner.get(`/v1/host/openwop-app/shared/${token}`)).status).toBe(200); // live before

    const edited = await owner.patch(CB(orgId, `/briefs/${id}`), { sceneDescription: 'Rewritten after approval' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.status).toBe('draft'); // demoted
    expect((await owner.get(`/v1/host/openwop-app/shared/${token}`)).status).toBe(404); // link purged — no drift
  });

  it('version snapshots are capped at 50 per brief — oldest pruned, newest kept', async () => {
    // Service-level (the CAS-test idiom in creative-briefs-route.test.ts):
    // exercising the REAL captureVersion prune path 55 times over memory://
    // is fast and honest; 55 HTTP PATCHes would pin the same code slower.
    const { createBrief, updateBrief, listVersions } = await import('../src/features/creative-briefs/creativeBriefsService.js');
    const tenantId = `t-vcap-${Date.now()}`;
    const orgId = 'org-vcap';
    const b = await createBrief(tenantId, orgId, 'u0', { title: 'Cap me', sceneDescription: 'v1' });

    const EDITS = 55; // create(v1) + 55 edits = 56 snapshots captured, > the 50 cap
    for (let i = 2; i <= 1 + EDITS; i++) {
      await updateBrief(tenantId, orgId, b.briefId, 'u0', { sceneDescription: `scene v${i}` });
    }

    const versions = await listVersions(tenantId, orgId, b.briefId);
    expect(versions.length).toBe(50); // the cap, exactly
    const nums = versions.map((v) => v.version);
    expect(Math.max(...nums)).toBe(1 + EDITS); // newest kept (v56)
    expect(Math.min(...nums)).toBe(1 + EDITS - 50 + 1); // oldest surviving = v7
    // The pruned early snapshots (v1..v6) are gone.
    expect(nums).not.toContain(1);
    expect(nums).not.toContain(6);
    // And the newest snapshot carries the newest content.
    expect(versions[0].snapshot.sceneDescription).toBe(`scene v${1 + EDITS}`);
  });
});

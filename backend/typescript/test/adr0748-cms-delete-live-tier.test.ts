/**
 * ADR 0748 correction (2026-09-27): deleting a LIVE page through the vendor CMS
 * editor route needs the admin tier (`host:members:manage`), the same as the
 * protocol `deleteContentPage` and as the editor's own unpublish. It used to need
 * `workspace:write` for a page in ANY status, so an editor could delete what they
 * could not unpublish. Drafts stay `workspace:write`. The approval gate does not
 * apply, because removal is the fail-safe direction.
 *
 * Route-level (cookie sessions through `createApp`), because authority is only
 * observable at the HTTP boundary.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

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
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    del: (p: string) => call('DELETE', p),
  };
}
type Client = ReturnType<typeof client>;

let n = 0;
async function signup(c: Client, tenantId: string): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `del-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const u = (orgId: string, s = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;

async function ownerWithEditor(): Promise<{ owner: Client; editor: Client; orgId: string }> {
  const tenantId = `org:del-${Date.now()}-${n++}`;
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

async function page(c: Client, orgId: string, title: string, publish: boolean): Promise<string> {
  const r = await c.post(u(orgId, '/pages'), { title, sections: [{ type: 'hero', data: { heading: title } }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  if (publish) expect((await c.post(u(orgId, `/pages/${encodeURIComponent(r.body.pageId)}/publish`))).status).toBe(200);
  return r.body.pageId as string;
}

describe('CMS editor delete — live pages are admin tier (ADR 0748 correction)', () => {
  it('an editor deletes a DRAFT (workspace:write, unchanged)', async () => {
    const { owner, editor, orgId } = await ownerWithEditor();
    const id = await page(owner, orgId, 'Draft one', false);
    expect((await editor.del(u(orgId, `/pages/${encodeURIComponent(id)}`))).status).toBe(204);
  });

  it('an editor is refused a PUBLISHED page (403 host:members:manage) and the page survives', async () => {
    const { owner, editor, orgId } = await ownerWithEditor();
    const id = await page(owner, orgId, 'Live one', true);
    const r = await editor.del(u(orgId, `/pages/${encodeURIComponent(id)}`));
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.details?.requiredScope).toBe('host:members:manage');
    expect((await owner.get(u(orgId, `/pages/${encodeURIComponent(id)}`))).status).toBe(200);
  });

  it('the owner (admin tier) deletes a published page, also with the approval gate ON', async () => {
    const { owner, orgId } = await ownerWithEditor();
    const id = await page(owner, orgId, 'Live two', true);
    const d = getToggleDefault('cms-approval-gate');
    await saveConfig({ ...d!, status: 'on' }, 'test');
    try {
      expect((await owner.del(u(orgId, `/pages/${encodeURIComponent(id)}`))).status).toBe(204);
    } finally {
      await saveConfig({ ...d!, status: 'off' }, 'test');
    }
    expect((await owner.get(u(orgId, `/pages/${encodeURIComponent(id)}`))).status).toBe(404);
  });
});

/**
 * CMS interrupt-backed editorial approval (ADR 0066) — ROUTE-level harness.
 * Boots the real app and drives the `cms-approval-gate` toggle:
 *   - ON: `submit` queues a `content-publish` approval in the shared Approvals
 *     inbox; the direct `approve` route 409s (publish goes through the inbox);
 *     a claim (host:members:manage) publishes; a reject returns to draft.
 *   - An editor (workspace:write, NO host:members:manage) cannot claim → 403.
 *   - OFF: no approval is queued and direct `approve` works (byte-identical).
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
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setGate = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('cms-approval-gate');
  expect(d, 'cms-approval-gate toggle must be declared').toBeTruthy();
  if (d) await saveConfig({ ...d, status }, 'test');
};

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
async function signup(c: Client, tenantId: string): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `appr-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
async function ownerWithMember(role: string): Promise<{ owner: Client; member: Client; orgId: string }> {
  const tenantId = `org:appr-${Date.now()}-${n++}`;
  const owner = client();
  await signup(owner, tenantId);
  const member = client();
  const memberUser = await signup(member, tenantId);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId;
  const add = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: [role] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, member, orgId };
}
const u = (orgId: string, s = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;

async function draft(owner: Client, orgId: string, title = 'Home'): Promise<string> {
  const r = await owner.post(u(orgId, '/pages'), { title, sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.pageId as string;
}
async function pendingFor(c: Client, pageId: string): Promise<any> {
  const list = await c.get('/v1/host/openwop-app/approvals?status=pending');
  expect(list.status).toBe(200);
  return (list.body.items as any[]).find((a) => a.kind === 'content-publish' && a.pageId === pageId);
}
const status = async (owner: Client, orgId: string, pageId: string): Promise<string> =>
  (await owner.get(u(orgId, `/pages/${pageId}`))).body.status;

describe('cms-approval-gate — ON', () => {
  it('submit queues a content-publish approval; direct approve 409s; claim publishes', async () => {
    await setGate('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draft(owner, orgId);

    const sub = await owner.post(u(orgId, `/pages/${pageId}/submit`));
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body.status).toBe('in_review');

    const appr = await pendingFor(owner, pageId);
    expect(appr, 'a content-publish approval should be queued').toBeTruthy();
    expect(appr.orgId).toBe(orgId);

    // Direct approve is gated off — publish goes through the inbox.
    const direct = await owner.post(u(orgId, `/pages/${pageId}/approve`));
    expect(direct.status).toBe(409);
    expect(direct.body.details?.gate).toBe('cms-approval-gate');

    // Claim via the inbox (owner has host:members:manage) → page published.
    const claim = await owner.post(`/v1/host/openwop-app/approvals/${appr.approvalId}/claim`);
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    expect(claim.body.status).toBe('approved');
    expect(await status(owner, orgId, pageId)).toBe('published');
  });

  it('submit is idempotent — one open approval per page', async () => {
    await setGate('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draft(owner, orgId);
    await owner.post(u(orgId, `/pages/${pageId}/submit`));
    // A re-submit is a 409 (already in_review) and never fans out a 2nd approval.
    await owner.post(u(orgId, `/pages/${pageId}/submit`));
    const list = await owner.get('/v1/host/openwop-app/approvals?status=pending');
    const mine = (list.body.items as any[]).filter((a) => a.kind === 'content-publish' && a.pageId === pageId);
    expect(mine.length).toBe(1);
  });

  it('reject returns the page to draft', async () => {
    await setGate('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draft(owner, orgId);
    await owner.post(u(orgId, `/pages/${pageId}/submit`));
    const appr = await pendingFor(owner, pageId);
    const rej = await owner.post(`/v1/host/openwop-app/approvals/${appr.approvalId}/reject`);
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(await status(owner, orgId, pageId)).toBe('draft');
  });

  it('an editor (workspace:write, no host:members:manage) cannot SEE or claim the approval', async () => {
    await setGate('on');
    const { owner, member, orgId } = await ownerWithMember('editor');
    const pageId = await draft(owner, orgId);
    // The editor can submit (workspace:write).
    const sub = await member.post(u(orgId, `/pages/${pageId}/submit`));
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    // MEDIUM-2: the row is org-filtered OUT of the editor's inbox (they can't
    // manage the org), but the owner (host:members:manage) sees it.
    expect(await pendingFor(member, pageId)).toBeUndefined();
    const appr = await pendingFor(owner, pageId);
    expect(appr).toBeTruthy();
    // …and even with the id, the editor cannot decide it.
    const claim = await member.post(`/v1/host/openwop-app/approvals/${appr.approvalId}/claim`);
    expect(claim.status).toBe(403);
    expect(await status(owner, orgId, pageId)).toBe('in_review'); // unchanged
  });

  it('direct reject clears the pending approval (no orphan) — MEDIUM-3', async () => {
    await setGate('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draft(owner, orgId);
    await owner.post(u(orgId, `/pages/${pageId}/submit`));
    expect(await pendingFor(owner, pageId)).toBeTruthy();
    // The direct /reject route (admin) moves the page to draft AND resolves the
    // pending content-publish approval, so it doesn't orphan in the inbox.
    const rej = await owner.post(u(orgId, `/pages/${pageId}/reject`));
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(await status(owner, orgId, pageId)).toBe('draft');
    expect(await pendingFor(owner, pageId)).toBeUndefined();
  });

  it('direct publish is a bypass and 409s when the gate is on', async () => {
    await setGate('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draft(owner, orgId);
    const pub = await owner.post(u(orgId, `/pages/${pageId}/publish`));
    expect(pub.status).toBe(409);
    expect(pub.body.details?.gate).toBe('cms-approval-gate');
  });

  it('a failed transition (page deleted mid-approval) re-opens the approval — HIGH-1/LOW-4', async () => {
    await setGate('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draft(owner, orgId);
    await owner.post(u(orgId, `/pages/${pageId}/submit`));
    const appr = await pendingFor(owner, pageId);
    expect(appr).toBeTruthy();
    // Delete the page out from under the pending approval.
    expect((await owner.del(u(orgId, `/pages/${pageId}`))).status).toBe(204);
    // Claiming now: transitionPage returns null (page gone) → the approval is
    // re-opened (NOT consumed) and the claim 404s. The row never lies.
    const claim = await owner.post(`/v1/host/openwop-app/approvals/${appr.approvalId}/claim`);
    expect(claim.status).toBe(404);
    expect(await pendingFor(owner, pageId)).toBeTruthy(); // still pending (re-opened)
  });
});

describe('cms-approval-gate — OFF (byte-identical)', () => {
  it('submit queues NO approval and the direct approve route publishes', async () => {
    await setGate('off');
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draft(owner, orgId);
    const sub = await owner.post(u(orgId, `/pages/${pageId}/submit`));
    expect(sub.status).toBe(200);
    expect(await pendingFor(owner, pageId)).toBeUndefined();
    const approve = await owner.post(u(orgId, `/pages/${pageId}/approve`));
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    expect(approve.body.status).toBe('published');
  });
});

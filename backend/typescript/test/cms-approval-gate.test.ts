/**
 * CMS editorial approval (ADR 0066 + chat-first-port C1) — ROUTE-level harness.
 *
 * After the C1 reconciliation there is ONE decision path: `submit` ALWAYS queues a
 * `content-publish` approval on the shared ApprovalsInbox (regardless of the
 * `cms-approval-gate` toggle); the `approve`/`reject` header buttons resolve THAT
 * row through the shared decision core — so page-decide ≡ inbox-decide. The toggle
 * now gates only the direct `publish` bypass (ON ⇒ publish must go through the
 * review; OFF ⇒ an admin may publish directly, which clears the pending row).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getApproval, reopenApproval } from '../src/host/approvalService.js';
import { AUDIT_KIND_GOVERNANCE_DECISION, listChain } from '../src/host/auditChainService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
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
async function ownerWithMember(role: string): Promise<{ owner: Client; member: Client; orgId: string; tenantId: string }> {
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
  return { owner, member, orgId, tenantId };
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
/** ADR 0593 D2 — how many GOVERNANCE_DECISION entries this tenant's
 *  tamper-evident chain holds. The wedge's durable half was that EVERY decide
 *  attempt appended one and then compensated, so a card nobody could clear also
 *  grew the record of record without bound. */
const governanceEntryCount = async (tenantId: string): Promise<number> =>
  (await listChain(tenantId)).filter((e) => e.kind === AUDIT_KIND_GOVERNANCE_DECISION).length;

const status = async (owner: Client, orgId: string, pageId: string): Promise<string> =>
  (await owner.get(u(orgId, `/pages/${pageId}`))).body.status;

describe('cms editorial approval — ONE decision path (submit always queues)', () => {
  for (const gate of ['on', 'off'] as const) {
    it(`submit queues a content-publish approval regardless of toggle (gate ${gate})`, async () => {
      await setGate(gate);
      const { owner, orgId } = await ownerWithMember('viewer');
      const pageId = await draft(owner, orgId);
      const sub = await owner.post(u(orgId, `/pages/${pageId}/submit`));
      expect(sub.status, JSON.stringify(sub.body)).toBe(200);
      expect(sub.body.status).toBe('in_review');
      const appr = await pendingFor(owner, pageId);
      expect(appr, 'a content-publish approval should be queued').toBeTruthy();
      expect(appr.orgId).toBe(orgId);
    });
  }

  it('the header approve button resolves the shared row and publishes (page-decide)', async () => {
    await setGate('off');
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draft(owner, orgId);
    await owner.post(u(orgId, `/pages/${pageId}/submit`));
    const approve = await owner.post(u(orgId, `/pages/${pageId}/approve`));
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    expect(approve.body.status).toBe('published');
    // The row is now resolved (no longer pending).
    expect(await pendingFor(owner, pageId)).toBeUndefined();
  });

  it('inbox-decide ≡ page-decide — claiming the row from the inbox also publishes', async () => {
    await setGate('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draft(owner, orgId);
    await owner.post(u(orgId, `/pages/${pageId}/submit`));
    const appr = await pendingFor(owner, pageId);
    const claim = await owner.post(`/v1/host/openwop-app/approvals/${appr.approvalId}/claim`);
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    expect(claim.body.status).toBe('approved');
    expect(await status(owner, orgId, pageId)).toBe('published');
  });

  it('the header reject button resolves the shared row and returns the page to draft', async () => {
    await setGate('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draft(owner, orgId);
    await owner.post(u(orgId, `/pages/${pageId}/submit`));
    const rej = await owner.post(u(orgId, `/pages/${pageId}/reject`));
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(rej.body.status).toBe('draft');
    expect(await pendingFor(owner, pageId)).toBeUndefined();
  });

  it('submit is idempotent — one open approval per page', async () => {
    await setGate('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draft(owner, orgId);
    await owner.post(u(orgId, `/pages/${pageId}/submit`));
    await owner.post(u(orgId, `/pages/${pageId}/submit`)); // re-submit 409s, no 2nd approval
    const list = await owner.get('/v1/host/openwop-app/approvals?status=pending');
    const mine = (list.body.items as any[]).filter((a) => a.kind === 'content-publish' && a.pageId === pageId);
    expect(mine.length).toBe(1);
  });

  it('an editor (workspace:write, no host:members:manage) can submit but not decide', async () => {
    await setGate('on');
    const { owner, member, orgId } = await ownerWithMember('editor');
    const pageId = await draft(owner, orgId);
    const sub = await member.post(u(orgId, `/pages/${pageId}/submit`));
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    // The row is org-filtered OUT of the editor's inbox but visible to the owner.
    expect(await pendingFor(member, pageId)).toBeUndefined();
    const appr = await pendingFor(owner, pageId);
    expect(appr).toBeTruthy();
    // The header approve button 403s for the editor (route bar), page unchanged.
    const denied = await member.post(u(orgId, `/pages/${pageId}/approve`));
    expect(denied.status).toBe(403);
    // …and even with the id, the editor cannot decide it via the inbox.
    const claim = await member.post(`/v1/host/openwop-app/approvals/${appr.approvalId}/claim`);
    expect(claim.status).toBe(403);
    expect(await status(owner, orgId, pageId)).toBe('in_review');
  });

  it('CAS: a page with no pending review cannot be decided (409)', async () => {
    await setGate('off');
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draft(owner, orgId); // never submitted → no row
    const approve = await owner.post(u(orgId, `/pages/${pageId}/approve`));
    expect(approve.status).toBe(409);
  });

  it('direct publish is a bypass and 409s when the gate is ON', async () => {
    await setGate('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draft(owner, orgId);
    const pub = await owner.post(u(orgId, `/pages/${pageId}/publish`));
    expect(pub.status).toBe(409);
    expect(pub.body.details?.gate).toBe('cms-approval-gate');
  });

  it('direct publish is allowed when the gate is OFF and clears any pending review', async () => {
    await setGate('off');
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draft(owner, orgId);
    await owner.post(u(orgId, `/pages/${pageId}/submit`));
    expect(await pendingFor(owner, pageId)).toBeTruthy();
    const pub = await owner.post(u(orgId, `/pages/${pageId}/publish`));
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    expect(pub.body.status).toBe('published');
    expect(await pendingFor(owner, pageId)).toBeUndefined(); // no orphan
  });

  // ADR 0593 D2 (CMSA-2a) — this test PINNED THE DEFECT. It asserted that a
  // decide against a deleted page 404s and leaves the row "still pending
  // (re-opened)", which read as refuse-not-fall-through and was correct
  // PER DECIDE — but the per-decide framing hid the class: the row was pending
  // FOREVER, both verbs threw forever, and every attempt appended a
  // GOVERNANCE_DECISION entry to the tamper-evident chain before compensating.
  // An UNCLEARABLE card. Delete now cascades the review, and the decide arm
  // closes any that a best-effort cascade missed.
  it('deleting the page CLOSES its pending review — no unclearable card (CMSA-2a)', async () => {
    await setGate('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draft(owner, orgId);
    await owner.post(u(orgId, `/pages/${pageId}/submit`));
    const appr = await pendingFor(owner, pageId);
    expect(appr).toBeTruthy();

    expect((await owner.del(u(orgId, `/pages/${pageId}`))).status).toBe(204);
    // The producer cascade cleared it — the card is GONE from the inbox, not
    // sitting there rejecting every click.
    expect(await pendingFor(owner, pageId)).toBeUndefined();

    // …and a decide attempt against the now-resolved row is a clean, terminal
    // refusal (the pre-existing already-resolved 409), not a 404-and-reopen.
    const claim = await owner.post(`/v1/host/openwop-app/approvals/${appr.approvalId}/claim`);
    expect(claim.status, JSON.stringify(claim.body)).toBe(409);
    expect(await pendingFor(owner, pageId)).toBeUndefined();
  });

  it('the decide arm itself closes a row whose page vanished — the backstop (CMSA-2)', async () => {
    // Every producer cascade is best-effort, and a FUTURE producer has no
    // cascade at all. The guarantee lives in the decide arm: a guard that cannot
    // identify its subject refuses AND leaves no unclearable card.
    await setGate('on');
    const { owner, orgId, tenantId } = await ownerWithMember('viewer');
    const pageId = await draft(owner, orgId);
    await owner.post(u(orgId, `/pages/${pageId}/submit`));
    const appr = await pendingFor(owner, pageId);

    // Simulate a producer whose cascade failed: drop the page WITHOUT the
    // cascade (the raw service delete the route wraps is what carries it, so we
    // re-create the stranded shape by re-opening the row after the delete).
    expect((await owner.del(u(orgId, `/pages/${pageId}`))).status).toBe(204);
    await reopenApproval(appr.approvalId);
    expect((await getApproval(appr.approvalId))?.status).toBe('pending');

    const before = await governanceEntryCount(tenantId);
    const first = await owner.post(`/v1/host/openwop-app/approvals/${appr.approvalId}/claim`);
    expect(first.status, JSON.stringify(first.body)).toBe(409);
    expect(first.body?.details?.reason).toBe('review_closed');
    const closed = await getApproval(appr.approvalId);
    expect(closed?.status).toBe('rejected');
    expect(closed?.note).toContain('deleted');
    // ATTRIBUTION — the system closed it, so no human's name is on the decision.
    expect(closed?.decidedBy).toBeUndefined();

    // Repeat attempts append NOTHING to the tamper-evident chain — the durable
    // pollution was the half of this defect that survived a page refresh.
    const afterFirst = await governanceEntryCount(tenantId);
    expect(afterFirst).toBe(before + 1);
    for (let i = 0; i < 3; i += 1) {
      expect((await owner.post(`/v1/host/openwop-app/approvals/${appr.approvalId}/claim`)).status).toBe(409);
      expect((await owner.post(`/v1/host/openwop-app/approvals/${appr.approvalId}/reject`)).status).toBe(409);
    }
    expect(await governanceEntryCount(tenantId)).toBe(afterFirst);
  });

  it('restoring a version closes the pending review instead of wedging it (CMSA-2b)', async () => {
    // `restoreVersion` always lands the page in `draft`, so approve 409'd stale
    // (correct) but reject 409'd-and-reopened FOREVER — `transitionPage('reject')`
    // demands `in_review`. Recoverable only by knowing to resubmit.
    await setGate('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draft(owner, orgId);
    await owner.post(u(orgId, `/pages/${pageId}/submit`)); // submit snapshots a version
    const versions = await owner.get(u(orgId, `/pages/${pageId}/versions`));
    expect(versions.status, JSON.stringify(versions.body)).toBe(200);
    const versionId = (versions.body.versions as any[])[0]?.versionId;
    expect(versionId, 'submit must have snapshotted a version to restore').toBeTruthy();
    expect(await pendingFor(owner, pageId)).toBeTruthy();

    const restored = await owner.post(u(orgId, `/pages/${pageId}/restore/${versionId}`));
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body.status).toBe('draft');
    expect(await pendingFor(owner, pageId)).toBeUndefined(); // closed, not wedged
  });
});

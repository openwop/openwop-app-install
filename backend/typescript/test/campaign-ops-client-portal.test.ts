/**
 * ADR 0924 D5 (P1) — the client approver portal, through the real routes: the
 * agency adds an approver and sends a link; the approver reads the package
 * through the sharing viewer and decides on the public route.
 *
 * Pins:
 *  - `client` policy needs the portal and an active approver; under it an agency
 *    member cannot approve (they may still reject);
 *  - the link is a sharing `campaign_approval` link (ADR 0448 D3), one per
 *    (change set, approver); the package shows the request and the diffs and
 *    never the approver's email;
 *  - the approver decides only the hash they were shown; every failure they could
 *    probe (unknown token, wrong hash, revoked approver, decided by someone else,
 *    portal off) is the same 404; a stale package is 409 `package_stale`;
 *  - the approval row records `client-approver:<id>`, never an email;
 *  - the approved change is written under the member who SENT the link, fixed at
 *    the decision; the sender must be able to approve for the agency (not the
 *    proposer) when sending AND when the client decides; members cannot mint
 *    approval links through the sharing route;
 *  - the decision is limited on the shared counter (10 per link per 10 min).
 *
 * Sabotage, each run 2026-10-19 and each red:
 *  - drop the member-approve refusal under `client` → the admin's approve lands;
 *  - drop the approver-active check in `liveContext` → a revoked approver decides;
 *  - drop the hash compare in `decideFromPortal` → a wrong-hash approve lands;
 *  - write as the approval's `decidedBy` instead of the run's person → the
 *    client-approved job writes nothing (`not_authorized`) where it must confirm;
 *  - drop the per-link limit → the 11th attempt is not 429.
 *  After the security review (same day), also each red:
 *  - drop separation of duties from `agencyStandInRefusal` → the proposer sends;
 *  - drop the sender re-check at the decision → a demoted sender's link approves;
 *  - drop `SYSTEM_MINT_ONLY` → a member mints an approval link on the sharing route;
 *  - make `writerOf` return `decidedBy` → the client-approved job has no writer.
 *  The approver-active sabotage stayed GREEN until the per-use case was added:
 *  revoking also deletes the links, so only a revoked record with a surviving
 *  link witnesses the per-use check.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace, listMembers, updateMember } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createPage, getPage, transitionPage, updatePage } from '../src/features/cms/cmsService.js';
import { createClient, updateClient } from '../src/features/campaign-ops/clientService.js';
import { addAsset } from '../src/features/campaign-ops/assetService.js';
import { createRequest, recordInterpretation } from '../src/features/campaign-ops/requestService.js';
import { proposeChangeSet } from '../src/features/campaign-ops/changeSetService.js';
import { getApproval } from '../src/host/approvalService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import type { Job } from '../src/features/campaign-ops/execution.js';
import type { ChangeSet, ClientApprover } from '../src/features/campaign-ops/types.js';

let BASE: string;
let server: http.Server;
let TENANT: string;
let orgA: string;
let editorId: string;
let adminId: string;
let editorCookie: string;
let adminCookie: string;
let admin2Id: string;
let admin2Cookie: string;
let n = 0;

function cookieFor(userId: string, home: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant: home, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}
interface Res<T> { status: number; body: T; raw: string }
async function call<T = Record<string, unknown>>(cookie: string | null, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const res = await fetch(`${BASE}/host/openwop-app${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T, raw };
}
const ops = (p: string): string => `/campaign-ops/clients/${orgA}${p}`;
const tokenOf = (url: string): string => decodeURIComponent(url.split('/shared/')[1]!);
const decide = (token: string, body: unknown) => call<{ status?: string; error?: string; details?: { reason?: string } }>(null, 'POST', `/public-campaign-approval/${encodeURIComponent(token)}/decision`, body);
const readPackage = (token: string) => call<{ resourceType?: string; resource?: Record<string, unknown> }>(null, 'GET', `/shared/${encodeURIComponent(token)}`);

const toggle = async (id: string, status: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };

async function livePageAsset(title: string): Promise<{ assetId: string; pageId: string; field: string }> {
  const page = await createPage({ tenantId: TENANT, orgId: orgA, title, createdBy: 'seed', sections: [{ type: 'hero', data: { heading: `${title} — Tuesday, Nov 3` } }] });
  await transitionPage(TENANT, orgA, page.pageId, 'publish', 'seed');
  const field = `sections[${page.sections[0].sectionId}].data.heading`;
  const asset = await addAsset({ tenantId: TENANT, orgId: orgA, destination: 'openwop.cms.page', locator: { pageId: page.pageId }, label: title, editableFields: [field], createdBy: 'seed' });
  return { assetId: asset.assetId, pageId: page.pageId, field };
}

async function inReview(title: string, proposerCookie = editorCookie): Promise<{ cs: ChangeSet; approvalId: string; pageId: string }> {
  const a = await livePageAsset(title);
  const req = await createRequest({ tenantId: TENANT, orgId: orgA, text: `Change ${++n}: move the webinar`, assetIds: [a.assetId], createdBy: editorId });
  await recordInterpretation(TENANT, orgA, req.requestId, 1, { intents: [{ kind: 'replace_text', find: 'Tuesday, Nov 3', replace: 'Thursday, Nov 5', evidence: 'move the webinar' }], questions: [] });
  const out = await proposeChangeSet({
    tenantId: TENANT, orgId: orgA, requestId: req.requestId, version: 1, idempotencyKey: `portal:${req.requestId}`, createdBy: editorId,
    proposal: { assets: [{ assetId: a.assetId, edits: [{ field: a.field, find: 'Tuesday, Nov 3', replace: 'Thursday, Nov 5' }] }] },
  });
  if (out.kind !== 'created') throw new Error(`proposal not created: ${JSON.stringify(out)}`);
  const r = await call<{ approvalId: string }>(proposerCookie, 'POST', ops(`/change-sets/${out.changeSet.changeSetId}/request-approval`));
  expect(r.status, r.raw).toBe(201);
  return { cs: out.changeSet, approvalId: r.body.approvalId, pageId: a.pageId };
}

async function sendLinks(cookie: string, changeSetId: string): Promise<Array<{ approverId: string; url: string; email: string }>> {
  const r = await call<{ links: Array<{ approverId: string; url: string; email: string }> }>(cookie, 'POST', ops(`/change-sets/${changeSetId}/approval-links`));
  expect(r.status, r.raw).toBe(201);
  return r.body.links;
}

async function settledJob(approvalId: string): Promise<Job> {
  return vi.waitFor(async () => {
    const r = await call<{ job: Job | null }>(adminCookie, 'GET', ops(`/approvals/${approvalId}/job`));
    expect(r.body.job?.finishedAt, r.raw).toBeTruthy();
    return r.body.job!;
  }, { timeout: 10_000, interval: 25 });
}

let ann: ClientApprover;
let bob: ClientApprover;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['cms', 'campaign-ops']) await toggle(id, 'on');
  TENANT = (await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:portal-owner' })).tenantId;
  editorId = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:portal-editor', source: 'oidc' })).userId;
  adminId = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:portal-admin', source: 'oidc' })).userId;
  admin2Id = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:portal-admin2', source: 'oidc' })).userId;
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A (synthetic)' })).orgId;
  for (const [subject, clientRole] of [[editorId, 'editor'], [adminId, 'admin'], [admin2Id, 'admin']] as const) {
    await createMember({ tenantId: TENANT, orgId: TENANT, subject, displayName: subject, roles: ['viewer'] });
    await createMember({ tenantId: TENANT, orgId: orgA, subject, displayName: subject, roles: [clientRole] });
  }
  await createClient({ tenantId: TENANT, orgId: orgA, name: 'Client A (synthetic)', createdBy: 'seed' });
  await updateClient(TENANT, orgA, { mode: 'live' });
  editorCookie = cookieFor(editorId, 'ws:home-portal-ed');
  adminCookie = cookieFor(adminId, 'ws:home-portal-ad');
  admin2Cookie = cookieFor(admin2Id, 'ws:home-portal-ad2');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0924 D4/D5 — setting up client approval', () => {
  it('needs the portal on, then an active approver, before the client policy is allowed', async () => {
    await toggle('campaign-ops-client-portal', 'off');
    expect((await call(adminCookie, 'POST', ops('/approvers'), { email: 'ann@client.test', displayName: 'Ann' })).body).toMatchObject({ details: { reason: 'portal_off' } });
    expect((await call(adminCookie, 'PATCH', ops(''), { approvalPolicy: 'client' })).body).toMatchObject({ details: { reason: 'portal_off' } });
    await toggle('campaign-ops-client-portal', 'on');
    expect((await call(adminCookie, 'PATCH', ops(''), { approvalPolicy: 'client' })).body).toMatchObject({ details: { reason: 'no_client_approver' } });
    // Adding an approver is an admin act on the client.
    expect((await call(editorCookie, 'POST', ops('/approvers'), { email: 'ann@client.test', displayName: 'Ann' })).status).toBe(403);
    const a = await call<{ approver: ClientApprover }>(adminCookie, 'POST', ops('/approvers'), { email: 'Ann@Client.test', displayName: 'Ann' });
    expect(a.status, a.raw).toBe(201);
    ann = a.body.approver;
    expect(ann).toMatchObject({ kind: 'client-stakeholder', email: 'ann@client.test', status: 'active', mode: 'link-only' });
    expect((await call(adminCookie, 'POST', ops('/approvers'), { email: 'ann@client.test', displayName: 'Ann again' })).status).toBe(409);
    bob = (await call<{ approver: ClientApprover }>(adminCookie, 'POST', ops('/approvers'), { email: 'bob@client.test', displayName: 'Bob' })).body.approver;
    const p = await call<{ client: { approvalPolicy: string } }>(adminCookie, 'PATCH', ops(''), { approvalPolicy: 'client' });
    expect(p.status, p.raw).toBe(200);
    expect(p.body.client.approvalPolicy).toBe('client');
  });

  it('under the client policy an agency member cannot approve, but can reject', async () => {
    const { cs, approvalId } = await inReview('Member approve');
    const r = await call<{ details?: { reason?: string } }>(adminCookie, 'POST', `/approvals/${approvalId}/claim`, { expectedChangeSetHash: cs.hash });
    expect(r.status, r.raw).toBe(403);
    expect(r.body.details?.reason).toBe('client_approval_required');
    expect((await getApproval(approvalId))?.status).toBe('pending');
    const rej = await call(adminCookie, 'POST', `/approvals/${approvalId}/reject`, { note: 'not now' });
    expect(rej.status, rej.raw).toBeLessThan(300);
    expect((await getApproval(approvalId))?.status).toBe('rejected');
  });
});

describe('ADR 0924 D5 — the link and the decision', () => {
  it('a client approval is written under the member who sent the link, and confirmed', async () => {
    const { cs, approvalId, pageId } = await inReview('Happy path');
    const links = await sendLinks(adminCookie, cs.changeSetId);
    expect(links.map((l) => l.approverId).sort()).toEqual([ann.approverId, bob.approverId].sort());
    const token = tokenOf(links.find((l) => l.approverId === ann.approverId)!.url);

    const pkg = await readPackage(token);
    expect(pkg.status, pkg.raw).toBe(200);
    expect(pkg.body.resourceType).toBe('campaign_approval');
    expect(pkg.body.resource).toMatchObject({ state: 'in_review', clientName: 'Client A (synthetic)', approverName: 'Ann', changeSetHash: cs.hash });
    expect(pkg.raw).toContain('Thursday, Nov 5');
    expect(pkg.raw).not.toContain('ann@client.test');
    expect(pkg.raw).not.toContain('bob@client.test');

    const d = await decide(token, { action: 'approve', expectedChangeSetHash: cs.hash, comment: 'Looks right.' });
    expect(d.status, d.raw).toBe(200);
    expect(d.body.status).toBe('approved');
    const row = await getApproval(approvalId);
    expect(row).toMatchObject({ status: 'approved', decidedBy: `client-approver:${ann.approverId}`, note: 'Looks right.' });
    expect(JSON.stringify(row)).not.toContain('ann@client.test');

    const job = await settledJob(approvalId);
    expect(job.actingUserId).toBe(adminId);
    expect(job.status).toBe('finished');
    const page = await getPage(TENANT, orgA, pageId);
    expect(JSON.stringify(page?.sections)).toContain('Thursday, Nov 5');

    // The other approver's link is dead now that the change set left review.
    const other = tokenOf(links.find((l) => l.approverId === bob.approverId)!.url);
    expect((await decide(other, { action: 'reject', expectedChangeSetHash: cs.hash })).status).toBe(404);
    const otherRead = await readPackage(other);
    expect(otherRead.status).toBe(404);
    expect(otherRead.body).toEqual({ error: 'not_found', message: 'Shared link not found.', details: {} });
  });

  it('the proposer cannot send their own change to the client while someone else could (security review)', async () => {
    // The editor asked for this change. Whoever sends the link holds it, so an
    // editor sending their own change could approve it themselves.
    const { cs, approvalId } = await inReview('Who sends');
    const self = await call<{ details?: { reason?: string } }>(editorCookie, 'POST', ops(`/change-sets/${cs.changeSetId}/approval-links`));
    expect(self.status, self.raw).toBe(403);
    expect(self.body.details?.reason).toBe('separation-of-duties');
    expect((await sendLinks(adminCookie, cs.changeSetId)).length).toBeGreaterThan(0);
    expect((await getApproval(approvalId))?.status).toBe('pending');
  });

  it('a sender who lost the right to approve kills their links at the decision', async () => {
    const { cs, approvalId } = await inReview('Sender demoted');
    const token = tokenOf((await sendLinks(admin2Cookie, cs.changeSetId))[0]!.url);
    const m = (await listMembers(TENANT, orgA)).find((x) => x.subject === admin2Id)!;
    await updateMember(m.memberId, { roles: ['viewer'] });
    try {
      const d = await decide(token, { action: 'approve', expectedChangeSetHash: cs.hash });
      expect(d.status, d.raw).toBe(409);
      expect(d.body.details?.reason).toBe('package_stale');
      expect((await getApproval(approvalId))?.status).toBe('pending');
    } finally {
      await updateMember(m.memberId, { roles: ['admin'] });
    }
  });

  it('a member cannot mint an approval link through the sharing route (security review)', async () => {
    const { cs } = await inReview('Member mint');
    await sendLinks(adminCookie, cs.changeSetId);
    const r = await call(editorCookie, 'POST', `/sharing/orgs/${orgA}/links`, { resourceType: 'campaign_approval', resourceId: `${cs.changeSetId}:${ann.approverId}` });
    expect(r.status, r.raw).toBe(404);
    const a = await call(adminCookie, 'POST', `/sharing/orgs/${orgA}/links`, { resourceType: 'campaign_approval', resourceId: `${cs.changeSetId}:${ann.approverId}` });
    expect(a.status, a.raw).toBe(404);
  });

  it('unknown token, wrong hash and a revoked approver are the same 404, and nothing is decided', async () => {
    const { cs, approvalId } = await inReview('Refusals');
    const links = await sendLinks(adminCookie, cs.changeSetId);
    const annToken = tokenOf(links.find((l) => l.approverId === ann.approverId)!.url);
    const unknown = await decide(`csap_${randomBytes(24).toString('hex')}`, { action: 'approve', expectedChangeSetHash: cs.hash });
    const wrongHash = await decide(annToken, { action: 'approve', expectedChangeSetHash: 'f'.repeat(64) });
    expect(unknown.status).toBe(404);
    expect(wrongHash.status).toBe(404);
    expect(wrongHash.raw).toBe(unknown.raw);
    // Revoke Bob: his link goes dark at once.
    const bobToken = tokenOf(links.find((l) => l.approverId === bob.approverId)!.url);
    expect((await call(adminCookie, 'DELETE', ops(`/approvers/${bob.approverId}`))).status).toBe(200);
    const revoked = await decide(bobToken, { action: 'approve', expectedChangeSetHash: cs.hash });
    expect(revoked.status).toBe(404);
    expect(revoked.raw).toBe(unknown.raw);
    expect((await getApproval(approvalId))?.status).toBe('pending');
    // Ann is now the only approver of a client-policy client: she cannot be removed.
    expect((await call(adminCookie, 'DELETE', ops(`/approvers/${ann.approverId}`))).body).toMatchObject({ details: { reason: 'last_client_approver' } });
    // Turning the portal off darkens the link too.
    await toggle('campaign-ops-client-portal', 'off');
    try {
      expect((await decide(annToken, { action: 'approve', expectedChangeSetHash: cs.hash })).status).toBe(404);
      expect((await readPackage(annToken)).status).toBe(404);
    } finally {
      await toggle('campaign-ops-client-portal', 'on');
    }
    expect((await getApproval(approvalId))?.status).toBe('pending');
  });

  it('the approver is re-checked on every use, not only when the link is deleted (ADR 0887)', async () => {
    const { cs, approvalId } = await inReview('Per use');
    const token = tokenOf((await sendLinks(adminCookie, cs.changeSetId)).find((l) => l.approverId === ann.approverId)!.url);
    // Mark Ann revoked in her record WITHOUT deleting her link (a revoke whose
    // link cleanup did not run): the link itself must still refuse.
    // Since ADR 0958 P1 the approver row is the link-only collaborator.
    const key = `hostext:extcollab:c:${ann.approverId}`;
    const storage = hostExtStorage();
    const raw = await storage.kvGet(key);
    await storage.kvSet(key, JSON.stringify({ ...JSON.parse(raw!), status: 'revoked' }));
    try {
      expect((await decide(token, { action: 'approve', expectedChangeSetHash: cs.hash })).status).toBe(404);
      expect((await readPackage(token)).status).toBe(404);
      expect((await getApproval(approvalId))?.status).toBe('pending');
    } finally {
      await storage.kvSet(key, raw!);
    }
  });

  it('a page edited after the link was sent: the package says so, and approving is 409 package_stale', async () => {
    const { cs, approvalId, pageId } = await inReview('Stale');
    const token = tokenOf((await sendLinks(adminCookie, cs.changeSetId))[0]!.url);
    const page = (await getPage(TENANT, orgA, pageId))!;
    await updatePage(TENANT, orgA, pageId, { sections: [{ ...page.sections[0], data: { heading: 'A human rewrote this' } }] }, 'human');
    const d = await decide(token, { action: 'approve', expectedChangeSetHash: cs.hash });
    expect(d.status, d.raw).toBe(409);
    expect(d.body.details?.reason).toBe('package_stale');
    expect((await getApproval(approvalId))?.status).toBe('rejected');
    const pkg = await readPackage(token);
    expect(pkg.status).toBe(200);
    expect(pkg.body.resource).toEqual({ kind: 'campaign_approval', state: 'stale', clientName: 'Client A (synthetic)' });
  });

  it('the decision is limited per link on the shared counter', async () => {
    const { cs } = await inReview('Limit');
    const token = tokenOf((await sendLinks(adminCookie, cs.changeSetId))[0]!.url);
    for (let i = 0; i < 10; i++) expect((await decide(token, { action: 'approve', expectedChangeSetHash: 'bad' })).status).toBe(404);
    const eleventh = await decide(token, { action: 'approve', expectedChangeSetHash: cs.hash });
    expect(eleventh.status).toBe(429);
  });
});

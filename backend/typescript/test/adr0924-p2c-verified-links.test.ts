/**
 * ADR 0924 P2c — verified emailed approval links, through the real routes.
 *
 * Pins (architecture review § 8 row 3):
 *  - with a code lane, each approver link is recipient-bound to the approver's
 *    address with verification (ADR 1141), and emailed through the transactional
 *    seam keyed `cops-link:<grantId>`; the delivery is recorded honestly;
 *  - holding the URL is not enough: a browser that has not verified can neither
 *    read the package nor decide (401), and a code requested from ANY browser goes
 *    only to the approver's address (C3.1: the sender, or a forwardee);
 *  - the verified browser decides; the same token from a cookie-less caller does not;
 *  - a send the transport refuses is `failed`, never `sent`;
 *  - with no code lane and no transport, the `client` policy keeps the v1 copy link,
 *    but only for a client that never had verified links: once it has, a missing
 *    code lane is 409 `verification_unavailable`, never an unbound link (user
 *    decision 2026-11-26);
 *  - an agency member's address cannot be a client approver: refused at add, and a
 *    vote from an approver whose address has since become a member's is the
 *    uniform 404 and no longer counts (C3.2);
 *  - an expired approval link answers the same 404 body as an unknown token (L1);
 *  - security read item 3: a cookie-carrying decision or code verify from a foreign
 *    origin is refused 403 `csrf_origin_rejected`, including a `text/plain`
 *    form-style POST; the allowlisted origin decides;
 *  - security read item 4: a second approve of a decided change is the uniform 404
 *    and changes nothing.
 *
 * Sabotage, each run and each red: see the ADR 0924 implementation record (P2c).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createPage, transitionPage } from '../src/features/cms/cmsService.js';
import { createClient, updateClient } from '../src/features/campaign-ops/clientService.js';
import { addAsset } from '../src/features/campaign-ops/assetService.js';
import { createRequest, recordInterpretation } from '../src/features/campaign-ops/requestService.js';
import { proposeChangeSet } from '../src/features/campaign-ops/changeSetService.js';
import { clientVoteStillLive } from '../src/features/campaign-ops/portal.js';
import { getClient } from '../src/features/campaign-ops/clientService.js';
import { getApproval } from '../src/host/approvalService.js';
import { __setShareCodeMailForTest } from '../src/features/sharing/shareCodeMail.js';
import { __lastShareCodeDeliveryForTest } from '../src/features/sharing/recipientVerification.js';
import { __resetVerificationStoreForTest } from '../src/features/sharing/verificationStore.js';
import { setTransactionalEmailTransport, __resetTransactionalEmail, type TransactionalEmail } from '../src/host/transactionalEmail.js';
import type { ChangeSet, ClientApprover } from '../src/features/campaign-ops/types.js';
import { getSetCookies } from './headerCookies.js';

let BASE: string;
let server: http.Server;
let TENANT: string;
let orgA: string;
let editorId: string;
let adminId: string;
let adminCookie: string;
let n = 0;

const codes: Array<{ tenantId: string; orgId: string; to: string; code: string; from: string; fromName?: string }> = [];
const priorFrom = process.env.OPENWOP_NOTIFY_EMAIL_FROM;
const priorCors = process.env.OPENWOP_CORS_ORIGINS;
const mails: TransactionalEmail[] = [];
let transportAnswer = true;

function cookieFor(userId: string, home: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant: home, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}
interface Res<T> { status: number; body: T; raw: string; cookies: string[] }
async function call<T = Record<string, unknown>>(cookie: string | null, method: string, path: string, body?: unknown, ip = '10.1.0.1'): Promise<Res<T>> {
  const res = await fetch(`${BASE}/host/openwop-app${path}`, {
    method,
    headers: { 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T, raw, cookies: getSetCookies(res.headers) };
}
const ops = (p: string): string => `/campaign-ops/clients/${orgA}${p}`;
const tokenOf = (url: string): string => decodeURIComponent(url.split('/shared/')[1]!);
const toggle = async (id: string, status: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };

/** One browser: keeps the `__session` cookie the verification sets. */
function browser(ip: string) {
  let cookie: string | null = null;
  const keep = <T>(r: Res<T>): Res<T> => { for (const c of r.cookies) { const m = /(__session=[^;]+)/.exec(c); if (m?.[1]) cookie = m[1]; } return r; };
  return {
    open: async (token: string) => keep(await call<{ resource?: Record<string, unknown>; error?: string }>(cookie, 'GET', `/shared/${encodeURIComponent(token)}`, undefined, ip)),
    requestCode: async (token: string) => { const r = keep(await call(cookie, 'POST', `/shared/${encodeURIComponent(token)}/verification`, undefined, ip)); await __lastShareCodeDeliveryForTest(); return r; },
    verify: async (token: string, code: string) => keep(await call(cookie, 'POST', `/shared/${encodeURIComponent(token)}/verification/verify`, { code }, ip)),
    decide: async (token: string, body: unknown) => keep(await call<{ status?: string; error?: string }>(cookie, 'POST', `/public-campaign-approval/${encodeURIComponent(token)}/decision`, body, ip)),
    /** A raw POST with this browser's cookie and chosen headers (a forged cross-site request). */
    raw: async (path: string, init: { headers: Record<string, string>; body: string }) => {
      const res = await fetch(`${BASE}/host/openwop-app${path}`, { method: 'POST', headers: { 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}), ...init.headers }, body: init.body });
      const raw = await res.text();
      let body: { details?: { code?: string } } | undefined;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
      return { status: res.status, body, raw };
    },
  };
}

async function inReview(title: string): Promise<{ cs: ChangeSet; approvalId: string }> {
  const page = await createPage({ tenantId: TENANT, orgId: orgA, title, createdBy: 'seed', sections: [{ type: 'hero', data: { heading: `${title} — Tuesday, Nov 3` } }] });
  await transitionPage(TENANT, orgA, page.pageId, 'publish', 'seed');
  const field = `sections[${page.sections[0].sectionId}].data.heading`;
  const asset = await addAsset({ tenantId: TENANT, orgId: orgA, destination: 'openwop.cms.page', locator: { pageId: page.pageId }, label: title, editableFields: [field], createdBy: 'seed' });
  const req = await createRequest({ tenantId: TENANT, orgId: orgA, text: `Change ${++n}: move the webinar`, assetIds: [asset.assetId], createdBy: editorId });
  await recordInterpretation(TENANT, orgA, req.requestId, 1, { intents: [{ kind: 'replace_text', find: 'Tuesday, Nov 3', replace: 'Thursday, Nov 5', evidence: 'move the webinar' }], questions: [] });
  const out = await proposeChangeSet({
    tenantId: TENANT, orgId: orgA, requestId: req.requestId, version: 1, idempotencyKey: `p2c:${req.requestId}`, createdBy: editorId,
    proposal: { assets: [{ assetId: asset.assetId, edits: [{ field, find: 'Tuesday, Nov 3', replace: 'Thursday, Nov 5' }] }] },
  });
  if (out.kind !== 'created') throw new Error(`proposal not created: ${JSON.stringify(out)}`);
  const r = await call<{ approvalId: string }>(cookieFor(editorId, 'ws:home-p2c-ed'), 'POST', ops(`/change-sets/${out.changeSet.changeSetId}/request-approval`));
  expect(r.status, r.raw).toBe(201);
  return { cs: out.changeSet, approvalId: r.body.approvalId };
}

interface Sent { approverId: string; url: string; email: string; verified: boolean; delivery: { channel: string; status: string } }
async function sendLinks(changeSetId: string): Promise<Sent[]> {
  const r = await call<{ links: Sent[] }>(adminCookie, 'POST', ops(`/change-sets/${changeSetId}/approval-links`));
  expect(r.status, r.raw).toBe(201);
  return r.body.links;
}

let ann: ClientApprover;
async function freshClient(): Promise<void> {
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client P2c (synthetic)' })).orgId;
  for (const [subject, role] of [[editorId, 'editor'], [adminId, 'admin']] as const) {
    await createMember({ tenantId: TENANT, orgId: orgA, subject, displayName: subject, roles: [role] });
  }
  await createClient({ tenantId: TENANT, orgId: orgA, name: 'Client P2c (synthetic)', createdBy: 'seed' });
  await updateClient(TENANT, orgA, { mode: 'live' });
  const a = await call<{ approver: ClientApprover }>(adminCookie, 'POST', ops('/approvers'), { email: `ann+${n}@client.test`, displayName: 'Ann' });
  expect(a.status, a.raw).toBe(201);
  ann = a.body.approver;
  const p = await call(adminCookie, 'PATCH', ops(''), { approvalPolicy: 'client' });
  expect(p.status, p.raw).toBe(200);
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['cms', 'campaign-ops', 'campaign-ops-client-portal']) await toggle(id, 'on');
  TENANT = (await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:p2c-owner' })).tenantId;
  editorId = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:p2c-editor', source: 'oidc' })).userId;
  adminId = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:p2c-admin', source: 'oidc' })).userId;
  for (const subject of [editorId, adminId]) await createMember({ tenantId: TENANT, orgId: TENANT, subject, displayName: subject, roles: ['viewer'] });
  adminCookie = cookieFor(adminId, 'ws:home-p2c-ad');
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(async () => {
  codes.length = 0; mails.length = 0; transportAnswer = true;
  // ADR 1141 follow-up: a code needs a sender (the org's own, else the host's).
  process.env.OPENWOP_NOTIFY_EMAIL_FROM = 'notify@agency-host.test';
  __setShareCodeMailForTest({ ready: true, sent: codes });
  setTransactionalEmailTransport(async (e) => { mails.push(e); return transportAnswer; });
  await __resetVerificationStoreForTest();
  await freshClient();
});
afterEach(() => { vi.useRealTimers(); __setShareCodeMailForTest(undefined); __resetTransactionalEmail(); });
afterAll(() => { if (priorFrom === undefined) delete process.env.OPENWOP_NOTIFY_EMAIL_FROM; else process.env.OPENWOP_NOTIFY_EMAIL_FROM = priorFrom; });
afterEach(() => { if (priorCors === undefined) delete process.env.OPENWOP_CORS_ORIGINS; else process.env.OPENWOP_CORS_ORIGINS = priorCors; });

describe('ADR 0924 P2c — verified emailed approval links', () => {
  it('emails each approver a recipient-bound link, keyed on its grant, and records the delivery', async () => {
    const { cs } = await inReview('Emailed');
    const [link] = await sendLinks(cs.changeSetId);
    expect(link).toMatchObject({ approverId: ann.approverId, verified: true, delivery: { channel: 'email', status: 'sent' } });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe(ann.email);
    expect(mails[0]!.text).toContain(link!.url);
    expect(mails[0]!.context?.idempotencyKey).toMatch(/^cops-link:/);
    // The email carries the link only: not the request text, not the change.
    expect(mails[0]!.text).not.toContain('move the webinar');
    expect(mails[0]!.text).not.toContain('Thursday, Nov 5');
  });

  it('holding the URL opens nothing: no read, no decision, and a code goes only to the approver', async () => {
    const { cs, approvalId } = await inReview('Forwarded');
    const [link] = await sendLinks(cs.changeSetId);
    const token = tokenOf(link!.url);
    const sender = browser('10.2.0.1'); // the member who holds the URL, or a forwardee
    expect((await sender.open(token)).status).toBe(401);
    expect((await sender.decide(token, { action: 'approve', expectedChangeSetHash: cs.hash })).status).toBe(401);
    await sender.requestCode(token);
    expect(codes.map((c) => c.to)).toEqual([ann.email]);
    // A wrong guess verifies nothing; the row is untouched.
    expect((await sender.verify(token, codes[0]!.code === '000000' ? '111111' : '000000')).status).toBe(400);
    expect((await sender.decide(token, { action: 'approve', expectedChangeSetHash: cs.hash })).status).toBe(401);
    expect((await getApproval(approvalId))?.status).toBe('pending');
  });

  it('the verified browser decides; the same token without that session does not', async () => {
    const { cs, approvalId } = await inReview('Verified');
    const [link] = await sendLinks(cs.changeSetId);
    const token = tokenOf(link!.url);
    const annBrowser = browser('10.3.0.1');
    await annBrowser.requestCode(token);
    expect((await annBrowser.verify(token, codes.at(-1)!.code)).status).toBe(204);
    expect((await annBrowser.open(token)).status).toBe(200);
    const bare = await call(null, 'POST', `/public-campaign-approval/${encodeURIComponent(token)}/decision`, { action: 'approve', expectedChangeSetHash: cs.hash }, '10.3.0.2');
    expect(bare.status, bare.raw).toBe(401);
    expect((await getApproval(approvalId))?.status).toBe('pending');
    const ok = await annBrowser.decide(token, { action: 'approve', expectedChangeSetHash: cs.hash });
    expect(ok.status, ok.raw).toBe(200);
    expect((await getApproval(approvalId))?.status).toBe('approved');
  });

  it('a send the transport refuses is recorded as failed, never as sent', async () => {
    transportAnswer = false;
    const { cs } = await inReview('Bounced');
    const [link] = await sendLinks(cs.changeSetId);
    expect(link!.delivery).toMatchObject({ channel: 'email', status: 'failed' });
  });

  it('with no code lane and no transport, the client policy keeps the v1 copy link', async () => {
    __setShareCodeMailForTest({ ready: false, sent: codes });
    __resetTransactionalEmail();
    const { cs, approvalId } = await inReview('Copy');
    const [link] = await sendLinks(cs.changeSetId);
    expect(link).toMatchObject({ verified: false, delivery: { channel: 'copy', status: 'sent' } });
    const r = await call(null, 'POST', `/public-campaign-approval/${encodeURIComponent(tokenOf(link!.url))}/decision`, { action: 'approve', expectedChangeSetHash: cs.hash }, '10.4.0.1');
    expect(r.status, r.raw).toBe(200);
    expect((await getApproval(approvalId))?.status).toBe('approved');
  });

  it('a member’s address is never a client approver: refused at add, and dropped at the vote', async () => {
    await createMember({ tenantId: TENANT, orgId: orgA, subject: 'oidc:p2c-member-mallory', email: 'mallory@agency.test', displayName: 'Mallory', roles: ['viewer'] });
    const add = await call<{ details?: { reason?: string } }>(adminCookie, 'POST', ops('/approvers'), { email: 'Mallory@Agency.test', displayName: 'Mallory' });
    expect(add.status, add.raw).toBe(409);
    expect(add.body.details?.reason).toBe('approver_is_member');

    // Ann is added as a client approver, then joins the agency.
    const { cs, approvalId } = await inReview('Became a member');
    const [link] = await sendLinks(cs.changeSetId);
    const token = tokenOf(link!.url);
    const annBrowser = browser('10.5.0.1');
    await annBrowser.requestCode(token);
    expect((await annBrowser.verify(token, codes.at(-1)!.code)).status).toBe(204);
    await createMember({ tenantId: TENANT, orgId: TENANT, subject: 'oidc:p2c-ann-joins', email: ann.email, displayName: 'Ann', roles: ['viewer'] });
    const unknown = await call(null, 'POST', '/public-campaign-approval/not-a-real-token-value/decision', { action: 'approve', expectedChangeSetHash: cs.hash }, '10.5.0.2');
    const r = await annBrowser.decide(token, { action: 'approve', expectedChangeSetHash: cs.hash });
    expect(r.status, r.raw).toBe(404);
    expect(r.raw).toBe(unknown.raw);
    expect((await getApproval(approvalId))?.status).toBe('pending');
    expect(await clientVoteStillLive(TENANT, orgA, cs.changeSetId, ann.approverId)).toBe(false);
  });

  it('an expired approval link answers the same 404 as an unknown token, not 410', async () => {
    const { cs } = await inReview('Expired');
    const [link] = await sendLinks(cs.changeSetId);
    const token = tokenOf(link!.url);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 8 * 86_400_000 });
    const expired = await call(null, 'GET', `/shared/${encodeURIComponent(token)}`, undefined, '10.6.0.1');
    const unknown = await call(null, 'GET', '/shared/not-a-real-token-value', undefined, '10.6.0.2');
    expect(expired.status, expired.raw).toBe(404);
    expect(expired.raw).toBe(unknown.raw);
    const decided = await call(null, 'POST', `/public-campaign-approval/${encodeURIComponent(token)}/decision`, { action: 'approve', expectedChangeSetHash: cs.hash }, '10.6.0.3');
    expect(decided.status, decided.raw).toBe(404);
  });

  it('a cookie-carrying decision or verify from a foreign origin is refused, form-style POST included', async () => {
    process.env.OPENWOP_CORS_ORIGINS = 'https://app.agency.test';
    const { cs, approvalId } = await inReview('Cross-site');
    const [link] = await sendLinks(cs.changeSetId);
    const token = tokenOf(link!.url);
    const annBrowser = browser('10.7.0.1');
    await annBrowser.requestCode(token);
    expect((await annBrowser.verify(token, codes.at(-1)!.code)).status).toBe(204);
    const path = `/public-campaign-approval/${encodeURIComponent(token)}/decision`;
    const json = JSON.stringify({ action: 'approve', expectedChangeSetHash: cs.hash });
    const forged = await annBrowser.raw(path, { headers: { 'content-type': 'application/json', origin: 'https://evil.test' }, body: json });
    expect(forged.status, forged.raw).toBe(403);
    expect(forged.body?.details?.code).toBe('csrf_origin_rejected');
    // The form-encoded shape a cross-site <form> can send without a preflight.
    const form = await annBrowser.raw(path, { headers: { 'content-type': 'text/plain', origin: 'https://evil.test' }, body: json });
    expect(form.status, form.raw).toBe(403);
    const viaReferer = await annBrowser.raw(path, { headers: { 'content-type': 'application/json', referer: 'https://evil.test/page' }, body: json });
    expect(viaReferer.status, viaReferer.raw).toBe(403);
    // Verifying (which binds a session) is refused the same way.
    const v = await annBrowser.raw(`/shared/${encodeURIComponent(token)}/verification/verify`, { headers: { 'content-type': 'application/json', origin: 'https://evil.test' }, body: JSON.stringify({ code: '000000' }) });
    expect(v.status, v.raw).toBe(403);
    expect((await getApproval(approvalId))?.status).toBe('pending');
    // The app's own origin decides.
    const ok = await annBrowser.raw(path, { headers: { 'content-type': 'application/json', origin: 'https://app.agency.test' }, body: json });
    expect(ok.status, ok.raw).toBe(200);
    expect((await getApproval(approvalId))?.status).toBe('approved');
  });

  it('a second approve of a decided change is the uniform 404 and changes nothing', async () => {
    const { cs, approvalId } = await inReview('Twice');
    const [link] = await sendLinks(cs.changeSetId);
    const token = tokenOf(link!.url);
    const annBrowser = browser('10.8.0.1');
    await annBrowser.requestCode(token);
    expect((await annBrowser.verify(token, codes.at(-1)!.code)).status).toBe(204);
    expect((await annBrowser.decide(token, { action: 'approve', expectedChangeSetHash: cs.hash })).status).toBe(200);
    const before = await getApproval(approvalId);
    const unknown = await call(null, 'POST', '/public-campaign-approval/not-a-real-token-value/decision', { action: 'approve', expectedChangeSetHash: cs.hash }, '10.8.0.2');
    const again = await annBrowser.decide(token, { action: 'approve', expectedChangeSetHash: cs.hash });
    expect(again.status, again.raw).toBe(404);
    expect(again.raw).toBe(unknown.raw);
    const after = await getApproval(approvalId);
    expect(after?.status).toBe('approved');
    expect(after?.resolvedAt).toBe(before?.resolvedAt);
    expect(after?.decidedBy).toBe(before?.decidedBy);
    // A reject after the approve does not flip it either.
    expect((await annBrowser.decide(token, { action: 'reject', expectedChangeSetHash: cs.hash })).status).toBe(404);
    expect((await getApproval(approvalId))?.status).toBe('approved');
  });

  it('once a client has had verified links, losing the email lane refuses the send instead of downgrading', async () => {
    const first = await inReview('Verified first');
    const [bound] = await sendLinks(first.cs.changeSetId);
    expect(bound!.verified).toBe(true);
    expect((await getClient(TENANT, orgA))?.verifiedLinksSince).toBeTruthy();
    // The agency's email lane goes away.
    __setShareCodeMailForTest({ ready: false, sent: codes });
    __resetTransactionalEmail();
    const { cs } = await inReview('After the lane went');
    const r = await call<{ details?: { reason?: string }; links?: unknown }>(adminCookie, 'POST', ops(`/change-sets/${cs.changeSetId}/approval-links`));
    expect(r.status, r.raw).toBe(409);
    expect(r.body.details?.reason).toBe('verification_unavailable');
    expect(r.body.links).toBeUndefined();
    // Re-sending the first change is refused too, and its bound link is not replaced.
    const again = await call<{ details?: { reason?: string } }>(adminCookie, 'POST', ops(`/change-sets/${first.cs.changeSetId}/approval-links`));
    expect(again.body.details?.reason).toBe('verification_unavailable');
    expect((await browser('10.9.0.1').open(tokenOf(bound!.url))).status).toBe(401);
  });
});

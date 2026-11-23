/**
 * ADR 0924 P2a — the campaign change-set kind on the shared vote path, through
 * the REAL routes (`createApp` + listen + signed cookies), the real portal and
 * the real SLA sweep.
 *
 * Pins (review finding in brackets):
 *  - [C1] a client's vote enters the host vote entry and the shared ledger: on a
 *    two-party row it is recorded as the `client` party and does NOT approve the
 *    change on its own;
 *  - [C2] on a quorum row the FIRST vote already runs the change-set checks: the
 *    requester's vote is refused (`separation-of-duties`) and counted nowhere,
 *    and a page edited since the proposal closes the review on that first vote
 *    (`asset_changed`);
 *  - [H3] when a quorum completes, an earlier vote whose voter has since lost
 *    `approvals:respond` is dropped and the change stays in review;
 *  - [H4] a per-row SLA expiry closes the change set (`rejected`, note
 *    `sla_expired`) and kills its client links, instead of rejecting the row and
 *    leaving the links answering the package;
 *  - [H5] an agency approve with an API key is refused `not_a_person`;
 *  - [M1, closes 0924 Q3] the person who WROTE the request cannot approve it
 *    while someone else can, even when someone else sent it for review.
 *
 * No change-set row carries a policy until 0924 P2b (`client_and_agency`), so the
 * quorum cases seed the row the way P2b's creator will (`createChangeSetApprovalOnce`
 * with a compiled policy, before `request-approval`, which then adopts it). Every
 * vote after that goes through the real routes.
 *
 * Red witness, per case, against `main` (the whole file also fails to import
 * there: `listGateDecisions` in `src/host/reviewDecisionLedger.ts` is new):
 *  - C1: `src/features/campaign-ops/approval.ts` `decideAs` resolves the row on
 *    the client's vote, so the decision answers `approved`;
 *  - C2: `src/host/approvalDecision.ts` `evaluateQuorum` records a non-final vote
 *    before the kind runs, so both first votes answer 200 `pending`;
 *  - H3: no re-check at completion, so the second vote approves;
 *  - H4: `src/host/approvalSla.ts` `firePerRowRung` raw-rejects, so the change set
 *    stays `in_review` and the link still serves the package (200);
 *  - H5: the decide path has no human-session rule for this kind;
 *  - M1: `approval.ts` compares the decider with the proposer only.
 * Sabotage (to run at the gate): return early from `checkChangeSetVote` on a
 * quorum row → C2 red; return `[]` from `staleChangeSetVotes` → H3 red; drop the
 * `expire` hook → H4 red; drop `req?.createdBy` from the submitters → M1 red.
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
import { createPage, transitionPage, updatePage } from '../src/features/cms/cmsService.js';
import { createClient, updateClient } from '../src/features/campaign-ops/clientService.js';
import { addAsset } from '../src/features/campaign-ops/assetService.js';
import { createRequest, recordInterpretation } from '../src/features/campaign-ops/requestService.js';
import { proposeChangeSet } from '../src/features/campaign-ops/changeSetService.js';
import { changeSetApprovalIdOf } from '../src/features/campaign-ops/approval.js';
import { CHANGE_SET_GRANT_KIND } from '../src/features/campaign-ops/portal.js';
import { createChangeSetApprovalOnce, getApproval, type ApprovalPolicy } from '../src/host/approvalService.js';
import { listGateDecisions } from '../src/host/reviewDecisionLedger.js';
import { sweepApprovalSla, trackApprovalSla } from '../src/host/approvalSla.js';
import { listGrants } from '../src/host/externalCollaborators.js';
import type { Job } from '../src/features/campaign-ops/execution.js';
import type { ChangeSet, ClientApprover } from '../src/features/campaign-ops/types.js';

let BASE: string;
let server: http.Server;
let TENANT: string;
let orgA: string;
let editorId: string;
let adminId: string;
let admin2Id: string;
let editorCookie: string;
let adminCookie: string;
let admin2Cookie: string;
let n = 0;

function cookieFor(userId: string, home: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant: home, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}
interface Res<T> { status: number; body: T; raw: string }
async function call<T = Record<string, unknown>>(auth: { cookie?: string; bearer?: string } | null, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const res = await fetch(`${BASE}/host/openwop-app${path}`, {
    method,
    headers: {
      ...(auth?.cookie ? { cookie: auth.cookie } : {}),
      ...(auth?.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T, raw };
}
const ck = (cookie: string) => ({ cookie });
const ops = (p: string): string => `/campaign-ops/clients/${orgA}${p}`;
const tokenOf = (url: string): string => decodeURIComponent(url.split('/shared/')[1]!);
const decide = (token: string, body: unknown) => call<{ status?: string; details?: { reason?: string } }>(null, 'POST', `/public-campaign-approval/${encodeURIComponent(token)}/decision`, body);
const readPackage = (token: string) => call(null, 'GET', `/shared/${encodeURIComponent(token)}`);
const approve = (auth: { cookie?: string; bearer?: string }, approvalId: string, hash: string) =>
  call<{ status?: string; details?: { reason?: string } }>(auth, 'POST', `/approvals/${approvalId}/claim`, { expectedChangeSetHash: hash });
const toggle = async (id: string, status: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };

/** A fresh client org per case. `client: true` adds Ann as the client approver
 *  and switches the client to the `client` policy. */
async function freshClient(opts: { client?: boolean } = {}): Promise<ClientApprover | null> {
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A (synthetic)' })).orgId;
  for (const [subject, role] of [[editorId, 'editor'], [adminId, 'admin'], [admin2Id, 'admin']] as const) {
    await createMember({ tenantId: TENANT, orgId: orgA, subject, displayName: subject, roles: [role] });
  }
  await createClient({ tenantId: TENANT, orgId: orgA, name: 'Client A (synthetic)', createdBy: 'seed' });
  await updateClient(TENANT, orgA, { mode: 'live' });
  if (!opts.client) return null;
  const a = await call<{ approver: ClientApprover }>(ck(adminCookie), 'POST', ops('/approvers'), { email: 'ann@client.test', displayName: 'Ann' });
  expect(a.status, a.raw).toBe(201);
  const p = await call(ck(adminCookie), 'PATCH', ops(''), { approvalPolicy: 'client' });
  expect(p.status, p.raw).toBe(200);
  return a.body.approver;
}

/** A live page, a request written by `requestBy`, and its proposed change set. */
async function proposed(title: string, requestBy = editorId): Promise<{ cs: ChangeSet; pageId: string }> {
  const page = await createPage({ tenantId: TENANT, orgId: orgA, title, createdBy: 'seed', sections: [{ type: 'hero', data: { heading: `${title} — Tuesday, Nov 3` } }] });
  await transitionPage(TENANT, orgA, page.pageId, 'publish', 'seed');
  const field = `sections[${page.sections[0].sectionId}].data.heading`;
  const asset = await addAsset({ tenantId: TENANT, orgId: orgA, destination: 'openwop.cms.page', locator: { pageId: page.pageId }, label: title, editableFields: [field], createdBy: 'seed' });
  const req = await createRequest({ tenantId: TENANT, orgId: orgA, text: `Change ${++n}: move the webinar`, assetIds: [asset.assetId], createdBy: requestBy });
  await recordInterpretation(TENANT, orgA, req.requestId, 1, { intents: [{ kind: 'replace_text', find: 'Tuesday, Nov 3', replace: 'Thursday, Nov 5', evidence: 'move the webinar' }], questions: [] });
  const out = await proposeChangeSet({
    tenantId: TENANT, orgId: orgA, requestId: req.requestId, version: 1, idempotencyKey: `p2a:${req.requestId}`, createdBy: editorId,
    proposal: { assets: [{ assetId: asset.assetId, edits: [{ field, find: 'Tuesday, Nov 3', replace: 'Thursday, Nov 5' }] }] },
  });
  if (out.kind !== 'created') throw new Error(`proposal not created: ${JSON.stringify(out)}`);
  return { cs: out.changeSet, pageId: page.pageId };
}

/** Send for review as the editor. With `policy`, first seed the row the way the
 *  0924 P2b creator will (a compiled policy on the deterministic id). */
async function toReview(cs: ChangeSet, policy?: ApprovalPolicy): Promise<string> {
  if (policy) {
    const { approval } = await createChangeSetApprovalOnce({
      tenantId: TENANT, orgId: orgA, approvalId: changeSetApprovalIdOf(TENANT, cs.changeSetId),
      changeSetId: cs.changeSetId, changeSetHash: cs.hash, requestId: cs.requestId, requestVersion: cs.requestVersion,
      sourceVersions: Object.fromEntries(cs.entries.map((e) => [e.assetId, { version: e.sourceVersion, contentHash: e.sourceContentHash }])),
      proposedBy: editorId, proposal: `Approve: ${cs.changeSetId}`, policy,
    });
    if (policy.sla) await trackApprovalSla(approval);
  }
  const r = await call<{ approvalId: string }>(ck(editorCookie), 'POST', ops(`/change-sets/${cs.changeSetId}/request-approval`));
  expect(r.status, r.raw).toBe(201);
  if (policy) expect((await getApproval(r.body.approvalId))?.policy, 'request-approval adopted the seeded row').toEqual(policy);
  return r.body.approvalId;
}

async function changeSetStatus(changeSetId: string): Promise<string | undefined> {
  return (await call<{ changeSet: ChangeSet }>(ck(adminCookie), 'GET', ops(`/change-sets/${changeSetId}`))).body.changeSet?.status;
}

async function settledJob(approvalId: string): Promise<Job> {
  return vi.waitFor(async () => {
    const r = await call<{ job: Job | null }>(ck(adminCookie), 'GET', ops(`/approvals/${approvalId}/job`));
    if (!r.body.job?.finishedAt) throw new Error(`job not settled: ${r.raw}`);
    return r.body.job;
  }, { timeout: 10_000, interval: 25 });
}

const AGENCY_QUORUM: ApprovalPolicy = { requiredApprovals: 2, approverRoleRefs: ['admin', 'editor'], rejectionPolicy: 'any' };
const TWO_PARTY: ApprovalPolicy = {
  requiredApprovals: 2, approverRoleRefs: ['admin'], rejectionPolicy: 'any',
  perParty: [{ party: 'agency', min: 1 }, { party: 'client', min: 1 }], clientApprover: true,
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['cms', 'campaign-ops', 'campaign-ops-client-portal']) await toggle(id, 'on');
  TENANT = (await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:p2a-owner' })).tenantId;
  editorId = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:p2a-editor', source: 'oidc' })).userId;
  adminId = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:p2a-admin', source: 'oidc' })).userId;
  admin2Id = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:p2a-admin2', source: 'oidc' })).userId;
  for (const subject of [editorId, adminId, admin2Id]) {
    await createMember({ tenantId: TENANT, orgId: TENANT, subject, displayName: subject, roles: ['viewer'] });
  }
  editorCookie = cookieFor(editorId, 'ws:home-p2a-ed');
  adminCookie = cookieFor(adminId, 'ws:home-p2a-ad');
  admin2Cookie = cookieFor(admin2Id, 'ws:home-p2a-ad2');
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0924 P2a — the client vote is a vote on the shared ledger (C1)', () => {
  it('on a two-party row the client approve is recorded for the client party and approves nothing alone', async () => {
    const ann = (await freshClient({ client: true }))!;
    const { cs } = await proposed('Client lane');
    const approvalId = await toReview(cs, TWO_PARTY);
    const links = await call<{ links: Array<{ approverId: string; url: string }> }>(ck(adminCookie), 'POST', ops(`/change-sets/${cs.changeSetId}/approval-links`));
    expect(links.status, links.raw).toBe(201);
    const token = tokenOf(links.body.links.find((l) => l.approverId === ann.approverId)!.url);

    const d = await decide(token, { action: 'approve', expectedChangeSetHash: cs.hash });
    expect(d.status, d.raw).toBe(200);
    expect(d.body.status).toBe('pending');
    expect((await getApproval(approvalId))?.status).toBe('pending');
    expect(await changeSetStatus(cs.changeSetId)).toBe('in_review');
    const votes = await listGateDecisions(approvalId);
    expect(votes.map((v) => ({ reviewerRef: v.reviewerRef, party: v.party, outcome: v.outcome })))
      .toEqual([{ reviewerRef: `client-approver:${ann.approverId}`, party: 'client', outcome: 'approved' }]);
  });
});

describe('ADR 0924 P2a — every vote runs the change-set checks (C2)', () => {
  it('the requester\'s first vote on a quorum row is refused and counted nowhere', async () => {
    await freshClient();
    const { cs } = await proposed('First vote self');
    const approvalId = await toReview(cs, AGENCY_QUORUM);
    const self = await approve(ck(editorCookie), approvalId, cs.hash);
    expect(self.status, self.raw).toBe(403);
    expect(self.body.details?.reason).toBe('separation-of-duties');
    expect(await listGateDecisions(approvalId)).toEqual([]);
    // Positive control: a non-requester's first vote is counted and waits.
    const other = await approve(ck(adminCookie), approvalId, cs.hash);
    expect(other.status, other.raw).toBe(200);
    expect(other.body.status).toBe('pending');
    expect((await listGateDecisions(approvalId)).map((v) => v.reviewerRef)).toEqual([adminId]);
  });

  it('a page edited since the proposal closes the review on the first vote', async () => {
    await freshClient();
    const { cs, pageId } = await proposed('First vote stale');
    const approvalId = await toReview(cs, AGENCY_QUORUM);
    await updatePage(TENANT, orgA, pageId, { title: 'First vote stale (edited by a person)' }, 'a-person');
    const r = await approve(ck(adminCookie), approvalId, cs.hash);
    expect(r.status, r.raw).toBe(409);
    expect(r.body.details?.reason).toBe('asset_changed');
    expect((await getApproval(approvalId))?.status).toBe('rejected');
    expect(await changeSetStatus(cs.changeSetId)).toBe('stale');
    expect(await listGateDecisions(approvalId)).toEqual([]);
  });
});

describe('ADR 0924 P2a — earlier votes are re-checked when the quorum completes (H3)', () => {
  it('a voter demoted after voting is dropped, and the change stays in review', async () => {
    await freshClient();
    const { cs } = await proposed('Demoted voter');
    const approvalId = await toReview(cs, { requiredApprovals: 2, approverRoleRefs: ['admin'], rejectionPolicy: 'any' });
    expect((await approve(ck(adminCookie), approvalId, cs.hash)).body.status).toBe('pending');
    const m = (await listMembers(TENANT, orgA)).find((x) => x.subject === adminId)!;
    await updateMember(m.memberId, { roles: ['viewer'] });
    const second = await approve(ck(admin2Cookie), approvalId, cs.hash);
    expect(second.status, second.raw).toBe(200);
    expect(second.body.status).toBe('pending');
    expect((await getApproval(approvalId))?.status).toBe('pending');
    expect((await listGateDecisions(approvalId)).map((v) => v.reviewerRef)).toEqual([admin2Id]);
    // Positive control: restored, the same person's vote completes it.
    await updateMember(m.memberId, { roles: ['admin'] });
    expect((await approve(ck(adminCookie), approvalId, cs.hash)).body.status).toBe('approved');
    expect((await settledJob(approvalId)).status).toBe('finished');
  });
});

describe('ADR 0924 P2a — the SLA expiry rejects through the kind (H4)', () => {
  it('closes the change set and kills its client links', async () => {
    const ann = (await freshClient({ client: true }))!;
    const { cs } = await proposed('Expired review');
    const approvalId = await toReview(cs, { requiredApprovals: 1, sla: { expireAfterMs: 60_000 } });
    const links = await call<{ links: Array<{ approverId: string; url: string }> }>(ck(adminCookie), 'POST', ops(`/change-sets/${cs.changeSetId}/approval-links`));
    expect(links.status, links.raw).toBe(201);
    const token = tokenOf(links.body.links.find((l) => l.approverId === ann.approverId)!.url);
    expect((await readPackage(token)).status, 'positive control: the link serves the package before expiry').toBe(200);

    await sweepApprovalSla(new Date(Date.now() + 120_000));

    expect(await getApproval(approvalId)).toMatchObject({ status: 'rejected', note: 'sla_expired', decidedBy: 'system:sla-expiry' });
    expect(await changeSetStatus(cs.changeSetId)).toBe('rejected');
    expect((await readPackage(token)).status).toBe(404);
    const grants = (await listGrants(TENANT, orgA, ann.approverId)).filter((g) => g.resource.kind === CHANGE_SET_GRANT_KIND && g.resource.id === cs.changeSetId);
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((g) => g.status !== 'active')).toBe(true);
  });
});

describe('ADR 0924 P2a — agency approvals need a person (H5) and not a requester (M1)', () => {
  it('an API key cannot cast the agency approve', async () => {
    await freshClient();
    const { cs } = await proposed('Via key');
    const approvalId = await toReview(cs);
    const key = await call<{ token: string }>(ck(adminCookie), 'POST', '/developer-keys', { name: 'p2a', scopes: ['*'] });
    expect(key.status, key.raw).toBe(201);
    const r = await approve({ bearer: key.body.token }, approvalId, cs.hash);
    expect(r.status, r.raw).toBe(403);
    expect(r.body.details?.reason).toBe('not_a_person');
    expect((await getApproval(approvalId))?.status).toBe('pending');
  });

  it('whoever wrote the request cannot approve it while someone else can', async () => {
    await freshClient();
    const { cs } = await proposed('Request author', admin2Id);
    const approvalId = await toReview(cs); // sent for review by the editor, not the author
    const author = await approve(ck(admin2Cookie), approvalId, cs.hash);
    expect(author.status, author.raw).toBe(403);
    expect(author.body.details?.reason).toBe('separation-of-duties');
    expect((await getApproval(approvalId))?.status).toBe('pending');
    // Positive control: another admin approves it.
    expect((await approve(ck(adminCookie), approvalId, cs.hash)).status).toBe(200);
    expect((await settledJob(approvalId)).status).toBe('finished');
  });
});

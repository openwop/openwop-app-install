/**
 * ADR 0957 P2 — the link-only client report portal and its emailed link,
 * through the real routes: an editor sends a PUBLISHED report to the client's
 * link-only stakeholders; the stakeholder reads it through the sharing viewer.
 *
 * Exit criteria pinned (ADR 0957 phased plan, P2):
 *  - a revoked grant is dark on the next request (and so are a withdrawn report,
 *    the portal toggle off, and a sender who lost write on the client);
 *  - the email contains no figures: outside its URL it has no digit at all.
 * Also pinned:
 *  - only a published report can be sent; a draft or in-review one is 409;
 *  - the page shows the frozen snapshot and nothing about the agency's people
 *    (no generatedBy / publishedBy / runId, no member id anywhere in the body);
 *  - a member cannot mint a `client_report` link on the member lane, even with a
 *    real live grant id (SYSTEM_MINT_ONLY);
 *  - no transport means `emailed: false` with the link still returned;
 *  - subject erasure tombstones the sender on the link record, which darkens it.
 *
 * Sabotage witnesses (each must red its case; NOT RUN at authoring, 2026-11-19,
 * the parent session runs them):
 *  - drop `checkGrantLink` from `liveReport` (portalLinks.ts) → "a revoked grant is dark";
 *  - drop the `status !== 'published'` check in `liveReport` AND `publishedReportExists` → "withdrawn is dark";
 *  - drop the sender `assertOrgScope` in `liveReport` → "a demoted sender's link is dark";
 *  - add `snapshot`'s figures to the email template → "the email carries no figures";
 *  - remove `client_report` from SYSTEM_MINT_ONLY (sharingService.ts) → "a member cannot mint";
 *  - drop `eraseReportLinkSenders` from the campaign-ops eraser → "erasure tombstones the sender".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace, updateMember } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createClient, getClient, updateClient } from '../src/features/campaign-ops/clientService.js';
import { persistRecords } from '../src/features/campaign-connectors/performanceService.js';
import { createReport, getDefinition, publishReport } from '../src/features/campaign-ops/reports/reportService.js';
import { reportLinkDays, sendReportLinks } from '../src/features/campaign-ops/reports/portalLinks.js';
import { eraseCampaignOpsSubject } from '../src/features/campaign-ops/erasure.js';
import { listGrants, revokeGrant } from '../src/host/externalCollaborators.js';
import { createLink } from '../src/features/sharing/sharingService.js';
import { setTransactionalEmailTransport, type TransactionalEmail } from '../src/host/transactionalEmail.js';
import type { ClientReport, ReportDefinition } from '../src/features/campaign-ops/reports/types.js';
import type { ClientApprover } from '../src/features/campaign-ops/types.js';

let BASE: string;
let server: http.Server;
let TENANT: string;
let editorId: string;
let adminId: string;
let editorCookie: string;
let adminCookie: string;
let orgA: string;
let editorMemberOnA: string;
let outbox: TransactionalEmail[] = [];

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
const readShared = (token: string) => call<{ resourceType?: string; resource?: Record<string, unknown> }>(null, 'GET', `/shared/${encodeURIComponent(token)}`);
const toggle = async (id: string, status: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };

type SentLink = { collaboratorId: string; url: string; email: string; emailed: boolean; expiresAt?: string };

/** One client per case: its members, two link-only contacts, distinctive figures. */
async function freshClient(): Promise<{ ann: ClientApprover; bob: ClientApprover }> {
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Harbor Client' })).orgId;
  editorMemberOnA = (await createMember({ tenantId: TENANT, orgId: orgA, subject: editorId, displayName: 'Editor', roles: ['editor'] })).memberId;
  await createMember({ tenantId: TENANT, orgId: orgA, subject: adminId, displayName: 'Admin', roles: ['admin'] });
  await createClient({ tenantId: TENANT, orgId: orgA, name: 'Harbor Client', createdBy: 'seed' });
  await updateClient(TENANT, orgA, { mode: 'live' });
  await persistRecords(TENANT, orgA, [{
    platform: 'meta', campaignName: 'Q4', adSet: 'A', date: '2026-09-01', spend: 4321.75, impressions: 98_765, clicks: 987, conversions: 13,
    revenue: 650, ctr: 0.01, cpc: 4.38, cvr: 0.013, cpa: 332.44, roas: 0.15, currency: 'USD',
  }], 'csv');
  const add = async (email: string, displayName: string): Promise<ClientApprover> => {
    const a = await call<{ approver: ClientApprover }>(adminCookie, 'POST', ops('/approvers'), { email, displayName });
    expect(a.status, a.raw).toBe(201);
    return a.body.approver;
  };
  return { ann: await add('ann@harbor.test', 'Ann'), bob: await add('bob@harbor.test', 'Bob') };
}

/** A report in the given state, built through the real service (the chain's
 *  compute and its publish CAS; the gate is pinned in adr0957-p1-*). */
async function reportIn(status: 'draft' | 'in_review' | 'published'): Promise<ClientReport> {
  const d = await call<{ definition: ReportDefinition }>(editorCookie, 'POST', ops('/report-definitions'), {
    title: 'Monthly results', sections: [{ kind: 'kpi' }], period: { kind: 'month', timezone: 'UTC' },
  });
  expect(d.status, d.raw).toBe(201);
  const def = (await getDefinition(TENANT, orgA, d.body.definition.definitionId))!;
  const period = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };
  if (status === 'draft') return createReport(def, period, editorId);
  const r = await createReport(def, period, editorId, { runId: `run_${randomBytes(6).toString('hex')}` });
  return status === 'in_review' ? r : publishReport(TENANT, orgA, r.reportId, r.snapshotHash, adminId);
}

async function send(cookie: string, reportId: string, body?: unknown): Promise<Res<{ links?: SentLink[]; details?: { reason?: string } }>> {
  return call(cookie, 'POST', ops(`/reports/${reportId}/links`), body ?? {});
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['cms', 'campaign-ops', 'campaign-ops-client-portal', 'campaign-ops.client-reports', 'campaign-connectors']) await toggle(id, 'on');
  TENANT = (await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:rlink-owner' })).tenantId;
  editorId = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:rlink-editor', source: 'oidc' })).userId;
  adminId = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:rlink-admin', source: 'oidc' })).userId;
  for (const subject of [editorId, adminId]) await createMember({ tenantId: TENANT, orgId: TENANT, subject, displayName: subject, roles: ['viewer'] });
  editorCookie = cookieFor(editorId, 'ws:home-rlink-ed');
  adminCookie = cookieFor(adminId, 'ws:home-rlink-ad');
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(() => {
  outbox = [];
  // Last writer wins over the email feature's brokered transport (no connection in tests).
  setTransactionalEmailTransport(async (email) => { outbox.push(email); return true; });
});

describe('ADR 0957 P2 — sending a published report', () => {
  it('only a published report can be sent', async () => {
    await freshClient();
    for (const status of ['draft', 'in_review'] as const) {
      const r = await reportIn(status);
      const res = await send(editorCookie, r.reportId);
      expect(res.status, res.raw).toBe(409);
      expect(res.body.details?.reason).toBe('report_not_published');
    }
    expect(outbox).toEqual([]);
  });

  it('a link per contact; the page is the frozen snapshot and nothing about the agency\'s people', async () => {
    await freshClient();
    const r = await reportIn('published');
    const res = await send(editorCookie, r.reportId);
    expect(res.status, res.raw).toBe(201);
    const links = res.body.links!;
    expect(links.map((l) => l.email).sort()).toEqual(['ann@harbor.test', 'bob@harbor.test']);
    expect(links.every((l) => l.emailed)).toBe(true);
    const page = await readShared(tokenOf(links[0]!.url));
    expect(page.status, page.raw).toBe(200);
    expect(page.body.resourceType).toBe('client_report');
    expect(page.body.resource).toMatchObject({ kind: 'client_report', title: 'Monthly results', clientName: 'Harbor Client', periodStart: '2026-09-01', periodEnd: '2026-09-30', snapshotHash: r.snapshotHash });
    expect(page.body.resource?.snapshot).toEqual(r.snapshot);
    for (const k of ['generatedBy', 'publishedBy', 'runId', 'definitionId', 'createdBy']) expect(page.body.resource).not.toHaveProperty(k);
    expect(page.raw).not.toContain(editorId);
    expect(page.raw).not.toContain(adminId);
    // The Q2 proposed default: next period end + 30 days, within 7–180.
    expect(reportLinkDays(r, new Date('2026-10-05T00:00:00Z'))).toBe(55);
    expect(reportLinkDays(r, new Date('2027-06-01T00:00:00Z'))).toBe(7);
  });

  it('the email carries no figures: outside its URL there is no digit at all', async () => {
    await freshClient();
    const r = await reportIn('published');
    const res = await send(editorCookie, r.reportId);
    expect(res.status, res.raw).toBe(201);
    expect(outbox).toHaveLength(2);
    for (const mail of outbox) {
      const link = res.body.links!.find((l) => l.email === mail.to)!;
      expect(mail.text).toContain(link.url);
      expect(mail.context).toMatchObject({ tenantId: TENANT, orgId: orgA, actingUserId: editorId });
      expect(mail.context?.idempotencyKey).toMatch(/^client-report-link:cgr_/);
      const words = `${mail.subject}\n${mail.text.split(link.url).join('')}`;
      expect(words, 'a figure leaked into the email').not.toMatch(/[0-9]/);
    }
  });

  it('no transport means no email: the link still comes back with emailed:false', async () => {
    await freshClient();
    const r = await reportIn('published');
    setTransactionalEmailTransport(async () => false);
    const res = await send(editorCookie, r.reportId);
    expect(res.status, res.raw).toBe(201);
    expect(res.body.links!.every((l) => l.emailed === false && l.url.includes('/shared/'))).toBe(true);
    expect((await readShared(tokenOf(res.body.links![0]!.url))).status).toBe(200);
  });
});

describe('ADR 0957 P2 — every view re-checks', () => {
  it('a revoked grant is dark on the next request; the other contact\'s link still works', async () => {
    const { ann } = await freshClient();
    const r = await reportIn('published');
    const links = (await send(editorCookie, r.reportId)).body.links!;
    const annLink = links.find((l) => l.collaboratorId === ann.approverId)!;
    const bobLink = links.find((l) => l.collaboratorId !== ann.approverId)!;
    expect((await readShared(tokenOf(annLink.url))).status).toBe(200);
    const grant = (await listGrants(TENANT, orgA, ann.approverId)).find((g) => g.resource.kind === 'client-report' && g.status === 'active')!;
    await revokeGrant(TENANT, orgA, grant.grantId, adminId);
    expect((await readShared(tokenOf(annLink.url))).status).toBe(404);
    expect((await readShared(tokenOf(bobLink.url))).status).toBe(200);
  });

  it('a re-send supersedes the earlier link of that pair', async () => {
    await freshClient();
    const r = await reportIn('published');
    const first = (await send(editorCookie, r.reportId)).body.links!;
    const second = (await send(editorCookie, r.reportId)).body.links!;
    expect((await readShared(tokenOf(first[0]!.url))).status).toBe(404);
    expect((await readShared(tokenOf(second[0]!.url))).status).toBe(200);
  });

  it('a withdrawn report is dark; withdrawing needs member management on the client', async () => {
    await freshClient();
    const r = await reportIn('published');
    const link = (await send(editorCookie, r.reportId)).body.links![0]!;
    expect((await call(editorCookie, 'POST', ops(`/reports/${r.reportId}/withdraw`))).status).toBe(403);
    expect((await readShared(tokenOf(link.url))).status).toBe(200);
    const w = await call<{ report: ClientReport }>(adminCookie, 'POST', ops(`/reports/${r.reportId}/withdraw`));
    expect(w.status, w.raw).toBe(200);
    expect(w.body.report).toMatchObject({ status: 'withdrawn', withdrawnBy: adminId, snapshotHash: r.snapshotHash });
    expect((await readShared(tokenOf(link.url))).status).toBe(404);
    expect((await send(editorCookie, r.reportId)).body.details?.reason).toBe('report_not_published');
  });

  it('turning the portal off darkens the link; turning it back on restores it', async () => {
    await freshClient();
    const r = await reportIn('published');
    const link = (await send(editorCookie, r.reportId)).body.links![0]!;
    await toggle('campaign-ops-client-portal', 'off');
    try {
      expect((await readShared(tokenOf(link.url))).status).toBe(404);
      expect((await send(editorCookie, r.reportId)).body.details?.reason).toBe('portal_off');
    } finally { await toggle('campaign-ops-client-portal', 'on'); }
    expect((await readShared(tokenOf(link.url))).status).toBe(200);
  });

  it('the send itself refuses a sender who cannot edit the client, not only the route', async () => {
    // Defence in depth: the route gates workspace:write, and `sendReportLinks` asks
    // again, because the links are handed out under the sender's authority. Red
    // witness: drop the `senderMayShare` check and this mints links for a viewer.
    await freshClient();
    const r = await reportIn('published');
    await updateMember(editorMemberOnA, { roles: ['viewer'] });
    const client = (await getClient(TENANT, orgA))!;
    await expect(sendReportLinks({ tenantId: TENANT, client, reportId: r.reportId, sentBy: editorId, baseUrl: 'https://app.test' }))
      .rejects.toMatchObject({ code: 'forbidden_scope', httpStatus: 403 });
    expect(outbox).toEqual([]);
    expect((await listGrants(TENANT, orgA)).filter((g) => g.resource.kind === 'client-report')).toEqual([]);
  });

  it('a demoted sender\'s link is dark: it was handed out under their authority', async () => {
    await freshClient();
    const r = await reportIn('published');
    const link = (await send(editorCookie, r.reportId)).body.links![0]!;
    await updateMember(editorMemberOnA, { roles: ['viewer'] });
    expect((await readShared(tokenOf(link.url))).status).toBe(404);
    await updateMember(editorMemberOnA, { roles: ['editor'] });
    expect((await readShared(tokenOf(link.url))).status).toBe(200);
  });

  it('a member cannot mint a client_report link on the member lane, even with a live grant', async () => {
    const { ann } = await freshClient();
    const r = await reportIn('published');
    await send(editorCookie, r.reportId);
    const grant = (await listGrants(TENANT, orgA, ann.approverId)).find((g) => g.resource.kind === 'client-report' && g.status === 'active')!;
    await expect(createLink(TENANT, orgA, editorId, { resourceType: 'client_report', resourceId: `${r.reportId}:${grant.grantId}` }, { lane: 'member' }))
      .rejects.toMatchObject({ httpStatus: 404 });
  });

  it('subject erasure tombstones the sender on the link record, which darkens the link', async () => {
    await freshClient();
    const r = await reportIn('published');
    const link = (await send(editorCookie, r.reportId)).body.links![0]!;
    const out = await eraseCampaignOpsSubject(TENANT, editorId);
    expect(out.rowsTouched).toBeGreaterThan(0);
    expect((await readShared(tokenOf(link.url))).status).toBe(404);
  });
});

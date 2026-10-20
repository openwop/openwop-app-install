/**
 * Campaign ops P0 — version-bound approval (ADR 0924) and execution with
 * read-back verification (ADR 0925), through the REAL approvals route, the real
 * decision core, the run starter and the `campaign-ops.execute` chain.
 *
 * The thesis, case by case:
 *  - an approval names one hash; a decider who saw another is refused
 *    (`change_set_mismatch`) and nothing is consumed;
 *  - a newer human edit after the proposal closes the review (`asset_changed`)
 *    and the change set goes stale; nothing is written;
 *  - the person who asked cannot approve (separation of duties);
 *  - an approved change is written under the approver's own CMS authority and
 *    confirmed ONLY by reading the page back;
 *  - one destination failing leaves the job `needs_attention` with that step
 *    `incomplete`, never `finished` (no false "done");
 *  - a write that times out after it landed is reconciled from the page itself:
 *    `confirmed`, with exactly one write; a destination that reports success but
 *    did not change is `conflicted` (`readback_mismatch`).
 * Also witnesses that the same change asked for DIFFERENT pages is not a
 * duplicate (every case here proposes identical intents for its own page).
 *
 * Sabotage, each run 2026-10-19 and each red: dropping the hash check, the
 * asset-version check, separation of duties, the read-back compare (always
 * "confirmed"), and the reconcile read before a retry.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createPage, getPage, transitionPage, updatePage } from '../src/features/cms/cmsService.js';
import { createClient, updateClient } from '../src/features/campaign-ops/clientService.js';
import { addAsset } from '../src/features/campaign-ops/assetService.js';
import { createRequest, recordInterpretation } from '../src/features/campaign-ops/requestService.js';
import { proposeChangeSet } from '../src/features/campaign-ops/changeSetService.js';
import { cmsPageAdapter } from '../src/features/campaign-ops/adapters/cmsPage.js';
import type { Job } from '../src/features/campaign-ops/execution.js';
import type { ChangeSet } from '../src/features/campaign-ops/types.js';

let BASE: string;
let server: http.Server;
let TENANT: string;
let orgA: string;
let operatorId: string;
let approverId: string;
let operatorCookie: string;
let approverCookie: string;
let n = 0;

function cookieFor(userId: string, home: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant: home, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}
interface Res<T> { status: number; body: T; raw: string }
async function call<T = Record<string, unknown>>(cookie: string, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const res = await fetch(`${BASE}/host/openwop-app${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T, raw };
}
const ops = (p: string): string => `/campaign-ops/clients/${orgA}${p}`;

/** A live landing page registered as an asset, its heading field editable. */
async function livePageAsset(title: string): Promise<{ assetId: string; pageId: string; field: string }> {
  const page = await createPage({ tenantId: TENANT, orgId: orgA, title, createdBy: 'seed', sections: [{ type: 'hero', data: { heading: `${title} — Tuesday, Nov 3` } }] });
  await transitionPage(TENANT, orgA, page.pageId, 'publish', 'seed');
  const field = `sections[${page.sections[0].sectionId}].data.heading`;
  const asset = await addAsset({ tenantId: TENANT, orgId: orgA, destination: 'openwop.cms.page', locator: { pageId: page.pageId }, label: title, editableFields: [field], createdBy: 'seed' });
  return { assetId: asset.assetId, pageId: page.pageId, field };
}

/** A proposed change set built through the services (no model involved). */
async function proposed(targets: Array<{ assetId: string; field: string; find: string; replace: string }>): Promise<ChangeSet> {
  const req = await createRequest({ tenantId: TENANT, orgId: orgA, text: `Change ${++n}: move the webinar`, assetIds: targets.map((t) => t.assetId), createdBy: operatorId });
  await recordInterpretation(TENANT, orgA, req.requestId, 1, { intents: [{ kind: 'replace_text', find: 'Tuesday, Nov 3', replace: 'Thursday, Nov 5', evidence: 'move the webinar' }], questions: [] });
  const out = await proposeChangeSet({
    tenantId: TENANT, orgId: orgA, requestId: req.requestId, version: 1, idempotencyKey: `test:${req.requestId}`, createdBy: operatorId,
    proposal: { assets: targets.map((t) => ({ assetId: t.assetId, edits: [{ field: t.field, find: t.find, replace: t.replace }] })) },
  });
  if (out.kind !== 'created') throw new Error(`proposal not created: ${JSON.stringify(out)}`);
  return out.changeSet;
}
async function toReview(cs: ChangeSet): Promise<string> {
  const r = await call<{ approvalId: string }>(operatorCookie, 'POST', ops(`/change-sets/${cs.changeSetId}/request-approval`));
  expect(r.status, r.raw).toBe(201);
  return r.body.approvalId;
}
const approve = (cookie: string, approvalId: string, hash: string) =>
  call<{ error?: string }>(cookie, 'POST', `/approvals/${approvalId}/claim`, { expectedChangeSetHash: hash });
async function settledJob(approvalId: string): Promise<Job> {
  return vi.waitFor(async () => {
    const r = await call<{ job: Job | null }>(operatorCookie, 'GET', ops(`/approvals/${approvalId}/job`));
    expect(r.body.job?.finishedAt, r.raw).toBeTruthy();
    return r.body.job!;
  }, { timeout: 10_000, interval: 25 });
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['cms', 'campaign-ops']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  TENANT = (await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:cops3-owner' })).tenantId;
  const op = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:cops3-operator', source: 'oidc' });
  const ap = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:cops3-approver', source: 'oidc' });
  operatorId = op.userId; approverId = ap.userId;
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A (synthetic)' })).orgId;
  for (const [subject, rootRole, clientRole] of [[operatorId, 'viewer', 'editor'], [approverId, 'viewer', 'admin']] as const) {
    await createMember({ tenantId: TENANT, orgId: TENANT, subject, displayName: subject, roles: [rootRole] });
    await createMember({ tenantId: TENANT, orgId: orgA, subject, displayName: subject, roles: [clientRole] });
  }
  await createClient({ tenantId: TENANT, orgId: orgA, name: 'Client A (synthetic)', createdBy: 'seed' });
  await updateClient(TENANT, orgA, { mode: 'live' });
  operatorCookie = cookieFor(operatorId, 'ws:home-op3');
  approverCookie = cookieFor(approverId, 'ws:home-ap3');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => { vi.restoreAllMocks(); });

describe('ADR 0924 — an approval authorizes exactly one change set', () => {
  it('refuses a decider who saw a different hash, and consumes nothing', async () => {
    const a = await livePageAsset('Mismatch page');
    const cs = await proposed([{ assetId: a.assetId, field: a.field, find: 'Tuesday, Nov 3', replace: 'Thursday, Nov 5' }]);
    const approvalId = await toReview(cs);
    const r = await approve(approverCookie, approvalId, 'sha256:not-the-hash');
    expect(r.status, r.raw).toBe(409);
    expect(r.raw).toContain('change_set_mismatch');
    const ok = await approve(approverCookie, approvalId, cs.hash); // still pending, so a correct decide works
    expect(ok.status, ok.raw).toBe(200);
    await settledJob(approvalId);
  });

  it('a newer human edit closes the review and stales the change set; nothing is written', async () => {
    const a = await livePageAsset('Stale page');
    const cs = await proposed([{ assetId: a.assetId, field: a.field, find: 'Tuesday, Nov 3', replace: 'Thursday, Nov 5' }]);
    const approvalId = await toReview(cs);
    await updatePage(TENANT, orgA, a.pageId, { title: 'Stale page (edited by a person)' }, 'a-person');
    const r = await approve(approverCookie, approvalId, cs.hash);
    expect(r.status, r.raw).toBe(409);
    expect(r.raw).toContain('asset_changed');
    const cur = await call<{ changeSet: ChangeSet }>(operatorCookie, 'GET', ops(`/change-sets/${cs.changeSetId}`));
    expect(cur.body.changeSet).toMatchObject({ status: 'stale', staleReason: 'asset_changed' });
    const page = await getPage(TENANT, orgA, a.pageId);
    expect(JSON.stringify(page?.sections)).toContain('Tuesday, Nov 3');
  });

  it('the person who asked cannot approve it', async () => {
    const a = await livePageAsset('Self page');
    const cs = await proposed([{ assetId: a.assetId, field: a.field, find: 'Tuesday, Nov 3', replace: 'Thursday, Nov 5' }]);
    const approvalId = await toReview(cs);
    const r = await approve(operatorCookie, approvalId, cs.hash);
    expect(r.status, r.raw).toBe(403);
    expect(r.raw).toContain('separation-of-duties');
  });
});

describe('ADR 0925 — completion comes from reading the destination back', () => {
  it('writes the approved change and confirms it from the live page', async () => {
    const a = await livePageAsset('Happy page');
    const cs = await proposed([{ assetId: a.assetId, field: a.field, find: 'Tuesday, Nov 3', replace: 'Thursday, Nov 5' }]);
    const approvalId = await toReview(cs);
    expect((await approve(approverCookie, approvalId, cs.hash)).status).toBe(200);
    const job = await settledJob(approvalId);
    expect(job.status).toBe('finished');
    expect(job.steps[0]).toMatchObject({ state: 'confirmed', attempts: 1 });
    const page = await getPage(TENANT, orgA, a.pageId);
    expect(page?.sections[0].data.heading).toBe('Happy page — Thursday, Nov 5');
    expect(page?.status).toBe('published'); // the in-place edit of a live page is its publish
  });

  it('one destination failing is visible: needs_attention, never finished', async () => {
    const ok = await livePageAsset('Partial ok');
    const bad = await livePageAsset('Partial blocked');
    // A `[TODO …]` marker is a publish blocker on a live page, so the CMS refuses that write.
    const cs = await proposed([
      { assetId: ok.assetId, field: ok.field, find: 'Tuesday, Nov 3', replace: 'Thursday, Nov 5' },
      { assetId: bad.assetId, field: bad.field, find: 'Tuesday, Nov 3', replace: 'Thursday, Nov 5 [TODO confirm room]' },
    ]);
    const approvalId = await toReview(cs);
    expect((await approve(approverCookie, approvalId, cs.hash)).status).toBe(200);
    const job = await settledJob(approvalId);
    expect(job.status).toBe('needs_attention');
    expect(job.outcome).toMatchObject({ confirmed: 1, incomplete: 1, total: 2 });
    const byAsset = Object.fromEntries(job.steps.map((s) => [s.assetId, s]));
    expect(byAsset[ok.assetId]).toMatchObject({ state: 'confirmed' });
    expect(byAsset[bad.assetId]).toMatchObject({ state: 'incomplete', reason: 'publish_blocked' });
  });

  it('a destination that reports success but did not change is conflicted, not done', async () => {
    const a = await livePageAsset('Liar page');
    const cs = await proposed([{ assetId: a.assetId, field: a.field, find: 'Tuesday, Nov 3', replace: 'Thursday, Nov 5' }]);
    vi.spyOn(cmsPageAdapter, 'write').mockResolvedValue({ kind: 'written', version: 999 }); // claims success, writes nothing
    const approvalId = await toReview(cs);
    expect((await approve(approverCookie, approvalId, cs.hash)).status).toBe(200);
    const job = await settledJob(approvalId);
    expect(job.steps[0]).toMatchObject({ state: 'conflicted', reason: 'readback_mismatch' });
    expect(job.status).toBe('needs_attention');
  });

  it('a write that timed out after landing is reconciled from the page: confirmed, one write', async () => {
    const a = await livePageAsset('Timeout page');
    const cs = await proposed([{ assetId: a.assetId, field: a.field, find: 'Tuesday, Nov 3', replace: 'Thursday, Nov 5' }]);
    const realWrite = cmsPageAdapter.write.bind(cmsPageAdapter);
    let writes = 0;
    vi.spyOn(cmsPageAdapter, 'write').mockImplementation(async (...args) => {
      writes++;
      await realWrite(...args);
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); // accepted, then the reply was lost
    });
    const approvalId = await toReview(cs);
    expect((await approve(approverCookie, approvalId, cs.hash)).status).toBe(200);
    const job = await settledJob(approvalId);
    expect(job.steps[0]).toMatchObject({ state: 'confirmed', attempts: 1 });
    expect(writes).toBe(1);
    expect(job.status).toBe('finished');
  });
});

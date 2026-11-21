/**
 * ADR 1022 CP71WF-23 (corrected 2026-11-20) — the person who proposes a budget
 * reallocation cannot approve it, on the Campaign Intelligence route
 * (`POST …/campaign-intel/reallocations/propose`) and the Intelligence Analyst's
 * chat tool (`openwop:campaign-intel.propose-reallocation`). Before the fix both
 * lanes wrote a campaign-spend approval with `submitters` but NO named approvers,
 * and the decide-time check (`host/autonomyPolicy/spendEligibility.ts`) only runs
 * for rows that name approvers, so the proposer approved their own plan.
 *
 * What it pins, through the real app, the real lanes and the real decide path
 * (`claimApproval` / `rejectApproval`):
 *   - a route proposal names the client org's approvers (owner/admin) and lists
 *     the proposer as a submitter; the proposer's vote is refused, also from a
 *     human session while another admin exists (`autonomy_self_approval_refused`);
 *   - the same for a chat-tool proposal; the chat turn's run id names no stored
 *     run, and the approval does not point at it (a dangling source run would
 *     refuse EVERY vote as `autonomy_requester_unreadable`);
 *   - a different admin on the client approves; a non-requester without an
 *     approver role on the client is refused (`autonomy_not_eligible`), so the
 *     named approvers are enforced, not only the requester list;
 *   - a reject by the proposer is REFUSED too. This is the existing rule for a
 *     row that names approvers (ADR 0942 D10.2, "in either direction"; the
 *     sole-admin exception is approve-only). Before the fix the proposer could reject;
 *     another admin still can;
 *   - the sole-admin self-approval ADR: the client org's only admin, voting in their own session, may
 *     approve their own plan, and the audit chain records `sole_admin`; the same
 *     vote without a session stays refused.
 *
 * Red witnesses (DESIGNED, NOT YET RUN — the authoring session was barred from
 * every test runner while merge trains gated; run each before citing this file):
 *   - drop `bindApproval` from the route (`campaign-intel/routes.ts`): the
 *     approval names no approvers, `spendEligibility` returns early, and the
 *     route proposer's vote PASSES — the route case goes red;
 *   - drop `bindApproval` from the chat tool (`campaign-intel/agentTools.ts`):
 *     the chat case goes red the same way;
 *   - make `reallocationApprovers` always set `autonomySourceRunId` to the
 *     policy run id: the chat approval points at a run that does not exist and
 *     the other admin's approve is refused — the different-admin case goes red;
 *   - remove the `soleAdminSelfApproval` call from `spendEligibility.ts`: the
 *     sole-admin case goes red.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';
import { importCsv } from '../src/features/campaign-connectors/performanceService.js';
import { getApproval } from '../src/host/approvalService.js';
import { claimApproval, rejectApproval } from '../src/host/approvalDecision.js';
import { listChain } from '../src/host/auditChainService.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { CAMPAIGN_INTEL_PROPOSE_REALLOCATION_TOOL_ID } from '../src/features/campaign-intel/agentTools.js';
import { AUTONOMY_TOGGLE } from '../src/host/autonomyPolicy/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import type {
  AdsAdapter, DispatchLedgerRow, GetCampaignBudgetArgs, GetCampaignBudgetResult, UpdateBudgetArgs, UpdateBudgetResult,
} from '../src/host/adsAdapter.js';

/** A fake ad platform behind the real adapter: per-campaign daily budgets; the dispatch ledger per tenant. */
const fake = vi.hoisted(() => ({
  ledger: new Map<string, Array<Record<string, unknown>>>(),
  budgets: new Map<string, number>(),
  writes: [] as Array<{ campaignId: string; dailyBudgetMinor: number }>,
}));
vi.mock('../src/host/adsAdapter.js', async (orig) => {
  const real = await orig<typeof import('../src/host/adsAdapter.js')>();
  return {
    ...real,
    listTenantDispatchRecords: vi.fn(async (tenantId: string) => (fake.ledger.get(tenantId) ?? []) as unknown as DispatchLedgerRow[]),
    makeAdsAdapter: vi.fn((deps: Parameters<typeof real.makeAdsAdapter>[0]): AdsAdapter => ({
      ...real.makeAdsAdapter(deps),
      getCampaignBudget: async (a: GetCampaignBudgetArgs): Promise<GetCampaignBudgetResult> => {
        const b = fake.budgets.get(a.campaignId);
        return b === undefined ? { outcome: 'failed', error: 'http_500' } : { outcome: 'ok', platform: a.platform, dailyBudgetMinor: b };
      },
      updateBudget: async (a: UpdateBudgetArgs): Promise<UpdateBudgetResult> => {
        fake.writes.push({ campaignId: a.campaignId, dailyBudgetMinor: a.dailyBudgetMinor });
        return { outcome: 'updated', platform: a.platform, dailyBudgetMinor: a.dailyBudgetMinor, target: a.campaignId };
      },
    })),
  };
});

/** Meta ROAS 1.35, Google ROAS 3.9: `optimizeBudget` moves spend from Meta to Google. */
const PERFORMANCE_CSV = [
  'Platform,Campaign,Day,Cost,Impr.,Clicks,Conversions,Revenue',
  'Meta,A,2026-01-01,1000,10000,100,10,1500',
  'Meta,A,2026-01-02,1000,10000,40,8,1200',
  'Google,B,2026-01-01,1000,10000,100,40,4000',
  'Google,B,2026-01-02,1000,10000,90,38,3800',
].join('\n');

const SOLO_TENANT = 'default';
const SOLO = 'u-realloc-solo';
const REFUSED = { httpStatus: 403, details: { reason: 'autonomy_self_approval_refused' } };

let BASE = '';
let server: http.Server;
let storage: Storage;
let hostSuite: HostAdapterSuite;
let TENANT = '';
let operator = '';
let operatorUserId = '';
let approverUserId = '';
let editorUserId = '';
let orgA = '';
let soloOrg = '';

const setToggle = async (id: string, on: boolean): Promise<void> => {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
};
function cookieFor(userId: string, personalTenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}
async function post<T = Record<string, unknown>>(cookie: string, path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}
const decide = (tenantId: string, approvalId: string, decidedBy: string, humanSession = false) =>
  claimApproval({ storage, hostSuite }, { tenantId, decidedBy, ...(humanSession ? { decidedByHumanSession: true } : {}) }, approvalId);
const reject = (tenantId: string, approvalId: string, decidedBy: string) =>
  rejectApproval({ storage, hostSuite }, { tenantId, decidedBy }, approvalId);

/** One dispatched Meta + Google campaign under `orgId`, with live budgets and performance. */
async function seedClientCampaigns(tenantId: string, orgId: string, tag: string): Promise<void> {
  const campaign = await finalizeFromBrief(tenantId, await createBrief(tenantId, orgId, 'seed', { name: `Spring ${tag}`, channels: [] }), 'seed');
  const row = (platform: 'meta' | 'google', id: string): Record<string, unknown> => ({
    platform, platformCampaignId: id, platformAdSetId: 's', platformAdId: 'a', briefId: campaign.briefId, campaignId: campaign.id, orgId,
    adAccountId: platform === 'meta' ? 'act_1' : '1234567890', createdAt: '2026-11-01T00:00:00.000Z',
  });
  fake.ledger.set(tenantId, [...(fake.ledger.get(tenantId) ?? []), row('meta', `m-${tag}`), row('google', `g-${tag}`)]);
  fake.budgets.set(`m-${tag}`, 5000).set(`g-${tag}`, 2000);
  await importCsv(tenantId, orgId, PERFORMANCE_CSV);
}

/** Propose through the chat tool; returns the approval id. */
async function chatPropose(tenantId: string, actingUserId: string, orgId: string, runId: string): Promise<string> {
  const out = await createAgentToolProvider({ tenantId, actingUserId, runId }).executeTool({ name: CAMPAIGN_INTEL_PROPOSE_REALLOCATION_TOOL_ID, input: { orgId } });
  expect(out.isError, out.content).toBeFalsy();
  const body = JSON.parse(out.content) as { outcome: string; approvalId?: string };
  expect(body.outcome, out.content).toBe('proposed');
  if (!body.approvalId) throw new Error(`no approval: ${out.content}`);
  return body.approvalId;
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  hostSuite = app.locals.hostSuite as HostAdapterSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['campaign-orchestration', 'campaign-brief', 'campaign-intel']) await setToggle(id, true);
  // No ADR 0942 policy on these lanes: the approvers are the client org's owner or
  // admin, deterministically (the chokepoint answers `unbound`).
  if (getToggleDefault(AUTONOMY_TOGGLE)) await setToggle(AUTONOMY_TOGGLE, false);

  const ws = await createWorkspace({ name: 'Realloc Agency', ownerSubject: 'oidc:rsa-owner' });
  TENANT = ws.tenantId;
  const op = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:rsa-operator', source: 'oidc' });
  const ap = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:rsa-approver', source: 'oidc' });
  const ed = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:rsa-editor', source: 'oidc' });
  for (const [u, name] of [[op, 'Operator'], [ap, 'Approver'], [ed, 'Editor']] as const) {
    await createMember({ tenantId: TENANT, orgId: TENANT, subject: u.userId, displayName: name, roles: ['editor'] });
  }
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  // The operator is an ADMIN on the client, an approver in every other respect, so
  // each refusal below is separation of duties, never a missing role.
  await createMember({ tenantId: TENANT, orgId: orgA, subject: op.userId, displayName: 'Operator', roles: ['admin'] });
  await createMember({ tenantId: TENANT, orgId: orgA, subject: ap.userId, displayName: 'Approver', roles: ['admin'] });
  await createMember({ tenantId: TENANT, orgId: orgA, subject: ed.userId, displayName: 'Editor', roles: ['editor'] });
  operator = cookieFor(op.userId, 'ws:home-rsa-operator');
  operatorUserId = op.userId;
  approverUserId = ap.userId;
  editorUserId = ed.userId;
  await seedClientCampaigns(TENANT, orgA, 'a');

  // The sole-admin self-approval ADR — a client org whose ONLY member is its owner (the shape of
  // adr1131-sole-admin-self-approval.test.ts).
  soloOrg = (await createOrg({ tenantId: SOLO_TENANT, createdBy: SOLO, name: 'One-person firm', ownerSubject: SOLO })).orgId;
  await seedClientCampaigns(SOLO_TENANT, soloOrg, 'solo');
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 1022 CP71WF-23 — a reallocation proposer cannot approve their own plan', () => {
  let routeApprovalId = '';

  it('route: the approval names the client\'s approvers, and the proposer\'s vote is refused', async () => {
    const r = await post<{ outcome: string; plan?: { approvalId?: string; createdBy?: string } }>(operator, '/host/openwop-app/campaign-intel/reallocations/propose', { orgId: orgA });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.outcome, JSON.stringify(r.body)).toBe('proposed');
    routeApprovalId = r.body.plan?.approvalId ?? '';
    const approval = await getApproval(routeApprovalId);
    expect(approval).toMatchObject({ kind: 'campaign-spend', spendKind: 'reallocation', status: 'pending', orgId: orgA });
    expect(approval?.policy?.approverRoleRefs).toEqual(expect.arrayContaining(['owner', 'admin']));
    expect(approval?.submitters).toContain(operatorUserId);
    expect(approval?.autonomySourceRunId).toBeUndefined();

    await expect(decide(TENANT, routeApprovalId, operatorUserId)).rejects.toMatchObject(REFUSED);
    // Another admin exists, so the sole-admin exception does not apply.
    await expect(decide(TENANT, routeApprovalId, operatorUserId, true)).rejects.toMatchObject(REFUSED);
    expect((await getApproval(routeApprovalId))?.status).toBe('pending');
  });

  it('route: a non-requester without an approver role is refused; a different admin approves', async () => {
    expect(routeApprovalId).not.toBe('');
    await expect(decide(TENANT, routeApprovalId, editorUserId)).rejects.toMatchObject({ httpStatus: 403, details: { reason: 'autonomy_not_eligible' } });
    await decide(TENANT, routeApprovalId, approverUserId);
    expect((await getApproval(routeApprovalId))?.status).toBe('approved');
    expect(fake.writes).toEqual([]);
  });

  it('chat: the proposer\'s vote is refused, and a different admin approves (the chat run is not pinned as a source)', async () => {
    const approvalId = await chatPropose(TENANT, operatorUserId, orgA, 'chat-turn-rsa-1');
    const approval = await getApproval(approvalId);
    expect(approval?.policy?.approverRoleRefs).toEqual(expect.arrayContaining(['owner', 'admin']));
    expect(approval?.submitters).toContain(operatorUserId);
    expect(approval?.autonomySourceRunId).toBeUndefined();

    await expect(decide(TENANT, approvalId, operatorUserId)).rejects.toMatchObject(REFUSED);
    await expect(decide(TENANT, approvalId, operatorUserId, true)).rejects.toMatchObject(REFUSED);
    expect((await getApproval(approvalId))?.status).toBe('pending');
    await decide(TENANT, approvalId, approverUserId);
    expect((await getApproval(approvalId))?.status).toBe('approved');
  });

  it('a reject by the proposer is refused as well (named-approver rule, either direction); another admin rejects', async () => {
    const approvalId = await chatPropose(TENANT, operatorUserId, orgA, 'chat-turn-rsa-2');
    await expect(reject(TENANT, approvalId, operatorUserId)).rejects.toMatchObject(REFUSED);
    expect((await getApproval(approvalId))?.status).toBe('pending');
    await reject(TENANT, approvalId, approverUserId);
    expect((await getApproval(approvalId))?.status).toBe('rejected');
  });
});

describe('the sole-admin self-approval ADR — the sole admin may still approve their own reallocation', () => {
  it('the client\'s only admin approves from their own session, and the audit chain says sole_admin', async () => {
    const approvalId = await chatPropose(SOLO_TENANT, SOLO, soloOrg, 'chat-turn-rsa-solo');
    expect((await getApproval(approvalId))?.submitters).toContain(SOLO);
    // Not a person's own session: no exception.
    await expect(decide(SOLO_TENANT, approvalId, SOLO)).rejects.toMatchObject(REFUSED);
    expect((await getApproval(approvalId))?.status).toBe('pending');

    const before = (await listChain(SOLO_TENANT)).length;
    await decide(SOLO_TENANT, approvalId, SOLO, true);
    expect((await getApproval(approvalId))?.status).toBe('approved');
    const rows = (await listChain(SOLO_TENANT)).slice(before).filter((e) => e.kind === 'autonomy.self_approval.sole_admin');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ gateId: approvalId, surface: 'campaign-spend', decider: SOLO, orgId: soloOrg, reason: 'sole_admin', otherApprovers: 0 });
  });
});

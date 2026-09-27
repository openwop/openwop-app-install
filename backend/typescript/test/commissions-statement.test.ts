/**
 * Sales Commissions — Phase 2 (statement computation).
 * Unit: effectiveRate (accelerator selection) + periodContains (Q/month bounds).
 * Route: base computation over CRM won deals, cap scaling, subject-scoped reads.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { effectiveRate, periodContains } from '../src/features/sales-commissions/entities/statement.js';

describe('commissions — effectiveRate (accelerator selection)', () => {
  const rule = { basis: 'deal-won' as const, type: 'percentage' as const, rate: 5, accelerators: [{ attainmentGte: 100, rate: 8 }, { attainmentGte: 150, rate: 12 }] };
  it('uses base rate below the first threshold or when attainment unknown', () => {
    expect(effectiveRate(rule, undefined)).toBe(5);
    expect(effectiveRate(rule, 99)).toBe(5);
  });
  it('uses the highest-threshold accelerator the rep qualifies for', () => {
    expect(effectiveRate(rule, 100)).toBe(8);
    expect(effectiveRate(rule, 149)).toBe(8);
    expect(effectiveRate(rule, 200)).toBe(12);
  });
  it('a rule with no accelerators is always base rate', () => {
    expect(effectiveRate({ basis: 'deal-won', type: 'fixed', rate: 250 }, 300)).toBe(250);
  });
});

describe('commissions — periodContains', () => {
  it('matches YYYY-Qn quarters and YYYY-MM months', () => {
    expect(periodContains('2026-02-15', '2026-Q1')).toBe(true);
    expect(periodContains('2026-04-01', '2026-Q1')).toBe(false);
    expect(periodContains('2026-04-01', '2026-Q2')).toBe(true);
    expect(periodContains('2026-02-15', '2026-02')).toBe(true);
    expect(periodContains('2026-03-15', '2026-02')).toBe(false);
    expect(periodContains(undefined, '2026-Q1')).toBe(false);
    expect(periodContains('2025-12-31', '2026-Q1')).toBe(false);
  });
});

let BASE: string;
let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm', 'sales-commissions']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
async function scenario(): Promise<{ admin: Client; rep: Client; rep2: Client; orgId: string; repId: string; rep2Id: string }> {
  const tenantId = `org:comms-${Date.now()}-${n++}`;
  const admin = client();
  await admin.post('/v1/host/openwop-app/test/login', { email: `a-${Date.now()}-${n++}@acme.test`, tenantId });
  const rep = client();
  const repId = (await rep.post('/v1/host/openwop-app/test/login', { email: `r-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
  const rep2 = client();
  const rep2Id = (await rep2.post('/v1/host/openwop-app/test/login', { email: `r2-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
  const orgId = (await admin.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
  for (const [subject, who] of [[repId, 'rep'], [rep2Id, 'rep2']] as const) {
    await admin.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: who, subject, roles: ['editor'] });
  }
  return { admin, rep, rep2, orgId, repId, rep2Id };
}
const cbase = (orgId: string): string => `/v1/host/openwop-app/commissions/orgs/${encodeURIComponent(orgId)}`;
const crm = (orgId: string): string => `/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}`;

async function wonDeal(admin: Client, orgId: string, title: string, amount: number, owner: string, closeDate: string): Promise<void> {
  const d = await admin.post(`${crm(orgId)}/deals`, { title, amount, owner, closeDate, status: 'won' });
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  expect(d.body.status).toBe('won');
}

/** CFP-1 (D9) — approve a commission statement through the SHARED reviews gate
 *  (it is no longer a direct route mutation). The approve route now returns
 *  `202 { review: { approvalId } }`; this claims it in the reviews inbox so the
 *  draft→approved transition is applied exactly as before the gate. Returns the
 *  SUBMIT response verbatim when not 202 (403/404/409 preserved). */
async function approveStatementViaReview(c: Client, B: string, statementId: string): Promise<Res> {
  const submit = await c.post(`${B}/statements/${encodeURIComponent(statementId)}/approve`);
  if (submit.status !== 202) return submit;
  return c.post(`/v1/host/openwop-app/reviews/approval:${submit.body.review.approvalId}/actions/approve`);
}

describe('commissions — statement computation + subject-scoped reads', () => {
  it('computes commission over won deals at base rate; scopes reads to the rep', async () => {
    const { admin, rep, rep2, orgId, repId, rep2Id } = await scenario();
    const B = cbase(orgId);
    const plan = (await admin.post(`${B}/plans`, { name: 'AE 5%', currency: 'USD', assignment: { kind: 'rep', ref: repId }, effectiveFrom: '2026-01-01', rules: [{ basis: 'deal-won', type: 'percentage', rate: 5 }] })).body;
    await wonDeal(admin, orgId, 'W1', 1000, repId, '2026-02-10');
    await wonDeal(admin, orgId, 'W2', 2000, repId, '2026-03-01');
    await wonDeal(admin, orgId, 'Other-period', 5000, repId, '2026-05-01'); // Q2 — excluded
    await wonDeal(admin, orgId, 'Rep2', 9000, rep2Id, '2026-02-10'); // other rep — excluded

    const computed = await admin.post(`${B}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    expect(computed.status, JSON.stringify(computed.body)).toBe(201);
    expect(computed.body.lines).toHaveLength(2); // only repId's Q1 won deals
    expect(computed.body.total).toBeCloseTo(150); // (1000+2000) * 5%
    expect(computed.body.status).toBe('draft');

    // Subject-scoping: the rep sees only their own; rep2 sees none; admin sees all.
    expect((await rep.get(`${B}/statements`)).body.statements).toHaveLength(1);
    expect((await rep2.get(`${B}/statements`)).body.statements).toHaveLength(0);
    expect((await admin.get(`${B}/statements`)).body.statements).toHaveLength(1);
    // rep2 cannot read the rep's statement by id (no existence leak)
    expect((await rep2.get(`${B}/statements/${encodeURIComponent(computed.body.statementId)}`)).status).toBe(404);
    expect((await rep.get(`${B}/statements/${encodeURIComponent(computed.body.statementId)}`)).status).toBe(200);
    // a rep cannot compute (payout-affecting → manage-only)
    expect((await rep.post(`${B}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' })).status).toBe(403);
  });

  it('applies a per-rule cap by scaling lines', async () => {
    const { admin, orgId, repId } = await scenario();
    const B = cbase(orgId);
    const plan = (await admin.post(`${B}/plans`, { name: 'Capped', currency: 'USD', assignment: { kind: 'rep', ref: repId }, effectiveFrom: '2026-01-01', rules: [{ basis: 'deal-won', type: 'percentage', rate: 10, cap: 100 }] })).body;
    await wonDeal(admin, orgId, 'Big', 5000, repId, '2026-02-10'); // 10% = 500, capped to 100
    const s = (await admin.post(`${B}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' })).body;
    expect(s.total).toBeCloseTo(100);
  });

  it('refuses to delete a plan with approved/paid statements; cascades drafts (COMM-DATA-1)', async () => {
    const { admin, orgId, repId } = await scenario();
    const B = cbase(orgId);
    const mkPlan = async (): Promise<string> => (await admin.post(`${B}/plans`, { name: 'P', currency: 'USD', assignment: { kind: 'rep', ref: repId }, effectiveFrom: '2026-01-01', rules: [{ basis: 'deal-won', type: 'fixed', rate: 100 }] })).body.planId;
    await wonDeal(admin, orgId, 'D', 1000, repId, '2026-02-10');

    // Plan A: a DRAFT statement does NOT block deletion — it cascades away.
    const planA = await mkPlan();
    await admin.post(`${B}/plans/${planA}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    expect((await admin.del(`${B}/plans/${planA}`)).status).toBe(200);
    expect((await admin.get(`${B}/statements`)).body.statements.filter((s: any) => s.planId === planA)).toHaveLength(0); // draft cascaded

    // Plan B: an APPROVED statement BLOCKS deletion (payout record must survive) → 409.
    const planB = await mkPlan();
    const sid = (await admin.post(`${B}/plans/${planB}/statements/compute`, { subjectId: repId, period: '2026-Q1' })).body.statementId;
    await approveStatementViaReview(admin, B, sid); // draft→approved through the shared reviews gate
    const blocked = await admin.del(`${B}/plans/${planB}`);
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    // the approved statement is untouched
    expect((await admin.get(`${B}/statements/${encodeURIComponent(sid)}`)).body.status).toBe('approved');
  });

  it('enforces the draft → approved → paid state machine (P3)', async () => {
    const { admin, rep, orgId, repId } = await scenario();
    const B = cbase(orgId);
    const plan = (await admin.post(`${B}/plans`, { name: 'P', currency: 'USD', assignment: { kind: 'rep', ref: repId }, effectiveFrom: '2026-01-01', rules: [{ basis: 'deal-won', type: 'fixed', rate: 100 }] })).body;
    await wonDeal(admin, orgId, 'D', 1000, repId, '2026-02-10');
    const sid = (await admin.post(`${B}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' })).body.statementId;
    const S = `${B}/statements/${encodeURIComponent(sid)}`;

    // Cannot skip approval: draft → pay is a 409.
    expect((await admin.post(`${S}/pay`)).status).toBe(409);
    // CFP-1 (D9): a rep cannot even SUBMIT for approval (manage-only) → 403.
    expect((await rep.post(`${S}/approve`)).status).toBe(403);
    // Approval rides the SHARED reviews gate: submitting returns a pending review;
    // the statement stays DRAFT until a manager claims it (no naked mutation).
    const submit = await admin.post(`${S}/approve`);
    expect(submit.status, JSON.stringify(submit.body)).toBe(202);
    expect((await admin.get(S)).body.status).toBe('draft'); // not applied until the gate resolves
    const decide = await admin.post(`/v1/host/openwop-app/reviews/approval:${submit.body.review.approvalId}/actions/approve`);
    expect(decide.status, JSON.stringify(decide.body)).toBe(200);
    expect(decide.body.status).toBe('approved');
    // The applied effect: statement approved + approver stamped, through the gate.
    const afterApprove = await admin.get(S);
    expect(afterApprove.body.status).toBe('approved');
    expect(afterApprove.body.approvedBy).toBeTruthy();
    // Re-submitting approve on a non-draft statement is refused (409).
    expect((await admin.post(`${S}/approve`)).status).toBe(409);
    // Now pay; then recompute is refused (409 — a paid statement is frozen).
    expect((await admin.post(`${S}/pay`)).body.status).toBe('paid');
    expect((await admin.post(`${B}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' })).status).toBe(409);
  });
});

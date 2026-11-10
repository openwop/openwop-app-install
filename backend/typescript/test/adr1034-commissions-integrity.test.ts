/**
 * ADR 1034 — sales-commissions money and gate integrity (feature loop row 75).
 *
 *  - D7  money is integer minor units: `Math.round(1.005 * 100)` is 100, so the old float
 *        conversion itself misrounded; a capped rule's rounded lines could sum past the cap.
 *  - D4  a deal pays at most once per plan: a `YYYY-MM` and a `YYYY-Qn` statement of one
 *        plan both included it, each approvable; overlapping plans for one assignment.
 *  - D5  the review card pins what drives the money (attainment + lines), not only the total.
 *  - D6  recompute is a CAS: an approval landing between its read and its write was
 *        overwritten by a draft at a new total.
 *  - D8  self-approval / self-pay match across subject spellings; erasure re-keys uniquely.
 *  - D11 a rep sees team plans and their own, never another rep's.
 *
 * Red when: a money conversion multiplies floats; the cap allocation is a float rescale;
 * a second statement of the same plan can approve an already-paid deal (by claim or, for
 * pre-claim rows, by the legacy scan); the deal conflict reopens the card instead of
 * closing it; plan overlap is not refused; the pin ignores the lines or accepts an
 * old-shape pin; recompute is a plain put; a self check compares raw strings; two erased
 * reps collide; another rep's plan is listed or readable.
 *
 * Recorded guards (grade-tests w88):
 *  - "A second statement cannot approve a paid deal" is held three ways. The decide
 *    pre-check and `approveStatement` both call `findDealConflicts`, which runs a legacy
 *    scan plus a claims loop, and `approveStatement` then refuses on `claimDeals`
 *    `heldElsewhere`. The legacy scan, the claims loop and the PAY gate are each
 *    witnessed alone. The approve-time `heldElsewhere` branch is defence in depth that
 *    no case reaches.
 *  - The pin's `lineDigest !== undefined` is an equivalent mutant, because an
 *    undefined digest never equals a real one. The old-shape case is held by the
 *    equality as well.
 * The cap allocation is also checked on an ASYMMETRIC fixture. Equal remainders cannot
 * tell largest-remainder order from index order.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { toMinor, lineCommissionMinor, allocateCap } from '../src/features/sales-commissions/entities/money.js';
import { approveStatement, computeStatement, getStatementRaw, markStatementPaid, listStatements, type CommissionStatement } from '../src/features/sales-commissions/entities/statement.js';
import { deletePlanClaims, dealClaimId, claimDeals } from '../src/features/sales-commissions/entities/dealClaims.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { lineDigest, pinMatches } from '../src/features/sales-commissions/pin.js';
import { getApproval } from '../src/host/approvalService.js';

let BASE: string;
let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm', 'sales-commissions', 'territories']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Line { dealId: string; rate: number; commission: number; commissionMinor?: number }
interface Body {
  user?: { userId: string }; orgId?: string; planId?: string; statementId?: string; total?: number; totalMinor?: number; status?: string;
  lines?: Line[]; excludedDeals?: Array<{ dealId: string; period: string }>; dealId?: string;
  review?: { approvalId: string; status: string }; plans?: Array<{ planId: string }>; canManage?: boolean;
  statements?: Array<{ statementId: string; review?: { status: string; superseded: boolean } }>;
  error?: string; message?: string; details?: Record<string, unknown>;
}
interface Res { status: number; body: Body }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    return { status: res.status, body: (res.status === 204 ? {} : await res.json().catch(() => ({}))) as Body };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

let n = 0;
async function scenario(): Promise<{ admin: Client; adminId: string; rep: Client; repId: string; rep2Id: string; orgId: string; tenantId: string }> {
  const tenantId = `org:adr1034c-${Date.now()}-${n++}`;
  const admin = client();
  const adminId = (await admin.post('/host/openwop-app/test/login', { email: `a-${Date.now()}-${n++}@acme.test`, tenantId })).body.user?.userId ?? '';
  const rep = client();
  const repId = (await rep.post('/host/openwop-app/test/login', { email: `r-${Date.now()}-${n++}@acme.test`, tenantId })).body.user?.userId ?? '';
  const rep2 = client();
  const rep2Id = (await rep2.post('/host/openwop-app/test/login', { email: `s-${Date.now()}-${n++}@acme.test`, tenantId })).body.user?.userId ?? '';
  const orgId = (await admin.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId ?? '';
  for (const [subject, name] of [[repId, 'Rita'], [rep2Id, 'Sam']] as const) {
    await admin.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: name, subject, roles: ['editor'] });
  }
  return { admin, adminId, rep, repId, rep2Id, orgId, tenantId };
}
const cbase = (orgId: string): string => `/host/openwop-app/commissions/orgs/${encodeURIComponent(orgId)}`;
const wonDeal = async (admin: Client, orgId: string, title: string, amount: number, owner: string, closeDate: string): Promise<string> => {
  const d = await admin.post(`/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/deals`, { title, amount, owner, closeDate, status: 'won', currency: 'USD' });
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  return d.body.dealId ?? '';
};
const mkPlan = async (admin: Client, orgId: string, over: Record<string, unknown>): Promise<string> => {
  const res = await admin.post(`${cbase(orgId)}/plans`, { name: 'Plan', currency: 'USD', effectiveFrom: '2026-01-01', rules: [{ basis: 'deal-won', type: 'percentage', rate: 5 }], ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.planId ?? '';
};
const compute = (admin: Client, orgId: string, planId: string, subjectId: string, period: string): Promise<Res> =>
  admin.post(`${cbase(orgId)}/plans/${planId}/statements/compute`, { subjectId, period });
const submit = (c: Client, orgId: string, statementId: string): Promise<Res> => c.post(`${cbase(orgId)}/statements/${encodeURIComponent(statementId)}/approve`);
const decide = (c: Client, approvalId: string, verb: 'approve' | 'reject' = 'approve'): Promise<Res> => c.post(`/host/openwop-app/reviews/approval:${approvalId}/actions/${verb}`);

describe('D7 — money in integer minor units', () => {
  it('converts a decimal amount exactly where float multiplication misrounds', () => {
    expect(Math.round(1.005 * 100)).toBe(100); // the defect, measured
    expect(toMinor(1.005, 'USD', 'amount')).toBe(101n);
    expect(toMinor(1234.5, 'JPY', 'amount')).toBe(1235n); // exponent 0
    expect(toMinor(1.2345, 'KWD', 'amount')).toBe(1235n); // exponent 3 → 1.235
    expect(toMinor(1e-7, 'USD', 'amount')).toBe(0n); // exponent-form input still parses
  });
  it('rounds a half-minor-unit commission half away from zero', () => {
    // 0.15 × 50% = 0.075 → 0.08. The old path: 0.15*50/100 = 0.075 → Math.round(7.4999…) = 7.
    expect(lineCommissionMinor('percentage', 15n, 50, 'USD')).toBe(8n);
    expect(lineCommissionMinor('fixed', 0n, 12.5, 'USD')).toBe(1250n);
  });
  it('allocates a cap by largest remainder, so capped lines sum to the cap exactly', () => {
    const lines = allocateCap([1000n, 1000n, 1000n], 2000n); // three $10 lines capped at $20
    expect(lines.reduce((a, v) => a + v, 0n)).toBe(2000n);
    expect(lines).toEqual([667n, 667n, 666n]);
    // Unequal remainders (by hand: floors 33/83/216 = 332, remainders 300/250/450 → the
    // one leftover unit goes to index 2). Index order would give [34n, 83n, 216n].
    expect(allocateCap([100n, 250n, 650n], 333n)).toEqual([33n, 83n, 217n]);
  });
  it('a statement stores exact minor units and its total equals its lines', async () => {
    const { admin, repId, orgId } = await scenario();
    const planId = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId }, rules: [{ basis: 'deal-won', type: 'percentage', rate: 10, cap: 20 }] });
    for (const t of ['a', 'b', 'c']) await wonDeal(admin, orgId, t, 100, repId, '2026-02-10');
    const st = (await compute(admin, orgId, planId, repId, '2026-Q1')).body;
    // The float rescale stored 6.67 × 3 = 20.01, one cent past the cap it was scaled to honour.
    expect(st.total).toBe(20);
    expect(st.totalMinor).toBe(2000);
    expect((st.lines ?? []).map((l) => l.commissionMinor).sort()).toEqual([666, 667, 667]);
  });
  it('refuses a won deal with a negative amount (a credit is a clawback, which is deferred)', async () => {
    const { admin, repId, orgId } = await scenario();
    const planId = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    await wonDeal(admin, orgId, 'neg', -50, repId, '2026-02-10');
    const res = await compute(admin, orgId, planId, repId, '2026-Q1');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/negative amount/);
  });
});

describe('D4 — a deal pays at most once per plan', () => {
  it('a monthly and a quarterly statement of one plan cannot both pay the same deal', async () => {
    const { admin, repId, orgId, tenantId } = await scenario();
    const planId = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    const dealId = await wonDeal(admin, orgId, 'Feb deal', 1000, repId, '2026-02-10');
    const month = (await compute(admin, orgId, planId, repId, '2026-02')).body;
    const quarter = (await compute(admin, orgId, planId, repId, '2026-Q1')).body;
    expect(month.total).toBe(50);
    expect(quarter.total).toBe(50); // both drafts include the deal before either is approved

    const monthCard = (await submit(admin, orgId, month.statementId ?? '')).body.review?.approvalId ?? '';
    const quarterCard = (await submit(admin, orgId, quarter.statementId ?? '')).body.review?.approvalId ?? '';
    expect((await decide(admin, monthCard)).status).toBe(200);

    // The quarterly approval is refused BY NAME, and its card is CLOSED (not reopened into a
    // card no approve can ever clear).
    const refused = await decide(admin, quarterCard);
    expect(refused.status).toBe(409);
    // (Error `details` are entropy-scrubbed on the wire, so the deal id reads redacted there;
    // the period and the count are what the reviewer gets.)
    expect(refused.body.details).toMatchObject({ reason: 'deal_already_committed', deals: [{ period: '2026-02' }] });
    expect(JSON.stringify(refused.body.details)).not.toContain(repId); // no statement id (it embeds the rep)
    expect((await getApproval(quarterCard))?.status).toBe('rejected');
    // The list tells the console what happened (grade-ux H5): Recompute, not Submit again.
    const listed = (await admin.get(`${cbase(orgId)}/statements`)).body;
    expect((listed.statements ?? []).find((r) => r.statementId === quarter.statementId)?.review).toEqual({ status: 'rejected', superseded: true });
    expect((listed.statements ?? []).find((r) => r.statementId === month.statementId)?.review).toBeUndefined(); // approved: its status says it
    const again2 = await decide(admin, quarterCard);
    expect([again2.status, again2.body.message]).toEqual([422, "Action 'approve' is not available for this review."]); // a closed card offers no approve
    expect((await getStatementRaw(tenantId, orgId, quarter.statementId ?? ''))?.status).toBe('draft');

    // A recompute leaves the paid deal off, and says so.
    const again = (await compute(admin, orgId, planId, repId, '2026-Q1')).body;
    expect(again.total).toBe(0);
    expect(again.excludedDeals).toEqual([{ dealId, period: '2026-02' }]);
    // …and once recomputed, the closed review no longer pins the row: Submit comes back
    // (the closing-pass Blocker — recompute mints no card, so "superseded" used to stick).
    const after = (await admin.get(`${cbase(orgId)}/statements`)).body;
    expect((after.statements ?? []).find((r) => r.statementId === quarter.statementId)?.review).toBeUndefined();
  });

  it('the choke point is approveStatement itself, and pre-claim approved rows still count', async () => {
    const { admin, adminId, repId, orgId, tenantId } = await scenario();
    const planId = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    await wonDeal(admin, orgId, 'Feb deal', 1000, repId, '2026-02-10');
    const month = await computeStatement(tenantId, orgId, planId, repId, '2026-02');
    const quarter = await computeStatement(tenantId, orgId, planId, repId, '2026-Q1');
    await approveStatement(tenantId, orgId, month.statementId, adminId); // the seeder's lane: no card at all
    await expect(approveStatement(tenantId, orgId, quarter.statementId, adminId)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'deal_already_committed' } });
    // Drop the claims: an approved row written before claims existed must still block it.
    await deletePlanClaims(tenantId, orgId, planId);
    await expect(approveStatement(tenantId, orgId, quarter.statementId, adminId)).rejects.toMatchObject({ details: { reason: 'deal_already_committed' } });
    expect((await getStatementRaw(tenantId, orgId, quarter.statementId))?.status).toBe('draft');
  });

  it('refuses a second plan for the same assignment over an overlapping window', async () => {
    const { admin, repId, orgId } = await scenario();
    await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId }, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' });
    const clash = await admin.post(`${cbase(orgId)}/plans`, { name: 'Overlap', currency: 'USD', assignment: { kind: 'rep', ref: repId }, effectiveFrom: '2026-06-01', rules: [{ basis: 'deal-won', type: 'percentage', rate: 5 }] });
    expect(clash.status).toBe(409);
    expect(clash.body.details).toMatchObject({ reason: 'plan_window_overlap' });
    // A window that does not overlap, and a different assignment, are both fine.
    const later = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId }, effectiveFrom: '2026-07-01' });
    await mkPlan(admin, orgId, { assignment: { kind: 'role', ref: 'ae' }, effectiveFrom: '2026-01-01' });
    // …and an update that moves a plan INTO an overlap is refused too.
    const moved = await admin.patch(`${cbase(orgId)}/plans/${later}`, { effectiveFrom: '2026-03-01' });
    expect(moved.status).toBe(409);
    expect(moved.body.details).toMatchObject({ reason: 'plan_window_overlap' });
  });
});

describe('D4 — the claim lifecycle (grade-code B1/H1)', () => {
  it('the claim key carries no NUL byte (Postgres TEXT cannot store one) and is unambiguous', () => {
    expect(dealClaimId('commplan:a', 'deal:b')).not.toMatch(/\u0000/);
    expect(dealClaimId('a|1', 'b')).not.toBe(dealClaimId('a', '1|b'));
  });

  it('PAY holds the claims: two approved statements of one plan cannot both be paid for one deal', async () => {
    const { admin, adminId, repId, orgId, tenantId } = await scenario();
    const planId = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    await wonDeal(admin, orgId, 'Feb deal', 1000, repId, '2026-02-10');
    const month = await computeStatement(tenantId, orgId, planId, repId, '2026-02');
    const quarter = await computeStatement(tenantId, orgId, planId, repId, '2026-Q1');
    // Both rows approved with no claims at all — the shape a pre-claim legacy row or a
    // lost claim leaves behind, written straight to storage.
    for (const st of [month, quarter]) {
      await hostExtStorage().kvSet(`hostext:commissions:commission-statement:${st.statementId}`, JSON.stringify({ ...st, status: 'approved', approvedBy: 'someone' }));
    }
    await deletePlanClaims(tenantId, orgId, planId);
    expect((await markStatementPaid(tenantId, orgId, month.statementId, adminId)).status).toBe('paid');
    await expect(markStatementPaid(tenantId, orgId, quarter.statementId, adminId)).rejects.toMatchObject({ details: { reason: 'deal_already_committed' } });
    expect((await getStatementRaw(tenantId, orgId, quarter.statementId))?.status).toBe('approved');
  });

  it('a rejected review frees its deals; a recompute frees deals the draft dropped', async () => {
    const { admin, repId, orgId, tenantId } = await scenario();
    const planId = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    const dealId = await wonDeal(admin, orgId, 'Feb deal', 1000, repId, '2026-02-10');
    const quarter = (await compute(admin, orgId, planId, repId, '2026-Q1')).body;
    // A failed approval attempt left the quarter holding the deal.
    await claimDeals(tenantId, orgId, planId, quarter.statementId ?? '', [dealId], new Date().toISOString());
    expect((await compute(admin, orgId, planId, repId, '2026-02')).body.excludedDeals).toEqual([{ dealId, period: '2026-Q1' }]);
    // Rejecting the quarter's review releases it…
    const card = (await submit(admin, orgId, quarter.statementId ?? '')).body.review?.approvalId ?? '';
    expect((await decide(admin, card, 'reject')).status).toBe(200);
    expect((await compute(admin, orgId, planId, repId, '2026-02')).body.excludedDeals).toBeUndefined();
    // …and a recompute that drops the deal releases it too.
    await claimDeals(tenantId, orgId, planId, quarter.statementId ?? '', [dealId], new Date().toISOString());
    await admin.patch(`/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/deals/${dealId}`, { closeDate: '2026-05-10' });
    expect((await compute(admin, orgId, planId, repId, '2026-Q1')).body.total).toBe(0);
    expect((await compute(admin, orgId, planId, repId, '2026-05')).body.excludedDeals).toBeUndefined();
  });
});

describe('D5 — the pin covers what drives the money', () => {
  const base = (): CommissionStatement => ({
    statementId: 'p:s:2026-Q1', tenantId: 't', orgId: 'o', subjectId: 's', period: '2026-Q1', planId: 'p', currency: 'USD',
    lines: [{ dealId: 'd1', dealAmount: 100, rate: 5, commission: 5, dealAmountMinor: 10000, commissionMinor: 500 }],
    total: 5, totalMinor: 500, attainmentPct: 80, status: 'draft', computedAt: 'x', updatedAt: 'x',
  });
  it('a change to the lines or the attainment is stale even when the total is the same', () => {
    const s = base();
    const pin = { statementId: s.statementId, subjectId: s.subjectId, period: s.period, total: 5, currency: 'USD', attainmentPct: 80, lineDigest: lineDigest(s) };
    expect(pinMatches(pin, s)).toBe(true);
    // Same total, different rate and deal: a different statement.
    expect(pinMatches(pin, { ...s, lines: [{ dealId: 'd2', dealAmount: 50, rate: 10, commission: 5, dealAmountMinor: 5000, commissionMinor: 500 }] })).toBe(false);
    expect(pinMatches(pin, { ...s, attainmentPct: 120 })).toBe(false);
    // A card minted before the pin grew cannot vouch for the lines.
    expect(pinMatches({ ...pin, lineDigest: undefined }, s)).toBe(false);
  });
});

describe('D6 — recompute is a CAS, so it cannot overwrite a concurrent approval', () => {
  it('an approval landing between the recompute read and its write wins, and the recompute is a 409', async () => {
    const { admin, adminId, repId, orgId, tenantId } = await scenario();
    const planId = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    await wonDeal(admin, orgId, 'W', 1000, repId, '2026-02-10');
    const draft = await computeStatement(tenantId, orgId, planId, repId, '2026-Q1');
    // Count computeStatement's reads of this row in a dry run, so the real run can fire on
    // the LAST one — the read its write compares against (earlier ones are list scans).
    const realGet = DurableCollection.prototype.get;
    let reads = 0;
    const counter = vi.spyOn(DurableCollection.prototype, 'get').mockImplementation(async function (this: DurableCollection<unknown>, id: string) {
      if (id === draft.statementId) reads += 1;
      return realGet.call(this, id);
    });
    try { await computeStatement(tenantId, orgId, planId, repId, '2026-Q1'); } finally { counter.mockRestore(); }
    expect(reads).toBeGreaterThan(0);
    let seen = 0;
    let armed = true;
    const spy = vi.spyOn(DurableCollection.prototype, 'get').mockImplementation(async function (this: DurableCollection<unknown>, id: string) {
      const row = await realGet.call(this, id);
      if (armed && id === draft.statementId && ++seen === reads) {
        armed = false;
        await approveStatement(tenantId, orgId, draft.statementId, adminId); // lands in the gap
      }
      return row;
    });
    try {
      const e = await computeStatement(tenantId, orgId, planId, repId, '2026-Q1').catch((x: unknown) => x);
      // The CAS's own refusal — not the approved-status refusal, which would mean the
      // approval landed BEFORE the read and this witnessed nothing.
      expect(e).toMatchObject({ code: 'conflict', message: 'This statement changed while it was being recomputed. Reload and try again.' });
    } finally {
      spy.mockRestore();
    }
    expect(armed).toBe(false); // the interleaving really happened
    expect((await getStatementRaw(tenantId, orgId, draft.statementId))?.status).toBe('approved');
  });
});

describe('D8 — identity and erasure', () => {
  it('self-approval and self-pay are refused across subject spellings', async () => {
    const { admin, adminId, orgId, tenantId } = await scenario();
    // A deal owner stored as the `user:` scope of the admin's own id.
    const selfRef = `user:${adminId}`;
    const planId = await mkPlan(admin, orgId, { assignment: { kind: 'role', ref: 'ae' } });
    await wonDeal(admin, orgId, 'mine', 1000, selfRef, '2026-02-10');
    const st = (await compute(admin, orgId, planId, selfRef, '2026-Q1')).body;
    const card = (await submit(admin, orgId, st.statementId ?? '')).body.review?.approvalId ?? '';
    const res = await decide(admin, card);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('You cannot approve your own commission statement.');
    // The entity lane refuses self-pay the same way.
    await approveStatement(tenantId, orgId, st.statementId ?? '', 'someone-else');
    await expect(markStatementPaid(tenantId, orgId, st.statementId ?? '', adminId)).rejects.toMatchObject({ message: 'You cannot mark your own commission statement paid.' });
  });

  it('erasing two reps who share a plan and period keeps both payout records', async () => {
    const { admin, adminId, repId, rep2Id, orgId, tenantId } = await scenario();
    const planId = await mkPlan(admin, orgId, { assignment: { kind: 'role', ref: 'ae' } });
    await wonDeal(admin, orgId, 'r1', 1000, repId, '2026-02-10');
    await wonDeal(admin, orgId, 'r2', 2000, rep2Id, '2026-02-11');
    for (const subject of [repId, rep2Id]) {
      const st = await computeStatement(tenantId, orgId, planId, subject, '2026-Q1');
      await approveStatement(tenantId, orgId, st.statementId, adminId);
    }
    await eraseSubject(tenantId, repId);
    await eraseSubject(tenantId, rep2Id);
    const rows = (await listStatements(tenantId, orgId, { planId }, true, undefined));
    expect(rows).toHaveLength(2); // the second erasure used to overwrite the first rep's row
    expect(rows.map((r) => r.total).sort((a, b) => a - b)).toEqual([50, 100]);
    expect(rows.every((r) => r.status === 'approved' && !r.statementId.includes(repId) && !r.statementId.includes(rep2Id))).toBe(true);
    expect(new Set(rows.map((r) => r.statementId)).size).toBe(2);
  });
});

describe('D8 — erasure survives a lost CAS (grade-code H2)', () => {
  it('a concurrent write that beats the delete is retried, never left as a second, un-erased row', async () => {
    const { admin, adminId, repId, orgId, tenantId } = await scenario();
    const planId = await mkPlan(admin, orgId, { assignment: { kind: 'role', ref: 'ae' } });
    await wonDeal(admin, orgId, 'r1', 1000, repId, '2026-02-10');
    const st = await computeStatement(tenantId, orgId, planId, repId, '2026-Q1');
    let raced = false;
    const realDel = DurableCollection.prototype.compareAndDelete;
    const spy = vi.spyOn(DurableCollection.prototype, 'compareAndDelete').mockImplementation(async function (this: DurableCollection<unknown>, expected: unknown) {
      if (!raced && (expected as { statementId?: string }).statementId === st.statementId) {
        raced = true;
        await approveStatement(tenantId, orgId, st.statementId, adminId); // lands first
      }
      return realDel.call(this, expected);
    });
    try { await eraseSubject(tenantId, repId); } finally { spy.mockRestore(); }
    expect(raced).toBe(true);
    const rows = await listStatements(tenantId, orgId, { planId }, true, undefined);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.statementId).not.toContain(repId);
    expect(rows[0]!.status).toBe('approved'); // the concurrent approval survived the erasure
  });
});

describe('closing re-grade — stale cards, lost claim repoints, a failed post-approve release', () => {
  it('a resubmit after a recompute closes the old card, and the stale card cannot approve', async () => {
    const { admin, repId, orgId, tenantId } = await scenario();
    const planId = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    await wonDeal(admin, orgId, 'a', 1000, repId, '2026-02-10');
    const st = (await compute(admin, orgId, planId, repId, '2026-Q1')).body;
    const stale = (await submit(admin, orgId, st.statementId ?? '')).body.review?.approvalId ?? '';
    await wonDeal(admin, orgId, 'b', 1000, repId, '2026-02-11');
    expect((await compute(admin, orgId, planId, repId, '2026-Q1')).body.total).toBe(100);
    const fresh = (await submit(admin, orgId, st.statementId ?? '')).body.review?.approvalId ?? '';
    expect(fresh).not.toBe(stale);
    expect((await getApproval(stale))?.status).toBe('rejected'); // closed on resubmit
    const staleAgain = await decide(admin, stale);
    expect([staleAgain.status, staleAgain.body.message]).toEqual([422, "Action 'approve' is not available for this review."]); // a closed card offers no approve
    expect((await getStatementRaw(tenantId, orgId, st.statementId ?? ''))?.status).toBe('draft');
    expect((await decide(admin, fresh)).status).toBe(200);
    expect((await getStatementRaw(tenantId, orgId, st.statementId ?? ''))?.status).toBe('approved');
  });

  it('a stale card that was never closed (pin no longer matches) is refused too', async () => {
    const { admin, repId, orgId, tenantId } = await scenario();
    const planId = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    await wonDeal(admin, orgId, 'a', 1000, repId, '2026-02-10');
    const st = (await compute(admin, orgId, planId, repId, '2026-Q1')).body;
    const card = (await submit(admin, orgId, st.statementId ?? '')).body.review?.approvalId ?? '';
    await wonDeal(admin, orgId, 'b', 1000, repId, '2026-02-11');
    await compute(admin, orgId, planId, repId, '2026-Q1'); // recomputed, NOT resubmitted
    expect((await decide(admin, card)).status).toBe(409);
    expect((await getStatementRaw(tenantId, orgId, st.statementId ?? ''))?.status).toBe('draft');
  });

  it('erasure re-points a claim even when a concurrent write beats its first CAS, so the payout stays payable', async () => {
    const { admin, adminId, repId, orgId, tenantId } = await scenario();
    const planId = await mkPlan(admin, orgId, { assignment: { kind: 'role', ref: 'ae' } });
    await wonDeal(admin, orgId, 'a', 1000, repId, '2026-02-10');
    const st = await computeStatement(tenantId, orgId, planId, repId, '2026-Q1');
    await approveStatement(tenantId, orgId, st.statementId, adminId);
    let raced = false;
    const realCas = DurableCollection.prototype.compareAndSwap;
    const spy = vi.spyOn(DurableCollection.prototype, 'compareAndSwap').mockImplementation(async function (this: DurableCollection<unknown>, expected: unknown, next: unknown) {
      const e = expected as { claimId?: string; statementId?: string } | null;
      const nx = next as { statementId?: string };
      if (!raced && e?.claimId && e.statementId === st.statementId && nx.statementId !== st.statementId) {
        raced = true; // a concurrent writer touches the claim row first
        await hostExtStorage().kvSet(`hostext:commissions:deal-claim:${e.claimId}`, JSON.stringify({ ...e, at: 'concurrently-touched' }));
      }
      return realCas.call(this, expected, next);
    });
    try { await eraseSubject(tenantId, repId); } finally { spy.mockRestore(); }
    expect(raced).toBe(true);
    const [row] = await listStatements(tenantId, orgId, { planId }, true, undefined);
    expect(row!.statementId).not.toContain(repId);
    // The claim followed the statement, so the payout can still be released.
    expect((await markStatementPaid(tenantId, orgId, row!.statementId, adminId)).status).toBe('paid');
  });

  it('a failed claim release after the approval flips logs and does not reopen the card', async () => {
    const { admin, repId, orgId, tenantId } = await scenario();
    const planId = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    await wonDeal(admin, orgId, 'a', 1000, repId, '2026-02-10');
    const st = (await compute(admin, orgId, planId, repId, '2026-Q1')).body;
    const card = (await submit(admin, orgId, st.statementId ?? '')).body.review?.approvalId ?? '';
    let flipped = false;
    let threw = false;
    const realCas = DurableCollection.prototype.compareAndSwap;
    const realList = DurableCollection.prototype.listForTenantIndexed;
    const casSpy = vi.spyOn(DurableCollection.prototype, 'compareAndSwap').mockImplementation(async function (this: DurableCollection<unknown>, expected: unknown, next: unknown) {
      const ok = await realCas.call(this, expected, next);
      if (ok && (next as { status?: string; statementId?: string }).status === 'approved' && (next as { statementId?: string }).statementId === st.statementId) flipped = true;
      return ok;
    });
    const listSpy = vi.spyOn(DurableCollection.prototype, 'listForTenantIndexed').mockImplementation(async function (this: DurableCollection<unknown>, t: string) {
      if (flipped && !threw) { threw = true; throw new Error('storage down'); }
      return realList.call(this, t);
    });
    let res: { status: number };
    try { res = await decide(admin, card); } finally { casSpy.mockRestore(); listSpy.mockRestore(); }
    expect(threw).toBe(true);
    expect(res.status).toBe(200);
    expect((await getStatementRaw(tenantId, orgId, st.statementId ?? ''))?.status).toBe('approved');
    expect((await getApproval(card))?.status).toBe('approved'); // not reopened
  });
});

describe('D11 — plan visibility', () => {
  it('a rep sees team plans and their own, never another rep’s', async () => {
    const { admin, rep, repId, rep2Id, orgId } = await scenario();
    const team = await mkPlan(admin, orgId, { assignment: { kind: 'role', ref: 'ae' } });
    const own = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    const other = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: rep2Id } });
    const listed = await rep.get(`${cbase(orgId)}/plans`);
    expect((listed.body.plans ?? []).map((p) => p.planId).sort()).toEqual([team, own].sort());
    expect(listed.body.canManage).toBe(false);
    expect((await rep.get(`${cbase(orgId)}/plans/${other}`)).status).toBe(404);
    expect((await rep.get(`${cbase(orgId)}/plans/${own}`)).status).toBe(200);
    const adminView = await admin.get(`${cbase(orgId)}/plans`);
    expect(adminView.body.plans).toHaveLength(3);
    expect(adminView.body.canManage).toBe(true);
  });
});

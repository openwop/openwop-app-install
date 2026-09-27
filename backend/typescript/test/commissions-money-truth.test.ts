/**
 * Sales Commissions ROUND 2 (UX_UPGRADE-sales-commissions, pass 2) — the seams where a
 * PAYOUT record stated something it could not know.
 *
 * Round 1 fixed a failed read that said "nobody is owed", and confirmed mark-paid. It
 * audited the currency SYMBOL and never the number under it, and it never touched the
 * money-truth transitions:
 *
 *  - COM2-B1  a statement summed deals across currencies and stamped the plan's on it
 *  - COM2-B2  attainment double-counted `won` up the territory hierarchy
 *  - COM2-B3  …and recomputed the ratio territories itself refuses to state
 *  - COM2-B4  the reviewer approved a total that could change after they saw it
 *  - COM2-B5  `assignment` ("who a plan pays") was never read: any plan paid any rep
 *  - COM2-M1  no quantisation: a JPY plan stored 6172.835 yen
 *  - COM2-M2  the plan's effective window was validated and never applied
 *  - COM2-M6  a recompute silently reverted an APPROVED statement and dropped its approver
 *  - COM2-M7  mark-paid recorded neither payer nor time
 *  - COM2-M9  no subject eraser over four subject-keyed fields
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { eraseSubject } from '../src/host/subjectErasure.js';

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

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
async function scenario(): Promise<{ admin: Client; repId: string; orgId: string; tenantId: string }> {
  const tenantId = `org:com2-${Date.now()}-${n++}`;
  const admin = client();
  await admin.post('/v1/host/openwop-app/test/login', { email: `a-${Date.now()}-${n++}@acme.test`, tenantId });
  const rep = client();
  const repId = (await rep.post('/v1/host/openwop-app/test/login', { email: `r-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
  const orgId = (await admin.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
  await admin.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'rep', subject: repId, roles: ['editor'] });
  return { admin, repId, orgId, tenantId };
}
const cbase = (orgId: string): string => `/v1/host/openwop-app/commissions/orgs/${encodeURIComponent(orgId)}`;
const crm = (orgId: string): string => `/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}`;

const wonDeal = async (admin: Client, orgId: string, title: string, amount: number, owner: string, closeDate: string, currency?: string): Promise<void> => {
  const d = await admin.post(`${crm(orgId)}/deals`, { title, amount, owner, closeDate, status: 'won', ...(currency ? { currency } : {}) });
  expect(d.status, JSON.stringify(d.body)).toBe(201);
};
const mkPlan = async (admin: Client, orgId: string, over: Record<string, unknown> = {}): Promise<any> => {
  const res = await admin.post(`${cbase(orgId)}/plans`, {
    name: 'AE 5%', currency: 'USD', effectiveFrom: '2026-01-01',
    rules: [{ basis: 'deal-won', type: 'percentage', rate: 5 }], ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};

describe('COM2-B1 — a payout record is denominated, or it does not exist', () => {
  it('refuses to compute across currencies, and names the deals', async () => {
    const { admin, repId, orgId } = await scenario();
    const plan = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    // The sums added raw `d.amount` and never read `d.currency`, then stamped the PLAN's
    // currency on the result: ¥100,000 + $20,000 at 5% became "$6,000", a figure that is
    // not a quantity of anything — shown to the rep, served to the agent verbatim, and
    // frozen onto an approval card. CRM's own report service refuses this shape already.
    await wonDeal(admin, orgId, 'JPY deal', 100_000, repId, '2026-02-10', 'JPY');
    await wonDeal(admin, orgId, 'USD deal', 20_000, repId, '2026-02-11', 'USD');
    const res = await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/JPY/);
  });

  it('a single-currency period still computes (the negative control)', async () => {
    const { admin, repId, orgId } = await scenario();
    const plan = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    await wonDeal(admin, orgId, 'USD a', 1000, repId, '2026-02-10', 'USD');
    await wonDeal(admin, orgId, 'USD b', 2000, repId, '2026-02-11', 'USD');
    const res = await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.total).toBe(150);
  });

  it('deals with NO currency are not treated as disagreement (named deferral)', async () => {
    const { admin, repId, orgId } = await scenario();
    const plan = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    // The CRM field is optional and mostly unset; treating absence as conflict would
    // refuse nearly every real statement. This is a decision, so it has a test.
    await wonDeal(admin, orgId, 'unlabelled', 1000, repId, '2026-02-10');
    const res = await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(50);
  });
});

describe('COM2-M1 — the figure is quantised to the currency it is paid in', () => {
  it('a JPY plan cannot store a fractional yen', async () => {
    const { admin, repId, orgId } = await scenario();
    const plan = await mkPlan(admin, orgId, { currency: 'JPY', assignment: { kind: 'rep', ref: repId }, rules: [{ basis: 'deal-won', type: 'percentage', rate: 0.5 }] });
    await wonDeal(admin, orgId, 'JPY deal', 1_234_567, repId, '2026-02-10', 'JPY');
    const res = await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // 1,234,567 × 0.5% = 6172.835 — not a representable amount in a currency with no
    // minor unit. Raw float arithmetic stored it anyway.
    expect(res.body.total).toBe(6173);
    expect(Number.isInteger(res.body.total)).toBe(true);
    // …and each LINE too. The total alone cannot discriminate: quantising the lines makes
    // the sum integral by itself, so a probe of the total-level rounding came back GREEN.
    // The per-line figure is what a rep reads beside the deal, and what the cap rescale
    // multiplies, so it is the one that has to be representable.
    expect(res.body.lines.every((l: { commission: number }) => Number.isInteger(l.commission))).toBe(true);
  });

  it('a USD plan keeps its cents (the negative control)', async () => {
    const { admin, repId, orgId } = await scenario();
    const plan = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId }, rules: [{ basis: 'deal-won', type: 'percentage', rate: 7.5 }] });
    await wonDeal(admin, orgId, 'a', 33_333.33, repId, '2026-02-10', 'USD');
    await wonDeal(admin, orgId, 'b', 66_666.67, repId, '2026-02-11', 'USD');
    const res = await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(7500);          // …and not 7500.000000000001
  });
});

describe('COM2-B5 — a plan pays who it is assigned to', () => {
  it('refuses a rep the plan is not assigned to', async () => {
    const { admin, repId, orgId } = await scenario();
    const plan = await mkPlan(admin, orgId, { name: 'SDR 2%', assignment: { kind: 'rep', ref: 'user:someone-else' }, rules: [{ basis: 'deal-won', type: 'percentage', rate: 2 }] });
    await wonDeal(admin, orgId, 'W', 1000, repId, '2026-02-10', 'USD');
    // `assignment` is documented as "WHO a plan pays" and validated on write; nothing
    // ever read it, so an SDR plan on a 2% floor produced a valid-looking statement
    // paying an AE — beside the plan's own name, looking deliberate.
    const res = await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/assigned/i);
  });

  it('…and pays the rep it IS assigned to (the negative control)', async () => {
    const { admin, repId, orgId } = await scenario();
    const plan = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    await wonDeal(admin, orgId, 'W', 1000, repId, '2026-02-10', 'USD');
    expect((await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' })).status).toBe(201);
  });
});

describe('COM2-M2 — the plan window is what makes a plan a plan', () => {
  it('a deal closed before the plan existed earns nothing on it', async () => {
    const { admin, repId, orgId } = await scenario();
    const plan = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId }, effectiveFrom: '2026-07-01' });
    await wonDeal(admin, orgId, 'before', 10_000, repId, '2026-02-10', 'USD');
    const res = await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(0);
    expect(res.body.lines).toHaveLength(0);
  });

  it('an EXPIRED plan stops paying', async () => {
    const { admin, repId, orgId } = await scenario();
    const plan = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId }, effectiveFrom: '2026-01-01', effectiveTo: '2026-01-31' });
    await wonDeal(admin, orgId, 'after', 10_000, repId, '2026-03-10', 'USD');
    const res = await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    expect(res.body.total).toBe(0);
  });

  it('a deal INSIDE the window still pays (the negative control)', async () => {
    const { admin, repId, orgId } = await scenario();
    const plan = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId }, effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' });
    await wonDeal(admin, orgId, 'inside', 10_000, repId, '2026-02-10', 'USD');
    expect((await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' })).body.total).toBe(500);
  });
});

describe('COM2-M6/M7 — the terminal transitions record what they did', () => {
  const approveViaReview = async (c: Client, orgId: string, statementId: string): Promise<Res> => {
    const submit = await c.post(`${cbase(orgId)}/statements/${encodeURIComponent(statementId)}/approve`);
    if (submit.status !== 202) return submit;
    return c.post(`/v1/host/openwop-app/reviews/approval:${submit.body.review.approvalId}/actions/approve`);
  };

  it('mark-paid records WHO released the money, and when', async () => {
    const { admin, repId, orgId } = await scenario();
    const plan = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    await wonDeal(admin, orgId, 'W', 1000, repId, '2026-02-10', 'USD');
    const st = (await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' })).body;
    expect((await approveViaReview(admin, orgId, st.statementId)).status).toBe(200);
    const paid = await admin.post(`${cbase(orgId)}/statements/${encodeURIComponent(st.statementId)}/pay`);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    // `void actor;` threw the payer away, and the only trace was a best-effort audit
    // append documented as unable to fail the mutation — i.e. it may not be there at all.
    expect(paid.body.paidBy).toBeTruthy();
    expect(paid.body.paidAt).toBeTruthy();
  });

  it('a recompute cannot silently revert an APPROVED statement', async () => {
    const { admin, repId, orgId } = await scenario();
    const plan = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    await wonDeal(admin, orgId, 'W', 1000, repId, '2026-02-10', 'USD');
    const st = (await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' })).body;
    expect((await approveViaReview(admin, orgId, st.statementId)).status).toBe(200);

    // The code said "an approved statement must be re-approved" and only refused `paid`:
    // a recompute returned the row to draft at a new total and DROPPED approvedBy with no
    // record, while the resolved card still showed a manager approving the old figure.
    const again = await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    expect(again.status).toBe(409);
    const rows = (await admin.get(`${cbase(orgId)}/statements`)).body.statements;
    expect(rows[0].status).toBe('approved');
    expect(rows[0].approvedBy).toBeTruthy();
  });

  it('a DRAFT statement still recomputes freely (the negative control)', async () => {
    const { admin, repId, orgId } = await scenario();
    const plan = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    await wonDeal(admin, orgId, 'W', 1000, repId, '2026-02-10', 'USD');
    await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    expect((await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' })).status).toBe(201);
  });
});

describe('COM2-B4 — the reviewer approves the total they were shown', () => {
  it('refuses an approval whose statement changed after submit', async () => {
    const { admin, repId, orgId } = await scenario();
    const plan = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    await wonDeal(admin, orgId, 'W1', 1000, repId, '2026-02-10', 'USD');
    const st = (await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' })).body;
    expect(st.total).toBe(50);

    const submit = await admin.post(`${cbase(orgId)}/statements/${encodeURIComponent(st.statementId)}/approve`);
    expect(submit.status).toBe(202);                       // the card now says "50 USD"

    // A late deal lands and the statement is recomputed — allowed, it is still a draft.
    await wonDeal(admin, orgId, 'W2', 900_000, repId, '2026-02-20', 'USD');
    const recomputed = (await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' })).body;
    expect(recomputed.total).toBe(45_050);

    // The card still reads 50 USD. Approving it used to apply 45,050 — the reviewer
    // authorised a figure they never saw, and the audit trail recorded their approval.
    const decide = await admin.post(`/v1/host/openwop-app/reviews/approval:${submit.body.review.approvalId}/actions/approve`);
    expect(decide.status).toBe(409);
    expect((await admin.get(`${cbase(orgId)}/statements`)).body.statements[0].status).toBe('draft');
  });

  it('an unchanged statement approves normally (the negative control)', async () => {
    const { admin, repId, orgId } = await scenario();
    const plan = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    await wonDeal(admin, orgId, 'W1', 1000, repId, '2026-02-10', 'USD');
    const st = (await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' })).body;
    const submit = await admin.post(`${cbase(orgId)}/statements/${encodeURIComponent(st.statementId)}/approve`);
    expect((await admin.post(`/v1/host/openwop-app/reviews/approval:${submit.body.review.approvalId}/actions/approve`)).status).toBe(200);
  });
});

describe('COM2-B2/B3 — the accelerator ratio', () => {
  const tbase = (orgId: string): string => `/v1/host/openwop-app/territories/orgs/${encodeURIComponent(orgId)}`;

  /**
   * A parent → child model where the deals route to the CHILD and the quota is authored
   * on `quotaOn`. The PARENT case is the natural shape (a district quota set at the
   * region), and it is the one my first fix broke — it took the leaf's own quota, which
   * is 0 there, and paid the base rate to a rep who had exceeded quota.
   */
  async function hierarchy(admin: Client, orgId: string, repId: string, quotaCurrency: string, quotaOn: 'parent' | 'child' = 'parent'): Promise<void> {
    const { transitionModelViaReview } = await import('./territoryReview.js');
    const modelId = (await admin.post(`${tbase(orgId)}/models`, { name: 'M' })).body.modelId;
    const parent = (await admin.post(`${tbase(orgId)}/models/${modelId}/territories`, { name: 'EMEA' })).body;
    const child = (await admin.post(`${tbase(orgId)}/models/${modelId}/territories`, { name: 'DACH', parentTerritoryId: parent.territoryId })).body;
    await admin.post(`${tbase(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: child.territoryId, priority: 10, filter: { field: 'amount', op: 'gte', value: 0 } });
    const quotaTerritory = quotaOn === 'parent' ? parent : child;
    expect((await admin.put(`${tbase(orgId)}/models/${modelId}/territories/${quotaTerritory.territoryId}/quota`, {
      period: '2026-Q1', amount: 400_000, currency: quotaCurrency, repSplits: [{ subjectId: repId, amount: 400_000 }],
    })).status).toBe(200);
    await transitionModelViaReview(admin as never, tbase(orgId), modelId);
  }

  it('B2: a rep at 125% is not read as 250% by counting the roll-up twice', async () => {
    const { admin, repId, orgId } = await scenario();
    await wonDeal(admin, orgId, 'big', 500_000, repId, '2026-02-10', 'USD');
    await hierarchy(admin, orgId, repId, 'USD');           // quota on the PARENT — the natural shape
    // `repSplits[].won` is the ROLLED figure (self + descendants) while `.quota` is that
    // node's OWN split, so summing over every territory counted the win once per ancestor
    // level against a quota counted once. With an accelerator at 200% the rep was paid
    // the top rate on a threshold they never crossed. A FLAT model hides this entirely.
    const plan = await mkPlan(admin, orgId, {
      assignment: { kind: 'rep', ref: repId },
      rules: [{ basis: 'deal-won', type: 'percentage', rate: 6, accelerators: [{ attainmentGte: 200, rate: 12 }] }],
    });
    const res = await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.attainmentPct).toBeCloseTo(125, 0);      // 500,000 / 400,000
    expect(res.body.lines[0].rate).toBe(6);                  // …so the 200% accelerator does NOT fire
  });

  it('B2: …and a rep who DID cross the threshold is still paid for it', async () => {
    const { admin, repId, orgId } = await scenario();
    await wonDeal(admin, orgId, 'big', 500_000, repId, '2026-02-10', 'USD');
    await hierarchy(admin, orgId, repId, 'USD');
    // The half my first fix got wrong: with the quota authored on the PARENT, taking the
    // leaf's OWN quota gives 0, `ratioUnavailable: 'no-quota'` short-circuits, and the
    // rep is paid the base rate on a quota they exceeded. `won` comes from the shallowest
    // row, `quota` from every row.
    const plan = await mkPlan(admin, orgId, {
      assignment: { kind: 'rep', ref: repId },
      rules: [{ basis: 'deal-won', type: 'percentage', rate: 6, accelerators: [{ attainmentGte: 100, rate: 12 }] }],
    });
    const res = await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.attainmentPct).toBeCloseTo(125, 0);
    expect(res.body.lines[0].rate).toBe(12);
  });

  it('B2: splits on BOTH levels sum once each — the discriminating case', async () => {
    const { admin, repId, orgId } = await scenario();
    const { transitionModelViaReview } = await import('./territoryReview.js');
    await wonDeal(admin, orgId, 'big', 500_000, repId, '2026-02-10', 'USD');
    // A region quota AND a district quota for the same rep — the shape where the two
    // halves of the rule pull apart. `won` must come from the parent alone (its rolled
    // figure already contains the child's) while `quota` must sum BOTH authored splits.
    // Taking quota from the same rows as won gives 200,000 → 250%, which is the original
    // defect wearing a different mask; my first fold-in test could not tell the two
    // apart, because with the quota on one level only they agree.
    const modelId = (await admin.post(`${tbase(orgId)}/models`, { name: 'M' })).body.modelId;
    const parent = (await admin.post(`${tbase(orgId)}/models/${modelId}/territories`, { name: 'EMEA' })).body;
    const child = (await admin.post(`${tbase(orgId)}/models/${modelId}/territories`, { name: 'DACH', parentTerritoryId: parent.territoryId })).body;
    await admin.post(`${tbase(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: child.territoryId, priority: 10, filter: { field: 'amount', op: 'gte', value: 0 } });
    for (const terr of [parent, child]) {
      expect((await admin.put(`${tbase(orgId)}/models/${modelId}/territories/${terr.territoryId}/quota`, {
        period: '2026-Q1', amount: 200_000, currency: 'USD', repSplits: [{ subjectId: repId, amount: 200_000 }],
      })).status).toBe(200);
    }
    await transitionModelViaReview(admin as never, tbase(orgId), modelId);

    const plan = await mkPlan(admin, orgId, {
      assignment: { kind: 'rep', ref: repId },
      rules: [{ basis: 'deal-won', type: 'percentage', rate: 6, accelerators: [{ attainmentGte: 200, rate: 12 }] }],
    });
    const res = await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.attainmentPct).toBeCloseTo(125, 0);      // 500,000 / (200,000 + 200,000)
    expect(res.body.lines[0].rate).toBe(6);
  });

  it('B2: the quota may be authored on the CHILD instead — same answer', async () => {
    const { admin, repId, orgId } = await scenario();
    await wonDeal(admin, orgId, 'big', 500_000, repId, '2026-02-10', 'USD');
    await hierarchy(admin, orgId, repId, 'USD', 'child');
    const plan = await mkPlan(admin, orgId, {
      assignment: { kind: 'rep', ref: repId },
      rules: [{ basis: 'deal-won', type: 'percentage', rate: 6, accelerators: [{ attainmentGte: 100, rate: 12 }] }],
    });
    const res = await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    expect(res.body.attainmentPct).toBeCloseTo(125, 0);
    expect(res.body.lines[0].rate).toBe(12);
  });

  it('B3: a quota in a different currency than the deals earns the BASE rate, not 12,000%', async () => {
    const { admin, repId, orgId } = await scenario();
    await wonDeal(admin, orgId, 'jpy', 12_000_000, repId, '2026-02-10', 'JPY');
    await hierarchy(admin, orgId, repId, 'USD');
    // Territories' own round 2 returns `attainment: null` + `ratioUnavailable` here,
    // because "EUR won ÷ USD quota is off by whatever FX would be". Recomputing that
    // ratio from the raw numerator and denominator produced 12,000% and fired every
    // accelerator — on a plan that pays in JPY, so the statement itself is valid.
    const plan = await mkPlan(admin, orgId, {
      currency: 'JPY', assignment: { kind: 'rep', ref: repId },
      rules: [{ basis: 'deal-won', type: 'percentage', rate: 1, accelerators: [{ attainmentGte: 200, rate: 10 }] }],
    });
    const res = await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.attainmentPct).toBeUndefined();          // "no context" — the safe fallback
    expect(res.body.lines[0].rate).toBe(1);
  });
});

describe('review fold-in — defects the independent pass found in the fix', () => {
  it('a stale card is RE-PINNED on re-submit, instead of dead-ending on reject', async () => {
    const { admin, repId, orgId } = await scenario();
    const plan = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    await wonDeal(admin, orgId, 'W1', 1000, repId, '2026-02-10', 'USD');
    const st = (await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' })).body;
    const first = await admin.post(`${cbase(orgId)}/statements/${encodeURIComponent(st.statementId)}/approve`);
    expect(first.status).toBe(202);

    await wonDeal(admin, orgId, 'W2', 900_000, repId, '2026-02-20', 'USD');
    await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    // The 409 tells the operator to re-submit. Both submit paths reused whatever pending
    // card they found and never re-pinned it, so re-submitting handed back the SAME card
    // and approve 409'd again — the only escape was reject, which is structurally the
    // dead end COM2-M5 exists to close, one guard over.
    expect((await admin.post(`/v1/host/openwop-app/reviews/approval:${first.body.review.approvalId}/actions/approve`)).status).toBe(409);

    const second = await admin.post(`${cbase(orgId)}/statements/${encodeURIComponent(st.statementId)}/approve`);
    expect(second.status).toBe(202);
    expect(second.body.review.approvalId).not.toBe(first.body.review.approvalId);   // a FRESH card
    expect((await admin.post(`/v1/host/openwop-app/reviews/approval:${second.body.review.approvalId}/actions/approve`)).status).toBe(200);
    expect((await admin.get(`${cbase(orgId)}/statements`)).body.statements[0].status).toBe('approved');
  });

  it('an unchanged statement re-submits idempotently (the negative control)', async () => {
    const { admin, repId, orgId } = await scenario();
    const plan = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    await wonDeal(admin, orgId, 'W1', 1000, repId, '2026-02-10', 'USD');
    const st = (await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' })).body;
    const a1 = await admin.post(`${cbase(orgId)}/statements/${encodeURIComponent(st.statementId)}/approve`);
    const a2 = await admin.post(`${cbase(orgId)}/statements/${encodeURIComponent(st.statementId)}/approve`);
    expect(a2.body.review.approvalId).toBe(a1.body.review.approvalId);
  });

  it('a deal currency in the wrong CASE is not treated as a different currency', async () => {
    const { admin, repId, orgId } = await scenario();
    const plan = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    // `deal.currency` has no normalisation on the raw CRM route, so one `"usd"` would
    // otherwise 400 every statement for that rep — naming the SAME currency as the
    // difference, with no console affordance to fix it.
    await wonDeal(admin, orgId, 'lower', 1000, repId, '2026-02-10', 'usd');
    const res = await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.total).toBe(50);
  });
});

describe('COM2-M9 — subject erasure reaches the commissions rows', () => {
  it('anonymises the statement and removes the rep as a payment target', async () => {
    const { admin, repId, orgId, tenantId } = await scenario();
    const plan = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    await wonDeal(admin, orgId, 'W', 1000, repId, '2026-02-10', 'USD');
    await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });

    await eraseSubject(tenantId, repId);

    const rows = (await admin.get(`${cbase(orgId)}/statements`)).body.statements;
    expect(rows[0].subjectId).toBe('user:[erased]');
    expect(rows[0].total).toBe(50);                        // the financial record survives
    // …and the row KEY no longer embeds them either. The first version rewrote four
    // FIELDS and left `statementId` = `planId:subjectId:period`, which the route returns
    // verbatim, the console renders, and the analyst agent is handed with the whole row.
    expect(rows[0].statementId).not.toContain(repId);

    // …and the plan no longer names them as someone to pay. NOT a sentinel: a sentinel
    // `ref` still satisfies the COM2-B5 assignment check, so the plan would keep paying.
    // The plan itself SURVIVES — erasure must not delete the business record.
    const plans = (await admin.get(`${cbase(orgId)}/plans`)).body.plans;
    expect(plans).toHaveLength(1);
    expect(plans[0].assignment).toBeUndefined();
    // …and an unassigned plan refuses to pay anyone until a human re-assigns it.
    const blocked = await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    expect(blocked.status).toBe(400);
  });

  it('leaves another subject alone (the negative control)', async () => {
    const { admin, repId, orgId, tenantId } = await scenario();
    const plan = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    await wonDeal(admin, orgId, 'W', 1000, repId, '2026-02-10', 'USD');
    await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' });
    await eraseSubject(tenantId, 'user:nobody-here');
    expect((await admin.get(`${cbase(orgId)}/statements`)).body.statements[0].subjectId).toBe(repId);
  });
});

describe('R3 — the approval card reads like the table (the COM-G3 reintroduction)', () => {
  it("the proposal names the rep and formats the money — the reviewer never sees a raw id", async () => {
    const { admin, repId, orgId } = await scenario();
    const plan = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: repId } });
    await wonDeal(admin, orgId, 'Big deal', 20_000, repId, '2026-02-10', 'USD');
    const st = (await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: repId, period: '2026-Q1' })).body;
    const submit = await admin.post(`${cbase(orgId)}/statements/${encodeURIComponent(st.statementId)}/approve`);
    expect(submit.status).toBe(202);
    const { getApproval } = await import('../src/host/approvalService.js');
    const card = await getApproval(submit.body.review.approvalId);
    expect(card!.proposal).toContain('rep');            // the member's displayName
    expect(card!.proposal).toContain('$1,000.00');      // 5% of $20k, currency-formatted
    expect(card!.proposal).not.toContain(repId);        // the raw id is gone
    expect(card!.proposal).not.toContain('1000 USD');   // …and so is the raw pair
  });

  it('a rep with NO member row falls back to the id — an honest fallback, not a blank', async () => {
    const { admin, orgId, tenantId } = await scenario();
    // A second authenticated user who was never added as an org member.
    const ghost = client();
    const ghostId = (await ghost.post('/v1/host/openwop-app/test/login', { email: `g-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
    const plan = await mkPlan(admin, orgId, { assignment: { kind: 'rep', ref: ghostId } });
    await wonDeal(admin, orgId, 'Ghost deal', 10_000, ghostId, '2026-02-12', 'USD');
    const st = (await admin.post(`${cbase(orgId)}/plans/${plan.planId}/statements/compute`, { subjectId: ghostId, period: '2026-Q1' })).body;
    const submit = await admin.post(`${cbase(orgId)}/statements/${encodeURIComponent(st.statementId)}/approve`);
    expect(submit.status).toBe(202);
    const { getApproval } = await import('../src/host/approvalService.js');
    const card = await getApproval(submit.body.review.approvalId);
    expect(card!.proposal).toContain(ghostId);          // no name to resolve — the id is the truth
    expect(card!.proposal).toContain('$500.00');        // money is still formatted
  });
});

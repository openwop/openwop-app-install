/**
 * Sales Commissions — statement computation (ADR 0280 Phase 2).
 *
 * `computeStatement(plan, rep, period)` sums the rep's WON deals in the period ×
 * the plan rate, applies the accelerator rate for reps past their quota-attainment
 * threshold (composed from ADR 0272 `computeAttainment` — NOT recomputed), and
 * caps. Deterministic given the deal + attainment snapshot, so a period-run is
 * replay-safe. The statement id is deterministic (`planId:subjectId:period`) so a
 * recompute upserts the same row (idempotent).
 *
 * Composition boundary (ADR 0280 §2): reps = deal `owner` (CRM `listDeals`);
 * attainment = territories `computeAttainment` against the active model. With
 * territories off / no active model / no rep quota, accelerators simply don't fire
 * (base rate only) — a safe, honest fallback.
 *
 * @see docs/adr/0280-sales-commissions.md
 */

import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { OpenwopError } from '../../../types.js';
import { listDeals } from '../../crm/crmEntitiesService.js';
import { getActiveModelId } from '../../territories/entities/territories.js';
import { computeAttainment } from '../../territories/entities/quota.js';
import { getPlan, type CommissionPlan, type CommissionRule } from './plan.js';
import { validateCommissionStatement } from './rowGuards.js';
import { toMinor, minorToMajorNumber, lineCommissionMinor, allocateCap } from './money.js';
import { claimDeals, listPlanClaims, repointClaims, releaseStatementClaims, eraseClaimSubjects } from './dealClaims.js';
import { repointCommissionStatementApprovals } from '../../../host/approvalService.js';
import { sameSubject } from './subject.js';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../../observability/logger.js';

const log = createLogger('sales-commissions.statement');
import { subjectKeyForms, ERASED, ERASED_USER_REF } from '../../../host/subjectErasureRedaction.js';

export type StatementStatus = 'draft' | 'approved' | 'paid';

export interface StatementLine {
  dealId: string;
  dealAmount: number;
  /** The effective rate applied (base or accelerated), in the rule's `type` units. */
  rate: number;
  commission: number;
  /** ADR 1034 D7 — the exact integer minor units `dealAmount`/`commission` are derived from.
   *  Absent on rows computed before D7. */
  dealAmountMinor?: number;
  commissionMinor?: number;
}

/** ADR 1034 D4 — a won deal left off this draft because another statement of the SAME plan
 *  already committed it (approved or paid). Named by deal and that statement's period only:
 *  the other statement's id embeds its rep. */
export interface ExcludedDeal {
  dealId: string;
  period: string;
}

export interface CommissionStatement {
  statementId: string; // deterministic: `${planId}:${subjectId}:${period}`
  tenantId: string;
  orgId: string;
  subjectId: string; // the rep (deal owner)
  period: string; // YYYY-Qn or YYYY-MM
  planId: string;
  currency: string;
  lines: StatementLine[];
  total: number;
  /** ADR 1034 D7 — the exact total in integer minor units (`total` is derived from it). */
  totalMinor?: number;
  /** ADR 1034 D4 — won deals in the period that another statement of this plan already paid. */
  excludedDeals?: ExcludedDeal[];
  /** The rep's quota attainment % used for accelerators (undefined = no context). */
  attainmentPct?: number;
  status: StatementStatus;
  computedAt: string;
  updatedAt: string;
  /** Set when status ⇒ approved (ADR 0280 P3). */
  approvedBy?: string;
  approvedAt?: string;
  /** R2 COM2-M7 — set when status ⇒ paid. Who released the money, and when: the terminal
   *  transition recorded neither, so a disputed payout a quarter later had nothing on the
   *  row to answer with. */
  paidBy?: string;
  paidAt?: string;
  /** R2 COM2-M4 — who SUBMITTED it for review, so the decide seam can refuse a
   *  self-approval (the separation of duties the approval's own docblock promises). */
  submittedBy?: string;
}

const PERIOD_RE = /^\d{4}-(Q[1-4]|(0[1-9]|1[0-2]))$/;
const statements = new DurableCollection<CommissionStatement>('commissions:commission-statement', (s) => s.statementId, validateCommissionStatement, (s) => s.tenantId);

const nowIso = (): string => new Date().toISOString();

/** R2 COM2-M2 — is a deal's close date inside the plan's effective window? */
function withinPlanWindow(closeDate: string | undefined, plan: CommissionPlan): boolean {
  if (!closeDate) return false;                       // an undated deal cannot be placed in a window
  if (closeDate < plan.effectiveFrom) return false;
  return plan.effectiveTo === undefined || closeDate <= plan.effectiveTo;
}
const scoped = <T extends { tenantId: string; orgId: string }>(rows: T[], tenantId: string, orgId: string): T[] =>
  rows.filter((r) => r.tenantId === tenantId && r.orgId === orgId);
const statementId = (planId: string, subjectId: string, period: string): string => `${planId}:${subjectId}:${period}`;

function assertPeriod(period: string): void {
  if (!PERIOD_RE.test(period)) throw new OpenwopError('validation_error', '`period` must be YYYY-Qn or YYYY-MM.', 400, { period });
}

/** True if a `YYYY-MM-DD` close date falls within a `YYYY-Qn` / `YYYY-MM` period. */
export function periodContains(closeDate: string | undefined, period: string): boolean {
  if (!closeDate || closeDate.length < 7) return false;
  const year = closeDate.slice(0, 4);
  const month = Number(closeDate.slice(5, 7));
  if (period.includes('-Q')) {
    const [py, pq] = period.split('-Q');
    if (py !== year) return false;
    const q = Number(pq); // Q1 → months 1-3, etc.
    return month >= (q - 1) * 3 + 1 && month <= q * 3;
  }
  return closeDate.slice(0, 7) === period; // YYYY-MM
}

/** The effective rate: the highest-threshold accelerator the rep qualifies for, else base. */
export function effectiveRate(rule: CommissionRule, attainmentPct: number | undefined): number {
  if (attainmentPct === undefined || !rule.accelerators || rule.accelerators.length === 0) return rule.rate;
  const qualifying = rule.accelerators.filter((a) => attainmentPct >= a.attainmentGte).sort((a, b) => b.attainmentGte - a.attainmentGte);
  return qualifying.length > 0 ? qualifying[0].rate : rule.rate;
}

export { sameSubject } from './subject.js';
export { releaseStatementClaims } from './dealClaims.js';

/** ADR 1034 D4 — deals another statement of this plan has already committed: claimed, or
 *  (for rows approved before claims existed) present on an approved/paid statement. */
export async function committedDealsForPlan(tenantId: string, orgId: string, planId: string, exceptStatementId: string): Promise<Map<string, string>> {
  const all = scoped(await statements.listForTenantIndexed(tenantId), tenantId, orgId).filter((s) => s.planId === planId);
  const periodOf = new Map(all.map((s) => [s.statementId, s.period]));
  const out = new Map<string, string>();
  for (const s of all) {
    if (s.statementId === exceptStatementId || s.status === 'draft') continue;
    for (const l of s.lines) out.set(l.dealId, s.period);
  }
  for (const c of await listPlanClaims(tenantId, orgId, planId)) {
    if (c.statementId !== exceptStatementId) out.set(c.dealId, periodOf.get(c.statementId) ?? 'another period');
  }
  return out;
}

/** The deals on `s` that another statement of its plan already committed (the approval pre-check). */
export async function findDealConflicts(s: CommissionStatement): Promise<ExcludedDeal[]> {
  const committed = await committedDealsForPlan(s.tenantId, s.orgId, s.planId, s.statementId);
  const seen = new Set<string>();
  const out: ExcludedDeal[] = [];
  for (const l of s.lines) {
    const period = committed.get(l.dealId);
    if (period !== undefined && !seen.has(l.dealId)) { seen.add(l.dealId); out.push({ dealId: l.dealId, period }); }
  }
  return out;
}

const safeMinor = (v: bigint, field: string): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new OpenwopError('validation_error', `\`${field}\` is too large to compute exactly.`, 400, { field });
  return n;
};

/** The rep's attainment % from the active territory model (undefined ⇒ no context). */
async function repAttainmentPct(tenantId: string, orgId: string, subjectId: string, period: string): Promise<number | undefined> {
  const modelId = await getActiveModelId(tenantId, orgId);
  if (!modelId) return undefined;
  const report = await computeAttainment(tenantId, orgId, modelId, period, undefined); // system read (undefined viewer) → all territories
  const rows = report.territories.filter((t) => t.repSplits.some((s) => s.subjectId === subjectId));

  // R2 COM2-B2 — the two halves of a split are asymmetric, so they need OPPOSITE
  // selections. `repSplits[].won` is the ROLLED figure (self + every descendant);
  // `.quota` is that node's OWN authored split. Summing both over every territory counted
  // a rep's win once PER ANCESTOR LEVEL against a quota counted once — 125% read as 250%
  // and paid an accelerator the rep never earned.
  //
  // CORRECTION (review): my first fix took BOTH from the deepest node, and that is worse.
  // Every ancestor of the leaf a rep's deals land in also carries a split row, so the
  // walk always picked the leaf — and took the leaf's own quota, which is 0 whenever the
  // quota was authored one level up (the natural shape). MEASURED: the same 125% rep came
  // back `attainmentPct: undefined` and was paid the BASE rate on a quota they exceeded.
  // The old bug at least crossed the threshold. My test had put the quota on the child —
  // the one arrangement where "deepest" is right — so it could not see this.
  //
  // Correct: take WON from the SHALLOWEST rows (a node with no ancestor carrying this
  // subject; its rolled figure already contains the whole subtree) and sum QUOTA over ALL
  // rows (each authored split counts once, wherever it was written). Siblings both count,
  // because neither is the other's ancestor; a flat model is unchanged.
  const idsWithSubject = new Set(rows.map((t) => t.territoryId));
  const byId = new Map(report.territories.map((t) => [t.territoryId, t]));
  const hasAncestorWithSubject = (territoryId: string): boolean => {
    let cur = byId.get(territoryId)?.parentTerritoryId ?? null;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (idsWithSubject.has(cur)) return true;
      seen.add(cur);
      cur = byId.get(cur)?.parentTerritoryId ?? null;
    }
    return false;
  };
  const wonRows = rows.filter((t) => !hasAncestorWithSubject(t.territoryId));
  const counted = rows;                                   // for the ratio-availability check below

  // R2 COM2-B3 — territories' own round 2 (#3145) added `ratioUnavailable` and returns
  // `attainment: null` precisely when a ratio cannot be stated honestly (mixed deal
  // currencies, mixed quota currencies, or a quota in a different currency than the
  // deals — "EUR won ÷ USD quota, off by whatever FX would be"). Recomputing that ratio
  // here from the raw numerator and denominator reproduces the exact figure territories
  // refuses to produce: a JPY-deals/USD-quota territory yields 12,000% and fires every
  // accelerator. `undefined` already means "no context, base rate only" — the documented
  // safe fallback — so an unstateable ratio takes it.
  if (counted.some((t) => t.ratioUnavailable !== undefined && t.ratioUnavailable !== 'no-quota')) return undefined;

  let won = 0;
  for (const terr of wonRows) {
    for (const s of terr.repSplits) if (s.subjectId === subjectId) won += s.won;
  }
  let quota = 0;
  for (const terr of rows) {
    for (const s of terr.repSplits) if (s.subjectId === subjectId) quota += s.quota;
  }
  return quota > 0 ? (won / quota) * 100 : undefined;
}

export async function computeStatement(tenantId: string, orgId: string, planId: string, subjectId: string, period: string): Promise<CommissionStatement> {
  assertPeriod(period);
  const plan: CommissionPlan = await getPlan(tenantId, orgId, planId);

  // R2 COM2-B5 — `PlanAssignment` is documented as "WHO a plan pays", it is validated on
  // write, and NOTHING read it: `computeStatement` took an arbitrary `subjectId` from the
  // request body, so an SDR plan on a 2% floor would happily produce a valid-looking
  // statement paying an AE — beside the plan's own name, looking deliberate. `rep` is the
  // exact case that can be decided here with certainty; `role`/`territory` need
  // membership lookups this layer does not own and are named as a deferral rather than
  // half-enforced.
  if (plan.assignment === undefined) {
    // Only reachable after erasure cleared it (COM2-M9): an unassigned plan pays nobody
    // until a human re-assigns it, rather than quietly paying whoever is asked for.
    throw new OpenwopError('validation_error', 'This plan is not assigned to anyone, so it cannot pay a statement. Assign it first.', 400, { field: 'assignment' });
  }
  if (plan.assignment.kind === 'rep' && plan.assignment.ref !== subjectId) {
    throw new OpenwopError('validation_error', 'This plan is assigned to a different rep, so it cannot pay this one.', 400, {
      field: 'subjectId', assignedTo: plan.assignment.ref, requested: subjectId,
    });
  }

  const attainmentPct = await repAttainmentPct(tenantId, orgId, subjectId, period);

  const id = statementId(planId, subjectId, period);
  const committed = await committedDealsForPlan(tenantId, orgId, planId, id);
  const excludedDeals: ExcludedDeal[] = [];
  const periodDeals = (await listDeals(tenantId, orgId, {}, undefined)).filter((d) =>
    d.owner === subjectId
    && d.status === 'won'
    && periodContains(d.closeDate, period)
    // R2 COM2-M2 — `effectiveFrom`/`effectiveTo` were required, format-validated, and
    // ordered against each other on write… and never once read. A plan created in July
    // paid full commission on deals closed in Q1, and an expired plan kept paying
    // forever. The window is what makes a plan a plan.
    && withinPlanWindow(d.closeDate, plan));
  // ADR 1034 D4 — a deal another statement of this plan already committed is not paid
  // again. It is listed, not silently dropped, so the reviewer sees why it is missing.
  const deals = periodDeals.filter((d) => {
    const paidIn = committed.get(d.dealId);
    if (paidIn === undefined) return true;
    excludedDeals.push({ dealId: d.dealId, period: paidIn });
    return false;
  });

  // R2 COM2-B1 — the sums add raw `d.amount` and never consult `d.currency`, then stamp
  // `plan.currency` on the result. A rep closing ¥100,000 and $20,000 under a 5% USD plan
  // produced "$6,000" — a payout record that is not a quantity of anything, shown to the
  // rep, served to the agent verbatim, and frozen onto an approval card. CRM's own report
  // service already refuses this shape ("groups by the deals' currency … so the UI can
  // render one figure per currency instead of a mixed-currency total") and territories
  // chose to withhold the ratio. A payout has no honest partial answer — there is no FX
  // here — so a disagreement is a typed refusal naming the deals, not a number.
  // A deal carrying NO currency is deliberately not a disagreement: the CRM field is
  // optional and mostly unset, and treating absence as conflict would refuse nearly every
  // real statement. Named as a deferral.
  // Review I7 — `plan.currency` is uppercased and shape-checked on write; `deal.currency`
  // is an arbitrary ≤8-char string with NO normalisation on the raw CRM route. One deal
  // written `"usd"` by an API client would otherwise 400 every statement for that rep,
  // naming the SAME currency as the difference.
  const offenders = deals.filter((d) => d.currency !== undefined && d.currency.toUpperCase() !== plan.currency.toUpperCase());
  if (offenders.length > 0) {
    throw new OpenwopError('validation_error', `This plan pays in ${plan.currency}, but ${offenders.length} won deal(s) in this period are in a different currency. There is no conversion here, so a commission cannot be computed from them.`, 400, {
      field: 'currency', planCurrency: plan.currency,
      deals: offenders.slice(0, 20).map((d) => ({ dealId: d.dealId, currency: d.currency })),
    });
  }

  // ADR 1034 D7 — a credit is a clawback, and clawback is deferred (ADR 0280 §8). A won deal
  // with a negative amount would be an unreviewed partial clawback, so it is refused by name.
  const negatives = deals.filter((d) => (d.amount ?? 0) < 0);
  if (negatives.length > 0) {
    throw new OpenwopError('validation_error', `${negatives.length} won deal(s) in this period have a negative amount. A commission cannot be computed from them; correct the deal amounts first.`, 400, {
      field: 'amount', deals: negatives.slice(0, 20).map((d) => ({ dealId: d.dealId })),
    });
  }

  // ADR 1034 D7 — integer minor units end to end (`money.ts`). R2 COM2-M1 rounded the float
  // results with `quantizeMajor`, which still misrounds at the half because the float
  // product it rounds is already wrong (`1.005 * 100 === 100.49999999999999`).
  const cur = plan.currency;
  const lines: StatementLine[] = [];
  let totalMinor = 0n;
  for (const rule of plan.rules) {
    const rate = effectiveRate(rule, attainmentPct);
    const dealMinors = deals.map((d) => toMinor(d.amount ?? 0, cur, 'amount'));
    let commissions = dealMinors.map((m) => lineCommissionMinor(rule.type, m, rate, cur));
    // Cap is per-rule on the rule's total, allocated by largest remainder so the lines sum
    // to the cap exactly (the float rescale could land one minor unit past it).
    const ruleTotal = commissions.reduce((a, v) => a + v, 0n);
    if (rule.cap !== undefined) {
      const capMinor = toMinor(rule.cap, cur, 'cap');
      if (ruleTotal > capMinor && ruleTotal > 0n) commissions = allocateCap(commissions, capMinor);
    }
    deals.forEach((d, i) => {
      lines.push({
        dealId: d.dealId,
        dealAmount: minorToMajorNumber(dealMinors[i], cur),
        rate,
        commission: minorToMajorNumber(commissions[i], cur),
        dealAmountMinor: safeMinor(dealMinors[i], 'amount'),
        commissionMinor: safeMinor(commissions[i], 'commission'),
      });
      totalMinor += commissions[i];
    });
  }
  const total = minorToMajorNumber(totalMinor, cur);
  const raw = await statements.get(id);
  if (raw && (raw.tenantId !== tenantId || raw.orgId !== orgId)) throw new OpenwopError('not_found', 'Commission plan not found.', 404, { planId });
  const existing = raw;
  const now = nowIso();
  const statement: CommissionStatement = {
    statementId: id,
    tenantId,
    orgId,
    subjectId,
    period,
    planId,
    currency: plan.currency,
    lines,
    total,
    totalMinor: safeMinor(totalMinor, 'total'),
    status: 'draft', // recompute always returns a draft (an approved statement must be re-approved)
    computedAt: now,
    updatedAt: now,
    ...(attainmentPct !== undefined ? { attainmentPct } : {}),
    ...(excludedDeals.length > 0 ? { excludedDeals } : {}),
    // ADR 1034 D6 — the submitter stamp survives a recompute (it is the audit trail).
    ...(existing?.submittedBy !== undefined ? { submittedBy: existing.submittedBy } : {}),
  };
  // Guard: refuse to silently overwrite an already-PAID statement via recompute.
  if (existing && existing.status === 'paid') throw new OpenwopError('conflict', 'This statement is already paid and cannot be recomputed.', 409, { statementId: id });
  // R2 COM2-M6 — …and an APPROVED one. The comment three lines up says "an approved
  // statement must be re-approved", but only `paid` was refused: a recompute silently
  // returned the row to `draft` at a different total and DROPPED `approvedBy`/`approvedAt`
  // with no record that an approval ever happened — while the resolved card in the Reviews
  // history still showed a manager approving the old figure. The two disagreed, and only
  // the inbox remembered.
  if (existing && existing.status === 'approved') {
    // (Closing grade-code I6: this used to say "Revoke the approval first", and there is no
    // revoke. An approved statement is final; its claims are too — ADR 1034 D4.)
    throw new OpenwopError('conflict', 'This statement is already approved, and an approved statement cannot be recomputed.', 409, { statementId: id, approvedBy: existing.approvedBy });
  }
  // ADR 1034 D6 — a CAS against the exact row the approved/paid refusals above read. A plain
  // `put` here let an approval landing between the read and the write be overwritten by a
  // draft at a new total: the card said approved, the row said draft.
  if (!(await statements.compareAndSwap(existing, statement))) {
    throw new OpenwopError('conflict', 'This statement changed while it was being recomputed. Reload and try again.', 409, { statementId: id });
  }
  // ADR 1034 D4 — a recomputed DRAFT no longer wants a deal it dropped (its close date moved,
  // it was lost): free that claim so another statement of the plan can pay it.
  await releaseStatementClaims(tenantId, id, new Set(lines.map((l) => l.dealId)));
  return statement;
}

export async function getStatementRaw(tenantId: string, orgId: string, statementId: string): Promise<CommissionStatement | null> {
  const s = await statements.get(statementId);
  return s && s.tenantId === tenantId && s.orgId === orgId ? s : null;
}

/** Subject-scoped list: `canSeeAll` (admin/view-all) sees every statement; else only
 *  the caller's own (`viewerSubject`). Mirrors ADR 0272 record visibility. */
export async function listStatements(
  tenantId: string,
  orgId: string,
  filter: { subjectId?: string; period?: string; planId?: string },
  canSeeAll: boolean,
  viewerSubject: string | undefined,
): Promise<CommissionStatement[]> {
  let rows = scoped(await statements.listForTenantIndexed(tenantId), tenantId, orgId);
  // fail-closed: no viewer ⇒ nothing. ADR 1034 D8 — matched across subject spellings.
  if (!canSeeAll) rows = rows.filter((s) => viewerSubject !== undefined && sameSubject(s.subjectId, viewerSubject));
  if (filter.subjectId) rows = rows.filter((s) => s.subjectId === filter.subjectId);
  if (filter.period) rows = rows.filter((s) => s.period === filter.period);
  if (filter.planId) rows = rows.filter((s) => s.planId === filter.planId);
  return rows.sort((a, b) => b.period.localeCompare(a.period) || a.subjectId.localeCompare(b.subjectId));
}

export async function persistStatement(s: CommissionStatement): Promise<void> {
  await statements.put(s);
}

/**
 * Approve a DRAFT statement (ADR 0280 P3), stamping the approver. Idempotent on an
 * already-approved statement; refuses a paid one.
 *
 * ADR 1034 D4 — the ONE choke point to `approved`: the decide handler and the demo seeder
 * both reach it, so the deal claims are taken here, never by a caller. `expected` is the row
 * the caller checked (the decide handler's pin-checked `live`); the flip CASes against
 * exactly that row, so a recompute between the check and the approval loses rather than
 * being approved unseen (architect B3).
 */
export async function approveStatement(tenantId: string, orgId: string, statementId: string, actor: string, expected?: CommissionStatement): Promise<CommissionStatement> {
  const s = expected ?? await getStatementRaw(tenantId, orgId, statementId);
  if (!s || s.tenantId !== tenantId || s.orgId !== orgId || s.statementId !== statementId) throw new OpenwopError('not_found', 'Statement not found.', 404, { statementId });
  if (s.status === 'approved') return s; // idempotent
  if (s.status !== 'draft') throw new OpenwopError('conflict', `Only a draft statement can be approved (this one is ${s.status}).`, 409, { statementId, status: s.status });
  const conflicts = await findDealConflicts(s);
  if (conflicts.length > 0) throw dealAlreadyCommitted(statementId, conflicts);
  const now = nowIso();
  const { heldElsewhere } = await claimDeals(tenantId, orgId, s.planId, statementId, s.lines.map((l) => l.dealId), now);
  // On either failure below, the claims this attempt inserted STAY bound to this statement
  // (see `releaseStatementClaims` for why there is no release here).
  if (heldElsewhere.length > 0) {
    throw dealAlreadyCommitted(statementId, heldElsewhere.map((dealId) => ({ dealId, period: 'another period' })));
  }
  const next: CommissionStatement = { ...s, status: 'approved', approvedBy: actor, approvedAt: now, updatedAt: now };
  // R2 COM2-M8 — a plain `put` is last-writer-wins on the two transitions that move
  // money. `compareAndSwap` is the documented `If-Match` equivalent on this collection
  // and was simply unused here.
  if (!(await statements.compareAndSwap(s, next))) {
    throw new OpenwopError('conflict', 'This statement changed while you were approving it. Reload and try again.', 409, { statementId });
  }
  // Closing grade-code I1 — free any claim this statement holds for a deal NOT on the lines
  // it was approved with (an earlier attempt over older lines can leave one). Safe here: the
  // row is now approved with exactly these lines, and only this statement's claims are touched.
  // Best-effort, and it must NOT fail the approval: the statement IS approved now, so a
  // throw here would make the decide handler reopen a card for an approved row. A failure
  // only leaves a stale claim for a deal this statement no longer has — logged, recoverable.
  try {
    await releaseStatementClaims(tenantId, statementId, new Set(next.lines.map((l) => l.dealId)));
  } catch (err) {
    log.error('commission_claim_release_after_approve_failed', { tenantId, statementId, err: err instanceof Error ? err.message : String(err) });
  }
  return next;
}

/** The typed refusal for a deal another statement of the plan already committed. Names
 *  deals and periods only — never the other statement's id, which embeds its rep. */
export function dealAlreadyCommitted(statementId: string, deals: readonly ExcludedDeal[]): OpenwopError {
  return new OpenwopError('conflict', `${deals.length} deal(s) on this statement were already paid on another statement of the same plan. Recompute it so they are left off.`, 409, {
    reason: 'deal_already_committed', statementId, deals: deals.slice(0, 20),
  });
}

/** Mark an APPROVED statement paid (payout itself is external/demo — ADR 0280 §8).
 *  Idempotent on paid; refuses to skip approval (draft → paid). */
export async function markStatementPaid(tenantId: string, orgId: string, statementId: string, actor: string): Promise<CommissionStatement> {
  const s = await getStatementRaw(tenantId, orgId, statementId);
  if (!s) throw new OpenwopError('not_found', 'Statement not found.', 404, { statementId });
  if (s.status === 'paid') return s; // idempotent
  if (s.status !== 'approved') throw new OpenwopError('conflict', `Only an approved statement can be marked paid (this one is ${s.status}).`, 409, { statementId, status: s.status });
  // R2 COM2-M4 — the person who is PAID must not be the person who releases the payment.
  // Nothing checked it, and the same rule is enforced verbatim two files over for
  // challenge publication ("the resolver MUST differ from submittedBy").
  if (sameSubject(actor, s.subjectId)) {
    throw new OpenwopError('forbidden_scope', 'You cannot mark your own commission statement paid.', 403, { statementId });
  }
  // ADR 1034 D4 (grade-code H1) — the PAY gate holds the claims, not only the approval.
  // Re-claiming is idempotent for this statement; a deal another statement holds is a
  // refusal. So whatever happened to the claims between approval and payout, two statements
  // can never both be PAID for one deal of one plan.
  const { heldElsewhere } = await claimDeals(tenantId, orgId, s.planId, statementId, s.lines.map((l) => l.dealId), nowIso());
  if (heldElsewhere.length > 0) throw dealAlreadyCommitted(statementId, heldElsewhere.map((dealId) => ({ dealId, period: 'another period' })));
  const now = nowIso();
  // R2 COM2-M7 — the terminal money transition recorded NEITHER who settled it NOR when:
  // `void actor;` threw the payer away, and the only trace was a best-effort audit append
  // documented as unable to fail the mutation — i.e. it may simply not be there. Approve
  // stamps both; pay is the more consequential of the two.
  const next: CommissionStatement = { ...s, status: 'paid', paidBy: actor, paidAt: now, updatedAt: now };
  // …and the CAS is what stops TWO managers both flipping approved→paid in the same tick
  // and emitting two `host.commission.statement.paid` events for one payout — the row
  // would look right either way; the EVENT is what an external payroll consumer acts on.
  if (!(await statements.compareAndSwap(s, next))) {
    throw new OpenwopError('conflict', 'This statement changed while you were marking it paid. Reload and try again.', 409, { statementId });
  }
  return next;
}

/**
 * R2 COM2-M9 — GDPR subject erasure. Commissions held FOUR subject-keyed fields
 * (`CommissionStatement.subjectId` / `.approvedBy` / `.paidBy`, and
 * `CommissionPlan.assignment.ref` when `kind === 'rep'`) and registered nothing, so a rep
 * who left and filed a DSAR kept their id on every statement, readable through the
 * console and the analyst agent — and stayed a live PAYMENT TARGET on any plan assigned
 * to them. Neither ratchet could see it: the host gate scans `src/host`, and the feature
 * gate binds on a `userId: string` declaration, which none of these are.
 *
 * ADR 0464's taxonomy: a statement is a FINANCIAL record, so it is anonymized in place
 * (the totals must keep summing); a plan's rep ASSIGNMENT is a grant, so it is removed —
 * an erased person must not remain someone the system will pay.
 */
export async function eraseSubjectCommissions(tenantId: string, subjectKey: string): Promise<void> {
  const forms = subjectKeyForms(subjectKey).forms;
  for (const listed of await statements.listForTenantIndexed(tenantId)) {
    if (listed.tenantId !== tenantId) continue;
    // ADR 1034 D8 (grade-code H2) — every write below is a CAS on the row just read, so a
    // concurrent approve or pay can make one lose. A lost write is RETRIED on a fresh read
    // (bounded), never ignored: ignoring it left the old row, with the erased rep's id in
    // its key and fields, beside a re-keyed copy — two payout records, one un-erased.
    let st: CommissionStatement | null = listed;
    let done = false;
    for (let attempt = 0; st && attempt < 5; attempt += 1) {
      if (await eraseOneStatement(st, forms, tenantId)) { done = true; break; }
      st = await statements.get(st.statementId);
    }
    // Closing grade-code I3 — never give up silently: an unfinished erasure throws, so the
    // DSAR job retries instead of reporting success with the id still on a payout record.
    if (!done && st) throw new OpenwopError('conflict', 'A commission statement kept changing during erasure; retry the erasure.', 409, {});
  }
  await eraseClaimSubjects(tenantId, forms, `${ERASED_USER_REF}~orphan`);
}

/** One statement's erasure. Returns false when a CAS lost (re-read and retry). */
async function eraseOneStatement(st: CommissionStatement, forms: ReadonlySet<string>, tenantId: string): Promise<boolean> {
  const next = { ...st };
  let touched = false;
  const subjectErased = forms.has(st.subjectId);
  if (subjectErased) { next.subjectId = ERASED_USER_REF; touched = true; }
  if (st.approvedBy !== undefined && forms.has(st.approvedBy)) { next.approvedBy = ERASED; touched = true; }
  if (st.paidBy !== undefined && forms.has(st.paidBy)) { next.paidBy = ERASED; touched = true; }
  if (st.submittedBy !== undefined && forms.has(st.submittedBy)) { next.submittedBy = ERASED; touched = true; }
  if (!touched) return true;
  // R2 review — the first version rewrote four FIELDS and left the row KEY, which
  // literally embeds the erased person's user id (`planId:subjectId:period`). That key
  // is returned verbatim by the statements route, rendered by the console, serialised
  // to the analyst agent with the whole row, and sits in `approval.commissionStatement`
  // — where the approvals redactor covers `subjectId` and `proposal` but NOT
  // `statementId`. Erasure has to rekey, or it did not erase.
  if (!subjectErased) return statements.compareAndSwap(st, next);
  // ADR 1034 D8 — a UNIQUE id. `planId:<erased>:period` collided when two erased reps
  // shared a plan and period (a role or territory plan), and the second erasure's `put`
  // overwrote the first rep's approved or paid statement. Nothing re-derives a statement
  // id after erasure (`closePendingCommissionStatementApprovals` matches the `planId:`
  // prefix), so a random suffix is safe. Insert the new row, then CAS-delete the exact old
  // one; if that delete loses, take the new row back out and report the loss.
  const rekeyed = { ...next, statementId: statementId(st.planId, `${ERASED_USER_REF}~${randomUUID()}`, st.period) };
  if (!(await statements.compareAndSwap(null, rekeyed))) return false;
  if (!(await statements.compareAndDelete(st))) {
    await statements.compareAndDelete(rekeyed);
    return false;
  }
  await repointClaims(tenantId, st.statementId, rekeyed.statementId);
  await repointCommissionStatementApprovals(tenantId, st.statementId, rekeyed.statementId);
  return true;
}

/** R2 COM2-M4 — stamp the submitter on the row at submit time (the approval card is
 *  minted from the same request). Best-effort by shape: a draft that has moved on is not
 *  re-stamped, and a missing submitter degrades to "no self-approval check", never to a
 *  block on a legitimate approval. */
export async function recordStatementSubmitter(tenantId: string, orgId: string, statementId: string, actor: string): Promise<void> {
  // ADR 1034 D6 — a CAS that retries once. The plain `put` here could write a stale draft
  // over an approval that landed between this read and this write.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const s = await getStatementRaw(tenantId, orgId, statementId);
    if (!s || s.status !== 'draft') return;
    if (await statements.compareAndSwap(s, { ...s, submittedBy: actor, updatedAt: nowIso() })) return;
  }
}

/** Count a plan's APPROVED/PAID statements — financial records that must survive a
 *  plan delete (COMM-DATA-1). Lives here (not plan.ts) to avoid an import cycle. */
export async function planNonDraftStatementCount(tenantId: string, orgId: string, planId: string): Promise<number> {
  return scoped(await statements.listForTenantIndexed(tenantId), tenantId, orgId).filter((s) => s.planId === planId && s.status !== 'draft').length;
}

/** Delete a plan's DRAFT statements (recomputable — safe to cascade on plan delete). */
export async function deleteDraftStatementsForPlan(tenantId: string, orgId: string, planId: string): Promise<number> {
  let removed = 0;
  for (const s of scoped(await statements.listForTenantIndexed(tenantId), tenantId, orgId).filter((s) => s.planId === planId && s.status === 'draft')) {
    await statements.delete(s.statementId);
    await releaseStatementClaims(tenantId, s.statementId); // a deleted draft wants nothing
    removed += 1;
  }
  return removed;
}


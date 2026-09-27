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
import { quantizeMajor } from '../../../host/currencyUnits.js';
import { subjectKeyForms, ERASED, ERASED_USER_REF } from '../../../host/subjectErasureRedaction.js';

export type StatementStatus = 'draft' | 'approved' | 'paid';

export interface StatementLine {
  dealId: string;
  dealAmount: number;
  /** The effective rate applied (base or accelerated), in the rule's `type` units. */
  rate: number;
  commission: number;
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

const commissionFor = (rule: CommissionRule, dealAmount: number, rate: number): number =>
  rule.type === 'percentage' ? (dealAmount * rate) / 100 : rate; // fixed = flat per won deal

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

  const deals = (await listDeals(tenantId, orgId, {}, undefined)).filter((d) =>
    d.owner === subjectId
    && d.status === 'won'
    && periodContains(d.closeDate, period)
    // R2 COM2-M2 — `effectiveFrom`/`effectiveTo` were required, format-validated, and
    // ordered against each other on write… and never once read. A plan created in July
    // paid full commission on deals closed in Q1, and an expired plan kept paying
    // forever. The window is what makes a plan a plan.
    && withinPlanWindow(d.closeDate, plan));

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

  const lines: StatementLine[] = [];
  for (const rule of plan.rules) {
    let ruleTotal = 0;
    const ruleLines: StatementLine[] = [];
    const rate = effectiveRate(rule, attainmentPct);
    for (const d of deals) {
      const dealAmount = d.amount ?? 0;
      const commission = commissionFor(rule, dealAmount, rate);
      ruleTotal += commission;
      ruleLines.push({ dealId: d.dealId, dealAmount, rate, commission });
    }
    // Cap is per-rule on the rule's total; scale lines proportionally so the sum honors the cap.
    if (rule.cap !== undefined && ruleTotal > rule.cap && ruleTotal > 0) {
      const factor = rule.cap / ruleTotal;
      for (const l of ruleLines) l.commission = l.commission * factor;
    }
    lines.push(...ruleLines);
  }
  // R2 COM2-M1 — every figure here was raw float arithmetic (a rate division, then a
  // proportional cap rescale), so a statement stored `7500.000000000001` and a JPY plan
  // stored `6172.835` yen — not a representable amount in a currency with no minor unit.
  // The console then rendered it at `maximumFractionDigits: 0` and interpolated THAT into
  // the confirm on an action its own body calls unreversible.
  for (const l of lines) l.commission = quantizeMajor(l.commission, plan.currency);
  const total = quantizeMajor(lines.reduce((sum, l) => sum + l.commission, 0), plan.currency);

  const id = statementId(planId, subjectId, period);
  const existing = await statements.get(id);
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
    status: 'draft', // recompute always returns a draft (an approved statement must be re-approved)
    computedAt: now,
    updatedAt: now,
    ...(attainmentPct !== undefined ? { attainmentPct } : {}),
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
    throw new OpenwopError('conflict', 'This statement is already approved. Revoke the approval before recomputing it.', 409, { statementId: id, approvedBy: existing.approvedBy });
  }
  await statements.put(statement);
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
  if (!canSeeAll) rows = rows.filter((s) => s.subjectId === viewerSubject); // fail-closed: no viewer ⇒ nothing
  if (filter.subjectId) rows = rows.filter((s) => s.subjectId === filter.subjectId);
  if (filter.period) rows = rows.filter((s) => s.period === filter.period);
  if (filter.planId) rows = rows.filter((s) => s.planId === filter.planId);
  return rows.sort((a, b) => b.period.localeCompare(a.period) || a.subjectId.localeCompare(b.subjectId));
}

export async function persistStatement(s: CommissionStatement): Promise<void> {
  await statements.put(s);
}

/** Approve a DRAFT statement (ADR 0280 P3), stamping the approver. Idempotent on
 *  an already-approved statement; refuses a paid one. */
export async function approveStatement(tenantId: string, orgId: string, statementId: string, actor: string): Promise<CommissionStatement> {
  const s = await getStatementRaw(tenantId, orgId, statementId);
  if (!s) throw new OpenwopError('not_found', 'Statement not found.', 404, { statementId });
  if (s.status === 'approved') return s; // idempotent
  if (s.status !== 'draft') throw new OpenwopError('conflict', `Only a draft statement can be approved (this one is ${s.status}).`, 409, { statementId, status: s.status });
  const now = nowIso();
  const next: CommissionStatement = { ...s, status: 'approved', approvedBy: actor, approvedAt: now, updatedAt: now };
  // R2 COM2-M8 — a plain `put` is last-writer-wins on the two transitions that move
  // money. `compareAndSwap` is the documented `If-Match` equivalent on this collection
  // and was simply unused here.
  if (!(await statements.compareAndSwap(s, next))) {
    throw new OpenwopError('conflict', 'This statement changed while you were approving it. Reload and try again.', 409, { statementId });
  }
  return next;
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
  if (actor === s.subjectId) {
    throw new OpenwopError('forbidden_scope', 'You cannot mark your own commission statement paid.', 403, { statementId });
  }
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
  for (const st of await statements.listForTenantIndexed(tenantId)) {
    if (st.tenantId !== tenantId) continue;
    const next = { ...st };
    let touched = false;
    const subjectErased = forms.has(st.subjectId);
    if (subjectErased) { next.subjectId = ERASED_USER_REF; touched = true; }
    if (st.approvedBy !== undefined && forms.has(st.approvedBy)) { next.approvedBy = ERASED; touched = true; }
    if (st.paidBy !== undefined && forms.has(st.paidBy)) { next.paidBy = ERASED; touched = true; }
    if (st.submittedBy !== undefined && forms.has(st.submittedBy)) { next.submittedBy = ERASED; touched = true; }
    if (!touched) continue;
    // R2 review — the first version rewrote four FIELDS and left the row KEY, which
    // literally embeds the erased person's user id (`planId:subjectId:period`). That key
    // is returned verbatim by the statements route, rendered by the console, serialised
    // to the analyst agent with the whole row, and sits in `approval.commissionStatement`
    // — where the approvals redactor covers `subjectId` and `proposal` but NOT
    // `statementId`. Erasure has to rekey, or it did not erase.
    if (subjectErased) {
      const rekeyed = { ...next, statementId: statementId(st.planId, ERASED_USER_REF, st.period) };
      await statements.delete(st.statementId);
      await statements.put(rekeyed);
      continue;
    }
    await statements.put(next);
  }
}

/** R2 COM2-M4 — stamp the submitter on the row at submit time (the approval card is
 *  minted from the same request). Best-effort by shape: a draft that has moved on is not
 *  re-stamped, and a missing submitter degrades to "no self-approval check", never to a
 *  block on a legitimate approval. */
export async function recordStatementSubmitter(tenantId: string, orgId: string, statementId: string, actor: string): Promise<void> {
  const s = await getStatementRaw(tenantId, orgId, statementId);
  if (!s || s.status !== 'draft') return;
  await statements.put({ ...s, submittedBy: actor, updatedAt: nowIso() });
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
    removed += 1;
  }
  return removed;
}


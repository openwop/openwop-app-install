/**
 * Sales Territory Management — quotas + attainment (ADR 0272 Phase 3).
 *
 * Per-territory `Quota` (period + amount + optional per-rep `repSplits`) and a
 * territory ATTAINMENT report that reuses the CRM weighted-pipeline formula
 * (`Σ amount × stage.probability/100`) — computed HERE, in territories, over the
 * active/selected model's materialized assignments, rather than editing CRM's
 * `reportService` (keeps the crm→territories decoupling; the CRM report is
 * untouched and additive). Attainment rolls up the parent-child hierarchy.
 *
 * @see docs/adr/0272-sales-territory-management.md
 */

import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { validateQuota } from './rowGuards.js';
import { OpenwopError } from '../../../types.js';
import { cleanString, cleanOpaqueToken } from '../../../host/boundedStrings.js';
import { quantizeMajor } from '../../../host/currencyUnits.js';
import { resolveEffectiveAccess } from '../../../host/accessControlService.js';
import { listDeals } from '../../crm/entities/deals.js';
import { listPipelines } from '../../crm/entities/pipelines.js';
import { getModel, listTerritories } from './territories.js';
import { listAssignmentsForModel } from './assignment.js';
import { territoryVisibility } from '../visibility.js';

const PERIOD_RE = /^\d{4}-(Q[1-4]|(0[1-9]|1[0-2]))$/; // YYYY-Qn or YYYY-MM
const MAX = { perModelQuotas: 2000, repSplits: 200 };

export interface RepSplit {
  subjectId: string;
  amount: number;
}
export interface Quota {
  quotaId: string; // deterministic: `${modelId}:${territoryId}:${period}`
  tenantId: string;
  orgId: string;
  modelId: string;
  territoryId: string;
  period: string;
  amount: number;
  currency?: string;
  repSplits: RepSplit[];
  updatedAt: string;
}

const quotas = new DurableCollection<Quota>('crm:territory-quota', (q) => q.quotaId, validateQuota, (q) => q.tenantId);
const nowIso = (): string => new Date().toISOString();
const quotaId = (modelId: string, territoryId: string, period: string): string => `${modelId}:${territoryId}:${period}`;
const scoped = <T extends { tenantId: string; orgId: string }>(rows: T[], tenantId: string, orgId: string): T[] => rows.filter((r) => r.tenantId === tenantId && r.orgId === orgId);

function num(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) throw new OpenwopError('validation_error', `\`${field}\` must be a non-negative finite number.`, 400, { field });
  return raw;
}

// ── Quota CRUD (editable on any non-archived model) ──────────────────────────

async function requireEditableModel(tenantId: string, orgId: string, modelId: string): Promise<void> {
  const m = await getModel(tenantId, orgId, modelId);
  if (m.state === 'archived') throw new OpenwopError('validation_error', 'Quotas cannot be edited on an archived model.', 409, { modelId });
}

export async function listQuotas(tenantId: string, orgId: string, modelId: string, period?: string): Promise<Quota[]> {
  await getModel(tenantId, orgId, modelId); // IDOR
  return scoped(await quotas.listForTenantIndexed(tenantId), tenantId, orgId).filter((q) => q.modelId === modelId && (!period || q.period === period));
}

export async function setQuota(tenantId: string, orgId: string, modelId: string, territoryId: string, input: { period?: unknown; amount?: unknown; currency?: unknown; repSplits?: unknown }): Promise<Quota> {
  await requireEditableModel(tenantId, orgId, modelId);
  // territory must exist in this model (IDOR) — listTerritories is model+org scoped
  const terr = (await listTerritories(tenantId, orgId, modelId)).find((t) => t.territoryId === territoryId);
  if (!terr) throw new OpenwopError('not_found', 'Territory not found in this model.', 404, { territoryId });

  const period = cleanString(input.period, 8, '');
  if (!PERIOD_RE.test(period)) throw new OpenwopError('validation_error', '`period` must be YYYY-Qn or YYYY-MM.', 400, { period: input.period });
  const amount = num(input.amount, 'amount');
  let currency: string | undefined;
  if (input.currency !== undefined && input.currency !== '') {
    const cur = cleanString(input.currency, 8, '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) throw new OpenwopError('validation_error', '`currency` must be a 3-letter ISO-4217 code.', 400, { currency: input.currency });
    currency = cur;
  }
  // R2 TER2-B3 — an amount with no unit is not an amount of money. Round 1 stopped
  // the editor INVENTING `USD` (right: a default is a fabricated fact) but left the
  // blank option saveable, so the common outcome became a quota denominated in
  // nothing — which then propagates: the sales map cannot label it, and the ratio
  // below cannot tell agreement from mismatch. This is capture-at-intake, and it is
  // unbackfillable: nothing downstream can recover a unit the author never gave.
  // Rows written before this are untouched and still read (they just report their
  // ratio without a currency claim).
  if (amount > 0 && !currency) {
    throw new OpenwopError('validation_error', 'A quota amount needs a currency — pick one so attainment can be compared against the deals it is measured by.', 400, { field: 'currency' });
  }

  const repSplits: RepSplit[] = [];
  if (Array.isArray(input.repSplits)) {
    for (const raw of input.repSplits) {
      const r = raw as { subjectId?: unknown; amount?: unknown };
      const subjectId = cleanOpaqueToken(r.subjectId, 200);
      if (!subjectId) continue;
      repSplits.push({ subjectId, amount: num(r.amount, 'repSplits.amount') });
      if (repSplits.length >= MAX.repSplits) break;
    }
  }
  const existingCount = (await listQuotas(tenantId, orgId, modelId)).length;
  const id = quotaId(modelId, territoryId, period);
  if (existingCount >= MAX.perModelQuotas && !(await quotas.get(id))) throw new OpenwopError('validation_error', `This model has the maximum ${MAX.perModelQuotas} quotas.`, 409, { max: MAX.perModelQuotas });

  const quota: Quota = { quotaId: id, tenantId, orgId, modelId, territoryId, period, amount, repSplits, updatedAt: nowIso(), ...(currency ? { currency } : {}) };
  await quotas.put(quota);
  return quota;
}

export async function deleteQuota(tenantId: string, orgId: string, modelId: string, territoryId: string, period: string): Promise<void> {
  await requireEditableModel(tenantId, orgId, modelId);
  const id = quotaId(modelId, territoryId, period);
  const q = await quotas.get(id);
  if (!q || q.tenantId !== tenantId || q.orgId !== orgId) throw new OpenwopError('not_found', 'Quota not found.', 404, { territoryId, period });
  await quotas.delete(id);
}

/** Purge ALL quotas for a model (TERR-DATA-2 cascade, invoked before
 *  `deleteArchivedModel`). No lifecycle guard — the routes.ts purge already
 *  asserted the model is archived. Returns the row count removed. */
export async function deleteModelQuotas(tenantId: string, orgId: string, modelId: string): Promise<number> {
  let removed = 0;
  for (const q of scoped(await quotas.listForTenantIndexed(tenantId), tenantId, orgId).filter((q) => q.modelId === modelId)) {
    await quotas.delete(q.quotaId);
    removed += 1;
  }
  return removed;
}

// ── Attainment report ────────────────────────────────────────────────────────

export interface TerritoryAttainment {
  territoryId: string;
  name: string;
  parentTerritoryId: string | null;
  /** Explicit sales-map region (ADR 0282 §8) — rides through so the map can
   *  colour by mapping instead of name-matching. */
  regionId?: string;
  quota: number;
  currency?: string;
  /** Directly-assigned deals only. */
  direct: { weightedPipeline: number; won: number; openCount: number; wonCount: number };
  /** Self + all descendants (hierarchy rollup). */
  rolled: { weightedPipeline: number; won: number };
  /** TER-G1 — the deals behind `direct`/`rolled` span more than one currency, so
   *  those sums are not denominated in anything. No FX is applied; the console
   *  drops the currency symbol and says so. */
  currencyMixed?: boolean;
  /**
   * TER2-B1 — the currency the SUMS are actually in, set only when every
   * contributing deal agreed on one. `currency` above is the QUOTA's currency and
   * says nothing about the money that was won: round 1 compared the deals against
   * EACH OTHER and never against the quota, so a territory whose deals are all JPY
   * against a USD quota was neither `currencyMixed` nor mislabelled-by-its-own-rule
   * — it just rendered `¥12,000,000` with a `$`.
   */
  valueCurrency?: string;
  /** TER2-B1 — the sums ARE denominated, just not in the quota's currency, so the
   *  ratios below would divide unlike units. */
  quotaCurrencyMismatch?: boolean;
  /** TER2-B2 — with no `period` filter the quota is a SUM across periods, and those
   *  rows can each carry their own currency. When they disagree the total is not
   *  denominated in anything either, and `currency` is withheld. */
  quotaCurrencyMixed?: boolean;
  /** rolled.won / quota — null when it cannot be computed HONESTLY, not merely
   *  when the quota is 0. See `ratioUnavailable` for which case applies. */
  attainment: number | null;
  /** (rolled.won + rolled.weightedPipeline) / quota — same nullability as `attainment`. */
  coverage: number | null;
  /**
   * TER2-B1 — why `attainment`/`coverage` are null. A percentage is the number this
   * page exists to show, so "absent" must carry its reason or the reader supplies
   * their own (usually "no deals yet", which is the one case it never means).
   */
  ratioUnavailable?: 'no-quota' | 'mixed-deal-currencies' | 'mixed-quota-currencies' | 'quota-currency-mismatch';
  repSplits: Array<{ subjectId: string; quota: number; won: number; weightedPipeline: number }>;
}

/** Compute per-territory attainment for a model, rolled up the hierarchy. When
 *  `viewerSubject` is given (and lacks `host:territories:view-all`), the result is
 *  scoped to the territories that viewer can see (A2) — a rep sees their own
 *  territories' numbers, a manager their subtree, an admin/no-viewer the org. */
export async function computeAttainment(tenantId: string, orgId: string, modelId: string, period?: string, viewerSubject?: string): Promise<{ period: string | null; territories: TerritoryAttainment[]; unassigned: { weightedPipeline: number; won: number } }> {
  const [territories, assignments, deals, pipelines, modelQuotas] = await Promise.all([
    listTerritories(tenantId, orgId, modelId),
    listAssignmentsForModel(tenantId, orgId, modelId),
    listDeals(tenantId, orgId),
    listPipelines(tenantId, orgId),
    listQuotas(tenantId, orgId, modelId, period),
  ]);

  const stageProb = new Map<string, number>();
  for (const p of pipelines) for (const s of p.stages) if (s.stageId) stageProb.set(s.stageId, s.probability);
  const terrOfDeal = new Map<string, string>();
  for (const a of assignments) if (a.target === 'deal') terrOfDeal.set(a.recordId, a.territoryId);
  const quotaOfTerr = new Map<string, Quota>();
  // TER2-B2 — the merge below sums quota rows across periods. Each row carries its
  // OWN currency, and the old merge kept the FIRST row's while adding the rest, so a
  // 2026-Q1 quota of 100,000 USD and a 2026-Q2 quota of 100,000 EUR became a single
  // "200,000 USD" that nobody authored. Track the set instead and let a disagreement
  // withhold the symbol, exactly as the deal-side sum already does.
  // REVIEW B2/M1 — the first version tracked this set and then read the symbol off the
  // MERGED row, i.e. off whichever row the merge happened to see first: computed and
  // bypassed, the same shape as the defect it closes. Two rules the deal side already
  // had right and this one did not:
  //   - a ZERO-amount row cannot make a sum ambiguous (this file says exactly that
  //     about deals, ~40 lines down) — else a 0 EUR row nulls a 100,000 USD ratio;
  //   - a row with no currency but a real amount IS a disagreement when something else
  //     carries one. Round 1's blank option created that population, and adding
  //     50,000-of-unknown to 100,000 USD is precisely "a denominator nobody authored".
  // A LONE unit-less row stays silent, mirroring the deal-side stance that absence is
  // no evidence rather than disagreement — it just cannot claim a symbol.
  const NO_UNIT = '\u0000none';
  const quotaCurrencies = new Map<string, Set<string>>();
  for (const q of modelQuotas) {
    if (q.amount > 0) quotaCurrencies.set(q.territoryId, (quotaCurrencies.get(q.territoryId) ?? new Set()).add(q.currency ?? NO_UNIT));
    const existing = quotaOfTerr.get(q.territoryId);
    // sum across periods when no period filter; else the single matching row
    if (!existing) quotaOfTerr.set(q.territoryId, q);
    else quotaOfTerr.set(q.territoryId, { ...existing, amount: existing.amount + q.amount, repSplits: mergeSplits(existing.repSplits, q.repSplits) });
  }

  // TER-G1 — the sums below add raw deal `amount`s and NEVER consult the deal's
  // own currency, so a territory holding EUR and GBP deals produces a figure
  // that is not in any currency at all — and the console then labelled it with
  // the QUOTA's symbol. There is no FX in this app, so the honest move is not to
  // convert but to REPORT the ambiguity: track the distinct set of contributing
  // deal currencies so the reader can be told the figure is not denominated.
  interface Acc { weightedPipeline: number; won: number; openCount: number; wonCount: number; byOwner: Map<string, { won: number; weightedPipeline: number }>; currencies: Set<string> }
  const mkAcc = (): Acc => ({ weightedPipeline: 0, won: 0, openCount: 0, wonCount: 0, byOwner: new Map(), currencies: new Set() });
  const direct = new Map<string, Acc>(territories.map((t) => [t.territoryId, mkAcc()]));
  const unassigned = { weightedPipeline: 0, won: 0 };

  for (const d of deals) {
    if (!dealInPeriod(d.closeDate, period)) continue; // period-scoped report counts only deals closing in that period
    const terrId = terrOfDeal.get(d.dealId);
    const amount = d.amount ?? 0;
    const status = d.status ?? 'open';
    const weighted = amount * ((stageProb.get(d.stageId) ?? 0) / 100);
    const acc = terrId ? direct.get(terrId) : undefined;
    if (!acc) {
      if (status === 'won') unassigned.won += amount;
      else if (status === 'open') unassigned.weightedPipeline += weighted;
      continue;
    }
    if (status === 'won') { acc.won += amount; acc.wonCount += 1; }
    else if (status === 'open') { acc.weightedPipeline += weighted; acc.openCount += 1; }
    // Only deals that actually CONTRIBUTE a figure count toward the currency set
    // — a zero-amount or ignored-status deal cannot make a sum ambiguous.
    if ((status === 'won' || status === 'open') && amount !== 0 && d.currency) acc.currencies.add(d.currency);
    if (d.owner) {
      const o = acc.byOwner.get(d.owner) ?? { won: 0, weightedPipeline: 0 };
      if (status === 'won') o.won += amount;
      else if (status === 'open') o.weightedPipeline += weighted;
      acc.byOwner.set(d.owner, o);
    }
  }

  // hierarchy rollup: sum direct over self + descendants (incl. per-owner, so
  // rep splits reconcile with the rolled territory figures — P3 review M1).
  const children = new Map<string, string[]>();
  for (const t of territories) if (t.parentTerritoryId) children.set(t.parentTerritoryId, [...(children.get(t.parentTerritoryId) ?? []), t.territoryId]);
  type OwnerAgg = Map<string, { won: number; weightedPipeline: number }>;
  interface Rolled { weightedPipeline: number; won: number; byOwner: OwnerAgg; currencies: Set<string> }
  const mergeOwner = (into: OwnerAgg, from: OwnerAgg): void => {
    for (const [subj, v] of from) { const cur = into.get(subj) ?? { won: 0, weightedPipeline: 0 }; cur.won += v.won; cur.weightedPipeline += v.weightedPipeline; into.set(subj, cur); }
  };
  const rollCache = new Map<string, Rolled>();
  const roll = (id: string, seen: Set<string>): Rolled => {
    if (rollCache.has(id)) return rollCache.get(id)!;
    if (seen.has(id)) return { weightedPipeline: 0, won: 0, byOwner: new Map(), currencies: new Set() }; // cycle guard (acyclic-validated elsewhere)
    seen.add(id);
    const self = direct.get(id) ?? mkAcc();
    const byOwner: OwnerAgg = new Map();
    mergeOwner(byOwner, self.byOwner);
    let w = self.weightedPipeline;
    let won = self.won;
    const currencies = new Set(self.currencies);
    for (const c of children.get(id) ?? []) {
      const r = roll(c, seen);
      w += r.weightedPipeline; won += r.won; mergeOwner(byOwner, r.byOwner);
      // A parent inherits every currency in its subtree — the roll-up is exactly
      // where a single-currency child can become a mixed-currency parent.
      for (const cur of r.currencies) currencies.add(cur);
    }
    const res: Rolled = { weightedPipeline: w, won, byOwner, currencies };
    rollCache.set(id, res);
    return res;
  };

  /**
   * REVIEW I3 — the currency facts and the ratio are derived from a SPECIFIC pair of
   * sums, so they must be derived again when the sums are replaced. A member-only
   * viewer has `rolled` swapped for `direct` (they hold no grant on the child rows),
   * and the first pass left `currencyMixed` / `valueCurrency` / `quotaCurrencyMismatch`
   * / `ratioUnavailable` / the null percentage computed from the FULL subtree — so the
   * viewer saw single-currency USD figures beside a "mixed currencies" chip and a
   * missing percentage caused by deals they are not allowed to know exist. Round 1
   * started that with `currencyMixed`; the first version of round 2 made it four fields.
   */
  const facts = (currencies: Set<string>, quotaCurrencySet: Set<string>, quota: number): {
    valueCurrency?: string; currencyMixed: boolean; quotaCurrency?: string;
    quotaCurrencyMismatch: boolean; quotaCurrencyMixed: boolean;
    ratioUnavailable?: TerritoryAttainment['ratioUnavailable'];
  } => {
    const quotaCurrencyMixed = quotaCurrencySet.size > 1;
    const valueCurrency = currencies.size === 1 ? [...currencies][0] : undefined;
    // Read the SET, never the merged row.
    const sole = quotaCurrencySet.size === 1 ? [...quotaCurrencySet][0] : undefined;
    const quotaCurrency = sole === NO_UNIT ? undefined : sole;
    const quotaCurrencyMismatch = valueCurrency !== undefined && quotaCurrency !== undefined && valueCurrency !== quotaCurrency;
    // Every branch is a DIFFERENT false statement the old code made, each of which
    // printed as a confident percentage:
    //   mixed deal currencies  → a numerator that is not a quantity of anything
    //   mixed quota currencies → a denominator nobody authored
    //   mismatch               → EUR won ÷ USD quota, off by whatever FX would be
    // Deals carrying NO currency are deliberately not a mismatch: the CRM field is
    // optional and mostly unset, so treating absence as disagreement would blank the
    // ratio for nearly every real model. Named as a deferral.
    const ratioUnavailable: TerritoryAttainment['ratioUnavailable'] | undefined =
      quota <= 0 ? 'no-quota'
        : currencies.size > 1 ? 'mixed-deal-currencies'
          : quotaCurrencyMixed ? 'mixed-quota-currencies'
            : quotaCurrencyMismatch ? 'quota-currency-mismatch'
              : undefined;
    return { valueCurrency, currencyMixed: currencies.size > 1, quotaCurrency, quotaCurrencyMismatch, quotaCurrencyMixed, ratioUnavailable };
  };
  /** Stamp a row's currency facts + ratios from one pair of sums. */
  const stamp = (
    base: Omit<TerritoryAttainment, 'currencyMixed' | 'valueCurrency' | 'quotaCurrencyMismatch' | 'quotaCurrencyMixed' | 'ratioUnavailable' | 'attainment' | 'coverage' | 'currency'>,
    f: ReturnType<typeof facts>, sums: { weightedPipeline: number; won: number }, quota: number,
  ): TerritoryAttainment => {
    const ratio = (n: number): number | null => (f.ratioUnavailable ? null : round(n / quota, 4));
    return {
      ...base,
      ...(f.currencyMixed ? { currencyMixed: true as const } : {}),
      ...(f.valueCurrency ? { valueCurrency: f.valueCurrency } : {}),
      ...(f.quotaCurrencyMismatch ? { quotaCurrencyMismatch: true as const } : {}),
      ...(f.quotaCurrencyMixed ? { quotaCurrencyMixed: true as const } : {}),
      ...(f.ratioUnavailable ? { ratioUnavailable: f.ratioUnavailable } : {}),
      attainment: ratio(sums.won),
      coverage: ratio(sums.won + sums.weightedPipeline),
      // Withheld when the quota rows disagree — a summed quota across currencies is
      // no more denominated than a summed pipeline across currencies.
      ...(f.quotaCurrency ? { currency: f.quotaCurrency } : {}),
    };
  };

  const out: TerritoryAttainment[] = territories.map((t) => {
    const acc = direct.get(t.territoryId)!;
    const rolled = roll(t.territoryId, new Set());
    const q = quotaOfTerr.get(t.territoryId);
    const quota = q?.amount ?? 0;
    const repByOwner = new Map(q?.repSplits.map((s) => [s.subjectId, s.amount]) ?? []);
    const ownerIds = new Set<string>([...rolled.byOwner.keys(), ...repByOwner.keys()]);

    const quotaCurrencySet = quotaCurrencies.get(t.territoryId) ?? new Set<string>();
    const f = facts(rolled.currencies, quotaCurrencySet, quota);
    // The sums are quantised to the exponent of the currency they are actually in
    // (JPY has none; KWD has three) — `round(n, 2)` invented a precision for one and
    // dropped a digit from the other.
    const qz = (n: number): number => quantizeMajor(n, f.valueCurrency);

    return stamp({
      territoryId: t.territoryId,
      name: t.name,
      parentTerritoryId: t.parentTerritoryId,
      ...(t.regionId ? { regionId: t.regionId } : {}),
      quota: quantizeMajor(quota, f.quotaCurrency),
      direct: { weightedPipeline: qz(acc.weightedPipeline), won: qz(acc.won), openCount: acc.openCount, wonCount: acc.wonCount },
      rolled: { weightedPipeline: qz(rolled.weightedPipeline), won: qz(rolled.won) },
      // rep splits reflect the ROLLED owner performance (subtree), matching the
      // territory's rolled figures and the split quota that lives on this node.
      repSplits: [...ownerIds].map((subjectId) => ({ subjectId, quota: quantizeMajor(repByOwner.get(subjectId) ?? 0, f.quotaCurrency), won: qz(rolled.byOwner.get(subjectId)?.won ?? 0), weightedPipeline: qz(rolled.byOwner.get(subjectId)?.weightedPipeline ?? 0) })),
    }, f, rolled, quota);
  });

  // A2 — scope the report to the viewer's visible territories (unless view-all).
  // A scoped viewer never sees org-wide `unassigned` (it would leak other-territory pipeline).
  if (viewerSubject) {
    const access = await resolveEffectiveAccess(tenantId, { subject: viewerSubject, orgId });
    if (!access.scopes.includes('host:territories:view-all')) {
      const { visible, subtree } = territoryVisibility(territories, viewerSubject);
      // A member-only territory must NOT expose its child subtree's rolled pipeline
      // (the viewer has no row-level grant to those child deals) — show direct only.
      // A managed territory keeps the full rolled figures.
      const scoped = out
        .filter((t) => visible.has(t.territoryId))
        .map((t) => {
          if (subtree.has(t.territoryId)) return t;
          // REVIEW I3 — the sums are replaced, so everything DERIVED from them is
          // re-derived from the direct accumulator's own currency set. Otherwise the
          // row describes money this viewer is not allowed to see.
          const own = direct.get(t.territoryId)?.currencies ?? new Set<string>();
          const f = facts(own, quotaCurrencies.get(t.territoryId) ?? new Set<string>(), t.quota);
          const sums = { weightedPipeline: t.direct.weightedPipeline, won: t.direct.won };
          const {
            currencyMixed: _cm, valueCurrency: _vc, quotaCurrencyMismatch: _qm,
            quotaCurrencyMixed: _qx, ratioUnavailable: _ru, attainment: _a, coverage: _c,
            currency: _cur, ...base
          } = t;
          return stamp({ ...base, rolled: sums }, f, sums, t.quota);
        });
      return { period: period ?? null, territories: scoped, unassigned: { weightedPipeline: 0, won: 0 } };
    }
  }
  return { period: period ?? null, territories: out, unassigned: { weightedPipeline: round(unassigned.weightedPipeline), won: round(unassigned.won) } };
}

function mergeSplits(a: RepSplit[], b: RepSplit[]): RepSplit[] {
  const m = new Map<string, number>();
  for (const s of [...a, ...b]) m.set(s.subjectId, (m.get(s.subjectId) ?? 0) + s.amount);
  return [...m.entries()].map(([subjectId, amount]) => ({ subjectId, amount }));
}
function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Is a deal's `closeDate` (YYYY-MM-DD) within the report `period` (YYYY-Qn | YYYY-MM)?
 *  No period ⇒ all-time (true). An undated deal is excluded from a period-scoped
 *  report — otherwise attainment would divide all-time won by a period quota. */
function dealInPeriod(closeDate: string | undefined, period?: string): boolean {
  if (!period) return true;
  if (!closeDate || closeDate.length < 7) return false;
  const year = closeDate.slice(0, 4);
  const month = Number(closeDate.slice(5, 7));
  if (period.includes('Q')) return period.slice(0, 4) === year && Math.ceil(month / 3) === Number(period.slice(6));
  return period === closeDate.slice(0, 7);
}

/** R2 TER2-B4 — see `__territoriesForErasure`. Quota splits name a person, and
 *  an erasure reaches them by tenant, not by model. */
export async function __quotasForErasure(tenantId: string): Promise<Quota[]> {
  return (await quotas.listForTenantIndexed(tenantId)).filter((q) => q.tenantId === tenantId);
}
export async function __putQuotaForErasure(q: Quota): Promise<void> {
  await quotas.put(q);
}


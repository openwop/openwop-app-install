/**
 * Cross-channel budget reallocation as ONE approved plan (ADR 0952 D3, phase P3).
 *
 * No new spend math: `optimizeBudget` (intelligence.ts) stays the optimizer. This
 * module turns its platform-level recommendation into per-campaign budget ops,
 * asks for ONE approval over the whole plan, and applies it through the one ads
 * adapter (`updateBudget`):
 *
 *  - Every op's "from" is READ from the platform (`getCampaignBudget`); an op
 *    whose budget cannot be read is dropped with a reason, never guessed.
 *  - An increase a covering spend cap would not allow is dropped at propose time.
 *  - DECREASES FIRST. A decrease that fails (or whose budget moved since the
 *    proposal) skips every increase, so a part-way failure under-spends and
 *    never over-spends.
 *  - Apply re-reads each budget first: a budget changed elsewhere is
 *    `stale_budget`, never overwritten.
 *  - A plan is idempotent per (tenant, org, run, planHash): a retry returns the
 *    same plan and approval. Apply is claimed with a lease, so two callers do not
 *    both run it, and a crashed apply resumes, skipping ops already recorded ok.
 *  - A plan expires after 7 days; an expired plan never applies, whatever its
 *    approval says (budgets have moved since).
 *  - The existing one-click route writes the same record (source `route`), which
 *    closes ADR 0357's "applied/skipped outcomes stamp back" promise (finding P3).
 *
 * @see docs/adr/0952-paid-media-operations-and-spend-control.md
 */

import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import { createCampaignSpendApproval, getApproval } from '../../host/approvalService.js';
import { authorizeBudgetOps, listTenantDispatchRecords, type AdPlatform, type AdsAdapter, type UpdateBudgetResult } from '../../host/adsAdapter.js';
import { listRecords } from '../campaign-connectors/performanceService.js';
import { listCampaigns } from '../campaign-orchestration/campaignService.js';
import { optimizeBudget } from './intelligence.js';
import { capBlocksIncrease } from './spendCaps.js';

const log = createLogger('campaign-intel.reallocation');

export const PLAN_TTL_MS = 7 * 86_400_000;
const APPLY_LEASE_MS = 5 * 60_000;
/** Never propose a daily budget below this (minor units): a scale-down must not zero a campaign. */
const MIN_DAILY_MINOR = 100;
const REALLOC_PLATFORMS: readonly AdPlatform[] = ['meta', 'google'];

export interface ReallocationOp {
  platform: AdPlatform;
  adAccountId: string;
  campaignId: string;
  /** Display name from the dispatch ledger, when known (never used to join). */
  campaignName?: string;
  /** Read from the platform at propose time; `null` only on a `route` record. */
  fromDailyMinor: number | null;
  toDailyMinor: number;
}
export interface DroppedOp { platform: AdPlatform; adAccountId: string; campaignId: string; toDailyMinor?: number; reason: string }
export type PlanStatus = 'proposed' | 'approved' | 'applying' | 'applied' | 'partial' | 'rejected' | 'expired';
export interface OpResult { opIx: number; outcome: 'updated' | 'already_applied' | 'failed' | 'skipped'; error?: string; at: string }

export interface ReallocationPlan {
  key: string;
  planId: string;
  tenantId: string;
  orgId: string;
  campaignId?: string;
  source: { kind: 'optimizeBudget' | 'agent' | 'route'; recommendationHash: string };
  /** Decreases first, then increases. */
  ops: ReallocationOp[];
  dropped: DroppedOp[];
  /** sha256 of the canonical ops — what the approval approves. */
  planHash: string;
  status: PlanStatus;
  approvalId?: string;
  results: OpResult[];
  /** The principal who proposed it (tombstoned on erasure). */
  createdBy?: string;
  createdAt: string;
  expiresAt: string;
  claimedAt?: string;
  version: number;
}

const plans = new DurableCollection<ReallocationPlan>('campaign-intel:realloc-plan', (p) => `${p.tenantId}::${p.orgId}::${p.planId}`);
const planKey = (tenantId: string, orgId: string, planId: string): string => `${tenantId}::${orgId}::${planId}`;
const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const isIncrease = (op: ReallocationOp): boolean => op.fromDailyMinor !== null && op.toDailyMinor > op.fromDailyMinor;

/** Plans kept per org. The oldest TERMINAL plans past it are deleted (an open
 *  plan is never trimmed): a stamp-back per one-click apply would otherwise grow
 *  the store without bound. */
const PLAN_CAP = 200;
async function trimPlans(tenantId: string, orgId: string): Promise<void> {
  const all = await listPlans(tenantId, orgId); // newest first
  const excess = all.length - PLAN_CAP;
  if (excess <= 0) return;
  const terminal = all.filter((p) => p.status === 'applied' || p.status === 'partial' || p.status === 'rejected' || p.status === 'expired');
  for (const p of terminal.slice(-excess)) await plans.delete(p.key).catch(() => undefined);
}

export async function listPlans(tenantId: string, orgId: string): Promise<ReallocationPlan[]> {
  return (await plans.listByPrefix(`${tenantId}::${orgId}::`))
    .filter((p) => p.tenantId === tenantId && p.orgId === orgId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getPlan(tenantId: string, orgId: string, planId: string): Promise<ReallocationPlan | null> {
  const p = await plans.get(planKey(tenantId, orgId, planId)).catch(() => undefined);
  return p && p.tenantId === tenantId && p.orgId === orgId ? p : null;
}

// ── Propose ──────────────────────────────────────────────────────────────────

export interface ProposeInput {
  /** An upstream `budget-optimize` recommendation; recomputed when absent. */
  recommendation?: unknown;
  /** Explicit target budgets (an agent's proposal); wins over `recommendation`. */
  ops?: unknown;
  campaignId?: string;
  runId: string;
  actor?: string;
}
export type ProposeOutcome =
  | { outcome: 'proposed'; plan: ReallocationPlan }
  | { outcome: 'no_change'; dropped: DroppedOp[] };

interface Target { platform: AdPlatform; adAccountId: string; campaignId: string; campaignName?: string }

/** The org's dispatched platform campaigns, joined by brief id (never by name). */
async function orgTargets(tenantId: string, orgId: string, campaignId?: string): Promise<Target[]> {
  const briefIds = new Set((await listCampaigns(tenantId, orgId)).filter((c) => !campaignId || c.id === campaignId).map((c) => c.briefId));
  const seen = new Set<string>();
  const out: Target[] = [];
  for (const r of await listTenantDispatchRecords(tenantId)) {
    if (!r.briefId || !briefIds.has(r.briefId) || !r.adAccountId || !REALLOC_PLATFORMS.includes(r.platform)) continue;
    const k = `${r.platform}:${r.platformCampaignId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ platform: r.platform, adAccountId: r.adAccountId, campaignId: r.platformCampaignId, ...(r.campaignName ? { campaignName: r.campaignName } : {}) });
  }
  return out;
}

/** Platform → spend factor, from a recommendation's reallocations. Malformed rows are ignored. */
function factorsOf(rec: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const rows = (rec as { reallocations?: unknown })?.reallocations;
  if (!Array.isArray(rows)) return out;
  for (const r of rows as Array<{ platform?: unknown; currentSpend?: unknown; changeAmount?: unknown }>) {
    const cur = Number(r.currentSpend);
    const chg = Number(r.changeAmount);
    if (typeof r.platform !== 'string' || !Number.isFinite(cur) || cur <= 0 || !Number.isFinite(chg) || chg === 0) continue;
    out.set(r.platform, Math.max(0, (cur + chg) / cur));
  }
  return out;
}

export async function proposeReallocation(adapter: AdsAdapter, tenantId: string, orgId: string, input: ProposeInput, now = new Date()): Promise<ProposeOutcome> {
  const targets = await orgTargets(tenantId, orgId, input.campaignId);
  const dropped: DroppedOp[] = [];
  // Desired target budgets: explicit ops, or factors applied to live budgets.
  const wants: Array<Target & { to?: number; factor?: number }> = [];
  let sourceKind: ReallocationPlan['source']['kind'] = 'optimizeBudget';
  let recommendationHash: string;
  if (Array.isArray(input.ops)) {
    sourceKind = 'agent';
    recommendationHash = sha(input.ops);
    for (const raw of input.ops as Array<Record<string, unknown>>) {
      const t = targets.find((x) => x.platform === raw.platform && x.campaignId === raw.campaignId);
      const to = Number(raw.toDailyMinor);
      if (!t) { dropped.push({ platform: String(raw.platform) as AdPlatform, adAccountId: String(raw.adAccountId ?? ''), campaignId: String(raw.campaignId ?? ''), reason: 'not_an_org_campaign' }); continue; }
      if (!Number.isSafeInteger(to) || to <= 0) { dropped.push({ ...t, reason: 'invalid_budget' }); continue; }
      wants.push({ ...t, to });
    }
  } else {
    const rec = input.recommendation ?? optimizeBudget(await listRecords(tenantId, orgId, input.campaignId));
    recommendationHash = sha(rec);
    const factors = factorsOf(rec);
    for (const t of targets) {
      const f = factors.get(t.platform);
      if (f !== undefined) wants.push({ ...t, factor: f });
    }
  }

  const ops: ReallocationOp[] = [];
  for (const w of wants) {
    const target: Target = { platform: w.platform, adAccountId: w.adAccountId, campaignId: w.campaignId };
    const cur = await adapter.getCampaignBudget(target);
    if (cur.outcome !== 'ok') { dropped.push({ ...target, reason: `budget_unreadable:${'error' in cur ? cur.error : cur.outcome}` }); continue; }
    const from = cur.dailyBudgetMinor;
    const to = Math.max(MIN_DAILY_MINOR, w.to ?? Math.round(from * (w.factor ?? 1)));
    if (Math.abs(to - from) < Math.max(1, from * 0.01)) continue; // no material change
    if (to > from) {
      let block: Awaited<ReturnType<typeof capBlocksIncrease>>;
      try { block = await capBlocksIncrease(tenantId, { ...target, orgId }, to, now); }
      catch { dropped.push({ ...target, toDailyMinor: to, reason: 'cap_unreadable' }); continue; }
      if (block) { dropped.push({ ...target, toDailyMinor: to, reason: `${block.reason}:${block.capId}` }); continue; }
    }
    ops.push({ ...target, ...(w.campaignName ? { campaignName: w.campaignName } : {}), fromDailyMinor: from, toDailyMinor: to });
  }
  if (ops.length === 0) return { outcome: 'no_change', dropped };
  // Decreases first, then increases; stable within each.
  ops.sort((a, b) => Number(isIncrease(a)) - Number(isIncrease(b)) || a.platform.localeCompare(b.platform) || a.campaignId.localeCompare(b.campaignId));

  const planHash = sha(ops.map((o) => [o.platform, o.adAccountId, o.campaignId, o.fromDailyMinor, o.toDailyMinor]));
  // Idempotent per (run, planHash) while the plan is open. A FINISHED plan with the
  // same id (applied, partial, rejected, expired) is history: a new proposal gets
  // a fresh id chained from it, never the old record back.
  let planId = `rp_${sha([tenantId, orgId, input.runId, planHash]).slice(0, 24)}`;
  for (let hop = 0; hop < 8; hop++) {
    const existing = await getPlan(tenantId, orgId, planId);
    if (!existing) break;
    if (existing.status === 'proposed' || existing.status === 'approved' || existing.status === 'applying') return { outcome: 'proposed', plan: await ensureApproval(existing) };
    planId = `rp_${sha([tenantId, orgId, input.runId, planHash, existing.planId]).slice(0, 24)}`;
  }
  const plan: ReallocationPlan = {
    key: planKey(tenantId, orgId, planId), planId, tenantId, orgId, ...(input.campaignId ? { campaignId: input.campaignId } : {}),
    source: { kind: sourceKind, recommendationHash }, ops, dropped, planHash, status: 'proposed', results: [],
    ...(input.actor ? { createdBy: input.actor } : {}),
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(), version: 1,
  };
  await trimPlans(tenantId, orgId).catch(() => undefined);
  if (!(await plans.compareAndSwap(null, plan))) {
    const won = await getPlan(tenantId, orgId, planId);
    if (won) return { outcome: 'proposed', plan: await ensureApproval(won) };
  }
  return { outcome: 'proposed', plan: await ensureApproval(plan) };
}

function planTable(plan: ReallocationPlan): string {
  const fmt = (m: number | null): string => (m === null ? '?' : String(m));
  const rows = plan.ops.map((o, i) => `${i + 1}. ${o.platform} campaign ${o.campaignId} (account ${o.adAccountId}): daily ${fmt(o.fromDailyMinor)} → ${fmt(o.toDailyMinor)}${isIncrease(o) ? ' (increase)' : ' (decrease)'}`);
  const up = plan.ops.filter(isIncrease).reduce((s, o) => s + (o.toDailyMinor - (o.fromDailyMinor ?? 0)), 0);
  const down = plan.ops.filter((o) => !isIncrease(o)).reduce((s, o) => s + ((o.fromDailyMinor ?? 0) - o.toDailyMinor), 0);
  return [
    `REALLOCATE daily ad budgets (${plan.ops.length} change${plan.ops.length === 1 ? '' : 's'}; decreases apply first). Amounts are minor units of each ad account's currency.`,
    ...rows,
    `Net daily change: +${fmt(up)} / -${fmt(down)}.`,
    ...(plan.dropped.length ? [`Left out: ${plan.dropped.map((d) => `${d.platform} ${d.campaignId} (${d.reason})`).join('; ')}.`] : []),
    `Plan ${plan.planId}, hash ${plan.planHash.slice(0, 12)}. Expires ${plan.expiresAt}.`,
  ].join('\n');
}

/** One campaign-spend approval per plan, created after the plan row exists so a
 *  lost insert race never orphans an approval. Re-entrant. */
async function ensureApproval(plan: ReallocationPlan): Promise<ReallocationPlan> {
  if (plan.approvalId || plan.status !== 'proposed') return plan;
  const first = plan.ops[0];
  if (!first) return plan;
  const approval = await createCampaignSpendApproval({
    tenantId: plan.tenantId,
    spendKind: 'reallocation',
    platform: [...new Set(plan.ops.map((o) => o.platform))].join(','),
    adAccountId: first.adAccountId,
    dailyBudgetMinor: plan.ops.filter(isIncrease).reduce((s, o) => s + (o.toDailyMinor - (o.fromDailyMinor ?? 0)), 0),
    spendIdemKey: `realloc:${plan.planHash}`,
    proposal: planTable(plan),
  });
  const next: ReallocationPlan = { ...plan, approvalId: approval.approvalId, version: plan.version + 1 };
  if (await plans.compareAndSwap(plan, next)) return next;
  // Someone else attached one first: use theirs.
  return (await getPlan(plan.tenantId, plan.orgId, plan.planId)) ?? next;
}

// ── Apply ────────────────────────────────────────────────────────────────────

export type ApplyOutcome =
  | { outcome: 'applied' | 'partial' | 'rejected' | 'expired'; plan: ReallocationPlan }
  | { outcome: 'requires_approval'; approvalId: string; plan: ReallocationPlan }
  | { outcome: 'in_progress'; plan: ReallocationPlan }
  | { outcome: 'not_found' };

async function setStatus(plan: ReallocationPlan, status: PlanStatus): Promise<ReallocationPlan> {
  const next = { ...plan, status, version: plan.version + 1 };
  return (await plans.compareAndSwap(plan, next)) ? next : ((await getPlan(plan.tenantId, plan.orgId, plan.planId)) ?? plan);
}

export async function applyReallocation(adapter: AdsAdapter, tenantId: string, orgId: string, planId: string, now = new Date()): Promise<ApplyOutcome> {
  let plan = await getPlan(tenantId, orgId, planId);
  if (!plan) return { outcome: 'not_found' };
  if (plan.status === 'applied' || plan.status === 'partial' || plan.status === 'rejected' || plan.status === 'expired') return { outcome: plan.status, plan };
  if (now.getTime() > new Date(plan.expiresAt).getTime()) return { outcome: 'expired', plan: await setStatus(plan, 'expired') };
  plan = await ensureApproval(plan);
  const approval = plan.approvalId ? await getApproval(plan.approvalId) : null;
  if (!approval || approval.tenantId !== tenantId) return { outcome: 'requires_approval', approvalId: plan.approvalId ?? '', plan };
  if (approval.status === 'rejected') return { outcome: 'rejected', plan: await setStatus(plan, 'rejected') };
  if (approval.status !== 'approved') return { outcome: 'requires_approval', approvalId: approval.approvalId, plan };

  // CLAIM, with a lease: a crashed apply resumes after it; a live one is not doubled.
  if (plan.status === 'applying' && plan.claimedAt && now.getTime() - new Date(plan.claimedAt).getTime() < APPLY_LEASE_MS) return { outcome: 'in_progress', plan };
  const claimed: ReallocationPlan = { ...plan, status: 'applying', claimedAt: now.toISOString(), version: plan.version + 1 };
  if (!(await plans.compareAndSwap(plan, claimed))) return { outcome: 'in_progress', plan: (await getPlan(tenantId, orgId, planId)) ?? plan };
  plan = claimed;

  await authorizeBudgetOps(tenantId, approval.approvalId, plan.ops.map((o) => ({ platform: o.platform, adAccountId: o.adAccountId, campaignId: o.campaignId, dailyBudgetMinor: o.toDailyMinor })));
  const done = new Set(plan.results.filter((r) => r.outcome === 'updated' || r.outcome === 'already_applied').map((r) => r.opIx));
  let decreaseFailed = false;
  for (const [opIx, op] of plan.ops.entries()) {
    if (done.has(opIx)) continue;
    const up = isIncrease(op);
    let result: OpResult;
    if (up && decreaseFailed) {
      result = { opIx, outcome: 'skipped', error: 'skipped_after_decrease_failure', at: now.toISOString() };
    } else {
      result = await applyOp(adapter, tenantId, orgId, op, opIx, now);
      if (!up && result.outcome === 'failed') decreaseFailed = true;
    }
    plan = await recordResult(plan, result);
  }
  const allOk = plan.ops.every((_, i) => plan!.results.some((r) => r.opIx === i && (r.outcome === 'updated' || r.outcome === 'already_applied')));
  const final = await setStatus(plan, allOk ? 'applied' : 'partial');
  return { outcome: allOk ? 'applied' : 'partial', plan: final };
}

async function applyOp(adapter: AdsAdapter, tenantId: string, orgId: string, op: ReallocationOp, opIx: number, now: Date): Promise<OpResult> {
  const at = now.toISOString();
  const target = { platform: op.platform, adAccountId: op.adAccountId, campaignId: op.campaignId };
  const live = await adapter.getCampaignBudget(target);
  if (live.outcome !== 'ok') return { opIx, outcome: 'failed', error: `budget_unreadable:${'error' in live ? live.error : live.outcome}`, at };
  if (live.dailyBudgetMinor === op.toDailyMinor) return { opIx, outcome: 'already_applied', at };
  if (live.dailyBudgetMinor !== op.fromDailyMinor) return { opIx, outcome: 'failed', error: 'stale_budget', at };
  // ADR 0952 P1 — the propose-time cap check is days old by now. An increase is
  // re-checked against a CURRENT cap snapshot right before the write (stale,
  // unenforceable or out of headroom refuses), the same bar a launch meets.
  if (isIncrease(op)) {
    let block: Awaited<ReturnType<typeof capBlocksIncrease>>;
    try { block = await capBlocksIncrease(tenantId, { ...target, orgId }, op.toDailyMinor, now); }
    catch { return { opIx, outcome: 'failed', error: 'cap_unreadable', at }; }
    if (block) return { opIx, outcome: 'failed', error: `${block.reason}:${block.capId}`, at };
  }
  const r: UpdateBudgetResult = await adapter.updateBudget({ ...target, dailyBudgetMinor: op.toDailyMinor });
  if (r.outcome === 'updated') return { opIx, outcome: 'updated', at };
  return { opIx, outcome: 'failed', error: 'error' in r ? r.error : r.outcome, at };
}

async function recordResult(plan: ReallocationPlan, result: OpResult): Promise<ReallocationPlan> {
  let cur = plan;
  for (let attempt = 0; attempt < 3; attempt++) {
    const next: ReallocationPlan = { ...cur, results: [...cur.results.filter((r) => r.opIx !== result.opIx), result], version: cur.version + 1 };
    if (await plans.compareAndSwap(cur, next)) return next;
    const fresh = await getPlan(cur.tenantId, cur.orgId, cur.planId);
    if (!fresh) break;
    cur = fresh;
  }
  log.warn('reallocation result record lost a race three times', { planId: plan.planId, opIx: result.opIx });
  return cur;
}

// ── Stamp-back for the one-click route ───────────────────────────────────────

/** ADR 0357 §3 / finding P3 — the one-click `/recommendations/apply` route records
 *  its outcome in the SAME plan store. A preview records nothing. Never throws:
 *  the budget write already happened (or not) and the response must not depend
 *  on the audit row. */
export async function recordRouteApply(
  tenantId: string, orgId: string, actor: string | undefined,
  op: { platform: AdPlatform; adAccountId: string; campaignId: string; dailyBudgetMinor: number },
  result: UpdateBudgetResult, now = new Date(),
): Promise<void> {
  if (result.outcome === 'preview') return;
  try {
    const planId = `rr_${randomUUID()}`;
    const ops: ReallocationOp[] = [{ platform: op.platform, adAccountId: op.adAccountId, campaignId: op.campaignId, fromDailyMinor: null, toDailyMinor: op.dailyBudgetMinor }];
    const status: PlanStatus = result.outcome === 'updated' ? 'applied' : result.outcome === 'requires_approval' ? 'proposed' : 'partial';
    const plan: ReallocationPlan = {
      key: planKey(tenantId, orgId, planId), planId, tenantId, orgId,
      source: { kind: 'route', recommendationHash: sha(op) }, ops, dropped: [],
      planHash: sha(ops.map((o) => [o.platform, o.adAccountId, o.campaignId, o.fromDailyMinor, o.toDailyMinor])),
      status, ...(result.outcome === 'requires_approval' ? { approvalId: result.approvalId } : {}),
      results: result.outcome === 'requires_approval' ? [] : [{ opIx: 0, outcome: result.outcome === 'updated' ? 'updated' : 'failed', ...(result.outcome === 'updated' ? {} : { error: 'error' in result ? result.error : result.outcome }), at: now.toISOString() }],
      ...(actor ? { createdBy: actor } : {}),
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(), version: 1,
    };
    await plans.compareAndSwap(null, plan);
    await trimPlans(tenantId, orgId);
  } catch (e) {
    log.warn('reallocation route stamp-back failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

/** Tombstone the proposer on this tenant's plans (the plans are the client's spend record and are kept). */
export async function erasePlanCreators(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  let touched = 0;
  for (const p of await plans.listByPrefix(`${tenantId}::`)) {
    if (p.tenantId !== tenantId || !p.createdBy || !forms.has(p.createdBy)) continue;
    if (await plans.compareAndSwap(p, { ...p, createdBy: tombstone })) touched += 1;
  }
  return touched;
}

/** Test-only. */
export async function __clearReallocationPlans(): Promise<void> {
  await plans.__clear();
}

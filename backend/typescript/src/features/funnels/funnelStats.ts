/**
 * Funnel per-step analytics rollups (ADR 0294 / Funnel A, Phase 3) — a DERIVED
 * cache, never authoritative (the ADR 0211 doctrine): each rebuild fully
 * recomputes a funnel's day rows from the two sources of truth — the CDP
 * event spine (`funnel.step_viewed` / `funnel.step_completed`, Phase 2) and
 * commerce Orders carrying the `funnelRef` provenance stamp (the P3 contract,
 * wired at checkout by ADR 0296). Self-correcting: pruned events / refunded
 * orders simply produce smaller numbers on the next rebuild; stale day rows
 * for the funnel are deleted.
 *
 * Rebuilds run on the reservation/affinity sweep pattern (a feature-owned,
 * bounded, unref'd interval — no new scheduler primitive) and on demand from
 * the authed rebuild route.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { MIN_SESSIONS_PER_VARIANT } from '../../host/variantAssignment.js';
import type { LegacyResultHealth } from '../../host/experiments/legacyHealth.js';
import { projectLegacyResults, type SignificanceWithheld } from '../../host/experiments/legacyProjection.js';
import { foldDailyCells, readExperimentRollup, totalsByArm, writeExperimentRollup, type UnitObservation } from '../../host/experiments/rollup.js';
import { createLogger } from '../../observability/logger.js';
import { collectedEventsRetainedSince, listCollectedEvents, type CollectedEvent } from '../cdp/collectService.js';
import { listOrders } from '../commerce/commerceService.js';
import { getFunnel, listFunnels, listFunnelScopes, type Funnel, type StepExperiment } from './funnelsService.js';
import { resolveStepExperiment } from './stepExperimentsEngine.js';
import { tenantFeatureCheck } from '../../host/tenantFeatureGate.js';

const log = createLogger('funnels.stats');

export interface FunnelStepDayStat {
  /** DISTINCT consented visitors who viewed the step this day (VP-R2-1: raw
   *  event counts double-counted — the viewer's old double-load, refreshes,
   *  Back-and-forth, and the sink+/next completion pair all inflated them). */
  views: number;
  /** DISTINCT consented visitors who completed the step this day. */
  completions: number;
  revenue: number;
  orders: number;
  /** VP-R2-4 (the currency doctrine): revenue per ISO code. `revenue` remains
   *  the cross-currency SUM — a bare number the UI must render UNLABELLED with
   *  a note when more than one code appears here (never one code's symbol). */
  revenueByCurrency: Record<string, number>;
}

export interface FunnelDayStat {
  statId: string; // `${tenantId}:${orgId}:${funnelId}:${day}`
  tenantId: string;
  orgId: string;
  funnelId: string;
  /** UTC day, YYYY-MM-DD. */
  day: string;
  steps: Record<string, FunnelStepDayStat>;
  rebuiltAt: string;
}

const stats = new DurableCollection<FunnelDayStat>('funnels:stat', (s) => s.statId, undefined, (s) => s.tenantId);

/** How many recent CDP events one rebuild reads (newest-first). Demo-scale
 *  honest bound — older events age out of the rollup once past this window,
 *  which the analytics route discloses via `eventWindow`. */
const EVENT_WINDOW = 50_000;

const day = (iso: string): string => iso.slice(0, 10);
const blank = (): FunnelStepDayStat => ({ views: 0, completions: 0, revenue: 0, orders: 0, revenueByCurrency: {} });

/** Recompute every day row for ONE org's funnels (all of them, published or
 *  not — drafts with history keep their numbers). Returns rows written. */
export async function rebuildFunnelStats(tenantId: string, orgId: string): Promise<number> {
  const funnels = await listFunnels(tenantId, orgId);
  // NO empty early-return: an org whose LAST funnel was deleted still needs
  // the stale-row sweep below (GC-FN-1) — the derivation loops no-op naturally.
  const byId = new Map<string, Funnel>(funnels.map((f) => [f.funnelId, f]));

  // views/completions from the event spine
  const rows = new Map<string, FunnelDayStat>(); // statId → row
  const touch = (funnelId: string, d: string, stepId: string): FunnelStepDayStat => {
    const statId = `${tenantId}:${orgId}:${funnelId}:${d}`;
    let row = rows.get(statId);
    if (!row) {
      row = { statId, tenantId, orgId, funnelId, day: d, steps: {}, rebuiltAt: new Date().toISOString() };
      rows.set(statId, row);
    }
    return (row.steps[stepId] ??= blank());
  };
  // GC-FRM-2 — form-submit completions carry a `submissionId` idempotency key
  // (ADR 0332 sink): count each submission exactly once, however often its
  // event lands in the window (the GC-D1-1 never-double-fire discipline).
  const seenSubmissions = new Set<string>();
  // VP-R2-1 — count DISTINCT visitors per (step, day, type), not raw events:
  // raw counts were systematically inflated (the old client double-load
  // doubled views; a form submission emitted step_completed TWICE — sink +
  // /next). Route-emitted events always carry a consented vk, but the FORMS
  // SINK emits `visitor: ''` for unconsented submissions — those flow through
  // the per-event fallthrough below and are counted once via submissionId
  // (live, load-bearing code, not belt-and-braces).
  const seenVisitor = new Set<string>();
  // ADR 0949 P1b — one read of the tenant's events serves both rollups: the day
  // stats keep their disclosed window; experiment rollups use every event (E-2).
  const allEvents = await listCollectedEvents(tenantId, Number.MAX_SAFE_INTEGER);
  for (const evt of allEvents.slice(0, EVENT_WINDOW)) {
    if (evt.eventType !== 'funnel.step_viewed' && evt.eventType !== 'funnel.step_completed') continue;
    const p = evt.payload as { orgId?: unknown; funnelId?: unknown; stepId?: unknown; submissionId?: unknown; visitor?: unknown };
    if (p.orgId !== orgId || typeof p.funnelId !== 'string' || typeof p.stepId !== 'string') continue;
    if (!byId.has(p.funnelId)) continue; // deleted funnel — tolerate, no row
    if (evt.eventType === 'funnel.step_completed' && typeof p.submissionId === 'string' && p.submissionId) {
      if (seenSubmissions.has(p.submissionId)) continue;
      seenSubmissions.add(p.submissionId);
    }
    const d = day(evt.at);
    if (typeof p.visitor === 'string' && p.visitor) {
      const vkey = `${evt.eventType}|${p.funnelId}|${d}|${p.stepId}|${p.visitor}`;
      if (seenVisitor.has(vkey)) continue;
      seenVisitor.add(vkey);
    }
    const cell = touch(p.funnelId, d, p.stepId);
    if (evt.eventType === 'funnel.step_viewed') cell.views += 1;
    else cell.completions += 1;
  }

  // revenue/orders from funnelRef-stamped, non-canceled orders
  for (const order of await listOrders(tenantId, orgId)) {
    const ref = order.funnelRef;
    if (!ref || order.status === 'canceled' || !byId.has(ref.funnelId)) continue;
    const cell = touch(ref.funnelId, day(order.createdAt), ref.stepId);
    cell.orders += 1;
    const net = Math.max(0, order.total - (order.refundedAmount ?? 0));
    cell.revenue += net;
    const code = order.currency || 'USD';
    cell.revenueByCurrency[code] = (cell.revenueByCurrency[code] ?? 0) + net;
  }

  // write the recomputed set; drop stale day rows — BOTH a live funnel's days
  // that recomputed empty AND every row of a DELETED funnel (grade-data GC-FN-1:
  // the old byId.has() guard made deleted-funnel rows permanent orphans).
  const fresh = new Set(rows.keys());
  for (const existing of await stats.listForTenantIndexed(tenantId)) {
    if (existing.orgId === orgId && (!byId.has(existing.funnelId) || !fresh.has(existing.statId))) {
      await stats.delete(existing.statId);
    }
  }
  for (const row of rows.values()) await stats.put(row);
  // ADR 0949 P1b — the step experiments' daily rollups, from the same read.
  const retainedSince = await collectedEventsRetainedSince(tenantId);
  for (const f of funnels) {
    for (const step of f.steps) {
      const exp = await resolveStepExperiment(tenantId, orgId, f.funnelId, step.stepId, step.experiment);
      if (exp) await rebuildStepExperimentRollup(tenantId, orgId, step.stepId, exp, allEvents, retainedSince);
    }
  }
  return rows.size;
}

/** All day rows for one funnel (oldest day first). */
export async function getFunnelStats(tenantId: string, orgId: string, funnelId: string): Promise<FunnelDayStat[]> {
  return (await stats.listForTenantIndexed(tenantId))
    .filter((s) => s.orgId === orgId && s.funnelId === funnelId)
    .sort((a, b) => a.day.localeCompare(b.day));
}

export const FUNNEL_STATS_EVENT_WINDOW = EVENT_WINDOW;

// ── the rebuild sweep (reservation/affinity clone) ───────────────────────────
const POLL_MS = (() => {
  const raw = Number(process.env.OPENWOP_FUNNEL_STATS_REBUILD_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 15 * 60 * 1000; // default 15m
})();

/** ADR 0820 §7 / G10 — the toggle the stats sweep's compute belongs to. */
export const FUNNEL_STATS_FEATURE_ID = 'funnels';

/**
 * One rebuild pass per (tenant, org) that has at least one funnel — derived from
 * the funnels the tenant index already knows. ADR 0820 §7 / G10: only tenants
 * that may use `funnels` (toggle + plan); a lapsed tenant is skipped silently
 * (the stats READS were already gated, so this stops the compute). Returns the
 * number of scopes rebuilt.
 */
export async function sweepFunnelStats(): Promise<number> {
  const mayUse = tenantFeatureCheck(FUNNEL_STATS_FEATURE_ID);
  let rebuilt = 0;
  for (const scope of await listFunnelScopes()) {
    if (!(await mayUse(scope.tenantId))) continue;
    await rebuildFunnelStats(scope.tenantId, scope.orgId);
    rebuilt += 1;
  }
  return rebuilt;
}

let started = false;
export function startFunnelStatsSweep(): { stop: () => void } | null {
  if (started) return null;
  started = true;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await sweepFunnelStats();
    } catch (err) {
      log.warn('funnel stats rebuild failed', { error: err instanceof Error ? err.message : String(err) });
    } finally { running = false; }
  };
  const timer = setInterval(() => void tick(), POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  log.info('funnel stats sweep started', { pollMs: POLL_MS });
  return { stop: () => { clearInterval(timer); started = false; } };
}

// ── Step-experiment results (Phase 4; ADR 0949 P1b — over the daily rollup,
//    through the shared projection) ──────────────────────────────────────────

/** Per-unit observations for one step experiment: a unit is a consented visitor
 *  stamped with this experiment. Its arm and cohort day come from its FIRST
 *  stamped view; it converts if a stamped completion exists. A completion with
 *  no stamped view is not counted (the legacy projection counted it, which could
 *  report more conversions than sessions). */
export function stepExperimentUnits(events: readonly CollectedEvent[], stepId: string, experimentId: string): UnitObservation[] {
  const exposures = new Map<string, { arm: string; at: string }>();
  const converted = new Set<string>();
  for (const evt of events) {
    if (evt.eventType !== 'funnel.step_viewed' && evt.eventType !== 'funnel.step_completed') continue;
    const pl = evt.payload as { stepId?: unknown; visitor?: unknown; experiment?: { experimentId?: unknown; variant?: unknown } };
    if (pl.stepId !== stepId || pl.experiment?.experimentId !== experimentId) continue;
    if (typeof pl.visitor !== 'string' || !pl.visitor || typeof pl.experiment?.variant !== 'string') continue;
    if (evt.eventType === 'funnel.step_completed') { converted.add(pl.visitor); continue; }
    const seen = exposures.get(pl.visitor);
    if (!seen || evt.at < seen.at) exposures.set(pl.visitor, { arm: pl.experiment.variant, at: evt.at });
  }
  return [...exposures].map(([unit, e]) => ({ arm: e.arm, firstExposureAt: e.at, converted: converted.has(unit) }));
}

/** Coverage is complete unless the source purged events from the experiment's life. */
export function stepExperimentCoverage(exp: StepExperiment, retainedSince: string | null): 'complete' | 'partial' {
  return retainedSince && retainedSince > exp.createdAt ? 'partial' : 'complete';
}

export async function rebuildStepExperimentRollup(
  tenantId: string, orgId: string, stepId: string, exp: StepExperiment,
  events: readonly CollectedEvent[], retainedSince: string | null,
): Promise<void> {
  const cells = foldDailyCells(tenantId, orgId, exp.experimentId, stepExperimentUnits(events, stepId, exp.experimentId));
  await writeExperimentRollup(tenantId, orgId, exp.experimentId, cells,
    { coverage: stepExperimentCoverage(exp, retainedSince), sourceRetainedSince: retainedSince }, new Date().toISOString());
}

export interface StepVariantResult {
  key: string;
  pageId: string | null;
  weight: number;
  /** Distinct consented visitors served this variant (first stamped view). */
  sessions: number;
  /** Distinct visitors served this variant who completed the step. */
  conversions: number;
  conversionRate: number;
  zScore: number | null;
  significant: boolean | null;
  insufficientSample: boolean;
}

export interface StepExperimentResultsOut {
  experimentId: string;
  status: 'running' | 'stopped';
  baselineKey: string;
  minSessionsPerVariant: number;
  variants: StepVariantResult[];
  /** ADR 0949 P1b (E-2) — the result reads every retained event, and says
   *  whether the source purged any from the experiment's life. */
  coverage: { status: 'complete' | 'partial'; retainedSince: string | null; rebuiltAt: string | null };
  /** ADR 0949 P0 — the split check and the fixed-horizon notice. */
  health: LegacyResultHealth;
  /** ADR 0949 P0/P1b — set when `significant` is withheld for every variant:
   *  a broken split (`srm`) or a source that lost events (`coverage`). */
  significanceWithheld?: SignificanceWithheld;
}

export async function stepExperimentResults(tenantId: string, orgId: string, funnelId: string, stepId: string): Promise<StepExperimentResultsOut | null> {
  const funnel = await getFunnel(tenantId, orgId, funnelId);
  const step = funnel?.steps.find((st) => st.stepId === stepId);
  if (!funnel || !step) return null;
  const exp = await resolveStepExperiment(tenantId, orgId, funnelId, stepId, step.experiment);
  if (!exp) return null;
  // A read rebuilds this experiment's rollup (idempotent; the sweep keeps it warm).
  await rebuildStepExperimentRollup(tenantId, orgId, stepId, exp,
    await listCollectedEvents(tenantId, Number.MAX_SAFE_INTEGER), await collectedEventsRetainedSince(tenantId));
  const { cells, header } = await readExperimentRollup(tenantId, orgId, exp.experimentId);
  const totals = totalsByArm(cells);
  const projection = projectLegacyResults(
    exp.variants.map((v) => ({ key: v.key, weight: v.weight, sessions: totals.get(v.key)?.n ?? 0, conversions: totals.get(v.key)?.sum ?? 0 })),
    { coverageComplete: header?.coverage !== 'partial' },
  );
  return {
    experimentId: exp.experimentId, status: exp.status, baselineKey: exp.variants[0]!.key, minSessionsPerVariant: MIN_SESSIONS_PER_VARIANT,
    variants: projection.arms.map((a, i) => ({ ...a, pageId: exp.variants[i]!.pageId })),
    coverage: { status: header?.coverage ?? 'complete', retainedSince: header?.sourceRetainedSince ?? null, rebuiltAt: header?.rebuiltAt ?? null },
    health: projection.health,
    ...(projection.significanceWithheld ? { significanceWithheld: projection.significanceWithheld } : {}),
  };
}

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
import { MIN_SESSIONS_PER_VARIANT, Z_95, twoProportionZ } from '../../host/variantAssignment.js';
import { createLogger } from '../../observability/logger.js';
import { listCollectedEvents } from '../cdp/collectService.js';
import { listOrders } from '../commerce/commerceService.js';
import { getFunnel, listFunnels, listFunnelScopes, type Funnel } from './funnelsService.js';

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
  for (const evt of await listCollectedEvents(tenantId, EVENT_WINDOW)) {
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

let started = false;
export function startFunnelStatsSweep(): { stop: () => void } | null {
  if (started) return null;
  started = true;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      // Rebuild per (tenant, org) that has at least one funnel — derived from
      // the funnels the tenant index already knows.
      for (const scope of await listFunnelScopes()) {
        await rebuildFunnelStats(scope.tenantId, scope.orgId);
      }
    } catch (err) {
      log.warn('funnel stats rebuild failed', { error: err instanceof Error ? err.message : String(err) });
    } finally { running = false; }
  };
  const timer = setInterval(() => void tick(), POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  log.info('funnel stats sweep started', { pollMs: POLL_MS });
  return { stop: () => { clearInterval(timer); started = false; } };
}

// ── Step-experiment results (Phase 4 — a READ-TIME projection over the
//    stamped funnel events; the 0236 shape, the SHARED z-test) ────────────────

export interface StepVariantResult {
  key: string;
  pageId: string | null;
  weight: number;
  /** Distinct consented visitors served this variant (step_viewed). */
  sessions: number;
  /** Distinct visitors who completed the step under this variant. */
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
  eventWindow: number;
  variants: StepVariantResult[];
}

export async function stepExperimentResults(tenantId: string, orgId: string, funnelId: string, stepId: string): Promise<StepExperimentResultsOut | null> {
  const funnel = await getFunnel(tenantId, orgId, funnelId);
  const step = funnel?.steps.find((st) => st.stepId === stepId);
  const exp = step?.experiment;
  if (!funnel || !step || !exp) return null;
  const sessionsBy = new Map<string, Set<string>>();
  const conversionsBy = new Map<string, Set<string>>();
  for (const evt of await listCollectedEvents(tenantId, EVENT_WINDOW)) {
    if (evt.eventType !== 'funnel.step_viewed' && evt.eventType !== 'funnel.step_completed') continue;
    const pl = evt.payload as { stepId?: unknown; visitor?: unknown; experiment?: { experimentId?: unknown; variant?: unknown } };
    if (pl.stepId !== stepId || pl.experiment?.experimentId !== exp.experimentId) continue;
    if (typeof pl.visitor !== 'string' || typeof pl.experiment?.variant !== 'string') continue;
    const v = pl.experiment.variant;
    if (!sessionsBy.has(v)) { sessionsBy.set(v, new Set()); conversionsBy.set(v, new Set()); }
    if (evt.eventType === 'funnel.step_viewed') sessionsBy.get(v)!.add(pl.visitor);
    else conversionsBy.get(v)!.add(pl.visitor);
  }
  const baseline = exp.variants[0];
  const baseSessions = sessionsBy.get(baseline.key)?.size ?? 0;
  const baseConversions = conversionsBy.get(baseline.key)?.size ?? 0;
  const variants: StepVariantResult[] = exp.variants.map((v, i) => {
    const sessions = sessionsBy.get(v.key)?.size ?? 0;
    const conversions = conversionsBy.get(v.key)?.size ?? 0;
    const insufficientSample = sessions < MIN_SESSIONS_PER_VARIANT || (i > 0 && baseSessions < MIN_SESSIONS_PER_VARIANT);
    const z = i === 0 ? null : twoProportionZ(baseConversions, baseSessions, conversions, sessions);
    return {
      key: v.key, pageId: v.pageId, weight: v.weight,
      sessions, conversions,
      conversionRate: sessions > 0 ? conversions / sessions : 0,
      zScore: z,
      significant: i === 0 || insufficientSample || z === null ? null : Math.abs(z) >= Z_95,
      insufficientSample,
    };
  });
  return { experimentId: exp.experimentId, status: exp.status, baselineKey: baseline.key, minSessionsPerVariant: MIN_SESSIONS_PER_VARIANT, eventWindow: EVENT_WINDOW, variants };
}


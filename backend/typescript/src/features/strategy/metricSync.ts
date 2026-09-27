/**
 * KR metric sync (ADR 0231 §C3) — read each sourced KR's current value via the
 * app's EXISTING data owners and write it through the ONE check-in path with
 * `origin:'sync'` (confirmed by the standing `measure.source` authorization;
 * `checkIns.ts` refuses fail-closed when the source is absent).
 *
 * Source readers (day-1 honesty matrix, the ads.sync precedent):
 *   - crm-deal-total        → sum of Deal.amount in the source org (crm service)
 *   - analytics-conversions → summary.byType.conversion in the source org
 *   - commerce-revenue      → captured revenue net of refunds (paid/fulfilled/
 *                             partially_refunded totals minus refunded slice,
 *                             major units) in the source org, scoped to ONE
 *                             currency via `source.query` (STRAT-PK1)
 *   - bigquery              → NOT embedded here (would need a brokered SQL runner
 *                             in this owner). Composed as a CHAIN instead —
 *                             `bigquery.query` → `check-in mode:'sync'` — so the
 *                             human-configured source still authorizes the write;
 *                             `kind:'bigquery'` stays the authorization marker.
 * A per-KR read failure records a skip and continues (the run output IS the
 * sync-health view; no bespoke panel — ADR 0082 doctrine).
 *
 * Cross-feature service imports follow the established precedent
 * (strategyService already imports projects + priority-matrix services).
 */
import { createLogger } from '../../observability/logger.js';
import { quantizeMajor } from '../../host/currencyUnits.js';
import { listDeals } from '../crm/crmEntitiesService.js';
import { summarize } from '../analytics/analyticsService.js';
import { listOrders } from '../commerce/commerceService.js';
import { listStrategies } from './strategyService.js';
import { appendCheckIn } from './checkIns.js';
import type { Strategy, StrategyKeyResult } from './types.js';

const log = createLogger('features.strategy.metricSync');

export interface MetricSyncResult {
  synced: Array<{ strategyId: string; krId: string; value: number; source: string }>;
  skipped: Array<{ strategyId: string; krId: string; reason: string }>;
}

async function readSource(tenantId: string, kr: StrategyKeyResult): Promise<{ value?: number; reason?: string }> {
  const src = kr.measure?.source;
  if (!src) return { reason: 'no_source' };
  try {
    if (src.kind === 'crm-deal-total') {
      const deals = await listDeals(tenantId, src.orgId);
      return { value: deals.reduce((s, d) => s + (typeof d.amount === 'number' && Number.isFinite(d.amount) ? d.amount : 0), 0) };
    }
    if (src.kind === 'analytics-conversions') {
      const summary = await summarize(tenantId, src.orgId);
      // ANL-9 — the same correction the commerce-revenue arm below records: an org
      // whose beacon has recorded NOTHING (not installed, never consented, all
      // telemetry) cannot be measured, and a CONFIRMED 0 would read as "zero
      // conversions" rather than "not measuring". Zero conversions WITH traffic
      // is a real measurement and still reports.
      if (summary.total === 0) {
        return { reason: 'source_no_analytics_events: the analytics beacon has recorded no events for this org, so this KR cannot be measured (a confirmed 0 would read as a real measurement)' };
      }
      return { value: summary.byType.conversion };
    }
    if (src.kind === 'commerce-revenue') {
      // Captured revenue NET of refunds — the same definition commerce's own
      // reporter uses (GMV over paid/fulfilled/partially_refunded, minus the
      // refunded slice; `commerceService.ts` order-figures reducer). A
      // partially_refunded order was a real sale, so its total counts and only
      // its `refundedAmount` is netted out; a full refund lands in status
      // 'refunded' and is excluded. `Order.total`/`refundedAmount` are MAJOR
      // units — same unit a KR target reads (grade-code STRAT-PK1).
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const orders = await listOrders(tenantId, src.orgId);
      const captured = orders.filter((o) => o.status === 'paid' || o.status === 'fulfilled' || o.status === 'partially_refunded');
      // Money in different currencies is NOT additive (commerce's own reporter is
      // strictly per-currency). Scope to ONE currency: `source.query` names the
      // ISO code (the "source-specific selector"). Absent, auto-detect only when
      // the captured set is single-currency; a mixed set skips honestly rather
      // than writing a meaningless cross-currency sum to an executive KR.
      const want = typeof src.query === 'string' && src.query.trim() ? src.query.trim().toUpperCase() : undefined;
      const present = new Set(captured.map((o) => (o.currency ?? '').toUpperCase()));
      // R2 STR2-M2 — `want` came straight from `source.query`, which is stored as free
      // text (≤2000 chars) and validated NOWHERE. A mistyped code, or a catalogue that
      // migrated from USD to EUR, matched no order — so `revenue` was 0 and a CONFIRMED
      // check-in was written, nightly, against an executive KR. Zero is the one value
      // indistinguishable from a correct measurement: `computeStrategyProgress` reads it
      // as 0% and flips the verdict to at-risk. A source that names nothing must SKIP.
      if (want !== undefined && !/^[A-Z]{3}$/.test(want)) {
        return { reason: `source_currency_invalid: measure.source.query must be a 3-letter ISO currency code (got "${want}")` };
      }
      // CORRECTION (review): the `captured.length > 0` guard meant an org with NO captured
      // orders skipped the check entirely — so `revenue = 0` and a CONFIRMED check-in was
      // still written nightly, which is the exact failure this fix exists to close, in its
      // other half. A source that can measure nothing must SKIP, not report zero.
      if (want !== undefined && captured.length === 0) {
        return { reason: `source_no_captured_orders: nothing has been captured in ${want} yet, so this KR cannot be measured (a confirmed 0 would read as a real measurement)` };
      }
      if (want !== undefined && !present.has(want)) {
        return { reason: `source_currency_not_present: no captured order is in ${want} (this org has ${[...present].filter(Boolean).join(', ') || 'none'})` };
      }
      const currency = want ?? (present.size <= 1 ? [...present][0] ?? '' : undefined);
      if (currency === undefined) {
        return { reason: 'source_ambiguous_currency: set measure.source.query to an ISO currency code (org sells in multiple currencies)' };
      }
      const revenue = captured
        .filter((o) => (o.currency ?? '').toUpperCase() === currency)
        .reduce((s, o) => s + num(o.total) - (o.status === 'partially_refunded' ? num(o.refundedAmount) : 0), 0);
      // R2 STR2-M6 — `Math.round(n * 100) / 100` is the shape `quantizeMajor` exists to
      // replace, and the currency is in scope one line up: this dropped the fils digit on
      // every KWD sync and invented two decimals for JPY.
      return { value: quantizeMajor(revenue, currency) };
    }
    // bigquery is composed as a CHAIN pattern (bigquery.query → check-in
    // mode:'sync'), never embedded here — the `source.kind` stays the
    // authorization marker the chain-fed value validates against (ADR 0231 §C3).
    return { reason: 'source_unsupported' };
  } catch (err) {
    return { reason: `source_read_failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Sync every sourced KR across the tenant's ACTIVE shared strategies. */
export async function syncSourcedKrs(tenantId: string, actor: string): Promise<MetricSyncResult> {
  const out: MetricSyncResult = { synced: [], skipped: [] };
  const strategies = (await listStrategies(tenantId, { includeArchived: false }))
    .filter((s: Strategy) => s.scope !== 'user' && s.status === 'active');
  for (const s of strategies) {
    for (const o of s.objectives) {
      for (const kr of o.keyResults) {
        if (!kr.measure?.source) continue;
        const read = await readSource(tenantId, kr);
        if (read.value === undefined) {
          out.skipped.push({ strategyId: s.id, krId: kr.id, reason: read.reason ?? 'unknown' });
          continue;
        }
        try {
          await appendCheckIn({ strategy: s, krId: kr.id, value: read.value, origin: 'sync', actor });
          out.synced.push({ strategyId: s.id, krId: kr.id, value: read.value, source: kr.measure.source.kind });
        } catch (err) {
          out.skipped.push({ strategyId: s.id, krId: kr.id, reason: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }
  log.info('strategy_metric_sync', { tenantId, synced: out.synced.length, skipped: out.skipped.length });
  return out;
}

/**
 * ADR 0118 Phase 2 — per-(tenant, provider, model) token-usage rollup.
 *
 * A write-through aggregation of recorded provider usage (the dispatch returns
 * `usage:{inputTokens,outputTokens}`) into a per-model cumulative cache — the
 * source for the cost/usage admin dashboard. `recordUsage` is additive per call;
 * `getUsageRollup` reads the tenant slice. The dispatch-path call site (threading
 * usage out of the exchange) is Phase 2b; this owns the store + math so it is
 * unit-testable without the dispatch coupling.
 *
 * @see docs/adr/0118-llm-observability-otel.md
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { computeCostUsd } from '../../providers/usageEmitter.js';

export interface UsageRollup {
  tenantId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  updatedAt: string;
}

const rollups = new DurableCollection<UsageRollup>('usage:rollup', (r) => `${r.tenantId}:${r.provider}:${r.model}`);

export async function recordUsage(
  tenantId: string,
  input: { provider: string; model: string; inputTokens?: number; outputTokens?: number; at: string },
): Promise<UsageRollup> {
  const provider = input.provider || 'unknown';
  const model = input.model || 'unknown';
  const key = `${tenantId}:${provider}:${model}`;
  const cur = (await rollups.get(key)) ?? { tenantId, provider, model, inputTokens: 0, outputTokens: 0, calls: 0, updatedAt: input.at };
  const next: UsageRollup = {
    ...cur,
    inputTokens: cur.inputTokens + Math.max(0, input.inputTokens ?? 0),
    outputTokens: cur.outputTokens + Math.max(0, input.outputTokens ?? 0),
    calls: cur.calls + 1,
    updatedAt: input.at,
  };
  await rollups.put(next);
  return next;
}

export async function getUsageRollup(tenantId: string): Promise<UsageRollup[]> {
  return (await rollups.listByPrefix(`${tenantId}:`)).sort((a, b) =>
    (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens) || (a.model < b.model ? -1 : 1),
  );
}

/** A rollup row + its estimated USD cost (ADR 0118 Phase 5). */
export interface UsageRollupWithCost extends UsageRollup { costUsd: number }

/** The rollup enriched with a per-row cost ESTIMATE from the ONE cost source
 *  (`computeCostUsd`, the per-1M-token rate table). An unpriced model → 0 (honest:
 *  no fabricated cost). Read-only, pure given the stored rows. */
export async function getUsageRollupWithCost(tenantId: string): Promise<UsageRollupWithCost[]> {
  return (await getUsageRollup(tenantId)).map((r) => ({
    ...r,
    costUsd: Number((computeCostUsd(r.model, r.inputTokens, r.outputTokens) ?? 0).toFixed(6)),
  }));
}

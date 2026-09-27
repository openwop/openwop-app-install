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
import { createLogger } from '../../observability/logger.js';

const logger = createLogger('usage.rollup');

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

/** Matches `host/workflowBudgets.ts` — enough to absorb a realistic turn burst
 *  without spinning when a key is genuinely hot. */
const CAS_ATTEMPTS = 8;

export async function recordUsage(
  tenantId: string,
  input: { provider: string; model: string; inputTokens?: number; outputTokens?: number; at: string },
): Promise<UsageRollup> {
  const provider = input.provider || 'unknown';
  const model = input.model || 'unknown';
  const key = `${tenantId}:${provider}:${model}`;

  // UAC-3 (ADR 0695) — this was a plain read-modify-write, and the loss is TOTAL,
  // not occasional. MEASURED on the in-memory backend, SINGLE process: 50 concurrent
  // `recordUsage` calls for one (tenant, provider, model) produced `calls=1,
  // inputTokens=1` — 49 of 50 increments dropped, because every caller awaited the
  // same `get`, all read 0, and all wrote 1.
  //
  // The filed row said this "drops increments on a MULTI-INSTANCE deploy". That
  // understates it by the margin that matters: the interleave is the Node event loop,
  // so ONE instance serving concurrent chat turns already loses nearly everything.
  // `dispatchTurn.ts` fires this per turn, detached — exactly the concurrent shape.
  //
  // Shape copied from the closest in-repo sibling, `host/workflowBudgets.ts:192-222`
  // (a spend accumulator): bounded attempts, jittered backoff, RE-READ and REBUILD
  // inside the loop — `compareAndSwap` compares the WHOLE row by value, so a stale
  // `next` can never win — and a `warn` on exhaustion.
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise((res) => setTimeout(res, Math.random() * 25));
    const existing = (await rollups.get(key)) ?? null;
    const base: UsageRollup = existing ?? { tenantId, provider, model, inputTokens: 0, outputTokens: 0, calls: 0, updatedAt: input.at };
    const next: UsageRollup = {
      ...base,
      inputTokens: base.inputTokens + Math.max(0, input.inputTokens ?? 0),
      outputTokens: base.outputTokens + Math.max(0, input.outputTokens ?? 0),
      calls: base.calls + 1,
      updatedAt: input.at,
    };
    if (await rollups.compareAndSwap(existing, next)) return next;
  }

  // Exhausted. Do NOT return the last computed row: it was never persisted, and
  // returning it would be success-with-wrong-data — the reporting equivalent of the
  // success-with-empty failure this repo forbids on model paths. The only caller is
  // fire-and-forget (`dispatchTurn.ts` `void … .catch(…)`), so throwing cannot break
  // a chat turn; the `warn` here makes a systematic loss visible even though that
  // caller swallows the error.
  logger.warn('usage_rollup_contention', { key, attempts: CAS_ATTEMPTS });
  throw new Error(`usage rollup contention: ${key} lost ${CAS_ATTEMPTS} compare-and-swap attempts`);
}

export async function getUsageRollup(tenantId: string): Promise<UsageRollup[]> {
  return (await rollups.listByPrefix(`${tenantId}:`)).sort((a, b) =>
    (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens) || (a.model < b.model ? -1 : 1),
  );
}

/** A rollup row + its estimated USD cost (ADR 0118 Phase 5).
 *
 *  `costUsd` is ABSENT when the rate table has no entry for the model — the
 *  cost is unknown, not zero. */
export interface UsageRollupWithCost extends UsageRollup { costUsd?: number }

/** The rollup enriched with a per-row cost ESTIMATE from the ONE cost source
 *  (`computeCostUsd`, the per-1M-token rate table). Read-only, pure given the
 *  stored rows.
 *
 *  CORRECTION (2026-07-25, UX_UPGRADE-usage-analytics UA-G1). This used to map an
 *  unpriced model to `0`, and the docstring called that "honest: no fabricated
 *  cost". The intent was right and the conclusion was backwards: `0` IS a
 *  fabricated cost, and it is the single most consequential number to invent on
 *  a spend dashboard, because it is the only one that asserts the model was
 *  FREE. `computeCostUsd` returns `undefined` for "no rate for this model"; that
 *  distinction now survives to the client, which renders it as unknown rather
 *  than as $0.00. `host/workflowFleetStats.ts` already modelled unknown cost as
 *  `number | null` — this brings the rollup in line with it. */
export async function getUsageRollupWithCost(tenantId: string): Promise<UsageRollupWithCost[]> {
  return (await getUsageRollup(tenantId)).map((r) => {
    const cost = computeCostUsd(r.model, r.inputTokens, r.outputTokens);
    return { ...r, ...(cost === undefined ? {} : { costUsd: Number(cost.toFixed(6)) }) };
  });
}

/**
 * Cost emitter. Records per-node + per-run cost attributes onto the
 * active OTel span under the `openwop.cost.*` namespace.
 *
 * Sample-grade: stores totals in-process (no metering integration).
 * Real deployers wire to their billing pipeline (Stripe usage records,
 * BigQuery, etc.).
 *
 * Allowlist enforcement (`spec/v1/observability.md §"Cost attribution
 * attributes"`): when a caller passes arbitrary record fields, only
 * attribute names in `OPENWOP_COST_ATTRIBUTE_NAMES` are forwarded to the
 * span. Non-allowlisted keys — including credential-shaped values
 * smuggled under unfamiliar key names — are dropped. The sanitizer is a
 * pure function (`sanitizeCostForOtel`) so it can be unit-tested
 * independent of the OTel runtime, and the conformance suite asserts
 * against it end-to-end via the in-suite OTel collector.
 */

import { trace } from '@opentelemetry/api';
import {
  OPENWOP_COST_ATTRIBUTE_NAMES as SDK_OPENWOP_COST_ATTRIBUTE_NAMES,
  sanitizeCostAttributes,
} from '@openwop/openwop';
import { createLogger } from './logger.js';

const costLog = createLogger('observability.costEmitter');

/** Canonical allowlist of cost-attribute names per
 *  `spec/v1/observability.md §"Cost attribution attributes"`.
 *  Re-exported from the published SDK (`@openwop/openwop`) so the
 *  host runtime + the conformance suite + downstream packs share one
 *  source of truth. Mutating this list is a wire-shape change — needs
 *  an RFC. */
export const OPENWOP_COST_ATTRIBUTE_NAMES: readonly string[] = SDK_OPENWOP_COST_ATTRIBUTE_NAMES;

/** Pure-function sanitizer. Thin re-export of the SDK helper so host
 *  code keeps its existing import surface stable. */
export const sanitizeCostForOtel = sanitizeCostAttributes;

interface CostRecord {
  promptTokens?: number;
  completionTokens?: number;
  usdCost?: number;
  provider?: string;
  model?: string;
}

/** Back-compat shim for callers that pre-date the allowlist refactor
 *  (`aiProvidersHost.ts` still calls `emitCost` with the typed record).
 *  Maps the legacy field names onto the canonical attribute names and
 *  routes through the sanitizer. */
export function emitCost(record: CostRecord): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  const mapped: Record<string, unknown> = {};
  if (record.promptTokens != null) mapped['openwop.cost.tokens.input'] = record.promptTokens;
  if (record.completionTokens != null) mapped['openwop.cost.tokens.output'] = record.completionTokens;
  if (record.usdCost != null) mapped['openwop.cost.usd'] = record.usdCost;
  if (record.provider) mapped['openwop.cost.provider'] = record.provider;
  if (record.model) {
    // `model` is NOT in the cost allowlist — it's an AI-namespace
    // attribute. Emit it directly under `openwop.ai.model` so existing
    // dashboards keep working; it bypasses the cost sanitizer because
    // the allowlist is scoped to `openwop.cost.*` only.
    span.setAttribute('openwop.ai.model', record.model);
  }
  for (const [k, v] of Object.entries(sanitizeCostForOtel(mapped))) {
    span.setAttribute(k, v);
  }
}

/** Conformance-only entry point. Accepts an open-shape attribute map
 *  (typically driven by a fixture node — see `conformance.cost.emit`
 *  registered in `bootstrap/nodes.ts`) and writes ONLY the
 *  allowlisted, primitive-typed attributes onto the active span.
 *  Non-allowlisted keys are silently dropped per
 *  `spec/v1/observability.md §"Cost attribution attributes"` and the
 *  `cost-attribution-allowlist-redaction` SECURITY invariant. */
export function emitRawCostAttrs(attrs: Record<string, unknown>): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  for (const [k, v] of Object.entries(sanitizeCostForOtel(attrs))) {
    span.setAttribute(k, v);
  }
}

/** Per-run rollup keyed by runId. Process-local; same posture as the
 *  variables runtime (`host/variablesRuntime.ts`). Shape mirrors
 *  `schemas/run-snapshot.schema.json §metrics.openwopCost` — populated
 *  lazily as nodes emit cost attrs. Multi-provider runs report the
 *  LAST contributing call's `provider` / `model` per the schema. */
export interface CostRollup {
  usd?: number;
  tokens?: { input?: number; output?: number };
  model?: string;
  provider?: string;
  duration_ms?: number;
}
const runCostRollups = new Map<string, CostRollup>();

/** Apply a sanitized cost-attr map to the per-run rollup. Accumulates
 *  numeric tokens / usd / duration; overwrites string `provider` /
 *  `model` (last-write-wins per the schema's `description`).
 *
 *  Folds only the SUBSET of allowlisted keys that
 *  `run-snapshot.schema.json §metrics.openwopCost` declares: `usd`,
 *  `tokens.{input,output}`, `provider`, `model`, `duration_ms`.
 *  Deliberate omissions:
 *    - `openwop.cost.tokens.total` — derivable from input+output; the
 *      schema's `tokens` object only carries the two primitives.
 *    - `openwop.cost.currency` / `openwop.cost.estimated` — span-only
 *      attributes; the snapshot rollup omits them (clients that need
 *      them read OTel spans directly per the schema's `description`).
 *
 *  The sanitizer (`sanitizeCostForOtel`) accepts all seven allowlisted
 *  keys for span emission; the rollup folds the documented subset.
 *  The two surfaces are intentionally not 1:1. */
export function applyCostRollup(runId: string, sanitized: Record<string, number | string | boolean>): void {
  if (!runId) return;
  const cur = runCostRollups.get(runId) ?? {};
  for (const [k, v] of Object.entries(sanitized)) {
    if (k === 'openwop.cost.usd' && typeof v === 'number') {
      cur.usd = (cur.usd ?? 0) + v;
    } else if (k === 'openwop.cost.tokens.input' && typeof v === 'number') {
      cur.tokens = cur.tokens ?? {};
      cur.tokens.input = (cur.tokens.input ?? 0) + v;
    } else if (k === 'openwop.cost.tokens.output' && typeof v === 'number') {
      cur.tokens = cur.tokens ?? {};
      cur.tokens.output = (cur.tokens.output ?? 0) + v;
    } else if (k === 'openwop.cost.provider' && typeof v === 'string') {
      cur.provider = v;
    }
    // tokens.total / currency / estimated intentionally not folded —
    // see header docblock for the snapshot-vs-span surface split.
  }
  runCostRollups.set(runId, cur);
}

/** Snapshot for the run-snapshot projection. Returns `null` when no
 *  cost has been recorded — projectRunSnapshot then omits the field
 *  entirely (spec-allowed per `run-snapshot.schema.json §metrics`). */
export function snapshotCostRollup(runId: string): CostRollup | null {
  return runCostRollups.get(runId) ?? null;
}

/**
 * ADR 0476 §1 (+ grade-trio correction) — stamp DURABLE run cost at the run's
 * terminal transition (the ONE queryable cost record — fleet stats read run
 * rows, never event logs).
 *
 * TWO disjoint sources, summed:
 *  - the run's `provider.usage` events (RFC 0026) — the DURABLE record every
 *    real AI dispatch emits. This is instance-independent, so a cancel routed
 *    to a non-executor instance now stamps real spend (grade-data M4: the
 *    in-process-only fold silently zeroed cross-instance cancels; it also
 *    missed ALL real AI-node spend, whose only rollup writer was the
 *    conformance fixture node).
 *  - the in-process rollup (`applyCostRollup`) — the conformance
 *    `conformance.cost.emit` lane, which emits no `provider.usage` event.
 *
 * The write is `storage.mergeRunMetadata(..., { ifAbsentKey: 'costUsd' })` —
 * ONE atomic statement (grade-code H2: the previous whole-metadata
 * read-modify-write raced the connectionUse stamp and the retention-pin
 * route, the exact ADR 0024 lost-update class this program fixed twice
 * elsewhere), with never-overwrite folded into the same statement
 * (`workforceHistory` stamps first for workforce runs and stays
 * authoritative). Client-supplied values never survive to here:
 * `costUsd`/`costTokens`/`costByNode` are RESERVED_RUN_METADATA_KEYS.
 * Best-effort — a stamp failure must never affect the terminal transition,
 * but it is LOGGED (grade-code L8), never swallowed silently.
 *
 * ADR 0482 §1 — the SAME fold additionally aggregates per `nodeId` and writes
 * `costByNode: { [nodeId]: usd }` (top 8 nodes by spend + an `__other`
 * remainder, 6-decimal rounding) INSIDE the same atomic merge — the
 * never-overwrite key guards the pair, so a workforce-stamped run never gets
 * an orphan costByNode. Unattributed spend (rollup lane, events without a
 * nodeId) folds into `__other`; the field is written only when at least one
 * event attributed spend to a real node.
 *
 * Returns the run's total computed usd (0 when none) so the ADR 0482 §2
 * spend-day fold at the same terminal seam consumes the SAME figure without
 * a second event scan.
 */
export const COST_BY_NODE_TOP_N = 8;

export function aggregateCostByNode(
  perNode: ReadonlyMap<string, number>,
  unattributedUsd: number,
): Record<string, number> | null {
  if (perNode.size === 0) return null;
  const round6 = (n: number): number => Number(n.toFixed(6));
  const sorted = [...perNode.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, COST_BY_NODE_TOP_N);
  let other = unattributedUsd;
  for (const [, v] of sorted.slice(COST_BY_NODE_TOP_N)) other += v;
  const out: Record<string, number> = {};
  for (const [nodeId, v] of top) {
    const r = round6(v);
    // Review L1 — a top-8 entry that rounds to ≤0 folds into __other instead
    // of vanishing (sum(costByNode) must track costUsd, not drift under it).
    if (r > 0) out[nodeId] = r;
    else other += v;
  }
  const otherR = round6(other);
  if (otherR > 0) out.__other = otherR;
  return Object.keys(out).length > 0 ? out : null;
}

export async function stampRunCostOnTerminal(
  storage: {
    listEvents(runId: string, opts?: { fromSeq?: number; limit?: number }): Promise<readonly { type: string; nodeId?: string; payload?: unknown }[]>;
    mergeRunMetadata(runId: string, patch: Record<string, unknown>, opts?: { ifAbsentKey?: string }): Promise<boolean>;
  },
  runId: string,
): Promise<number> {
  try {
    let usd = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let sawTokens = false;
    // ADR 0482 §1 — per-node attribution rides the same single event scan.
    const perNode = new Map<string, number>();
    let unattributedUsd = 0;
    // Durable lane: fold the run's own provider.usage events (bounded read —
    // the event log is per-run and already capped by the executor's budgets).
    for (const ev of await storage.listEvents(runId, { limit: 5000 })) {
      if (ev.type !== 'provider.usage') continue;
      const p = (ev.payload ?? {}) as { costEstimateUsd?: unknown; inputTokens?: unknown; outputTokens?: unknown };
      if (typeof p.costEstimateUsd === 'number' && Number.isFinite(p.costEstimateUsd)) {
        usd += p.costEstimateUsd;
        if (typeof ev.nodeId === 'string' && ev.nodeId.length > 0) {
          perNode.set(ev.nodeId, (perNode.get(ev.nodeId) ?? 0) + p.costEstimateUsd);
        } else {
          unattributedUsd += p.costEstimateUsd;
        }
      }
      if (typeof p.inputTokens === 'number' && Number.isFinite(p.inputTokens)) { tokensIn += p.inputTokens; sawTokens = true; }
      if (typeof p.outputTokens === 'number' && Number.isFinite(p.outputTokens)) { tokensOut += p.outputTokens; sawTokens = true; }
    }
    // In-process lane (conformance fixture node — no provider.usage event).
    const rollup = runCostRollups.get(runId);
    if (rollup) {
      usd += rollup.usd ?? 0;
      unattributedUsd += rollup.usd ?? 0;
      if (rollup.tokens) {
        tokensIn += rollup.tokens.input ?? 0;
        tokensOut += rollup.tokens.output ?? 0;
        sawTokens = true;
      }
    }
    if (usd <= 0 && !sawTokens) return 0;
    const costByNode = aggregateCostByNode(perNode, unattributedUsd);
    const wrote = await storage.mergeRunMetadata(runId, {
      ...(usd > 0 ? { costUsd: Number(usd.toFixed(6)) } : {}),
      ...(sawTokens ? { costTokens: { input: tokensIn, output: tokensOut } } : {}),
      ...(costByNode ? { costByNode } : {}),
    }, { ifAbsentKey: 'costUsd' });
    // ADR 0482 review C1 — the return is the FOLD TICKET: the budget counter
    // consumes only spend this call actually WROTE. A skipped merge (an
    // earlier writer stamped — a raced cancel, a crash-retry re-dispatch, the
    // workforce demo lane) returns 0, so one run can never fold twice. The
    // counter therefore mirrors the WRITTEN stamp exactly (a cancel-time
    // partial figure stays the counted truth — under-counting the post-cancel
    // remainder is the disclosed trade against double-counting).
    // Return the ROUNDED figure (data-grade LOW-2) so the spend counter is a
    // byte-exact projection of Σ costUsd stamps, not a sub-µ$-drifting sum.
    return wrote && usd > 0 ? Number(usd.toFixed(6)) : 0;
  } catch (err) {
    costLog.warn('run_cost_stamp_failed', { runId, error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

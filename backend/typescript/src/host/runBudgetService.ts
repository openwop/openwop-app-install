/**
 * Run budget guardrails — ONE atomic (bucket, window) counter, two consumers.
 *
 * The mechanism is a storage-backed atomic upsert (`consumeRunBudget` →
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING count`), so every limit here holds
 * across the max-instance fleet — the only counter in the host that does.
 *
 * 1. **Autonomous-run budget** (per tenant, rolling window). The scheduler +
 *    heartbeat daemons fire runs on their own — without a ceiling, a
 *    misconfigured cadence or a large fleet could spawn runs (and model spend)
 *    without bound. Ordinary human-initiated runs ("Run now", "Check now",
 *    kanban drags, POST /v1/runs) are never throttled here.
 *
 * 2. **Deep-investigation budget** (per conversation/room, rolling window) —
 *    XCH-GRP-3, 2026-07-15. The DELIBERATE exception to rule 1's
 *    "humans are never throttled": a deep @mention is human-initiated but
 *    dispatches a whole tool-running agent run (~15x the tokens of a chat turn
 *    — Anthropic's published multi-agent figure), so a mention-storm in one room
 *    is a real burst. Over budget DEGRADES to the normal inline turn (the user
 *    still gets an answer, with an honest marker) — it never fails the turn.
 *
 * Limits + windows are env-configurable; `<= 0` disables a cap (unlimited).
 * Defaults: 120 autonomous runs / 1h / tenant · 5 deep runs / 1h / room.
 *
 * @see src/host/scheduleDaemon.ts, src/host/heartbeatService.ts — consumer (1)
 * @see src/host/conversationExchange.ts — consumer (2)
 */

import type { Storage } from '../storage/storage.js';

export interface RunBudgetConfig {
  /** Max autonomous runs per tenant per window. <= 0 ⇒ unlimited. */
  limit: number;
  /** Rolling window length in ms. */
  windowMs: number;
}

function defaultConfig(): RunBudgetConfig {
  const limit = Number(process.env.OPENWOP_AUTONOMOUS_RUN_LIMIT);
  const windowMs = Number(process.env.OPENWOP_AUTONOMOUS_RUN_WINDOW_MS);
  return {
    limit: Number.isFinite(limit) ? limit : 120,
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 3_600_000,
  };
}

/** ADR 0717 D1 — the env/default autonomous-run cap, exposed so a degraded config
 *  read can fail to the TIGHTER of {last-known-good admin limit, env default} instead
 *  of silently dropping an operator's tightened cap back to the default. */
export function defaultRunBudgetLimit(): number {
  return defaultConfig().limit;
}

/** ADR 0318 — a budget config that overrides only the limit (runs/window),
 *  keeping the env/default window. Used by the heartbeat-admin runtime override
 *  (`runBudgetPerHour`). `<= 0` ⇒ unlimited (same rule as the env cap). */
export function runBudgetConfigWithLimit(limit: number): RunBudgetConfig {
  return { limit, windowMs: defaultConfig().windowMs };
}

export interface BudgetDecision {
  allowed: boolean;
  current: number;
  limit: number;
}

/**
 * Atomically consume one unit of `tenantId`'s autonomous-run budget for the
 * current window and decide whether the run may proceed. Consuming on every
 * check (including denials) is intentional: it keeps the decision a single
 * atomic write (no read-then-write race across instances); over-budget denials
 * just keep the counter climbing until the window rolls over.
 *
 * `cfg` overrides the env-derived config (tests pass it explicitly).
 */
export async function checkAutonomousRunBudget(
  storage: Storage,
  tenantId: string,
  now: number = Date.now(),
  cfg: RunBudgetConfig = defaultConfig(),
): Promise<BudgetDecision> {
  return consumeBudget(storage, tenantId, now, cfg);
}

/** The ONE consume-and-decide step both budgets share: quantize the window,
 *  key the bucket, atomically consume, compare. `bucketPrefix` namespaces a
 *  budget's rows inside the shared `run_budget` table — no schema change, and
 *  two budgets can never share a counter. */
async function consumeBudget(
  storage: Storage,
  scopeKey: string,
  now: number,
  cfg: RunBudgetConfig,
  bucketPrefix = '',
): Promise<BudgetDecision> {
  if (cfg.limit <= 0) return { allowed: true, current: 0, limit: cfg.limit }; // unlimited
  const windowStart = Math.floor(now / cfg.windowMs) * cfg.windowMs;
  // GEN-1c — this bucket shape (`${tenant}:${ws}` / `deep:${tenant}:${conv}:${ws}`)
  // is what tenant fold + teardown match on; `run_budget` has no tenant_id column.
  // Keep in sync with `storage/tenantMigration.ts` `runBudgetBucketBelongsTo`.
  const bucket = `${bucketPrefix}${scopeKey}:${windowStart}`;
  const current = await storage.consumeRunBudget(bucket, windowStart);
  return { allowed: current <= cfg.limit, current, limit: cfg.limit };
}

/** XCH-GRP-3 — the DEEP-INVESTIGATION budget config (per room, per window).
 *  `OPENWOP_DEEP_RUN_LIMIT_PER_ROOM <= 0` ⇒ unlimited (the env convention). */
export function deepRunBudgetConfig(): RunBudgetConfig {
  const limit = Number(process.env.OPENWOP_DEEP_RUN_LIMIT_PER_ROOM);
  const windowMs = Number(process.env.OPENWOP_DEEP_RUN_WINDOW_MS);
  return {
    limit: Number.isFinite(limit) ? limit : 5,
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 3_600_000,
  };
}

/**
 * XCH-GRP-3 — atomically consume one unit of THIS ROOM's deep-investigation
 * budget and decide whether the @mention may dispatch a tool-running agent run.
 *
 * Scoped per CONVERSATION, not per tenant: the burst shape this guards is a
 * mention-storm inside one room (an advisory board where a user @-mentions five
 * deep advisors), which a tenant-wide counter would either miss or over-block.
 *
 * Consumes on denial for the same reason the autonomous budget does (one atomic
 * write, no read-then-write race across the fleet). That is safe HERE because a
 * denial degrades to the inline turn rather than rejecting the user — an
 * over-budget room keeps answering, just without dispatching more deep runs
 * until the window rolls.
 */
export async function checkDeepInvestigationBudget(
  storage: Storage,
  tenantId: string,
  conversationId: string,
  now: number = Date.now(),
  cfg: RunBudgetConfig = deepRunBudgetConfig(),
): Promise<BudgetDecision> {
  return consumeBudget(storage, `${tenantId}:${conversationId}`, now, cfg, 'deep:');
}

/** Best-effort prune of budget rows for windows older than the current one.
 *  Called opportunistically from the daemon ticks. */
export async function pruneRunBudget(
  storage: Storage,
  now: number = Date.now(),
  cfg: RunBudgetConfig = defaultConfig(),
  deepCfg: RunBudgetConfig = deepRunBudgetConfig(),
): Promise<number> {
  // The `run_budget` table is now SHARED by both budgets (XCH-GRP-3), so the
  // cutoff must protect BOTH. Two bugs this guards against:
  //  1. Growth: early-returning when the AUTONOMOUS cap is disabled would leave
  //     deep rows unpruned forever (they are written independently of it).
  //  2. Leak: pruning at the autonomous window boundary would DELETE a live
  //     deep row whenever the deep window is longer, silently resetting the
  //     deep counter every autonomous window — a budget that never enforces.
  // So: prune strictly below the EARLIEST live window start of any ENABLED
  // budget; if every budget is disabled, nothing is being written, so the
  // safe cutoff is the earliest of the two configured windows anyway.
  const liveStarts: number[] = [];
  if (cfg.limit > 0) liveStarts.push(Math.floor(now / cfg.windowMs) * cfg.windowMs);
  if (deepCfg.limit > 0) liveStarts.push(Math.floor(now / deepCfg.windowMs) * deepCfg.windowMs);
  if (liveStarts.length === 0) {
    // Both disabled ⇒ no new rows, but historical rows must still drain.
    liveStarts.push(Math.floor(now / Math.max(cfg.windowMs, deepCfg.windowMs)) * Math.max(cfg.windowMs, deepCfg.windowMs));
  }
  const cutoff = Math.min(...liveStarts);
  try {
    return await storage.pruneRunBudget(cutoff);
  } catch {
    return 0;
  }
}

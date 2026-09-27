/**
 * ADR 0482 — per-workflow daily spend counter + budgets + alerts + hard cap.
 *
 * Two stores:
 *  - `workflow:spend-day` — `${tenantId}:${enc(workflowId)}:${day}` →
 *    `{ usd, alerted80, alerted100 }`. CAS-folded at the run-terminal seam
 *    (beside `stampRunCostOnTerminal` — the fold consumes the SAME usd the
 *    stamp computed, so counter↔stamp divergence is bounded by dropped-on-
 *    contention increments, disclosed in the ADR). ALL terminal spend counts —
 *    production, debug, eval, cancelled: the segmentation doctrine governs
 *    OUTCOME statistics, never money (the `costDaily` doctrine; FE disclosure).
 *  - `workflow:budget` — `${tenantId}:${enc(workflowId)}` →
 *    `{ dailyUsd, hardCap, updatedBy, updatedAt }`, owner-gated GET/PUT
 *    (routes/workflowBudgets.ts).
 *
 * Alerts (ADR 0482 §4): crossing 80%/100% of `dailyUsd` with the counter
 * row's flag unset CAS-sets the flag ON THE SAME ROW AS THE SPEND FOLD, so
 * "once per threshold per day" holds BY CONSTRUCTION (one CAS covers both).
 * The notification is a tenant BROADCAST (`openwop-app.workflow.budget-alert`, bell/inbox
 * only — the ADR 0478 email chokepoint picks up only ADDRESSED records).
 *
 * Hard cap (ADR 0482 §5): `workflowBudgetExhausted` is checked at
 * `startWorkflowRun` and `POST /v1/runs` ONLY. It is deliberately NOT checked
 * in `subWorkflowDispatcher` (blocking a child strands a mid-flight parent —
 * worse than one overspent child), nor in the debug-run / eval-run / redrive
 * routes (diagnostic spend stays unblocked — those lanes carry their own
 * `debug`/`eval` stamps and the redrive route is a recovery path). FAIL-OPEN:
 * any budget/counter read error returns `false` and logs — a budget-
 * infrastructure outage must never block production.
 */

import { DurableCollection } from './hostExtPersistence.js';
import { onWorkflowDeleted } from './workflowsRegistry.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { ERASED, subjectKeyForms } from './subjectErasureRedaction.js';
import { getOwned } from './workflowOwnership.js';
import { getNotificationEmitter } from '../notifications/emitter.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.workflowBudgets');

/* ── stores ─────────────────────────────────────────────────────────────── */

export interface WorkflowBudgetRecord {
  /** `${tenantId}:${encodeURIComponent(workflowId)}` */
  key: string;
  tenantId: string;
  workflowId: string;
  /** Daily budget in USD (> 0, finite). */
  dailyUsd: number;
  /** When true, run creation is refused once today's spend ≥ dailyUsd. */
  hardCap: boolean;
  /** Operator audit attribution — redacted to [erased] by the DSAR eraser. */
  updatedBy?: string;
  updatedAt: string;
}

export interface WorkflowSpendDayRecord {
  /** `${tenantId}:${encodeURIComponent(workflowId)}:${day}` */
  key: string;
  tenantId: string;
  workflowId: string;
  /** YYYY-MM-DD (UTC). */
  day: string;
  usd: number;
  /** Alert flags — set in the SAME CAS as the spend fold (once/threshold/day). */
  alerted80: boolean;
  alerted100: boolean;
  updatedAt: string;
}

const budgets = new DurableCollection<WorkflowBudgetRecord>(
  'workflow:budget',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);
const spendDays = new DurableCollection<WorkflowSpendDayRecord>(
  'workflow:spend-day',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);

const budgetKey = (tenantId: string, workflowId: string): string =>
  `${tenantId}:${encodeURIComponent(workflowId)}`;
const spendKey = (tenantId: string, workflowId: string, day: string): string =>
  `${tenantId}:${encodeURIComponent(workflowId)}:${day}`;
const spendPrefix = (tenantId: string, workflowId: string): string =>
  `${tenantId}:${encodeURIComponent(workflowId)}:`;

export const SPEND_DAY_KEEP_DAYS = 35;

function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const round6 = (n: number): number => Number(n.toFixed(6));

/* ── budget CRUD (route-facing) ─────────────────────────────────────────── */

export async function getWorkflowBudget(tenantId: string, workflowId: string): Promise<WorkflowBudgetRecord | null> {
  return budgets.get(budgetKey(tenantId, workflowId));
}

export async function putWorkflowBudget(
  tenantId: string,
  workflowId: string,
  input: { dailyUsd: number; hardCap: boolean; updatedBy?: string },
): Promise<WorkflowBudgetRecord> {
  const row: WorkflowBudgetRecord = {
    key: budgetKey(tenantId, workflowId),
    tenantId,
    workflowId,
    dailyUsd: round6(input.dailyUsd),
    hardCap: input.hardCap,
    ...(input.updatedBy ? { updatedBy: input.updatedBy } : {}),
    updatedAt: new Date().toISOString(),
  };
  await budgets.put(row);
  // Review M3 — changing the budget resets TODAY's alert flags: raising it
  // after an alert previously suppressed the NEW 80/100 thresholds for the
  // rest of the day (spend could climb through them silently). CAS best-
  // effort: a concurrent fold's flags win, which only re-arms later.
  try {
    const key = spendKey(tenantId, workflowId, todayUtc());
    const today = await spendDays.get(key);
    if (today && (today.alerted80 || today.alerted100)) {
      await spendDays.compareAndSwap(today, { ...today, alerted80: false, alerted100: false, updatedAt: new Date().toISOString() });
    }
  } catch { /* best-effort — the fold re-reads on its next pass */ }
  return row;
}

export async function clearWorkflowBudget(tenantId: string, workflowId: string): Promise<boolean> {
  const existing = await budgets.get(budgetKey(tenantId, workflowId));
  if (!existing) return false;
  await budgets.delete(existing.key);
  return true;
}

/** Today's folded spend for one workflow (0 when no row). */
export async function getTodaySpendUsd(tenantId: string, workflowId: string): Promise<number> {
  const row = await spendDays.get(spendKey(tenantId, workflowId, todayUtc()));
  return row?.usd ?? 0;
}

/** Batch reads for the dashboard list join (TWO prefix reads total for the
 *  whole tenant — never a per-row point-read fan-out). */
export async function listBudgetsForTenant(tenantId: string): Promise<WorkflowBudgetRecord[]> {
  return budgets.listByPrefix(`${tenantId}:`);
}
export async function listTodaySpendForTenant(tenantId: string): Promise<Map<string, number>> {
  const day = todayUtc();
  const out = new Map<string, number>();
  for (const r of await spendDays.listByPrefix(`${tenantId}:`)) {
    if (r.day === day) out.set(r.workflowId, r.usd);
  }
  return out;
}

/* ── the terminal spend fold (ADR 0482 §2/§4) ───────────────────────────── */

/** Fire-and-forget beside `stampRunCostOnTerminal` at every stamp site: the
 *  caller passes the usd the stamp computed for THIS run. Never throws. */
export async function foldWorkflowSpendOnTerminal(
  storage: { getRun(runId: string): Promise<{ tenantId: string; workflowId: string } | null | undefined> },
  runId: string,
  usd: number,
): Promise<void> {
  try {
    if (!(usd > 0) || !Number.isFinite(usd)) return;
    const run = await storage.getRun(runId);
    if (!run) return;
    await recordWorkflowSpend(run.tenantId, run.workflowId, usd);
  } catch (err) {
    log.warn('workflow_spend_fold_failed', { runId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** The CAS fold itself (exported for tests + the fold above). Mirrors the
 *  ADR 0480 bucket discipline: 8 attempts with random jitter; persistent
 *  contention DROPS the increment and logs (best-effort counts, disclosed). */
export async function recordWorkflowSpend(tenantId: string, workflowId: string, usd: number): Promise<void> {
  if (!(usd > 0) || !Number.isFinite(usd)) return;
  const day = todayUtc();
  const key = spendKey(tenantId, workflowId, day);
  // Budget read OUTSIDE the CAS loop — threshold math only; a mid-loop budget
  // edit shifts at most one alert boundary by one fold (daily-granularity rail).
  const budget = await budgets.get(budgetKey(tenantId, workflowId)).catch(() => null);
  const daily = budget && budget.dailyUsd > 0 ? budget.dailyUsd : null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (attempt > 0) await new Promise((res) => setTimeout(res, Math.random() * 25));
    const existing = await spendDays.get(key);
    const base: WorkflowSpendDayRecord = existing ?? {
      key, tenantId, workflowId, day, usd: 0, alerted80: false, alerted100: false, updatedAt: new Date().toISOString(),
    };
    const nextUsd = round6(base.usd + usd);
    const crossed80 = daily !== null && !base.alerted80 && nextUsd >= 0.8 * daily;
    const crossed100 = daily !== null && !base.alerted100 && nextUsd >= daily;
    const next: WorkflowSpendDayRecord = {
      ...base,
      usd: nextUsd,
      alerted80: base.alerted80 || crossed80 || crossed100,
      alerted100: base.alerted100 || crossed100,
      updatedAt: new Date().toISOString(),
    };
    if (await spendDays.compareAndSwap(existing ?? null, next)) {
      if (!existing) await pruneSpendDays(tenantId, workflowId, day);
      // ONE notification per fold: when a single fold crosses both thresholds
      // the 100% alert subsumes the 80% one (both flags set — neither fires
      // again today). The flag rides the SAME CAS row as the spend, so a
      // concurrent fold that lost the CAS re-reads flags already set.
      if (crossed100 && daily !== null) {
        void emitBudgetAlert(tenantId, workflowId, 100, nextUsd, daily, budget?.hardCap === true);
      } else if (crossed80 && daily !== null) {
        void emitBudgetAlert(tenantId, workflowId, 80, nextUsd, daily, budget?.hardCap === true);
      }
      return;
    }
  }
  log.warn('workflow_spend_fold_contention', { key });
}

async function pruneSpendDays(tenantId: string, workflowId: string, day: string): Promise<void> {
  try {
    const rows = await spendDays.listByPrefix(spendPrefix(tenantId, workflowId));
    const sorted = rows.sort((a, b) => b.day.localeCompare(a.day));
    for (const r of sorted.slice(SPEND_DAY_KEEP_DAYS)) await spendDays.delete(r.key);
    void day;
  } catch (err) {
    log.warn('workflow_spend_prune_failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Tenant BROADCAST bell/inbox alert. Best-effort — never breaks the fold.
 *  Title/message carry workflow name + spent/budget figures ONLY (no node
 *  config, no outputs, no secrets). */
async function emitBudgetAlert(tenantId: string, workflowId: string, threshold: 80 | 100, spentUsd: number, dailyUsd: number, hardCap: boolean): Promise<void> {
  try {
    const name = (await getOwned(tenantId, workflowId).catch(() => null))?.name ?? workflowId;
    const spent = `$${spentUsd.toFixed(2)}`;
    const budget = `$${dailyUsd.toFixed(2)}`;
    await getNotificationEmitter().emit({
      tenantId,
      // No recipientUserId — ADR 0482 §4: tenant broadcast (bell for all
      // members); addressed/email delivery is the recorded follow-on.
      type: 'openwop-app.workflow.budget-alert',
      priority: threshold === 100 ? 'high' : 'normal',
      title: threshold === 100
        ? `Daily budget reached: ${name}`
        : `Approaching daily budget: ${name}`,
      // ux review H2 — the 100% alert is the moment an operator learns their
      // schedules/triggers stopped: when the hard cap is on, SAY it.
      message: threshold === 100
        ? (hardCap
          ? `Today's spend (${spent}) has reached the ${budget} daily budget for "${name}". The hard cap is on: new runs — including schedules and triggers — are blocked until tomorrow (UTC).`
          : `Today's spend (${spent}) has reached the ${budget} daily budget for "${name}".`)
        : `Today's spend (${spent}) has passed 80% of the ${budget} daily budget for "${name}".`,
      workflowId,
      actionUrl: '/builder',
      metadata: { workflowId, threshold, spentUsd, dailyUsd, day: todayUtc() },
    });
  } catch (err) {
    log.warn('workflow_budget_alert_emit_failed', { workflowId, threshold, error: err instanceof Error ? err.message : String(err) });
  }
}

/* ── the hard cap (ADR 0482 §5) ─────────────────────────────────────────── */

/** Test seam ONLY: internal read indirection so fail-open is provable without
 *  reaching into the store internals. Production code never touches this. */
export const __budgetReadsForTests = {
  budget: (tenantId: string, workflowId: string) => getWorkflowBudget(tenantId, workflowId),
  spend: (tenantId: string, workflowId: string) => getTodaySpendUsd(tenantId, workflowId),
};

/**
 * True when the workflow has a hard-capped budget AND today's folded spend has
 * reached it. Point-reads budget then counter; FAIL-OPEN — any error returns
 * false and logs (a budget-infrastructure outage must never block production).
 *
 * Called from `startWorkflowRun` (schedules/triggers/kanban/MCP/CRM) and
 * `POST /v1/runs` BEFORE dispatch — and NOWHERE ELSE. Deliberately absent from:
 *  - `subWorkflowDispatcher` (child dispatch): refusing a child strands a
 *    mid-flight parent — worse than one overspent child run;
 *  - the debug-run / eval-run routes (their runs carry `debug`/`eval`
 *    provenance stamps): diagnostic spend stays unblocked;
 *  - the redrive route: a recovery lane, not a fresh production trigger.
 * TOCTOU accepted + disclosed (ADR 0482 §5): two concurrent creates can both
 * pass at 99% — a budget is a daily-granularity guardrail, not an invariant.
 */
export async function workflowBudgetExhausted(tenantId: string, workflowId: string): Promise<boolean> {
  try {
    const budget = await __budgetReadsForTests.budget(tenantId, workflowId);
    if (!budget || !budget.hardCap || !(budget.dailyUsd > 0)) return false;
    const spent = await __budgetReadsForTests.spend(tenantId, workflowId);
    return spent >= budget.dailyUsd;
  } catch (err) {
    log.warn('workflow_budget_check_failed_open', { workflowId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/* ── lifecycle: deletion cascade + DSAR eraser ──────────────────────────── */

// Budgets + counters die with the definition (the ADR 0474 registry deletion
// seam — all delete callers inherit). Field match, tenant-sliced when the
// caller names the owning tenant(s) (grade-data M7 — never a per-delete full
// scan on the hot GC path).
onWorkflowDeleted(async (workflowId, tenantIds) => {
  const scan = async <T extends { key: string; workflowId: string }>(store: {
    listByPrefix(p: string): Promise<T[]>; list(): Promise<T[]>; delete(k: string): Promise<unknown>;
  }): Promise<void> => {
    const rows = tenantIds && tenantIds.length > 0
      ? (await Promise.all(tenantIds.map((t) => store.listByPrefix(`${t}:`)))).flat()
      : await store.list();
    for (const r of rows) {
      if (r.workflowId === workflowId) await store.delete(r.key);
    }
  };
  await scan(budgets);
  await scan(spendDays);
});

/** ADR 0464 — DSAR subject-eraser: REDACT `updatedBy` on the tenant's budget
 *  rows (the attribution is the only subject field; the budget itself is
 *  tenant config — the workflow:revision `createdBy` precedent). The
 *  spend-day store carries counts + alert flags only (REVIEWED_EXEMPT). */
export async function eraseSubjectWorkflowBudgets(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const r of await budgets.listForTenantIndexed(tenantId)) {
    if (r.updatedBy && forms.has(r.updatedBy)) await budgets.put({ ...r, updatedBy: ERASED });
  }
}

/** ADR 0464 — called from `registerHostSubjectErasers()` (one explicit boot list). */
export function registerWorkflowBudgetErasure(): void {
  registerSubjectEraser(eraseSubjectWorkflowBudgets);
}

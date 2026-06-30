/**
 * ADR 0114 Phase 5 — per-tenant code-execution spend governance. A daily exec-count
 * budget (a paid, high-blast-radius surface). `OPENWOP_CODE_EXEC_MAX_PER_DAY`
 * (default 100; 0/unset = uncapped). Deterministic given the `day` bucket (passed
 * in — no host clock in the math), DurableCollection-backed. The sandbox adapter
 * checks BEFORE dispatch + records AFTER a successful run.
 *
 * @see docs/adr/0114-sandboxed-code-execution-node.md
 */
import { DurableCollection } from './hostExtPersistence.js';

interface ExecCount { key: string; count: number }
const counts = new DurableCollection<ExecCount>('codeexec:budget', (c) => c.key);

export function codeExecMaxPerDay(): number {
  const n = parseInt(process.env.OPENWOP_CODE_EXEC_MAX_PER_DAY ?? '100', 10);
  return Number.isFinite(n) && n >= 0 ? n : 100;
}

export interface BudgetCheck { allowed: boolean; used: number; max: number }

export async function checkCodeExecBudget(tenantId: string, day: string): Promise<BudgetCheck> {
  const max = codeExecMaxPerDay();
  if (max <= 0) return { allowed: true, used: 0, max: 0 }; // uncapped
  const cur = (await counts.get(`${tenantId}:${day}`))?.count ?? 0;
  return { allowed: cur < max, used: cur, max };
}

export async function recordCodeExec(tenantId: string, day: string): Promise<void> {
  if (codeExecMaxPerDay() <= 0) return;
  const key = `${tenantId}:${day}`;
  // CXE-3: atomic increment — a plain read-then-write loses concurrent increments (two
  // parallel runs both read `cur` and write `cur+1`, undercounting the daily cap). Use
  // compare-and-swap with a bounded retry; fail-soft on contention (best-effort accounting,
  // never fails a run that already executed).
  for (let attempt = 0; attempt < 12; attempt++) {
    const existing = await counts.get(key);
    const next: ExecCount = { key, count: (existing?.count ?? 0) + 1 };
    if (await counts.compareAndSwap(existing ?? null, next)) return;
  }
}

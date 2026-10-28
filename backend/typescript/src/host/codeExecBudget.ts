/**
 * ADR 0114 Phase 5 — per-tenant code-execution spend governance. A daily exec-count
 * budget (a paid, high-blast-radius surface). `OPENWOP_CODE_EXEC_MAX_PER_DAY`
 * (default 100; 0 = uncapped). Deterministic given the `day` bucket (passed
 * in — no host clock in the math), DurableCollection-backed.
 *
 * CORRECTED (ADR 0995 D6) — this said the adapter "checks BEFORE dispatch + records AFTER a
 * successful run". That pair never counted an execution that threw (a far-end timeout), and a
 * check separate from its record let concurrent callers at max-1 all pass. The runner now
 * RESERVES (`reserveCodeExec`, an atomic CAS increment below the max) and releases only a
 * refusal raised before dispatch (`releaseCodeExec`).
 *
 * @see docs/adr/0114-sandboxed-code-execution-node.md
 */
import { DurableCollection } from './hostExtPersistence.js';

// GEN-6: `tenantId` is carried in CONTENT (not just the `${tenantId}:${day}` key) so
// tenant teardown (`purgeTenantRows`'s content-match) can find and reap these rows —
// without it the daily counters survived account-delete forever (double-blind). No
// `tenantOf`/secondary index: this collection is point-read (`get(${tenant}:${day})`)
// and never listed by tenant, so a marker would be pure write-amplification. The fold
// already moves these via GEN-1b's key-rewrite (the tenant is in the key).
interface ExecCount { key: string; tenantId: string; count: number }
const counts = new DurableCollection<ExecCount>('codeexec:budget', (c) => c.key);

export function codeExecMaxPerDay(): number {
  const n = parseInt(process.env.OPENWOP_CODE_EXEC_MAX_PER_DAY ?? '100', 10);
  return Number.isFinite(n) && n >= 0 ? n : 100;
}

export interface BudgetCheck { allowed: boolean; used: number; max: number }

export interface BudgetReservation extends BudgetCheck {
  /** True when a unit was taken (false when uncapped, or refused). */
  reserved: boolean;
  /** True when the refusal was CAS contention, not the cap. */
  contended?: boolean;
}

const CAS_ATTEMPTS = 12;

/** ADR 0995 D6 — take one unit of `tenant:day`'s budget atomically, or refuse. A CAS that loses
 *  every attempt REFUSES (fail-closed): running uncharged is the defect this replaces. */
export async function reserveCodeExec(tenantId: string, day: string): Promise<BudgetReservation> {
  const max = codeExecMaxPerDay();
  if (max <= 0) return { allowed: true, reserved: false, used: 0, max: 0 }; // uncapped
  const key = `${tenantId}:${day}`;
  let cur = 0;
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const existing = await counts.get(key);
    cur = existing?.count ?? 0;
    if (cur >= max) return { allowed: false, reserved: false, used: cur, max };
    if (await counts.compareAndSwap(existing ?? null, { key, tenantId, count: cur + 1 })) {
      return { allowed: true, reserved: true, used: cur + 1, max };
    }
  }
  return { allowed: false, reserved: false, contended: true, used: cur, max };
}

/** ADR 0995 D6 — give back a unit taken by `reserveCodeExec` for a run refused before dispatch.
 *  Same `day` the reservation used (the caller captures it). Best-effort: a release that loses
 *  every CAS leaves the tenant charged one execution it did not get, which is the stated
 *  residual, and the safe direction. */
export async function releaseCodeExec(tenantId: string, day: string): Promise<void> {
  const key = `${tenantId}:${day}`;
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const existing = await counts.get(key);
    if (!existing || existing.count <= 0) return;
    if (await counts.compareAndSwap(existing, { ...existing, count: existing.count - 1 })) return;
  }
}

export async function checkCodeExecBudget(tenantId: string, day: string): Promise<BudgetCheck> {
  const max = codeExecMaxPerDay();
  if (max <= 0) return { allowed: true, used: 0, max: 0 }; // uncapped
  const cur = (await counts.get(`${tenantId}:${day}`))?.count ?? 0;
  return { allowed: cur < max, used: cur, max };
}

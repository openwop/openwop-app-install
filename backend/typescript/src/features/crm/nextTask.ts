/**
 * ADR 0837 D8 (implements ADR 0567 D1) — the per-deal NEXT activity: the earliest
 * OPEN task linked to the deal. It is a projection over tasks, computed once per
 * request from ONE org task read (never a per-deal query: the board would fan out
 * against the per-IP read budget), and filtered by the same territory predicate
 * as every other task exit (D5), so a hidden task never surfaces as "next".
 *
 * `null` is a first-class answer meaning "no next activity", never "unknown".
 *
 * Ordering. `dueDate` is any string up to 40 characters (`optStr(…, 40)`), not a
 * validated date (architect A10), so a value counts as DATED only when it starts
 * with `YYYY-MM-DD`; dated tasks come first by that calendar date, then undated
 * ones by creation. "Overdue" is decided by the viewer against THEIR local date,
 * so this module ships the date part and leaves that comparison to the client.
 */

import type { Task } from './entities/tasks.js';

export interface NextTask {
  taskId: string;
  title: string;
  /** The leading `YYYY-MM-DD` of the task's due date, or null when undated. */
  dueDate: string | null;
}

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

/** The calendar date a `dueDate` names, or null when it names none. */
export function dueDay(dueDate: string | undefined): string | null {
  const m = dueDate ? DATE_PREFIX.exec(dueDate) : null;
  return m ? m[1]! : null;
}

function before(a: Task, b: Task): boolean {
  const da = dueDay(a.dueDate);
  const db = dueDay(b.dueDate);
  if (da && db && da !== db) return da < db;
  if (da && !db) return true;
  if (!da && db) return false;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt;
  return a.taskId < b.taskId; // a total order, so the answer never flickers
}

/** dealId → its next open task, for every deal that has one. */
export function nextTaskByDeal(tasks: readonly Task[]): Map<string, NextTask> {
  const best = new Map<string, Task>();
  for (const t of tasks) {
    if (!t.dealId || (t.status !== 'open' && t.status !== 'doing')) continue;
    const cur = best.get(t.dealId);
    if (!cur || before(t, cur)) best.set(t.dealId, t);
  }
  const out = new Map<string, NextTask>();
  for (const [dealId, t] of best) out.set(dealId, { taskId: t.taskId, title: t.title, dueDate: dueDay(t.dueDate) });
  return out;
}

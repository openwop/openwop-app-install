/**
 * ADR 0789 — the one row-rewrite primitive every fork hook uses.
 *
 * A fork hook (`onWorkflowForked`) rewrites references to the old shared id in
 * rows its OWN module holds. Every such write is a compare-and-swap against the
 * row as read (a plain get→put would race a concurrent edit of the same schedule
 * or card and silently revert it), retried against a fresh read, and SKIPPED when
 * the row no longer references the old id — so a hook run twice re-points nothing
 * the second time.
 */
import type { DurableCollection } from './hostExtPersistence.js';

/**
 * Re-point one row. `rewrite` returns the rewritten row, or `null` when the row
 * (as freshly read) no longer needs it. Returns whether a write landed.
 */
export async function casRepoint<T>(
  col: DurableCollection<T>,
  id: string,
  rewrite: (row: T) => T | null,
): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await col.get(id);
    if (!current) return false;
    const next = rewrite(current);
    if (!next) return false;
    if (await col.compareAndSwap(current, next)) return true;
  }
  throw new Error(`fork re-point lost the compare-and-swap 4 times on row ${id}`);
}

/** Replace `from` with `to` in a workflow-id list, de-duplicating; `null` when the
 *  list does not contain `from` (nothing to do). */
export function repointList(list: readonly string[] | undefined, from: string, to: string): string[] | null {
  if (!list || !list.includes(from)) return null;
  const out: string[] = [];
  for (const id of list) {
    const v = id === from ? to : id;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Move rows whose KEY embeds the workflow id (budgets, eval sets, debug pins):
 * insert the re-keyed row only if absent (a second run of the hook, or a row the
 * user already made on the fork, is never overwritten), then delete the old one.
 * Returns how many rows moved.
 */
export async function moveKeyedRows<T>(
  col: DurableCollection<T>,
  rows: readonly T[],
  keyOf: (row: T) => string,
  rekey: (row: T) => T,
): Promise<number> {
  let n = 0;
  for (const row of rows) {
    const next = rekey(row);
    await col.putIfAbsent(next);
    await col.delete(keyOf(row));
    n += 1;
  }
  return n;
}

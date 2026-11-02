/**
 * ADR 1022 (CP71WF-28) — a retried compare-and-swap rewrite of one row, for
 * the subject erasers. A blind `put` of a row read earlier undid any save that
 * landed in between (the old version came back); one CAS attempt silently
 * skipped the row and kept the erased person's id. This re-reads and retries,
 * and throws when it keeps losing, as the spend-cap eraser does.
 */

import type { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';

/** Rewrite `key` with `next(row)` while `needs(row)` still holds. Returns true
 *  when it wrote, false when the row is gone or no longer needs it. */
export async function casRewrite<T>(coll: DurableCollection<T>, key: string, needs: (row: T) => boolean, next: (row: T) => T, what: string): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await coll.get(key);
    if (!current || !needs(current)) return false;
    if (await coll.compareAndSwap(current, next(current))) return true;
  }
  throw new OpenwopError('conflict', `${what} erasure lost concurrent updates; retry.`, 409);
}

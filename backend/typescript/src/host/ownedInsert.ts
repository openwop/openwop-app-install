/**
 * ADR 0848 D1 — the ONE "create at a caller-chosen id" rule for a `DurableCollection`
 * keyed by id alone.
 *
 * The defect it closes (#4485, and ADR 0838 D1 before it): a create path accepted a
 * caller-supplied id, looked for a "prior" row through a tenant/org-FILTERED getter —
 * which answers `null` for a row another tenant or org holds — and then `put` blindly.
 * The victim's row moved into the caller's workspace. Every adopter had its own private
 * copy of the fix, which is how the second instance survived the first fix.
 *
 * The rule:
 *   1. read the RAW row by id;
 *   2. it exists and `owns(existing)` → return it (`created: false`) — the replay /
 *      retry convergence every caller relies on;
 *   3. it exists and is NOT owned → `409 conflict`. The message carries no tenant, org
 *      or owner: the only thing learnt is that this exact id is taken;
 *   4. absent → `build()` the row (caps and validation live there, so a replay of an
 *      owned id never trips them) and insert it with `compareAndSwap(null, row)`; a lost
 *      race re-reads and applies 2–3.
 */

import { OpenwopError } from '../types.js';
import type { DurableCollection } from './hostExtPersistence.js';

export async function insertOwnedOrConflict<T>(
  collection: DurableCollection<T>,
  id: string,
  owns: (existing: T) => boolean,
  build: () => Promise<T> | T,
): Promise<{ row: T; created: boolean }> {
  const prior = await collection.get(id);
  if (prior) {
    if (owns(prior)) return { row: prior, created: false };
    throw new OpenwopError('conflict', 'That id is already in use.', 409, { id });
  }
  const row = await build();
  if (await collection.compareAndSwap(null, row)) return { row, created: true };
  const raced = await collection.get(id);
  if (raced && owns(raced)) return { row: raced, created: false };
  throw new OpenwopError('conflict', raced ? 'That id is already in use.' : 'Could not create the row (concurrent write).', 409, { id });
}

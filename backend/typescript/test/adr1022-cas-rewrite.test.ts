/**
 * ADR 1022 (CP71WF-28) — the campaign-intel subject erasers rewrite a row with a
 * retried compare-and-swap. A blind `put` of a row read earlier undid a save
 * that landed in between; a single CAS attempt silently skipped the row and kept
 * the erased person's id.
 *
 * Sabotage (run red, then reverted): make `casRewrite` give up after one lost
 * CAS (return false) → the "concurrent save" case keeps the old id.
 */

import { describe, expect, it } from 'vitest';
import { casRewrite } from '../src/features/campaign-intel/casRewrite.js';
import type { DurableCollection } from '../src/host/hostExtPersistence.js';

interface Row { k: string; by: string; v: number }

/** A one-row store whose first CAS loses to a concurrent save (v bumps). */
function racingStore(start: Row, losses: number): { coll: DurableCollection<Row>; row: () => Row } {
  let row = start;
  let left = losses;
  const coll = {
    get: async () => ({ ...row }),
    compareAndSwap: async (expected: Row | null, next: Row) => {
      if (left > 0) { left -= 1; row = { ...row, v: row.v + 1 }; return false; } // someone else saved first
      if (!expected || expected.v !== row.v) return false;
      row = next;
      return true;
    },
  } as unknown as DurableCollection<Row>;
  return { coll, row: () => row };
}

describe('casRewrite', () => {
  it('retries a lost CAS on the FRESH row: the concurrent save survives and the id is erased', async () => {
    const s = racingStore({ k: 'r', by: 'user:gone', v: 1 }, 1);
    expect(await casRewrite(s.coll, 'r', (r) => r.by === 'user:gone', (r) => ({ ...r, by: 'tomb' }), 'Test')).toBe(true);
    expect(s.row()).toEqual({ k: 'r', by: 'tomb', v: 2 });
  });

  it('a row that no longer needs it is left alone; one that keeps losing throws', async () => {
    const done = racingStore({ k: 'r', by: 'someone-else', v: 1 }, 0);
    expect(await casRewrite(done.coll, 'r', (r) => r.by === 'user:gone', (r) => ({ ...r, by: 'tomb' }), 'Test')).toBe(false);
    const hot = racingStore({ k: 'r', by: 'user:gone', v: 1 }, 99);
    await expect(casRewrite(hot.coll, 'r', (r) => r.by === 'user:gone', (r) => ({ ...r, by: 'tomb' }), 'Test')).rejects.toMatchObject({ code: 'conflict' });
  });
});

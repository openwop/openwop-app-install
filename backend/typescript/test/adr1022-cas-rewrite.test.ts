/**
 * ADR 1022 (CP71WF-28) — the campaign-intel subject erasers rewrite a row with a
 * retried compare-and-swap. A blind `put` of a row read earlier undid a save
 * that landed in between; a single CAS attempt silently skipped the row and kept
 * the erased person's id.
 *
 * The store is a real `DurableCollection` on memory storage. A concurrent save is
 * a real `put` landing just before our CAS, so the storage CAS itself loses on the
 * stale `expected` (no fabricated `false`).
 *
 * Sabotage-witnessed (w83): give up after one lost CAS (return its result) → the
 * concurrent-save case keeps the old id; retry with the FIRST read instead of a
 * fresh one → it throws; drop the `needs` re-check → the done row is rewritten;
 * return false instead of throwing → the hot row reads as "nothing to do"; raise
 * the 5-attempt bound → the hot row is eventually written.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { casRewrite } from '../src/features/campaign-intel/casRewrite.js';
import { DurableCollection, initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { OpenwopError } from '../src/types.js';

interface Row { k: string; by: string; v: number }

/** Each of the first `losses` CAS attempts is beaten by a concurrent save (v + 1). */
class RacingCollection extends DurableCollection<Row> {
  attempts = 0;
  constructor(private losses: number) { super('test:adr1022-cas-rewrite', (r) => r.k); }
  override async compareAndSwap(expected: Row | null, next: Row): Promise<boolean> {
    this.attempts += 1;
    if (this.losses > 0) {
      this.losses -= 1;
      const now = await this.get(next.k);
      if (now) await this.put({ ...now, v: now.v + 1 }); // someone else saved first
    }
    return super.compareAndSwap(expected, next);
  }
}

async function racing(start: Row, losses: number): Promise<RacingCollection> {
  const coll = new RacingCollection(losses);
  await coll.put(start);
  return coll;
}

const erase = (coll: RacingCollection): Promise<boolean> =>
  casRewrite(coll, 'r', (r) => r.by === 'user:gone', (r) => ({ ...r, by: 'tomb' }), 'Test');

beforeEach(async () => { initHostExtPersistence(await openStorage('memory://')); });
afterEach(() => { __resetHostExtPersistence(); });

describe('casRewrite', () => {
  it('retries a lost CAS on the FRESH row: the concurrent save survives and the id is erased', async () => {
    const coll = await racing({ k: 'r', by: 'user:gone', v: 1 }, 1);
    expect(await erase(coll)).toBe(true);
    expect(await coll.get('r')).toEqual({ k: 'r', by: 'tomb', v: 2 });
    expect(coll.attempts).toBe(2);
  });

  it('a row that no longer needs it is left alone', async () => {
    const coll = await racing({ k: 'r', by: 'someone-else', v: 1 }, 0);
    expect(await erase(coll)).toBe(false);
    expect(await coll.get('r')).toEqual({ k: 'r', by: 'someone-else', v: 1 });
    expect(coll.attempts).toBe(0);
  });

  it('one that keeps losing throws a 409 conflict after 5 attempts', async () => {
    const coll = await racing({ k: 'r', by: 'user:gone', v: 1 }, 99);
    const err = await erase(coll).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(OpenwopError);
    expect(err).toMatchObject({ code: 'conflict', httpStatus: 409, message: 'Test erasure lost concurrent updates; retry.' });
    expect(coll.attempts).toBe(5);
    expect((await coll.get('r'))?.by).toBe('user:gone');
  });
});

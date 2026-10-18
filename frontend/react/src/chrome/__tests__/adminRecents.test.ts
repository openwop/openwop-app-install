/**
 * Admin home recents (`chrome/adminRecents.ts`) — a bounded, presentation-only
 * list of canonical admin destinations. Guards: at most five entries, deduped
 * most-recent-first; the overview itself and anything that is not a top-level
 * path (a record id, a relative value) is never PERSISTED; corrupt storage reads
 * as empty instead of throwing into the Admin home. Breaks if the cap, the
 * dedupe, the write-side filter or the read-side catch is removed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readRecentAdminDestinations, recordRecentAdminDestination } from '../adminRecents.js';

const KEY = 'openwop.admin.recent-destinations';

describe('admin recents', () => {
  beforeEach(() => localStorage.clear());

  it('keeps a deduplicated five-item canonical-path list', () => {
    for (const path of ['/one', '/two', '/three', '/four', '/five', '/six', '/three']) {
      recordRecentAdminDestination(path);
    }
    expect(readRecentAdminDestinations()).toEqual(['/three', '/six', '/five', '/four', '/two']);
  });

  it('does not record the overview or malformed values and fails closed on corrupt storage', () => {
    recordRecentAdminDestination('/admin');
    recordRecentAdminDestination('record/secret-id');
    // Raw storage, not the reader: the reader re-filters non-`/` values, which
    // would hide a write-side leak of the record id.
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(readRecentAdminDestinations()).toEqual([]);
    localStorage.setItem(KEY, '{bad');
    expect(readRecentAdminDestinations()).toEqual([]);
  });
});

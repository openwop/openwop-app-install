import { beforeEach, describe, expect, it } from 'vitest';
import { readRecentAdminDestinations, recordRecentAdminDestination } from '../adminRecents.js';

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
    expect(readRecentAdminDestinations()).toEqual([]);
    localStorage.setItem('openwop.admin.recent-destinations', '{bad');
    expect(readRecentAdminDestinations()).toEqual([]);
  });
});

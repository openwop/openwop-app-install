/**
 * A3 catalog-health aggregation (ADR 0438). countByState must group the published
 * catalog by lifecycle state and sort deterministically (descending count, then
 * state name) so the operator's view is stable across loads.
 *
 * Sabotage witnesses (w40 probes): counting every status as 1, sorting ascending,
 * or dropping the `localeCompare` tie-break each turn a case here red. The
 * empty-catalog boundary is carried by catalogHealthHonesty.test.tsx › "EMPTY: a
 * genuinely empty catalog still says so" (w40g4-chh-empty went red there under
 * the same sabotage as the case cut from this file).
 */
import { describe, it, expect } from 'vitest';
import { countByState } from '../catalogHealth.js';
import type { ChallengeSummary } from '../../../client/kicktodoClient.js';

const ch = (id: string, status: ChallengeSummary['status']): ChallengeSummary =>
  ({ id, version: 1, status, title: id, summary: '', outcome: '', durationDays: 7, activities: [] });

describe('countByState', () => {
  it('groups by status and sorts by descending count then status name', () => {
    const out = countByState([
      ch('a', 'published'), ch('b', 'published'), ch('c', 'retired'),
      ch('d', 'published'), ch('e', 'retired'),
    ]);
    expect(out).toEqual([['published', 3], ['retired', 2]]);
  });

  it('breaks equal counts by state name (ascending) for stability', () => {
    const out = countByState([ch('a', 'retired'), ch('b', 'published')]);
    expect(out).toEqual([['published', 1], ['retired', 1]]);
  });
});

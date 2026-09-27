/**
 * A3 catalog-health aggregation (ADR 0438). countByState must group the published
 * catalog by lifecycle state and sort deterministically (descending count, then
 * state name) so the operator's view is stable across loads.
 */
import { describe, it, expect } from 'vitest';
import { countByState } from '../catalogHealth.js';
import type { ChallengeSummary } from '../../../client/kicktodoClient.js';

const ch = (id: string, status: string): ChallengeSummary =>
  ({ id, status } as ChallengeSummary);

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

  it('returns an empty array for an empty catalog', () => {
    expect(countByState([])).toEqual([]);
  });
});

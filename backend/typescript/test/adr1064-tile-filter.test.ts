/**
 * ADR 1064 P3b — the columns section keeps `filter: true` (status filter chips
 * over a tiles grid) and drops any other value. Sabotage witness: removing the
 * filter line from the validator reds the first case.
 */
import { describe, expect, it } from 'vitest';
import { validateSection } from '../src/features/cms/cmsService.js';

const data = (d: Record<string, unknown>): Record<string, unknown> =>
  validateSection({ type: 'columns', data: { layout: 'tiles', columns: [{ title: 'Marketing', badge: 'Works today' }], ...d } }).data;

describe('tiles filter (ADR 1064 P3b)', () => {
  it('keeps filter: true', () => {
    expect(data({ filter: true }).filter).toBe(true);
  });

  it('drops any other filter value', () => {
    for (const filter of [false, 'true', 1, 'status']) expect(data({ filter }).filter, String(filter)).toBeUndefined();
    expect(data({}).filter).toBeUndefined();
  });
});

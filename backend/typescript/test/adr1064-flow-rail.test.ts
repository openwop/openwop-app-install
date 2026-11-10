/**
 * ADR 1064 P3c — the flow rail's validator half: the hero `flow` keeps
 * `numbered` and `run` only when true; a columns `flow` keeps `run` only when
 * true (and `numbers: 'circle'`, which already existed). Sabotage witnesses
 * (grade-tests w92, 8 probes): keeping a truthy non-true `numbered`, `run` or
 * columns `run`, dropping any of them, keeping `run` off a flow layout, or
 * losing 'circle' from the step numbers reds its case.
 */
import { describe, expect, it } from 'vitest';
import { validateSection } from '../src/features/cms/cmsService.js';

const NODES = [{ label: 'Kick off' }, { label: 'Split the work' }];

describe('flow rail (ADR 1064 P3c)', () => {
  it('hero flow keeps numbered and run only when true', () => {
    const hero = (flow: Record<string, unknown>): Record<string, unknown> =>
      validateSection({ type: 'hero', data: { heading: 'How it works', visual: 'flow', flow: { nodes: NODES, ...flow } } }).data.flow as Record<string, unknown>;
    expect(hero({ numbered: true, run: true })).toMatchObject({ numbered: true, run: true });
    const off = hero({ numbered: 'yes', run: 1 });
    expect(off.numbered).toBeUndefined();
    expect(off.run).toBeUndefined();
  });

  it('columns flow keeps run only when true, and numbers circle', () => {
    const cols = (d: Record<string, unknown>): Record<string, unknown> =>
      validateSection({ type: 'columns', data: { layout: 'flow', columns: [{ title: 'A' }, { title: 'B' }], ...d } }).data;
    expect(cols({ run: true, numbers: 'circle' })).toMatchObject({ run: true, numbers: 'circle' });
    expect(cols({ run: 'true' }).run).toBeUndefined();
    // run is a flow option only.
    expect(validateSection({ type: 'columns', data: { layout: 'cards', columns: [{ title: 'A' }], run: true } }).data.run).toBeUndefined();
  });
});

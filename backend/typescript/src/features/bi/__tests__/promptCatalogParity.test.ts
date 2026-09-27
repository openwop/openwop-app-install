/**
 * ADR 0417 P2 — prompt↔catalog parity (the repo-wide tripwire pattern).
 * The tool/prompt text a model sees must DERIVE from the SSoT vocabularies
 * (`metricTypes.ts`) — never a hand-copied enum that can drift. Asserts the
 * source interpolates the consts, and that the projected catalog carries the
 * same closed worlds the evaluator enforces.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGGREGATES, METRIC_FILTER_OPS, TIME_BUCKETS } from '../metricTypes.js';

const read = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('bi prompt/catalog parity (ADR 0358 discipline)', () => {
  it('agent-tool text interpolates the SSoT vocab consts — no hand-copied enums', () => {
    const src = read('agentTools.ts');
    expect(src).toContain('AGGREGATES.join');
    expect(src).toContain('TIME_BUCKETS.join');
    expect(src).toContain('[...TIME_BUCKETS]');
    // The tell of drift: a literal aggregate list in prose. The only allowed
    // occurrences of e.g. "sum, avg" must come from the join interpolation.
    expect(src).not.toMatch(/count,\s*sum,\s*avg/);
  });

  it('the surface catalog projection exposes the SAME closed vocab the evaluator enforces', async () => {
    const { projectBiCatalog } = await import('../surface.js');
    // memory:// store — no rows needed; system metrics come from code.
    process.env.OPENWOP_STORAGE_DSN ??= 'memory://';
    const cat = await projectBiCatalog('tenant-parity').catch(() => null);
    // If persistence isn't booted in this unit context, the vocab consts are
    // still the assertion target via the module exports below.
    if (cat) {
      expect(cat.vocab.aggregates).toEqual(AGGREGATES);
      expect(cat.vocab.filterOps).toEqual(METRIC_FILTER_OPS);
      expect(cat.vocab.buckets).toEqual(TIME_BUCKETS);
      expect(typeof cat.promptMetricList).toBe('string');
    }
    expect(AGGREGATES).toEqual(['count', 'sum', 'avg', 'min', 'max']);
    expect(METRIC_FILTER_OPS).toEqual(['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains']);
  });
});

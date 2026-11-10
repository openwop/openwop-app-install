/**
 * ADR 0417 P2 — prompt↔catalog parity (the repo-wide tripwire pattern).
 * The tool/prompt text a model sees must DERIVE from the SSoT vocabularies
 * (`metricTypes.ts`) — never a hand-copied enum that can drift. Asserts the
 * tool declarations the model is offered carry the consts, and that the projected
 * catalog carries the same closed worlds the evaluator enforces.
 *
 * Two kinds of check, both load-bearing: the declarations and the projection are
 * compared WITH the consts (a hand-copied list drifts from them), and the consts are
 * pinned to literals (the vocabulary itself cannot move unseen).
 *
 * Sabotage-witnessed: a hand-copied aggregate list, even with `AGGREGATES.join` left in
 * a comment, reds case 1; a narrowed `bucket` enum reds case 1; a blank projection
 * vocabulary or a moved const reds case 2. The projection needs a store: without one
 * `listMetrics` throws, which this file used to swallow, so case 2 asserted nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builtinAgentTool } from '../../../host/agentToolProvider.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../../../host/hostExtPersistence.js';
import { openStorage } from '../../../storage/index.js';
import { BI_LIST_METRICS_TOOL_ID, BI_RUN_METRIC_TOOL_ID, registerBiAgentTools } from '../agentTools.js';
import { AGGREGATES, METRIC_FILTER_OPS, TIME_BUCKETS } from '../metricTypes.js';
import { projectBiCatalog } from '../surface.js';

const read = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('bi prompt/catalog parity (ADR 0358 discipline)', () => {
  beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
  afterAll(() => { __resetHostExtPersistence(); });

  it('agent-tool text interpolates the SSoT vocab consts — no hand-copied enums', () => {
    registerBiAgentTools();
    const list = builtinAgentTool(BI_LIST_METRICS_TOOL_ID)?.def;
    const run = builtinAgentTool(BI_RUN_METRIC_TOOL_ID)?.def;
    expect(list?.description).toContain(`aggregate (one of: ${AGGREGATES.join(', ')})`);
    expect(run?.description).toContain(`bucket (one of: ${TIME_BUCKETS.join(', ')})`);
    expect(run?.inputSchema).toMatchObject({ properties: { bucket: { enum: [...TIME_BUCKETS] } } });
    // ADR 1052 D10 — every honesty flag a result can carry is explained to the model,
    // and so is the stale refusal (a model told nothing reads `groupsTruncated` as noise).
    for (const flag of ['scope', 'groupsTruncated', 'droppedGroups', 'undatedRows', 'metric_stale']) expect(run?.description).toContain(flag);
    expect(list?.description).toContain('stale');
    // The tell of drift: a literal aggregate list in prose. The only allowed
    // occurrences of e.g. "sum, avg" must come from the join interpolation.
    expect(read('agentTools.ts')).not.toMatch(/count,\s*sum,\s*avg/);
  });

  it('the surface catalog projection exposes the SAME closed vocab the evaluator enforces', async () => {
    // No stored rows needed; system metrics come from code.
    const cat = await projectBiCatalog('tenant-parity', 'org-parity');
    expect(cat.vocab.aggregates).toEqual(AGGREGATES);
    expect(cat.vocab.filterOps).toEqual(METRIC_FILTER_OPS);
    expect(cat.vocab.buckets).toEqual(TIME_BUCKETS);
    expect(cat.promptMetricList).toContain('sys-deal-count (');
    expect(AGGREGATES).toEqual(['count', 'sum', 'avg', 'min', 'max']);
    expect(METRIC_FILTER_OPS).toEqual(['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains']);
    expect(TIME_BUCKETS).toEqual(['day', 'week', 'month']);
  });
});

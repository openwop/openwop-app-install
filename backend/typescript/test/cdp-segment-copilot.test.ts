/**
 * CDP-C — segment-author copilot grounding (ADR 0265). The closed-world vocabulary
 * + a non-throwing validator: the copilot drafts filters, validates against the
 * legal fields/ops, and can never emit an invalid segment (the workflow-author
 * closed-world pattern).
 *
 * Sabotage-witnessed (/grade-tests w38): the numeric-value check removed, the validator's catch
 * reporting `valid:true`, and the persist verb dropping the validated filters each turn a case
 * red. The persist refusal's "no write" is double-guarded (`createSegment` re-runs
 * `validateFilters`), so the read-back below is a ceiling, not a separate witness.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { segmentVocabulary, validateSegmentDraft, getSegment, listSegments } from '../src/features/crm/segmentsService.js';
import { buildCrmSurface } from '../src/features/crm/surface.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';

describe('CDP-C segment-author grounding', () => {
  it('exposes the closed-world vocabulary (fields, calculated fields, ops)', () => {
    // The claim is PARITY: everything the copilot is told is legal, the validator accepts —
    // so a drafted filter grounded in the vocabulary can never be refused (and vice versa).
    const v = segmentVocabulary();
    expect(v.fields.length + v.calculatedFields.length).toBeGreaterThan(0);
    for (const field of [...v.fields, ...v.calculatedFields, `${v.customFieldPrefix}anything`]) {
      expect(validateSegmentDraft([{ field, op: 'exists' }]).valid, field).toBe(true);
    }
    for (const op of v.ops) {
      const value = op === 'exists' ? undefined : '1';
      expect(validateSegmentDraft([{ field: 'propensity', op, ...(value ? { value } : {}) }]).valid, op).toBe(true);
    }
    expect(validateSegmentDraft([{ field: 'not_a_field', op: 'exists' }]).valid).toBe(false);
  });

  it('validates a good draft and rejects a bad one (with errors)', () => {
    const good = validateSegmentDraft([{ field: 'stage', op: 'eq', value: 'customer' }, { field: 'propensity', op: 'gte', value: '7' }]);
    expect(good.valid).toBe(true);
    expect(good.filters.length).toBe(2);

    const badField = validateSegmentDraft([{ field: 'not_a_field', op: 'eq', value: 'x' }]);
    expect(badField.valid).toBe(false);
    expect(badField.errors).toEqual(['Unknown segment filter field `not_a_field`.']);

    const badNumeric = validateSegmentDraft([{ field: 'propensity', op: 'gt', value: 'high' }]);
    expect(badNumeric.valid).toBe(false);
    expect(badNumeric.errors).toEqual(['filter.value must be numeric for op `gt`.']);

    const notArray = validateSegmentDraft({ field: 'stage' });
    expect(notArray.valid).toBe(false);
  });
});

describe('CDP-C segment-author PERSIST (ADR 0265 — draft→validate→persist)', () => {
  beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

  it('persistSegment writes a validated draft and REFUSES an invalid one (fail-closed, no write)', async () => {
    const tenantId = `tenant-seg-${randomUUID()}`;
    const segmentId = `seg:copilot-${randomUUID()}`;
    const surface = buildCrmSurface({ tenantId, runId: 'r1', actingUserId: 'u1' });
    const persist = surface.persistSegment as (a: Record<string, unknown>) => Promise<Record<string, unknown>>;

    // Invalid draft → structured errors, NO segment written.
    const bad = await persist({ name: 'Bad', filters: [{ field: 'not_a_field', op: 'eq', value: 'x' }] });
    expect(bad.success).toBe(false);
    expect(bad.errors).toEqual(['Unknown segment filter field `not_a_field`.']);
    expect(await listSegments(tenantId)).toEqual([]);

    // Valid draft → persisted (the copilot's confirmed write).
    const ok = await persist({ name: 'Late-stage customers', filters: [{ field: 'stage', op: 'eq', value: 'customer' }], segmentId });
    expect(ok.success).toBe(true);
    const saved = await getSegment(tenantId, segmentId);
    expect(saved?.name).toBe('Late-stage customers');
    expect(saved?.filters).toEqual([{ field: 'stage', op: 'eq', value: 'customer' }]);
  });
});

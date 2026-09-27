/**
 * CDP-C — segment-author copilot grounding (ADR 0265). The closed-world vocabulary
 * + a non-throwing validator: the copilot drafts filters, validates against the
 * legal fields/ops, and can never emit an invalid segment (the workflow-author
 * closed-world pattern).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { segmentVocabulary, validateSegmentDraft, getSegment } from '../src/features/crm/segmentsService.js';
import { buildCrmSurface } from '../src/features/crm/surface.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';

describe('CDP-C segment-author grounding', () => {
  it('exposes the closed-world vocabulary (fields, calculated fields, ops)', () => {
    const v = segmentVocabulary();
    expect(v.fields).toContain('stage');
    expect(v.calculatedFields).toContain('propensity');
    expect(v.calculatedFields).toContain('emailClicks');
    expect(v.ops).toEqual(expect.arrayContaining(['eq', 'gt', 'lt', 'contains', 'exists']));
    expect(v.customFieldPrefix).toBe('customFields.');
  });

  it('validates a good draft and rejects a bad one (with errors)', () => {
    const good = validateSegmentDraft([{ field: 'stage', op: 'eq', value: 'customer' }, { field: 'propensity', op: 'gte', value: '7' }]);
    expect(good.valid).toBe(true);
    expect(good.filters.length).toBe(2);

    const badField = validateSegmentDraft([{ field: 'not_a_field', op: 'eq', value: 'x' }]);
    expect(badField.valid).toBe(false);
    expect(badField.errors.length).toBeGreaterThan(0);

    const badNumeric = validateSegmentDraft([{ field: 'propensity', op: 'gt', value: 'high' }]);
    expect(badNumeric.valid).toBe(false);

    const notArray = validateSegmentDraft({ field: 'stage' });
    expect(notArray.valid).toBe(false);
  });
});

describe('CDP-C segment-author PERSIST (ADR 0265 — draft→validate→persist)', () => {
  beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

  it('persistSegment writes a validated draft and REFUSES an invalid one (fail-closed, no write)', async () => {
    const surface = buildCrmSurface({ tenantId: 'tenant-seg', runId: 'r1', actingUserId: 'u1' });
    const persist = surface.persistSegment as (a: Record<string, unknown>) => Promise<Record<string, unknown>>;

    // Invalid draft → structured errors, NO segment written.
    const bad = await persist({ name: 'Bad', filters: [{ field: 'not_a_field', op: 'eq', value: 'x' }] });
    expect(bad.success).toBe(false);
    expect(Array.isArray(bad.errors)).toBe(true);

    // Valid draft → persisted (the copilot's confirmed write).
    const ok = await persist({ name: 'Late-stage customers', filters: [{ field: 'stage', op: 'eq', value: 'customer' }], segmentId: 'seg:copilot-1' });
    expect(ok.success).toBe(true);
    const saved = await getSegment('tenant-seg', 'seg:copilot-1');
    expect(saved?.name).toBe('Late-stage customers');
    expect(saved?.filters).toEqual([{ field: 'stage', op: 'eq', value: 'customer' }]);
  });
});

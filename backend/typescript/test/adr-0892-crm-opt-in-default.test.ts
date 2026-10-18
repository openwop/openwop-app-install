/**
 * ADR 0892 — CRM is an opt-in bundle: its toggle defaults OFF, so a white-label
 * install starts without the CRM group. This supersedes ADR 0191 Phase 1, which
 * had defaulted `crm` on so the lighthouse templates would not throw mid-run;
 * ADR 0191 Phase 2's preflight now names the missing feature before a run.
 *
 * `analytics` stays on (it measures the public site and the paywall funnel, not
 * CRM). Locks both at the source of truth so a silent revert is a loud failure.
 */
import { describe, it, expect } from 'vitest';
import { crmFeature } from '../src/features/crm/feature.js';
import { analyticsFeature } from '../src/features/analytics/feature.js';

describe('ADR 0892 — CRM is opt-in; analytics stays on', () => {
  it('crm toggle defaults off', () => {
    expect(crmFeature.toggleDefault?.status).toBe('off');
  });

  it('analytics toggle still defaults on', () => {
    expect(analyticsFeature.toggleDefault?.status).toBe('on');
  });

  it('crm keeps its A/B triage variants, so enabling it restores the split', () => {
    const variants = crmFeature.toggleDefault?.variants ?? [];
    expect(variants.map((v) => v.key).sort()).toEqual(['basic', 'enriched']);
    for (const v of variants) {
      expect(v.bindings?.some((b) => b.slot === 'crm.triage')).toBe(true);
    }
  });

  it('bucketUnit/salt unchanged (tenant-bucketed shared surfaces)', () => {
    expect(crmFeature.toggleDefault?.bucketUnit).toBe('tenant');
    expect(analyticsFeature.toggleDefault?.bucketUnit).toBe('tenant');
  });
});

describe('ADR 0892 extension — strategy, priority-matrix and advisory-board are opt-in', () => {
  it('each defaults off (supersedes ADR 0229 default-on)', async () => {
    const { strategyFeature } = await import('../src/features/strategy/feature.js');
    const { priorityMatrixFeature } = await import('../src/features/priority-matrix/feature.js');
    const { advisoryBoardFeature } = await import('../src/features/advisory-board/feature.js');
    expect(strategyFeature.toggleDefault?.status).toBe('off');
    expect(priorityMatrixFeature.toggleDefault?.status).toBe('off');
    expect(advisoryBoardFeature.toggleDefault?.status).toBe('off');
  });
});

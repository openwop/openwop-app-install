/**
 * ADR 0191 Phase 1 — the reference app ships the two product surfaces the
 * bundled `core.openwop.workflows.lighthouse` templates read (`crm`,
 * `analytics`) with their toggle default `on`, so those templates resolve out
 * of the box instead of throwing `host_capability_disabled` mid-run.
 *
 * Locks the decision at the source of truth (the exported feature modules) so a
 * revert to `off` is a loud test failure, not a silent broken-first-run.
 */
import { describe, it, expect } from 'vitest';
import { crmFeature } from '../src/features/crm/feature.js';
import { analyticsFeature } from '../src/features/analytics/feature.js';

describe('ADR 0191 — lighthouse-required features default on', () => {
  it('crm toggle defaults on', () => {
    expect(crmFeature.toggleDefault?.status).toBe('on');
  });

  it('analytics toggle defaults on', () => {
    expect(analyticsFeature.toggleDefault?.status).toBe('on');
  });

  it('crm keeps its A/B triage variants under status:on (on + variants ⇒ split, not clobbered)', () => {
    const variants = crmFeature.toggleDefault?.variants ?? [];
    expect(variants.map((v) => v.key).sort()).toEqual(['basic', 'enriched']);
    // both variants still bind the crm.triage slot — the experiment is intact
    for (const v of variants) {
      expect(v.bindings?.some((b) => b.slot === 'crm.triage')).toBe(true);
    }
  });

  it('the flip is minimal — bucketUnit/salt unchanged (tenant-bucketed shared surfaces)', () => {
    expect(crmFeature.toggleDefault?.bucketUnit).toBe('tenant');
    expect(analyticsFeature.toggleDefault?.bucketUnit).toBe('tenant');
  });
});

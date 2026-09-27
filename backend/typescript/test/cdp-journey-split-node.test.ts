/**
 * CDP-E — the journey experiment/holdout `split` node (ADR 0267). Asserts the node
 * CONTRACT directly (like the data-ops pack test): it buckets deterministically via
 * ctx.features bucketHoldout and outputs the arm for EdgeCondition routing; it fails
 * closed without a contactId or when the host capability is missing.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — importing the pack's .mjs node directly to assert its contract.
import { split } from '../../../packs/feature.campaign-journeys.nodes/index.mjs';
import { holdoutArm } from '../src/features/campaign-journeys/surface.js';

const noop = async () => ({});
function ctxWith(inputs: Record<string, unknown>, opts: { withBucket?: boolean } = {}) {
  const cj: Record<string, unknown> = { enroll: noop, checkEligibility: noop };
  if (opts.withBucket !== false) {
    cj.bucketHoldout = async (a: { contactId: string; experimentId: string; holdoutPct: number }) => {
      const r = holdoutArm(a.contactId, a.experimentId, a.holdoutPct);
      return { arm: r.arm, bucket: r.bucket, control: r.arm === 'control', treatment: r.arm === 'treatment' };
    };
  }
  return { inputs, triggerData: {}, nodeId: 'n1', features: { 'campaign-journeys': cj } };
}

describe('CDP-E journey split node', () => {
  it('outputs a deterministic arm + boolean edges', async () => {
    const out: any = await split(ctxWith({ contactId: 'crm:abc', experimentId: 'exp', holdoutPct: 50 }));
    expect(out.status).toBe('success');
    expect(['control', 'treatment']).toContain(out.outputs.arm);
    expect(out.outputs.control).toBe(!out.outputs.treatment);
    expect(out.outputs.contactId).toBe('crm:abc');
    const out2: any = await split(ctxWith({ contactId: 'crm:abc', experimentId: 'exp', holdoutPct: 50 }));
    expect(out2.outputs.arm).toBe(out.outputs.arm); // deterministic
  });

  it('fails closed without a contactId', async () => {
    const out: any = await split(ctxWith({}));
    expect(out.status).toBe('failed');
    expect(out.error.code).toBe('validation_error');
  });

  it('fails closed when bucketHoldout is unavailable', async () => {
    const out: any = await split(ctxWith({ contactId: 'crm:x' }, { withBucket: false }));
    expect(out.status).toBe('failed');
    expect(out.error.code).toBe('host_capability_missing');
  });
});

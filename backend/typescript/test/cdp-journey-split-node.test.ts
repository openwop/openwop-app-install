/**
 * CDP-E — the journey experiment/holdout `split` node (ADR 0267). Asserts the node
 * CONTRACT directly (like the data-ops pack test): it forwards contactId /
 * experimentId / holdoutPct (default 10) / orgId (ADR 0949 P3b, '' when absent) to
 * ctx.features bucketHoldout and outputs the
 * capability's arm verbatim (+ contactId) for EdgeCondition routing; it fails closed
 * without a contactId or when the host capability is missing.
 *
 * The bucketing itself (determinism, population split) is cdp-journey-holdout.test.ts;
 * here the capability is a RECORDING fake returning a fixed literal, so the test
 * asserts what the node does with its inputs and outputs, not the fake's arithmetic.
 *
 * Sabotage that reds it (w38 probes): dropping the contactId guard; dropping the
 * capability check (a TypeError instead of host_capability_missing); not echoing
 * contactId; a hard-coded holdoutPct; dropping experimentId; dropping orgId.
 */
import { describe, it, expect } from 'vitest';
import { split } from '../../../packs/feature.campaign-journeys.nodes/index.mjs';

type NodeResult = { status: string; outputs?: Record<string, unknown>; error?: { code: string; message: string } };
type BucketArgs = { contactId: string; experimentId: string; holdoutPct: number; orgId: string };
const ARM = { arm: 'control', bucket: 7, control: true, treatment: false } as const;

const noop = async () => ({});
function ctxWith(inputs: Record<string, unknown>, opts: { withBucket?: boolean } = {}) {
  const calls: BucketArgs[] = [];
  const cj: Record<string, unknown> = { enroll: noop, checkEligibility: noop };
  if (opts.withBucket !== false) {
    cj.bucketHoldout = async (a: BucketArgs) => { calls.push(a); return { ...ARM }; };
  }
  return { calls, ctx: { inputs, triggerData: {}, nodeId: 'n1', features: { 'campaign-journeys': cj } } };
}

describe('CDP-E journey split node', () => {
  it('outputs a deterministic arm + boolean edges', async () => {
    const { calls, ctx } = ctxWith({ contactId: 'crm:abc', experimentId: 'exp', holdoutPct: 50, orgId: 'org-a' });
    const out = (await split(ctx)) as NodeResult;
    expect(out.status).toBe('success');
    expect(calls).toEqual([{ contactId: 'crm:abc', experimentId: 'exp', holdoutPct: 50, orgId: 'org-a' }]);
    expect(out.outputs).toEqual({ ...ARM, contactId: 'crm:abc' });
  });

  it('defaults holdoutPct to 10 when the input omits it', async () => {
    const { calls, ctx } = ctxWith({ contactId: 'crm:abc', experimentId: 'exp' });
    expect(((await split(ctx)) as NodeResult).status).toBe('success');
    expect(calls).toEqual([{ contactId: 'crm:abc', experimentId: 'exp', holdoutPct: 10, orgId: '' }]);
  });

  it('fails closed without a contactId', async () => {
    const { calls, ctx } = ctxWith({});
    const out = (await split(ctx)) as NodeResult;
    expect(out.status).toBe('failed');
    expect(out.error).toEqual({ code: 'validation_error', message: 'contactId is required.' });
    expect(calls).toHaveLength(0);
  });

  it('fails closed when bucketHoldout is unavailable', async () => {
    const { ctx } = ctxWith({ contactId: 'crm:x' }, { withBucket: false });
    const out = (await split(ctx)) as NodeResult;
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('host_capability_missing');
  });
});

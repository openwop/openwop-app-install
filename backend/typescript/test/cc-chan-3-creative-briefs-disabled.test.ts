/**
 * CC-CHAN-3 — with the Creative Briefs toggle OFF, `create-creative-briefs` failed
 * `creative_briefs_not_created` ("Something went wrong") AFTER the person approved
 * the draft (casavoga.com v0.14.0, run 85847a2a). The node tried to skip when the
 * feature is off, but tested that `ctx.features['creative-briefs'].create` is a
 * function, which is always true: the host provides the surface and a disabled
 * tenant gets `host_capability_disabled` from every call. Those refusals were then
 * counted and dropped, so nothing named the cause.
 *
 * Red before the fix: the disabled surface produced `status: 'failed'`, and an
 * ordinary failure's message named no cause.
 */
import { describe, expect, it } from 'vitest';
import { nodes } from '../../../packs/feature.campaign-channels.nodes/index.mjs';

const createCreativeBriefs = nodes['feature.campaign-channels.nodes.create-creative-briefs']!;
const draft = { channel: 'creative_briefs', briefs: [{ format: 'story', sceneDescription: 'a lamp' }] };
const disabled = (): Error => Object.assign(new Error("feature 'creative-briefs' is not enabled for this tenant"), { code: 'host_capability_disabled' });

function ctxWith(surface: Record<string, unknown>): Record<string, unknown> {
  return {
    inputs: { briefId: 'brief-1', draft },
    features: {
      'campaign-brief': { assembleContext: async () => ({ found: true, brief: { orgId: 'org-1', productName: 'Lamp' } }) },
      'creative-briefs': surface,
    },
  };
}

type Out = { status: string; outputs?: { skipped?: boolean; reason?: string }; error?: { code: string; message: string; details?: { causes?: string[] } } };

describe('CC-CHAN-3 — a disabled Creative Briefs surface skips, never fails after approval', () => {
  it('skips with reason feature_disabled when every surface call is refused as disabled', async () => {
    const out = (await createCreativeBriefs(ctxWith({ list: async () => { throw disabled(); }, create: async () => { throw disabled(); } }))) as Out;
    expect(out.status).toBe('success');
    expect(out.outputs?.skipped).toBe(true);
    expect(out.outputs?.reason).toBe('feature_disabled');
  });

  it('skips the same way when only create reports the feature off', async () => {
    const out = (await createCreativeBriefs(ctxWith({ list: async () => ({ briefs: [] }), create: async () => { throw disabled(); } }))) as Out;
    expect(out.status).toBe('success');
    expect(out.outputs?.reason).toBe('feature_disabled');
  });

  it('an ordinary total failure names its cause in the message and details', async () => {
    const boom = Object.assign(new Error('db down'), { code: 'storage_unavailable' });
    const out = (await createCreativeBriefs(ctxWith({ list: async () => ({ briefs: [] }), create: async () => { throw boom; } }))) as Out;
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('creative_briefs_not_created');
    expect(out.error?.message).toContain('storage_unavailable');
    expect(out.error?.details?.causes).toEqual(['storage_unavailable']);
  });
});

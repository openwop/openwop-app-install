/**
 * ADR 1039 D1 (architect A1) — when the creative-briefs write floor refuses the
 * run's person, `create-creative-briefs` fails with THAT refusal. Before: every
 * create error was counted into `briefCreateErrors` and the step said "Try
 * approving the draft again", which is false for a scope refusal: approving again
 * cannot give the run's starter `workspace:write`.
 *
 * Red when a `forbidden_scope` from `ctx.features['creative-briefs'].create` is
 * swallowed into `creative_briefs_not_created`, or when an ordinary create error
 * stops being counted.
 */
import { describe, expect, it } from 'vitest';
import { nodes } from '../../../packs/feature.campaign-channels.nodes/index.mjs';

const createCreativeBriefs = nodes['feature.campaign-channels.nodes.create-creative-briefs']!;

const draft = { channel: 'creative_briefs', briefs: [{ format: 'story', sceneDescription: 'a lamp' }, { format: 'feed', sceneDescription: 'a desk' }] };

function ctxWith(create: () => Promise<unknown>): Record<string, unknown> {
  return {
    inputs: { briefId: 'brief-1', draft },
    features: {
      'campaign-brief': { assembleContext: async () => ({ found: true, brief: { orgId: 'org-1', productName: 'Lamp' } }) },
      'creative-briefs': { list: async () => ({ briefs: [] }), create },
    },
  };
}

describe('ADR 1039 D1 — create-creative-briefs passes a scope refusal through', () => {
  it('forbidden_scope fails the step with that code, not "try approving again"', async () => {
    const refusal = Object.assign(new Error('Missing required scope: workspace:write'), { code: 'forbidden_scope' });
    const out = (await createCreativeBriefs(ctxWith(async () => { throw refusal; }))) as { status: string; error: { code: string; message: string } };
    expect(out.status).toBe('failed');
    expect(out.error.code).toBe('forbidden_scope');
    expect(out.error.message).not.toMatch(/approving/i);
  });

  it('an ordinary create error is still counted, and partial success stays success', async () => {
    let n = 0;
    const out = (await createCreativeBriefs(ctxWith(async () => {
      n += 1;
      if (n === 1) throw new Error('storage hiccup');
      return { brief: { briefId: 'cbrief:2' } };
    }))) as { status: string; outputs: { createdBriefIds: string[]; briefCreateErrors: number } };
    expect(out.status).toBe('success');
    expect(out.outputs.createdBriefIds).toEqual(['cbrief:2']);
    expect(out.outputs.briefCreateErrors).toBe(1);
  });
});

/**
 * XCH-APPB-3 (LLM-EXCHANGE-AUDIT Wave 2): the design chain persisted
 * AI-authored app docs WITHOUT closed-world validation — an out-of-catalog
 * component survived both HITL gates and 422ed on the user's first editor
 * save. The gate now lives where the workflow-author precedent puts it: a
 * `validate` op on the feature surface, called by the pack's render/deepen
 * nodes when the surface is present.
 */
import { describe, expect, it } from 'vitest';
import { buildAppBuilderSurface } from '../surface.js';
import { registerAppBuilderComponents } from '../componentCatalog.js';
// eslint-disable-next-line import/no-relative-packages -- vendored pack, the runtime loads it the same way
import { render, deepen } from '../../../../../../packs/feature.app-builder.nodes/index.mjs';

registerAppBuilderComponents();

const surface = buildAppBuilderSurface({ tenantId: 't1' } as never);

const validApp = {
  name: 'Parity',
  screens: [{ id: 'home', name: 'Home', isInitial: true, components: [{ type: 'heading', props: { text: 'Hi' } }] }],
};

describe('app-builder surface.validate (XCH-APPB-3)', () => {
  it('returns ok for a catalog-conformant doc', async () => {
    const v = await (surface.validate as (a: Record<string, unknown>) => Promise<{ ok: boolean }>)({ app: validApp });
    expect(v.ok).toBe(true);
  });

  it('rejects an out-of-catalog component type', async () => {
    const bad = { ...validApp, screens: [{ ...validApp.screens[0], components: [{ type: 'holo-deck', props: {} }] }] };
    const v = await (surface.validate as (a: Record<string, unknown>) => Promise<{ ok: boolean; errors: unknown[] }>)({ app: bad });
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });
});

describe('render node gates through the surface (XCH-APPB-3)', () => {
  const features = { 'app-builder': surface };

  it('fails typed on an out-of-catalog type instead of emitting the artifact', async () => {
    const app = { name: 'Bad', screens: [{ id: 's1', name: 'S1', components: [{ type: 'holo-deck', props: {} }] }] };
    await expect(render({ inputs: { app }, features })).rejects.toMatchObject({ code: 'app_doc_invalid' });
  });

  it('passes a conformant doc and reports the validation verdict', async () => {
    const r = await render({ inputs: { app: validApp }, features });
    expect(r.status).toBe('success');
    expect(r.outputs.validation).toMatchObject({ ok: true });
  });

  it('stays normalize-only (honestly unvalidated) on hosts without the surface', async () => {
    const app = { name: 'Foreign', screens: [{ id: 's1', name: 'S1', components: [{ type: 'holo-deck', props: {} }] }] };
    const r = await render({ inputs: { app } });
    expect(r.status).toBe('success');
    expect(r.outputs.validation).toEqual({ unvalidated: true });
  });
});

describe('deepen reverts AI enrichments that leave the closed world (XCH-APPB-3)', () => {
  it('keeps the original screens when the merged doc fails validation', async () => {
    const features = { 'app-builder': surface };
    const artifact = { artifactTypeId: 'canvas.app-builder', payload: structuredClone(validApp), title: 'Parity' };
    const ctx = {
      inputs: { artifact },
      features,
      config: {},
      // The AI leg proposes an out-of-catalog component for every screen.
      callAI: async () => ({ content: JSON.stringify([{ type: 'holo-deck', props: {} }, { type: 'text', props: { text: 'x' } }]) }),
    };
    const r = await deepen(ctx);
    expect(r.status).toBe('success');
    expect(r.outputs.deepened).toEqual([]);
    const screens = (r.outputs.artifact as { payload: typeof validApp }).payload.screens;
    expect(JSON.stringify(screens)).not.toContain('holo-deck');
  });
});

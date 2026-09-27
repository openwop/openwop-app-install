/**
 * UX_UPGRADE-cad ROUND 2 — the three backend defects R1 never looked at.
 *
 * R1's tracker declares "Screens: 1" and names ZERO backend files. Every module
 * exercised here was created on 2026-07-17 or 2026-07-22 — before R1 merged on
 * 2026-07-25 — so this is coverage the feature has never had, not a regression
 * suite for something that once worked.
 *
 *  - CAD2-B1: the agent round-trip DROPPED `rotation`/`metallic`/`roughness`.
 *    `openwop:cad.render` writes with `merge:'replace'` and the agent's own
 *    prompt tells it to read-then-modify the real solids, so a faithful echo
 *    destroyed every one of those user edits.
 *  - CAD2-B2: `formatDimension` hard-rounded to 2dp for every unit, putting the
 *    displayed nominal OUTSIDE its own stated tolerance in `in` and `m` — on a
 *    toleranced GD&T annotation, i.e. a manufacturing instruction.
 *
 * CAD2-B3 (the approximate volume summed into a total marked exact) is pinned
 * END-TO-END in `cad-mesh-routes.test.ts`, against a real stored mesh asset,
 * rather than a hand-built BomDoc here — the CSV a user downloads is the
 * artifact that carried the false claim.
 */
import { describe, expect, it } from 'vitest';
import { formatDimension } from '../src/features/cad/cadDims.js';
// Static import — the convention every other pack test uses (`adr0411-reel-node`,
// `ai-exchange-round2`); a dynamic `await import` of an untyped .mjs is implicit-any.
import { render } from '../../../packs/feature.cad.nodes/index.mjs';

describe('CAD2-B1 — the render node preserves every editable solid field', () => {
  it('keeps rotation, metallic and roughness through a read→modify→write round-trip', async () => {
    const authored = {
      kind: 'box', x: 0, y: 0, z: 0, width: 10, height: 10, depth: 10,
      rotation: 45, metallic: 0.9, roughness: 0.2, materialId: 'steel', label: 'base',
    };
    const out = await render({ inputs: { model: { solids: [authored], units: 'mm' } } });
    const solid = out.outputs.artifact.payload.solids[0]! as Record<string, unknown>;

    // Each is honoured by a real consumer: tessellation + `poseMesh`
    // (meshCodec), GLB materials (cadExport), and `cadDims`, where an
    // `angular` dimension IS `solid.rotation` — so losing it silently reset a
    // 45° bracket's annotation to 0°.
    expect(solid.rotation, 'rotation survives').toBe(45);
    expect(solid.metallic, 'metallic survives').toBe(0.9);
    expect(solid.roughness, 'roughness survives').toBe(0.2);
    // …and the fields that always worked still do, so this is not a blanket
    // pass-through that would let an unknown field reach durable geometry.
    expect(solid.materialId).toBe('steel');
    expect(solid.width).toBe(10);
  });

  it('still refuses a field that is NOT a legal solid property (the control)', async () => {
    // CORRECTED (review CAD2-R3): the first version probed with a STRING
    // (`bogusField: 'nope'`) while the fix changed the NUMERIC allowlist — so it
    // passed even against a blanket `for (const k of Object.keys(raw))`
    // pass-through, proven by sabotage. A control has to be made of the same
    // stuff as the thing it controls for.
    const out = await render({
      inputs: { model: { solids: [{ kind: 'box', width: 5, bogusNum: 7, bogusField: 'nope' }], units: 'mm' } },
    });
    const solid = out.outputs.artifact.payload.solids[0]! as Record<string, unknown>;
    expect(solid.bogusNum, 'an unknown NUMERIC field must not ride the allowlist').toBeUndefined();
    expect(solid.bogusField).toBeUndefined();
  });
});

describe('CAD2-B2 — a nominal is never displayed outside its own tolerance', () => {
  const sym = (unit: string, tolA: number) =>
    ({ kind: 'linear', unit, tolType: 'symmetric', tolA }) as never;

  it('inches: 1.4375 ±0.001 keeps enough places to sit inside the tolerance', () => {
    // Was `1.44 in ±0.001` — a display error of 0.0025, i.e. 2.5× the stated
    // tolerance, on a manufacturing instruction.
    const text = formatDimension(1.4375, sym('in', 0.001), 'in');
    expect(text).toBe('1.4375 in ±0.001');
    const shown = Number(/^([\d.]+)/.exec(text)![1]);
    expect(Math.abs(shown - 1.4375)).toBeLessThanOrEqual(0.001);
  });

  it('metres: 0.04052 ±0.0002 likewise', () => {
    const text = formatDimension(0.04052, sym('m', 0.0002), 'm');
    const shown = Number(/^([\d.]+)/.exec(text)![1]);
    expect(Math.abs(shown - 0.04052)).toBeLessThanOrEqual(0.0002);
  });

  it('mm without a tolerance is unchanged at 2dp (the negative control)', () => {
    // Without this, "more precision" would be satisfied by printing raw floats
    // everywhere, which is a different readability defect.
    expect(formatDimension(40.005, { kind: 'linear', unit: 'mm' } as never, 'mm')).toBe('40.01 mm');
  });

  it('angular still renders degrees', () => {
    expect(formatDimension(45.123, { kind: 'angular' } as never, 'mm')).toBe('45.12°');
  });

  it('LIMIT tolerances land inside their own window (review CAD2-R1)', () => {
    // `limit` stores ABSOLUTE upper/lower limits, not deltas. The first cut of
    // this fix fed them to `Math.min(...)` as magnitudes, so `min(10.001,
    // 10.002)` read as a ±10.001 tolerance, dp stayed at 2, and the nominal
    // rendered OUTSIDE its stated window — the same Blocker, surviving in the
    // one tolerance grammar that had no test.
    const lim = (tolA: number, tolB: number) =>
      ({ kind: 'diameter', unit: 'mm', tolType: 'limit', tolA, tolB }) as never;

    const text = formatDimension(10.0015, lim(10.002, 10.001), 'mm');
    const shown = Number(/^([\d.]+)/.exec(text)![1]);
    expect(shown, `${text}: the nominal must sit inside its own limits`).toBeGreaterThanOrEqual(10.001);
    expect(shown).toBeLessThanOrEqual(10.002);

    const wide = formatDimension(39.9955, lim(39.999, 39.990), 'mm');
    const wideShown = Number(/^([\d.]+)/.exec(wide)![1]);
    expect(wideShown).toBeGreaterThanOrEqual(39.990);
    expect(wideShown).toBeLessThanOrEqual(39.999);
  });

  it('COMMON mm tolerances keep their existing 2dp output (the other control)', () => {
    // The invariant is "a display STEP fits inside the band", not "as many
    // digits as possible". mm is the default unit, so a rule that widened every
    // toleranced mm dimension would be a readability regression affecting far
    // more drawings than the defect it fixed — and the labels render as bare
    // 8px SVG text with no width budget, so extra digits can collide.
    const mm = (tolA: number) => ({ kind: 'linear', unit: 'mm', tolType: 'symmetric', tolA }) as never;
    expect(formatDimension(12.3456, mm(0.5), 'mm')).toBe('12.35 mm ±0.5');
    expect(formatDimension(12.3456, mm(0.05), 'mm')).toBe('12.35 mm ±0.05');
    expect(formatDimension(12.3456, mm(0.01), 'mm')).toBe('12.35 mm ±0.01');
    // …and only tightens where it must: ±0.001 cannot be honoured at 2dp.
    expect(formatDimension(12.3456, mm(0.001), 'mm')).toBe('12.346 mm ±0.001');
  });
});

describe('CAD2-R4 — the model-facing texts name every field the node preserves', () => {
  it('the prompt, the tool description and the pack doc all list them', async () => {
    // The mechanical fix (adding three names to an allowlist) is only half the
    // contract. `render` writes with `merge:'replace'`, so a model that follows
    // a prompt describing the solid shape as `{x,y,z}` + `color` + `label` will
    // re-emit exactly that and destroy the rest — the same data loss, arrived at
    // by obedience rather than by a bug. Three hand-written texts describe this
    // payload, and nothing pinned them, so the fix could look complete while the
    // instruction that causes the loss stayed on the page.
    const { readFileSync } = await import('node:fs');
    const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
    const prompt = read('../../../packs/feature.cad.agents/prompts/cad-modeler.md');
    const pack = read('../../../packs/feature.cad.nodes/pack.json');
    const tool = read('../src/features/cad/agentTools.ts');

    // Anchored on the SOLID-SHAPE sentence, not the whole file. A bare
    // `toContain` over the document passes as soon as the word appears anywhere
    // — including in the "carry every field back out" paragraph — so deleting
    // the enumeration itself left it green. A sabotage probe proved exactly
    // that, which is the second time a `toContain` wiring assertion has been too
    // loose in this programme.
    const shapeSentence = /All solids accept[\s\S]*?Use a consistent unit scale/.exec(prompt)?.[0];
    expect(shapeSentence, 'the prompt should still enumerate the solid shape').toBeTruthy();
    const toolShape = /all accept a position[\s\S]*?assetRef\.\)/.exec(tool)?.[0];
    expect(toolShape, 'the tool description should still enumerate the solid shape').toBeTruthy();

    for (const field of ['rotation', 'metallic', 'roughness', 'materialId']) {
      expect(shapeSentence!, `the prompt's solid-shape sentence must name \`${field}\``).toContain(field);
      expect(toolShape!, `the tool's solid-shape sentence must name \`${field}\``).toContain(field);
      expect(pack, `the render node's pack doc must name \`${field}\``).toContain(field);
    }
    // …and the prompt must say the write REPLACES, which is why dropping a field
    // deletes it rather than leaving it alone.
    expect(prompt.toLowerCase()).toContain('replaces');
  });
});

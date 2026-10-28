/**
 * ADR 0945 P1 — stage A (the deterministic fidelity check), witnessed through
 * the REAL renderer's output, not synthetic pixels.
 *
 * A cut-out (a product on a transparent background) is composed by `renderAd`
 * exactly as a product shot is, then sampled back:
 *  - the identity composite passes every check;
 *  - a RECOLOURED product (same shape, different colour) fails ΔE2000 — the
 *    exit-criterion sabotage (ADR 0945 § Phased plan, P1);
 *  - a product with a MISSING PART (a smaller shape inside the source
 *    silhouette) fails the perceptual hashes;
 *  - the ΔE2000 implementation matches a published reference pair.
 * Breaks if the mask stops following the source alpha, the candidate crop
 * drifts from the slot the renderer drew into, or a threshold is loosened
 * without a ruleset bump.
 */
import { describe, expect, it } from 'vitest';
import { Resvg } from '@resvg/resvg-js';
import { renderAd, type BrandRenderTokens } from '../src/features/creative-briefs/render/renderCreative.js';
import { BUNDLED_FONT_FAMILIES } from '../src/features/creative-briefs/render/fonts.js';
import { getTemplate } from '../src/features/creative-briefs/render/templates.js';
import { imageLayerSlot } from '../src/features/creative-briefs/render/renderCreative.js';
import {
  STAGE_A_RULES, FIDELITY_RULESET_VERSION, deltaE2000, productMask, rasteriseCrop, rasteriseIntoSlot, runStageA,
} from '../src/host/creativeFidelity/index.js';

const png = (svg: string): string => Buffer.from(new Resvg(svg).render().asPng()).toString('base64');
/** A product cut-out: a shape on a TRANSPARENT 200×200 canvas. */
const cutout = (shape: string): string => png(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">${shape}</svg>`);
const scene = png('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#2e7d32"/></svg>');

const RED_MUG = cutout('<rect x="30" y="20" width="120" height="160" rx="10" fill="#c62828"/><rect x="150" y="70" width="30" height="60" fill="#c62828"/>');
const BLUE_MUG = cutout('<rect x="30" y="20" width="120" height="160" rx="10" fill="#1565c0"/><rect x="150" y="70" width="30" height="60" fill="#1565c0"/>');
const RED_MUG_NO_BODY_HALF = cutout('<rect x="30" y="20" width="120" height="80" rx="10" fill="#c62828"/><rect x="150" y="70" width="30" height="60" fill="#c62828"/>');

const template = getTemplate('meta.feed.1x1')!;
const brand: BrandRenderTokens = { colors: { ink: '#111111', paper: '#ffffff', accent: '#ff6600', accentInk: '#ffffff' }, fontFamilies: { sans: BUNDLED_FONT_FAMILIES.sans, serif: BUNDLED_FONT_FAMILIES.serif } };

function compose(product: string): string {
  const out = renderAd({
    template,
    content: {
      images: {
        background: { dataUri: `data:image/png;base64,${scene}`, sha256: 'b' },
        product: { dataUri: `data:image/png;base64,${product}`, sha256: 'p' },
      },
      texts: { headline: 'A mug' },
    },
    brand,
  });
  return out.png.toString('base64');
}

function judge(sourceB64: string, compositeB64: string) {
  const slot = imageLayerSlot(template, 'product')!;
  const g = STAGE_A_RULES.grid;
  const source = rasteriseIntoSlot('image/png', sourceB64, slot.box, g);
  const candidate = rasteriseCrop('image/png', compositeB64, { w: template.width, h: template.height }, slot.box, g);
  return runStageA(source, candidate, productMask(source, { w: slot.box.w, h: slot.box.h, radiusPx: slot.radiusPx }));
}
const byId = (checks: ReturnType<typeof judge>) => Object.fromEntries(checks.map((c) => [c.id, c]));

describe('stage A over a real composite (ruleset ' + FIDELITY_RULESET_VERSION + ')', () => {
  it('the identity composite passes every check, near zero', () => {
    const c = byId(judge(RED_MUG, compose(RED_MUG)));
    expect(c.dhash.status).toBe('pass');
    expect(c.phash.status).toBe('pass');
    expect(c.colour_delta_e.status).toBe('pass');
    expect(c.colour_delta_e.value!).toBeLessThan(2);
  });

  it('SABOTAGE: a recoloured product fails ΔE2000 even though its shape is identical', () => {
    const c = byId(judge(RED_MUG, compose(BLUE_MUG)));
    expect(c.colour_delta_e.status).toBe('fail');
    expect(c.colour_delta_e.value!).toBeGreaterThan(STAGE_A_RULES.deltaEMax * 3);
  });

  it('SABOTAGE: a product with a missing part fails the perceptual hashes', () => {
    const checks = judge(RED_MUG, compose(RED_MUG_NO_BODY_HALF));
    expect(checks.some((x) => (x.id === 'dhash' || x.id === 'phash') && x.status === 'fail'), JSON.stringify(checks)).toBe(true);
  });

  it('an empty silhouette is never a pass', () => {
    const empty = cutout('');
    const checks = judge(empty, compose(RED_MUG));
    expect(checks.every((c) => c.status === 'fail')).toBe(true);
  });

  it('CIEDE2000 matches the Sharma/Wu/Dalal reference pair 1 (2.0425)', () => {
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3);
    expect(deltaE2000([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(27.1492, 3);
  });
});

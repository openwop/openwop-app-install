/**
 * Grade pass GC-CV-4 — FE/BE element-cap parity pins. The backend validators
 * are the authority (a FE cap looser than the server means an edit the save
 * 422s; tighter means a silently unreachable schema range).
 *
 * w46 correction: this header used to say "the caps are restated here as
 * LITERALS … changing either side without the other breaks this test". Only the
 * FE half was true — the backend numbers were copies, so `MAX_SHAPES = 2001`
 * stayed green (probes w46g2-cap-be-drawings / -cap-be-slides were vacuous).
 * Like `features/projects/__tests__/charterCapParity.test.ts`, this file now
 * PARSES the backend validator source (a frontend test can read it; a backend
 * test cannot import the FE definitions). Every parser miss THROWS, so no case
 * can pass on nothing. The `min: 1` floors are checked against the validator's
 * "needs at least one" refusal (`<col>.length === 0`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { slidesDefinition } from '../../features/slides/definition.js';
import { drawingsDefinition } from '../../features/drawings/definition.js';
import { cadDefinition } from '../../features/cad/definition.js';
import { campaignStudioDefinition } from '../../features/campaign-studio/definition.js';

const BACKEND_FEATURES = join(process.cwd(), '../../backend/typescript/src/features');
const backendSrc = (rel: string): string => readFileSync(join(BACKEND_FEATURES, rel), 'utf8');

const SLIDES = backendSrc('slides/validateSlidesDoc.ts');
const DRAWINGS = backendSrc('drawings/validateDrawingDoc.ts');
const CAD = backendSrc('cad/validateCadDoc.ts');
const CAMPAIGN = backendSrc('campaign-studio/validateCampaignDoc.ts');

/** `export const MAX_X = 100;` → 100. Throws on a miss. */
function constant(src: string, name: string): number {
  const m = new RegExp(`const ${name}\\s*=\\s*(\\d+)\\s*;`).exec(src);
  if (!m) throw new Error(`${name} not found in the backend validator — the parser needs updating, not the expectation`);
  return Number(m[1]);
}

/** The validator really ENFORCES the constant on that collection (`<col>.length > MAX_X`),
 *  so a renamed/unused constant cannot keep this file green. Returns the parsed cap. */
function enforcedCap(src: string, col: string, name: string): number {
  if (!new RegExp(`\\b${col}\\.length > ${name}\\b`).test(src)) {
    throw new Error(`\`${col}.length > ${name}\` not found — the validator no longer enforces ${name} on ${col}`);
  }
  return constant(src, name);
}

/** The validator refuses an empty collection (the schema minItems: 1 floor). */
function refusesEmpty(src: string, col: string): boolean {
  return new RegExp(`\\b${col}\\.length === 0\\b`).test(src);
}

type Col = { key: string; max: number; min?: number };
const col = (def: { elements?: readonly Col[] }, key: string): Col => {
  const c = def.elements?.find((e) => e.key === key);
  if (!c) throw new Error(`no FE collection ${key}`);
  return c;
};

describe('FE definition caps mirror the backend validators', () => {
  it('slides — validateSlidesDoc.ts (MAX_SLIDES; a deck needs at least one slide)', () => {
    expect(slidesDefinition.frames?.max).toBe(enforcedCap(SLIDES, 'slides', 'MAX_SLIDES'));
    expect(refusesEmpty(SLIDES, 'slides')).toBe(true);
  });

  it('drawings — validateDrawingDoc.ts (MAX_SHAPES, minItems 1)', () => {
    const shapes = col(drawingsDefinition, 'shapes');
    expect(shapes.max).toBe(enforcedCap(DRAWINGS, 'shapes', 'MAX_SHAPES'));
    expect(shapes.min).toBe(1);
    expect(refusesEmpty(DRAWINGS, 'shapes')).toBe(true);
  });

  it('cad — validateCadDoc.ts (MAX_SOLIDS, minItems 1; dimensions cap)', () => {
    const solids = col(cadDefinition, 'solids');
    expect(solids.max).toBe(enforcedCap(CAD, 'solids', 'MAX_SOLIDS'));
    expect(solids.min).toBe(1);
    expect(refusesEmpty(CAD, 'solids')).toBe(true);
    // The dimensions cap is an inline literal in the validator (`dims.length > 100`).
    const m = /\bdims\.length > (\d+)\b/.exec(CAD);
    if (!m) throw new Error('`dims.length > N` not found in validateCadDoc.ts');
    expect(col(cadDefinition, 'dimensions').max).toBe(Number(m[1]));
  });

  it('campaign — validateCampaignDoc.ts (channels / funnel / assets)', () => {
    const channels = col(campaignStudioDefinition, 'channels');
    expect(channels.max).toBe(enforcedCap(CAMPAIGN, 'channels', 'MAX_CHANNELS'));
    expect(channels.min).toBe(1);
    expect(refusesEmpty(CAMPAIGN, 'channels')).toBe(true);
    expect(col(campaignStudioDefinition, 'funnel').max).toBe(enforcedCap(CAMPAIGN, 'funnel', 'MAX_FUNNEL_STAGES'));
    expect(col(campaignStudioDefinition, 'assets').max).toBe(enforcedCap(CAMPAIGN, 'assets', 'MAX_ASSETS'));
  });
});

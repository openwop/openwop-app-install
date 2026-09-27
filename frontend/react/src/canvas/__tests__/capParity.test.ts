/**
 * Grade pass GC-CV-4 — FE/BE element-cap parity pins. The backend validators
 * are the authority (a FE cap looser than the server means an edit the save
 * 422s; tighter means a silently unreachable schema range). The caps are
 * deliberately restated here as LITERALS cross-referenced to the backend
 * files — changing either side without the other breaks this test, which is
 * the point.
 */
import { describe, expect, it } from 'vitest';
import { slidesDefinition } from '../../features/slides/definition.js';
import { drawingsDefinition } from '../../features/drawings/definition.js';
import { cadDefinition } from '../../features/cad/definition.js';
import { campaignStudioDefinition } from '../../features/campaign-studio/definition.js';

const colMax = (def: { elements?: { key: string; max: number; min?: number }[] }, key: string) =>
  def.elements!.find((c) => c.key === key)!;

describe('FE definition caps mirror the backend validators', () => {
  it('slides — backend/src/features/slides/validateSlidesDoc.ts (MAX_SLIDES)', () => {
    expect(slidesDefinition.frames.max).toBe(100);
  });
  it('drawings — backend/src/features/drawings/validateDrawingDoc.ts (MAX_SHAPES, minItems 1)', () => {
    // ADR 0333 Phase 3 raised MAX_SHAPES to 2000; Phase 6 aligned the FE gate.
    expect(colMax(drawingsDefinition, 'shapes')).toMatchObject({ max: 2000, min: 1 });
  });
  it('cad — backend/src/features/cad/validateCadDoc.ts (MAX_SOLIDS, minItems 1)', () => {
    expect(colMax(cadDefinition, 'solids')).toMatchObject({ max: 200, min: 1 });
  });
  it('campaign — backend/src/features/campaign-studio/validateCampaignDoc.ts (40/12/60)', () => {
    expect(colMax(campaignStudioDefinition, 'channels')).toMatchObject({ max: 40, min: 1 });
    expect(colMax(campaignStudioDefinition, 'funnel').max).toBe(12);
    expect(colMax(campaignStudioDefinition, 'assets').max).toBe(60);
  });
});

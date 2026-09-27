/**
 * ADR 0359 Phase 5 — the FE↔backend collab-registration drift pin. Every
 * first-party canvas type that registers `collab: true` on the backend
 * (`registerCanvasEditorRoutes` cfg) MUST declare the matching chassis binding
 * kind here, and vice versa — a one-sided flip means either a socket that 404s
 * a provisioning chassis, or a chassis that never provisions a served room.
 * The backend twin lives in backend/typescript/test/collab-authboundary.test.ts
 * (registry parity). Pack types are deliberately absent (v1 exclusion).
 */
import { describe, it, expect } from 'vitest';
import { documentDefinition } from '../../features/document-editor/definition.js';
import { slidesDefinition } from '../../features/slides/definition.js';
import { drawingsDefinition } from '../../features/drawings/definition.js';
import { cadDefinition } from '../../features/cad/definition.js';
import { campaignStudioDefinition } from '../../features/campaign-studio/definition.js';
import { appBuilderDefinition } from '../../features/app-builder/definition.js';
import { challengeOutlineDefinition } from '../../features/challenge-outline/definition.js';

describe('collab-capable canvas types (ADR 0359 Phase 5)', () => {
  it('pins each first-party type to its binding kind', () => {
    expect(documentDefinition.collab).toBe('document');       // y-prosemirror surface
    expect(slidesDefinition.collab).toBe('elements');         // frames + tree
    expect(appBuilderDefinition.collab).toBe('elements');     // frames + tree (+ graph projection)
    expect(drawingsDefinition.collab).toBe('elements');
    expect(cadDefinition.collab).toBe('elements');
    expect(campaignStudioDefinition.collab).toBe('elements');
    // ADR 0458 §2.3 — frames (single 'outline') + tree (days/children). MUST
    // mirror the backend registerCanvasEditorRoutes `collab: true` for
    // canvas.challenge-outline (backend twin: collab-authboundary.test.ts).
    expect(challengeOutlineDefinition.collab).toBe('elements');
  });

  it('every elements-kind type has traits the collab shape can bind (frames or elements)', () => {
    for (const def of [slidesDefinition, appBuilderDefinition, drawingsDefinition, cadDefinition, campaignStudioDefinition, challengeOutlineDefinition]) {
      const hasFrames = Boolean(def.frames?.key);
      const hasElements = Array.isArray(def.elements) && def.elements.length > 0;
      expect(hasFrames || hasElements).toBe(true);
    }
    // Deterministic slide ids (coerce preserves-when-present, `slide-<n>` when
    // absent) — the property that prevents id churn wars through the CRDT.
    const coerced = slidesDefinition.coerceDoc({ title: 'T', slides: [{ id: 'slide-7', layout: 'blank' }, { layout: 'blank' }] });
    const frames = (coerced as { slides?: { id?: string }[] }).slides ?? [];
    expect(frames[0]?.id).toBe('slide-7');                       // preserved when present
    expect(frames[1]?.id).toMatch(/^slide-\d+$/);                // deterministic synthesis
    // Re-coercing the SAME doc yields the SAME ids (no per-client churn).
    const again = slidesDefinition.coerceDoc(coerced as Record<string, unknown>);
    expect((again as { slides?: { id?: string }[] }).slides?.map((s) => s.id)).toEqual(frames.map((s) => s.id));
  });
});

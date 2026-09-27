/**
 * Tutorials registry sanity (ADR 0490): every tutorial is structurally sound —
 * unique ids, unique step ids (they are the progress keys), non-empty phases,
 * and only known content-block types (the renderer's discriminated union).
 */
import { describe, expect, it } from 'vitest';
import { TUTORIALS, getTutorial } from '../registry.js';

const KNOWN_TYPES = new Set(['instructions', 'feature-grid', 'callout', 'prose', 'checklist', 'code']);

describe('tutorials registry', () => {
  it('has the flagship funnel walkthrough', () => {
    expect(getTutorial('build-your-first-funnel')?.phases.length).toBe(10);
  });

  it('every tutorial is structurally sound', () => {
    const ids = new Set<string>();
    for (const tut of TUTORIALS) {
      expect(ids.has(tut.id)).toBe(false);
      ids.add(tut.id);
      expect(tut.phases.length).toBeGreaterThan(0);
      const stepIds = new Set<string>();
      for (const phase of tut.phases) {
        expect(phase.steps.length).toBeGreaterThan(0);
        for (const step of phase.steps) {
          expect(stepIds.has(step.id)).toBe(false); // progress keys must be unique
          stepIds.add(step.id);
          expect(step.content.length).toBeGreaterThan(0);
          for (const block of step.content) expect(KNOWN_TYPES.has(block.type)).toBe(true);
        }
      }
    }
  });
});

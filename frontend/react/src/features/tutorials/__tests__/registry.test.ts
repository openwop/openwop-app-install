/**
 * Tutorials registry sanity (ADR 0490): every tutorial is structurally sound —
 * unique ids, unique step ids (they are the progress keys), non-empty phases,
 * and only known content-block types (the renderer's discriminated union).
 *
 * w52: the flagship case pinned a bare `phases.length === 10`, a content count
 * that churns on any authoring edit. It now pins what makes that number matter:
 * the hero promises "in N phases", and the tutorial must have exactly N. The
 * KNOWN_TYPES check is kept as a runtime guard (it overlaps `tsc` on typed
 * content; no covering case exists to justify a cut). Sabotage-witnessed: a
 * duplicated step id, a duplicated tutorial id.
 */
import { describe, expect, it } from 'vitest';
import { TUTORIALS, getTutorial } from '../registry.js';

const KNOWN_TYPES = new Set(['instructions', 'feature-grid', 'callout', 'prose', 'checklist', 'code']);

describe('tutorials registry', () => {
  it('has the flagship funnel walkthrough, with as many phases as its hero promises', () => {
    const funnel = getTutorial('build-your-first-funnel');
    expect(funnel).not.toBeNull();
    const promised = /in (\d+) phases/.exec(funnel!.hero.subtitle);
    expect(promised, 'the hero states its phase count').not.toBeNull();
    expect(funnel!.phases.length).toBe(Number(promised![1]));
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

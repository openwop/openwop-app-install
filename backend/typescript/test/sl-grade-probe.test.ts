/**
 * GRADING PROBE — "Slides" (FEATURES.md ordinal 230). Evidence only. GREEN + CI-safe.
 * Exercises the closed-world deck validator `validateSlidesDoc` (the SSoT mirror of
 * the `canvas.slides` artifact schema) directly — the gate that makes the Slides AI
 * agent's output honest (invalid = typed error, never a fabricated slide) and that
 * the save route turns into a typed 422.
 *
 * SLP-1 (closed-world reject): an unknown layout, an unknown slide field, and an
 *     unknown deck field are all rejected (closed enum + additionalProperties mirror).
 * SLP-2 (per-layout closed world): `blocks` on a non-`blocks` slide, and `build:true`
 *     on a non-`blocks` slide, are rejected — the block catalog is gated to the
 *     `blocks` layout, so a deck cannot smuggle blocks onto a title slide.
 * SLP-3 (control): a well-formed deck validates clean.
 */
import { describe, it, expect } from 'vitest';
import { validateSlidesDoc } from '../src/features/slides/validateSlidesDoc.js';

const deck = (slides: unknown[], extra: Record<string, unknown> = {}) =>
  ({ title: 'Probe', theme: 'default', slides, ...extra });
const slide = (over: Record<string, unknown> = {}) => ({ layout: 'title', id: 's1', name: 'Slide 1', ...over });

describe('Slides — closed-world deck validator (by execution)', () => {
  it('SLP-1: closed-world rejects unknown layout / unknown slide field / unknown deck field', () => {
    expect(validateSlidesDoc(deck([slide({ layout: 'hologram' })])).errors.length).toBeGreaterThan(0);
    expect(validateSlidesDoc(deck([slide({ bogusField: 1 })])).errors.length).toBeGreaterThan(0);
    expect(validateSlidesDoc(deck([slide()], { rogueDeckField: true })).errors.length).toBeGreaterThan(0);
  });

  it('SLP-2: per-layout closed world — blocks / build only on a `blocks` slide', () => {
    // A blocks array on a `title` slide is rejected.
    expect(validateSlidesDoc(deck([slide({ blocks: [{ type: 'text', text: 'x' }] })])).errors.length).toBeGreaterThan(0);
    // build:true on a non-blocks slide is rejected.
    expect(validateSlidesDoc(deck([slide({ build: true })])).errors.length).toBeGreaterThan(0);
  });

  it('SLP-3 (control): a well-formed deck validates clean', () => {
    expect(validateSlidesDoc(deck([slide({ layout: 'title-bullets', bullets: ['a', 'b'] })])).errors).toEqual([]);
  });
});

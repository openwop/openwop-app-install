/**
 * Slides canvas (ADR 0153 Phase 1) — the host-side contract: `canvas.slides` is a
 * registered artifact type whose schema is what gates the `artifact.created` event
 * (ADR 0055 validateArtifact). A well-formed deck validates; a malformed one is
 * rejected with errors (so a bad deck never persists as a silent empty render).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerSlidesArtifactType } from '../artifactTypes.js';
import { validateArtifact, isRegisteredArtifactType } from '../../../host/artifactTypes.js';

const validDeck = {
  title: 'Q3 Strategy',
  theme: 'dark',
  slides: [
    { layout: 'title', title: 'Q3 Strategy', subtitle: 'Plan of record' },
    { layout: 'title-bullets', title: 'Goals', bullets: ['Grow ARR', 'Cut churn'] },
    { layout: 'section', title: 'Execution' },
    { layout: 'quote', title: 'Make it work, then make it fast.', attribution: '— Kent Beck' },
    { layout: 'image', title: 'Architecture', imageUrl: 'https://example.com/diagram.png' },
    { layout: 'blank' },
  ],
};

describe('canvas.slides artifact type', () => {
  // Register once (validateArtifact is read-only; the registry persists for the file).
  beforeAll(() => { registerSlidesArtifactType(); });

  it('registers canvas.slides', () => {
    expect(isRegisteredArtifactType('canvas.slides')).toBe(true);
  });

  it('accepts a well-formed deck', () => {
    const r = validateArtifact('canvas.slides', validDeck);
    expect(r).toMatchObject({ registered: true, valid: true });
  });

  it('rejects an empty deck (no slides)', () => {
    const r = validateArtifact('canvas.slides', { slides: [] });
    expect(r.registered).toBe(true);
    expect(r.valid).toBe(false);
  });

  it('rejects an unknown slide layout', () => {
    const r = validateArtifact('canvas.slides', { slides: [{ layout: 'carousel', title: 'x' }] });
    expect(r.valid).toBe(false);
  });

  it('rejects unknown top-level properties (closed schema)', () => {
    const r = validateArtifact('canvas.slides', { slides: [{ layout: 'blank' }], script: 'alert(1)' });
    expect(r.valid).toBe(false);
  });

  it('rejects unknown per-slide properties (closed schema)', () => {
    const r = validateArtifact('canvas.slides', { slides: [{ layout: 'blank', onclick: 'x' }] });
    expect(r.valid).toBe(false);
  });

  it('rejects a non-string bullet', () => {
    const r = validateArtifact('canvas.slides', { slides: [{ layout: 'title-bullets', bullets: [1, 2] }] });
    expect(r.valid).toBe(false);
  });
});

/**
 * Grade pass DATA-CV-2 — pins the slides editor-doc ↔ artifact-schema
 * ASYMMETRY: the working copy carries per-slide `id`/`name` (the frames
 * trait's identity fields, required by `validateSlidesDoc`), which the
 * positional artifact schema REJECTS. Any path that re-emits a working copy
 * as a `canvas.slides` artifact must route through `normalizeDeckForArtifact`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { registerSlidesArtifactType } from '../artifactTypes.js';
import { validateArtifact } from '../../../host/artifactTypes.js';
import { normalizeDeckForArtifact, validateSlidesDoc } from '../validateSlidesDoc.js';
import { registerSlideBlocks } from '../blockCatalog.js';

// The blocks gate resolves the catalog at validate time (feature.ts registers
// it at boot); tests register it themselves.
registerSlideBlocks();

const editorDoc = {
  title: 'Pitch',
  theme: 'dark',
  slides: [
    { id: 'cover', name: 'Cover', layout: 'title', title: 'Hello', subtitle: 'World' },
    { id: 'points', name: 'Points', layout: 'title-bullets', title: 'Why', bullets: ['a', 'b'] },
  ],
};

beforeAll(() => { registerSlidesArtifactType(); });

describe('slides editor-doc ↔ artifact-schema asymmetry (DATA-CV-2)', () => {
  it('the editor doc is VALID as a working copy but REJECTED as an artifact', () => {
    expect(validateSlidesDoc(editorDoc).errors).toEqual([]);
    const asArtifact = validateArtifact('canvas.slides', editorDoc);
    expect(asArtifact.registered).toBe(true);
    expect(asArtifact.valid).toBe(false); // id/name violate additionalProperties:false
  });

  it('normalizeDeckForArtifact strips the identity fields and the result validates', () => {
    const normalized = normalizeDeckForArtifact(editorDoc);
    const v = validateArtifact('canvas.slides', normalized);
    expect(v.valid, JSON.stringify(v.errors)).toBe(true);
    // Content preserved; only id/name gone.
    const slides = normalized.slides as Record<string, unknown>[];
    expect(slides[0]).toEqual({ layout: 'title', title: 'Hello', subtitle: 'World' });
    expect(slides[1]).toEqual({ layout: 'title-bullets', title: 'Why', bullets: ['a', 'b'] });
    // The input is not mutated.
    expect((editorDoc.slides[0] as Record<string, unknown>).id).toBe('cover');
  });
});

// ── ADR 0328 Phase 3 — the blocks validator gate (closed-world catalog). ───
describe('validateSlidesDoc — blocks slides', () => {
  const slide = (over: Record<string, unknown>): Record<string, unknown> => ({
    title: 'D',
    slides: [{ id: 's1', name: 'S', layout: 'blocks', blocks: [], ...over }],
  });

  it('accepts a valid blocks slide (catalog types, variant, nesting)', () => {
    const doc = slide({
      variant: 'two-col',
      blocks: [
        { type: 'heading', props: { text: 'T', level: '2' } },
        { type: 'bullets', props: { items: ['a'] } },
      ],
    });
    expect(validateSlidesDoc(doc).errors).toEqual([]);
  });

  it('rejects unknown block types, bad variants, and blocks on a non-blocks layout', () => {
    expect(validateSlidesDoc(slide({ blocks: [{ type: 'hologram', props: {} }] })).errors.length).toBeGreaterThan(0);
    expect(validateSlidesDoc(slide({ variant: 'diagonal' })).errors.some((e) => e.path.endsWith('.variant'))).toBe(true);
    const wrongLayout = { title: 'D', slides: [{ id: 's1', name: 'S', layout: 'title', blocks: [] }] };
    expect(validateSlidesDoc(wrongLayout).errors.some((e) => e.path.endsWith('.blocks'))).toBe(true);
    const missing = { title: 'D', slides: [{ id: 's1', name: 'S', layout: 'blocks' }] };
    expect(validateSlidesDoc(missing).errors.some((e) => e.message.includes('requires a blocks array'))).toBe(true);
  });
});

// ── ADR 0328 Phase 5 — motion fields. ──────────────────────────────────────
describe('validateSlidesDoc — motion fields', () => {
  it('accepts transition + build; rejects bad values and build off blocks slides', () => {
    const ok = { title: 'D', slides: [{ id: 's1', name: 'S', layout: 'blocks', blocks: [], transition: 'magic', build: true }] };
    expect(validateSlidesDoc(ok).errors).toEqual([]);
    const badT = { title: 'D', slides: [{ id: 's1', name: 'S', layout: 'title', transition: 'spin' }] };
    expect(validateSlidesDoc(badT).errors.some((e) => e.path.endsWith('.transition'))).toBe(true);
    const badB = { title: 'D', slides: [{ id: 's1', name: 'S', layout: 'title', build: true }] };
    expect(validateSlidesDoc(badB).errors.some((e) => e.path.endsWith('.build'))).toBe(true);
  });
});

/**
 * Slides CanvasTypeDefinition tests (ADR 0310 Phase B) — the coercion that
 * synthesizes the frames trait's identity fields (per-slide id/name) over the
 * positional artifact schema, and the frames-trait binding itself.
 *
 * /grade-tests w52 — witnessed by sabotage of `definition.tsx` / `canvas/frameOps.ts`:
 * id dedup, layout clamp, bullet filtering, the minItems slide, `uniqueIds`
 * (ADR 0886 SL2CD-1) and its 48-char cap, legacy→blocks variant/notes, the
 * no-reconvert guard, notes absent from renderFrame (the S7 leak), the build cap,
 * the leading-'with' anchor, the group boundary, sectionOf, and buildStepsOf's
 * blocks-only gate (the legacy fixture now CARRIES blocks, so the gate is
 * load-bearing). The constant-only `share.resourceType` case is replaced by the
 * `mint` call it stood in for (7-day TTL parity).
 */
import { describe, expect, it, vi } from 'vitest';

// Narrow local shape: `mint` reads only `token` from the minted link.
const { createLink } = vi.hoisted(() => ({ createLink: vi.fn<(orgId: string, input: unknown) => Promise<{ token: string }>>() }));
vi.mock('../../sharing/sharingClient.js', async (orig) => ({
  ...(await orig<typeof import('../../sharing/sharingClient.js')>()),
  createLink,
}));
import { renderToStaticMarkup } from 'react-dom/server';
import { coerceDeck, slidesFrameOps, slidesDefinition, legacyToBlocks, type EditorSlide } from '../definition.js';

/** The frames trait is optional on the definition TYPE; slides declares it. */
function framesTrait(): NonNullable<typeof slidesDefinition.frames> {
  const f = slidesDefinition.frames;
  if (!f) throw new Error('slides declares no frames trait');
  return f;
}

describe('coerceDeck', () => {
  it('synthesizes stable unique ids and names from titles', () => {
    const doc = coerceDeck({
      title: 'Pitch',
      theme: 'dark',
      slides: [
        { layout: 'title', title: 'Welcome to Acme' },
        { layout: 'title-bullets', bullets: ['a', 1, 'b'] },
        { layout: 'quote', title: 'Q', id: 'quote-slide', name: 'The quote' },
      ],
    });
    expect(doc.title).toBe('Pitch');
    expect(doc.slides.map((s) => s.id)).toEqual(['slide-1', 'slide-2', 'quote-slide']);
    expect(doc.slides[0]?.name).toBe('Welcome to Acme');
    expect(doc.slides[1]?.name).toBe('Slide 2');
    expect(doc.slides[2]?.name).toBe('The quote');
    expect(doc.slides[1]?.bullets).toEqual(['a', 'b']); // non-strings dropped
  });

  it('dedups colliding ids and clamps unknown layouts', () => {
    const doc = coerceDeck({ slides: [{ id: 'x', layout: 'holo-deck' }, { id: 'x', layout: 'blank' }] });
    expect(doc.slides[0]?.layout).toBe('title-bullets');
    expect(doc.slides.map((s) => s.id)).toEqual(['x', 'slide-2']);
    expect(doc.title).toBe('Untitled deck');
  });

  it('guarantees at least one slide (the schema minItems)', () => {
    const doc = coerceDeck({ title: 'Empty' });
    expect(doc.slides).toHaveLength(1);
  });
});

describe('slides frames trait', () => {
  it('adds/duplicates/deletes slides with no home flag and the slide slug fallback', () => {
    const doc = coerceDeck({ title: 'D', slides: [{ layout: 'title', title: 'One' }] });
    const i = slidesFrameOps.addFrame(doc, '!!!');
    expect(i).toBe(1);
    expect(doc.slides[1]?.id).toMatch(/^slide-[a-z0-9]{6}$/); // slugFallback + never-reused suffix (ADR 0886)
    expect(doc.slides[1]?.layout).toBe('title-bullets'); // makeFrame default
    const d = slidesFrameOps.duplicateFrame(doc, 0);
    expect(d).toBe(1);
    expect(doc.slides[1]?.title).toBe('One');
    expect(slidesFrameOps.deleteFrame(doc, 2)).toBe(true);
    // The delete landed: the added slide (index 2 after the duplicate) is gone.
    expect(doc.slides).toHaveLength(2);
    expect(doc.slides.map((s) => s.title)).toEqual(['One', 'One']);
  });

  it('never re-mints a deleted slide id for the next slide of the same name (ADR 0886, SL2CD-1)', () => {
    const doc = coerceDeck({ title: 'D', slides: [{ layout: 'title', title: 'One' }] });
    const i = slidesFrameOps.addFrame(doc, 'Slide 2');
    const gone = doc.slides[i]!.id;
    expect(slidesFrameOps.deleteFrame(doc, i)).toBe(true);
    const seen = new Set<string>();
    for (let k = 0; k < 20; k++) {
      const j = slidesFrameOps.addFrame(doc, 'Slide 2');
      const id = doc.slides[j]!.id;
      expect(id).not.toBe(gone);
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/); // the backend slide-id slug
      seen.add(id);
      slidesFrameOps.deleteFrame(doc, j);
    }
    expect(seen.size).toBeGreaterThan(1);
    // A very long name still yields a valid (≤ 64) id.
    const long = slidesFrameOps.addFrame(doc, 'x'.repeat(200));
    expect(doc.slides[long]!.id.length).toBeLessThanOrEqual(64);
  });

  it('exposes per-layout property defs mirroring the renderer', () => {
    const defs = framesTrait().propDefs!;
    expect(defs({ id: 'a', name: 'A', layout: 'quote' }).map((p) => p.name)).toEqual(['layout', 'title', 'attribution', 'notes', 'background', 'skip', 'transition']);
    expect(defs({ id: 'a', name: 'A', layout: 'title-bullets' }).map((p) => p.name)).toEqual(['layout', 'title', 'bullets', 'notes', 'background', 'skip', 'transition']);
    expect(defs({ id: 'a', name: 'A', layout: 'blank' }).map((p) => p.name)).toEqual(['layout', 'notes', 'background', 'skip', 'transition']);
  });
});

// ── ADR 0328 Phase 3 — the block pivot. ────────────────────────────────────
describe('blocks slides (ADR 0328 P3)', () => {
  it('the blocks layout exposes variant/notes/background (content lives in the tree)', () => {
    const defs = framesTrait().propDefs!;
    expect(defs({ id: 'a', name: 'A', layout: 'blocks' }).map((p) => p.name)).toEqual(['layout', 'variant', 'build', 'notes', 'background', 'skip', 'transition']);
  });

  it('legacyToBlocks converts each legacy layout content-preservingly and strips the legacy fields', () => {
    const bul = legacyToBlocks({ id: 's1', name: 'S', layout: 'title-bullets', title: 'Highlights', bullets: ['a', 'b'], notes: 'n', background: 'accent' });
    expect(bul.layout).toBe('blocks');
    expect(bul.variant).toBe('full');
    expect(bul.blocks).toEqual([
      { type: 'heading', props: { text: 'Highlights', level: '2' } },
      { type: 'bullets', props: { items: ['a', 'b'] } },
    ]);
    expect(bul.notes).toBe('n');
    expect(bul.background).toBe('accent');
    expect('title' in bul).toBe(false);
    expect('bullets' in bul).toBe(false);

    const title = legacyToBlocks({ id: 't', name: 'T', layout: 'title', title: 'Deck', subtitle: 'Sub' });
    expect(title.variant).toBe('hero');
    expect(title.blocks?.map((b) => b.type)).toEqual(['heading', 'text']);

    const quote = legacyToBlocks({ id: 'q', name: 'Q', layout: 'quote', title: 'Wow', attribution: 'CEO' });
    expect(quote.blocks).toEqual([{ type: 'quote', props: { text: 'Wow', attribution: 'CEO' } }]);

    const img = legacyToBlocks({ id: 'i', name: 'I', layout: 'image', title: 'Chart', imageUrl: '/host/openwop-app/assets/tok12345' });
    expect(img.blocks?.[1]).toEqual({ type: 'image', props: { src: '/host/openwop-app/assets/tok12345', fit: 'cover' } });

    expect(legacyToBlocks({ id: 'b', name: 'B', layout: 'blank' }).blocks).toEqual([]);
  });

  it('transformOnPropChange converts ONLY on the layout→blocks change', () => {
    const hook = framesTrait().transformOnPropChange!;
    const legacy = { id: 's1', name: 'S', layout: 'title-bullets' as const, title: 'T', bullets: ['x'] };
    const converted = hook(legacy, 'layout', 'blocks');
    expect(converted?.layout).toBe('blocks');
    expect(converted?.blocks?.length).toBe(2);
    // Any other prop change falls through to the plain field set.
    expect(hook(legacy, 'layout', 'quote')).toBeUndefined();
    expect(hook(legacy, 'title', 'blocks')).toBeUndefined();
    // Already-blocks slides never re-convert (would wipe the tree).
    expect(hook({ id: 'b', name: 'B', layout: 'blocks', blocks: [] }, 'layout', 'blocks')).toBeUndefined();
  });

  it('treeEnabledFor gates tree editing to blocks slides; coerceDeck keeps variant+blocks', () => {
    const blocksSlide: EditorSlide = { id: 'a', name: 'A', layout: 'blocks' };
    const titleSlide: EditorSlide = { id: 'a', name: 'A', layout: 'title' };
    expect(slidesDefinition.treeEnabledFor!(blocksSlide)).toBe(true);
    expect(slidesDefinition.treeEnabledFor!(titleSlide)).toBe(false);
    // A third layout (the makeFrame default): the gate is "is blocks", not "is not title".
    const bulletsSlide: EditorSlide = { id: 'a', name: 'A', layout: 'title-bullets' };
    expect(slidesDefinition.treeEnabledFor!(bulletsSlide)).toBe(false);
    const doc = coerceDeck({ title: 'D', slides: [{ layout: 'blocks', variant: 'split', blocks: [{ type: 'heading', props: { text: 'X' } }] }] });
    expect(doc.slides[0]?.variant).toBe('split');
    expect(doc.slides[0]?.blocks?.length).toBe(1);
  });
});

// ── ADR 0328 Phase 4 — present trait: the notes-leak fix is structural. ────
describe('present trait (ADR 0328 P4)', () => {
  it('renderFrame renders the slide content and NEVER the speaker notes', () => {
    const doc = {
      title: 'D',
      theme: 'dark',
      slides: [{ id: 's1', name: 'S', layout: 'title', title: 'Visible headline', subtitle: 'Sub', notes: 'SECRET presenter notes' }],
    };
    const el = slidesDefinition.present!.renderFrame(doc, 0);
    const html = renderToStaticMarkup(el as JSX.Element);
    expect(html).toContain('Visible headline');
    expect(html).toContain("data-theme=\"dark\"");
    expect(html).not.toContain('SECRET presenter notes');
    expect(slidesDefinition.present!.renderFrame(doc, 9)).toBeNull();
  });

  it('skip survives the coercion', () => {
    const doc = coerceDeck({ title: 'D', slides: [{ layout: 'title', skip: true }] });
    expect(doc.slides[0]?.skip).toBe(true);
  });
});

// ── ADR 0328 Phase 5 — motion trait + build gating. ────────────────────────
describe('motion (ADR 0328 P5)', () => {
  const doc = {
    title: 'D',
    slides: [{
      id: 'b1', name: 'B', layout: 'blocks', variant: 'full', transition: 'magic', build: true,
      blocks: [
        { type: 'heading', props: { text: 'One' } },
        { type: 'bullets', props: { items: ['a'] } },
        { type: 'text', props: { text: 'Three' } },
      ],
    }],
  };

  it('transitionOf and buildStepsOf read the slide fields (build only on blocks slides)', () => {
    expect(slidesDefinition.present!.transitionOf!(doc, 0)).toBe('magic');
    expect(slidesDefinition.present!.buildStepsOf!(doc, 0)).toBe(3);
    // The legacy slide CARRIES blocks (coercion keeps them on any layout), so a
    // build count can only be 0 because of the blocks-layout gate.
    const legacy = { title: 'D', slides: [{ id: 'a', name: 'A', layout: 'title', build: true, blocks: [{ type: 'heading', props: { text: 'x' } }] }] };
    expect(slidesDefinition.present!.buildStepsOf!(legacy, 0)).toBe(0);
  });

  it('renderFrame caps visible blocks at the build step (visibility-gated, layout preserved)', () => {
    const html1 = renderToStaticMarkup(slidesDefinition.present!.renderFrame(doc, 0, 1) as JSX.Element);
    expect((html1.match(/canvas-slides__blk--pending/g) ?? []).length).toBe(2); // blocks 2+3 hidden
    const htmlAll = renderToStaticMarkup(slidesDefinition.present!.renderFrame(doc, 0, 3) as JSX.Element);
    expect(htmlAll).not.toContain('canvas-slides__blk--pending');
    // No cap (previews) renders everything.
    const htmlNoCap = renderToStaticMarkup(slidesDefinition.present!.renderFrame(doc, 0) as JSX.Element);
    expect(htmlNoCap).not.toContain('canvas-slides__blk--pending');
  });

  it('the blocks propDefs include build; every layout offers transition', () => {
    const defs = framesTrait().propDefs!;
    expect(defs({ id: 'a', name: 'A', layout: 'blocks' }).map((p) => p.name)).toEqual(['layout', 'variant', 'build', 'notes', 'background', 'skip', 'transition']);
    expect(defs({ id: 'a', name: 'A', layout: 'title' }).map((p) => p.name)).toContain('transition');
  });
});

// ── ADR 0328 Phase 7 — derived sections + the share trait. ─────────────────
describe('sections + share (ADR 0328 P7)', () => {
  it('sectionOf yields the section slide titles only', () => {
    const doc = { title: 'D', slides: [
      { id: 'a', name: 'A', layout: 'title', title: 'Open' },
      { id: 'b', name: 'B', layout: 'section', title: 'Part one' },
      { id: 'c', name: 'C', layout: 'blank' },
    ] };
    expect(slidesDefinition.present!.sectionOf!(doc, 0)).toBeUndefined();
    expect(slidesDefinition.present!.sectionOf!(doc, 1)).toBe('Part one');
    expect(slidesDefinition.present!.sectionOf!(doc, 2)).toBeUndefined();
  });

  it('mints a slides_canvas share link with the 7-day TTL and returns its shared-page URL', async () => {
    createLink.mockReset().mockResolvedValue({ token: 'tok-abc' });
    const url = await slidesDefinition.share!.mint('org-1', { resourceId: 'cv-1', label: 'Board' });
    expect(slidesDefinition.share?.resourceType).toBe('slides_canvas');
    expect(createLink).toHaveBeenCalledWith('org-1', { resourceType: 'slides_canvas', resourceId: 'cv-1', expiresInDays: 7, label: 'Board' });
    expect(url).toBe(`${window.location.origin}/shared/tok-abc`);
  });
});

// ADR 0328 Phase 8 — per-element build timing (with/after; absent = after).
import { buildGroupCount, blocksVisibleForSteps } from '../definition.js';
import type { CanvasNode } from '../../../canvas/types.js';

describe('per-element build timing (ADR 0328 P8)', () => {
  const b = (type: string, build?: string): CanvasNode => ({ type, props: { text: 'x', ...(build ? { buildTiming: build } : {}) } });

  it('absent build on every block = one group per block (the prior order-is-build behavior)', () => {
    expect(buildGroupCount([b('heading'), b('text'), b('bullets')])).toBe(3);
  });

  it("consecutive 'with' blocks join the previous step", () => {
    // [heading][text WITH][bullets][callout WITH][code WITH] → 2 groups... heading+text | bullets+callout+code
    const blocks = [b('heading'), b('text', 'with'), b('bullets', 'after'), b('callout', 'with'), b('code', 'with')];
    expect(buildGroupCount(blocks)).toBe(2);
    expect(blocksVisibleForSteps(blocks, 1)).toBe(2); // heading + its 'with' rider
    expect(blocksVisibleForSteps(blocks, 2)).toBe(5); // everything
    expect(blocksVisibleForSteps(blocks, 0)).toBe(0);
  });

  it("a leading 'with' still starts step 1 (the first block always anchors)", () => {
    const blocks = [b('heading', 'with'), b('text')];
    expect(buildGroupCount(blocks)).toBe(2);
    expect(blocksVisibleForSteps(blocks, 1)).toBe(1);
  });

  it('steps beyond the group count show every block', () => {
    const blocks = [b('heading'), b('text', 'with')];
    expect(blocksVisibleForSteps(blocks, 9)).toBe(2);
  });
});

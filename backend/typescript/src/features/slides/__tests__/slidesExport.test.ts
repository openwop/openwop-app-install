/**
 * ADR 0328 Phase 0+1 — the REAL deck exporters. These assert the produced
 * FILE CONTENT (unzipped pptx XML / pdf structure), not just that a function
 * returned — the seam lesson: an export that produces garbage passes any
 * button-level test.
 *
 * Expected colours are pinned as LITERALS, not read from SLIDE_THEMES, so a palette
 * sabotage cannot move the expectation with it. The PDF is asserted structurally only
 * (page count): pdfkit compresses its content streams, so the PDF case claims one page
 * per blocks slide and nothing about its text.
 * Sabotage that turns it red (w74 probes): dropping notes, bullets, the linked-image
 * placeholder, the slide background or the accent swap; one PDF page for the deck; a
 * theme or layout missing from the shared module; an asset token that accepts '..';
 * a non-hex brand channel; the chart placeholder, statCard value or blocks notes.
 */
import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import { renderDeckToPptx, renderDeckToPdf } from '../export/slidesExport.js';
import { SLIDE_THEMES, assetTokenFromUrl, SLIDE_GEOMETRY } from '../export/slideGeometry.js';
import { slidesSchema } from '../artifactTypes.js';

const deck = {
  title: 'Q3 Review',
  theme: 'editorial',
  slides: [
    { layout: 'title', title: 'Q3 Review', subtitle: 'Revenue and roadmap', notes: 'Welcome everyone to the review.' },
    { layout: 'title-bullets', title: 'Highlights', bullets: ['Revenue up 12%', 'Churn down 0.4pts', 'Two launches shipped'] },
    { layout: 'quote', title: 'The best quarter yet', attribution: 'A very real customer' },
    { layout: 'section', title: 'Roadmap' },
    { layout: 'image', title: 'The chart', imageUrl: 'https://example.com/external.png' },
    { layout: 'blank' },
  ],
};

describe('pptx export — content-level assertions', () => {
  it('produces a valid pptx whose slide XML carries titles, bullets, and REAL speaker notes', async () => {
    const buf = await renderDeckToPptx(deck);
    const zip = await JSZip.loadAsync(buf);
    // 6 slides on disk.
    const slideFiles = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    expect(slideFiles.length).toBe(6);
    const slide1 = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(slide1).toContain('Q3 Review');
    expect(slide1).toContain('Revenue and roadmap');
    const slide2 = await zip.file('ppt/slides/slide2.xml')!.async('string');
    expect(slide2).toContain('Revenue up 12%');
    expect(slide2).toContain('Churn down 0.4pts');
    // Speaker notes land as a REAL notes slide (the headline honesty fix).
    // Read slide 1's notes part BY NAME (zip key order is not a contract).
    const notes1 = await zip.file('ppt/notesSlides/notesSlide1.xml')!.async('string');
    expect(notes1).toContain('Welcome everyone to the review.');
  });

  it('external image URLs are NEVER fetched — a linked-image placeholder renders instead (SSRF posture)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    let buf: Buffer;
    try {
      buf = await renderDeckToPptx(deck);
      expect(fetchSpy).not.toHaveBeenCalled(); // never fetched — not even attempted
    } finally { fetchSpy.mockRestore(); }
    const zip = await JSZip.loadAsync(buf);
    const slide5 = await zip.file('ppt/slides/slide5.xml')!.async('string');
    expect(slide5).toContain('Linked image');
    expect(slide5).toContain('example.com/external.png');
    // No media parts were embedded for the external URL.
    expect(Object.keys(zip.files).filter((f) => f.startsWith('ppt/media/') && !zip.files[f]!.dir)).toEqual([]);
  });

  it('the theme palette reaches the slide background', async () => {
    const buf = await renderDeckToPptx({ ...deck, theme: 'vibrant' });
    const zip = await JSZip.loadAsync(buf);
    const slide1 = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(slide1).toContain('0F0A2E'); // the vibrant theme's background
  });
});

describe('pdf export — structural assertions', () => {
  it('produces a real PDF with one page per slide', async () => {
    const buf = await renderDeckToPdf(deck);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    const pageCount = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pageCount).toBe(6);
  });
});

describe('the shared geometry/theme module (the anti-drift source)', () => {
  it('the theme SET matches the artifact schema enum exactly (both directions)', () => {
    const schema = slidesSchema() as { properties: { theme: { enum: string[] } } };
    expect(Object.keys(SLIDE_THEMES).sort()).toEqual([...schema.properties.theme.enum].sort());
  });

  it('every schema layout has a geometry entry', () => {
    const schema = slidesSchema() as { properties: { slides: { items: { properties: { layout: { enum: string[] } } } } } };
    for (const l of schema.properties.slides.items.properties.layout.enum) {
      expect(SLIDE_GEOMETRY[l as keyof typeof SLIDE_GEOMETRY], l).toBeTruthy();
    }
  });

  it('assetTokenFromUrl embeds ONLY host asset-serve URLs', () => {
    expect(assetTokenFromUrl('/v1/host/openwop-app/assets/abc123XYZ_-')).toBe('abc123XYZ_-');
    expect(assetTokenFromUrl('https://app.openwop.dev/v1/host/openwop-app/assets/tok_abc12345?x=1')).toBe('tok_abc12345');
    expect(assetTokenFromUrl('https://evil.example/steal.png')).toBeNull();
    expect(assetTokenFromUrl('http://169.254.169.254/latest/meta-data')).toBeNull();
    expect(assetTokenFromUrl('/v1/host/openwop-app/assets/../../etc/passwd')).toBeNull();
  });
});

// ── ADR 0328 Phase 2 — brand theme + the per-slide background accent. ──
describe('phase 2 — brand palette + background accent', () => {
  it('brandPalette overlays ONLY hex-valid channels onto the default palette', async () => {
    const { brandPalette } = await import('../export/slideGeometry.js');
    const p = brandPalette({ accent: '#AB12CD', paper: 'oklch(0.9 0.1 200)', ink: '#000000' });
    expect(p.accent).toBe('AB12CD');
    expect(p.ink).toBe('000000');
    expect(p.bg).toBe('FFFFFF'); // non-hex paper falls back to the default bg
  });

  it('an accent-background slide swaps bg/ink in the pptx', async () => {
    const buf = await renderDeckToPptx({
      title: 'D', theme: 'default',
      slides: [{ layout: 'section', title: 'Big statement', background: 'accent' }],
    });
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain('2563EB'); // the default accent, as the slide bg
  });
});

// ── ADR 0328 Phase 3 — blocks slides export as a stacked text flow. ────────
describe('phase 3 — blocks slides in both exporters', () => {
  const blocksDeck = {
    title: 'Blocks',
    theme: 'default',
    slides: [{
      layout: 'blocks',
      variant: 'full',
      notes: 'Blocks speaker notes.',
      blocks: [
        { type: 'heading', props: { text: 'Quarterly numbers', level: '1' } },
        { type: 'bullets', props: { items: ['Revenue up 12%', 'Two launches'] } },
        { type: 'statCard', props: { label: 'NRR', value: '118%', delta: '+6pts' } },
        { type: 'chart', props: { spec: JSON.stringify({ title: 'ARR by region', chartType: 'bar' }) } },
        { type: 'image', props: { src: 'https://example.com/x.png' } },
      ],
    }],
  };

  it('pptx renders block text, bullets, the statCard, the honest chart placeholder, and notes', async () => {
    const buf = await renderDeckToPptx(blocksDeck);
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain('Quarterly numbers');
    expect(xml).toContain('Revenue up 12%');
    expect(xml).toContain('118%');
    expect(xml).toContain('ARR by region — see the live deck');
    // External image stays a linked placeholder (SSRF posture holds for blocks too).
    expect(xml).toContain('Linked image');
    expect(Object.keys(zip.files).filter((f) => f.startsWith('ppt/media/') && !zip.files[f]!.dir)).toEqual([]);
    const notesFiles = Object.keys(zip.files).filter((f) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(f));
    expect(notesFiles.length).toBe(1);
    expect(await zip.file(notesFiles[0]!)!.async('string')).toContain('Blocks speaker notes.');
  });

  it('pdf renders a blocks slide as exactly one page', async () => {
    const buf = await renderDeckToPdf(blocksDeck);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    const pageCount = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pageCount).toBe(1);
  });
});

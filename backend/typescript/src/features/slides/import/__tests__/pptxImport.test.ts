/**
 * Grade pass 2026-07-10 — the pptx import's hostile-input posture: zip-bomb
 * caps (per-entry + whole-file budget), linear scanning on unbalanced XML,
 * entity decoding, and the non-pptx rejection.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parsePptx } from '../pptxImport.js';

async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

const slideXml = (title: string, paras: string[]): string =>
  `<p:sld><p:sp><p:ph type="title"/><a:p><a:t>${title}</a:t></a:p></p:sp>` +
  paras.map((p) => `<a:p><a:t>${p}</a:t></a:p>`).join('') + '</p:sld>';

describe('parsePptx — hostile inputs', () => {
  it('rejects a zip whose slide part inflates past the per-entry cap (decompression bomb)', async () => {
    // 8 MB of a repeated byte compresses to a few KB — inert under the cap.
    const bomb = 'A'.repeat(8 * 1024 * 1024);
    const buf = await zipOf({ 'ppt/slides/slide1.xml': bomb });
    await expect(parsePptx(buf)).rejects.toThrow(/too large/);
  });

  it('survives unbalanced adversarial XML in linear time (no lazy-regex blowup)', async () => {
    // 200k unclosed openers — the old [\s\S]*? scan went quadratic here.
    const evil = '<a:p'.repeat(200_000);
    const buf = await zipOf({ 'ppt/slides/slide1.xml': `<p:sld>${evil}</p:sld>` });
    const started = performance.now();
    const out = await parsePptx(buf);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(out.slides[0]?.layout).toBe('title'); // no text extracted, honest fallback
  });

  it('rejects a non-pptx zip and decodes XML entities in real content', async () => {
    await expect(parsePptx(await zipOf({ 'readme.txt': 'hi' }))).rejects.toThrow(/no slides/);
    const buf = await zipOf({
      'ppt/slides/slide1.xml': slideXml('Q3 &amp; Q4 &#8212; plan', ['Revenue &gt; costs']),
      'ppt/notesSlides/notesSlide1.xml': '<p:notes><a:p><a:t>Say &quot;hello&quot;</a:t></a:p></p:notes>',
    });
    const { slides } = await parsePptx(buf);
    expect(slides[0]?.title).toBe('Q3 & Q4 — plan');
    expect(slides[0]?.bullets).toEqual(['Revenue > costs']);
    expect(slides[0]?.notes).toBe('Say "hello"');
  });
});

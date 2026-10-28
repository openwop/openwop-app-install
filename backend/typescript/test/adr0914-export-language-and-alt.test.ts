/**
 * ADR 0914 (Book AI P3 + P10) — the Markdown EPUB/DOCX writers carry the
 * content language (and direction), and DOCX images carry alt text.
 *
 * Tracker TST-BJT. Red when (probe-witnessed, w65): a malformed tag is accepted as
 * the language; the EPUB or the DOCX image ignores the resolver's description (or
 * `decorative`); the rtl spine loses `page-progression-direction`.
 */
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { renderMarkdownToEpub, renderMarkdownToDocx, type ResolvedExportImage } from '../src/features/documents/render.js';

// 1×1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const img = (altText?: ResolvedExportImage['altText']) => async (): Promise<ResolvedExportImage> => ({ data: PNG, kind: 'png', width: 1, height: 1, ...(altText ? { altText } : {}) });

async function epubFiles(buf: Buffer): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(buf);
  const out: Record<string, string> = {};
  for (const name of Object.keys(zip.files)) if (/\.(opf|xhtml)$/.test(name)) out[name] = await zip.file(name)!.async('string');
  return out;
}
async function docxPart(buf: Buffer, part: string): Promise<string> {
  return (await JSZip.loadAsync(buf)).file(part)!.async('string');
}

describe('ADR 0914 P10 — EPUB content language', () => {
  it('a named language reaches dc:language, the package and every XHTML root', async () => {
    const f = await epubFiles(await renderMarkdownToEpub('# Un\n\nBonjour.\n\n# Deux\n\nAu revoir.', { title: 'Livre', language: 'fr-CA' }));
    expect(f['EPUB/content.opf']).toContain('<dc:language>fr-CA</dc:language>');
    expect(f['EPUB/content.opf']).toMatch(/<package [^>]*xml:lang="fr-CA"/);
    const roots = Object.entries(f).filter(([n]) => n.endsWith('.xhtml'));
    expect(roots.length).toBeGreaterThanOrEqual(2);
    for (const [n, x] of roots) expect(x, n).toMatch(/<html [^>]*xml:lang="fr-CA" lang="fr-CA"/);
  });

  it('rtl sets dir and the spine page progression', async () => {
    const f = await epubFiles(await renderMarkdownToEpub('# א\n\nשלום', { language: 'he', direction: 'rtl' }));
    expect(f['EPUB/content.opf']).toContain('page-progression-direction="rtl"');
    expect(f['EPUB/chapter1.xhtml']).toContain('dir="rtl"');
  });

  it('no language (or a malformed one) keeps the old output: en, no lang on roots', async () => {
    for (const language of [undefined, 'not a tag!']) {
      const f = await epubFiles(await renderMarkdownToEpub('# A\n\nText', { ...(language ? { language } : {}) }));
      expect(f['EPUB/content.opf']).toContain('<dc:language>en</dc:language>');
      expect(f['EPUB/chapter1.xhtml']).not.toContain('xml:lang');
    }
  });

  it('a resolver-supplied description replaces the markdown alt; decorative empties it', async () => {
    const described = await epubFiles(await renderMarkdownToEpub('# A\n\n![md alt](media://x)', { resolveImage: img({ description: 'A map of the valley' }) }));
    expect(described['EPUB/chapter1.xhtml']).toContain('alt="A map of the valley"');
    const decorative = await epubFiles(await renderMarkdownToEpub('# A\n\n![md alt](media://x)', { resolveImage: img({ decorative: true }) }));
    expect(decorative['EPUB/chapter1.xhtml']).toContain('alt=""');
  });
});

describe('ADR 0914 P10 + P3 — DOCX language and image alt text', () => {
  it('a named language becomes the default run language', async () => {
    const styles = await docxPart(await renderMarkdownToDocx('Bonjour', { language: 'fr-FR' }), 'word/styles.xml');
    expect(styles).toMatch(/<w:lang [^>]*w:val="fr-FR"/);
  });

  it('no language: no w:lang written (unchanged)', async () => {
    const styles = await docxPart(await renderMarkdownToDocx('Hello'), 'word/styles.xml');
    expect(styles).not.toContain('<w:lang');
  });

  it('an image carries the markdown alt as its description, or the resolver\'s', async () => {
    const plain = await docxPart(await renderMarkdownToDocx('![Lighthouse at dusk](media://x)', { resolveImage: img() }), 'word/document.xml');
    expect(plain).toMatch(/<wp:docPr [^>]*descr="Lighthouse at dusk"/);
    const given = await docxPart(await renderMarkdownToDocx('![x](media://x)', { resolveImage: img({ description: 'A red lighthouse' }) }), 'word/document.xml');
    expect(given).toMatch(/descr="A red lighthouse"/);
  });
});

/**
 * ADR 0904 D6 / P2 — PDF text PER PAGE, so a chunk knows its page.
 *
 * The ingest extracted with `mergePages: true` (one flat string), so every KB chunk
 * reported `pageNumber: null` — a citation could name the document but never the page.
 * This extracts page by page, joins the pages with a blank line, and returns the char
 * offset where each page starts; the chunker chunks page by page, so every chunk sits on
 * exactly one page.
 *
 * SECURITY (H61): the pdf.js proxy MUST come from `kbService.loadUnpdf()` — the seam that
 * hands unpdf the patched `pdfjs-dist` — and `isEvalSupported` stays false. The caller
 * passes it in, so this file cannot import `unpdf` on its own (`kb-vendored-pdfjs.test.ts`).
 */

type Unpdf = Pick<typeof import('unpdf'), 'extractText' | 'getDocumentProxy'>;

export interface PdfPagesText { text: string; pageOffsets: number[] }

/** Join per-page texts; `pageOffsets[i]` is where page i+1 starts in `text`. Empty pages
 *  keep their slot (an offset equal to the next page's) so numbering stays true. Pure. */
export function joinPdfPages(pages: readonly string[]): PdfPagesText {
  let text = '';
  const pageOffsets: number[] = [];
  for (const raw of pages) {
    const page = raw.replace(/\r\n?/g, '\n').trim();
    if (text.length > 0 && page.length > 0) text += '\n\n';
    pageOffsets.push(text.length);
    text += page;
  }
  return { text, pageOffsets };
}

export async function extractPdfPages(unpdf: Unpdf, buffer: Buffer): Promise<PdfPagesText> {
  const pdf = await unpdf.getDocumentProxy(new Uint8Array(buffer), { isEvalSupported: false });
  const { text } = await unpdf.extractText(pdf, { mergePages: false });
  return joinPdfPages(Array.isArray(text) ? text : [text]);
}

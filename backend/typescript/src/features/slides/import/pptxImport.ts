/**
 * PPTX → deck import (ADR 0328 Phase 7 / research S9) — TEXT-FIDELITY import:
 * slide titles, body paragraphs (as bullets), and speaker notes. Images,
 * charts, tables, and layout geometry are NOT imported (recorded honestly —
 * a placeholder-free deck the user restructures beats a mangled lookalike).
 *
 * A .pptx is a zip of XML parts; we read `ppt/slides/slideN.xml` (ordered by
 * N) + the matching `ppt/notesSlides/notesSlideN.xml`.
 *
 * Hostile-input posture (grade pass 2026-07-10): the route caps the COMPRESSED
 * input, so this module owns the decompression side — a per-entry uncompressed
 * cap + a whole-file budget (zip bombs), and LINEAR indexOf-based tag scanning
 * instead of lazy `[\s\S]*?` regexes (whose failed scans go quadratic on
 * unbalanced adversarial XML). No XML-parser dependency, no external fetches.
 */
import JSZip from 'jszip';

export interface ImportedSlide {
  id: string;
  name: string;
  layout: 'title' | 'title-bullets' | 'section';
  title?: string;
  bullets?: string[];
  notes?: string;
}

/** Per-entry uncompressed cap. A real slide XML part is tens of KB; 5 MB is
 *  generous headroom while making 1000:1 bombs inert. */
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;
/** Whole-import decompressed budget across all read entries. */
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;

/** JSZip keeps the central-directory size on the (unexposed) `_data` — read it
 *  structurally so an oversized entry is rejected BEFORE decompression. */
type ZipEntrySize = { _data?: { uncompressedSize?: number } };
function uncompressedSizeOf(entry: JSZip.JSZipObject): number | null {
  const n = (entry as JSZip.JSZipObject & ZipEntrySize)._data?.uncompressedSize;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
/** Test-only (SL-6) — the structural `_data.uncompressedSize` read is a
 *  private-jszip dependency: if a jszip upgrade drops the field, the guard
 *  silently degrades to post-decompress checks (bombs get decompressed before
 *  rejection). The tripwire test asserts the field still exists so the bump
 *  fails LOUD instead. */
export const __uncompressedSizeOfForTests = uncompressedSizeOf;

const decodeEntities = (s: string): string => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, '&');

/** LINEAR scan for `<open …>…</close>` scopes: one indexOf pass, never
 *  re-visits input (the regex version was O(n²) on unbalanced tags). An
 *  unclosed opener ends the scan. */
function scanScopes(xml: string, open: string, close: string, cap = 2000): string[] {
  const out: string[] = [];
  let from = 0;
  while (out.length < cap) {
    const start = xml.indexOf(open, from);
    if (start === -1) break;
    const end = xml.indexOf(close, start + open.length);
    if (end === -1) break;
    out.push(xml.slice(start, end + close.length));
    from = end + close.length;
  }
  return out;
}

/** All paragraph texts of one XML scope, in document order. */
function paragraphTexts(xml: string): string[] {
  const out: string[] = [];
  for (const p of scanScopes(xml, '<a:p', '</a:p>')) {
    const runs = scanScopes(p, '<a:t>', '</a:t>')
      .map((r) => decodeEntities(r.slice('<a:t>'.length, -'</a:t>'.length)));
    const text = runs.join('').trim();
    if (text) out.push(text.slice(0, 400));
  }
  return out;
}

/** The title placeholder's text, when the slide declares one. */
function titleOf(xml: string): string | null {
  // A title shape: <p:sp> whose <p:ph type="title"|"ctrTitle"> — its first paragraph.
  for (const sp of scanScopes(xml, '<p:sp', '</p:sp>')) {
    if (sp.includes('type="title"') || sp.includes('type="ctrTitle"')) {
      const t = paragraphTexts(sp)[0];
      if (t) return t.slice(0, 240);
    }
  }
  return null;
}

/** Parse a .pptx buffer into editor-shaped slides. Throws on a non-pptx zip,
 *  an over-budget file, or an oversized part. */
/** SL-G8 — a skip reason as DATA: the client localizes it (×4 locales); the
 *  legacy `skipped` strings are DERIVED from these (skipText below), so the two
 *  fields cannot drift. */
export type ImportSkip =
  | { code: 'rich-content'; slide: number }
  | { code: 'truncated'; total: number };

/** The single English rendering — the legacy `skipped` wire field and any
 *  logging both come through here. */
export function skipText(sk: ImportSkip): string {
  return sk.code === 'rich-content'
    ? `slide ${sk.slide}: images/charts/tables are not imported (text only)`
    : `deck truncated to 100 slides (had ${sk.total})`;
}

export async function parsePptx(buf: Buffer): Promise<{ slides: ImportedSlide[]; skipped: string[]; skippedCoded: ImportSkip[] }> {
  const zip = await JSZip.loadAsync(buf);
  const slideFiles = Object.keys(zip.files)
    .map((f) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(f))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  if (slideFiles.length === 0) throw new Error('no slides found — is this a .pptx file?');

  let budget = MAX_TOTAL_BYTES;
  const readEntry = async (name: string): Promise<string | null> => {
    const entry = zip.file(name);
    if (!entry) return null;
    const size = uncompressedSizeOf(entry);
    if (size !== null && size > MAX_ENTRY_BYTES) throw new Error(`part ${name} is too large to import`);
    const text = await entry.async('string');
    // Defense in depth for zips whose directory lies about the size.
    if (text.length > MAX_ENTRY_BYTES) throw new Error(`part ${name} is too large to import`);
    budget -= text.length;
    if (budget < 0) throw new Error('file expands past the import budget');
    return text;
  };

  const skippedCoded: ImportSkip[] = [];
  const slides: ImportedSlide[] = [];
  for (const m of slideFiles.slice(0, 100)) {
    const n = Number(m[1]);
    const xml = await readEntry(m[0]);
    if (xml === null) continue;
    if (xml.includes('<p:graphicFrame') || xml.includes('<pic:pic') || xml.includes('<p:pic')) {
      skippedCoded.push({ code: 'rich-content', slide: n });
    }
    const title = titleOf(xml);
    const all = paragraphTexts(xml);
    const body = title ? all.filter((t) => t !== title) : all.slice(1);
    const effectiveTitle = title ?? all[0];
    const bullets = body.slice(0, 12);
    const slide: ImportedSlide = {
      id: `slide-${slides.length + 1}`,
      name: (effectiveTitle ?? `Slide ${n}`).slice(0, 80),
      layout: bullets.length ? 'title-bullets' : (effectiveTitle ? 'section' : 'title'),
      ...(effectiveTitle ? { title: effectiveTitle.slice(0, 240) } : {}),
      ...(bullets.length ? { bullets } : {}),
    };
    const notesXml = await readEntry(`ppt/notesSlides/notesSlide${n}.xml`);
    if (notesXml) {
      // Drop the slide-number placeholder runs; keep spoken paragraphs.
      const notes = paragraphTexts(notesXml).filter((t) => !/^\d+$/.test(t)).join('\n').slice(0, 4000);
      if (notes) slide.notes = notes;
    }
    slides.push(slide);
  }
  if (slideFiles.length > 100) skippedCoded.push({ code: 'truncated', total: slideFiles.length });
  // Legacy strings DERIVED from the coded list — older clients keep their wire.
  return { slides, skipped: skippedCoded.map(skipText), skippedCoded };
}

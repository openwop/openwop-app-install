/**
 * ADR 0904 D6 / P2 — DOCX → structure-preserving markdown.
 *
 * `mammoth.extractRawText` threw the document's structure away: no headings (so the
 * structural chunker gave every DOCX chunk an empty `headingPath`), tables flattened into
 * run-on cell text, lists indistinguishable from prose. `convertToHtml` keeps them, and
 * this file turns mammoth's HTML into the markdown the chunker already understands:
 * `#` headings, `|` tables (kept whole by the chunker), `-`/`1.` lists.
 *
 * The converter handles mammoth's output vocabulary only (`h1–h6 p ul ol li table tr td
 * th strong em a br img sup sub s`), which is small, closed and escaped — so a strict
 * tokenizer suffices and no HTML-parser dependency is added. Unknown tags contribute
 * their text. Images are dropped at the source (mammoth would inline them as data URIs,
 * megabytes each) and here. Only http(s) links keep their target.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decode(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const TOKEN = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g;

interface ListFrame { ordered: boolean; n: number }

/** Convert mammoth's HTML to markdown. Pure + deterministic. */
export function mammothHtmlToMarkdown(html: string): string {
  const blocks: string[] = [];
  let line = '';
  let indent = ''; // a nested list item's leading indent (kept; prose is never indented)
  const lists: ListFrame[] = [];
  let table: string[][] | null = null;
  let row: string[] | null = null;
  let cell: string | null = null;
  let href: string | null = null;
  let linkText = '';

  const write = (text: string): void => {
    if (href !== null) { linkText += text; return; }
    if (cell !== null) { cell += text; return; }
    line += text;
  };
  const endBlock = (): void => {
    const t = line.replace(/[ \t]+/g, ' ').trim();
    if (t) blocks.push(indent + t);
    line = '';
    indent = '';
  };

  for (const m of html.matchAll(TOKEN)) {
    const [, close, rawTag, attrs, text] = m;
    if (text !== undefined) { write(decode(text)); continue; }
    const tag = rawTag!.toLowerCase();
    const closing = close === '/';
    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        if (closing) { const t = line.replace(/\s+/g, ' ').trim(); line = ''; if (t) blocks.push(`${'#'.repeat(Number(tag[1]))} ${t}`); }
        else endBlock();
        break;
      case 'p':
        if (cell !== null) { if (closing) cell += ' '; break; } // paragraphs inside a cell join with a space
        if (lists.length > 0) break; // a paragraph inside a list item continues the item
        endBlock();
        break;
      case 'ul': case 'ol':
        if (closing) { lists.pop(); if (lists.length === 0) endBlock(); }
        else { endBlock(); lists.push({ ordered: tag === 'ol', n: 0 }); }
        break;
      case 'li':
        if (closing) { endBlock(); break; }
        endBlock();
        {
          const frame = lists[lists.length - 1] ?? { ordered: false, n: 0 };
          frame.n += 1;
          indent = '  '.repeat(Math.max(0, lists.length - 1));
          line = `${frame.ordered ? `${frame.n}.` : '-'} `;
        }
        break;
      case 'table':
        if (closing) {
          if (table && table.length > 0) {
            const width = Math.max(...table.map((r) => r.length));
            const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
            const fmt = (r: string[]) => `| ${pad(r).join(' | ')} |`;
            const out = [fmt(table[0]!), `|${' --- |'.repeat(width)}`, ...table.slice(1).map(fmt)];
            blocks.push(out.join('\n'));
          }
          table = null;
        } else { endBlock(); table = []; }
        break;
      case 'tr':
        if (closing) { if (table && row) table.push(row); row = null; } else row = [];
        break;
      case 'td': case 'th':
        if (closing) { if (row && cell !== null) row.push(cell.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()); cell = null; }
        else cell = '';
        break;
      case 'strong': case 'b':
        write('**');
        break;
      case 'em': case 'i':
        write('_');
        break;
      case 'a':
        if (closing) {
          if (href !== null) { const target = href; href = null; write(target ? `[${linkText}](${target})` : linkText); }
        } else {
          const h = /\bhref="([^"]*)"/i.exec(attrs ?? '')?.[1];
          const decoded = h ? decode(h) : '';
          href = /^https?:\/\//i.test(decoded) ? decoded : '';
          linkText = '';
        }
        break;
      case 'br':
        if (cell !== null) cell += ' '; else if (href === null) { endBlock(); }
        break;
      case 'img':
        break; // images carry no indexable text
      default:
        break; // sup/sub/s/span…: their text flows through
    }
  }
  endBlock();
  // `**` / `_` markers left empty by an empty run are noise.
  return blocks.map((b) => b.replace(/\*\*\s*\*\*/g, '').replace(/(^|\s)_\s*_(?=\s|$)/g, '$1')).filter(Boolean).join('\n\n');
}

/** Extract a DOCX as structure-preserving markdown via mammoth (lazy-imported). Images
 *  are dropped at conversion so no data URI is ever built. */
export async function extractDocxMarkdown(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.convertToHtml({ buffer }, { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) });
  return mammothHtmlToMarkdown(value);
}

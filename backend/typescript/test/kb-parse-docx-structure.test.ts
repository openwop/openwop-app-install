/**
 * ADR 0904 P2 — DOCX keeps its structure. `mammoth.extractRawText` flattened headings,
 * tables and lists, so every DOCX chunk had an empty `headingPath` and a table became
 * run-on cell text. Now `convertToHtml` → markdown the chunker understands.
 *
 * Pinned (sabotage-witnessed): headings become `#` lines and drive `headingPath`; a table
 * becomes a markdown table; lists keep their markers; images never reach the text (a
 * data URI would be megabytes); only http(s) links keep a target; entities decode.
 * Sabotage: go back to `extractRawText` ⇒ the end-to-end case is red.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';
import { mammothHtmlToMarkdown, extractDocxMarkdown } from '../src/features/kb/parsers/docx.js';
import { createCollection, ingestDocument, getDocument, searchDetailed } from '../src/features/kb/kbService.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbdocx-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

const cell = (t: string) => new TableCell({ children: [new Paragraph(t)] });

async function makeDocx(): Promise<Buffer> {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: 'Expense Policy', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ children: [new TextRun('Applies to every employee & contractor.')] }),
        new Paragraph({ text: 'Meal limits', heading: HeadingLevel.HEADING_2 }),
        new Table({ rows: [new TableRow({ children: [cell('City'), cell('Daily limit')] }), new TableRow({ children: [cell('Lisbon'), cell('EUR 45')] }), new TableRow({ children: [cell('Austin'), cell('USD 60')] })] }),
        new Paragraph({ text: 'Receipts', heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ text: 'Keep the original receipt', bullet: { level: 0 } }),
        new Paragraph({ text: 'Submit within 30 days', bullet: { level: 0 } }),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}

describe('mammothHtmlToMarkdown', () => {
  it('maps headings, tables, lists, emphasis and links', () => {
    const md = mammothHtmlToMarkdown(
      '<h1>Title</h1><p>Hello <strong>bold</strong> &amp; <em>it</em> — <a href="https://x.test/a?b=1&amp;c=2">link</a> and <a href="javascript:alert(1)">bad</a>.</p>'
      + '<table><tr><td><p>A</p></td><td><p>B|C</p></td></tr><tr><td>1</td><td>2</td></tr></table>'
      + '<ol><li>one</li><li>two<ul><li>nested</li></ul></li></ol><p><img src="data:image/png;base64,AAAA" /></p>',
    );
    expect(md).toBe([
      '# Title',
      'Hello **bold** & _it_ — [link](https://x.test/a?b=1&c=2) and bad.',
      '| A | B\\|C |\n| --- | --- |\n| 1 | 2 |',
      '1. one',
      '2. two',
      '  - nested',
    ].join('\n\n'));
    expect(md).not.toMatch(/data:image|javascript:/);
  });

  it('decodes numeric entities', () => {
    expect(mammothHtmlToMarkdown('<p>caf&#233; &#x2014; &quot;x&quot;</p>')).toBe('café — "x"');
  });
});

describe('DOCX ingest keeps structure (end to end)', () => {
  it('headings drive headingPath, the table survives as a table, the list keeps markers', async () => {
    const buf = await makeDocx();
    const md = await extractDocxMarkdown(buf);
    expect(md).toMatch(/^# Expense Policy$/m);
    expect(md).toMatch(/^## Meal limits$/m);
    expect(md).toContain('| City | Daily limit |\n| --- | --- |\n| Lisbon | EUR 45 |\n| Austin | USD 60 |');
    expect(md).toMatch(/^- Keep the original receipt$/m);

    const col = await createCollection('t-docx', 'o', 'u', { name: 'docs' });
    const d = await ingestDocument('t-docx', 'o', 'u', col.collectionId, {
      title: 'policy.docx',
      contentBase64: buf.toString('base64'),
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect((await getDocument('t-docx', 'o', col.collectionId, d.documentId))?.text).toContain('| Lisbon | EUR 45 |');
    const hit = (await searchDetailed('t-docx', 'o', col.collectionId, 'Lisbon daily limit', 3, 'hybrid')).hits[0]!;
    expect(hit.headingPath).toEqual(['Expense Policy', 'Meal limits']);
    expect(hit.text).toContain('| Lisbon | EUR 45 |');
  });
});

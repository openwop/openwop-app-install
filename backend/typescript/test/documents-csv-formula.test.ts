/**
 * DOCT-2 — CSV formula-injection neutralization (CWE-1236).
 *
 * The `sheet` export's own comment says the file "opens directly in
 * Excel/Sheets", and document content can be model-authored (all six documents
 * agent tools declare `contentTrust:'untrusted'`), so a cell that survives
 * verbatim with a leading `=` / `+` / `-` / `@` / tab is a formula the
 * operator's spreadsheet will execute. Two arms:
 *   1. formula triggers are neutralized (leading `'` — the spreadsheet
 *      text-literal marker);
 *   2. ordinary signed numbers are NOT mangled — `-42` must stay `-42`.
 *
 * Pure unit test — `renderMarkdownToCsv` takes markdown and returns bytes; no
 * app boot needed.
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdownToCsv } from '../src/features/documents/render.js';

const csv = (md: string): string => renderMarkdownToCsv(md).toString('utf8');
const tableOf = (...cells: string[]): string =>
  `| ${cells.join(' | ')} |\n| ${cells.map(() => '---').join(' | ')} |\n| ${cells.join(' | ')} |`;

describe('DOCT-2 — csvCell neutralizes formula triggers', () => {
  it('neutralizes leading = + - @ and tab (arm 1)', () => {
    const out = csv(tableOf('=1+2', '@SUM(A1)', '+cmd cat', '-2+3'));
    // Every dangerous cell must carry the text-literal apostrophe prefix.
    expect(out).toContain("'=1+2");
    expect(out).toContain("'@SUM(A1)");
    expect(out).toContain("'+cmd cat");
    expect(out).toContain("'-2+3");
    // And the raw trigger must not survive at a cell start anywhere.
    for (const line of out.split('\r\n')) {
      for (const cell of line.split(',')) {
        expect(/^[=@\t]/.test(cell), `cell '${cell}' still starts with a formula trigger`).toBe(false);
      }
    }
  });

  it('leaves ordinary signed numbers unmangled (arm 2)', () => {
    const out = csv(tableOf('-42', '+3.5', '100', 'plain text'));
    expect(out).toContain('-42');
    expect(out).toContain('+3.5');
    expect(out).not.toContain("'-42");
    expect(out).not.toContain("'+3.5");
  });

  it('the fallback one-column lane is covered too — no table in the doc', () => {
    const out = csv('=HYPERLINK(evil)\nnormal line\n-7');
    expect(out.startsWith("'=HYPERLINK"), `fallback lane leaked: ${out.split('\r\n')[0]}`).toBe(true);
    expect(out).toContain('-7');
    expect(out).not.toContain("'-7");
  });

  it('neutralized cells still quote correctly when they contain commas', () => {
    const out = csv(tableOf('=1,2'));
    // Neutralize THEN quote: the apostrophe rides inside the quoted cell.
    expect(out).toContain('"\'=1,2"');
  });
});

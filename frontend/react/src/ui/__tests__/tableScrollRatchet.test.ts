/**
 * RATCHET — a horizontal table scroller renders through <TableScroll>, never as a
 * bare `<div className="table-scroll">`.
 *
 * A bare wrapper scrolls but is not keyboard-focusable, so a keyboard user cannot
 * reach the clipped columns (axe `scrollable-region-focusable`, serious). It hid
 * on main because the page grid let the table widen the page instead of the card
 * scrolling; when `.page-stack` stopped growing to its content (#5859) the
 * /capabilities a11y spec went red. <TableScroll> becomes a named, focusable
 * region while it overflows. Allowed: the component itself (in ui/DataTable.tsx), and comments.
 * The same holds for a `u-overflow-auto` / `u-overflow-x-auto` div around a `<table>`
 * (A11Y-TS-3), and every `<DataTable>` carries the caption that names its region.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(process.cwd(), 'src');
const OWNER = ['ui', 'DataTable.tsx'].join(sep);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__') walk(p, out); }
    else if (/\.(tsx|ts)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** `table-scroll` as a class in markup: a className string, template or expression. */
const BARE = /className=\{?[`"'][^`"']*\btable-scroll\b/;

function bareTableScrollSites(files: readonly { path: string; text: string }[]): string[] {
  return files.flatMap(({ path, text }) => text.split('\n').flatMap((line, i) =>
    BARE.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line) ? [`${path}:${i + 1}`] : []));
}

/** An overflow-utility `<div>` whose first child is a `<table>`: the same unfocusable scroller
 *  as a bare `.table-scroll`, spelled with a utility class (A11Y-TS-3). */
const UTILITY_SCROLLER = /<div className=\{?[`"'][^`"']*\bu-overflow(-x)?-auto\b[^`"']*[`"']\}?>\s*<table\b/g;

function utilityTableScrollers(files: readonly { path: string; text: string }[]): string[] {
  return files.flatMap(({ path, text }) => [...text.matchAll(UTILITY_SCROLLER)].map((m) => `${path}:${text.slice(0, m.index).split('\n').length}`));
}

/** Comments blanked to spaces, so line numbers hold and a commented `<DataTable>` is not a use. */
const blankComments = (text: string): string => text.replace(/\/\*[^]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, ' '));

/** A `<DataTable …>` opening tag (an optional `<T>` generic, then up to its first `>` outside braces and quotes) with no `caption=`. */
function uncaptionedDataTables(files: readonly { path: string; text: string }[]): string[] {
  return files.flatMap(({ path, text: raw }) => {
    const text = blankComments(raw);
    const out: string[] = [];
    for (const m of text.matchAll(/<DataTable\b(<[^>]*>)?/g)) {
      let depth = 0;
      let quote = '';
      let end = m.index + m[0].length;
      for (; end < text.length; end++) {
        const ch = text[end];
        // A `>` or brace inside a quoted value is text, not the end of the tag (TS-2).
        if (quote) { if (ch === quote && text[end - 1] !== '\\') quote = ''; }
        else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
        else if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === '>' && depth === 0) break;
      }
      if (!/\bcaption=/.test(text.slice(m.index, end))) out.push(`${path}:${text.slice(0, m.index).split('\n').length}`);
    }
    return out;
  });
}

describe('tableScrollRatchet', () => {
  it('no bare .table-scroll wrapper outside <TableScroll>', () => {
    const files = walk(SRC).filter((p) => relative(SRC, p) !== OWNER).map((p) => ({ path: relative(SRC, p), text: readFileSync(p, 'utf8') }));
    expect(bareTableScrollSites(files)).toEqual([]);
  });
  // A <DataTable> scrolls through <TableScroll>, which names its region from the
  // caption: an uncaptioned table that overflows is a focusable region with no name.
  it('every <DataTable> has a caption', () => {
    const files = walk(SRC).filter((p) => relative(SRC, p) !== OWNER).map((p) => ({ path: relative(SRC, p), text: readFileSync(p, 'utf8') }));
    expect(uncaptionedDataTables(files)).toEqual([]);
  });
  it('catches a planted uncaptioned DataTable', () => {
    expect(uncaptionedDataTables([
      { path: 'a.tsx', text: '<DataTable columns={c} rows={r} rowKey={(x) => x.id} />' },
      { path: 'b.tsx', text: "<DataTable\n  caption={t('x')}\n  columns={c} />" },
      { path: 'c.tsx', text: '// the shared <DataTable> register' },
      { path: 'd.tsx', text: '{/* the <DataTable>\n lane */}\n<DataTable<Row> rows={r} />' },
      { path: 'e.tsx', text: '<DataTable<Row>\n  caption={t(\'x\')}\n  rows={r} />' },
      { path: 'f.tsx', text: '<DataTable emptyLabel="a > b" caption={t(\'x\')} rows={r} />' },
      { path: 'g.tsx', text: '<DataTable rowKey={(x) => `${x.a}>${x.b}`} caption={c} />' },
    ])).toEqual(['a.tsx:1', 'd.tsx:3']);
  });
  it('no overflow-utility div wraps a <table> (use <TableScroll>)', () => {
    const files = walk(SRC).filter((p) => relative(SRC, p) !== OWNER).map((p) => ({ path: relative(SRC, p), text: readFileSync(p, 'utf8') }));
    expect(utilityTableScrollers(files)).toEqual([]);
  });
  it('catches a planted utility scroller', () => {
    expect(utilityTableScrollers([
      { path: 'a.tsx', text: 'x\n<div className="u-overflow-x-auto">\n  <table className="data-table">' },
      { path: 'b.tsx', text: '<div className="card u-overflow-auto"><table>' },
      { path: 'c.tsx', text: '<div className="u-overflow-x-auto">\n  <pre>{json}</pre>' },
      { path: 'd.tsx', text: '<TableScroll label={c}>\n  <table>' },
    ])).toEqual(['a.tsx:2', 'b.tsx:1']);
  });
  it('catches a planted bare wrapper (the ratchet can fail)', () => {
    expect(bareTableScrollSites([
      { path: 'a.tsx', text: '<div className="table-scroll table--stack">' },
      { path: 'b.tsx', text: "<div className={`table-scroll${x ? ' y' : ''}`}>" },
      { path: 'c.tsx', text: '<TableScroll className="table--stack">' },
    ])).toEqual(['a.tsx:1', 'b.tsx:1']);
  });

  // CT-TS-1 (2026-11-13): a cell's `.sr-only` text is `position: absolute`. With a static
  // scroller its containing block was the card, outside the clip, and /capabilities was
  // 543 px wide at a 380 px viewport. The scroller must be the containing block.
  it('the scroller is the containing block of what it scrolls', () => {
    const css = readFileSync(join(SRC, 'styles', 'global.css'), 'utf8');
    const rule = css.match(/^\.table-scroll\s*\{([^}]*)\}/m)?.[1] ?? '';
    expect(rule).toMatch(/overflow-x:\s*auto/);
    expect(rule).toMatch(/position:\s*relative/);
  });
});

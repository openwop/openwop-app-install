/**
 * Backend pmToMarkdown twin tests (ADR 0334 4b) — the server-authoritative
 * serializer used by the export route. Mirrors the FE twin's coverage.
 */
import { describe, it, expect } from 'vitest';
import { pmToMarkdown, type PMNode } from '../pmToMarkdown.js';

const doc = (content: PMNode[]): PMNode => ({ type: 'doc', content });
const text = (t: string, marks?: { type: string; attrs?: Record<string, unknown> }[]): PMNode => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });

describe('pmToMarkdown (backend)', () => {
  it('serializes headings, marks, and blocks', () => {
    const out = pmToMarkdown(doc([
      { type: 'heading', attrs: { level: 1 }, content: [text('Title')] },
      { type: 'paragraph', content: [text('a'), text('b', [{ type: 'bold' }]), text('c', [{ type: 'italic' }])] },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [text('q')] }] },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('x=1')] },
      { type: 'horizontalRule' },
    ]));
    expect(out).toBe('# Title\n\na**b***c*\n\n> q\n\n```ts\nx=1\n```\n\n---\n');
  });

  it('serializes nested lists (2 levels)', () => {
    const li = (t: string, nested?: PMNode): PMNode => ({ type: 'listItem', content: [{ type: 'paragraph', content: [text(t)] }, ...(nested ? [nested] : [])] });
    const nested = { type: 'bulletList', content: [li('a1')] };
    expect(pmToMarkdown(doc([{ type: 'bulletList', content: [li('a', nested), li('b')] }]))).toBe('- a\n  - a1\n- b\n');
  });

  it('degrades a link mark + empty doc gracefully', () => {
    expect(pmToMarkdown(doc([{ type: 'paragraph', content: [text('x', [{ type: 'link', attrs: { href: 'https://y.z' } }])] }]))).toBe('[x](https://y.z)\n');
    expect(pmToMarkdown(doc([{ type: 'paragraph' }]))).toBe('\n');
  });

  it('serializes a math block', () => {
    expect(pmToMarkdown(doc([{ type: 'mathBlock', attrs: { latex: 'a+b' } }]))).toBe('$$a+b$$\n');
  });

  it('exports a pending deletion suggestion struck, insertion plain (6b-2)', () => {
    const p = { type: 'paragraph', content: [
      text('keep '), text('gone', [{ type: 'deletion' }]), text('added', [{ type: 'insertion' }]),
    ] };
    expect(pmToMarkdown(doc([p]))).toBe('keep ~~gone~~added\n');
  });

  it('serializes chart + embed blocks to fenced blocks (2b-3)', () => {
    expect(pmToMarkdown(doc([{ type: 'chartBlock', attrs: { spec: '{"chartType":"line"}' } }]))).toBe('```chart\n{"chartType":"line"}\n```\n');
    expect(pmToMarkdown(doc([{ type: 'embedBlock', attrs: { html: '<i>x</i>' } }]))).toBe('```html\n<i>x</i>\n```\n');
  });

  it('serializes a table (GFM) and an image', () => {
    const cell = (t: string): PMNode => ({ type: 'tableCell', content: [{ type: 'paragraph', content: [text(t)] }] });
    const hcell = (t: string): PMNode => ({ type: 'tableHeader', content: [{ type: 'paragraph', content: [text(t)] }] });
    const row = (cells: PMNode[]): PMNode => ({ type: 'tableRow', content: cells });
    const table = { type: 'table', content: [row([hcell('A'), hcell('B')]), row([cell('1'), cell('2')])] };
    expect(pmToMarkdown(doc([table]))).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n');
    expect(pmToMarkdown(doc([{ type: 'image', attrs: { src: '/assets/t', alt: 'L' } }]))).toBe('![L](/assets/t)\n');
  });
});

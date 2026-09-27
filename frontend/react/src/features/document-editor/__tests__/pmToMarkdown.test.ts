/**
 * pmToMarkdown tests (ADR 0334 Phase 4) — the ProseMirror-JSON → Markdown export
 * serializer over the Phase-1/2 schema.
 */
import { describe, it, expect } from 'vitest';
import { pmToMarkdown } from '../pmToMarkdown.js';
import type { JSONContent } from '@tiptap/core';

const doc = (content: JSONContent[]): JSONContent => ({ type: 'doc', content });
const text = (t: string, marks?: { type: string; attrs?: Record<string, unknown> }[]): JSONContent =>
  ({ type: 'text', text: t, ...(marks ? { marks } : {}) });

describe('pmToMarkdown', () => {
  it('serializes headings by level', () => {
    expect(pmToMarkdown(doc([{ type: 'heading', attrs: { level: 2 }, content: [text('Title')] }]))).toBe('## Title\n');
  });

  it('serializes inline marks (bold/italic/strike/code/link)', () => {
    const p = { type: 'paragraph', content: [
      text('a'), text('b', [{ type: 'bold' }]), text('c', [{ type: 'italic' }]),
      text('d', [{ type: 'strike' }]), text('e', [{ type: 'code' }]),
      text('f', [{ type: 'link', attrs: { href: 'https://x.com' } }]),
    ] };
    expect(pmToMarkdown(doc([p]))).toBe('a**b***c*~~d~~`e`[f](https://x.com)\n');
  });

  it('serializes bullet and ordered lists', () => {
    const bl = { type: 'bulletList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [text('one')] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [text('two')] }] },
    ] };
    expect(pmToMarkdown(doc([bl]))).toBe('- one\n- two\n');
    const ol = { type: 'orderedList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [text('a')] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [text('b')] }] },
    ] };
    expect(pmToMarkdown(doc([ol]))).toBe('1. a\n2. b\n');
  });

  it('serializes blockquote, code block, and horizontal rule', () => {
    expect(pmToMarkdown(doc([{ type: 'blockquote', content: [{ type: 'paragraph', content: [text('q')] }] }]))).toBe('> q\n');
    expect(pmToMarkdown(doc([{ type: 'codeBlock', attrs: { language: 'ts' }, content: [text('x=1')] }]))).toBe('```ts\nx=1\n```\n');
    expect(pmToMarkdown(doc([{ type: 'horizontalRule' }]))).toBe('---\n');
  });

  it('joins blocks with blank lines and trims', () => {
    const out = pmToMarkdown(doc([
      { type: 'heading', attrs: { level: 1 }, content: [text('H')] },
      { type: 'paragraph', content: [text('body')] },
    ]));
    expect(out).toBe('# H\n\nbody\n');
  });

  it('degrades an empty document to a trailing newline', () => {
    expect(pmToMarkdown(doc([{ type: 'paragraph' }]))).toBe('\n');
  });

  // EXP-1 — nested lists (the re-derivation branch): a listItem's leading
  // paragraph shares the marker line; nested lists indent by two spaces/level.
  const li = (t: string, nested?: JSONContent): JSONContent =>
    ({ type: 'listItem', content: [{ type: 'paragraph', content: [text(t)] }, ...(nested ? [nested] : [])] });

  it('serializes a 2-level nested bulleted list', () => {
    const nested = { type: 'bulletList', content: [li('a1'), li('a2')] };
    const out = pmToMarkdown(doc([{ type: 'bulletList', content: [li('a', nested), li('b')] }]));
    expect(out).toBe('- a\n  - a1\n  - a2\n- b\n');
  });

  it('serializes a 3-level mixed ordered/bulleted list', () => {
    const lvl3 = { type: 'bulletList', content: [li('deep')] };
    const lvl2 = { type: 'orderedList', content: [li('x', lvl3)] };
    const out = pmToMarkdown(doc([{ type: 'bulletList', content: [li('top', lvl2)] }]));
    expect(out).toBe('- top\n  1. x\n    - deep\n');
  });

  // 2b — tables + images.
  const cell = (t: string): JSONContent => ({ type: 'tableCell', content: [{ type: 'paragraph', content: [text(t)] }] });
  const hcell = (t: string): JSONContent => ({ type: 'tableHeader', content: [{ type: 'paragraph', content: [text(t)] }] });
  const row = (cells: JSONContent[]): JSONContent => ({ type: 'tableRow', content: cells });

  it('serializes a table to a GFM table', () => {
    const table = { type: 'table', content: [row([hcell('A'), hcell('B')]), row([cell('1'), cell('2')])] };
    expect(pmToMarkdown(doc([table]))).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n');
  });

  it('escapes pipes inside table cells', () => {
    const table = { type: 'table', content: [row([hcell('a|b')]), row([cell('c|d')])] };
    expect(pmToMarkdown(doc([table]))).toBe('| a\\|b |\n| --- |\n| c\\|d |\n');
  });

  it('serializes a math block to $$…$$', () => {
    expect(pmToMarkdown(doc([{ type: 'mathBlock', attrs: { latex: 'x^2 + y^2' } }]))).toBe('$$x^2 + y^2$$\n');
  });

  it('serializes an image node', () => {
    expect(pmToMarkdown(doc([{ type: 'image', attrs: { src: '/assets/tok', alt: 'Logo' }}]))).toBe('![Logo](/assets/tok)\n');
  });

  it('exports a pending deletion suggestion as struck text, insertion as plain (6b-2)', () => {
    const p = { type: 'paragraph', content: [
      text('keep '), text('gone', [{ type: 'deletion' }]), text('added', [{ type: 'insertion' }]),
    ] };
    expect(pmToMarkdown(doc([p]))).toBe('keep ~~gone~~added\n');
  });

  it('serializes a chart block to a fenced ```chart block (2b-3)', () => {
    const spec = '{"chartType":"bar"}';
    expect(pmToMarkdown(doc([{ type: 'chartBlock', attrs: { spec } }]))).toBe('```chart\n' + spec + '\n```\n');
  });

  it('serializes an embed block to a fenced ```html block (2b-3)', () => {
    expect(pmToMarkdown(doc([{ type: 'embedBlock', attrs: { html: '<b>hi</b>' } }]))).toBe('```html\n<b>hi</b>\n```\n');
  });
});

// ── Review-of-#1601 F1 — export fidelity: escaping, code+link, fences. ─────
describe('markdown fidelity (review F1)', () => {
  it('escapes markdown-significant characters in prose so literal text round-trips', () => {
    const md = pmToMarkdown({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: '2 * 3 * 4 is [not] _italic_ or `code`' }] },
    ] });
    expect(md.trim()).toBe('2 \\* 3 \\* 4 is \\[not\\] \\_italic\\_ or \\`code\\`');
  });

  it('keeps the link on a code-marked run ([`code`](href)) and pads/extends backtick spans', () => {
    const md = pmToMarkdown({ type: 'doc', content: [
      { type: 'paragraph', content: [
        { type: 'text', text: 'fetchData', marks: [{ type: 'code' }, { type: 'link', attrs: { href: 'https://api.example/docs' } }] },
      ] },
    ] });
    expect(md.trim()).toBe('[`fetchData`](https://api.example/docs)');
    const tricky = pmToMarkdown({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'a ` b', marks: [{ type: 'code' }] }] },
    ] });
    expect(tricky.trim()).toBe('``a ` b``');
  });

  it('code blocks stay verbatim behind a fence longer than any embedded backtick run', () => {
    const md = pmToMarkdown({ type: 'doc', content: [
      { type: 'codeBlock', attrs: { language: 'md' }, content: [{ type: 'text', text: 'use ```js\ncode\n``` fences' }] },
    ] });
    expect(md.startsWith('````md\n')).toBe(true);
    expect(md).toContain('use ```js');
    expect(md.trim().endsWith('````')).toBe(true);
  });

  it('escapes parentheses in link hrefs so the link target cannot be truncated', () => {
    const md = pmToMarkdown({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'wiki', marks: [{ type: 'link', attrs: { href: 'https://x.test/a(b)c' } }] }] },
    ] });
    expect(md.trim()).toBe('[wiki](https://x.test/a%28b%29c)');
  });
});

// ── Grade pass 2026-07-10 — block-leading escaping (round-trip fidelity). ──
describe('block-leading escaping (grade pass)', () => {
  it('a paragraph starting with list/heading/quote syntax does NOT re-parse as that block', () => {
    const md = pmToMarkdown({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: '1. First point about pricing' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '# Not a heading' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '> Not a quote' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '- Not a bullet' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '10) Also not a list' }] },
    ] });
    const lines = md.trim().split('\n\n');
    expect(lines[0]).toBe('1\\. First point about pricing');
    expect(lines[1]).toBe('\\# Not a heading');
    expect(lines[2]).toBe('\\> Not a quote');
    expect(lines[3]).toBe('\\- Not a bullet');
    expect(lines[4]).toBe('10\\) Also not a list');
  });

  it('a REAL heading/list block still emits its live syntax (escaping is paragraph-only)', () => {
    const md = pmToMarkdown({ type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Real heading' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'real item' }] }] }] },
    ] });
    expect(md).toContain('## Real heading');
    expect(md).toContain('- real item');
  });
});

/**
 * documentSchema tests (ADR 0334 2b-3, ADR 1055) — the closed extension set builds a
 * valid ProseMirror schema that includes the custom block nodes (math/chart/embed),
 * so the editable surface and the read-only renderer share one schema; and the
 * suggestion marks survive an HTML round-trip as suggestions (DE87UX-22).
 *
 * Sabotage (wave 14, re-probed wave 117): drop MathBlock / ChartBlock / the
 * comment mark's `inclusive:false` / the insertion+deletion marks from the closed
 * set → the named case goes red. Chart/embed atomicity is held twice: `atom: true`
 * AND being a content-less leaf (ProseMirror `isAtom = isLeaf || spec.atom`), so
 * flipping `atom` alone is an equivalent mutant (w14g4-schema-atom, vacuous). One
 * edit that replaces `atom: true` with `content: 'inline*'` breaks both halves and
 * reds the atom case. The round-trip case reds when the suggestion parse rules
 * lose their priority over StarterKit's Strike (`<del>` → strike), when
 * `<ins>`/`<del>` render as `<span>`, or when the author attr is not parsed back.
 */
import { describe, it, expect } from 'vitest';
import { getSchema, generateHTML, generateJSON } from '@tiptap/core';
import { documentExtensions } from '../documentSchema.js';

describe('documentExtensions', () => {
  it('builds a ProseMirror schema containing the custom block nodes', () => {
    const schema = getSchema(documentExtensions());
    expect(Object.keys(schema.nodes)).toEqual(expect.arrayContaining(['doc', 'mathBlock', 'chartBlock', 'embedBlock']));
  });

  it('registers the inline comment mark with a threadId attr (6b)', () => {
    const schema = getSchema(documentExtensions());
    expect(schema.marks.comment).toBeTruthy();
    const mark = schema.marks.comment!.create({ threadId: 'th-1' });
    expect(mark.attrs.threadId).toBe('th-1');
    expect(schema.marks.comment!.spec.inclusive).toBe(false);
  });

  it('registers the track-changes suggestion marks with an author attr (6b-2)', () => {
    const schema = getSchema(documentExtensions());
    expect(schema.marks.insertion).toBeTruthy();
    expect(schema.marks.deletion).toBeTruthy();
    expect(schema.marks.insertion!.create({ author: 'a' }).attrs.author).toBe('a');
    expect(schema.marks.deletion!.create({ author: 'b' }).attrs.author).toBe('b');
  });

  it('treats chart + embed as atom blocks with a string spec/html attr', () => {
    const schema = getSchema(documentExtensions());
    const chart = schema.nodes.chartBlock!.createAndFill({ spec: '{"chartType":"bar"}' });
    const embed = schema.nodes.embedBlock!.createAndFill({ html: '<b>x</b>' });
    expect(chart?.attrs.spec).toBe('{"chartType":"bar"}');
    expect(embed?.attrs.html).toBe('<b>x</b>');
    expect(schema.nodes.chartBlock!.isAtom).toBe(true);
    expect(schema.nodes.embedBlock!.isAtom).toBe(true);
  });

  // DE87UX-22 — suggestions render as native <ins>/<del>. StarterKit's Strike
  // also parses <del> and is registered first, so a copied-and-pasted deletion
  // came back as permanent strikethrough unless the suggestion rules outrank it.
  it('a suggested insertion and deletion survive an HTML round-trip as suggestions', () => {
    const exts = documentExtensions();
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'old', marks: [{ type: 'deletion', attrs: { author: 'ai' } }] },
      { type: 'text', text: 'new', marks: [{ type: 'insertion', attrs: { author: 'ai' } }] },
    ] }] };
    const html = generateHTML(doc, exts);
    // Native elements carrying the suggestion text (DE87UX-12), not just a tag
    // somewhere in the string.
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('del[data-deletion]')?.textContent).toBe('old');
    expect(host.querySelector('ins[data-insertion]')?.textContent).toBe('new');
    const back = generateJSON(html, exts) as { content: { content: { text: string; marks: { type: string; attrs?: { author?: string } }[] }[] }[] };
    const runs = back.content[0]!.content;
    expect(runs.map((r) => [r.text, r.marks.map((m) => m.type)])).toEqual([['old', ['deletion']], ['new', ['insertion']]]);
    expect(runs.map((r) => r.marks[0]!.attrs?.author)).toEqual(['ai', 'ai']);
  });
});


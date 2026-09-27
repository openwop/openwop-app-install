/**
 * documentSchema tests (ADR 0334 2b-3) — the closed extension set builds a valid
 * ProseMirror schema that includes the custom block nodes (math/chart/embed), so
 * the editable surface and the read-only renderer share one schema.
 */
import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { documentExtensions } from '../documentSchema.js';

describe('documentExtensions', () => {
  it('builds a ProseMirror schema containing the custom block nodes', () => {
    const schema = getSchema(documentExtensions());
    expect(schema.nodes.doc).toBeTruthy();
    expect(schema.nodes.mathBlock).toBeTruthy();
    expect(schema.nodes.chartBlock).toBeTruthy();
    expect(schema.nodes.embedBlock).toBeTruthy();
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
});

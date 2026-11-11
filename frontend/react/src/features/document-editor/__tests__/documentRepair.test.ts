// @vitest-environment jsdom
/**
 * ADR 1055 D2 — a stored document that holds something the editor cannot open
 * opens with its good content, never blank.
 *
 * RED on `13fb94b5d` (the editor took the stored JSON verbatim): each of the
 * three shapes below made `new Editor({ content })` return `getText() === ''`,
 * so "keep me" vanished from the editor and from the read-only renderer.
 */
import { describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import { documentExtensions } from '../documentSchema.js';
import { repairDocumentContent } from '../documentDoc.js';

const keep = { type: 'paragraph', content: [{ type: 'text', text: 'keep me' }] };
const SHAPES: Record<string, JSONContent> = {
  'an unknown node': { type: 'doc', content: [keep, { type: 'notARealNode', content: [{ type: 'text', text: 'gone' }] }] },
  'an empty text node': { type: 'doc', content: [keep, { type: 'paragraph', content: [{ type: 'text', text: '' }] }] },
  'an unknown mark': { type: 'doc', content: [keep, { type: 'paragraph', content: [{ type: 'text', text: 'styled', marks: [{ type: 'glitter' }, { type: 'bold' }] }] }] },
};

function openText(content: JSONContent): string {
  const ed = new Editor({ extensions: documentExtensions(), content });
  try { return ed.getText(); } finally { ed.destroy(); }
}

describe('repairDocumentContent (ADR 1055 D2)', () => {
  it.each(Object.entries(SHAPES))('a document with %s opens with its good content', (_label, content) => {
    const r = repairDocumentContent(content);
    expect(r.droppedCount).toBe(1);
    expect(openText(r.content)).toContain('keep me');
  });

  it('keeps the text a dropped mark sat on, with its valid marks', () => {
    const r = repairDocumentContent(SHAPES['an unknown mark']!);
    expect(r.dropped).toEqual({ glitter: 1 });
    expect(r.content.content?.[1]?.content?.[0]).toEqual({ type: 'text', text: 'styled', marks: [{ type: 'bold' }] });
  });

  it('drops a link mark whose href the editor refuses, keeping its text', () => {
    const r = repairDocumentContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] });
    expect(r.dropped).toEqual({ link: 1 });
    expect(r.content.content?.[0]?.content?.[0]).toEqual({ type: 'text', text: 'click' });
  });

  it('leaves a valid document exactly as it was (control)', () => {
    const valid: JSONContent = { type: 'doc', content: [keep, { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }] }] };
    const r = repairDocumentContent(valid);
    expect(r.droppedCount).toBe(0);
    expect(r.content).toEqual(valid);
    expect(openText(r.content)).toContain('keep me');
  });

  it('gives an empty editable document, not nothing, when nothing survives', () => {
    const r = repairDocumentContent({ type: 'doc', content: [{ type: 'notARealNode' }] });
    expect(r.content).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
  });

  // DE87CD-3/4 — nesting. A `doc` below the root has no DOM form and crashed the
  // view outright; text directly in the doc opened as an invalid document.
  it('drops a nested doc and keeps the rest openable', () => {
    const r = repairDocumentContent({ type: 'doc', content: [keep, { type: 'blockquote', content: [{ type: 'doc', content: [keep] }] }] });
    expect(r.dropped).toEqual({ doc: 1 });
    expect(openText(r.content)).toContain('keep me');
  });

  it('wraps text that sits directly in a block container, without calling it dropped', () => {
    const r = repairDocumentContent({ type: 'doc', content: [{ type: 'text', text: 'loose' }, keep] });
    expect(r.droppedCount).toBe(0);
    expect(r.content.content?.[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'loose' }] });
  });

  it('drops a block that sits inside a textblock', () => {
    const r = repairDocumentContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'keep me' }, { type: 'table' }] }] });
    expect(r.dropped).toEqual({ table: 1 });
    expect(openText(r.content)).toContain('keep me');
  });
});

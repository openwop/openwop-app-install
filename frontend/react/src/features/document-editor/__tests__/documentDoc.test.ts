/**
 * canvas.document doc-model tests (ADR 0334 Phase 1) — coercion (safe fallback to
 * an empty doc) and the `flow.headings` outline projection.
 */
import { describe, it, expect } from 'vitest';
import { coerceDocument, documentHeadings, documentA11yIssues, EMPTY_DOC } from '../documentDoc.js';

describe('coerceDocument', () => {
  it('keeps a valid { title, content } document', () => {
    const content = { type: 'doc', content: [{ type: 'paragraph' }] };
    expect(coerceDocument({ title: 'A', content })).toEqual({ title: 'A', content });
  });

  it('falls back to an empty doc when content is missing or malformed', () => {
    expect(coerceDocument({}).content).toEqual(EMPTY_DOC);
    expect(coerceDocument({ content: 'nope' }).content).toEqual(EMPTY_DOC);
    expect(coerceDocument({ content: { type: 'paragraph' } }).content).toEqual(EMPTY_DOC);
  });

  it('coerces a non-string title to empty', () => {
    expect(coerceDocument({ title: 42, content: { type: 'doc' } }).title).toBe('');
  });
});

describe('documentHeadings', () => {
  it('projects top-level heading nodes with text + level + stable id', () => {
    const doc = coerceDocument({ content: { type: 'doc', content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Intro' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Details' }] },
    ] } });
    expect(documentHeadings(doc)).toEqual([
      { id: 'heading-0', text: 'Intro', level: 1 },
      { id: 'heading-2', text: 'Details', level: 2 },
    ]);
  });

  it('defaults level to 1 and gives untitled headings a placeholder', () => {
    const doc = coerceDocument({ content: { type: 'doc', content: [{ type: 'heading', content: [] }] } });
    expect(documentHeadings(doc)).toEqual([{ id: 'heading-0', text: 'Heading 1', level: 1 }]);
  });

  it('returns no headings for a plain document', () => {
    expect(documentHeadings(coerceDocument({}))).toEqual([]);
  });
});

describe('documentA11yIssues', () => {
  const wrap = (blocks: unknown[]) => coerceDocument({ content: { type: 'doc', content: blocks } });

  it('flags an image missing alt text (and passes one with alt)', () => {
    expect(documentA11yIssues(wrap([{ type: 'image', attrs: { src: '/a', alt: '' } }]))).toHaveLength(1);
    expect(documentA11yIssues(wrap([{ type: 'image', attrs: { src: '/a', alt: 'Logo' } }]))).toEqual([]);
    expect(documentA11yIssues(wrap([{ type: 'image', attrs: { src: '/a' } }]))[0]!).toMatchObject({ kind: 'missing-alt', messageKey: 'missingAlt', wcag: '1.1.1' });
  });

  it('flags a skipped heading level (H1 → H3) with params, allows H1→H2', () => {
    const skip = documentA11yIssues(wrap([
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'A' }] },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'B' }] },
    ]));
    expect(skip).toHaveLength(1);
    expect(skip[0]).toMatchObject({ kind: 'heading-skip', messageKey: 'headingSkip', params: { from: 1, to: 3 } });
    expect(documentA11yIssues(wrap([
      { type: 'heading', attrs: { level: 1 }, content: [] },
      { type: 'heading', attrs: { level: 2 }, content: [] },
    ]))).toEqual([]);
  });

  it('returns no issues for a clean document', () => {
    expect(documentA11yIssues(coerceDocument({}))).toEqual([]);
  });
});

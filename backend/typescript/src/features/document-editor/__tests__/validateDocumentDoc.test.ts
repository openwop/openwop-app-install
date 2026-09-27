/**
 * canvas.document validation tests (ADR 0334 Phase 1) — the light structural +
 * DoS guard the backend applies to a rich-text PATCH before persisting it on
 * host.canvas. The FRONTEND engine owns the full schema; this guard just rejects
 * garbage and oversized/over-deep payloads (the ADR 0328 import-DoS lesson).
 */
import { describe, it, expect } from 'vitest';
import { validateDocumentDoc, MAX_NODES, MAX_DEPTH, MAX_TITLE, MAX_EMBED_HTML } from '../validateDocumentDoc.js';
import { blankDocumentState } from '../routes.js';

const doc = (content: unknown, title = 'T'): Record<string, unknown> => ({ title, content });

describe('validateDocumentDoc', () => {
  it('accepts a well-formed ProseMirror document', () => {
    const v = validateDocumentDoc(doc({ type: 'doc', content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Hi' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Body', marks: [{ type: 'bold' }] }] },
    ] }));
    expect(v.errors).toEqual([]);
  });

  it('accepts the blank document state', () => {
    expect(validateDocumentDoc(blankDocumentState('Untitled')).errors).toEqual([]);
  });

  it('rejects a missing/invalid content root', () => {
    expect(validateDocumentDoc(doc(undefined)).errors.length).toBeGreaterThan(0);
    expect(validateDocumentDoc(doc('nope')).errors.length).toBeGreaterThan(0);
    expect(validateDocumentDoc(doc([])).errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-"doc" root type', () => {
    const v = validateDocumentDoc(doc({ type: 'paragraph' }));
    expect(v.errors.some((e) => e.path === 'content.type')).toBe(true);
  });

  it('rejects a node without a string type', () => {
    const v = validateDocumentDoc(doc({ type: 'doc', content: [{ attrs: {} }] }));
    expect(v.errors.length).toBeGreaterThan(0);
  });

  it('rejects wrong-typed node fields (text/attrs/marks/content)', () => {
    expect(validateDocumentDoc(doc({ type: 'doc', content: [{ type: 'p', text: 5 }] })).errors.length).toBeGreaterThan(0);
    expect(validateDocumentDoc(doc({ type: 'doc', content: [{ type: 'p', marks: {} }] })).errors.length).toBeGreaterThan(0);
    expect(validateDocumentDoc(doc({ type: 'doc', content: [{ type: 'p', content: {} }] })).errors.length).toBeGreaterThan(0);
  });

  it('rejects an over-long title', () => {
    const v = validateDocumentDoc(doc({ type: 'doc', content: [] }, 'x'.repeat(MAX_TITLE + 1)));
    expect(v.errors.some((e) => e.path === 'title')).toBe(true);
  });

  it('rejects a document that exceeds the node-count cap (DoS guard)', () => {
    const many = Array.from({ length: MAX_NODES + 5 }, () => ({ type: 'paragraph' }));
    const v = validateDocumentDoc(doc({ type: 'doc', content: many }));
    expect(v.errors.length).toBeGreaterThan(0);
  });

  it('rejects a document that exceeds the nesting-depth cap (DoS guard)', () => {
    let node: Record<string, unknown> = { type: 'paragraph' };
    for (let i = 0; i < MAX_DEPTH + 5; i++) node = { type: 'blockquote', content: [node] };
    const v = validateDocumentDoc(doc({ type: 'doc', content: [node] }));
    expect(v.errors.length).toBeGreaterThan(0);
  });

  it('accepts chart + embed blocks, and caps oversized embed HTML (2b-3)', () => {
    const ok = validateDocumentDoc(doc({ type: 'doc', content: [
      { type: 'chartBlock', attrs: { spec: '{"chartType":"bar"}' } },
      { type: 'embedBlock', attrs: { html: '<b>hi</b>' } },
    ] }));
    expect(ok.errors.length).toBe(0);
    const huge = validateDocumentDoc(doc({ type: 'doc', content: [
      { type: 'embedBlock', attrs: { html: 'x'.repeat(MAX_EMBED_HTML + 1) } },
    ] }));
    expect(huge.errors.some((e) => e.path.endsWith('.attrs.html'))).toBe(true);
  });
});

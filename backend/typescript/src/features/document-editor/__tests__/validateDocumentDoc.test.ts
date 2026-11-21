/**
 * canvas.document validation tests (ADR 0334 Phase 1) — the light structural +
 * DoS guard the backend applies to a rich-text PATCH before persisting it on
 * host.canvas. The FRONTEND engine owns the full schema; this guard just rejects
 * garbage and oversized/over-deep payloads (the ADR 0328 import-DoS lesson).
 *
 * Each rejection case asserts WHICH guard fired (its error path / message), so an
 * unrelated error cannot satisfy it. Sabotage-witnessed (grade-tests w14): dropping
 * the root-object, root-type, node-type, text/marks/content type, title, node-count,
 * depth or embed-size check each turns its case red.
 *
 * Re-graded at grade-tests w117: each cap is pinned at its boundary (one over is
 * refused, exactly at the cap is accepted), so a cap moved by one is red; and the
 * node-field case fixtures use `paragraph`, since ADR 1055 D1 refuses a node type
 * outside the closed schema before the field checks run (`p` would stop there).
 * The closed-world checks themselves are in `test/adr1055-document-editor.test.ts`.
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
    // The root-object guard returns early with exactly one error on `content`.
    for (const bad of [undefined, 'nope', []]) {
      expect(validateDocumentDoc(doc(bad)).errors).toEqual([expect.objectContaining({ path: 'content' })]);
    }
  });

  it('rejects a non-"doc" root type', () => {
    const v = validateDocumentDoc(doc({ type: 'paragraph' }));
    expect(v.errors.map((e) => e.path)).toEqual(['content.type']);
  });

  it('rejects a node without a string type', () => {
    const v = validateDocumentDoc(doc({ type: 'doc', content: [{ attrs: {} }] }));
    expect(v.errors.map((e) => e.path)).toEqual(['content.content[0].type']);
  });

  it('rejects wrong-typed node fields (text/attrs/marks/content)', () => {
    const paths = (node: Record<string, unknown>) => validateDocumentDoc(doc({ type: 'doc', content: [node] })).errors.map((e) => e.path);
    expect(paths({ type: 'paragraph', text: 5 })).toEqual(['content.content[0].text']);
    expect(paths({ type: 'paragraph', attrs: 'x' })).toEqual(['content.content[0].attrs']);
    expect(paths({ type: 'paragraph', marks: {} })).toEqual(['content.content[0].marks']);
    expect(paths({ type: 'paragraph', content: {} })).toEqual(['content.content[0].content']);
  });

  it('rejects an over-long title', () => {
    const v = validateDocumentDoc(doc({ type: 'doc', content: [] }, 'x'.repeat(MAX_TITLE + 1)));
    expect(v.errors.map((e) => e.path)).toEqual(['title']);
    // Boundary: a title of exactly the cap is accepted.
    expect(validateDocumentDoc(doc({ type: 'doc', content: [] }, 'x'.repeat(MAX_TITLE))).errors).toEqual([]);
  });

  it('rejects a document that exceeds the node-count cap (DoS guard)', () => {
    // The root `doc` counts, so the root + MAX_NODES paragraphs is ONE node over the cap.
    const paragraphs = (n: number) => Array.from({ length: n }, () => ({ type: 'paragraph' }));
    const v = validateDocumentDoc(doc({ type: 'doc', content: paragraphs(MAX_NODES) }));
    expect(v.errors).toEqual([{ path: 'content', message: `document exceeds the ${MAX_NODES}-node limit` }]);
    // Boundary: exactly MAX_NODES nodes (the root + MAX_NODES - 1) are accepted.
    expect(validateDocumentDoc(doc({ type: 'doc', content: paragraphs(MAX_NODES - 1) })).errors).toEqual([]);
  });

  it('rejects a document that exceeds the nesting-depth cap (DoS guard)', () => {
    // `wraps` blockquotes around a paragraph, under the root: the paragraph sits at depth wraps + 1.
    const nested = (wraps: number) => {
      let node: Record<string, unknown> = { type: 'paragraph' };
      for (let i = 0; i < wraps; i++) node = { type: 'blockquote', content: [node] };
      return validateDocumentDoc(doc({ type: 'doc', content: [node] })).errors.map((e) => e.message);
    };
    expect(nested(MAX_DEPTH)).toEqual([`content nesting exceeds ${MAX_DEPTH} levels`]); // depth MAX_DEPTH + 1
    expect(nested(MAX_DEPTH - 1)).toEqual([]); // depth MAX_DEPTH: at the cap, accepted
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
    expect(huge.errors.map((e) => e.path)).toEqual(['content.content[0].attrs.html']);
    // Boundary: HTML of exactly the cap is accepted.
    expect(validateDocumentDoc(doc({ type: 'doc', content: [
      { type: 'embedBlock', attrs: { html: 'x'.repeat(MAX_EMBED_HTML) } },
    ] })).errors).toEqual([]);
  });
});

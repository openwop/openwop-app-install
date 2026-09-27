/**
 * The `canvas.document` doc model (ADR 0334 Phase 1). A rich-text document is
 * `{ title, content }` where `content` is a ProseMirror document node — the
 * TipTap engine's canonical JSON (`JSONContent`), stored verbatim on
 * `host.canvas`. The `JSONContent` import is TYPE-ONLY (erased at build — no
 * engine runtime enters this module), so the definition, the editor surface, the
 * renderer, and tests all share one coercion + one outline projection.
 */
import type { JSONContent } from '@tiptap/core';

export interface DocumentDoc {
  title: string;
  content: JSONContent;
}

/** A blank document — one empty paragraph (mirrors the backend `blankState`). */
export const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Narrow the opaque canvas state into the editable document — never launder
 *  through `as unknown as`; fall back to a valid empty doc on anything odd. */
export function coerceDocument(state: Record<string, unknown>): DocumentDoc {
  const content: JSONContent = isObj(state.content) && state.content.type === 'doc'
    ? (state.content as JSONContent)
    : EMPTY_DOC;
  return {
    title: typeof state.title === 'string' ? state.title : '',
    content,
  };
}

/** The plain text of a node subtree (concatenated leaf text). Bounded by the
 *  document's own node count (the backend validator caps it). */
function nodeText(node: JSONContent): string {
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(nodeText).join('');
}

/** Project the document into an outline for the shared navigation pane (ADR 0334
 *  `flow.headings`): top-level heading nodes → text + level + a stable-by-index
 *  anchor id. Scroll-target wiring lands in Phase 3. */
export function documentHeadings(doc: DocumentDoc): { id: string; text: string; level: number }[] {
  const blocks = doc.content.content ?? [];
  const out: { id: string; text: string; level: number }[] = [];
  blocks.forEach((node, i) => {
    if (node.type !== 'heading') return;
    const lvl = typeof node.attrs?.level === 'number' ? node.attrs.level : 1;
    const text = nodeText(node).trim();
    out.push({ id: `heading-${i}`, text: text || `Heading ${out.length + 1}`, level: lvl });
  });
  return out;
}

// ADR 0363 P2 — the a11y checker is now the SHARED `a11y/contentA11y` checker;
// document-editor keeps only a pure projector (doc → the normalized model).
export type { A11yIssue } from '../../a11y/contentA11y.js';
import { checkContentA11y, type ContentA11yModel } from '../../a11y/contentA11y.js';
import type { A11yIssue } from '../../a11y/contentA11y.js';

/** Deep-walk every node (bounded by the validated doc size). */
function walkNodes(node: JSONContent, visit: (n: JSONContent) => void): void {
  visit(node);
  (node.content ?? []).forEach((c) => walkNodes(c, visit));
}

/** Project a document into the normalized {@link ContentA11yModel}: images (with
 *  their alt) + heading levels. Links in prose are inline marks and out of scope
 *  for the document surface (parity with the original ADR 0334 checker). Pure. */
export function documentToA11yModel(doc: DocumentDoc): ContentA11yModel {
  const images: ContentA11yModel['images'] = [];
  const headings: ContentA11yModel['headings'] = [];
  walkNodes(doc.content, (n) => {
    if (n.type === 'image') {
      const alt = typeof n.attrs?.alt === 'string' ? n.attrs.alt.trim() : '';
      images.push({ alt, ref: `img-${images.length}` });
    } else if (n.type === 'heading') {
      const lvl = typeof n.attrs?.level === 'number' ? n.attrs.level : 1;
      headings.push({ level: lvl, ref: `head-${headings.length}` });
    }
  });
  return { images, headings, links: [] };
}

/** Accessibility checker: flags images missing alt text and skipped heading
 *  levels (WCAG 1.1.1 / 1.3.1) via the shared vocabulary. `[]` = clean. */
export function documentA11yIssues(doc: DocumentDoc): A11yIssue[] {
  return checkContentA11y(documentToA11yModel(doc));
}

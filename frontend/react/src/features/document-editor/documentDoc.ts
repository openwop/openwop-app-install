/**
 * The `canvas.document` doc model (ADR 0334 Phase 1). A rich-text document is
 * `{ title, content }` where `content` is a ProseMirror document node — the
 * TipTap engine's canonical JSON (`JSONContent`), stored verbatim on
 * `host.canvas`. The `JSONContent` import is TYPE-ONLY (erased at build — no
 * engine runtime enters this module), so the definition, the editor surface, the
 * renderer, and tests all share one coercion + one outline projection.
 */
import type { JSONContent } from '@tiptap/core';
import { DOCUMENT_INLINE_TYPES, DOCUMENT_MARK_TYPES, DOCUMENT_NODE_TYPES, DOCUMENT_TEXTBLOCK_TYPES, isDocumentHrefAllowed } from './documentSchemaNames.js';

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

const NODE_TYPES = new Set(DOCUMENT_NODE_TYPES);
const MARK_TYPES = new Set(DOCUMENT_MARK_TYPES);
const INLINE_TYPES = new Set(DOCUMENT_INLINE_TYPES);
const TEXTBLOCK_TYPES = new Set(DOCUMENT_TEXTBLOCK_TYPES);

/** What {@link repairDocumentContent} removed, counted by type. */
export interface DocumentRepair {
  content: JSONContent;
  /** `0` when nothing was removed. */
  droppedCount: number;
  dropped: Record<string, number>;
}

/**
 * ADR 1055 D2 — drop what the editor cannot open, keep everything else.
 *
 * TipTap opens a WHOLE document as blank when any node or mark in it is outside
 * the schema, or when a text node is empty. A stored document can still hold
 * one (written before the server validator closed, or after a type is removed),
 * so the editor and the renderer pass content through this first: an unknown
 * node goes with its subtree, an unknown or malformed mark goes off its text
 * node, an empty text node goes, and so does a link whose href the editor
 * refuses. Nesting is repaired too: a `doc` below the root goes (it has no DOM
 * form and would crash the view), a block inside a textblock goes, and text
 * sitting directly in a block container is wrapped in a paragraph. Everything else comes back unchanged (as a copy). Pure, and bounded
 * by the document's own size.
 */
export function repairDocumentContent(content: JSONContent): DocumentRepair {
  const dropped: Record<string, number> = {};
  let droppedCount = 0;
  const drop = (what: string): void => { dropped[what] = (dropped[what] ?? 0) + 1; droppedCount += 1; };
  const markOk = (m: unknown): boolean => {
    if (!isObj(m) || typeof m.type !== 'string') { drop('mark'); return false; }
    if (!MARK_TYPES.has(m.type)) { drop(m.type); return false; }
    if (m.type === 'link') {
      const href = isObj(m.attrs) ? m.attrs.href : undefined;
      if (typeof href !== 'string' || !isDocumentHrefAllowed(href)) { drop('link'); return false; }
    }
    return true;
  };
  const walk = (node: JSONContent, parentType: string | null): JSONContent | null => {
    if (!isObj(node) || typeof node.type !== 'string') { drop('node'); return null; }
    if (!NODE_TYPES.has(node.type)) { drop(node.type); return null; }
    if (parentType !== null && node.type === 'doc') { drop('doc'); return null; }
    if (parentType !== null && TEXTBLOCK_TYPES.has(parentType) && !INLINE_TYPES.has(node.type)) { drop(node.type); return null; }
    if (node.type === 'text' && (typeof node.text !== 'string' || node.text.length === 0)) { drop('empty text'); return null; }
    const out: JSONContent = { ...node };
    if (Array.isArray(node.marks)) {
      const marks = node.marks.filter(markOk);
      if (marks.length > 0) out.marks = marks; else delete out.marks;
    } else if (node.marks !== undefined) { drop('mark'); delete out.marks; }
    if (Array.isArray(node.content)) {
      const kids = node.content.map((c) => walk(c, node.type ?? null)).filter((c): c is JSONContent => c !== null);
      out.content = TEXTBLOCK_TYPES.has(node.type) ? kids : wrapStrayInline(kids);
    } else if (node.content !== undefined) { drop('content'); delete out.content; }
    return out;
  };
  const root = isObj(content) && content.type === 'doc' ? walk(content, null) : null;
  if (!root || !root.content || root.content.length === 0) return { content: EMPTY_DOC, dropped, droppedCount };
  return { content: root, dropped, droppedCount };
}

/** In a block container, consecutive inline children are gathered into one
 *  paragraph (text never sits directly in a doc, list item or cell). Nothing is
 *  lost, so this is not counted as dropped. */
function wrapStrayInline(kids: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  let run: JSONContent[] = [];
  const flush = (): void => {
    if (run.length > 0) { out.push({ type: 'paragraph', content: run }); run = []; }
  };
  for (const k of kids) {
    if (typeof k.type === 'string' && INLINE_TYPES.has(k.type)) run.push(k);
    else { flush(); out.push(k); }
  }
  flush();
  return out;
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

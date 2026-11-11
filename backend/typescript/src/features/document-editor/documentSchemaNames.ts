/**
 * The closed `canvas.document` schema, as names (ADR 1055 D1).
 *
 * The frontend's `documentSchema.ts` is the engine. TipTap turns a whole stored
 * document into an EMPTY one when any node or mark in it is outside that schema
 * (`createNodeFromContent` catches the `nodeFromJSON` throw), so the server must
 * refuse exactly what the engine cannot open. These lists are that boundary.
 * `frontend/react/src/features/document-editor/__tests__/documentSchemaParity.test.ts`
 * parses this file and fails when the editor's schema and these lists differ.
 * Removing a type here ships a stored-row migration (ADR 1055 D2).
 */

export const DOCUMENT_NODE_TYPES: readonly string[] = [
  'doc', 'paragraph', 'text', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem',
  'codeBlock', 'horizontalRule', 'hardBreak',
  'table', 'tableRow', 'tableHeader', 'tableCell',
  'image', 'mathBlock', 'chartBlock', 'embedBlock',
];

export const DOCUMENT_MARK_TYPES: readonly string[] = [
  'bold', 'italic', 'strike', 'code', 'underline', 'link',
  'comment', 'insertion', 'deletion',
];

/** Nesting (ADR 1055 D1, DE87CD-3/4): inline nodes sit only inside a textblock,
 *  a textblock holds only inline nodes, and `doc` is only the root. The editor
 *  renders a misplaced node wrongly or not at all (a nested `doc` has no DOM
 *  form and crashes the view). */
export const DOCUMENT_INLINE_TYPES: readonly string[] = ['text', 'hardBreak'];
export const DOCUMENT_TEXTBLOCK_TYPES: readonly string[] = ['paragraph', 'heading', 'codeBlock'];

/** Link schemes a document may carry. The editor's `link` extension, this
 *  validator and every exporter use this one list. */
export const DOCUMENT_LINK_PROTOCOLS: readonly string[] = ['http', 'https', 'mailto', 'tel'];

/** True for an href with an allowed scheme, or a scheme-less relative/anchor
 *  href. Control characters and whitespace are stripped first, the way a
 *  browser reads the scheme, so `java\tscript:` is still `javascript:`. */
export function isDocumentHrefAllowed(href: string): boolean {
  const s = href.replace(/[\u0000- \u007f-\u009f]/g, '');
  if (s === '') return false;
  // An entity- or percent-encoded scheme (`javascript&#58;…`, `javascript%3A…`)
  // reads as relative here and as a scheme to a Markdown renderer that decodes
  // it, so an encoding character before the first `/`, `?` or `#` refuses.
  if (/[&%\\]/.test(s.split(/[/?#]/)[0] ?? '')) return false;
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);
  if (!m) return true;
  return DOCUMENT_LINK_PROTOCOLS.includes(m[1]!.toLowerCase());
}

/**
 * The closed `canvas.document` schema as names (ADR 1055 D1/D2), engine-free so
 * `documentDoc.ts` can repair content without loading TipTap.
 *
 * Three lists must agree, and `__tests__/documentSchemaParity.test.ts` fails when
 * they do not: these constants, the schema `documentExtensions()` actually builds,
 * and the backend's `features/document-editor/documentSchemaNames.ts`, which the
 * server validator refuses against.
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

/** Link schemes a document may carry: the editor's `link` extension, the
 *  Markdown export and the server agree on this one list. */
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

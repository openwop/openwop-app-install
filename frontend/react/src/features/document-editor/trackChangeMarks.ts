/**
 * Track-changes suggestion marks for canvas.document (ADR 0334 6b-2).
 *
 * Two inline marks that ride in the shared schema (so the read-only renderer
 * shows suggestions too): `insertion` (proposed added text) and `deletion`
 * (proposed removed text — kept in the doc, struck through, never actually
 * removed until accepted). Each carries an `author`: `'ai'` for a suggestion
 * applied from the chat, empty for a typed one (ADR 1055 D6; it used to hold the
 * org id, which identified nobody). It is display-only and not personal data; a
 * REST writer can set it to anything. They are DISTINCT from StarterKit's
 * `strike` formatting mark. Applied/removed by the tracking plugin + the
 * accept/reject commands, never typed directly.
 */
import { Mark, mergeAttributes } from '@tiptap/core';

function authorAttr() {
  return {
    author: {
      default: '',
      parseHTML: (el: HTMLElement) => el.getAttribute('data-author') ?? '',
      renderHTML: (attrs: { author?: unknown }) => (attrs.author ? { 'data-author': String(attrs.author) } : {}),
    },
  };
}

export const InsertionMark = Mark.create({
  name: 'insertion',
  inclusive: false,
  addAttributes() { return authorAttr(); },
  // priority 60 (> the default 50): StarterKit's Strike also parses `<del>` and
  // is registered first, so without it a pasted deletion became permanent
  // strikethrough (DE87UX-22).
  parseHTML() { return [{ tag: 'ins[data-insertion]', priority: 60 }, { tag: 'span[data-insertion]', priority: 60 }]; },
  // Native <ins>/<del> (DE87UX-12), so assistive tech can tell a proposed
  // insertion from a proposed deletion; <span> read both as one run of text.
  renderHTML({ HTMLAttributes }) {
    return ['ins', mergeAttributes(HTMLAttributes, { 'data-insertion': '', class: 'doc-ins' }), 0];
  },
});

export const DeletionMark = Mark.create({
  name: 'deletion',
  inclusive: false,
  addAttributes() { return authorAttr(); },
  parseHTML() { return [{ tag: 'del[data-deletion]', priority: 60 }, { tag: 'span[data-deletion]', priority: 60 }]; },
  renderHTML({ HTMLAttributes }) {
    return ['del', mergeAttributes(HTMLAttributes, { 'data-deletion': '', class: 'doc-del' }), 0];
  },
});

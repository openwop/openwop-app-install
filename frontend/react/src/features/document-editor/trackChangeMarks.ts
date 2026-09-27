/**
 * Track-changes suggestion marks for canvas.document (ADR 0334 6b-2).
 *
 * Two inline marks that ride in the shared schema (so the read-only renderer
 * shows suggestions too): `insertion` (proposed added text) and `deletion`
 * (proposed removed text — kept in the doc, struck through, never actually
 * removed until accepted). Each carries an opaque `author` id for attribution.
 * They are DISTINCT from StarterKit's `strike` formatting mark. Applied/removed
 * by the tracking plugin + the accept/reject commands, never typed directly.
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
  parseHTML() { return [{ tag: 'span[data-insertion]' }]; },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-insertion': '', class: 'doc-ins' }), 0];
  },
});

export const DeletionMark = Mark.create({
  name: 'deletion',
  inclusive: false,
  addAttributes() { return authorAttr(); },
  parseHTML() { return [{ tag: 'span[data-deletion]' }]; },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-deletion': '', class: 'doc-del' }), 0];
  },
});

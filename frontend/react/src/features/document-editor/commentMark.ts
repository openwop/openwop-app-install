/**
 * `comment` mark for canvas.document (ADR 0334 6b) — anchors an inline comment
 * thread to a text range. The mark carries only an opaque `threadId`; the thread
 * itself lives in the comments backend under `resourceId = ${canvasId}#${threadId}`
 * (the chat_message/priority_idea composite-id precedent). The mark IS the anchor
 * — ProseMirror repositions it automatically as the surrounding text is edited,
 * so the comment "sticks" to its range across edits. Shared by the editable
 * surface AND the read-only renderer (a shared/public view shows the highlight).
 * `inclusive:false` so typing at either boundary doesn't silently extend it.
 */
import { Mark, mergeAttributes } from '@tiptap/core';

export const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,
  addAttributes() {
    return {
      threadId: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-comment-thread') ?? '',
        renderHTML: (attrs) => (attrs.threadId ? { 'data-comment-thread': String(attrs.threadId) } : {}),
      },
    };
  },
  parseHTML() { return [{ tag: 'span[data-comment-thread]' }]; },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'doc-comment' }), 0];
  },
});

/**
 * `embedBlock` — a sandboxed-HTML node for canvas.document (ADR 0334 2b-3). An
 * atom block holding an untrusted HTML body string in `data-html`; the React
 * NodeView renders it through the chat `SandboxedArtifactFrame` (isolated iframe,
 * no same-origin, no network egress). Editing goes through the surface's embed
 * modal. Shared by the editable surface AND the read-only renderer.
 */
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { EmbedNodeView } from './EmbedNodeView.js';

export const EmbedBlock = Node.create({
  name: 'embedBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      html: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-html') ?? '',
        renderHTML: (attrs) => ({ 'data-html': String(attrs.html ?? '') }),
      },
    };
  },
  parseHTML() { return [{ tag: 'div[data-embed-block]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-embed-block': '' })]; },
  addNodeView() { return ReactNodeViewRenderer(EmbedNodeView); },
});

/**
 * `mathBlock` — a KaTeX display-math node for canvas.document (ADR 0334 2b-2).
 * An atom block holding a LaTeX string in `data-latex`; the NodeView renders it
 * with `katex.render` (KaTeX emits math markup from LaTeX — not executable HTML;
 * the repo already renders KaTeX via rehype-katex, and `throwOnError:false`
 * degrades a malformed formula to its source text). Editing goes through the
 * surface's LaTeX modal (select the node → edit), so the node needs no inline
 * editing. Shared by the editable surface AND the read-only renderer.
 */
import { Node, mergeAttributes } from '@tiptap/core';
import katex from 'katex';
// The doc editor is its own lazy chunk; ensure KaTeX styles load here too
// (bundler-dedup'd with the chat chunk's import).
import 'katex/dist/katex.min.css';

function paint(dom: HTMLElement, latex: string): void {
  dom.setAttribute('aria-label', latex || 'math');
  try { katex.render(latex, dom, { throwOnError: false, displayMode: true }); }
  catch { dom.textContent = latex; }
}

export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-latex') ?? '',
        renderHTML: (attrs) => ({ 'data-latex': String(attrs.latex ?? '') }),
      },
    };
  },
  parseHTML() { return [{ tag: 'div[data-math-block]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-math-block': '' })]; },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'doc-math';
      dom.setAttribute('data-math-block', '');
      dom.setAttribute('role', 'math');
      paint(dom, String(node.attrs.latex ?? ''));
      return {
        dom,
        update: (updated) => {
          if (updated.type.name !== 'mathBlock') return false;
          paint(dom, String(updated.attrs.latex ?? ''));
          return true;
        },
      };
    };
  },
});

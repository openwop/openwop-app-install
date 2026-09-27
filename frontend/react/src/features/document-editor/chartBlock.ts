/**
 * `chartBlock` — a data-chart node for canvas.document (ADR 0334 2b-3). An atom
 * block holding an `interactive.chart` JSON spec string in `data-spec`; the React
 * NodeView renders it through the chat `ChartRenderer` (inline SVG, no charting
 * lib). Editing goes through the surface's chart modal. Shared by the editable
 * surface AND the read-only renderer via `documentExtensions()`.
 */
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { ChartNodeView } from './ChartNodeView.js';

export const ChartBlock = Node.create({
  name: 'chartBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      spec: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-spec') ?? '',
        renderHTML: (attrs) => ({ 'data-spec': String(attrs.spec ?? '') }),
      },
    };
  },
  parseHTML() { return [{ tag: 'div[data-chart-block]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-chart-block': '' })]; },
  addNodeView() { return ReactNodeViewRenderer(ChartNodeView); },
});

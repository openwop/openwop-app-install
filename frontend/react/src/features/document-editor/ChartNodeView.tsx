/**
 * React NodeView for the `chartBlock` node (ADR 0334 2b-3). Reuses the chat
 * artifact `ChartRenderer` (pure inline SVG from a parsed JSON spec — no charting
 * lib, XSS-safe by construction) so a document chart renders identically in the
 * editable surface AND the read-only renderer. The node is an atom; editing goes
 * through the surface's chart modal (select the node → edit).
 */
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import { ChartRenderer } from '../../chat/artifacts/ChartRenderer.js';

export function ChartNodeView({ node, selected }: ReactNodeViewProps): JSX.Element {
  const { t } = useTranslation('document-editor');
  const spec = String(node.attrs.spec ?? '');
  return (
    <NodeViewWrapper
      className={`doc-chart${selected ? ' doc-chart--selected' : ''}`}
      data-chart-block=""
      role="figure"
      aria-label={t('chart')}
    >
      <ChartRenderer content={spec} />
    </NodeViewWrapper>
  );
}

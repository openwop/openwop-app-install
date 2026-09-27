/**
 * React NodeView for the `embedBlock` node (ADR 0334 2b-3). Reuses the chat
 * `SandboxedArtifactFrame` — the app's accepted isolation boundary for untrusted
 * HTML: `sandbox="allow-scripts"` (opaque origin — no access to the app's cookies,
 * tokens, or storage) + a `default-src 'none'` CSP (no network egress) + `srcDoc`
 * only (never innerHTML). So an author's embed is neutralised even when it renders
 * in another viewer's browser. The stored HTML is inert PM-JSON until this frame
 * isolates it. Editing goes through the surface's embed modal.
 */
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import { SandboxedArtifactFrame } from '../../chat/artifacts/SandboxedArtifactFrame.js';

export function EmbedNodeView({ node, selected }: ReactNodeViewProps): JSX.Element {
  const { t } = useTranslation('document-editor');
  const html = String(node.attrs.html ?? '');
  return (
    <NodeViewWrapper
      className={`doc-embed${selected ? ' doc-embed--selected' : ''}`}
      data-embed-block=""
      role="figure"
      aria-label={t('embed')}
    >
      <SandboxedArtifactFrame body={html} title={t('embed')} />
    </NodeViewWrapper>
  );
}

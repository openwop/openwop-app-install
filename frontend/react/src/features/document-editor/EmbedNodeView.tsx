/**
 * React NodeView for the `embedBlock` node (ADR 0334 2b-3). Reuses the chat
 * `SandboxedArtifactFrame`, the app's isolation boundary for untrusted HTML: an opaque
 * origin (no access to the app's cookies, tokens or storage), `srcDoc` only (never
 * innerHTML), and STATIC until the reader runs its scripts (ADR 1017 D1). Running
 * scripts can reach the network, so the embed of another workspace member never runs
 * in a reader's browser without that reader's click. Consent is keyed by the HTML, so
 * a peer's edit starts static again. Editing goes through the surface's embed modal.
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

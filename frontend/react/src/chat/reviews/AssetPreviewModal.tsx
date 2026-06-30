/**
 * AssetPreviewModal — renders the concrete asset(s) a HITL approval is gating,
 * by detected type, so a reviewer sees WHAT they're approving (a drafted email,
 * a markdown doc, prose) instead of raw output or an opaque id.
 *
 * Convergent with how Claude Artifacts / ChatGPT Canvas / Copilot present the
 * thing under review: rendered, in a focused surface — never raw JSON. Reuses
 * the shared `<Modal>` (focus-trap + Esc + aria) and `<Markdown>` primitives.
 * Type detection is intentionally conservative; markdown also renders plain
 * text well, so the default path is safe for arbitrary drafted content.
 */

import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import { AssetPreview } from './AssetPreview.js';
import type { ReviewAsset } from './reviewClient.js';

export function AssetPreviewModal({
  open,
  assets,
  title,
  onClose,
}: {
  open: boolean;
  assets: readonly ReviewAsset[];
  /** Dialog title — the approval subject, so the reviewer keeps context. */
  title: string;
  onClose: () => void;
}): JSX.Element | null {
  const { t } = useTranslation('chat');
  if (!open) return null;
  return (
    <Modal onClose={onClose} label={t('assetPreviewLabel', { title })}>
      <div className="assetpreview-root">
        <h2 className="u-fs-14 u-fw-600 u-mbox-b2">{title}</h2>
        {assets.length === 0
          ? <p className="muted u-fs-12">{t('assetPreviewNone')}</p>
          : assets.map((a, i) => <AssetPreview key={a.artifactId ?? a.label ?? i} asset={a} />)}
      </div>
    </Modal>
  );
}

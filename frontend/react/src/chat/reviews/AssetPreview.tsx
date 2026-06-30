/**
 * AssetPreview — renders ONE asset a HITL approval is gating, by detected type,
 * so a reviewer sees WHAT they're approving (a drafted email, a markdown doc,
 * prose) instead of raw output or an opaque id.
 *
 * Extracted from `AssetPreviewModal` (DS reuse) so the SAME renderer backs both
 * the focused modal AND the inline preview embedded in the approval card — the
 * approver should see the content WITHOUT a click, never a dead-end "Preview"
 * button. Type detection is conservative; markdown also renders plain text well,
 * so the default path is safe for arbitrary drafted content.
 */

import { useTranslation } from 'react-i18next';
import { Markdown } from '../../ui/Markdown.js';
import { FileTextIcon } from '../../ui/icons/index.js';
import type { ReviewAsset } from './reviewClient.js';

const EMAIL_HEADER_LINE = /^\s*(To|From|Cc|Bcc|Subject|Reply-To)\s*:\s*(.*)$/i;

/** An email draft if the content opens with header lines including a Subject. */
export function looksLikeEmail(content: string): boolean {
  const head = content.slice(0, 500);
  return /^\s*(to|from|cc|bcc|subject)\s*:/im.test(head) && /(^|\n)\s*subject\s*:/i.test(head);
}

function EmailView({ content }: { content: string }): JSX.Element {
  const lines = content.split('\n');
  const headers: { label: string; value: string }[] = [];
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = EMAIL_HEADER_LINE.exec(lines[i]!);
    if (m) {
      headers.push({ label: m[1]!, value: m[2]! });
      bodyStart = i + 1;
    } else if (lines[i]!.trim() === '') {
      bodyStart = i + 1;
      break; // blank line ends the header block
    } else if (headers.length > 0) {
      break; // first non-header, non-blank line after headers → body
    }
  }
  const body = lines.slice(bodyStart).join('\n').trim();
  return (
    <div className="assetpreview-email">
      <dl className="assetpreview-email-headers">
        {headers.map((h) => (
          <div key={h.label} className="assetpreview-email-row">
            <dt className="muted u-fs-11 u-mono">{h.label}</dt>
            <dd className="u-fs-13">{h.value || '—'}</dd>
          </div>
        ))}
      </dl>
      {body && <div className="assetpreview-email-body"><Markdown>{body}</Markdown></div>}
    </div>
  );
}

/** Single-asset renderer. `hideLabel` suppresses the per-asset heading when the
 *  surrounding surface (e.g. the approval card) already names the content. */
export function AssetPreview({ asset, hideLabel }: { asset: ReviewAsset; hideLabel?: boolean }): JSX.Element {
  const { t } = useTranslation('chat');
  const content = asset.content;
  return (
    <div className="assetpreview-asset">
      {asset.label && !hideLabel && (
        <div className="assetpreview-asset-head u-iflex u-items-center u-gap-1-5">
          <FileTextIcon size={14} aria-hidden />
          <span className="u-fw-600 u-fs-13">{asset.label}</span>
        </div>
      )}
      {content
        ? (looksLikeEmail(content)
            ? <EmailView content={content} />
            : <div className="assetpreview-body"><Markdown>{content}</Markdown></div>)
        : (
          <p className="muted u-fs-12">
            {asset.artifactId ? t('assetPreviewArtifactRef', { id: asset.artifactId }) : t('assetPreviewNone')}
          </p>
        )}
    </div>
  );
}

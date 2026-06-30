/**
 * Media asset Card + Row — the two cells of the §4.5 collection-view canon
 * (rule 11) for the Media Library page. The Card fills a `.card-grid`; the Row
 * fills a `.surface-card.list-view`. Both derive their sub-line + chips from the
 * SAME helpers below, so the grid and list views never diverge. Composed from
 * existing primitives — no bespoke CSS. Preserves every asset datum/action:
 * thumbnail/preview (image assets) or a file icon, name, tag chips, the
 * usage/unused badge, and the Delete action.
 */

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { IconButton } from '../../ui/IconButton.js';
import { ImageIcon, TrashIcon } from '../../ui/icons/index.js';
import { formatBytes, formatNumber } from '../../i18n/format.js';
import { absoluteServeUrl, type MediaAsset } from './mediaClient.js';

const isImage = (a: MediaAsset): boolean => a.contentType.startsWith('image/');

/** The short format label from the asset content-type — the `png` of `image/png`,
 *  else the full type. Shared by Card + Row. */
export function assetFormat(a: MediaAsset): string {
  const slash = a.contentType.lastIndexOf('/');
  return (slash >= 0 ? a.contentType.slice(slash + 1) : a.contentType).toUpperCase();
}

/** The contextual one-liner from REAL fields — format + human size. Shared by
 *  Card + Row. */
export function assetSubLine(a: MediaAsset): string {
  return `${assetFormat(a)} · ${formatBytes(a.sizeBytes)}`;
}

/** The asset thumbnail (image preview) or a file icon — shared by Card + Row. */
function AssetThumb({ a }: { a: MediaAsset }): JSX.Element {
  return isImage(a) ? (
    <img src={absoluteServeUrl(a.serveUrl)} alt={a.name} className="media-thumb-img" />
  ) : (
    <ImageIcon aria-hidden />
  );
}

function AssetUsage({ a, t }: { a: MediaAsset; t: TFunction }): JSX.Element {
  return (
    <span className="u-label-sm">
      {a.usageCount > 0 ? t('usageCount', { count: a.usageCount, used: formatNumber(a.usageCount) }) : t('unused')}
    </span>
  );
}

function AssetChips({ a }: { a: MediaAsset }): JSX.Element {
  return (
    <>
      <span className="chip chip--muted">{assetFormat(a)}</span>
      {a.tags.map((tag) => (
        <span key={tag} className="chip">{tag}</span>
      ))}
    </>
  );
}

export function MediaAssetCard({
  asset: a,
  onDelete,
}: {
  asset: MediaAsset;
  onDelete: () => void;
}): JSX.Element {
  const { t } = useTranslation('media');
  return (
    <div className="surface-card u-gap-2 u-p-2">
      <div className="media-thumb">
        <AssetThumb a={a} />
      </div>
      <span className="media-asset-name" title={a.name}>{a.name}</span>
      <div className="u-flex u-wrap u-gap-1">
        <AssetChips a={a} />
      </div>
      <div className="action-bar u-justify-between">
        <AssetUsage a={a} t={t} />
        <IconButton label={t('deleteAssetLabel')} icon={<TrashIcon />} className="btn-ghost" onClick={onDelete} />
      </div>
    </div>
  );
}

export function MediaAssetRow({
  asset: a,
  onDelete,
}: {
  asset: MediaAsset;
  onDelete: () => void;
}): JSX.Element {
  const { t } = useTranslation('media');
  return (
    <div className="list-row">
      <div className="list-row-id">
        <ImageIcon size={18} aria-hidden />
        <span className="list-row-name-wrap">
          <span className="list-row-name-line">
            <span className="list-row-name">{a.name}</span>
          </span>
          <span className="list-row-sub">{assetSubLine(a)}</span>
        </span>
      </div>
      <div className="list-row-meta">
        <AssetChips a={a} />
        <AssetUsage a={a} t={t} />
      </div>
      <div className="list-row-actions action-bar">
        <IconButton label={t('deleteAssetLabel')} icon={<TrashIcon />} className="btn-ghost" onClick={onDelete} />
      </div>
    </div>
  );
}

/**
 * Marketplace pack Card + Row — the two cells of the §4.5 collection-view canon
 * (rule 11) for the Marketplace page. The Card fills a `.card-grid`; the Row
 * fills a `.surface-card.list-view`. Both derive their sub-line + chips from the
 * SAME helpers below, so the grid and list views never diverge. Composed from
 * existing primitives — no bespoke CSS. Preserves every card datum/action:
 * pack name, category chip, install-status chip, description sub-line,
 * "required by" note, and the Reviews + Install actions.
 */

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { PackageIcon } from '../../ui/icons/index.js';
import type { Listing } from './marketplaceClient.js';

/** The contextual one-liner from REAL fields — the pack description, else a
 *  no-description fallback. Shared by Card + Row. */
export function listingSubLine(l: Listing, t: TFunction): string {
  return l.description || t('subNoDescription');
}

function ListingChips({ l, t }: { l: Listing; t: TFunction }): JSX.Element {
  return (
    <>
      <span className="chip chip--muted">{l.category}</span>
      <span className={`chip ${l.installed ? 'chip--success' : 'chip--muted'}`}>
        {l.installed ? t('installed') : t('notInstalled')}
      </span>
    </>
  );
}

function ListingActions({
  l,
  busy,
  onReviews,
  onInstall,
}: {
  l: Listing;
  busy: boolean;
  onReviews: () => void;
  onInstall: () => void;
}): JSX.Element {
  const { t } = useTranslation('marketplace');
  return (
    <>
      <button type="button" className="btn-ghost" onClick={onReviews}>{t('reviewsAction')}</button>
      <button type="button" className="btn-primary" disabled={busy || l.installed} onClick={onInstall}>
        {l.installed ? t('installed') : t('install')}
      </button>
    </>
  );
}

export function ListingCard({
  listing: l,
  busy,
  onReviews,
  onInstall,
}: {
  listing: Listing;
  busy: boolean;
  onReviews: () => void;
  onInstall: () => void;
}): JSX.Element {
  const { t } = useTranslation('marketplace');
  return (
    <li className="surface-card u-p-4 mkt-card">
      <div className="mkt-card-head">
        <PackageIcon size={18} aria-hidden />
        <div className="u-grid u-gap-1">
          <span className="mkt-card-title">{l.packName}</span>
          <span className="chip chip--muted">{l.category}</span>
        </div>
        <span className={`chip ${l.installed ? 'chip--success' : 'chip--muted'}`}>{l.installed ? t('installed') : t('notInstalled')}</span>
      </div>
      {l.description ? <p className="mkt-card-desc">{l.description}</p> : null}
      {l.requiredBy && l.requiredBy.length > 0 ? (
        <p className="u-text-muted mkt-card-meta">{t('requiredBy', { packs: l.requiredBy.join(', ') })}</p>
      ) : null}
      <div className="action-bar">
        <ListingActions l={l} busy={busy} onReviews={onReviews} onInstall={onInstall} />
      </div>
    </li>
  );
}

export function ListingRow({
  listing: l,
  busy,
  onReviews,
  onInstall,
}: {
  listing: Listing;
  busy: boolean;
  onReviews: () => void;
  onInstall: () => void;
}): JSX.Element {
  const { t } = useTranslation('marketplace');
  return (
    <div className="list-row">
      <div className="list-row-id">
        <PackageIcon size={18} aria-hidden />
        <span className="list-row-name-wrap">
          <span className="list-row-name-line">
            <span className="list-row-name">{l.packName}</span>
          </span>
          <span className="list-row-sub">{listingSubLine(l, t)}</span>
        </span>
      </div>
      <div className="list-row-meta">
        <ListingChips l={l} t={t} />
        {l.requiredBy && l.requiredBy.length > 0 ? (
          <span>{t('requiredBy', { packs: l.requiredBy.join(', ') })}</span>
        ) : null}
      </div>
      <div className="list-row-actions action-bar">
        <ListingActions l={l} busy={busy} onReviews={onReviews} onInstall={onInstall} />
      </div>
    </div>
  );
}

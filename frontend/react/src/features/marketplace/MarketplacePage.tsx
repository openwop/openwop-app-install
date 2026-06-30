/**
 * Marketplace (host-extension product feature — ADR 0022). Browse signed feature
 * packs (install status + aggregate rating), install (superadmin — a 403 is
 * surfaced as a clear message), and review. Gates on useFeatureAccess('marketplace'):
 * hidden in nav when off, a disabled StateCard on the page when off.
 *
 * Reviews are ORG-scoped, so an org picker drives the detail panel's reviews.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n/index.js';
import { formatDate, formatNumber } from '../../i18n/format.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { BoxesIcon, LockIcon, StarIcon, TrashIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import {
  listListings, installPack, listOrgs, listReviews, postReview, deleteReview,
  type Listing, type Review, type RatingSummary, type Org,
} from './marketplaceClient.js';
import { ListingCard, ListingRow } from './MarketplaceViews.js';

const when = (iso: string): string => { try { return formatDate(iso); } catch { return iso; } };
const authorLabel = (id: string): string => (id.startsWith('agent:') ? i18n.t('marketplace:authorAgent') : id);

/**
 * A 1–5 star row. Read-only (`onPick` absent): a single labelled `img` role
 * announcing "N out of 5 stars" (the individual glyphs are decorative). Interactive
 * (`onPick` present): a proper `radiogroup` of `radio` buttons (`aria-checked`),
 * each with a per-star label, so the rating is keyboard- and screen-reader-operable.
 */
function Stars({ value, onPick, label }: { value: number; onPick?: (n: number) => void; label?: string }): JSX.Element {
  const { t } = useTranslation('marketplace');
  const stars = [1, 2, 3, 4, 5];
  if (!onPick) {
    return (
      <span className="mkt-stars" role="img" aria-label={t('starsReadLabel', { count: Math.round(value) })}>
        {stars.map((n) => (
          <span key={n} className="mkt-star" aria-hidden>
            <StarIcon fill={n <= Math.round(value) ? 'currentColor' : 'none'} />
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className="mkt-stars" role="radiogroup" aria-label={label ?? t('ratingLabel')}>
      {stars.map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={n === value}
          className="btn-ghost mkt-star-btn"
          aria-label={t('starLabel', { count: n })}
          onClick={() => onPick(n)}
        >
          <StarIcon fill={n <= value ? 'currentColor' : 'none'} />
        </button>
      ))}
    </span>
  );
}

export function MarketplacePage(): JSX.Element {
  const { t } = useTranslation('marketplace');
  const access = useFeatureAccess('marketplace');
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewMode, setViewMode] = useViewMode('marketplace', 'grid');

  const load = useCallback(() => {
    setError(null);
    void listListings()
      .then(setListings)
      .catch((err) => setError(err instanceof Error ? err.message : t('loadFailed')));
  }, [t]);

  useEffect(() => { if (access.enabled) load(); }, [access.enabled, load]);

  const filtered = useMemo(() => {
    if (!listings) return null;
    const q = query.trim().toLowerCase();
    if (!q) return listings;
    return listings.filter((l) => `${l.packName} ${l.title} ${l.description ?? ''} ${l.category}`.toLowerCase().includes(q));
  }, [listings, query]);

  const install = useCallback(async (l: Listing) => {
    setBusy(true);
    try {
      const r = await installPack({ packName: l.packName, version: l.version });
      toast.success(r.alreadyInstalled ? t('alreadyInstalled', { pack: l.packName }) : t('installedToast', { pack: l.packName }));
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('installFailed'));
    } finally {
      setBusy(false);
    }
  }, [load, t]);

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return (
      <section className="u-grid u-gap-4">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </section>
    );
  }

  const selectedListing = selected ? (listings ?? []).find((l) => l.packName === selected) ?? null : null;

  return (
    <section className="u-grid u-gap-4">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      <div className="filterbar" role="group" aria-label={t('filterGroup')}>
        <input
          type="search"
          className="ui-input filterbar-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchPacksLabel')}
        />
        <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" />
      </div>

      {filtered === null ? (
        <Skeleton />
      ) : filtered.length === 0 ? (
        <StateCard icon={<BoxesIcon />} title={t('noPacksFoundTitle')} body={query ? t('noPacksFoundBodySearch') : t('noPacksFoundBodyEmpty')} />
      ) : viewMode === 'grid' ? (
        <ul className="card-grid mkt-list" aria-label={t('packsLabel')}>
          {filtered.map((l) => (
            <ListingCard
              key={l.packName}
              listing={l}
              busy={busy}
              onReviews={() => setSelected(l.packName)}
              onInstall={() => void install(l)}
            />
          ))}
        </ul>
      ) : (
        <div className="surface-card list-view" aria-label={t('packsLabel')}>
          {filtered.map((l) => (
            <ListingRow
              key={l.packName}
              listing={l}
              busy={busy}
              onReviews={() => setSelected(l.packName)}
              onInstall={() => void install(l)}
            />
          ))}
        </div>
      )}

      {selectedListing ? (
        <ReviewsPanel listing={selectedListing} onClose={() => setSelected(null)} />
      ) : null}
    </section>
  );
}

/** Org-scoped reviews for one pack: pick an org, see the aggregate + reviews, rate. */
function ReviewsPanel({ listing, onClose }: { listing: Listing; onClose: () => void }): JSX.Element {
  const { t } = useTranslation('marketplace');
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [summary, setSummary] = useState<RatingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void listOrgs().then((o) => { setOrgs(o); setOrgId((c) => c || (o[0]?.orgId ?? '')); }).catch(() => setOrgs([]));
  }, []);

  const load = useCallback((org: string) => {
    if (!org) return;
    setError(null); setReviews(null);
    void listReviews(org, listing.packName)
      .then((r) => { setReviews(r.reviews); setSummary(r.summary); })
      .catch((e) => { setReviews([]); setError(e instanceof Error ? e.message : t('loadReviewsFailed')); });
  }, [listing.packName, t]);

  useEffect(() => { if (orgId) load(orgId); }, [orgId, load]);

  const submit = useCallback(async () => {
    if (rating < 1) { toast.error(t('pickRating')); return; }
    setBusy(true);
    try {
      await postReview(orgId, listing.packName, { rating, ...(body.trim() ? { body: body.trim() } : {}) });
      setBody(''); setRating(0);
      load(orgId);
      toast.success(t('reviewSaved'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('reviewFailed'));
    } finally { setBusy(false); }
  }, [orgId, listing.packName, rating, body, load, t]);

  const remove = useCallback(async (r: Review) => {
    try { await deleteReview(orgId, listing.packName, r.reviewId); load(orgId); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); }
  }, [orgId, listing.packName, load, t]);

  const orgPicker = orgs && orgs.length > 1 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('orgPickerLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  return (
    <div className="surface-card u-p-4 u-grid u-gap-3" aria-label={t('reviewsForLabel', { pack: listing.packName })}>
      <div className="mkt-card-head">
        <div className="u-grid u-gap-1">
          <span className="mkt-card-title">{t('reviewsForTitle', { pack: listing.packName })}</span>
          {summary && summary.average !== null ? (
            <span className="mkt-summary"><Stars value={summary.average} /> <span className="u-text-muted">{t('reviewsSummary', { average: formatNumber(summary.average), total: formatNumber(summary.count) })}</span></span>
          ) : (
            <span className="u-text-muted">{t('noReviewsInline')}</span>
          )}
        </div>
        {orgPicker}
        <button type="button" className="btn-ghost" onClick={onClose} aria-label={t('closeReviewsLabel')}>{t('common:close')}</button>
      </div>

      {error ? <Notice variant="error">{error}</Notice> : null}

      <div className="surface-card u-p-3 surface-form u-grid u-gap-2">
        <div className="u-grid u-gap-1">
          <span className="u-label-sm">{t('yourRating')}</span>
          <Stars value={rating} onPick={setRating} label={t('yourRating')} />
        </div>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('commentOptional')}</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder={t('commentPlaceholder')} />
        </label>
        <button type="button" className="btn-primary" disabled={busy || rating < 1} onClick={() => void submit()}>{t('submitReview')}</button>
      </div>

      {reviews === null ? <Skeleton /> : reviews.length === 0 ? (
        <StateCard icon={<StarIcon />} title={t('noReviewsTitle')} body={t('noReviewsBody')} />
      ) : (
        <ul className="u-grid u-gap-2 mkt-reviews">
          {reviews.map((r) => (
            <li key={r.reviewId} className="surface-card u-p-3 mkt-review">
              <div className="mkt-review-head">
                <Stars value={r.rating} />
                <span className="u-text-muted">{authorLabel(r.authorId)} · {when(r.createdAt)}</span>
                <button type="button" className="btn-ghost" onClick={() => void remove(r)} aria-label={t('deleteReviewLabel')}><TrashIcon /></button>
              </div>
              {r.body ? <p className="mkt-review-body">{r.body}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

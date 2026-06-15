/**
 * Marketplace (host-extension product feature — ADR 0022). Browse signed feature
 * packs (install status + aggregate rating), install (superadmin — a 403 is
 * surfaced as a clear message), and review. Gates on useFeatureAccess('marketplace'):
 * hidden in nav when off, a disabled StateCard on the page when off.
 *
 * Reviews are ORG-scoped, so an org picker drives the detail panel's reviews.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { BoxesIcon, LockIcon, PackageIcon, SearchIcon, StarIcon, TrashIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import {
  listListings, installPack, listOrgs, listReviews, postReview, deleteReview,
  type Listing, type Review, type RatingSummary, type Org,
} from './marketplaceClient.js';

const when = (iso: string): string => { try { return new Date(iso).toLocaleDateString(); } catch { return iso; } };
const authorLabel = (id: string): string => (id.startsWith('agent:') ? 'Agent' : id);

/**
 * A 1–5 star row. Read-only (`onPick` absent): a single labelled `img` role
 * announcing "N out of 5 stars" (the individual glyphs are decorative). Interactive
 * (`onPick` present): a proper `radiogroup` of `radio` buttons (`aria-checked`),
 * each with a per-star label, so the rating is keyboard- and screen-reader-operable.
 */
function Stars({ value, onPick, label }: { value: number; onPick?: (n: number) => void; label?: string }): JSX.Element {
  const stars = [1, 2, 3, 4, 5];
  if (!onPick) {
    return (
      <span className="mkt-stars" role="img" aria-label={`${Math.round(value)} out of 5 stars`}>
        {stars.map((n) => (
          <span key={n} className="mkt-star" aria-hidden>
            <StarIcon fill={n <= Math.round(value) ? 'currentColor' : 'none'} />
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className="mkt-stars" role="radiogroup" aria-label={label ?? 'Rating'}>
      {stars.map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={n === value}
          className="btn-ghost mkt-star-btn"
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
          onClick={() => onPick(n)}
        >
          <StarIcon fill={n <= value ? 'currentColor' : 'none'} />
        </button>
      ))}
    </span>
  );
}

export function MarketplacePage(): JSX.Element {
  const access = useFeatureAccess('marketplace');
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    void listListings()
      .then(setListings)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load the marketplace.'));
  }, []);

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
      toast.success(r.alreadyInstalled ? `${l.packName} is already installed.` : `Installed ${l.packName}.`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Install failed.');
    } finally {
      setBusy(false);
    }
  }, [load]);

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return (
      <section className="u-grid u-gap-4">
        <PageHeader eyebrow="Business" title="Marketplace" />
        <StateCard icon={<LockIcon />} title="Marketplace is not enabled" body="Ask an administrator to turn on the Marketplace feature in Admin → Feature toggles." />
      </section>
    );
  }

  const selectedListing = selected ? (listings ?? []).find((l) => l.packName === selected) ?? null : null;

  return (
    <section className="u-grid u-gap-4">
      <PageHeader eyebrow="Business" title="Marketplace" lede="Browse and install signed feature packs from the registry." />
      {error ? <Notice variant="error">{error}</Notice> : null}

      <div className="surface-card u-p-3 mkt-search">
        <SearchIcon />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search packs by name, capability, or category"
          aria-label="Search packs"
        />
      </div>

      {filtered === null ? (
        <Skeleton />
      ) : filtered.length === 0 ? (
        <StateCard icon={<BoxesIcon />} title="No packs found" body={query ? 'No packs match your search. Try a broader term.' : 'No packs are available in the catalog yet.'} />
      ) : (
        <ul className="card-grid mkt-list" aria-label="Packs">
          {filtered.map((l) => (
            <li key={l.packName} className="surface-card u-p-4 mkt-card">
              <div className="mkt-card-head">
                <PackageIcon size={18} />
                <div className="u-grid u-gap-1">
                  <span className="mkt-card-title">{l.packName}</span>
                  <span className="chip chip--muted">{l.category}</span>
                </div>
                <span className={`chip ${l.installed ? 'chip--success' : 'chip--muted'}`}>{l.installed ? 'Installed' : 'Not installed'}</span>
              </div>
              {l.description ? <p className="mkt-card-desc">{l.description}</p> : null}
              {l.requiredBy && l.requiredBy.length > 0 ? (
                <p className="u-text-muted mkt-card-meta">Required by: {l.requiredBy.join(', ')}</p>
              ) : null}
              <div className="action-bar">
                <button type="button" className="btn-ghost" onClick={() => setSelected(l.packName)}>Reviews</button>
                <button type="button" className="btn-primary" disabled={busy || l.installed} onClick={() => void install(l)}>
                  {l.installed ? 'Installed' : 'Install'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {selectedListing ? (
        <ReviewsPanel listing={selectedListing} onClose={() => setSelected(null)} />
      ) : null}
    </section>
  );
}

/** Org-scoped reviews for one pack: pick an org, see the aggregate + reviews, rate. */
function ReviewsPanel({ listing, onClose }: { listing: Listing; onClose: () => void }): JSX.Element {
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
      .catch((e) => { setReviews([]); setError(e instanceof Error ? e.message : 'Failed to load reviews.'); });
  }, [listing.packName]);

  useEffect(() => { if (orgId) load(orgId); }, [orgId, load]);

  const submit = useCallback(async () => {
    if (rating < 1) { toast.error('Pick a rating from 1 to 5.'); return; }
    setBusy(true);
    try {
      await postReview(orgId, listing.packName, { rating, ...(body.trim() ? { body: body.trim() } : {}) });
      setBody(''); setRating(0);
      load(orgId);
      toast.success('Review saved.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Review failed.');
    } finally { setBusy(false); }
  }, [orgId, listing.packName, rating, body, load]);

  const remove = useCallback(async (r: Review) => {
    try { await deleteReview(orgId, listing.packName, r.reviewId); load(orgId); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed.'); }
  }, [orgId, listing.packName, load]);

  const orgPicker = orgs && orgs.length > 1 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label="Organization">
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  return (
    <div className="surface-card u-p-4 u-grid u-gap-3" aria-label={`Reviews for ${listing.packName}`}>
      <div className="mkt-card-head">
        <div className="u-grid u-gap-1">
          <span className="mkt-card-title">Reviews — {listing.packName}</span>
          {summary && summary.average !== null ? (
            <span className="mkt-summary"><Stars value={summary.average} /> <span className="u-text-muted">{summary.average} ({summary.count})</span></span>
          ) : (
            <span className="u-text-muted">No reviews yet</span>
          )}
        </div>
        {orgPicker}
        <button type="button" className="btn-ghost" onClick={onClose} aria-label="Close reviews">Close</button>
      </div>

      {error ? <Notice variant="error">{error}</Notice> : null}

      <div className="surface-card u-p-3 surface-form u-grid u-gap-2">
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">Your rating</span>
          <Stars value={rating} onPick={setRating} label="Your rating" />
        </label>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">Comment (optional)</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder="What did you think of this pack?" />
        </label>
        <button type="button" className="btn-primary" disabled={busy || rating < 1} onClick={() => void submit()}>Submit review</button>
      </div>

      {reviews === null ? <Skeleton /> : reviews.length === 0 ? (
        <StateCard icon={<StarIcon />} title="No reviews yet" body="Be the first to rate this pack with the form above." />
      ) : (
        <ul className="u-grid u-gap-2 mkt-reviews">
          {reviews.map((r) => (
            <li key={r.reviewId} className="surface-card u-p-3 mkt-review">
              <div className="mkt-review-head">
                <Stars value={r.rating} />
                <span className="u-text-muted">{authorLabel(r.authorId)} · {when(r.createdAt)}</span>
                <button type="button" className="btn-ghost" onClick={() => void remove(r)} aria-label="Delete review"><TrashIcon /></button>
              </div>
              {r.body ? <p className="mkt-review-body">{r.body}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

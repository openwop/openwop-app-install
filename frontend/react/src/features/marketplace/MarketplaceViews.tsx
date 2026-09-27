/**
 * Marketplace pack Card + Row — the two cells of the §4.5 collection-view canon
 * (rule 11) for the Marketplace page. The Card fills a `.card-grid`; the Row
 * fills a `.surface-card.list-view`. Both derive their sub-line + chips from the
 * SAME helpers below, so the grid and list views never diverge. Composed from
 * existing primitives — no bespoke CSS. Preserves every card datum/action:
 * pack name, category chip, install-status chip, description sub-line,
 * "required by" note, and the Reviews + Install actions.
 */

import { Button } from '../../ui/Button.js';
import { useTranslation } from 'react-i18next';
import { formatCurrency } from '../../i18n/format.js';
import type { TFunction } from 'i18next';
import { PackageIcon } from '../../ui/icons/index.js';
import { useEffectiveAccess } from '../../client/useEffectiveAccess.js';
import type { Listing } from './marketplaceClient.js';
import { prettyPackName } from './packName.js';

/** The contextual one-liner from REAL fields — the pack description, else a
 *  no-description fallback. Shared by Card + Row. */
function listingSubLine(l: Listing, t: TFunction): string {
  return l.description || t('subNoDescription');
}

/**
 * MKT2-B2 — the status chip used to read "Not installed" whenever no registry
 * install marker was present, which is a false claim about every pack mounted
 * from the host checkout: the executor is loading and running them. `origin`
 * separates "we do not have it" from "it came bundled".
 */
function ListingChips({ l, t, wsDisabled, orderStatus }: { l: Listing; t: TFunction; wsDisabled: boolean; orderStatus?: 'pending' | 'failed' | undefined }): JSX.Element {
  return (
    <>
      <span className="chip chip--muted">{l.category}</span>
      {l.tombstoned ? (
        <span className="chip chip--danger">{t('removedFromHost')}</span>
      ) : (
        <span
          className={`chip ${l.installed ? 'chip--success' : l.origin === 'local' ? 'chip--accent' : 'chip--muted'}`}
          title={l.origin === 'local' && !l.installed ? t('bundledWhy') : undefined}
        >
          {l.installed ? t('installed') : l.origin === 'local' ? t('bundledChip') : t('notInstalled')}
        </span>
      )}
      {wsDisabled ? <span className="chip chip--warning">{t('hiddenInWorkspace')}</span> : null}
      <PricingChip l={l} t={t} orderStatus={orderStatus} />
    </>
  );
}

/** ADR 0385 P4 — paid-lane chip (price / external / purchased). MKT-UX-5 adds the
 *  pending/failed order states so a card is no longer identical between "checkout
 *  in flight", "payment failed" and "never tried". */
function PricingChip({ l, t, orderStatus }: { l: Listing; t: TFunction; orderStatus?: 'pending' | 'failed' | undefined }): JSX.Element | null {
  const p = l.pricing;
  if (!p) return null;
  if (p.purchased) return <span className="chip chip--success">{t('purchased')}</span>;
  // MKT-UX-5 — an in-flight or failed purchase for this pack, shown ONLY while not
  // yet purchased. Pending takes precedence over the bare price (the buyer already
  // acted); failed replaces it too, and Buy stays enabled below so they can retry.
  if (orderStatus === 'pending') return <span className="chip chip--warning">{t('paymentPending')}</span>;
  if (orderStatus === 'failed') return <span className="chip chip--danger">{t('paymentFailed')}</span>;
  if (p.lane === 'native-paid' && p.priceMajorUnits !== undefined) {
    return <span className="chip chip--accent">{formatCurrency(p.priceMajorUnits, p.currency ?? 'usd')}</span>;
  }
  if (p.lane === 'external-link') return <span className="chip chip--accent">{t('externallyPaid')}</span>;
  return null;
}

/**
 * Why a pack can't be removed from the host (ADR 0194 P4 protected classes), or
 * null when it is removable. Mirrors the backend's two 409 guards so the FE
 * pre-disables "Remove from host" instead of letting the click dead-end on a
 * 409: `core.openwop.*` is host substrate, and a feature-pinned pack (non-empty
 * `requiredBy`) is managed through its feature's toggle, never removed. The
 * backend stays the authority; this only spares the operator a doomed click. */
function removalBlockedReason(l: Listing, t: TFunction): string | null {
  if (l.packName.startsWith('core.openwop.')) return t('removeBlockedCore');
  if (l.requiredBy && l.requiredBy.length > 0) return t('removeBlockedPinned', { features: l.requiredBy.join(', ') });
  return null;
}

function ListingActions({
  l,
  busy,
  wsDisabled,
  curationUnknown,
  onReviews,
  onInstall,
  onToggleAvailability,
  onRemove,
  onRestore,
  onPurge,
  onPurchase,
  orderStatus,
}: {
  l: Listing;
  busy: boolean;
  /** True when the caller's workspace disabled this pack (ADR 0194 P3). */
  wsDisabled: boolean;
  /** Which packs are hidden could not be read — the availability control must not
   *  present a fabricated state as authoritative. */
  curationUnknown: boolean;
  onReviews: () => void;
  onInstall: () => void;
  onToggleAvailability: () => void;
  onRemove: () => void;
  onRestore: () => void;
  onPurge: () => void;
  onPurchase: () => void;
  orderStatus?: 'pending' | 'failed' | undefined;
}): JSX.Element {
  const { t } = useTranslation('marketplace');
  const removeBlocked = removalBlockedReason(l, t);
  // MPL-2 (review fold-in) — `purchasable` is a TENANT-level projection (lifecycle,
  // seller, region); `POST …/purchase/checkout` additionally requires the CALLER to
  // hold `workspace:write` (editor+). A viewer in a shared workspace was rendered
  // Buy and got the raw untranslated `Missing required scope: workspace:write` back
  // through `toast.error(e.message)`. The hook is MODULE-CACHED and shared, so a
  // grid of N cards still issues ONE `/access/effective` read — the rate-limit
  // fan-out rule. Presentation only; the route stays the authority.
  const canPurchase = useEffectiveAccess().scopes.includes('workspace:write');
  // ADR 0194 P4 — a removed pack shows only its recovery/final actions; the
  // workspace-availability + install controls return once restored.
  if (l.tombstoned) {
    return (
      <>
        <Button variant="quiet" disabled={busy} onClick={onRestore}>{t('restorePack')}</Button>
        {/* MKT-UX-11 — `variant="danger"`, the convention `ui/ConfirmDialog`
            names for irreversible actions. "Delete permanently" rendered
            `btn-ghost`, visually identical to the benign **Restore** sitting
            immediately beside it: danger was communicated only AFTER the click. */}
        <Button variant="danger" disabled={busy} onClick={onPurge} aria-label={t('purgeAria', { pack: l.packName })}>
          {t('purgePack')}
        </Button>
      </>
    );
  }
  return (
    <>
      <label className="u-iflex u-gap-2 u-items-center mkt-availability">
        <input
          type="checkbox"
          checked={!wsDisabled}
          disabled={busy || curationUnknown}
          onChange={onToggleAvailability}
          aria-label={t('availabilityAria', { pack: l.packName })}
        />
        <span>{curationUnknown ? t('availabilityUnknown') : t('availableInWorkspace')}</span>
      </label>
      <Button variant="quiet" onClick={onReviews}>{t('reviewsAction')}</Button>
      {/* MKT-UX-11 — host-wide removal, beside the benign **Reviews** quiet button. */}
      <Button
        variant="danger"
        disabled={busy || removeBlocked !== null}
        title={removeBlocked ?? undefined}
        onClick={onRemove}
        aria-label={t('removeAria', { pack: l.packName })}
      >
        {t('removePack')}
      </Button>
      {l.pricing?.lane === 'external-link' && l.pricing.externalPaymentUrl ? (
        <a className="btn-ghost" href={l.pricing.externalPaymentUrl} target="_blank" rel="noopener noreferrer">
          {t('openExternalPayment')}
        </a>
      ) : null}
      {l.pricing?.purchasable && canPurchase ? (
        // MKT-UX-5 — Buy is disabled while a purchase is PENDING (checkout done,
        // fulfilment webhook not yet in) so the buyer can't double-start it; a
        // FAILED order leaves Buy enabled so they can retry.
        <Button
          variant="primary"
          disabled={busy || orderStatus === 'pending'}
          title={orderStatus === 'pending' ? t('paymentPending') : undefined}
          onClick={onPurchase}
        >{t('buy')}</Button>
      ) : null}
      {/* MKT2-B2 — a `local` pack was never published to the registry, so
          `installPackFromRegistry`'s manifest fetch necessarily 404s. The action
          was enabled and could not succeed; say what is true instead. */}
      <Button
        variant="primary"
        disabled={busy || l.installed || l.origin === 'local'}
        title={l.origin === 'local' && !l.installed ? t('bundledWhy') : undefined}
        onClick={onInstall}
      >
        {l.installed ? t('installed') : l.origin === 'local' ? t('bundledTitle') : t('install')}
      </Button>
    </>
  );
}

export interface ListingCellProps {
  listing: Listing;
  busy: boolean;
  /** True when the caller's workspace disabled this pack (ADR 0194 P3). */
  wsDisabled: boolean;
  /** Which packs are hidden could not be read — the availability control must not
   *  present a fabricated state as authoritative. */
  curationUnknown: boolean;
  onReviews: () => void;
  onInstall: () => void;
  onToggleAvailability: () => void;
  onRemove: () => void;
  onRestore: () => void;
  onPurge: () => void;
  /** ADR 0385 P4 — start a native-paid purchase (only rendered when purchasable). */
  onPurchase: () => void;
  /** MKT-UX-5 — the caller's latest actionable order state for THIS pack, when it
   *  is not yet purchased: `pending` (checkout done, fulfilment webhook not yet in)
   *  or `failed`. Absent ⇒ never attempted (or already paid). Drives the payment
   *  chip + disabling Buy while a purchase is pending. */
  orderStatus?: 'pending' | 'failed' | undefined;
}

export function ListingCard({ listing: l, busy, wsDisabled, curationUnknown, onReviews, onInstall, onToggleAvailability, onRemove, onRestore, onPurge, onPurchase, orderStatus }: ListingCellProps): JSX.Element {
  const { t } = useTranslation('marketplace');
  return (
    <li className="surface-card u-p-4 mkt-card">
      <div className="mkt-card-head">
        <PackageIcon size={18} aria-hidden />
        <div className="u-grid u-gap-1">
          <span className="mkt-card-title">{prettyPackName(l.packName)}</span>
          <code className="mkt-pack-id u-text-sm u-text-muted">{l.packName}</code>
          <span className="chip chip--muted">{l.category}</span>
        </div>
        {l.tombstoned ? (
          <span className="chip chip--danger">{t('removedFromHost')}</span>
        ) : (
          <span
            className={`chip ${l.installed ? 'chip--success' : l.origin === 'local' ? 'chip--accent' : 'chip--muted'}`}
            title={l.origin === 'local' && !l.installed ? t('bundledWhy') : undefined}
          >{l.installed ? t('installed') : l.origin === 'local' ? t('bundledChip') : t('notInstalled')}</span>
        )}
        {wsDisabled ? <span className="chip chip--warning">{t('hiddenInWorkspace')}</span> : null}
        <PricingChip l={l} t={t} orderStatus={orderStatus} />
      </div>
      {l.description ? <p className="mkt-card-desc">{l.description}</p> : null}
      {l.requiredBy && l.requiredBy.length > 0 ? (
        <p className="u-text-muted mkt-card-meta">{t('requiredBy', { packs: l.requiredBy.join(', ') })}</p>
      ) : null}
      <div className="action-bar">
        <ListingActions l={l} busy={busy} wsDisabled={wsDisabled} curationUnknown={curationUnknown} onReviews={onReviews} onInstall={onInstall} onToggleAvailability={onToggleAvailability} onRemove={onRemove} onRestore={onRestore} onPurge={onPurge} onPurchase={onPurchase} orderStatus={orderStatus} />
      </div>
    </li>
  );
}

export function ListingRow({ listing: l, busy, wsDisabled, curationUnknown, onReviews, onInstall, onToggleAvailability, onRemove, onRestore, onPurge, onPurchase, orderStatus }: ListingCellProps): JSX.Element {
  const { t } = useTranslation('marketplace');
  return (
    <div className="list-row">
      <div className="list-row-id">
        <PackageIcon size={18} aria-hidden />
        <span className="list-row-name-wrap">
          <span className="list-row-name-line">
            <span className="list-row-name">{prettyPackName(l.packName)}</span>
            <code className="mkt-pack-id u-text-sm u-text-muted">{l.packName}</code>
          </span>
          <span className="list-row-sub">{listingSubLine(l, t)}</span>
        </span>
      </div>
      <div className="list-row-meta">
        <ListingChips l={l} t={t} wsDisabled={wsDisabled} orderStatus={orderStatus} />
        {l.requiredBy && l.requiredBy.length > 0 ? (
          <span>{t('requiredBy', { packs: l.requiredBy.join(', ') })}</span>
        ) : null}
      </div>
      <div className="list-row-actions action-bar">
        <ListingActions l={l} busy={busy} wsDisabled={wsDisabled} curationUnknown={curationUnknown} onReviews={onReviews} onInstall={onInstall} onToggleAvailability={onToggleAvailability} onRemove={onRemove} onRestore={onRestore} onPurge={onPurge} onPurchase={onPurchase} orderStatus={orderStatus} />
      </div>
    </div>
  );
}

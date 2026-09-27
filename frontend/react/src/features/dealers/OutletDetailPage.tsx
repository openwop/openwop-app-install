/**
 * Outlet detail — `/dealers/outlets/:outletId?org=<orgId>` (ADR 0281 changelog
 * P6). The landing target for a sales-map outlet-pin click (the ADR 0282 P5
 * deep-link deferral): one store location with its status, address, coordinates,
 * and the owning dealer (linking back into the `/dealers` master/detail via the
 * existing `?dealer=` deep-link). Mirrors the OrderDetailPage deep-link shape
 * (ADR 0336): target derived from `:outletId` + `?org=`, a missing org fails
 * closed to not-found WITHOUT a fetch, 404s render not-found (no existence
 * leak), and the feature gate is checked before any request.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState, type JSX } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { MapPinIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { formatNumber } from '../../i18n/format.js';
import { getOutlet, getDealer, updateOutlet, DealersApiError, type Outlet, type Dealer } from './dealersClient.js';
import { TextField } from '../../ui/Field.js';
import { toast } from '../../ui/toast.js';

const coord = (n: number): string => formatNumber(n, { maximumFractionDigits: 4 });

export function OutletDetailPage(): JSX.Element {
  const { t } = useTranslation('dealers');
  const access = useFeatureAccess('dealers');
  const { outletId = '' } = useParams();
  const [search] = useSearchParams();
  const orgId = search.get('org') ?? '';

  const [outlet, setOutlet] = useState<Outlet | null>(null);
  const [dealer, setDealer] = useState<Dealer | null>(null);
  const [dealerFailed, setDealerFailed] = useState(false);
  // Both-or-neither and range-checked, the same rule the create form applies — one
  // coordinate is not a place, and half a pin cannot be drawn.
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [saving, setSaving] = useState(false);
  const outOfRange = (v: string, max: number): boolean => {
    if (v.trim() === '') return false;
    const n = Number(v);
    return !Number.isFinite(n) || Math.abs(n) > max;
  };
  const badLat = outOfRange(lat, 90);
  const badLng = outOfRange(lng, 180);
  const half = (lat.trim() === '') !== (lng.trim() === '');
  const saveCoords = async (): Promise<void> => {
    if (badLat || badLng || half || !outletId) return;
    setSaving(true);
    try {
      const empty = lat.trim() === '' && lng.trim() === '';
      await updateOutlet(orgId, outletId, empty ? { lat: null, lng: null } : { lat: Number(lat), lng: Number(lng) });
      toast.success(t('coordinatesSavedToast'));
      load();
    } catch (e) { toast.error(e instanceof Error ? e.message : t('coordinatesSaveFailed')); } finally { setSaving(false); }
  };
  const [state, setState] = useState<'loading' | 'ready' | 'notfound' | 'error'>('loading');

  const load = useCallback(() => {
    if (!orgId || !outletId) { setState('notfound'); return; }
    setState('loading');
    void getOutlet(orgId, outletId)
      .then((o) => {
        setOutlet(o);
        setState('ready');
        // Owning dealer is enrichment — its failure never blocks the outlet. But
        // DLR-G3: falling back to the bare id gave no way to tell "the dealer
        // lookup failed" from "this is just how we show it", so the reader could
        // not know whether to retry.
        setDealerFailed(false);
        void getDealer(orgId, o.dealerId)
          .then((d) => { setDealer(d); setDealerFailed(false); })
          .catch(() => { setDealer(null); setDealerFailed(true); });
      })
      .catch((e) => setState(e instanceof DealersApiError && e.status === 404 ? 'notfound' : 'error'));
  }, [orgId, outletId]);

  // Don't fetch behind a closed gate — the access check is otherwise render-only.
  useEffect(() => { if (access.enabled) load(); }, [load, access.enabled]);
  // Prefill from the loaded row, so the form EDITS the outlet instead of silently
  // proposing to blank it — and so re-saving after a reload is not a destructive no-op.
  useEffect(() => {
    setLat(typeof outlet?.lat === 'number' ? String(outlet.lat) : '');
    setLng(typeof outlet?.lng === 'number' ? String(outlet.lng) : '');
  }, [outlet]);

  const backLink = (
    <Link className="inline-link u-text-sm" to={`/dealers${orgId ? `?org=${encodeURIComponent(orgId)}` : ''}`}>
      ← {t('backToDealers')}
    </Link>
  );

  if (access.loading) return <section className="u-grid u-gap-4"><PageHeader title={t('outletDetailTitle')} /><Skeleton /></section>;
  if (!access.enabled) return <section className="u-grid u-gap-4"><PageHeader title={t('outletDetailTitle')} /><StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} /></section>;

  return (
    <section className="u-grid u-gap-4">
      <PageHeader title={t('outletDetailTitle')} actions={backLink} />
      {state === 'loading' ? <Skeleton /> : state === 'notfound' ? (
        <StateCard icon={<MapPinIcon />} title={t('outletNotFoundTitle')} body={t('outletNotFoundBody')} action={backLink} />
      ) : state === 'error' || !outlet ? (
        <StateCard announce title={t('loadErrorTitle')} body={t('loadErrorBody')} action={<Button variant="primary" size="sm" onClick={load}>{t('retryButton')}</Button>} />
      ) : (
        <div className="surface-card u-p-4 u-grid u-gap-3">
          <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
            <h2 className="u-m-0">{outlet.name}</h2>
            <StatusBadge status={outlet.status === 'active' ? 'active' : 'cancelled'} label={outlet.status === 'active' ? t('statusActive') : t('statusClosed')} />
          </div>
          <dl className="u-grid u-gap-1 u-m-0 u-text-sm">
            {outlet.address ? (
              <div className="action-bar u-justify-between u-gap-2"><dt className="muted">{t('outletAddressTerm')}</dt><dd className="u-m-0">{outlet.address}</dd></div>
            ) : null}
            <div className="action-bar u-justify-between u-gap-2">
              <dt className="muted">{t('coordinatesTerm')}</dt>
              <dd className="u-m-0 tabular-nums">
                {typeof outlet.lat === 'number' && typeof outlet.lng === 'number'
                  ? <>{coord(outlet.lat)}, {coord(outlet.lng)}</>
                  : <span className="muted">{t('coordinatesMissing')}</span>}
              </dd>
            </div>
            <div className="action-bar u-justify-between u-gap-2">
              <dt className="muted">{t('dealerTerm')}</dt>
              <dd className="u-m-0">
                {dealer ? (
                  <Link className="inline-link" to={`/dealers?org=${encodeURIComponent(orgId)}&dealer=${encodeURIComponent(dealer.dealerId)}`}>{dealer.name}</Link>
                ) : (
                  <span className="u-flex u-items-center u-gap-2 u-flex-wrap">
                    <code className="u-text-sm">{outlet.dealerId}</code>
                    {dealerFailed ? <span className="u-text-sm muted">{t('dealerNameUnavailable')}</span> : null}
                  </span>
                )}
              </dd>
            </div>
          </dl>

          {/* R2 review B3 — the editor the coordinate capture was missing. Without it the
              fix reached only outlets created after it shipped, while the sales map's
              "N outlets are not on the map" line is ABOUT the ones that already exist. */}
          <form
            className="u-flex u-gap-2 u-items-end u-flex-wrap"
            onSubmit={(e) => { e.preventDefault(); void saveCoords(); }}
          >
            <TextField
              label={t('outletLatLabel')} value={lat} inputMode="decimal"
              onChange={(e) => setLat(e.target.value)} placeholder={t('outletLatPlaceholder')}
              error={badLat ? t('outletLatError') : half && lat.trim() === '' ? t('outletGeoPairError') : undefined}
            />
            <TextField
              label={t('outletLngLabel')} value={lng} inputMode="decimal"
              onChange={(e) => setLng(e.target.value)} placeholder={t('outletLngPlaceholder')}
              error={badLng ? t('outletLngError') : half && lng.trim() === '' ? t('outletGeoPairError') : undefined}
            />
            <Button type="submit" variant="primary" disabled={saving || badLat || badLng || half}>{t('saveCoordinatesButton')}</Button>
          </form>
        </div>
      )}
    </section>
  );
}

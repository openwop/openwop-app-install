/**
 * Dynamic Sales Maps — the demo/standalone page (ADR 0282 P1).
 *
 * Composes the ACTIVE territory model's attainment (ADR 0272) onto the vendored
 * Natural Earth country boundaries as a choropleth: each country is coloured by the
 * rolled `won` of the territory whose NAME (or alias — NAME_LONG/ISO codes) matches
 * it (a territory→region mapping field remains the follow-up for ambiguous names,
 * ADR §8). The MapView carries the mandatory data-table
 * fallback. Outlet/dealer PINS + geocoding land in P2. Built on the shared ui/.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Panel } from '../../ui/layout.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { SelectField } from '../../ui/Field.js';
import { GlobeIcon } from '../../ui/icons/index.js';
import { formatNumber } from '../../i18n/format.js';
import { listOrgs, type Org } from '../crm/crmOrgClient.js';
import { listModels, getAttainment, type TerritoryAttainment } from '../territories/territoriesClient.js';
import { DealersApiError, listAllOutlets, type Outlet } from '../dealers/dealersClient.js';
import { MapView, type MapRegion, type MapPoint } from './MapView.js';
import { resolveRegionId, WORLD_REGIONS, regionValues } from './boundaries.js';

export function SalesMapsPage(): JSX.Element {
  const { t } = useTranslation('sales-maps');
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [orgErr, setOrgErr] = useState<string | null>(null);

  useEffect(() => {
    listOrgs().then((o) => { setOrgs(o); const [first] = o; if (first) setOrgId((cur) => cur || first.orgId); }).catch((e) => setOrgErr(e instanceof Error ? e.message : t('loadOrgsError')));
  }, [t]);

  return (
    <div className="u-flex-col u-gap-4" data-walkthrough="sales-map.page">
      <PageHeader title={t('title')} lede={t('lede')} />
      {orgErr ? <Notice variant="error">{orgErr}</Notice> : null}
      {orgs === null ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard icon={<GlobeIcon />} title={t('noOrgsTitle')} body={t('noOrgsBody')} />
      ) : (
        <>
          <Panel className="surface-card">
            <SelectField label={t('orgLabel')} value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
            </SelectField>
          </Panel>
          {orgId ? <MapForOrg orgId={orgId} /> : null}
        </>
      )}
    </div>
  );
}

function MapForOrg({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('sales-maps');
  const navigate = useNavigate();
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; territories: TerritoryAttainment[]; noModel: boolean }>({ status: 'loading' });
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [outletsFailed, setOutletsFailed] = useState(false);

  // R3 F10 — a request-ignore token on BOTH fetches: an org switch mid-flight
  // used to let org A's slower answer land under org B's header (pins and
  // attainment alike — the standard stale-write family).
  const seqRef = useRef(0);
  const load = useCallback(() => {
    const seq = ++seqRef.current;
    setState({ status: 'loading' });
    listModels(orgId).then(async ({ activeModelId }) => {
      if (seq !== seqRef.current) return;
      if (!activeModelId) { setState({ status: 'ok', territories: [], noModel: true }); return; }
      const { territories } = await getAttainment(orgId, activeModelId);
      if (seq !== seqRef.current) return;
      setState({ status: 'ok', territories, noModel: false });
    }).catch((e) => { if (seq === seqRef.current) setState({ status: 'error', message: e instanceof Error ? e.message : t('loadAttainmentError') }); });
    // Outlet pins compose the Dealers feature (ADR 0281). If it's off, the map is
    // just the choropleth — degrade quietly to no pins.
    // SM-R2-1 — Dealers OFF (404) degrades quietly to no pins (the comment
    // above is right about that case); a REAL failure must not render the
    // same empty map as "no outlets anywhere".
    setOutletsFailed(false);
    listAllOutlets(orgId)
      .then((o) => { if (seq === seqRef.current) setOutlets(o); })
      .catch((e) => { if (seq !== seqRef.current) return; setOutlets([]); if (!(e instanceof DealersApiError && e.status === 404)) setOutletsFailed(true); });
  }, [orgId, t]);
  useEffect(load, [load]);

  if (state.status === 'loading') return <Skeleton />;
  if (state.status === 'error') return <Notice variant="error">{state.message}</Notice>;
  if (state.noModel) return <StateCard icon={<GlobeIcon />} title={t('noModelTitle')} body={t('noModelBody')} />;

  // Colour countries by territory: an explicit regionId mapping (ADR 0282 §8)
  // wins; unmapped territories fall back to name/alias matching.
  const wonByRegion = regionValues(state.territories.map((terr) => ({ name: terr.name, ...(terr.regionId ? { regionId: terr.regionId } : {}), value: terr.rolled.won })));
  // SM-G1 — this took the FIRST territory that happened to carry a currency and
  // labelled EVERY country's money with it. `currency` is per-territory and
  // optional, so a model spanning EUR and GBP territories had the whole map
  // stamped with whichever came first in the array — not a neutral default but
  // an arbitrary pick from the data. Resolve the distinct set instead: exactly
  // one ⇒ use it; more than one ⇒ label nothing and say why (there is no FX
  // here, so the figures are not in any single currency anyway); none ⇒
  // unlabelled, exactly as before.
  // R2 SM2-F1/F2 — round 1 resolved the WRONG population. `TerritoryAttainment.currency`
  // is the QUOTA's authored currency, while the figure plotted here is `rolled.won` — a
  // sum of raw deal amounts that never consults each deal's currency. Two consequences
  // it got wrong:
  //   • a territory whose quota is USD but whose deals are EUR was labelled `$`;
  //   • a territory with NO quota carries no currency at all, so it never entered the
  //     set — one EUR quota anywhere denominated all 176 countries.
  // And `currencyMixed` — the flag the SAME row carries, meaning "the deals behind this
  // total span more than one currency" — was never read, though the sibling Territories
  // console reads it on the identical row and withholds the symbol.
  // TER2 review B1 — this page plots `rolled.won`, and `terr.currency` is the QUOTA's
  // currency. The docblock above says exactly that and then resolved the symbol from
  // the quota anyway, so the territories round-2 fix — which added `valueCurrency` (what
  // the SUMS are in) and `quotaCurrencyMismatch` — was INERT here: the very example that
  // pass was written for, ¥12,000,000 of JPY deals against a USD quota, still rendered
  // as $12,000,000 on this map, with the ramp drawn. The set is now built from the field
  // that denominates the number being plotted.
  const anyMixed = state.territories.some((terr) => terr.currencyMixed || terr.quotaCurrencyMismatch || terr.quotaCurrencyMixed);
  const contributing = state.territories.filter((terr) => terr.rolled.won !== 0);
  const currencies = new Set(contributing.map((terr) => terr.valueCurrency).filter((c): c is string => !!c));
  // Review B2 — "we cannot tell" is NOT "they disagree", and conflating them made an
  // ordinary model both lie and lose its ramp. A quota's currency is optional (the
  // Territories form ships an explicit "no currency" option, blank by default) and a
  // hierarchy ROOT normally carries no quota at all — so `some(t => !t.currency)` is the
  // DEFAULT state of a real model, not an edge case. It was firing "this model's
  // territories use more than one currency" at models using exactly one, and flattening
  // the choropleth for most of them. The sibling campaign-intel page keeps the two
  // apart for exactly this reason.
  const currencyMixed = currencies.size > 1 || anyMixed;                 // a claim about currencies
  // A contributing territory whose deals carry no currency is a genuine "we cannot
  // tell" — the symbol is withheld, the ramp survives. (Territories with no won money
  // cannot make the plotted total ambiguous, so they are not evidence either way.)
  const currencyUnknown = currencies.size === 0 || contributing.some((terr) => !terr.valueCurrency);
  const currency = !currencyMixed && !currencyUnknown && currencies.size === 1 ? [...currencies][0] : undefined;
  // Only a genuine DISAGREEMENT makes the magnitude ramp dishonest. Not knowing the
  // currency means we withhold the symbol, not that the numbers stop being comparable.
  const comparableValues = !currencyMixed;
  const regions: MapRegion[] = WORLD_REGIONS.map((r) => {
    const won = wonByRegion.get(r.id);
    return { id: r.id, name: r.name, geometry: r.geometry, ...(won !== undefined ? { value: won } : {}) };
  });
  const matched = regions.filter((r) => r.value !== undefined).length;
  const money = (n: number): string => (currency ? formatNumber(n, { style: 'currency', currency, maximumFractionDigits: 0 }) : formatNumber(n, { maximumFractionDigits: 0 }));
  // Outlet pins — only those with coordinates (P2 geocoding fills in the rest).
  const plottable = outlets.filter((o) => typeof o.lat === 'number' && typeof o.lng === 'number');
  // SM-G2 — outlets without coordinates are dropped, and on a MAP an absent pin
  // reads as "no presence there". A network of 50 outlets with 3 geocoded showed
  // "3 outlets plotted" and nothing about the other 47.
  const unplottable = outlets.length - plottable.length;
  // R2 SM2-F5 — SM-G2's exact shape at the sibling call site: `matched` counts REGIONS
  // that got coloured, never TERRITORIES that failed to place. Real models are named
  // "EMEA", "West Coast", "Enterprise" — none of which match a country — so ten
  // territories' revenue could be absent from both the map and the table with nothing
  // said, which is the impression SM-G2 exists to prevent.
  // Review B3 — this must mirror what the MATCHER does, or the disclosure is wrong in
  // both directions. `matchValuesToRegions` matches the canonical name OR any alias, on
  // a trimmed+lowercased key — so a territory named "USA" (the exact example the page's
  // own copy tells the user to use) was shaded on the map AND reported as "not shown".
  // Review M1 — and a rolled-up PARENT whose children are placed has its revenue on the
  // map already (that is F8's double-shading); calling it unshown is a second falsehood.
  const parentIds = new Set(state.territories.map((terr) => terr.parentTerritoryId).filter(Boolean));
  const unplacedTerritories = state.territories.filter(
    (terr) => !parentIds.has(terr.territoryId) && resolveRegionId(terr) === undefined,
  ).length;
  const points: MapPoint[] = plottable.map((o) => ({ id: o.outletId, lat: o.lat as number, lng: o.lng as number, label: o.name, kind: 'outlet' as const, ...(o.address ? { sublabel: o.address } : {}) }));

  return (
    <Panel className="surface-card u-flex-col u-gap-3">
      <h2 className="u-mb-0">{points.length > 0 ? t('attainmentHeadingWithOutlets') : t('attainmentHeading')}</h2>
      {/* SM-R2-1 — announce required: a conditionally-rendered region arrives
          complete, so its live region never fires on its own. */}
      {outletsFailed ? <Notice variant="warning" announce={t('outletsUnavailable')}>{t('outletsUnavailable')}</Notice> : null}
      <p className="u-text-muted u-mt-0 u-text-sm">
        {t('regionsShaded')}{' '}
        {matched === 0 ? t('matchNone') : t('matchSome', { matched, total: WORLD_REGIONS.length })}
        {points.length > 0 ? ` ${t('outletsPlotted', { count: points.length })}` : ''}
        {unplottable > 0 ? ` ${t('outletsUnplotted', { count: unplottable })}` : ''}
        {/* R2 SM2-F5 — territories the map could not place are revenue absent from BOTH
            the map and the a11y table. Said only when non-zero, the same rule SM-G2 uses. */}
        {unplacedTerritories > 0 ? ` ${t('territoriesUnplaced', { count: unplacedTerritories })}` : ''} {t('boundariesNote')}
      </p>
      {currencyMixed ? <Notice variant="info">{t('currencyMixedNote')}</Notice> : null}
      <MapView
        regions={regions}
        points={points}
        valueLabel={t('wonRevenue')}
        formatValue={money}
        comparable={comparableValues}
        caption={t('tableCaption')}
        emptyMessage={t('emptyMessage')}
        onPointClick={(outletId) => navigate(`/dealers/outlets/${encodeURIComponent(outletId)}?org=${encodeURIComponent(orgId)}`)}
      />
    </Panel>
  );
}

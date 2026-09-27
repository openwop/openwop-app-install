/**
 * Dealer Network — admin surface (ADR 0281 P4/P5). One cohesive page: pick an org,
 * manage the dealer directory (each referencing a CRM company + tier), manage a
 * dealer's retail outlets, issue the partner-portal link, and review deal
 * registrations (approve/reject). Outlets render as a LIST here — the map view
 * composes the Sales Maps feature (ADR 0282) when enabled; the list is the
 * designed fallback. Built entirely on the shared ui/ design system.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Panel } from '../../ui/layout.js';
import { StateCard } from '../../ui/StateCard.js';
import { DeepLinkMissNotice, isDeepLinkMiss } from '../../ui/DeepLinkMissNotice.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { Notice } from '../../ui/Notice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { toast } from '../../ui/toast.js';
import { BuildingIcon } from '../../ui/icons/index.js';
import {
  listOrgs, type Org, listCompanies, type Company,
  listDealers, createDealer, updateDealer, deleteDealer, type Dealer,
  listOutlets, createOutlet, deleteOutlet, type Outlet,
  mintPortalToken, listRegistrations, type DealRegistration,
} from './dealersClient.js';

const dealerTone = (s: Dealer['status']): string => (s === 'active' ? 'active' : 'cancelled');
const regTone = (s: DealRegistration['status']): { status: string; labelKey: string } =>
  s === 'approved' ? { status: 'success', labelKey: 'regApproved' } : s === 'rejected' ? { status: 'failed', labelKey: 'regRejected' } : { status: 'pending', labelKey: 'regPending' };

export function DealersPage(): JSX.Element {
  const { t } = useTranslation('dealers');
  const [searchParams, setSearchParams] = useSearchParams();
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  // Deep-link spine (Phase 3): store rides `?org=` (one-shot, validated); org
  // switch clears the stale `?dealer=` selection.
  const [orgId, setOrgId] = useState(() => searchParams.get('org') ?? '');
  const [orgErr, setOrgErr] = useState<string | null>(null);
  const selectOrg = useCallback((id: string) => {
    setOrgId(id);
    setSearchParams((p) => { const n = new URLSearchParams(p); n.set('org', id); n.delete('dealer'); return n; }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => (cur && o.some((x) => x.orgId === cur)) ? cur : (o[0]?.orgId ?? '')); }).catch((e) => setOrgErr(e instanceof Error ? e.message : t('loadOrgsError')));
  }, [t]);

  return (
    <div className="u-flex-col u-gap-4" data-walkthrough="dealers.page">
      <PageHeader title={t('title')} lede={t('lede')} />
      {orgErr ? <Notice variant="error">{orgErr}</Notice> : null}
      {orgs === null ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard icon={<BuildingIcon />} title={t('noOrgsTitle')} body={t('noOrgsBody')} />
      ) : (
        <>
          <Panel className="surface-card">
            <SelectField label={t('orgLabel')} value={orgId} onChange={(e) => selectOrg(e.target.value)}>
              {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
            </SelectField>
          </Panel>
          {orgId ? <DealersForOrg orgId={orgId} /> : null}
        </>
      )}
    </div>
  );
}

function DealersForOrg({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('dealers');
  const [dealers, setDealers] = useState<Dealer[] | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  // DLR-G2 — a FAILED companies read used to `setCompanies([])`, which renders
  // the select's "create a company first" option. That is an actively
  // misleading instruction: it tells the operator to create something that may
  // already exist, and disables the control that would have shown it.
  const [companiesFailed, setCompaniesFailed] = useState(false);
  // Deep-link spine (Phase 3): the URL owns the selected dealer (?dealer=).
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('dealer') ?? '';
  const setSelectedId = useCallback((id: string) => {
    setSearchParams((prev) => { const n = new URLSearchParams(prev); if (id) n.set('dealer', id); else n.delete('dealer'); return n; }, { replace: true });
  }, [setSearchParams]);
  const [err, setErr] = useState<string | null>(null);
  const [dealersFailed, setDealersFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setErr(null);
    // R2 DLR2-M2 — the catch set an error banner and left `dealers === null`, so the
    // panel below shimmered forever: a skeleton is "still loading", which is a claim,
    // and it was false. Note it does NOT become `[]` — that is the failure-as-empty
    // defect round 1 closed for the two reads one level down; this is the third read,
    // the one those two hang off, and it never got the same treatment (nor a retry).
    setDealersFailed(false);
    listDealers(orgId)
      .then((d) => { setDealers(d); setDealersFailed(false); })
      .catch((e) => { setDealersFailed(true); setErr(e instanceof Error ? e.message : t('loadDealersError')); });
    listCompanies(orgId)
      .then((c) => { setCompanies(c); setCompaniesFailed(false); })
      .catch(() => { setCompanies([]); setCompaniesFailed(true); });
  }, [orgId, t]);
  useEffect(load, [load]);

  const selected = useMemo(() => dealers?.find((d) => d.dealerId === selectedId), [dealers, selectedId]);

  return (
    <div className="u-grid u-grid-2 u-gap-4 u-items-start">
      {err ? <Notice variant="error">{err}</Notice> : null}
      <DeepLinkMissNotice show={isDeepLinkMiss(selectedId, dealers !== null, selected)} onClear={() => setSelectedId('')} />
      <DirectoryPanel orgId={orgId} dealers={dealers} companies={companies} companiesFailed={companiesFailed} dealersFailed={dealersFailed} selectedId={selectedId} setSelectedId={setSelectedId} busy={busy} setBusy={setBusy} onChange={load} />
      {selected ? <DealerDetail key={selected.dealerId} orgId={orgId} dealer={selected} busy={busy} setBusy={setBusy} onDealerChange={load} />
        : <StateCard icon={<BuildingIcon />} title={t('selectDealerTitle')} body={t('selectDealerBody')} />}
    </div>
  );
}

function DirectoryPanel({ orgId, dealers, companies, companiesFailed, dealersFailed, selectedId, setSelectedId, busy, setBusy, onChange }: {
  orgId: string; dealers: Dealer[] | null; companies: Company[];
  /** DLR-G2 — whether the companies READ failed, so an empty list is not
   *  mistaken for "there are none" and turned into a "create one first" nudge. */
  companiesFailed: boolean;
  /** R2 DLR2-M2 — whether the DEALERS read failed, so the panel shows a retry
   *  instead of a skeleton that claims to still be loading. */
  dealersFailed: boolean;
  selectedId: string; setSelectedId: (id: string) => void; busy: boolean; setBusy: (b: boolean) => void; onChange: () => void;
}): JSX.Element {
  const { t } = useTranslation('dealers');
  const [name, setName] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [tier, setTier] = useState('');
  // §4.5 collection search (DESIGN.md rule 13) — name/tier match; view-only,
  // the selection resolves against the full directory.
  const [query, setQuery] = useState('');
  const visibleDealers = (dealers ?? []).filter((d) =>
    !query.trim() || `${d.name} ${d.tier}`.toLowerCase().includes(query.trim().toLowerCase()));
  const companyName = useMemo(() => new Map(companies.map((c) => [c.companyId, c.name])), [companies]);
  useEffect(() => { const [first] = companies; if (!companyId && first) setCompanyId(first.companyId); }, [companies, companyId]);

  const create = async (): Promise<void> => {
    if (!name.trim() || !companyId) { toast.error(t('nameAndCompanyRequired')); return; }
    setBusy(true);
    try { await createDealer(orgId, { name: name.trim(), companyId, tier: tier.trim() }); toast.success(t('dealerCreatedToast')); setName(''); setTier(''); onChange(); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('createFailed')); } finally { setBusy(false); }
  };

  return (
    <Panel className="surface-card u-flex-col u-gap-3">
      <h2 className="u-mb-0">{t('dealersHeading')}</h2>
      <p className="u-text-muted u-mt-0">{t('dealersIntro')}</p>
      {dealers && dealers.length > 3 ? (
        <input
          type="search"
          className="ui-input filterbar-search"
          placeholder={t('filterPlaceholder')}
          aria-label={t('filterAria')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      ) : null}
      {dealersFailed ? (
        /* Review I6 — `StateCard`'s prop doc: "Set it on FAILED-READ states." Without
           it, AT heard only the raw client error string from the Notice above, while a
           sighted reader got the honest "this is a loading failure, not an empty
           directory". The sibling OutletDetailPage already does this. */
        <StateCard announce icon={<BuildingIcon />} title={t('dealersLoadFailedTitle')} body={t('dealersLoadFailedBody')} action={<Button variant="primary" onClick={onChange}>{t('retryButton')}</Button>} />
      ) : dealers === null ? <Skeleton /> : dealers.length === 0 ? (
        <p className="u-text-muted">{t('noDealersYet')}</p>
      ) : visibleDealers.length === 0 ? (
        <span className="u-flex u-items-center u-gap-2 u-text-sm u-text-muted">
          {t('noMatchBody')}
          <Button variant="quiet" size="sm" onClick={() => setQuery('')}>{t('clearSearch')}</Button>
        </span>
      ) : (
        <ul className="u-flex-col u-gap-1 u-list-none">
          {visibleDealers.map((d) => (
            <li key={d.dealerId}>
              <button type="button" className={`chip u-justify-between u-w-full${d.dealerId === selectedId ? ' is-selected' : ''}`} aria-pressed={d.dealerId === selectedId} onClick={() => setSelectedId(d.dealerId)}>
                <span>{d.name}{d.tier ? <span className="u-text-muted u-text-sm"> · {d.tier}</span> : null}</span>
                <StatusBadge status={dealerTone(d.status)} label={d.status === 'active' ? t('statusActive') : t('statusSuspended')} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <fieldset className="u-flex-col u-gap-2 u-fieldset-bare">
        <legend className="u-text-sm u-text-muted">{t('newDealerLegend')}</legend>
        <TextField label={t('nameLabel')} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
        <SelectField
          label={t('crmCompanyLabel')}
          value={companyId}
          onChange={(e) => setCompanyId(e.target.value)}
          disabled={companies.length === 0}
          {...(companiesFailed ? { error: t('companiesLoadFailed') } : {})}
        >
          {companies.length === 0
            ? <option value="">{companiesFailed ? t('companiesUnavailableOption') : t('createCompanyFirstOption')}</option>
            : companies.map((c) => <option key={c.companyId} value={c.companyId}>{companyName.get(c.companyId) ?? c.name}</option>)}
        </SelectField>
        <TextField label={t('tierLabel')} value={tier} onChange={(e) => setTier(e.target.value)} placeholder={t('tierPlaceholder')} />
        <div className="action-bar">
          <Button variant="primary" disabled={busy || !name.trim() || !companyId} onClick={() => void create()}>{t('addDealerButton')}</Button>
        </div>
      </fieldset>
    </Panel>
  );
}

function DealerDetail({ orgId, dealer, busy, setBusy, onDealerChange }: { orgId: string; dealer: Dealer; busy: boolean; setBusy: (b: boolean) => void; onDealerChange: () => void }): JSX.Element {
  const { t } = useTranslation('dealers');
  const [outlets, setOutlets] = useState<Outlet[] | null>(null);
  const [regs, setRegs] = useState<DealRegistration[] | null>(null);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const [outletsFailed, setOutletsFailed] = useState(false);
  const [regsFailed, setRegsFailed] = useState(false);
  const [oName, setOName] = useState('');
  const [oAddr, setOAddr] = useState('');
  // R2 DLR2-B5 — the outlet form sent name+address ONLY, and nothing in the product
  // ever produced a coordinate: the geocode route has no caller, and its provider path
  // fails loud without a BYOK Connection nobody can configure from here. So the sales
  // map — the feature that exists to plot these — showed zero pins for every real
  // tenant, and the honest "N outlets are not on the map" line it just shipped read
  // "all of them", forever. The backend has accepted `lat`/`lng` on create and PATCH
  // all along (`dealer.ts:165`), and the geocode service's MANUAL path needs no
  // provider. This is the missing wiring, not a missing capability.
  const [oLat, setOLat] = useState('');
  const [oLng, setOLng] = useState('');
  const geoNum = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));
  const geoInvalid = (v: string, max: number): boolean => {
    if (v.trim() === '') return false;
    const n = Number(v);
    return !Number.isFinite(n) || Math.abs(n) > max;
  };
  // Both or neither: one coordinate is not a location, and half a pin cannot be drawn.
  const geoHalf = (oLat.trim() === '') !== (oLng.trim() === '');
  const geoBad = geoInvalid(oLat, 90) || geoInvalid(oLng, 180) || geoHalf;

  const load = useCallback(() => {
    // DLR-G1 — both used to swallow the failure into `[]`, so "this dealer has no
    // outlets" and "we could not load its outlets" rendered the same sentence.
    // On a dealer-network console those are materially different statements.
    setOutletsFailed(false); setRegsFailed(false);
    listOutlets(orgId, dealer.dealerId).then((o) => { setOutlets(o); setOutletsFailed(false); }).catch(() => { setOutlets([]); setOutletsFailed(true); });
    listRegistrations(orgId, dealer.dealerId).then((r) => { setRegs(r); setRegsFailed(false); }).catch(() => { setRegs([]); setRegsFailed(true); });
  }, [orgId, dealer.dealerId]);
  useEffect(load, [load]);

  const addOutlet = async (): Promise<void> => {
    if (!oName.trim()) { toast.error(t('outletNameRequired')); return; }
    setBusy(true);
    try {
      const lat = geoNum(oLat); const lng = geoNum(oLng);
      await createOutlet(orgId, dealer.dealerId, {
        name: oName.trim(),
        ...(oAddr.trim() ? { address: oAddr.trim() } : {}),
        ...(lat !== undefined && lng !== undefined ? { lat, lng } : {}),
      });
      toast.success(t('outletAddedToast')); setOName(''); setOAddr(''); setOLat(''); setOLng(''); load();
    }
    catch (e) { toast.error(e instanceof Error ? e.message : t('addFailed')); } finally { setBusy(false); }
  };
  const removeOutlet = async (o: Outlet): Promise<void> => {
    setBusy(true);
    try { await deleteOutlet(orgId, o.outletId); toast.success(t('outletRemovedToast')); load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('removeFailed')); } finally { setBusy(false); }
  };
  const setStatus = async (status: 'active' | 'suspended'): Promise<void> => {
    setBusy(true);
    try {
      await updateDealer(orgId, dealer.dealerId, { status });
      toast.success(status === 'active' ? t('dealerReactivatedToast') : t('dealerSuspendedToast'));
      onDealerChange();
    } catch (e) { toast.error(e instanceof Error ? e.message : t('statusChangeFailed')); } finally { setBusy(false); }
  };
  const issuePortal = async (): Promise<void> => {
    setBusy(true);
    try { const { url } = await mintPortalToken(orgId, dealer.dealerId); setPortalUrl(url); toast.success(t('portalIssuedToast')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('portalIssueFailed')); } finally { setBusy(false); }
  };

  return (
    <div className="u-flex-col u-gap-4" data-walkthrough="dealers.page">
      <Panel className="surface-card u-flex-col u-gap-3">
        <h2 className="u-mb-0">{dealer.name}</h2>
        <div className="u-flex u-gap-2 u-items-center">
          <StatusBadge status={dealerTone(dealer.status)} label={dealer.status === 'active' ? t('statusActive') : t('statusSuspended')} />
          {dealer.tier ? <span className="chip chip--muted">{dealer.tier}</span> : null}
        </div>
        <div className="action-bar">
          {/* R2 DLR2-B4 — `suspendDealersForCompany` calls itself "non-destructive +
              REVERSIBLE" and the reversal had no caller anywhere in the product: the
              PATCH route and service existed, the client did not expose them, and no
              control rendered. A dealer suspended by a mistaken CRM company delete was
              stuck that way, escapable only by Delete + recreate — which cascades its
              outlets, its registrations and its live partner link. */}
          <Button variant="primary" disabled={busy} onClick={() => void setStatus(dealer.status === 'active' ? 'suspended' : 'active')}>
            {dealer.status === 'active' ? t('suspendDealerButton') : t('reactivateDealerButton')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void issuePortal()}>{t('issuePartnerLinkButton')}</Button>
        </div>
        {portalUrl ? <Notice variant="info">{t('portalLinkNotice')} <code className="u-break-all">{portalUrl}</code></Notice> : null}
      </Panel>

      {/* Outlets — a LIST (the map view composes ADR 0282 when the maps feature is on) */}
      <Panel className="surface-card u-flex-col u-gap-3">
        <h3 className="u-mb-0">{t('outletsHeading')}</h3>
        <p className="u-text-muted u-mt-0 u-text-sm">{t('outletsIntro')}</p>
        {outlets === null ? <Skeleton /> : outletsFailed ? (
          <Notice variant="warning" announce={t('outletsLoadFailed')}>{t('outletsLoadFailed')} <Button variant="link" onClick={load}>{t('retryButton')}</Button></Notice>
        ) : outlets.length === 0 ? <p className="u-text-muted">{t('noOutletsYet')}</p> : (
          <ul className="u-flex-col u-gap-1 u-list-none">
            {outlets.map((o) => (
              <li key={o.outletId} className="u-flex u-justify-between u-items-center u-gap-2">
                <span>{o.name}{o.address ? <span className="u-text-muted u-text-sm"> · {o.address}</span> : null}</span>
                <Button variant="primary" size="sm" className="u-text-danger" aria-label={t('removeOutletAria', { name: o.name })} disabled={busy} onClick={() => void removeOutlet(o)}>{t('removeButton')}</Button>
              </li>
            ))}
          </ul>
        )}
        <div className="u-flex u-gap-2 u-items-end">
          <TextField label={t('outletNameLabel')} value={oName} onChange={(e) => setOName(e.target.value)} placeholder={t('outletNamePlaceholder')} />
          <TextField label={t('outletAddressLabel')} value={oAddr} onChange={(e) => setOAddr(e.target.value)} />
          <TextField label={t('outletLatLabel')} value={oLat} onChange={(e) => setOLat(e.target.value)} inputMode="decimal" placeholder={t('outletLatPlaceholder')} error={geoInvalid(oLat, 90) ? t('outletLatError') : geoHalf && oLat.trim() === '' ? t('outletGeoPairError') : undefined} />
          <TextField label={t('outletLngLabel')} value={oLng} onChange={(e) => setOLng(e.target.value)} inputMode="decimal" placeholder={t('outletLngPlaceholder')} error={geoInvalid(oLng, 180) ? t('outletLngError') : geoHalf && oLng.trim() === '' ? t('outletGeoPairError') : undefined} />
          <Button variant="primary" disabled={busy || !oName.trim() || geoBad} onClick={() => void addOutlet()}>{t('addButton')}</Button>
        </div>
      </Panel>

      {/* Deal registrations */}
      <Panel className="surface-card u-flex-col u-gap-3">
        <h3 className="u-mb-0">{t('registrationsHeading')}</h3>
        {regs === null ? <Skeleton /> : regsFailed ? (
          <Notice variant="warning" announce={t('registrationsLoadFailed')}>{t('registrationsLoadFailed')} <Button variant="link" onClick={load}>{t('retryButton')}</Button></Notice>
        ) : regs.length === 0 ? <p className="u-text-muted">{t('noRegistrationsYet')}</p> : (
          <ul className="u-flex-col u-gap-2 u-list-none">
            {regs.map((r) => {
              const rt = regTone(r.status);
              return (
                <li key={r.regId} className="u-flex u-justify-between u-items-center u-gap-2">
                  <div className="u-flex-col">
                    <strong>{r.dealTitle}</strong>
                    <span className="u-text-muted u-text-sm">{r.companyName}</span>
                  </div>
                  <div className="u-flex u-gap-2 u-items-center">
                    <StatusBadge status={rt.status} label={t(rt.labelKey)} />
                    {/* CFP-1 (D9): the DECISION rides the shared Reviews inbox now
                        (host:dealers:manage), not a bespoke page button — a pending
                        registration shows its awaiting-review state here. */}
                    {/* R2 DLR2-B2 — this chip was derived from `status`, which is
                        `pending` whether or not the review card ever reached the inbox.
                        The queue write is best-effort by design (a public partner submit
                        must not 500 on a durable row), so "queued" was a guess that read
                        as a fact — and the ONLY decision path is that card, so a lost one
                        means the deal is never decided while every surface says it is
                        waiting. `queueFailed` is the row's own answer. */}
                    {r.status === 'pending' ? (
                      r.queueFailed
                        ? (
                          <span className="chip chip--warning">
                            {t('registrationNotQueuedChip')}
                            {/* Review I5 — this sentence lived in a `title=`, which is not the
                                accessible name of an element that already has text, is never
                                announced, and is unreachable by touch or keyboard. The chip
                                alone ("not sent for review") does not say what to do about it. */}
                            <span className="sr-only">{` — ${t('registrationNotQueuedTitle')}`}</span>
                          </span>
                        )
                        : <span className="chip chip--muted">{t('registrationInReviewHint')}</span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <div className="action-bar">
        <ConfirmDeleteDealer orgId={orgId} dealer={dealer} busy={busy} setBusy={setBusy} onDeleted={onDealerChange} />
      </div>
    </div>
  );
}

function ConfirmDeleteDealer({ orgId, dealer, busy, setBusy, onDeleted }: { orgId: string; dealer: Dealer; busy: boolean; setBusy: (b: boolean) => void; onDeleted: () => void }): JSX.Element {
  const { t } = useTranslation('dealers');
  const [open, setOpen] = useState(false);
  const remove = async (): Promise<void> => {
    setBusy(true);
    try { const { removed } = await deleteDealer(orgId, dealer.dealerId); toast.success(t('dealerDeletedToast', { count: removed })); onDeleted(); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); } finally { setBusy(false); setOpen(false); }
  };
  return (
    <>
      <Button variant="primary" className="u-text-danger" disabled={busy} onClick={() => setOpen(true)}>{t('deleteDealerButton')}</Button>
      {open ? <ConfirmDialog title={t('deleteDialogTitle')} body={t('deleteDialogBody', { name: dealer.name })} confirmLabel={t('deleteConfirmLabel')} danger busy={busy} onConfirm={() => void remove()} onCancel={() => setOpen(false)} /> : null}
    </>
  );
}

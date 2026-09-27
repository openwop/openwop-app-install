/**
 * Media Library (host-extension product feature — ADR 0007). Org-scoped asset
 * store: pick an org, browse/create collections, upload + search assets, delete.
 * ALWAYS-ON (ADR 0027 — the `media` toggle is retired; no useFeatureAccess gate:
 * an absent id resolves OFF and bricked fresh installs — /browser 2026-07-03); writes require workspace:write in the org
 * (the backend fail-closes — a viewer sees a 403 surfaced as a toast).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { confirm } from '../../ui/confirm.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { IconButton } from '../../ui/IconButton.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { toast } from '../../ui/toast.js';
import { ImageIcon, PackageIcon, PlusIcon, TrashIcon } from '../../ui/icons/index.js';
import { MediaAssetCard, MediaAssetRow } from './MediaViews.js';
import { AltTextDialog } from './AltTextDialog.js';
import { Modal } from '../../ui/Modal.js';
import {
  createCollection,
  deleteAsset,
  deleteCollection,
  listAssets,
  listAssetUsage,
  listCollections,
  listOrgs,
  uploadAsset,
  type MediaAsset,
  type MediaCollection,
  type MediaUsageRef,
  type Org,
} from './mediaClient.js';

const ALL = '__all__';
const UNCATEGORIZED = 'none'; // matches the backend ?collectionId sentinel (server-side filter)

export function MediaLibraryPage(): JSX.Element {
  const { t } = useTranslation('media');
  const [searchParams, setSearchParams] = useSearchParams();
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgsFailed, setOrgsFailed] = useState(false);
  // Deep-link spine (Phase 4): store rides ?org=; the collection filter rides
  // ?collection= (sentinels round-trip: absent → ALL, 'none' → uncategorized);
  // an open asset rides ?asset=. The URL owns all three.
  const [orgId, setOrgId] = useState<string>(() => searchParams.get('org') ?? '');
  const [collections, setCollections] = useState<MediaCollection[] | null>(null);
  const [collectionsFailed, setCollectionsFailed] = useState(false);
  const [assets, setAssets] = useState<MediaAsset[] | null>(null);
  // MED2-M4 (R3) — failure is its own state: the catch used to set `error` and
  // leave `assets` null, so the grid showed a PERMANENT skeleton under the
  // banner; and the banner itself outlived the failure (nothing cleared it on a
  // later successful search).
  const [assetsFailed, setAssetsFailed] = useState(false);
  const [q, setQ] = useState('');
  const [newCollection, setNewCollection] = useState('');
  const [busy, setBusy] = useState(false);
  const [usageRefs, setUsageRefs] = useState<MediaUsageRef[] | null>(null);
  const [usageFailed, setUsageFailed] = useState(false);
  const [altTextForId, setAltTextForId] = useState<string | null>(null); // ADR 0363 P1
  const altTextFor = useMemo(() => assets?.find((a) => a.assetId === altTextForId) ?? null, [assets, altTextForId]);

  const selectedParam = searchParams.get('collection');
  const selected = useMemo(() => {
    if (!selectedParam) return ALL;
    if (selectedParam === UNCATEGORIZED) return UNCATEGORIZED;
    if (collections === null) return selectedParam;
    return collections.some((c) => c.collectionId === selectedParam) ? selectedParam : ALL; // validity
  }, [selectedParam, collections]);
  /** The open REAL collection (ALL / UNCATEGORIZED are views, not entities), so
   *  its header can carry the name and the delete that used to sit on the rail. */
  const selectedCollection = useMemo(
    () => collections?.find((c) => c.collectionId === selected) ?? null,
    [collections, selected],
  );
  const assetParam = searchParams.get('asset');
  // The "used by" panel (ADR 0206 B4) is now URL-addressable — the open asset
  // derives from ?asset= (validity: a param naming no loaded asset reads closed).
  const usageFor = useMemo(() => assets?.find((a) => a.assetId === assetParam) ?? null, [assets, assetParam]);

  const selectOrg = useCallback((id: string) => {
    setOrgId(id);
    setSearchParams((p) => { const n = new URLSearchParams(p); n.set('org', id); n.delete('collection'); n.delete('asset'); return n; }, { replace: true });
  }, [setSearchParams]);
  const selectCollection = useCallback((sel: string) => {
    setSearchParams((p) => { const n = new URLSearchParams(p); if (sel && sel !== ALL) n.set('collection', sel); else n.delete('collection'); return n; }, { replace: true });
  }, [setSearchParams]);
  /** The rail cell's href — the SAME transition `selectCollection` performs, as
   *  a URL the browser can open in a new tab or copy (§4.5 rule 12). Derived
   *  from `searchParams` so the two can't drift apart. */
  const collectionHref = useCallback((sel: string): string => {
    const n = new URLSearchParams(searchParams);
    if (sel && sel !== ALL) n.set('collection', sel); else n.delete('collection');
    const q = n.toString();
    return q ? `?${q}` : '';
  }, [searchParams]);
  const showUsage = useCallback((id: string | null) => {
    setSearchParams((p) => { const n = new URLSearchParams(p); if (id) n.set('asset', id); else n.delete('asset'); return n; }, { replace: true });
  }, [setSearchParams]);
  const [viewMode, setViewMode] = useViewMode('media', 'grid');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const assetResultsRef = useRef<HTMLDivElement | null>(null);

  // Load orgs once the feature is enabled; default to the first (validated).
  const loadOrgs = useCallback(() => {
    setOrgs(null);
    setOrgsFailed(false);
    void listOrgs()
      .then((o) => {
        setOrgs(o);
        setOrgsFailed(false);
        setOrgId((cur) => (cur && o.some((x) => x.orgId === cur)) ? cur : (o[0]?.orgId ?? ''));
      })
      .catch(() => setOrgsFailed(true));
  }, []);
  useEffect(() => { loadOrgs(); }, [loadOrgs]);
  // Fetch the "used by" refs whenever the open asset changes (incl. a ?asset= deep link).
  useEffect(() => {
    if (!usageFor) { setUsageRefs(null); return; }
    setUsageRefs(null);
    setUsageFailed(false);
    // "Not used anywhere" is what a person checks BEFORE deleting an asset. A
    // failed read may not say it. (Delete has its own confirm, so unlike the CMS
    // shared-section case no guardrail was removed — but the answer was still
    // fabricated at exactly the moment it is relied on.)
    listAssetUsage(orgId, usageFor.assetId)
      .then((u) => { setUsageRefs(u); setUsageFailed(false); })
      .catch(() => { setUsageRefs(null); setUsageFailed(true); });
  }, [usageFor, orgId]);

  const loadAssets = useCallback(
    (org: string, sel: string, query: string) => {
      const filter: { collectionId?: string; q?: string } = {};
      if (sel !== ALL) filter.collectionId = sel; // sel may be UNCATEGORIZED ('none') — the backend filters server-side
      if (query.trim()) filter.q = query.trim();
      void listAssets(org, filter)
        .then((rows) => { setAssets(rows); setAssetsFailed(false); })
        .catch(() => { setAssetsFailed(true); });
    },
    [],
  );

  // Collections reload only when the ORG changes (selected/q are reset to ALL/''
  // by the org-select onChange, so this effect doesn't also touch them).
  useEffect(() => {
    if (!orgId) return;
    setCollections(null);
    setCollectionsFailed(false);
    void listCollections(orgId)
      .then((value) => { setCollections(value); setCollectionsFailed(false); })
      .catch(() => setCollectionsFailed(true));
  }, [orgId]);

  // The SINGLE asset-loading effect — keyed on org + filter + search. On an org
  // switch the select resets selected→ALL + q→'' in the same batch, so this
  // fires exactly once with the right args (no double-fetch).
  useEffect(() => {
    if (!orgId) return;
    setAssets(null);
    setAssetsFailed(false);
    loadAssets(orgId, selected, q);
  }, [orgId, selected, q, loadAssets]);

  const addCollection = useCallback(async () => {
    if (!newCollection.trim() || !orgId) return;
    setBusy(true);
    try {
      const c = await createCollection(orgId, newCollection.trim());
      setCollections((cur) => [...(cur ?? []), c]);
      setNewCollection('');
      toast.success(t('collectionCreated'));
    } catch {
      toast.error(t('createFailed'));
    } finally {
      setBusy(false);
    }
  }, [newCollection, orgId, t]);

  const removeCollection = useCallback(
    async (collectionId: string, name: string) => {
      if (!(await confirm({ title: t('deleteCollectionConfirm', { name }), danger: true, confirmLabel: t('common:delete') }))) return;
      try {
        await deleteCollection(orgId, collectionId);
        setCollections((cur) => cur?.filter((c) => c.collectionId !== collectionId) ?? cur);
        if (selected === collectionId) selectCollection(ALL);
        toast.info(t('collectionDeleted'));
      } catch {
        toast.error(t('deleteFailed'));
      }
    },
    [orgId, selected, selectCollection, t],
  );

  const onUpload = useCallback(
    async (file: File) => {
      setBusy(true);
      try {
        const collectionId = selected !== ALL && selected !== UNCATEGORIZED ? selected : undefined;
        await uploadAsset(orgId, file, collectionId);
        loadAssets(orgId, selected, q);
        toast.success(t('uploaded', { name: file.name }));
      } catch {
        toast.error(t('uploadFailed'));
      } finally {
        setBusy(false);
      }
    },
    [orgId, selected, q, loadAssets, t],
  );

  const removeAsset = useCallback(
    async (assetId: string, name: string) => {
      if (!(await confirm({ title: t('deleteAssetConfirm'), danger: true, confirmLabel: t('common:delete') }))) return;
      try {
        await deleteAsset(orgId, assetId);
        setAssets((cur) => (cur ? cur.filter((a) => a.assetId !== assetId) : cur));
        toast.info(t('assetDeleted', { name }));
        requestAnimationFrame(() => assetResultsRef.current?.focus());
      } catch {
        toast.error(t('deleteFailed'));
      }
    },
    [orgId, t],
  );


  const orgActions = (
    <select
      value={orgId}
      onChange={(e) => {
        selectOrg(e.target.value); // also clears ?collection= / ?asset= for the new org
        setQ('');
      }}
      className="u-w-auto"
      aria-label={t('orgPickerLabel')}
    >
      {(orgs ?? []).map((o) => (
        <option key={o.orgId} value={o.orgId}>{o.name}</option>
      ))}
    </select>
  );

  return (
    <div data-walkthrough="media.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={orgs && orgs.length > 0 ? orgActions : undefined} />

      {orgsFailed ? (
        <StateCard announce icon={<PackageIcon />} title={t('orgsFailedTitle')} body={t('orgsFailedBody')}
          action={<Button variant="secondary" onClick={loadOrgs}>{t('common:retry')}</Button>} />
      ) : !orgs ? (
        <Skeleton />
      ) : orgs.length === 0 ? (
        <StateCard icon={<PackageIcon />} title={t('noOrgsTitle')} body={t('noOrgsBody')} />
      ) : (
        <div className="media-layout">
          {/* Collections sidebar */}
          <div className="surface-card u-gap-2">
            <h2 className="u-fs-16 u-m-0">{t('collectionsHeading')}</h2>
            {[
              { id: ALL, name: t('allAssets') },
              { id: UNCATEGORIZED, name: t('uncategorized') },
            ].map((c) => (
              <Link key={c.id} to={collectionHref(c.id)} replace className={`${selected === c.id ? 'btn-accent' : 'btn-ghost'} u-justify-start`} aria-current={selected === c.id ? 'true' : undefined}>
                {c.name}
              </Link>
            ))}
            <div className="media-divider" />
            {/* §4.5 rule 12 — rail cells are real `<Link>`s (cmd-click, copy
                link address), and delete is NOT on the cell: it lives on the
                open collection's own header to the right, where it can't be hit
                by a slip aimed at the row you meant to open. */}
            {collectionsFailed ? (
              <StateCard announce icon={<PackageIcon />} title={t('collectionsFailedTitle')} body={t('collectionsFailedBody')}
                action={<Button variant="secondary" onClick={() => {
                  setCollections(null); setCollectionsFailed(false);
                  void listCollections(orgId).then((value) => setCollections(value)).catch(() => setCollectionsFailed(true));
                }}>{t('common:retry')}</Button>} />
            ) : collections === null ? <Skeleton height={48} /> : collections.map((c) => (
              <Link
                key={c.collectionId}
                to={collectionHref(c.collectionId)}
                replace
                className={`${selected === c.collectionId ? 'btn-accent' : 'btn-ghost'} u-justify-start`}
                aria-current={selected === c.collectionId ? 'true' : undefined}
              >
                <PackageIcon /> {c.name}
              </Link>
            ))}
            <div className="u-flex u-gap-1 u-mt-2">
              <input value={newCollection} onChange={(e) => setNewCollection(e.target.value)} placeholder={t('newCollectionPlaceholder')} aria-label={t('newCollectionPlaceholder')} disabled={collections === null || collectionsFailed} onKeyDown={(e) => { if (e.key === 'Enter') void addCollection(); }} />
              <IconButton label={t('newCollectionPlaceholder')} icon={<PlusIcon />} className="btn-ghost" disabled={busy || collections === null || collectionsFailed || !newCollection.trim()} onClick={() => void addCollection()} />
            </div>
          </div>

          {/* Assets */}
          <div className="u-grid u-gap-3">
            {/* The open collection's own header. Delete lives HERE (§4.5 rule
                12) — next to the thing it destroys and the name that says which
                one. The ALL / Uncategorized views are not entities, so they
                carry no header and nothing to delete. */}
            {selectedCollection ? (
              <div className="u-flex u-items-center u-gap-2 u-wrap">
                <h2 className="u-fs-16 u-m-0 u-flex-1">{selectedCollection.name}</h2>
                <Button variant="danger" onClick={() => void removeCollection(selectedCollection.collectionId, selectedCollection.name)}>
                  <TrashIcon size={14} /> {t('deleteCollectionLabel')}
                </Button>
              </div>
            ) : null}
            {/* Upload control — untouched (collection-management / upload surface). */}
            <div className="action-bar">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,application/json,.txt,.md,.csv"
                className="u-hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onUpload(f);
                  e.target.value = '';
                }}
              />
              <Button variant="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
                <ImageIcon /> {t('upload')}
              </Button>
            </div>

            {/* The ONE asset-list filterbar (search + the shared grid/list toggle). */}
            <div className="filterbar" role="group" aria-label={t('filterGroup')}>
              <input
                type="search"
                className="ui-input filterbar-search"
                placeholder={t('searchPlaceholder')}
                aria-label={t('filterAria')}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" />
            </div>

            <div ref={assetResultsRef} tabIndex={-1} role="region" aria-label={t('assetResultsLabel')}>
            {assetsFailed ? (
              <StateCard
                announce
                icon={<ImageIcon />}
                title={t('assetsFailedTitle')}
                body={t('assetsFailedBody')}
                action={<Button variant="secondary" onClick={() => { setAssets(null); setAssetsFailed(false); loadAssets(orgId, selected, q); }}>{t('common:retry')}</Button>}
              />
            ) : !assets ? (
              <Skeleton />
            ) : assets.length === 0 ? (
              q.trim() ? (
                <StateCard
                  icon={<ImageIcon />}
                  title={t('noMatchTitle')}
                  body={t('noMatchBody')}
                  action={<Button variant="secondary" onClick={() => setQ('')}>{t('clearSearch')}</Button>}
                />
              ) : (
                <StateCard icon={<ImageIcon />} title={t('noAssetsTitle')} body={t('noAssetsBody')} />
              )
            ) : viewMode === 'grid' ? (
              <div className="card-grid">
                {assets.map((a) => (
                  <MediaAssetCard key={a.assetId} asset={a} onDelete={() => void removeAsset(a.assetId, a.name)} onShowUsage={() => showUsage(a.assetId)} onEditAltText={() => setAltTextForId(a.assetId)} />
                ))}
              </div>
            ) : (
              <div className="surface-card list-view">
                {assets.map((a) => (
                  <MediaAssetRow key={a.assetId} asset={a} onDelete={() => void removeAsset(a.assetId, a.name)} onShowUsage={() => showUsage(a.assetId)} onEditAltText={() => setAltTextForId(a.assetId)} />
                ))}
              </div>
            )}
            </div>
          </div>
        </div>
      )}

      {altTextFor ? (
        <AltTextDialog
          orgId={orgId}
          asset={altTextFor}
          onClose={() => setAltTextForId(null)}
          onSaved={(u) => setAssets((prev) => prev?.map((x) => (x.assetId === u.assetId ? u : x)) ?? prev)}
        />
      ) : null}

      {usageFor ? (
        <Modal onClose={() => showUsage(null)} label={t('usedByTitle', { name: usageFor.name })}>
          {usageFailed ? (
            <StateCard announce title={t('usedByFailedTitle')} body={t('usedByFailed')}
              action={<Button variant="secondary" onClick={() => {
                setUsageFailed(false); setUsageRefs(null);
                void listAssetUsage(orgId, usageFor.assetId)
                  .then((value) => setUsageRefs(value))
                  .catch(() => setUsageFailed(true));
              }}>{t('common:retry')}</Button>} />
          ) : !usageRefs ? <Skeleton /> : usageRefs.length === 0 ? (
            <span className="u-label-sm">{t('usedByEmpty')}</span>
          ) : (
            <div className="u-grid u-gap-1">
              {usageRefs.map((r) => (
                <div key={`${r.refKind}:${r.refId}`} className="u-flex u-gap-2 u-items-center">
                  <span className="chip chip--muted">
                    {t(r.refKind === 'campaign' ? 'usedByKindCampaign' : r.refKind === 'creative-brief' ? 'usedByKindCreativeBrief' : 'usedByKindCmsPage')}
                  </span>
                  <span>{r.refLabel}</span>
                </div>
              ))}
            </div>
          )}
        </Modal>
      ) : null}
    </div>
  );
}

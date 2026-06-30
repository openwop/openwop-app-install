/**
 * Media Library (host-extension product feature — ADR 0007). Org-scoped asset
 * store: pick an org, browse/create collections, upload + search assets, delete.
 * Gates on useFeatureAccess('media'); writes require workspace:write in the org
 * (the backend fail-closes — a viewer sees a 403 surfaced as a toast).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../../ui/confirm.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { IconButton } from '../../ui/IconButton.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { ImageIcon, LockIcon, PackageIcon, PlusIcon, TrashIcon } from '../../ui/icons/index.js';
import { MediaAssetCard, MediaAssetRow } from './MediaViews.js';
import {
  createCollection,
  deleteAsset,
  deleteCollection,
  listAssets,
  listCollections,
  listOrgs,
  uploadAsset,
  type MediaAsset,
  type MediaCollection,
  type Org,
} from './mediaClient.js';

const ALL = '__all__';
const UNCATEGORIZED = 'none'; // matches the backend ?collectionId sentinel (server-side filter)

export function MediaLibraryPage(): JSX.Element {
  const { t } = useTranslation('media');
  const access = useFeatureAccess('media');
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState<string>('');
  const [collections, setCollections] = useState<MediaCollection[]>([]);
  const [selected, setSelected] = useState<string>(ALL); // ALL | UNCATEGORIZED | collectionId
  const [assets, setAssets] = useState<MediaAsset[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [newCollection, setNewCollection] = useState('');
  const [busy, setBusy] = useState(false);
  const [viewMode, setViewMode] = useViewMode('media', 'grid');
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Load orgs once the feature is enabled; default to the first.
  useEffect(() => {
    if (!access.enabled) return;
    void listOrgs()
      .then((o) => {
        setOrgs(o);
        setOrgId((cur) => cur || (o[0]?.orgId ?? ''));
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('loadOrgsFailed')));
  }, [access.enabled, t]);

  const loadAssets = useCallback(
    (org: string, sel: string, query: string) => {
      const filter: { collectionId?: string; q?: string } = {};
      if (sel !== ALL) filter.collectionId = sel; // sel may be UNCATEGORIZED ('none') — the backend filters server-side
      if (query.trim()) filter.q = query.trim();
      void listAssets(org, filter)
        .then(setAssets)
        .catch((err) => setError(err instanceof Error ? err.message : t('loadAssetsFailed')));
    },
    [t],
  );

  // Collections reload only when the ORG changes (selected/q are reset to ALL/''
  // by the org-select onChange, so this effect doesn't also touch them).
  useEffect(() => {
    if (!orgId) return;
    setError(null);
    void listCollections(orgId).then(setCollections).catch(() => setCollections([]));
  }, [orgId]);

  // The SINGLE asset-loading effect — keyed on org + filter + search. On an org
  // switch the select resets selected→ALL + q→'' in the same batch, so this
  // fires exactly once with the right args (no double-fetch).
  useEffect(() => {
    if (!orgId) return;
    setAssets(null);
    loadAssets(orgId, selected, q);
  }, [orgId, selected, q, loadAssets]);

  const addCollection = useCallback(async () => {
    if (!newCollection.trim() || !orgId) return;
    setBusy(true);
    try {
      const c = await createCollection(orgId, newCollection.trim());
      setCollections((cur) => [...cur, c]);
      setNewCollection('');
      toast.success(t('collectionCreated'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('createFailed'));
    } finally {
      setBusy(false);
    }
  }, [newCollection, orgId, t]);

  const removeCollection = useCallback(
    async (collectionId: string) => {
      try {
        await deleteCollection(orgId, collectionId);
        setCollections((cur) => cur.filter((c) => c.collectionId !== collectionId));
        if (selected === collectionId) setSelected(ALL);
        toast.info(t('collectionDeleted'));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('deleteFailed'));
      }
    },
    [orgId, selected, t],
  );

  const onUpload = useCallback(
    async (file: File) => {
      setBusy(true);
      try {
        const collectionId = selected !== ALL && selected !== UNCATEGORIZED ? selected : undefined;
        await uploadAsset(orgId, file, collectionId);
        loadAssets(orgId, selected, q);
        toast.success(t('uploaded', { name: file.name }));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('uploadFailed'));
      } finally {
        setBusy(false);
      }
    },
    [orgId, selected, q, loadAssets, t],
  );

  const removeAsset = useCallback(
    async (assetId: string) => {
      if (!(await confirm({ title: t('deleteAssetConfirm'), danger: true, confirmLabel: t('common:delete') }))) return;
      try {
        await deleteAsset(orgId, assetId);
        setAssets((cur) => (cur ? cur.filter((a) => a.assetId !== assetId) : cur));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('deleteFailed'));
      }
    },
    [orgId, t],
  );

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  }

  const orgActions = (
    <select
      value={orgId}
      onChange={(e) => {
        setOrgId(e.target.value);
        setSelected(ALL); // reset filter + search in the same batch as the org switch
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
    <div>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={orgs && orgs.length > 0 ? orgActions : undefined} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {!orgs ? (
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
              <button key={c.id} type="button" className={`${selected === c.id ? 'btn-accent' : 'btn-ghost'} u-justify-start`} aria-current={selected === c.id ? 'true' : undefined} onClick={() => setSelected(c.id)}>
                {c.name}
              </button>
            ))}
            <div className="media-divider" />
            {collections.map((c) => (
              <div key={c.collectionId} className="u-flex u-gap-1 u-items-center">
                <button type="button" className={`${selected === c.collectionId ? 'btn-accent' : 'btn-ghost'} u-justify-start u-flex-1`} aria-current={selected === c.collectionId ? 'true' : undefined} onClick={() => setSelected(c.collectionId)}>
                  <PackageIcon /> {c.name}
                </button>
                <IconButton label={t('deleteCollectionLabel')} icon={<TrashIcon />} className="btn-ghost" onClick={() => void removeCollection(c.collectionId)} />
              </div>
            ))}
            <div className="u-flex u-gap-1 u-mt-2">
              <input value={newCollection} onChange={(e) => setNewCollection(e.target.value)} placeholder={t('newCollectionPlaceholder')} aria-label={t('newCollectionPlaceholder')} onKeyDown={(e) => { if (e.key === 'Enter') void addCollection(); }} />
              <IconButton label={t('newCollectionPlaceholder')} icon={<PlusIcon />} className="btn-ghost" disabled={busy || !newCollection.trim()} onClick={() => void addCollection()} />
            </div>
          </div>

          {/* Assets */}
          <div className="u-grid u-gap-3">
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
              <button type="button" className="btn-primary" disabled={busy} onClick={() => fileRef.current?.click()}>
                <ImageIcon /> {t('upload')}
              </button>
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

            {!assets ? (
              <Skeleton />
            ) : assets.length === 0 ? (
              q.trim() ? (
                <StateCard
                  icon={<ImageIcon />}
                  title={t('noMatchTitle')}
                  body={t('noMatchBody')}
                  action={<button type="button" className="secondary" onClick={() => setQ('')}>{t('clearSearch')}</button>}
                />
              ) : (
                <StateCard icon={<ImageIcon />} title={t('noAssetsTitle')} body={t('noAssetsBody')} />
              )
            ) : viewMode === 'grid' ? (
              <div className="card-grid">
                {assets.map((a) => (
                  <MediaAssetCard key={a.assetId} asset={a} onDelete={() => void removeAsset(a.assetId)} />
                ))}
              </div>
            ) : (
              <div className="surface-card list-view">
                {assets.map((a) => (
                  <MediaAssetRow key={a.assetId} asset={a} onDelete={() => void removeAsset(a.assetId)} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

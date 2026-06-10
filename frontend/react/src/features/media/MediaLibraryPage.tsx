/**
 * Media Library (host-extension product feature — ADR 0007). Org-scoped asset
 * store: pick an org, browse/create collections, upload + search assets, delete.
 * Gates on useFeatureAccess('media'); writes require workspace:write in the org
 * (the backend fail-closes — a viewer sees a 403 surfaced as a toast).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { ImageIcon, LockIcon, PackageIcon, PlusIcon, TrashIcon } from '../../ui/icons/index.js';
import {
  absoluteServeUrl,
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
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Load orgs once the feature is enabled; default to the first.
  useEffect(() => {
    if (!access.enabled) return;
    void listOrgs()
      .then((o) => {
        setOrgs(o);
        setOrgId((cur) => cur || (o[0]?.orgId ?? ''));
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load organizations.'));
  }, [access.enabled]);

  const loadAssets = useCallback(
    (org: string, sel: string, query: string) => {
      const filter: { collectionId?: string; q?: string } = {};
      if (sel !== ALL) filter.collectionId = sel; // sel may be UNCATEGORIZED ('none') — the backend filters server-side
      if (query.trim()) filter.q = query.trim();
      void listAssets(org, filter)
        .then(setAssets)
        .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load assets.'));
    },
    [],
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
      toast.success('Collection created.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Create failed.');
    } finally {
      setBusy(false);
    }
  }, [newCollection, orgId]);

  const removeCollection = useCallback(
    async (collectionId: string) => {
      try {
        await deleteCollection(orgId, collectionId);
        setCollections((cur) => cur.filter((c) => c.collectionId !== collectionId));
        if (selected === collectionId) setSelected(ALL);
        toast.info('Collection deleted (assets re-homed).');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Delete failed.');
      }
    },
    [orgId, selected],
  );

  const onUpload = useCallback(
    async (file: File) => {
      setBusy(true);
      try {
        const collectionId = selected !== ALL && selected !== UNCATEGORIZED ? selected : undefined;
        await uploadAsset(orgId, file, collectionId);
        loadAssets(orgId, selected, q);
        toast.success(`Uploaded ${file.name}.`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Upload failed.');
      } finally {
        setBusy(false);
      }
    },
    [orgId, selected, q, loadAssets],
  );

  const removeAsset = useCallback(
    async (assetId: string) => {
      try {
        await deleteAsset(orgId, assetId);
        setAssets((cur) => (cur ? cur.filter((a) => a.assetId !== assetId) : cur));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Delete failed.');
      }
    },
    [orgId],
  );

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title="Media library is not enabled" body="Ask an administrator to enable the Media feature for this tenant." />;
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
      aria-label="Organization"
    >
      {(orgs ?? []).map((o) => (
        <option key={o.orgId} value={o.orgId}>{o.name}</option>
      ))}
    </select>
  );

  return (
    <div>
      <PageHeader eyebrow="Platform" title="Media Library" lede="Org-scoped assets + collections." actions={orgs && orgs.length > 0 ? orgActions : undefined} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {!orgs ? (
        <Skeleton />
      ) : orgs.length === 0 ? (
        <StateCard icon={<PackageIcon />} title="No organizations" body="Create an organization first — media collections belong to an org." />
      ) : (
        <div className="media-layout">
          {/* Collections sidebar */}
          <div className="surface-card u-gap-2">
            <strong>Collections</strong>
            {[
              { id: ALL, name: 'All assets' },
              { id: UNCATEGORIZED, name: 'Uncategorized' },
            ].map((c) => (
              <button key={c.id} type="button" className={`${selected === c.id ? 'btn-primary' : 'btn-ghost'} u-justify-start`} onClick={() => setSelected(c.id)}>
                {c.name}
              </button>
            ))}
            <div className="media-divider" />
            {collections.map((c) => (
              <div key={c.collectionId} className="u-flex u-gap-1 u-items-center">
                <button type="button" className={`${selected === c.collectionId ? 'btn-primary' : 'btn-ghost'} u-justify-start u-flex-1`} onClick={() => setSelected(c.collectionId)}>
                  <PackageIcon /> {c.name}
                </button>
                <button type="button" className="btn-ghost" title="Delete collection" onClick={() => void removeCollection(c.collectionId)}>
                  <TrashIcon />
                </button>
              </div>
            ))}
            <div className="u-flex u-gap-1 u-mt-2">
              <input value={newCollection} onChange={(e) => setNewCollection(e.target.value)} placeholder="New collection" />
              <button type="button" className="btn-ghost" disabled={busy || !newCollection.trim()} onClick={() => void addCollection()}>
                <PlusIcon />
              </button>
            </div>
          </div>

          {/* Assets */}
          <div className="u-grid u-gap-3">
            <div className="action-bar">
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name…" className="u-flex-1" />
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
                <ImageIcon /> Upload
              </button>
            </div>

            {!assets ? (
              <Skeleton />
            ) : assets.length === 0 ? (
              <StateCard icon={<ImageIcon />} title="No assets" body="Upload a file to start this collection." />
            ) : (
              <div className="media-asset-grid">
                {assets.map((a) => (
                  <div key={a.assetId} className="surface-card u-gap-2 u-p-2">
                    <div className="media-thumb">
                      {a.contentType.startsWith('image/') ? (
                        <img src={absoluteServeUrl(a.serveUrl)} alt={a.name} className="media-thumb-img" />
                      ) : (
                        <ImageIcon />
                      )}
                    </div>
                    <span className="media-asset-name" title={a.name}>{a.name}</span>
                    <div className="u-flex u-wrap u-gap-1">
                      {a.tags.map((t) => (
                        <span key={t} className="chip">{t}</span>
                      ))}
                    </div>
                    <div className="action-bar u-justify-between">
                      <span className="u-label-sm">{a.usageCount > 0 ? `used ${a.usageCount}×` : 'unused'}</span>
                      <button type="button" className="btn-ghost" title="Delete asset" onClick={() => void removeAsset(a.assetId)}>
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

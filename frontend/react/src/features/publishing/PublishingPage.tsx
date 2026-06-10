/**
 * Publishing & SEO (host-extension product feature — ADR 0012).
 *
 * Gates on useFeatureAccess('publishing'). An org picker drives the org's CMS
 * pages; selecting one opens a per-page SEO editor (meta + Open Graph + canonical
 * + noindex, OG image from the Media Library) and, for published pages, the
 * PUBLIC URLs (page / sitemap / feed) the org's site is served at.
 */
import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { FileTextIcon, LockIcon, SaveIcon, GlobeIcon } from '../../ui/icons/index.js';
import {
  feedUrl,
  getSeo,
  listMediaAssets,
  listOrgs,
  listPages,
  publicPageUrl,
  putSeo,
  sitemapUrl,
  type CmsPageRef,
  type MediaAssetRef,
  type Org,
  type PageSeo,
} from './publishingClient.js';

const EMPTY_SEO: PageSeo = { noindex: false };

function copy(text: string): void {
  void navigator.clipboard?.writeText(text).then(() => toast.success('Copied')).catch(() => { /* clipboard blocked */ });
}

export function PublishingPage(): JSX.Element {
  const access = useFeatureAccess('publishing');
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [pages, setPages] = useState<CmsPageRef[] | null>(null);
  const [assets, setAssets] = useState<MediaAssetRef[]>([]);
  const [selected, setSelected] = useState<CmsPageRef | null>(null);
  const [seo, setSeo] = useState<PageSeo>(EMPTY_SEO);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!access.enabled) return;
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); }).catch(() => setOrgs([]));
  }, [access.enabled]);

  useEffect(() => {
    if (!orgId) return;
    // Guard against a slow fetch for a PREVIOUS org resolving after the user
    // switched — `active` goes false on cleanup, so a stale list never clobbers
    // the current org's view (which would then 404 on a page click).
    let active = true;
    setSelected(null); setPages(null);
    void listPages(orgId).then((p) => { if (active) setPages(p); }).catch((e) => { if (active) setError(e instanceof Error ? e.message : 'Failed to load pages.'); });
    void listMediaAssets(orgId).then((a) => { if (active) setAssets(a); }).catch(() => { if (active) setAssets([]); });
    return () => { active = false; };
  }, [orgId]);

  const openPage = useCallback((p: CmsPageRef) => {
    setSelected(p); setSeo(EMPTY_SEO);
    void getSeo(orgId, p.pageId).then((s) => setSeo(s ?? EMPTY_SEO)).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load SEO.'));
  }, [orgId]);

  const save = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    try { setSeo(await putSeo(orgId, selected.pageId, seo)); toast.success('SEO saved'); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed.'); }
    finally { setBusy(false); }
  }, [orgId, selected, seo]);

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title="Publishing is not enabled" body="Ask an administrator to enable the Publishing & SEO feature for this tenant." />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label="Organization">
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  const set = (patch: Partial<PageSeo>): void => setSeo((s) => ({ ...s, ...patch }));

  return (
    <div>
      <PageHeader eyebrow="Platform" title="Publishing & SEO" lede="Publish CMS pages to a public site with SEO metadata, sitemap, and RSS." actions={orgPicker} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {!orgs ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard icon={<GlobeIcon />} title="No organizations" body="Create an organization first — a site belongs to an org." />
      ) : (
        <div className="publishing-layout">
          {/* Page list + site links */}
          <div className="surface-card u-gap-2">
            <strong>Pages</strong>
            {!pages ? <Skeleton /> : pages.length === 0 ? <span className="u-label-sm">No CMS pages yet.</span> : pages.map((p) => (
              <button key={p.pageId} type="button" className={`${selected?.pageId === p.pageId ? 'btn-primary' : 'btn-ghost'} u-flex u-justify-between`} onClick={() => openPage(p)}>
                <span>{p.title}</span>
                <span className="chip">{p.status}</span>
              </button>
            ))}
            <div className="publishing-links u-mt-2">
              <span className="u-label-sm">Public site</span>
              <button type="button" className="btn-ghost u-justify-start" onClick={() => copy(sitemapUrl(orgId))}>Copy sitemap.xml URL</button>
              <button type="button" className="btn-ghost u-justify-start" onClick={() => copy(feedUrl(orgId))}>Copy feed.rss URL</button>
            </div>
          </div>

          {/* SEO editor */}
          {!selected ? (
            <StateCard icon={<FileTextIcon />} title="Select a page" body="Pick a page to edit its SEO metadata. Published pages get a public URL." />
          ) : (
            <div className="surface-card u-gap-3">
              <div className="u-flex u-gap-2 u-items-center u-wrap">
                <strong>{selected.title}</strong>
                <span className="chip">{selected.status}</span>
                {selected.status === 'published' ? (
                  <button type="button" className="btn-ghost u-ml-auto" onClick={() => copy(publicPageUrl(orgId, selected.slug))}>Copy public URL</button>
                ) : <span className="u-label-sm u-ml-auto">Publish in the CMS to go live</span>}
              </div>

              <label className="u-label-sm">Meta title
                <input value={seo.metaTitle ?? ''} onChange={(e) => set({ metaTitle: e.target.value })} placeholder={selected.title} />
              </label>
              <label className="u-label-sm">Meta description
                <textarea value={seo.metaDescription ?? ''} onChange={(e) => set({ metaDescription: e.target.value })} rows={2} placeholder="Falls back to the page's first section text" />
              </label>
              <label className="u-label-sm">Open Graph title
                <input value={seo.ogTitle ?? ''} onChange={(e) => set({ ogTitle: e.target.value })} placeholder="Falls back to meta title" />
              </label>
              <label className="u-label-sm">Open Graph description
                <textarea value={seo.ogDescription ?? ''} onChange={(e) => set({ ogDescription: e.target.value })} rows={2} placeholder="Falls back to meta description" />
              </label>
              <label className="u-label-sm">Open Graph image
                <select value={seo.ogImageToken ?? ''} onChange={(e) => set({ ogImageToken: e.target.value })}>
                  <option value="">— none —</option>
                  {assets.filter((a) => a.serveToken).map((a) => <option key={a.assetId} value={a.serveToken}>{a.name}</option>)}
                </select>
              </label>
              <label className="u-label-sm">Canonical URL
                <input value={seo.canonicalUrl ?? ''} onChange={(e) => set({ canonicalUrl: e.target.value })} placeholder="https://… (optional override)" />
              </label>
              <label className="u-label-sm u-flex u-gap-2 u-items-center">
                <input type="checkbox" checked={seo.noindex} onChange={(e) => set({ noindex: e.target.checked })} className="u-w-auto" />
                Exclude from sitemap + feed (noindex)
              </label>

              <div className="u-flex u-justify-end">
                <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}><SaveIcon /> Save SEO</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

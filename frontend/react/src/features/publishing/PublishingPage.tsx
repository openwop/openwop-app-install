/**
 * Publishing & SEO (host-extension product feature — ADR 0012).
 *
 * Gates on useFeatureAccess('publishing'). An org picker drives the org's CMS
 * pages; selecting one opens a per-page SEO editor (meta + Open Graph + canonical
 * + noindex, OG image from the Media Library) and, for published pages, the
 * PUBLIC URLs (page / sitemap / feed) the org's site is served at.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import i18n from '../../i18n/index.js';
import { FileTextIcon, LockIcon, SaveIcon, GlobeIcon } from '../../ui/icons/index.js';
import { useUnsavedChangesWarning } from '../../ui/useUnsavedChangesWarning.js';
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

/** Page status → a §5.3 chip variant (the status word rides alongside the
 *  color, so it is never the sole signal). */
function statusChipClass(status: string): string {
  switch (status) {
    case 'published': return 'chip chip--success';
    case 'in_review': return 'chip chip--warning';
    default: return 'chip chip--muted'; // draft, archived
  }
}

function copy(text: string): void {
  void navigator.clipboard?.writeText(text).then(() => toast.success(i18n.t('publishing:copied'))).catch(() => { /* clipboard blocked */ });
}

export function PublishingPage(): JSX.Element {
  const { t } = useTranslation('publishing');
  const access = useFeatureAccess('publishing');
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [pages, setPages] = useState<CmsPageRef[] | null>(null);
  const [assets, setAssets] = useState<MediaAssetRef[]>([]);
  const [selected, setSelected] = useState<CmsPageRef | null>(null);
  const [seo, setSeo] = useState<PageSeo>(EMPTY_SEO);
  // The loaded/last-saved SEO baseline — `seo` diverges on edit, matches again
  // on page-select and after a successful save. UX CONT-6.
  const [savedSeo, setSavedSeo] = useState<PageSeo>(EMPTY_SEO);
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
    void listPages(orgId).then((p) => { if (active) setPages(p); }).catch((e) => { if (active) setError(e instanceof Error ? e.message : t('loadPagesFailed')); });
    void listMediaAssets(orgId).then((a) => { if (active) setAssets(a); }).catch(() => { if (active) setAssets([]); });
    return () => { active = false; };
  }, [orgId, t]);

  const openPage = useCallback((p: CmsPageRef) => {
    setSelected(p); setSeo(EMPTY_SEO); setSavedSeo(EMPTY_SEO);
    void getSeo(orgId, p.pageId).then((s) => { setSeo(s ?? EMPTY_SEO); setSavedSeo(s ?? EMPTY_SEO); }).catch((e) => setError(e instanceof Error ? e.message : t('loadSeoFailed')));
  }, [orgId, t]);

  const save = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    try { const next = await putSeo(orgId, selected.pageId, seo); setSeo(next); setSavedSeo(next); toast.success(t('seoSaved')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('saveFailed')); }
    finally { setBusy(false); }
  }, [orgId, selected, seo, t]);

  // Dirty while the SEO form diverges from the loaded/saved baseline. UX CONT-6.
  const dirty = selected !== null && JSON.stringify(seo) !== JSON.stringify(savedSeo);
  useUnsavedChangesWarning(dirty);

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('orgPickerLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  const set = (patch: Partial<PageSeo>): void => setSeo((s) => ({ ...s, ...patch }));

  return (
    <div>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={orgPicker} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {!orgs ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard icon={<GlobeIcon />} title={t('noOrgsTitle')} body={t('noOrgsBody')} />
      ) : (
        <div className="publishing-layout">
          {/* Page list + site links */}
          <div className="surface-card u-gap-2">
            <h2 className="u-fs-16 u-m-0">{t('pages')}</h2>
            {!pages ? <Skeleton /> : pages.length === 0 ? <span className="u-label-sm">{t('noPages')}</span> : pages.map((p) => (
              <button key={p.pageId} type="button" className={`${selected?.pageId === p.pageId ? 'btn-accent' : 'btn-ghost'} u-flex u-justify-between`} aria-current={selected?.pageId === p.pageId ? 'true' : undefined} onClick={() => openPage(p)}>
                <span>{p.title}</span>
                <span className={statusChipClass(p.status)}>{p.status}</span>
              </button>
            ))}
            <div className="publishing-links u-mt-2">
              <span className="u-label-sm">{t('publicSite')}</span>
              <button type="button" className="btn-ghost u-justify-start" onClick={() => copy(sitemapUrl(orgId))}>{t('copySitemapUrl')}</button>
              <button type="button" className="btn-ghost u-justify-start" onClick={() => copy(feedUrl(orgId))}>{t('copyFeedUrl')}</button>
            </div>
          </div>

          {/* SEO editor */}
          {!selected ? (
            <StateCard icon={<FileTextIcon />} title={t('selectPageTitle')} body={t('selectPageBody')} />
          ) : (
            <div className="surface-card u-gap-3">
              <div className="u-flex u-gap-2 u-items-center u-wrap">
                <h2 className="u-fs-16 u-m-0">{selected.title}</h2>
                <span className={statusChipClass(selected.status)}>{selected.status}</span>
                {selected.status === 'published' ? (
                  <button type="button" className="btn-ghost u-ml-auto" onClick={() => copy(publicPageUrl(orgId, selected.slug))}>{t('copyPublicUrl')}</button>
                ) : <span className="u-label-sm u-ml-auto">{t('publishToGoLive')}</span>}
              </div>

              <label className="u-label-sm">{t('metaTitle')}
                <input value={seo.metaTitle ?? ''} onChange={(e) => set({ metaTitle: e.target.value })} placeholder={selected.title} />
              </label>
              <label className="u-label-sm">{t('metaDescription')}
                <textarea value={seo.metaDescription ?? ''} onChange={(e) => set({ metaDescription: e.target.value })} rows={2} placeholder={t('metaDescriptionPlaceholder')} />
              </label>
              <label className="u-label-sm">{t('ogTitle')}
                <input value={seo.ogTitle ?? ''} onChange={(e) => set({ ogTitle: e.target.value })} placeholder={t('ogTitlePlaceholder')} />
              </label>
              <label className="u-label-sm">{t('ogDescription')}
                <textarea value={seo.ogDescription ?? ''} onChange={(e) => set({ ogDescription: e.target.value })} rows={2} placeholder={t('ogDescriptionPlaceholder')} />
              </label>
              <label className="u-label-sm">{t('ogImage')}
                <select value={seo.ogImageToken ?? ''} onChange={(e) => set({ ogImageToken: e.target.value })}>
                  <option value="">{t('ogImageNone')}</option>
                  {assets.filter((a) => a.serveToken).map((a) => <option key={a.assetId} value={a.serveToken}>{a.name}</option>)}
                </select>
              </label>
              <label className="u-label-sm">{t('canonicalUrl')}
                <input value={seo.canonicalUrl ?? ''} onChange={(e) => set({ canonicalUrl: e.target.value })} placeholder={t('canonicalUrlPlaceholder')} />
              </label>
              <label className="u-label-sm u-flex u-gap-2 u-items-center">
                <input type="checkbox" checked={seo.noindex} onChange={(e) => set({ noindex: e.target.checked })} className="u-w-auto" />
                {t('noindexLabel')}
              </label>

              <div className="u-flex u-justify-end">
                <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}><SaveIcon /> {t('saveSeo')}</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

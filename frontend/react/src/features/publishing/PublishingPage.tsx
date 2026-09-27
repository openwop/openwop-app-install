/**
 * Publishing & SEO (host-extension product feature — ADR 0012).
 *
 * ALWAYS-ON (ADR 0027 — the `publishing` toggle is retired; no useFeatureAccess
 * gate: an absent id resolves OFF and bricked fresh installs — /browser 2026-07-03). An org picker drives the org's CMS
 * pages; selecting one opens a per-page SEO editor (meta + Open Graph + canonical
 * + noindex, OG image from the Media Library) and, for published pages, the
 * PUBLIC URLs (page / sitemap / feed) the org's site is served at.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import i18n from '../../i18n/index.js';
import { FileTextIcon, SaveIcon, GlobeIcon } from '../../ui/icons/index.js';
import { useUnsavedChangesWarning } from '../../ui/useUnsavedChangesWarning.js';
import { copyToClipboard } from '../../ui/copyToClipboard.js';
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
import { SYSTEM_SITE_ORG } from '../cms/siteOrg.js';
import { getSiteConfig } from '../site/siteConfigClient.js';

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
  void copyToClipboard(text, i18n.t('publishing:copied'));
}

export function PublishingPage(): JSX.Element {
  const { t } = useTranslation(['publishing', 'cms']);
  const [pages, setPages] = useState<CmsPageRef[] | null>(null);
  // §4.5 picker search (DESIGN.md rule 13) — view-only; selection resolves
  // against the full list.
  const [query, setQuery] = useState('');
  const visiblePages = (pages ?? []).filter((p) => !query.trim() || p.title.toLowerCase().includes(query.trim().toLowerCase()) || p.slug.toLowerCase().includes(query.trim().toLowerCase()));
  const [assets, setAssets] = useState<MediaAssetRef[]>([]);
  const [seo, setSeo] = useState<PageSeo>(EMPTY_SEO);
  // The loaded/last-saved SEO baseline — `seo` diverges on edit, matches again
  // on page-select and after a successful save. UX CONT-6.
  const [savedSeo, setSavedSeo] = useState<PageSeo>(EMPTY_SEO);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The deployment's public site lives in the reserved `host-site` scope,
  // which is intentionally absent from the ordinary org list. The same
  // superadmin probe as CMS decides whether this synthetic scope exists for
  // the caller; without it the now-authorized SEO route is unreachable from
  // the product UI.
  const [isSiteAdmin, setIsSiteAdmin] = useState(false);

  // COLL-UX-1 — the open page rides the URL (`?org=&page=`, the forms/email
  // routing canon, DESIGN.md rule 12): shareable + reload-stable.
  const [searchParams] = useSearchParams();
  /** One-shot snapshot of the inbound `?org=` deep link (the Funnels idiom):
   *  keeps the orgs effect's dep list honest without a lint suppression. */
  const [deepLinkOrg] = useState(() => searchParams.get('org'));
  /** The shared read (`ui/useOrgSelection`). The local version wrote
   *  `setOrgs([])` in the catch beside an `orgsFailed` flag, so `orgs.length
   *  === 0` carried two meanings and only the flag separated them. The hook
   *  keeps `orgs` null on failure, and honours the `?org=` deep link when the
   *  read confirms it exists. */
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } =
    useOrgSelection<Org>(listOrgs, true, deepLinkOrg ?? '');
  useEffect(() => {
    void getSiteConfig().then(() => setIsSiteAdmin(true)).catch(() => setIsSiteAdmin(false));
  }, []);
  const frontPageScope: Org = { orgId: SYSTEM_SITE_ORG, name: t('cms:frontPageScope') };
  const pickerOrgs: readonly Org[] = isSiteAdmin ? [frontPageScope, ...(orgs ?? [])] : (orgs ?? []);

  // `useOrgSelection` can only validate deep links against ordinary orgs. Once
  // BOTH reads settle and the superadmin probe confirms the synthetic system
  // scope, restore a `?org=host-site` deep link instead of silently redirecting
  // it to the first workspace. Waiting for `orgs` is load-bearing: when the
  // site-config probe wins the race, the org hook otherwise overwrites this
  // selection when its later response arrives.
  useEffect(() => {
    if (orgs !== null && isSiteAdmin && deepLinkOrg === SYSTEM_SITE_ORG) setOrgId(SYSTEM_SITE_ORG);
  }, [deepLinkOrg, isSiteAdmin, orgs, setOrgId]);
  /** §4.5 rule 12 — `?page=` IS the selection, not a mirror of local state.
   *  Deriving it (rather than storing a copy and writing the param alongside)
   *  is what lets the rail cells be real `<Link>`s: the URL changes, and the
   *  page follows. It also retires the one-shot deep-link consumption this page
   *  used to need — an inbound link is now just the ordinary path. */
  const selectedId = searchParams.get('page') ?? '';
  /** A rail cell's href — the same transition, as a URL the browser can open in
   *  a new tab or copy. */
  const pageHref = useCallback((pageId: string): string => {
    const n = new URLSearchParams(searchParams);
    n.set('page', pageId); if (orgId) n.set('org', orgId);
    return `?${n.toString()}`;
  }, [searchParams, orgId]);

  useEffect(() => {
    if (!orgId) return;
    // Guard against a slow fetch for a PREVIOUS org resolving after the user
    // switched — `active` goes false on cleanup, so a stale list never clobbers
    // the current org's view (which would then 404 on a page click).
    let active = true;
    setPages(null);
    void listPages(orgId).then((p) => { if (active) setPages(p); }).catch((e) => { if (active) setError(e instanceof Error ? e.message : t('loadPagesFailed')); });
    void listMediaAssets(orgId).then((a) => { if (active) setAssets(a); }).catch(() => { if (active) setAssets([]); });
    return () => { active = false; };
  }, [orgId, t]);

  /** The open page, resolved from the URL against the loaded list. A `?page=`
   *  naming nothing in this org reads as "none selected" — the same validity
   *  rule the KB + Media rails use. */
  const selected = useMemo(
    () => pages?.find((p) => p.pageId === selectedId) ?? null,
    [pages, selectedId],
  );

  // The open page's SEO follows the URL. This replaces `openPage`'s imperative
  // fetch: a rail click, a browser Back, and an inbound deep link are now the
  // same event — a change of `?page=` — so all three load identically.
  useEffect(() => {
    if (!orgId || !selected) { setSeo(EMPTY_SEO); setSavedSeo(EMPTY_SEO); return undefined; }
    let active = true;
    setSeo(EMPTY_SEO); setSavedSeo(EMPTY_SEO);
    void getSeo(orgId, selected.pageId)
      .then((s) => { if (active) { setSeo(s ?? EMPTY_SEO); setSavedSeo(s ?? EMPTY_SEO); } })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : t('loadSeoFailed')); });
    return () => { active = false; };
  }, [orgId, selected, t]);

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


  const orgPicker = pickerOrgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('ui:orgPickerLabel')}>
      {pickerOrgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  const set = (patch: Partial<PageSeo>): void => setSeo((s) => ({ ...s, ...patch }));

  return (
    <div data-walkthrough="publishing.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={orgPicker} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {/* Fifth sighting of "Create an organization first" rendered by a read
          that failed, across this program — the branch is the component's now,
          so the order cannot be got wrong again here. */}
      <OrgSelectionState
        orgs={orgs === null ? null : pickerOrgs}
        orgsFailed={orgsFailed}
        retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')}
        failedBody={t('orgsFailedClause')}
        icon={<GlobeIcon />}
      >
        {(
        <div className="publishing-layout">
          {/* Page list + site links */}
          <div className="surface-card u-gap-2">
            <h2 className="u-fs-16 u-m-0">{t('pages')}</h2>
            {pages && pages.length > 3 ? (
              <input
                type="search"
                className="ui-input filterbar-search"
                placeholder={t('filterPlaceholder')}
                aria-label={t('filterAria')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            ) : null}
            {!pages ? <Skeleton /> : pages.length === 0 ? <span className="u-label-sm">{t('noPages')}</span>
              : visiblePages.length === 0 ? (
                <span className="u-flex u-items-center u-gap-2 u-label-sm">
                  {t('noMatchBody')}
                  <Button variant="quiet" size="sm" onClick={() => setQuery('')}>{t('clearSearch')}</Button>
                </span>
              ) : visiblePages.map((p) => (
              /* §4.5 rule 12 — a rail cell is a real `<Link>`. The rail keeps its
                 rule-11 exemption (no Grid⇄List toggle in a 300px column) but not
                 this one: cmd-click and "copy link address" have to work here. */
              <Link
                key={p.pageId}
                to={pageHref(p.pageId)}
                replace
                className={`${selectedId === p.pageId ? 'btn-accent' : 'btn-ghost'} u-flex u-justify-between`}
                aria-current={selectedId === p.pageId ? 'true' : undefined}
              >
                <span>{p.title}</span>
                <span className={statusChipClass(p.status)}>{t(`status_${p.status}`)}</span>
              </Link>
            ))}
            <div className="publishing-links u-mt-2">
              <span className="u-label-sm">{t('publicSite')}</span>
              <Button variant="quiet" className="u-justify-start" onClick={() => copy(sitemapUrl(orgId))}>{t('copySitemapUrl')}</Button>
              <Button variant="quiet" className="u-justify-start" onClick={() => copy(feedUrl(orgId))}>{t('copyFeedUrl')}</Button>
            </div>
          </div>

          {/* SEO editor */}
          {!selected ? (
            <StateCard icon={<FileTextIcon />} title={t('selectPageTitle')} body={t('selectPageBody')} />
          ) : (
            <div className="surface-card u-gap-3">
              <div className="u-flex u-gap-2 u-items-center u-wrap">
                <h2 className="u-fs-16 u-m-0">{selected.title}</h2>
                <span className={statusChipClass(selected.status)}>{t(`status_${selected.status}`)}</span>
                {selected.status === 'published' ? (
                  <Button variant="quiet" className="u-ml-auto" onClick={() => copy(publicPageUrl(orgId, selected.slug))}>{t('copyPublicUrl')}</Button>
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
                <Button variant="primary" disabled={busy} onClick={() => void save()}><SaveIcon /> {t('saveSeo')}</Button>
              </div>
            </div>
          )}
        </div>
        )}
      </OrgSelectionState>
    </div>
  );
}

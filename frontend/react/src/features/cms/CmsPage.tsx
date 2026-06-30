/**
 * CMS + Page Builder (host-extension product feature — ADR 0009).
 *
 * Gates on useFeatureAccess('cms'). An org picker drives a page list + a
 * section-based editor (the core section set), the editorial workflow buttons
 * (the backend enforces who may approve/publish — a wrong-authority click
 * surfaces a 403 toast), and a live preview. Section images are Media-Library
 * tokens.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { IconButton } from '../../ui/IconButton.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { FileTextIcon, LockIcon, PlusIcon, SaveIcon, TrashIcon } from '../../ui/icons/index.js';
import { useUnsavedChangesWarning } from '../../ui/useUnsavedChangesWarning.js';
import { RenderSection } from './SectionRenderer.js';
import { SectionsEditor } from './SectionsEditor.js';
import { CmsLanguageSettings } from './CmsLanguageSettings.js';
import {
  createPage,
  deletePage,
  getLanguageSettings,
  getPage,
  listMediaAssets,
  listOrgs,
  listPages,
  savePage,
  transition,
  translateSection,
  type LanguageSettings,
  type MediaAssetRef,
  type Org,
  type Page,
  type WorkflowAction,
} from './cmsClient.js';


/** Status → the workflow actions to OFFER (authority is enforced server-side). */
const ACTIONS_FOR: Record<string, WorkflowAction[]> = {
  draft: ['submit', 'publish'],
  in_review: ['approve', 'reject'],
  published: ['unpublish', 'archive'],
  archived: ['unpublish'],
};

/** Page status → a §5.3 chip variant (color is never the sole signal — the
 *  status word rides alongside). */
function statusChipClass(status: string): string {
  switch (status) {
    case 'published': return 'chip chip--success';
    case 'in_review': return 'chip chip--warning';
    case 'archived': return 'chip chip--muted';
    default: return 'chip chip--muted'; // draft
  }
}

export function CmsPage(): JSX.Element {
  const { t } = useTranslation('cms');
  const access = useFeatureAccess('cms');
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [pages, setPages] = useState<Page[] | null>(null);
  const [selected, setSelected] = useState<Page | null>(null);
  // The loaded/last-saved page baseline — `selected` is edited in place, so it
  // diverges from this on edit and matches again on open / save / workflow
  // transition. UX CONT-6.
  const [savedPage, setSavedPage] = useState<Page | null>(null);
  const [assets, setAssets] = useState<MediaAssetRef[]>([]);
  const [settings, setSettings] = useState<LanguageSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!access.enabled) return;
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); }).catch(() => setOrgs([]));
  }, [access.enabled]);

  const loadPages = useCallback((org: string) => {
    void listPages(org).then(setPages).catch((e) => setError(e instanceof Error ? e.message : t('loadPagesFailed')));
  }, [t]);

  useEffect(() => {
    if (!orgId) return;
    // FP-1: guard against a stale org's responses landing after a fast org
    // switch and stomping the newer org's data. The cleanup flips `cancelled`,
    // so in-flight resolutions for the previous org are dropped.
    let cancelled = false;
    setPages(null); setSelected(null); setSavedPage(null); setError(null); setSettings(null);
    void listPages(orgId).then((p) => { if (!cancelled) setPages(p); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t('loadPagesFailed')); });
    void listMediaAssets(orgId).then((a) => { if (!cancelled) setAssets(a); }).catch(() => { if (!cancelled) setAssets([]); });
    void getLanguageSettings(orgId).then((s) => { if (!cancelled) setSettings(s); }).catch(() => { if (!cancelled) setSettings(null); });
    return () => { cancelled = true; };
  }, [orgId, t]);

  // Editor locale tabs (ADR 0064): [base, ...supported]. Empty/1-entry ⇒ no tabs.
  const locales = settings ? [settings.baseLocale, ...settings.supportedLocales] : [];
  const baseLocale = settings?.baseLocale ?? 'en';

  const open = useCallback((pageId: string) => {
    void getPage(orgId, pageId).then((p) => { setSelected(p); setSavedPage(p); }).catch((e) => toast.error(e instanceof Error ? e.message : t('openFailed')));
  }, [orgId, t]);

  const create = useCallback(async () => {
    if (!newTitle.trim()) return;
    setBusy(true);
    try { const p = await createPage(orgId, newTitle.trim()); setNewTitle(''); loadPages(orgId); setSelected(p); setSavedPage(p); toast.success(t('pageCreated')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('createFailed')); } finally { setBusy(false); }
  }, [orgId, newTitle, loadPages, t]);

  const save = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const saved = await savePage(orgId, selected.pageId, { title: selected.title, sections: selected.sections });
      setSelected(saved); setSavedPage(saved); loadPages(orgId); toast.success(t('pageSaved'));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('saveFailed')); } finally { setBusy(false); }
  }, [orgId, selected, loadPages, t]);

  const runAction = useCallback(async (action: WorkflowAction) => {
    if (!selected) return;
    try { const p = await transition(orgId, selected.pageId, action); setSelected(p); setSavedPage(p); loadPages(orgId); toast.success(t('pageStatusChanged', { status: p.status })); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed', { action })); }
  }, [orgId, selected, loadPages, t]);

  const remove = useCallback(async (pageId: string) => {
    try { await deletePage(orgId, pageId); if (selected?.pageId === pageId) { setSelected(null); setSavedPage(null); } loadPages(orgId); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); }
  }, [orgId, selected, loadPages, t]);

  // Dirty while the editor's title/sections diverge from the loaded/saved page.
  // Workflow transitions replace both `selected` and `savedPage`, so a status
  // change is never "unsaved". UX CONT-6.
  const dirty = selected !== null && savedPage !== null &&
    (selected.title !== savedPage.title || JSON.stringify(selected.sections) !== JSON.stringify(savedPage.sections));
  useUnsavedChangesWarning(dirty);

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('disabledTitle')} body={t('disabledBody')} />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('organizationLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  return (
    <div>
      <PageHeader eyebrow={t('headerEyebrow')} title={t('headerTitle')} lede={t('headerLede')} actions={orgs && orgs.length > 0 ? orgPicker : undefined} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {!orgs ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard icon={<FileTextIcon />} title={t('noOrgsTitle')} body={t('noOrgsBody')} />
      ) : (
        <>
        {/* Content languages (ADR 0064) — org-level config, collapsed by default. */}
        <details className="surface-card u-gap-2 u-mb-2">
          <summary className="u-label-sm">Content languages{settings && settings.supportedLocales.length > 0 ? ` · ${settings.supportedLocales.length} translation${settings.supportedLocales.length === 1 ? '' : 's'}` : ''}</summary>
          <div className="u-mt-2"><CmsLanguageSettings orgId={orgId} onChange={setSettings} /></div>
        </details>

        <div className="cms-layout">
          {/* Page list */}
          <div className="surface-card u-gap-2">
            <h2 className="u-fs-16 u-m-0">{t('pagesHeading')}</h2>
            {!pages ? <Skeleton /> : pages.length === 0 ? <span className="u-label-sm">{t('noPagesYet')}</span> : pages.map((p) => (
              <div key={p.pageId} className="u-flex u-gap-1 u-items-center">
                <button
                  type="button"
                  className={`${selected?.pageId === p.pageId ? 'btn-accent' : 'btn-ghost'} u-justify-start u-flex-1`}
                  aria-current={selected?.pageId === p.pageId ? 'true' : undefined}
                  onClick={() => open(p.pageId)}
                >
                  {p.title}
                </button>
                <span className={statusChipClass(p.status)}>{p.status}</span>
                <IconButton label={t('deletePageTitle')} icon={<TrashIcon />} className="btn-ghost" onClick={() => void remove(p.pageId)} />
              </div>
            ))}
            <div className="u-flex u-gap-1 u-mt-2">
              <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={t('newPageTitlePlaceholder')} aria-label={t('newPageTitlePlaceholder')} onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
              <IconButton label={t('newPageTitlePlaceholder')} icon={<PlusIcon />} className="btn-ghost" disabled={busy || !newTitle.trim()} onClick={() => void create()} />
            </div>
          </div>

          {/* Editor */}
          {!selected ? (
            <StateCard icon={<FileTextIcon />} title={t('selectPageTitle')} body={t('selectPageBody')} />
          ) : (
            <div className="u-grid u-gap-4">
              <div className="surface-card u-gap-3">
                <div className="u-flex u-gap-2 u-items-center u-wrap">
                  <span className={statusChipClass(selected.status)}>{selected.status}</span>
                  <span className="u-label-sm">/{selected.slug} · v{selected.version}</span>
                  <span className="u-flex-1" />
                  {ACTIONS_FOR[selected.status]?.map((a) => (
                    <button key={a} type="button" className="btn-ghost" onClick={() => void runAction(a)}>{a}</button>
                  ))}
                </div>
                <label className="u-grid u-gap-1">
                  <span className="u-label-sm">{t('titleLabel')}</span>
                  <input value={selected.title} onChange={(e) => setSelected((p) => (p ? { ...p, title: e.target.value } : p))} />
                </label>

                <h2 className="u-fs-16 u-m-0">{t('sectionsHeading')}</h2>
                <SectionsEditor
                  sections={selected.sections}
                  assets={assets}
                  baseLocale={baseLocale}
                  locales={locales}
                  onChange={(sections) => setSelected((p) => (p ? { ...p, sections } : p))}
                  onTranslate={async (sectionType, data, targetLocale) => {
                    try {
                      const overlay = await translateSection(orgId, { sectionType, data, targetLocale });
                      if (!overlay || Object.keys(overlay).length === 0) {
                        toast.error(t('translateEmpty'));
                        return null;
                      }
                      return overlay;
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : t('translateUnavailable'));
                      return null;
                    }
                  }}
                />

                <div className="action-bar">
                  <span className="u-flex-1" />
                  <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}><SaveIcon /> {t('saveAction')}</button>
                </div>
              </div>

              {/* Preview */}
              <div className="surface-card u-gap-3">
                <h2 className="u-fs-16 u-m-0">{t('previewHeading')}</h2>
                {selected.sections.length === 0 ? <span className="u-label-sm">{t('previewEmpty')}</span> : selected.sections.map((s) => <RenderSection key={s.sectionId} section={s} mode="editor" />)}
              </div>
            </div>
          )}
        </div>
        </>
      )}
    </div>
  );
}

// The section editor + preview now live in the shared `SectionsEditor` /
// `SectionRenderer` (ADR 0027) so the org CMS editor and the host-level home-page
// editor use the same controls.

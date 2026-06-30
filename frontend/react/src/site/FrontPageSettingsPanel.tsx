/**
 * Front page (ADR 0027) — the superadmin surface to EDIT the public homepage and
 * toggle it on/off. The homepage is the host-level system page, edited via the
 * super-admin `/v1/host/openwop-app/site-page` route (cross-tenant by host authority,
 * never via org-scoped CMS) — so a super admin can always edit it, whatever org.
 * Reuses the shared `SectionsEditor` (same controls as the org CMS) + the public
 * `SectionRenderer` for a live preview. Non-superadmins see a read-only notice.
 */
import { useCallback, useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { PageHeader } from '../ui/PageHeader.js';
import { Notice } from '../ui/Notice.js';
import { Skeleton } from '../ui/Skeleton.js';
import { toast } from '../ui/toast.js';
import { SaveIcon } from '../ui/icons/index.js';
import { SectionsEditor } from '../features/cms/SectionsEditor.js';
import { RenderSection } from '../features/cms/SectionRenderer.js';
import type { Section } from '../features/cms/cmsClient.js';
import {
  getSiteConfig, putSiteConfig, getSitePage, putSitePage, invalidateFrontPage, ApiError,
} from '../features/site/siteConfigClient.js';

export function FrontPageSettingsPanel(): JSX.Element {
  const { t } = useTranslation('site');
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [title, setTitle] = useState('Home');
  const [sections, setSections] = useState<Section[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [cfg, page] = await Promise.all([getSiteConfig(), getSitePage()]);
        if (!live) return;
        setEnabled(cfg.enabled);
        setTitle(page.title);
        setSections(page.sections);
      } catch (err) {
        if (!live) return;
        if (err instanceof ApiError && err.status === 403) setDenied(true);
        else setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      // Content + on/off switch. Save content first (validated server-side), then
      // the toggle, then drop the public cache so '/' reflects the change.
      const page = await putSitePage({ title, sections });
      await putSiteConfig({ enabled });
      invalidateFrontPage();
      setSections(page.sections);
      toast.success(t('homePageSaved'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) { setDenied(true); return; }
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [title, sections, enabled, t]);

  if (loading) return <div className="u-p-4"><Skeleton /></div>;

  if (denied) {
    return (
      <div className="u-grid u-gap-3">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('ledeDenied')} />
        <Notice variant="warning">
          <Trans t={t} i18nKey="deniedNotice" components={{ 0: <strong />, 1: <code /> }} />
        </Notice>
      </div>
    );
  }

  return (
    <div className="u-grid u-gap-4">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        lede={t('lede')}
        actions={
          <button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>
            <SaveIcon size={15} /> {saving ? t('saving') : t('savePublish')}
          </button>
        }
      />

      {error ? <Notice variant="error">{error}</Notice> : null}

      <section className="surface-card u-grid u-gap-3 u-p-4">
        <label className="u-flex u-gap-2 u-items-center">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span><Trans t={t} i18nKey="frontPageToggle" components={{ 0: <strong />, 1: <code />, 2: <code /> }} /></span>
        </label>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('pageTitleLabel')}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </section>

      <div className="builder-two-col u-grid u-gap-4">
        <section className="surface-card u-grid u-gap-3 u-p-4">
          <h2 className="u-fs-16 u-m-0">{t('sectionsHeading')}</h2>
          <SectionsEditor sections={sections} assets={[]} onChange={setSections} />
        </section>
        <section className="surface-card u-grid u-gap-3 u-p-4">
          <h2 className="u-fs-16 u-m-0">{t('previewHeading')}</h2>
          {sections.length === 0
            ? <span className="u-label-sm">{t('addSectionToPreview')}</span>
            : <div className="cms-public-page">{sections.map((s) => <RenderSection key={s.sectionId} section={s} mode="public" />)}</div>}
        </section>
      </div>
    </div>
  );
}

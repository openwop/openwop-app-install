/**
 * App Builder's intentional entry point (ADR 0737). Existing applications stay
 * in the unified Documents canvas inventory; this page supplies the focused
 * start/re-entry workflow without creating a second list, store, or ownership
 * policy for app-builder canvases.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader, StateCard } from '../../ui/index.js';
import { Button } from '../../ui/Button.js';
import { MonitorIcon, PlusIcon, RotateCcwIcon, WorkflowIcon } from '../../ui/icons/index.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { createCanvas, listOrgs, type Org } from './canvasEditorClient.js';

export function AppBuilderHubPage(): JSX.Element {
  const { t } = useTranslation('app-builder');
  const navigate = useNavigate();
  const { orgs, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const startBlank = async (): Promise<void> => {
    const org = orgs?.[0];
    if (!org || creating) return;
    setCreating(true); setError('');
    try {
      const canvas = await createCanvas(org.orgId, { name: t('hubUntitled') });
      navigate(`/app-builder/${encodeURIComponent(canvas.canvasId)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('hubCreateFailed'));
      setCreating(false);
    }
  };

  return (
    <main className="page-shell app-builder-hub">
      <PageHeader
        eyebrow={t('hubEyebrow')}
        title={t('hubTitle')}
        lede={t('hubLede')}
        actions={<Button variant="primary" onClick={() => void startBlank()} disabled={!orgs?.length || creating}><PlusIcon size={15} aria-hidden /> {creating ? t('hubCreating') : t('hubStartBlank')}</Button>}
      />
      {orgsFailed ? (
        <StateCard icon={<MonitorIcon size={28} />} title={t('hubLoadFailedTitle')} body={t('hubLoadFailedBody')} announce action={<Button variant="secondary" onClick={retryOrgs}><RotateCcwIcon size={15} aria-hidden /> {t('hubRetry')}</Button>} />
      ) : orgs === null ? (
        <StateCard loading title={t('hubLoading')} />
      ) : orgs.length === 0 ? (
        <StateCard icon={<MonitorIcon size={28} />} title={t('hubNoOrgTitle')} body={t('hubNoOrgBody')} />
      ) : (
        <section className="card-grid app-builder-hub__grid" aria-label={t('hubChoices')}>
          <article className="surface-card">
            <span className="muted"><MonitorIcon size={22} aria-hidden /></span>
            <h2>{t('hubBlankTitle')}</h2>
            <p className="muted">{t('hubBlankBody')}</p>
            <div className="action-bar"><Button variant="primary" onClick={() => void startBlank()} disabled={creating}><PlusIcon size={15} aria-hidden /> {t('hubStartBlank')}</Button></div>
          </article>
          <article className="surface-card">
            <span className="muted"><MonitorIcon size={22} aria-hidden /></span>
            <h2>{t('hubExistingTitle')}</h2>
            <p className="muted">{t('hubExistingBody')}</p>
            <div className="action-bar"><Link className="btn secondary" to="/documents">{t('hubOpenDocuments')}</Link></div>
          </article>
          <article className="surface-card">
            <span className="muted"><WorkflowIcon size={22} aria-hidden /></span>
            <h2>{t('hubWorkflowTitle')}</h2>
            <p className="muted">{t('hubWorkflowBody')}</p>
            <div className="action-bar">
              <Link className="btn secondary" to="/builder?template=app-builder.design">{t('hubOpenWorkflow')}</Link>
            </div>
          </article>
        </section>
      )}
      {error ? <p className="notice notice--error" role="alert">{error}</p> : null}
    </main>
  );
}

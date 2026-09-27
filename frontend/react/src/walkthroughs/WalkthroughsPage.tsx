/**
 * Walkthroughs surface (ADR 0374) — the first-class home for authoring/managing/
 * playing guided walkthroughs, moved off the `/test` QA runner. Composes the existing
 * engine only: `requestWalkthroughRecord`/`requestWalkthroughLaunch` (the bus), the tenant
 * workflows list (ADR 0369, walkthroughs are id-prefixed `walkthrough.*`), and the player.
 * No new backend.
 */
import { Button } from '../ui/Button.js';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../ui/PageHeader.js';
import { StateCard } from '../ui/StateCard.js';
import { Notice } from '../ui/Notice.js';
import { useFeatureAccess } from '../featureToggles/FeatureAccessContext.js';
import { listWorkflowSummaries, archiveWorkflow, type WorkflowSummaryDTO } from '../workflows/workflowsClient.js';
import { requestWalkthroughRecord, requestWalkthroughLaunch } from './walkthroughBus.js';
import { authedHeaders, config, fetchOpts } from '../client/config.js';

/** ADR 0378 P3 — the honest run-derived funnel, fetched ON DEMAND per
 *  walkthrough (never page-load fan-out — the per-IP rate-limit budget). */
/**
 * §Correction (grade-code `WT-6`): `skipped` + `skippedByNode` were computed on
 * EVERY funnel request and then dropped on the floor — absent from this type and
 * rendered nowhere. ADR 0489's adaptive-checkpoint arm exists to answer "how
 * often did we skip work the learner had already done", and that question was
 * unanswerable in the product while every request paid to compute it.
 *
 * `scanned`/`truncated` (grade-data `WALK-2`) distinguish "nobody ran this" from
 * "the newest 100 runs of a busy tenant contained none of them".
 */
interface Funnel {
  started: number; completed: number; cancelled: number; failed: number; active: number;
  stalledByNode: Record<string, number>;
  skipped: number;
  skippedByNode: Record<string, number>;
  scanned?: number;
  truncated?: boolean;
}
function FunnelStats({ walkthroughId }: { walkthroughId: string }): JSX.Element {
  const { t } = useTranslation('walkthroughs');
  const [state, setState] = useState<'idle' | 'loading' | 'error' | Funnel>('idle');
  const load = () => {
    setState('loading');
    fetch(`${config.baseUrl}/host/openwop-app/walkthroughs/funnel?walkthroughId=${encodeURIComponent(walkthroughId)}`, fetchOpts({ headers: authedHeaders() }))
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); setState((await r.json()) as Funnel); })
      .catch(() => setState('error'));
  };
  // Grade-pass: ONE persistent live region wraps every state so the result is
  // announced when it lands (the old render swapped elements — focus fell to
  // body and screen readers heard nothing).
  if (state === 'idle') return <div aria-live="polite"><Button variant="secondary" size="sm" onClick={load}>{t('statsButton')}</Button></div>;
  if (state === 'loading') return <div aria-live="polite"><span className="muted" role="status">{t('common:loading')}</span></div>;
  if (state === 'error') return <div aria-live="polite"><Notice variant="error">{t('funnelError')}</Notice></div>;
  const stalls = Object.entries(state.stalledByNode).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const skips = Object.entries(state.skippedByNode ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return (
    <div className="muted u-mt-2" role="group" aria-live="polite" aria-label={t('statsButton')}>
      <span className="chip chip--muted">{t('funnelStarted', { n: state.started })}</span>{' '}
      <span className="chip chip--success">{t('funnelCompleted', { n: state.completed })}</span>{' '}
      <span className="chip chip--muted">{t('funnelAbandoned', { n: state.cancelled + state.failed })}</span>{' '}
      {/* ADR 0489 — steps the adaptive checkpoint skipped because the learner
          had already done the work. Rendered only when non-zero: a "0 skipped"
          chip on every walkthrough is noise, not a signal. */}
      {state.skipped > 0 ? <><span className="chip chip--muted">{t('funnelSkipped', { n: state.skipped })}</span>{' '}</> : null}
      {stalls.length > 0 ? <span>{t('funnelStalls', { list: stalls.map(([nodeId, c]) => `${nodeId} ×${c}`).join(', ') })}</span> : null}
      {skips.length > 0 ? <div>{t('funnelSkips', { list: skips.map(([nodeId, c]) => `${nodeId} ×${c}`).join(', ') })}</div> : null}
      <div className="u-mt-1">
        <small>
          {/* Say what was actually READ. Without this, an all-zero funnel on a
              busy tenant reads as "nobody ran it" (grade-data WALK-2). */}
          {state.truncated && typeof state.scanned === 'number'
            ? t('funnelWindowScanned', { n: state.scanned })
            : t('funnelWindowHint')}
        </small>
      </div>
    </div>
  );
}

// ADR 0435 — the two sample walkthroughs are NO LONGER a hard-coded card list
// here. They were host-owned builtins rendered with only a Play button, so a
// tenant could neither edit nor delete them. They are now seeded demo data
// (`demo-walkthroughs` on /example-data) and therefore arrive in the ordinary
// owned list below, with Review-in-builder and delete like any other.

export function WalkthroughsPage(): JSX.Element {
  const { t } = useTranslation('walkthroughs');
  const nav = useNavigate();
  const access = useFeatureAccess('walkthroughs');
  const [mine, setMine] = useState<WorkflowSummaryDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The read FAILED — distinct from `null` (loading) and `[]` (genuinely none).
   *  #2596: the resolution depends on what the EMPTY state says; here it is
   *  "Press Record… or load the samples" — instructive. */
  const [mineFailed, setMineFailed] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  /** Archive an owned walkthrough — the workflows dashboard's remove verb
   *  (ADR 0369 lifecycle), applied optimistically to the list on success. */
  const remove = async (workflowId: string): Promise<void> => {
    setRemoving(workflowId);
    setError(null);
    try {
      await archiveWorkflow(workflowId);
      setMine((rows) => (rows ?? []).filter((w) => w.workflowId !== workflowId));
    } catch {
      setError(t('removeError'));
    } finally {
      setRemoving(null);
    }
  };

  useEffect(() => {
    if (!access.enabled) return;
    let live = true;
    listWorkflowSummaries()
      .then((rows) => { if (live) { setMineFailed(false); setMine(rows.filter((w) => w.workflowId.startsWith('walkthrough.'))); } })
      .catch(() => {
        if (!live) return;
        setError(t('loadError'));
        setMineFailed(true);
      });
    return () => { live = false; };
  }, [access.enabled, t]);

  if (access.loading) return <div className="u-p-4"><StateCard loading title={t('common:loading')} /></div>;
  if (!access.enabled) {
    return (
      <section>
        <PageHeader eyebrow={t('pageEyebrow')} title={t('pageTitle')} lede={t('pageLede')} />
        <Notice variant="info">{t('disabledBody')}</Notice>
      </section>
    );
  }

  return (
    <section data-walkthrough="walkthroughs.page">
      <PageHeader
        eyebrow={t('pageEyebrow')}
        title={t('pageTitle')}
        lede={t('pageLede')}
        actions={<Button variant="accent-solid" size="sm" onClick={() => requestWalkthroughRecord()}>{t('recordWalkthrough')}</Button>}
      />

      {error ? <Notice variant="error">{error}</Notice> : null}

      <div className="workflows-section">
        <div className="workflows-section-header"><h2>{t('yourWalkthroughsTitle')}</h2><span className="muted">{t('yourWalkthroughsHint')}</span></div>
        {mine === null && mineFailed ? (
          <StateCard announce title={t('walkLoadFailedTitle')} body={t('walkLoadFailedBody')} />
        ) : mine === null ? (
          <StateCard loading title={t('common:loading')} />
        ) : mine.length === 0 ? (
          <StateCard
            title={t('noWalkthroughsTitle')}
            body={t('noWalkthroughsBody')}
            action={<Button variant="secondary" size="sm" onClick={() => nav('/example-data')}>{t('loadSamples')}</Button>}
          />
        ) : (
          <div className="card-grid">
            {mine.map((w) => (
              <div key={w.workflowId} className="surface-card">
                <div className="workflow-card-title-row">
                  <h3 className="workflow-card-title">{w.name}</h3>
                  {w.transient ? <span className="chip chip--muted">{t('draftChip')}</span> : <span className="chip chip--success">{t('savedChip')}</span>}
                </div>
                <div className="workflow-card-meta muted"><span>{t('stepCount', { n: w.nodeCount })}</span></div>
                <FunnelStats walkthroughId={w.workflowId} />
                <div className="workflow-template-actions u-justify-end u-mt-2 action-bar">
                  {/* ADR 0435 — every listed walkthrough is tenant-owned, so it
                      carries the same remove verb the workflows dashboard uses
                      (archive: reversible, and it preserves the run history the
                      funnel reads). Seeded samples clear here or from
                      /example-data. */}
                  <Button variant="quiet" size="sm" onClick={() => void remove(w.workflowId)} disabled={removing === w.workflowId}>
                    {removing === w.workflowId ? t('common:loading') : t('removeWalkthrough')}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => nav(`/builder/${w.workflowId}`)}>{t('reviewInBuilder')}</Button>
                  <Button variant="accent" size="sm" onClick={() => requestWalkthroughLaunch(w.workflowId)}>{t('play')}</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

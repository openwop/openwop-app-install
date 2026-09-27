/**
 * `/runtime-posture` (Settings → Deployment → Runtime posture) — superadmin view
 * of the Cloud Run posture this host runs with (ADR 0742): warm (1 instance, CPU
 * always allocated) or cold (scale to zero, CPU only during requests).
 *
 * Everything shown is read back LIVE from Cloud Run by the backend, never from
 * this app's own state. A change request is audited and returns the commands to
 * run; nothing is applied from here, because the host deliberately holds no
 * write credential on its own service.
 *
 * @see docs/adr/0742-runtime-posture-admin.md
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button.js';
import { PageHeader } from '../ui/PageHeader.js';
import { Notice } from '../ui/Notice.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { StateCard } from '../ui/StateCard.js';
import { toast } from '../ui/toast.js';
import { formatCurrency, formatDateTime } from '../i18n/format.js';
import {
  getRuntimePosture,
  requestPostureChange,
  RuntimePostureRequestError,
  type PostureChangeRequest,
  type RuntimePosture,
} from '../client/runtimePostureClient.js';
import { useEffectiveAccessState } from '../client/useEffectiveAccess.js';

export function RuntimePosturePage(): JSX.Element {
  const { t } = useTranslation('settings');
  // ADR 0742 defect 1 (MEASURED on rev 00737-vkq by a peer session): this page
  // used to fetch on mount, which is BEFORE the session binds its identity —
  // the Cloud Run log shows the panel's 403 at 08:25:52.853 and the OIDC bind
  // landing at 08:25:55.413, 2.6 s later. A superadmin landing directly on the
  // page saw "This is a failed read, not a posture" on a working system: honest
  // about the read, wrong about the cause. Wait for the access read to RESOLVE
  // (the same `useEffectiveAccessState` the nav rails gate on, which re-resolves
  // on auth change) and re-fetch when authority changes.
  const { access, resolved } = useEffectiveAccessState();
  const [view, setView] = useState<RuntimePosture | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [request, setRequest] = useState<PostureChangeRequest | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setDenied(false);
    try {
      setView(await getRuntimePosture());
    } catch (err) {
      // 401/403 is an AUTHORITY answer, not a broken read. Separated so the
      // failed-read card keeps meaning "the read failed", which is what makes it
      // worth announcing.
      if (err instanceof RuntimePostureRequestError && (err.status === 401 || err.status === 403)) {
        setDenied(true);
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!resolved) return;          // the session has not answered yet — asking now measures the anonymous session
    void load();
  }, [load, resolved, access.superadmin]);

  const onRequest = useCallback(async (warm: boolean) => {
    setBusy(true);
    try {
      const r = await requestPostureChange(warm);
      setRequest(r);
      toast.success(t('rpRequested'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const postureName = (p: 'warm' | 'cold' | 'custom'): string =>
    p === 'warm' ? t('rpPostureWarm') : p === 'cold' ? t('rpPostureCold') : t('rpPostureCustom');

  return (
    <div className="page-shell" data-walkthrough="runtime-posture.page">
      <PageHeader eyebrow={t('rpEyebrow')} title={t('rpTitle')} lede={t('rpLede')} />
      {view === null && !resolved ? (
        <SkeletonRows rows={3} columns={['40%', '60%']} />
      ) : view === null && denied ? (
        <StateCard
          title={t('rpDeniedTitle')}
          body={t(access.superadmin ? 'rpDeniedBodySuperadmin' : 'rpDeniedBody')}
          action={<Button variant="secondary" onClick={() => void load()}>{t('rpRetry')}</Button>}
        />
      ) : view === null && error ? (
        <StateCard
          announce
          title={t('rpLoadFailedTitle')}
          body={t('rpLoadFailedBody')}
          action={<Button variant="secondary" onClick={() => void load()}>{t('rpRetry')}</Button>}
        />
      ) : view === null ? (
        <SkeletonRows rows={3} columns={['40%', '60%']} />
      ) : !view.available ? (
        <StateCard
          announce
          title={t('rpUnavailableTitle')}
          body={t('rpUnavailableBody', { reason: view.reason })}
          action={<Button variant="secondary" onClick={() => void load()}>{t('rpRetry')}</Button>}
        />
      ) : (
        <>
          {view.rollout === 'not-live' ? (
            <Notice variant="warning">
              {view.pendingRevision
                ? t('rpNotLive', { rev: view.pendingRevision, serving: view.servingRevision ?? '—' })
                : t('rpNotLiveSplit')}
            </Notice>
          ) : (
            <Notice variant="info">{t('rpSettled', { rev: view.servingRevision ?? '—' })}</Notice>
          )}

          <section className="surface-card u-mt-3" aria-label={t('rpCurrentLabel')}>
            <h2>{t('rpCurrentLabel')}: {view.serving ? postureName(view.serving.posture) : '—'}</h2>
            {view.serving ? (
              <p className="u-text-sm">
                {t('rpDetail', {
                  min: view.serving.minInstances,
                  cpu: view.serving.cpuThrottled ? t('rpCpuThrottled') : t('rpCpuAlways'),
                  rev: view.servingRevision ?? '—',
                })}
              </p>
            ) : null}
            <p className="u-text-sm muted">{t('rpReadAt', { at: formatDateTime(view.readAt), service: view.service, region: view.region })}</p>
          </section>

          <div className="u-grid-2 u-mt-3">
            <section className="surface-card" aria-label={t('rpPostureWarm')}>
              <h3>{t('rpPostureWarm')}</h3>
              <p className="u-text-sm">{t('rpOptionWarmBody')}</p>
              <p><strong>{t('rpCostWarm', { cost: formatCurrency(view.monthlyCostUsd.warm, 'USD', { maximumFractionDigits: 0 }) })}</strong></p>
              <Button variant="accent-solid" disabled={busy} onClick={() => void onRequest(true)}>{t('rpRequestWarm')}</Button>
            </section>
            <section className="surface-card" aria-label={t('rpPostureCold')}>
              <h3>{t('rpPostureCold')}</h3>
              <p className="u-text-sm">{t('rpOptionColdBody')}</p>
              <p><strong>{t('rpCostCold', { cost: formatCurrency(view.monthlyCostUsd.cold, 'USD', { maximumFractionDigits: 0 }) })}</strong></p>
              <Button variant="secondary" disabled={busy} onClick={() => void onRequest(false)}>{t('rpRequestCold')}</Button>
            </section>
          </div>
          <p className="u-text-sm muted u-mt-2">{t('rpCostNote')}</p>
          <Notice variant="info">{t('rpRolloutNote')}</Notice>

          {request ? (
            <section className="surface-card u-mt-3" aria-label={t('rpCommandsLabel')}>
              <h3>{request.noop ? t('rpRequestNoop') : t('rpCommandsLabel')}</h3>
              <p className="u-text-sm">{t('rpCommandsHelp')}</p>
              <pre className="u-mono">{request.commands.join('\n')}</pre>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

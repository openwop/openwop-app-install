/**
 * ADR 0961 P0 — the campaign autopilot on the campaign itself: the preflight
 * checklist (what the campaign still needs) and the Launch action.
 *
 * Lazy-loaded by the campaign detail (`CampaignDetailPage`) only when the
 * `campaign-autopilot` toggle is visible, so it costs the entry chunk nothing.
 * Every item is a labeled status chip (never color alone). A failed read is
 * said, never shown as "ready". The server decides readiness and access; the
 * button only reflects them.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { InlineState } from '../../ui/InlineState.js';
import { Notice } from '../../ui/Notice.js';
import { AutopilotError, getPreflight, launchAutopilot, type Preflight, type PreflightItem } from './autopilotClient.js';

type Load = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; preflight: Preflight; canLaunch: boolean };
type Launch = { kind: 'idle' } | { kind: 'busy' } | { kind: 'launched'; reused: boolean } | { kind: 'failed'; forbidden: boolean };

const CHIP: Record<PreflightItem['status'], string> = { ok: 'chip chip--success', missing: 'chip chip--danger', warn: 'chip chip--warning' };

/** `messaging.primaryValueProp` → `missing_messaging_primaryValueProp` (i18next reads dots as nesting). */
const missingKey = (code: string): string => `missing_${code.replace(/[^A-Za-z0-9]/g, '_')}`;

export function AutopilotSection({ campaignId }: { campaignId: string }): JSX.Element {
  const { t } = useTranslation('campaign-autopilot');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [launch, setLaunch] = useState<Launch>({ kind: 'idle' });

  const refresh = useCallback(async () => {
    setLoad({ kind: 'loading' });
    try { setLoad({ kind: 'ready', ...(await getPreflight(campaignId)) }); } catch { setLoad({ kind: 'failed' }); }
  }, [campaignId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const onLaunch = async (): Promise<void> => {
    setLaunch({ kind: 'busy' });
    try {
      const out = await launchAutopilot(campaignId);
      setLaunch({ kind: 'launched', reused: out.reused });
    } catch (e) {
      setLaunch({ kind: 'failed', forbidden: e instanceof AutopilotError && e.status === 403 });
    }
  };

  const ready = load.kind === 'ready' && load.preflight.ready;
  const viewOnly = load.kind === 'ready' && !load.canLaunch;
  return (
    <section className="surface-card u-mb-4" aria-labelledby="campaign-autopilot">
      <h3 id="campaign-autopilot" className="u-mt-0">{t('title')}</h3>
      <p className="muted u-mt-0">{t('lede')}</p>
      {load.kind === 'loading' ? <InlineState kind="loading" message={t('loading')} /> : null}
      {load.kind === 'failed' ? (
        <InlineState kind="failed" announce={t('loadFailed')} announcePolite message={t('loadFailed')}
          action={<Button variant="secondary" size="sm" onClick={() => void refresh()}>{t('retry')}</Button>} />
      ) : null}
      {load.kind === 'ready' ? (
        <ul className="u-list-none u-p-0 u-m-0 u-mb-3" aria-label={t('checklistLabel')}>
          {load.preflight.items.map((item) => (
            <li key={item.id} className="u-flex u-items-center u-gap-2 u-mb-2">
              <span className={CHIP[item.status]}>{t(`status_${item.status}`)}</span>
              <span>{t(`item_${item.id}`)}{item.blocking && item.status !== 'ok' ? <span className="muted"> · {t('blocking')}</span> : null}</span>
              {item.missing?.length ? (
                <span className="muted u-fs-13">— {item.missing.map((m) => t(missingKey(m), { defaultValue: m })).join(', ')}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {load.kind === 'ready' && !ready ? <p className="muted u-fs-13">{t('notReady')}</p> : null}
      {viewOnly ? <p className="muted u-fs-13">{t('viewOnly')}</p> : null}
      {launch.kind === 'launched' ? (
        <Notice variant="success" announce={t(launch.reused ? 'launchedReused' : 'launched')}>{t(launch.reused ? 'launchedReused' : 'launched')}</Notice>
      ) : null}
      {launch.kind === 'failed' ? (
        <Notice variant="error" announce={t(launch.forbidden ? 'launchForbidden' : 'launchFailed')}>{t(launch.forbidden ? 'launchForbidden' : 'launchFailed')}</Notice>
      ) : null}
      <div className="u-flex u-gap-2">
        <Button variant="primary" size="sm" disabled={!ready || viewOnly || launch.kind === 'busy'} onClick={() => void onLaunch()}>
          {launch.kind === 'busy' ? t('launching') : t('launch')}
        </Button>
        <Button variant="secondary" size="sm" disabled={load.kind === 'loading'} onClick={() => void refresh()}>{t('recheck')}</Button>
      </div>
    </section>
  );
}

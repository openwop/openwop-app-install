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
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunConfigurable } from '@openwop/openwop';
import { onAuthChange } from '../../client/config.js';
import { RunInputsDialog } from '../../ui/RunInputsForm.js';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { InlineState } from '../../ui/InlineState.js';
import { Notice } from '../../ui/Notice.js';
import { AutopilotError, getPreflight, launchAutopilot, type Preflight, type PreflightItem, type LaunchAiInput } from './autopilotClient.js';

type Load = { kind: 'loading' } | { kind: 'failed'; epoch: number } | { kind: 'ready'; epoch: number; preflight: Preflight; canLaunch: boolean };
type Launch = { kind: 'idle' } | { kind: 'busy'; epoch: number } | { kind: 'launched'; epoch: number; reused: boolean } | { kind: 'failed'; epoch: number; forbidden: boolean; ai: boolean };

const CHIP: Record<PreflightItem['status'], string> = { ok: 'chip chip--success', missing: 'chip chip--danger', warn: 'chip chip--warning' };

/** `messaging.primaryValueProp` → `missing_messaging_primaryValueProp` (i18next reads dots as nesting). */
const missingKey = (code: string): string => `missing_${code.replace(/[^A-Za-z0-9]/g, '_')}`;

export function AutopilotSection({ campaignId }: { campaignId: string }): JSX.Element {
  const { t } = useTranslation('campaign-autopilot');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [launch, setLaunch] = useState<Launch>({ kind: 'idle' });

  const generation = useRef(0);
  const currentCampaign = useRef(campaignId);
  const reads = useRef(0);
  const inFlight = useRef(false);
  const [options, setOptions] = useState<{ epoch: number; campaignId: string } | null>(null);
  if (currentCampaign.current !== campaignId) {
    currentCampaign.current = campaignId;
    generation.current += 1;
  }
  const refresh = useCallback(async () => {
    const epoch = generation.current;
    const request = ++reads.current;
    setLoad({ kind: 'loading' });
    try {
      const result = await getPreflight(campaignId);
      if (epoch === generation.current && request === reads.current && currentCampaign.current === campaignId) setLoad({ kind: 'ready', epoch, ...result });
    } catch {
      if (epoch === generation.current && request === reads.current && currentCampaign.current === campaignId) setLoad({ kind: 'failed', epoch });
    }
  }, [campaignId]);
  useEffect(() => {
    // StrictMode cleanup invalidates old work; the next setup performs a fresh read.
    inFlight.current = false;
    setLaunch({ kind: 'idle' });
    setOptions(null);
    void refresh();
    const unsubscribe = onAuthChange(() => {
      generation.current += 1;
      inFlight.current = false;
      setOptions(null);
      setLaunch({ kind: 'idle' });
      void refresh();
    });
    return () => { generation.current += 1; reads.current += 1; unsubscribe(); };
  }, [refresh]);
  const visibleLoad: Load = load.kind !== 'loading' && load.epoch === generation.current ? load : { kind: 'loading' };

  const onLaunch = async (epoch: number, configurable?: RunConfigurable): Promise<void> => {
    if (epoch !== generation.current || currentCampaign.current !== campaignId || inFlight.current
      || visibleLoad.kind !== 'ready' || !visibleLoad.preflight.ready || !visibleLoad.canLaunch) return;
    const credentialRef = configurable?.ai?.credentialRef;
    const ai: LaunchAiInput | undefined = credentialRef ? { credentialRef } : undefined;
    inFlight.current = true;
    setLaunch({ kind: 'busy', epoch });
    try {
      const out = ai ? await launchAutopilot(campaignId, ai) : await launchAutopilot(campaignId);
      if (epoch === generation.current && currentCampaign.current === campaignId) setLaunch({ kind: 'launched', epoch, reused: out.reused });
    } catch (e) {
      if (epoch === generation.current && currentCampaign.current === campaignId) setLaunch({ kind: 'failed', epoch, forbidden: e instanceof AutopilotError && e.status === 403, ai: e instanceof AutopilotError && e.reason?.startsWith('campaign_ai_') === true });
    } finally { if (epoch === generation.current) inFlight.current = false; }
  };

  const visibleLaunch: Launch = launch.kind === 'idle' || launch.epoch === generation.current ? launch : { kind: 'idle' };
  const ready = visibleLoad.kind === 'ready' && visibleLoad.preflight.ready;
  const viewOnly = visibleLoad.kind === 'ready' && !visibleLoad.canLaunch;
  return (
    <section className="surface-card u-mb-4" aria-labelledby="campaign-autopilot">
      <h3 id="campaign-autopilot" className="u-mt-0">{t('title')}</h3>
      <p className="muted u-mt-0">{t('lede')}</p>
      {visibleLoad.kind === 'loading' ? <InlineState kind="loading" message={t('loading')} /> : null}
      {visibleLoad.kind === 'failed' ? (
        <InlineState kind="failed" announce={t('loadFailed')} announcePolite message={t('loadFailed')}
          action={<Button variant="secondary" size="sm" onClick={() => void refresh()}>{t('retry')}</Button>} />
      ) : null}
      {visibleLoad.kind === 'ready' ? (
        <ul className="u-list-none u-p-0 u-m-0 u-mb-3" aria-label={t('checklistLabel')}>
          {visibleLoad.preflight.items.map((item) => (
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
      {visibleLoad.kind === 'ready' && !ready ? <p className="muted u-fs-13">{t('notReady')}</p> : null}
      {viewOnly ? <p className="muted u-fs-13">{t('viewOnly')}</p> : null}
      {visibleLaunch.kind === 'launched' ? (
        <Notice variant="success" announce={t(visibleLaunch.reused ? 'launchedReused' : 'launched')}>{t(visibleLaunch.reused ? 'launchedReused' : 'launched')}</Notice>
      ) : null}
      {visibleLaunch.kind === 'failed' ? (
        <Notice variant="error" announce={t(visibleLaunch.ai ? 'launchAiFailed' : visibleLaunch.forbidden ? 'launchForbidden' : 'launchFailed')}>{t(visibleLaunch.ai ? 'launchAiFailed' : visibleLaunch.forbidden ? 'launchForbidden' : 'launchFailed')}</Notice>
      ) : null}
      <p className="muted u-fs-13">{t('launchOptionsHelp')}</p>
      <div className="u-flex u-gap-2">
        <Button variant="primary" size="sm" disabled={!ready || viewOnly || visibleLaunch.kind === 'busy'} onClick={() => { if (ready && !viewOnly && currentCampaign.current === campaignId && visibleLoad.kind === 'ready' && visibleLoad.epoch === generation.current) setOptions({ epoch: generation.current, campaignId }); }}>
          {visibleLaunch.kind === 'busy' ? t('launching') : t('launch')}
        </Button>
        <Button variant="secondary" size="sm" disabled={visibleLoad.kind === 'loading'} onClick={() => void refresh()}>{t('recheck')}</Button>
      </div>
      {options && options.epoch === generation.current && options.campaignId === campaignId ? (
        <RunInputsDialog key={`${options.campaignId}:${options.epoch}`} workflowName={t('title')} variables={[]} aiKeyOption
          onCancel={() => setOptions(null)} onRun={(_inputs, configurable) => {
            const epoch = options.epoch;
            setOptions(null);
            void onLaunch(epoch, configurable);
          }} />
      ) : null}
    </section>
  );
}

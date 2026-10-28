/**
 * ADR 0952 D4 — a pacing or spend-cap alert links here with ONE action staged
 * (`stage=pause|reallocate|raise-cap`). The alert never changed anything; this
 * card says what the action does and lets a person confirm it:
 *  - pause: pauses every platform campaign of the campaign (ungated: stopping
 *    spend is the safe direction);
 *  - reallocate: proposes ONE plan that waits for approval (no budget changes);
 *  - raise-cap: points at the cap in the caps panel below.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { pauseCampaign, proposeReallocationPlan } from './campaignIntelClient.js';

export type StagedAction = 'pause' | 'reallocate' | 'raise-cap';
export const isStagedAction = (v: string | null): v is StagedAction => v === 'pause' || v === 'reallocate' || v === 'raise-cap';

export function StagedAlertAction({ action, orgId, campaignId, campaignName, onProposed }: {
  action: StagedAction;
  orgId: string;
  campaignId?: string | null;
  campaignName?: string;
  /** Called after a plan is proposed, so the plans panel reloads. */
  onProposed: () => void;
}): JSX.Element | null {
  const { t } = useTranslation('campaign-intel');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ variant: 'success' | 'error' | 'info'; text: string } | null>(null);

  if (action === 'pause' && !campaignId) return null;

  const doPause = async (): Promise<void> => {
    if (!campaignId) return;
    setBusy(true);
    try {
      const r = await pauseCampaign(orgId, campaignId);
      const ok = r.results.filter((x) => x.outcome === 'updated' || x.outcome === 'unchanged').length;
      const failed = r.results.length - ok;
      setResult(r.results.length === 0
        ? { variant: 'info', text: t('stagePauseNothing') }
        : { variant: failed > 0 ? 'error' : 'success', text: t('stagePauseResult', { count: ok, ok, failed }) });
    } catch (e) {
      setResult({ variant: 'error', text: e instanceof Error && e.message ? e.message : t('stageFailed') });
    } finally { setBusy(false); }
  };

  const doPropose = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await proposeReallocationPlan(orgId);
      setResult(r.outcome === 'proposed'
        ? { variant: 'success', text: t('stageProposed', { count: r.plan.ops.length }) }
        : { variant: 'info', text: t('stageNoChange') });
      onProposed();
    } catch (e) {
      setResult({ variant: 'error', text: e instanceof Error && e.message ? e.message : t('stageFailed') });
    } finally { setBusy(false); }
  };

  return (
    <section className="surface-card u-mb-4" aria-labelledby="staged-action-title">
      <h2 id="staged-action-title" className="u-mt-0 u-fs-15">{t('stageTitle')}</h2>
      <p className="u-fs-13 u-mt-0">
        {action === 'pause' ? t('stagePauseBody', { name: campaignName ?? campaignId ?? '' })
          : action === 'reallocate' ? t('stageReallocateBody')
          : t('stageRaiseCapBody')}
      </p>
      {action === 'pause' ? <Button size="sm" variant="primary" disabled={busy} onClick={() => { void doPause(); }}>{t('stagePauseButton')}</Button> : null}
      {action === 'reallocate' ? <Button size="sm" variant="primary" disabled={busy} onClick={() => { void doPropose(); }}>{t('stageReallocateButton')}</Button> : null}
      {result ? <Notice announce={result.text} variant={result.variant}>{result.text}</Notice> : null}
    </section>
  );
}

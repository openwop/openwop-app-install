/**
 * ADR 0942 P4b — steps of this campaign that will run when their review window
 * ends, unless one of the people the policy notifies vetoes them. Lazy-loaded by
 * the campaign detail beside the review-policy panel. Hidden when there are none
 * or the autonomy toggle is off. Who may veto is the SERVER's answer (`canVeto`).
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../ui/Button.js';
import { ConfirmDialog } from '../../../ui/ConfirmDialog.js';
import { TextField } from '../../../ui/Field.js';
import { InlineState } from '../../../ui/InlineState.js';
import { toast } from '../../../ui/toast.js';
import { formatDateTime } from '../../../i18n/format.js';
import { BellIcon } from '../../../ui/icons/index.js';
import { AutonomyDisabledError, castVeto, listVetoWindows, type VetoWindow } from './autonomyClient.js';

const classKey = (actionClass: string): string => `autClass_${actionClass.replace(/[.-]/g, '_')}`;

export default function VetoWindowsSection({ campaignId }: { campaignId: string }): JSX.Element | null {
  const { t } = useTranslation('campaign-orchestration');
  const headingId = useId();
  const [windows, setWindows] = useState<VetoWindow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [confirming, setConfirming] = useState<VetoWindow | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setWindows(await listVetoWindows(campaignId)); setFailed(false); } catch (e) {
      if (e instanceof AutonomyDisabledError) setHidden(true); else setFailed(true);
    }
  }, [campaignId]);
  useEffect(() => { void refresh(); }, [refresh]);

  if (hidden || (windows && windows.length === 0)) return null;
  return (
    <section className="surface-card u-mb-4" aria-labelledby={headingId}>
      <div className="u-flex u-items-center u-gap-2 u-mb-2">
        <BellIcon size={16} />
        <h3 id={headingId} className="u-m-0">{t('vetoTitle')}</h3>
      </div>
      <p className="muted u-mt-0">{t('vetoLede')}</p>
      {failed ? (
        <InlineState kind="failed" message={t('vetoLoadFailed')} announce={t('vetoLoadFailed')} announcePolite
          action={<Button variant="secondary" size="sm" onClick={() => void refresh()}>{t('autRetry')}</Button>} />
      ) : null}
      {!windows && !failed ? <InlineState kind="loading" message={t('vetoLoading')} /> : null}
      {windows && windows.length > 0 ? (
        <ul className="u-list-none u-p-0 u-m-0 u-grid u-gap-2">
          {windows.map((w) => (
            <li key={w.vetoId} className="u-flex u-flex-wrap u-items-center u-gap-2">
              <span className="u-fw-600">{t(classKey(w.actionClass), { defaultValue: w.actionClass })}</span>
              <span className="muted u-fs-13">{t('vetoRunsAt', { when: formatDateTime(w.deadline) })}</span>
              {w.canVeto ? (
                <Button variant="danger" size="sm" onClick={() => { setReason(''); setError(null); setConfirming(w); }}>{t('vetoAction')}</Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          title={t('vetoConfirmTitle', { step: t(classKey(confirming.actionClass), { defaultValue: confirming.actionClass }) })}
          body={(
            <>
              <p className="u-mt-0">{t('vetoConfirmBody')}</p>
              <TextField label={t('vetoReason')} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
            </>
          )}
          confirmLabel={t('vetoAction')}
          danger
          busy={busy}
          error={error ?? undefined}
          errorAnnounce={error ?? undefined}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setBusy(true); setError(null);
            void castVeto(campaignId, confirming.vetoId, reason.trim())
              .then(() => { setConfirming(null); toast.success(t('vetoDone')); void refresh(); })
              .catch((e: unknown) => setError(e instanceof Error ? e.message : t('vetoFailed')))
              .finally(() => setBusy(false));
          }}
        />
      ) : null}
    </section>
  );
}

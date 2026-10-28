/**
 * ADR 0958 P3 — files collaborators sent for this client, waiting for review.
 * Accepting puts them in the client's media library, with who supplied them and
 * on what rights; rejecting tells the collaborator why, and the files are
 * deleted 30 days later. Nothing here is usable until it is accepted.
 *
 * Lazy (own chunk). Renders nothing when external collaborators are off. A
 * failed read is said with a retry, never shown as "nothing waiting". The
 * files are downloads, never previews in the app: they are unreviewed.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { InlineState } from '../../ui/InlineState.js';
import { Notice } from '../../ui/Notice.js';
import { TextField } from '../../ui/Field.js';
import { formatBytes, formatDate } from '../../i18n/format.js';
import { CampaignOpsError } from './campaignOpsClient.js';
import { acceptClientIntake, downloadIntakeFile, listClientIntakes, rejectClientIntake, type AgencyIntake } from './intakeClient.js';

type Load = { kind: 'loading' } | { kind: 'off' } | { kind: 'failed' } | { kind: 'ready'; intakes: AgencyIntake[] };
type TFn = ReturnType<typeof useTranslation>['t'];

const isOff = (e: unknown): boolean => e instanceof CampaignOpsError && e.status === 404 && /not enabled/i.test(e.message);
const errorText = (e: unknown, t: TFn): string => (e instanceof CampaignOpsError && e.message ? e.message : t('intakeActionFailed'));

function rightsText(i: AgencyIntake, t: TFn): string {
  const parts = [t(`intakeLicense_${i.rights.license.replace(/-/g, '_')}`)];
  if (i.rights.termEndsAt) parts.push(t('intakeUntil', { date: formatDate(`${i.rights.termEndsAt}T00:00:00Z`, { timeZone: 'UTC' }) }));
  parts.push(i.rights.modelReleases ? t('intakeReleasesYes') : t('intakeReleasesNo'));
  if (i.rights.credit) parts.push(t('intakeCredit', { credit: i.rights.credit }));
  return parts.join(' · ');
}

export function ClientIntakeSection({ orgId }: { orgId: string }): JSX.Element | null {
  const { t } = useTranslation('campaign-ops');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const refresh = useCallback(async () => {
    try { setLoad({ kind: 'ready', intakes: await listClientIntakes(orgId) }); }
    catch (e) { setLoad(isOff(e) ? { kind: 'off' } : { kind: 'failed' }); }
  }, [orgId]);
  useEffect(() => { setLoad({ kind: 'loading' }); void refresh(); }, [refresh]);

  const run = async (id: string, fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(id); setError(null); setStatus(null);
    try { await fn(); setStatus(done); setRejecting(null); setReason(''); await refresh(); }
    catch (e) { setError(errorText(e, t)); }
    finally { setBusy(null); }
  };

  if (load.kind === 'off') return null;
  const waiting = load.kind === 'ready' ? load.intakes.filter((i) => i.status === 'submitted') : [];
  const decided = load.kind === 'ready' ? load.intakes.filter((i) => i.status !== 'submitted').slice(0, 10) : [];
  return (
    <section className="surface-card" aria-labelledby="campaign-ops-intakes">
      <h3 id="campaign-ops-intakes" className="u-mt-0 u-fs-15">{t('intakeHeading')}</h3>
      <p className="muted u-fs-13 u-mt-0">{t('intakeIntro')}</p>
      {load.kind === 'loading' ? <InlineState kind="loading" message={t('intakeLoading')} /> : null}
      {load.kind === 'failed' ? (
        <InlineState kind="failed" announce={t('intakeLoadFailed')} announcePolite message={t('intakeLoadFailed')}
          action={<Button variant="secondary" size="sm" onClick={() => void refresh()}>{t('intakeRetry')}</Button>} />
      ) : null}
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      {status ? <Notice variant="success" announce={status}>{status}</Notice> : null}
      {load.kind === 'ready' && waiting.length === 0 ? <p className="muted u-mb-0">{t('intakeEmpty')}</p> : null}
      {waiting.length > 0 ? (
        <ul className="u-list-plain u-grid u-gap-3 u-m-0">
          {waiting.map((i) => (
            <li key={i.intakeId} className="u-grid u-gap-1">
              <span className="u-flex u-flex-wrap u-gap-2 u-items-center">
                <span className="u-fw-600">{i.collaborator?.displayName ?? t('intakeUnknownSender')}</span>
                <span className="muted u-fs-13">{t('intakeSentOn', { date: formatDate(i.submittedAt) })}</span>
                {i.files.some((f) => f.scan !== 'clean') ? <span className="chip chip--warning">{t('intakeNotScanned')}</span> : null}
              </span>
              <span className="u-fs-13">{rightsText(i, t)}</span>
              {i.note ? <span className="u-fs-13">{t('intakeNote', { note: i.note })}</span> : null}
              <ul className="u-m-0 u-fs-13">
                {i.files.map((f) => (
                  <li key={f.fileId}>
                    <Button variant="link" disabled={busy !== null} onClick={() => void downloadIntakeFile(orgId, i.intakeId, f).catch((e: unknown) => setError(errorText(e, t)))}
                      aria-label={t('intakeDownloadAria', { name: f.name })}>{f.name}</Button>
                    {' '}<span className="muted">{formatBytes(f.bytes)}</span>
                  </li>
                ))}
              </ul>
              {rejecting === i.intakeId ? (
                <div className="action-bar u-flex u-items-end u-gap-2">
                  <TextField label={t('intakeRejectReason')} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className="u-mb-0" />
                  <Button variant="secondary" size="sm" disabled={busy !== null || !reason.trim()} onClick={() => void run(i.intakeId, () => rejectClientIntake(orgId, i.intakeId, reason.trim()), t('intakeRejected'))}>{t('intakeRejectConfirm')}</Button>
                  <Button variant="link" onClick={() => { setRejecting(null); setReason(''); }}>{t('intakeCancel')}</Button>
                </div>
              ) : (
                <div className="action-bar u-flex u-gap-2">
                  <Button variant="primary" size="sm" loading={busy === i.intakeId} disabled={busy !== null || i.accepting} onClick={() => void run(i.intakeId, () => acceptClientIntake(orgId, i.intakeId), t('intakeAccepted', { count: i.files.length }))}>{t('intakeAccept')}</Button>
                  <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => { setRejecting(i.intakeId); setReason(''); }}>{t('intakeReject')}</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {decided.length > 0 ? (
        <details className="u-mt-3">
          <summary className="u-fs-13">{t('intakeDecided', { count: decided.length })}</summary>
          <ul className="u-m-0 u-fs-13">
            {decided.map((i) => (
              <li key={i.intakeId}>
                {i.collaborator?.displayName ?? t('intakeUnknownSender')} · {t(`intakeStatus_${i.status}`)} · {i.files.map((f) => f.name).join(', ')}
                {i.reason ? ` · ${i.reason}` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

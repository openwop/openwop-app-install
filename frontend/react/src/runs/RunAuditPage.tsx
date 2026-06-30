/**
 * Dedicated per-run audit-log viewer.
 *
 * The shipped per-run Operations panel (`RunOpsPanel.tsx`) has an inline
 * "Verify audit integrity" button that shows a compact one-line result.
 * This page is the full surface called for in plan Item #13:
 *
 *   - re-runs `client.audit.verify(0, lastSeq)` on mount + on click
 *   - shows the chain-valid status as a prominent banner
 *   - lists every signed checkpoint with its merkle root + signature,
 *     ordered by sequence — the "audit timeline"
 *   - lists every detected anomaly with full expected/actual hashes
 *     (not just the short prefixes the side panel shows)
 *   - exports the full `AuditVerifyResult` as JSON for offline review
 *     or out-of-band re-verification via `scripts/verify-audit-checkpoints.mjs`
 *
 * Capability-gated on the host advertising the
 * `openwop-audit-log-integrity` auth profile (`spec/v1/auth-profiles.md`).
 * When absent, the page renders an explanatory placeholder rather than
 * 500'ing on the `audit.verify` call.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import type { AuditVerifyResult, RunEventDoc } from '@openwop/openwop';
import { getSdkClient, getCapabilities, pollEvents } from '../client/runsClient.js';
import { ArrowLeftIcon, CheckIcon, XIcon } from '../ui/icons/index.js';
import { Notice } from '../ui/Notice.js';
import { formatNumber } from '../i18n/format.js';

export function RunAuditPage() {
  const { t } = useTranslation('runs');
  const { runId = '' } = useParams();
  const [auditProfile, setAuditProfile] = useState<boolean | null>(null);
  const [events, setEvents] = useState<RunEventDoc[]>([]);
  const [result, setResult] = useState<AuditVerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The largest `toSeq` we've already verified. We auto-re-verify on
  // every increase so a run that extends after page load gets re-verified
  // without a manual button press, but we DON'T re-verify when state
  // updates that leave `lastSeq` unchanged (e.g., the verify call
  // returning, which would otherwise loop). The button always re-runs.
  const lastVerifiedSeqRef = useRef<number>(-1);

  // Gate the page on the host advertising openwop-audit-log-integrity.
  // Without the profile the audit.verify endpoint 404s, so it's better
  // to render a friendly explainer than to surface a network error.
  useEffect(() => {
    let cancelled = false;
    getCapabilities()
      .then((caps) => {
        const profiles = ((caps.auth as { profiles?: string[] } | undefined)?.profiles) ?? [];
        if (!cancelled) setAuditProfile(profiles.includes('openwop-audit-log-integrity'));
      })
      .catch(() => { if (!cancelled) setAuditProfile(false); });
    return () => { cancelled = true; };
  }, []);

  // Replay the public event log so we know lastSeq — verify(0, lastSeq)
  // covers the full run. Re-runs once on initial render; the user can
  // re-verify via the button if the run extends after this page loads.
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    pollEvents(runId, 0)
      .then((poll) => { if (!cancelled) setEvents([...poll.events]); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [runId]);

  const lastSeq = events.reduce((m, e) => Math.max(m, e.sequence), 0);

  const runVerify = useCallback(async () => {
    if (auditProfile !== true) return;
    setVerifying(true);
    setError(null);
    // Remember the seq we're verifying at *call* time so a `lastSeq`
    // change during the in-flight request doesn't make the auto-verify
    // effect think we're still behind.
    const targetSeq = lastSeq;
    try {
      const r = await getSdkClient().audit.verify(0, targetSeq);
      setResult(r);
      lastVerifiedSeqRef.current = targetSeq;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifying(false);
    }
  }, [auditProfile, lastSeq]);

  // Auto-verify on first load AND whenever lastSeq grows past the
  // largest seq we've already verified — so a long-running run that
  // emits more events while the page is open gets re-verified without
  // a manual button press. The ref-based gate avoids re-entrancy (the
  // verify result itself doesn't trigger another call).
  useEffect(() => {
    if (
      auditProfile === true &&
      lastSeq > 0 &&
      lastSeq > lastVerifiedSeqRef.current &&
      !verifying
    ) {
      void runVerify();
    }
  }, [auditProfile, lastSeq, verifying, runVerify]);

  function onDownload() {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `run-${runId}-audit-checkpoints.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <section className="card">
      <div className="audit-page__head">
        <h1 className="u-flex-1 u-m-0">{t('auditLogHeading')} <code className="u-fs-14">{runId}</code></h1>
        <Link to={`/runs/${runId}`} className="inline-link u-fs-13 u-ink-3"><ArrowLeftIcon size={13} /> {t('backToRun')}</Link>
      </div>
      <p className="muted u-fs-13 u-mt-0">
        {t('auditIntroPre')}<code>openwop-audit-log-integrity</code>{t('auditIntroMid1')}<code>client.audit.verify(0, {lastSeq})</code>{t('auditIntroMid2')}<code>AuditVerifyResult</code>{t('auditIntroMid3')}<code>scripts/verify-audit-checkpoints.mjs</code>{t('auditIntroPost')}
      </p>

      {auditProfile === false && (
        <Notice variant="warning">
          <strong>{t('auditProfileMissingPre')}<code>openwop-audit-log-integrity</code>{t('auditProfileMissingPost')}</strong>{' '}
          {t('auditEndpointUnavailablePre')}<code>auth.profiles</code>{t('auditEndpointUnavailableMid')}<code>/.well-known/openwop</code>{t('auditEndpointUnavailablePost')}
        </Notice>
      )}

      {auditProfile === true && (
        <>
          <div className="action-bar u-mb-3">
            <button type="button" onClick={() => void runVerify()} disabled={verifying || lastSeq === 0}>
              {verifying ? t('verifying') : t('reVerify')}
            </button>
            <button type="button" className="secondary" onClick={onDownload} disabled={!result}>
              {t('downloadCheckpoints')}
            </button>
          </div>

          {error && <Notice variant="error">{error}</Notice>}

          {result && (
            <>
              <div
                className={`alert ${result.chainValid ? 'success' : 'error'} u-mb-3`}
                role="status"
              >
                <strong>{result.chainValid ? <><CheckIcon size={14} /> {t('hashChainValid')}</> : <><XIcon size={14} /> {t('hashChainInvalid')}</>}</strong>
                {' — '}
                {t('auditSeqRange', { from: formatNumber(result.fromSeq), to: formatNumber(result.toSeq) })} ·{' '}
                {t('checkpointCount', { count: result.checkpoints.length })}
                {typeof result.checkpointsValid === 'boolean' && (
                  <>
                    {' · '}
                    {result.checkpointsValid ? t('checkpointSignaturesValid') : t('checkpointSignaturesInvalid')}
                  </>
                )}
                {result.anomalies.length > 0 && (
                  <>
                    {' · '}
                    {t('anomalyCount', { count: result.anomalies.length })}
                  </>
                )}
              </div>

              {result.anomalies.length > 0 && (
                <div className="card audit-anomaly-card">
                  <h2 className="u-fs-16 u-mt-0">{t('anomaliesHeading')}</h2>
                  <table className="audit-anomaly-table">
                    <thead>
                      <tr>
                        <th>{t('anomalyColAtSeq')}</th>
                        <th>{t('anomalyColExpected')}</th>
                        <th>{t('anomalyColActual')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.anomalies.map((a) => (
                        <tr key={a.atSeq}>
                          <td>{a.atSeq}</td>
                          <td className="audit-anomaly-table__hash">{a.expectedPrevHash}</td>
                          <td className="audit-anomaly-table__hash">{a.actualPrevHash}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="card u-mb-0">
                <h2 className="u-fs-16 u-mt-0">
                  {t('checkpointTimeline', { count: formatNumber(result.checkpoints.length) })}
                </h2>
                {result.checkpoints.length === 0 ? (
                  <p className="muted u-fs-12">
                    {t('noCheckpointsPre')}<code>capabilities.audit.checkpointInterval</code>{t('noCheckpointsPost')}
                  </p>
                ) : (
                  <ol className="audit-checkpoint-list">
                    {result.checkpoints.map((c) => (
                      <li key={c.atSequence} className="audit-checkpoint-row">
                        <span className="muted">{t('seqPrefix', { seq: formatNumber(c.atSequence) })}</span>
                        <div>
                          <div className="audit-checkpoint-row__field">
                            <strong>{t('checkpointFieldCheckpoint')}</strong> {c.checkpoint}
                          </div>
                          <div className="audit-checkpoint-row__field">
                            <strong>{t('checkpointFieldMerkleRoot')}</strong> {c.merkleRoot}
                          </div>
                          <div className="audit-checkpoint-row__field">
                            <strong>{t('checkpointFieldSignature')}</strong> {c.signature}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </>
          )}

          {!result && !error && auditProfile === true && (
            <p className="muted u-fs-13">
              {lastSeq === 0 ? t('loadingRunEvents') : t('runningInitialVerification')}
            </p>
          )}
        </>
      )}
    </section>
  );
}

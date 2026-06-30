/**
 * RunOpsPanel — operations surface for a run: audit-log verification
 * (RFC 0009/0010) and debug-bundle download (RFC 0009).
 *
 *  - "Verify integrity" calls the SDK `audit.verify(fromSeq, toSeq)`,
 *    which validates the append-only hash chain and returns signed
 *    checkpoints + any detected anomalies. Gated on the host advertising
 *    the `openwop-audit-log-integrity` auth profile; hidden otherwise.
 *  - "Download debug bundle" GETs `/v1/runs/:id/debug-bundle` (the
 *    production-profile bundle with truncation) and saves it as JSON for
 *    support/triage.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { AuditVerifyResult, RunEventDoc } from '@openwop/openwop';
import { getSdkClient, getCapabilities } from '../client/runsClient.js';
import { authedHeaders, config, fetchOpts } from '../client/config.js';
import { formatNumber } from '../i18n/format.js';

interface Props {
  runId: string;
  events: readonly RunEventDoc[];
}

export function RunOpsPanel({ runId, events }: Props) {
  const { t } = useTranslation('runs');
  const [auditProfile, setAuditProfile] = useState<boolean | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<AuditVerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Pre-flight the audit profile so we only show Verify when the host
  // actually advertises openwop-audit-log-integrity.
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

  const maxSeq = events.reduce((m, e) => Math.max(m, e.sequence), 0);

  async function onVerify() {
    setVerifying(true);
    setError(null);
    setResult(null);
    try {
      const res = await getSdkClient().audit.verify(0, maxSeq);
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifying(false);
    }
  }

  async function onDownloadBundle() {
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch(
        `${config.baseUrl}/v1/runs/${encodeURIComponent(runId)}/debug-bundle`,
        fetchOpts({ headers: authedHeaders({ accept: 'application/json' }) }),
      );
      if (!res.ok) throw new Error(`debug-bundle returned ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `run-${runId}-debug-bundle.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="card">
      <h2>{t('operations')}</h2>
      <div className="button-row">
        <button type="button" className="secondary" onClick={onDownloadBundle} disabled={downloading}>
          {downloading ? t('preparing') : t('downloadDebugBundle')}
        </button>
        {auditProfile && (
          <button type="button" className="secondary" onClick={onVerify} disabled={verifying}>
            {verifying ? t('verifying') : t('verifyAuditIntegrity')}
          </button>
        )}
        {auditProfile && (
          <Link
            to={`/runs/${runId}/audit`}
            className="secondary runops-audit-link"
            title={t('viewFullAuditLogTitle')}
          >
            {t('viewFullAuditLog')}
          </Link>
        )}
      </div>
      {auditProfile === false && (
        <p className="muted u-fs-12">
          {t('auditProfileUnavailablePre')}<code>openwop-audit-log-integrity</code>{t('auditProfileUnavailablePost')}
        </p>
      )}
      {error && <div className="alert error">{error}</div>}
      {result && (
        <div className="audit-result u-mt-2">
          <div className="u-flex u-items-center u-gap-2">
            <span className={`status-badge ${result.chainValid ? 'completed' : 'failed'}`}>
              {result.chainValid ? t('chainValid') : t('chainInvalid')}
            </span>
            <span className="muted u-fs-12">
              {t('opsSeqRange', { from: formatNumber(result.fromSeq), to: formatNumber(result.toSeq) })} · {t('opsCheckpointCount', { count: result.checkpoints.length })}
              {result.anomalies.length > 0 && ` · ${t('opsAnomalyCount', { count: result.anomalies.length })}`}
            </span>
          </div>
          {result.anomalies.length > 0 && (
            <ul className="u-fs-12 u-mt-1-5">
              {result.anomalies.map((a) => (
                <li key={a.atSeq}>
                  {t('opsAnomalySeqPrefix', { seq: formatNumber(a.atSeq) })} <code>{a.expectedPrevHash.slice(0, 12)}…</code>{t('opsAnomalyGot')}<code>{a.actualPrevHash.slice(0, 12)}…</code>
                </li>
              ))}
            </ul>
          )}
          {result.checkpoints.length > 0 && (
            <details className="u-mt-1-5">
              <summary className="muted">{t('signedCheckpoints')}</summary>
              <ul className="u-fs-11">
                {result.checkpoints.map((c) => (
                  <li key={c.atSequence}>
                    {t('opsCheckpointRowPrefix', { seq: formatNumber(c.atSequence) })} <code>{c.merkleRoot.slice(0, 16)}…</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

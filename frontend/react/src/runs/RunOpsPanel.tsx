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

import { Button } from '../ui/Button.js';
import { useEffect, useState } from 'react';
import { Notice } from '../ui/Notice.js';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { AuditVerifyResult, RunEventDoc } from '@openwop/openwop';
import { getDebugBundle, getSdkClient, getCapabilities } from '../client/runsClient.js';
import { formatNumber } from '../i18n/format.js';

interface Props {
  runId: string;
  events: readonly RunEventDoc[];
}

export function RunOpsPanel({ runId, events }: Props) {
  const { t } = useTranslation('runs');
  const [auditProfile, setAuditProfile] = useState<boolean | null>(null);
  /** UX-RUN-1 — the capability read failed; we know nothing about the host. */
  const [capsFailed, setCapsFailed] = useState(false);
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
      // UX-RUN-1 (sibling of RunAuditPage) — the `false` arm renders "Host does
      // not advertise the openwop-audit-log-integrity profile; verification
      // unavailable." A failed capability READ must not make that claim about
      // the host. Leave `auditProfile` null and flag the failure separately.
      .catch(() => { if (!cancelled) setCapsFailed(true); });
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
      // ADR 0730 C.1 — the ONE debug-bundle reader, which addresses the
      // host-extension twin. The operation has no v2 path, so the v1 spelling
      // this panel used would have died with the v1 surface, and it was a
      // SECOND copy of a read `runsClient` already owns.
      const bundle = await getDebugBundle(runId);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
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
        <Button variant="secondary" onClick={onDownloadBundle} disabled={downloading}>
          {downloading ? t('preparing') : t('downloadDebugBundle')}
        </Button>
        {auditProfile && (
          <Button variant="secondary" onClick={onVerify} disabled={verifying}>
            {verifying ? t('verifying') : t('verifyAuditIntegrity')}
          </Button>
        )}
        {auditProfile && (
          <Link
            to={`/runs/${runId}/audit`}
            className="btn secondary"
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
      {/* UX-RUN-1 — unknown, not unsupported. */}
      {capsFailed && <p className="muted u-fs-12">{t('auditCapsUnknown')}</p>}
      {error && <Notice variant="error">{error}</Notice>}
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

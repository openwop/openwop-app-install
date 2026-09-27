/**
 * Audit & metrics (ADR 0438 A7) — the metric-trustworthiness surface. Per the
 * /architect verdict this composes the OWNED KickTodo verifier-quality metric
 * (`kicktodoMetricsClient.getVerifierQuality`, ADR 0432 sampling — a tenant-
 * authority read) and LINKS the shared tamper-evident audit surface at its own
 * (superadmin) authority (`/audit-log`, ADR 0416/0301) rather than embedding a
 * superadmin read behind the `isAdminCaller` gate (which would 403 for a
 * non-superadmin admin and duplicate the single audit owner).
 *
 * Honesty (B18): the verifier disagreement rate is only as trustworthy as the
 * sample. When it can't be computed it renders "indicative, not audited" — never
 * a fabricated agreement number.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { KeyFigureBand } from '../../ui/KeyFigure.js';
import { getVerifierQuality, type VerifierQuality } from '../../client/kicktodoMetricsClient.js';

export function AuditMetricsPage(): JSX.Element {
  const { t } = useTranslation('kicktodo-admin');
  const [vq, setVq] = useState<VerifierQuality | null | undefined>(undefined);
  const [error, setError] = useState(false);

  const reload = useCallback(async () => {
    try { setError(false); setVq(await getVerifierQuality()); }
    catch { setError(true); setVq(null); }
  }, []);
  useEffect(() => { void reload(); }, [reload]); // KTUX-18 — retryable load

  return (
    <div className="page">
      <div className="action-bar">
        <Link className="btn-ghost btn-sm" to="/admin/kicktodo">{t('backToConsole')}</Link>
      </div>
      <header className="page-header">
        <h1 className="page-header__title">{t('auditMetricsTitle')}</h1>
        <p className="page-header__lede">{t('auditMetricsLede')}</p>
      </header>

      {error && (
        <>
          <Notice variant="error">{t('auditMetricsError')}</Notice>
          <div className="action-bar">
            <Button variant="quiet" size="sm" onClick={() => void reload()}>{t('retry')}</Button>
          </div>
        </>
      )}
      {vq === undefined && !error && <StateCard loading title={t('auditMetricsTitle')} />}

      {vq && (
        <section className="surface-card" aria-label={t('verifierHeading')}>
          <h2 className="u-fs-13 muted">{t('verifierHeading')}</h2>
          {vq.sampled === 0 ? (
            <p className="muted u-fs-13">{t('verifierNoSample')}</p>
          ) : (
            <>
              {/* One-pager pass — every rate shows its denominator, as serif
                  denominator cards (the sanctioned KeyFigureBand), never a bare
                  count that hides its sample. */}
              <KeyFigureBand ariaLabel={t('verifierHeading')} figures={[
                { key: 'sampled', label: t('figVerifierSampled'), value: vq.sampled },
                { key: 'agreed', label: t('figVerifierAgreed'), value: `${vq.agreed} / ${vq.resolved}` },
                { key: 'fp', label: t('figVerifierFalsePos'), value: `${vq.falsePositives} / ${vq.resolved}`, tone: vq.falsePositives > 0 ? 'attention' : 'default' },
                { key: 'fn', label: t('figVerifierFalseNeg'), value: `${vq.falseNegatives} / ${vq.resolved}`, tone: vq.falseNegatives > 0 ? 'attention' : 'default' },
              ]} />
              {/* B18 — the disagreement rate is honest about its own confidence. */}
              <p className="u-fs-13">
                {vq.disagreementRate === null
                  ? <span className="muted">{t('disagreementIndicative')}</span>
                  : t('disagreementRate', { rate: Math.round(vq.disagreementRate * 100) })}
              </p>
            </>
          )}
        </section>
      )}

      {/* Audit lives at its own superadmin authority — linked, not embedded. */}
      <section className="surface-card" aria-label={t('auditHeading')}>
        <h2 className="u-fs-13 muted">{t('auditHeading')}</h2>
        <p className="muted u-fs-13">{t('auditDescription')}</p>
        <div className="action-bar">
          <Link className="btn-ghost btn-sm" to="/audit-log">{t('openAuditLog')}</Link>
        </div>
      </section>
    </div>
  );
}

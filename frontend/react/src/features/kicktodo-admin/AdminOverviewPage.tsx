/**
 * KickTodo Trust & Operations — command center (ADR 0438 A0). The one place an
 * operator answers "what needs me, and where do I go". Per the §13 /architect
 * correction this is an ADDITIVE platform-admin surface: it hosts the Safety inbox
 * (A2, genuinely admin authority) and LINKS to the operator surfaces that live at
 * their own authority (metrics = tenant-read, org programs = org-manager) rather
 * than re-homing them under the platform-admin gate. It is honest about what is
 * here today and what is sequenced, and never asserts a trust it can't back.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ShieldIcon } from '../../ui/icons/index.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { Button } from '../../ui/Button.js';
import { useReviewStatusStore, useReviewList } from '../../chat/reviews/reviewStatusStore.js';
import { isKickTodoReviewKind } from './kicktodoReviewKinds.js';
import { ExceptionLedgerRow } from './ExceptionLedgerRow.js';
import { listExceptions, type ExceptionLedger } from '../../client/kicktodoExceptionsClient.js';

export function AdminOverviewPage(): JSX.Element {
  const { t } = useTranslation('kicktodo-admin');
  const connect = useReviewStatusStore((s) => s.connect);
  const disconnect = useReviewStatusStore((s) => s.disconnect);
  const loading = useReviewStatusStore((s) => s.loading);
  const initialized = useReviewStatusStore((s) => s.initialized);
  const pending = useReviewList().filter((r) => isKickTodoReviewKind(r.kind)).length;

  // ADR 0460 Phase 2 — the Exception Ledger (undefined = loading, null = error).
  const [ledger, setLedger] = useState<ExceptionLedger | null | undefined>(undefined);
  const loadLedger = useCallback(async () => {
    setLedger(undefined);
    try { setLedger(await listExceptions()); }
    catch { setLedger(null); }
  }, []);
  useEffect(() => { void loadLedger(); }, [loadLedger]);
  const degradedSources = (ledger?.sources ?? []).filter((s) => !s.ok);

  useEffect(() => {
    void connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return (
    <div className="page" data-walkthrough="admin-kicktodo.page">
      <header className="page-header">
        <h1 className="page-header__title">{t('overviewTitle')}</h1>
        <p className="page-header__lede">{t('overviewLede')}</p>
      </header>

      {/* The one genuinely-admin surface: the Safety & approvals queue. */}
      <section className="surface-card" aria-label={t('needsYouHeading')}>
        <h2 className="kt-eyebrow">{t('needsYouHeading')}</h2>
        <div className="action-bar">
          <ShieldIcon size={16} aria-hidden />
          <Link className="btn-accent-solid" to="/admin/kicktodo/safety">{t('openSafety')}</Link>
          {/* KTUX-19 — don't flash "nothing awaiting" before the review store loads. */}
          {(!initialized || loading) && pending === 0 ? (
            <span className="chip chip--muted">{t('pendingLoading')}</span>
          ) : (
            <span className={pending > 0 ? 'chip chip--danger' : 'chip chip--muted'}>
              {pending > 0 ? t('pendingCount', { count: pending }) : t('pendingNone')}
            </span>
          )}
        </div>
        <p className="muted u-fs-13">{t('safetyDescription')}</p>
      </section>

      {/* ADR 0460 Phase 2 — the Exception Ledger: the composed feed of what needs
          attention across KickTodo (approvals / broken sources / open payouts /
          flagged reviews). Every row deep-links its owning surface; a DEGRADED
          source is shown as such, never a silent "all clear". */}
      <section className="surface-card" aria-label={t('ledgerHeading')}>
        <h2 className="kt-eyebrow">{t('ledgerHeading')}</h2>
        {ledger === undefined ? <StateCard loading title={t('ledgerHeading')} />
          : ledger === null ? <StateCard announce title={t('ledgerError')} action={<Button variant="secondary" onClick={() => void loadLedger()}>{t('retry')}</Button>} />
          : (
            <>
              {degradedSources.length > 0 && (
                <Notice variant="error" announce={t('ledgerDegraded', { sources: degradedSources.map((s) => s.key).join(', ') })}>
                  {t('ledgerDegraded', { sources: degradedSources.map((s) => s.key).join(', ') })}
                </Notice>
              )}
              {ledger.rows.length === 0 ? (
                <p className="muted u-fs-13">{t('ledgerEmpty')}</p>
              ) : (
                <ul role="list" className="list-plain">
                  {ledger.rows.map((row) => <ExceptionLedgerRow key={row.id} row={row} />)}
                </ul>
              )}
            </>
          )}
      </section>

      {/* Admin lenses over the content lifecycle (A3) + metric trust (A7). */}
      <section className="surface-card" aria-label={t('healthHeading')}>
        <h2 className="kt-eyebrow">{t('healthHeading')}</h2>
        <div className="action-bar">
          <Link className="btn-ghost btn-sm" to="/admin/kicktodo/catalog">{t('openCatalogHealth')}</Link>
          <Link className="btn-ghost btn-sm" to="/admin/kicktodo/audit-metrics">{t('openAuditMetrics')}</Link>
          <Link className="btn-ghost btn-sm" to="/admin/kicktodo/connections">{t('openConnectionsAdmin')}</Link>
          <Link className="btn-ghost btn-sm" to="/admin/kicktodo/commerce">{t('openCommerce')}</Link>
        </div>
        <p className="muted u-fs-13">{t('healthDescription')}</p>
      </section>

      {/* A4 — the read-only People & access LENS (aggregate counts at admin
          authority); person- and consent-scoped surfaces stay linked at their OWN
          authority (platform accessControl + org-manager org programs), and cohort
          AGGREGATES stay consent-gated (B16) — never a re-home, never a cross-org
          aggregate the console can't lawfully show. */}
      <section className="surface-card" aria-label={t('peopleHeading')}>
        <h2 className="kt-eyebrow">{t('peopleHeading')}</h2>
        <div className="action-bar">
          <Link className="btn-ghost btn-sm" to="/admin/kicktodo/people">{t('openPeople')}</Link>
          <Link className="btn-ghost btn-sm" to="/access">{t('openAccess')}</Link>
          <Link className="btn-ghost btn-sm" to="/kicktodo/org-programs">{t('openOrgPrograms')}</Link>
        </div>
        <p className="muted u-fs-13">{t('peopleB16Note')}</p>
      </section>

      {/* A8 (folded per the /architect verdict) — settings & distribution ride the
          existing platform surfaces; the console LINKS them, never rebuilds them. */}
      <section className="surface-card" aria-label={t('settingsHeading')}>
        <h2 className="kt-eyebrow">{t('settingsHeading')}</h2>
        <div className="action-bar">
          <Link className="btn-ghost btn-sm" to="/feature-toggles">{t('openFeatureToggles')}</Link>
        </div>
        <p className="muted u-fs-13">{t('settingsDescription')}</p>
      </section>

      {/* Operator surfaces that live at their OWN authority — linked, not re-homed
          (the §13 authz correction). Each names its authority honestly. */}
      <section className="surface-card" aria-label={t('operatorHeading')}>
        <h2 className="kt-eyebrow">{t('operatorHeading')}</h2>
        <ul role="list" className="list-plain">
          <li className="list-row">
            <div>
              <Link to="/kicktodo/metrics">{t('linkMetrics')}</Link>
              <span className="chip chip--muted">{t('authorityTenant')}</span>
              <p className="muted u-fs-13">{t('metricsDescription')}</p>
            </div>
          </li>
          <li className="list-row">
            <div>
              <Link to="/kicktodo/org-programs">{t('linkOrgPrograms')}</Link>
              <span className="chip chip--muted">{t('authorityOrgManager')}</span>
              <p className="muted u-fs-13">{t('orgProgramsDescription')}</p>
            </div>
          </li>
          <li className="list-row">
            <div>
              <Link to="/kicktodo/community">{t('linkCommunity')}</Link>
              <span className="chip chip--muted">{t('authorityParticipant')}</span>
              <p className="muted u-fs-13">{t('communityDescription')}</p>
            </div>
          </li>
        </ul>
      </section>

      {/* Honest deferral: the broader console groups (catalog health, commerce
          reconciliation, cross-tenant trust/audit) are sequenced — not faked. */}
      <p className="muted u-fs-13">{t('overviewDeferredNote')}</p>
      {/* One-pager pass — the console's standing promise, stated once. */}
      <p className="muted u-fs-13">{t('overviewHonestyNote')}</p>
    </div>
  );
}

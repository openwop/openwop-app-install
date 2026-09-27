/**
 * Creator insights & earnings (ADR 0437 UX-2.7). The creator's own reach signal:
 * per-product active/revoked entitlement counts, from the EXISTING
 * `revenueProjectionFor` (ADR 0420 — the creator-facing projection that is
 * counts-only and never exposes buyer PII). Subject-scoped server-side, so the
 * creator only ever sees their own products; being self-data, no k-anonymity
 * floor applies.
 *
 * Honesty: the projection carries NO monetary field, so this renders reach in
 * ENTITLEMENTS (units), with an explicit note that dollar amounts aren't shown —
 * never a fabricated earnings figure (the §14 measurement-honesty rule).
 *
 * ADR 0445 P1/P2 — the Earnings section is what finally licenses REAL currency
 * here: per-currency accrued/paid totals from the derived share ledger (minor
 * units, `formatCurrencyMinor`), with `accrued` explicitly framed as UNPAID
 * until onboarding + a payout run; the payout-onboarding request rides the
 * shared `connect-seller` approval queue.
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { WandIcon } from '../../ui/icons/index.js';
import { KeyFigureBand, type KeyFigureItem } from '../../ui/KeyFigure.js';
import { formatCurrencyMinor } from '../../i18n/format.js';
import { listChallenges, type ChallengeSummary } from '../../client/kicktodoClient.js';
import {
  earningsCsvUrl,
  getMyRevenue,
  getMyEarnings,
  getReferralEarnings,
  getSellerOnboardingStatus,
  requestSellerOnboarding,
  type CreatorRevenueRow,
  type EarningsTotal,
  type ReferralEarnings,
  type SellerOnboardingStatus,
} from '../../client/kicktodoSeatClient.js';
import { formatCurrency } from '../../i18n/format.js';

/** Literal keys (KTUX-9 rule) for the request-state chip. */
function requestStateKey(s: SellerOnboardingStatus['request']): string {
  switch (s) {
    case 'pending': return 'earningsRequestPending';
    case 'approved': return 'earningsRequestApproved';
    case 'rejected': return 'earningsRequestRejected';
    default: return 'earningsRequestNone';
  }
}

export function CreatorInsightsPage(): JSX.Element {
  const { t } = useTranslation('kicktodo-studio');
  const [rows, setRows] = useState<CreatorRevenueRow[] | null>(null);
  const [catalog, setCatalog] = useState<ChallengeSummary[]>([]);
  const [earningTotals, setEarningTotals] = useState<EarningsTotal[]>([]);
  const [earningsFailed, setEarningsFailed] = useState(false); // grade-ux: a failed read must not render as "no earnings"
  const [sellerStatus, setSellerStatus] = useState<SellerOnboardingStatus | null>(null);
  const [referral, setReferral] = useState<ReferralEarnings | null>(null); // ADR 0451 P3
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const challengeTitle = (id: string): string | null =>
    catalog.find((c) => c.id === id)?.title ?? null;

  const load = async (): Promise<void> => {
    setError(false);
    const [revenue, earnings, status, ref, cs] = await Promise.all([
      getMyRevenue(),
      getMyEarnings().catch(() => null),
      getSellerOnboardingStatus().catch(() => null),
      getReferralEarnings().catch(() => null),
      listChallenges().catch(() => [] as ChallengeSummary[]),
    ]);
    setRows(revenue);
    setCatalog(cs);
    setEarningsFailed(earnings === null);
    setEarningTotals(earnings?.totals ?? []);
    setSellerStatus(status);
    setReferral(ref);
  };

  useEffect(() => {
    void load().catch(() => setError(true));
  }, []);

  const onRequestPayouts = async (): Promise<void> => {
    setBusy(true);
    try { await requestSellerOnboarding(); await load(); }
    catch { setError(true); }
    finally { setBusy(false); }
  };

  const totals = useMemo(() => {
    const list = rows ?? [];
    return {
      products: list.length,
      active: list.reduce((s, r) => s + r.activeEntitlements, 0),
      revoked: list.reduce((s, r) => s + r.revokedEntitlements, 0),
    };
  }, [rows]);

  return (
    <div className="page">
      <div className="action-bar">
        <Link className="btn-ghost btn-sm" to="/kicktodo/studio">{t('backToStudio')}</Link>
      </div>
      <header className="page-header">
        <h1 className="page-header__title">{t('insightsTitle')}</h1>
        <p className="page-header__lede">{t('insightsLede')}</p>
      </header>

      {error && <Notice variant="error">{t('insightsError')}</Notice>}
      {!rows && !error && <StateCard loading title={t('insightsTitle')} />}

      {rows && rows.length === 0 && !error && (
        <StateCard icon={<WandIcon aria-hidden />} title={t('insightsEmptyTitle')} body={t('insightsEmptyBody')} />
      )}

      {/* `announce` even though `error` renders role="alert": this repo's own
          doctrine (DESIGN.md, the .state-card row) is that a live region mounted
          with its text ALREADY INSIDE is not reliably announced, and role="alert"
          on insertion is "widely reported to work", not guaranteed. On a money
          surface that is the wrong side to be lax on. Passing `announce` REMOVES
          the role (see Notice.tsx) so there is no double-announce. */}
      {earningsFailed && <Notice variant="error" announce={t('earningsLoadError')}>{t('earningsLoadError')}</Notice>}
      {/* ADR 0445 — Earnings: real currency ONLY from the derived share ledger;
          nothing here is ever fabricated. Hidden entirely until a ledger exists. */}
      {rows && !error && (
        <section className="surface-card" aria-label={t('earningsHeading')}>
          <h2 className="kt-eyebrow">{t('earningsHeading')}</h2>
          {/* Screen-polish: the section never hides — payout ONBOARDING must be
              reachable BEFORE the first sale (it was gated on having already
              earned), and "nothing accrued yet" is an honest designed line,
              never a fabricated zero figure.

              CI-R2-1 — but it was only honest when the read SUCCEEDED.
              `getMyEarnings().catch(() => null)` sets `earningsFailed` AND
              `setEarningTotals(earnings?.totals ?? [])` → `[]`, so a FAILED
              earnings read rendered "Nothing accrued yet" — telling a creator
              they have earned nothing when we simply could not find out. On a
              money surface that is the worst direction to be wrong in.

              A TERNARY, not a bare `!earningsFailed` gate: the section must stay
              (payout onboarding lives below), so suppressing the line would
              leave a blank beside the onboarding chips, which reads as "loaded,
              nothing here" — the same false impression with no words to argue
              with. The failure gets its own line. The page-level Notice above
              stays; this is what a reader scanning the earnings block sees. */}
          {earningsFailed ? (
            <p className="muted u-fs-13">{t('earningsUnknown')}</p>
          ) : earningTotals.length === 0 ? (
            <p className="muted u-fs-13">{t('earningsNothingYet')}</p>
          ) : null}
          {earningTotals.length > 0 && (
          <>
          {/* One-pager pass — real currency as the serif KeyFigureBand: accrued
              is amber (owed, not yet paid), paid is plain. Per currency, from the
              ledger totals only; never a fabricated figure. */}
          <KeyFigureBand ariaLabel={t('earningsHeading')} figures={earningTotals.flatMap((tt): KeyFigureItem[] => [
            { key: `a-${tt.currency}`, label: t('earningsFigAccrued'), value: formatCurrencyMinor(tt.accruedMinor, tt.currency), tone: 'attention' },
            ...(tt.paidMinor > 0
              ? [{ key: `p-${tt.currency}`, label: t('earningsFigPaid'), value: formatCurrencyMinor(tt.paidMinor, tt.currency) } satisfies KeyFigureItem]
              : []),
          ])} />
          <p className="muted u-fs-13">{t('earningsAccruedNote')}</p>
          </>
          )}
          {/* ADR 0451 P3 — referral commission (accrued, advisory). Shown only
              once they've actually referred (a real affiliate code); never a
              fabricated zero. */}
          {referral?.code && (
            <p className="u-fs-13">
              {t('referralEarningsLabel')}{' '}
              <strong>{formatCurrency(referral.balanceOwed, referral.currency.toUpperCase())}</strong>
            </p>
          )}
          {/* ADR 0445 P4 — the author's own statement (cookie-authed download). */}
          <div className="action-bar">
            <a className="btn-ghost btn-sm" href={earningsCsvUrl} download>{t('earningsStatementCta')}</a>
          </div>
          {sellerStatus && (
            <div className="action-bar">
              <span className="chip chip--muted">{t(requestStateKey(sellerStatus.request))}</span>
              {sellerStatus.seller?.payoutsEnabled && <span className="chip chip--success">{t('earningsPayoutsEnabled')}</span>}
              {sellerStatus.request === 'none' && (
                <Button variant="quiet" size="sm" disabled={busy} onClick={() => void onRequestPayouts()}>
                  {t('earningsRequestCta')}
                </Button>
              )}
            </div>
          )}
        </section>
      )}

      {rows && rows.length > 0 && (
        <>
          <section className="surface-card" aria-label={t('insightsSummaryHeading')}>
            <h2 className="u-fs-13 muted">{t('insightsSummaryHeading')}</h2>
            <div className="action-bar">
              <span className="chip chip--muted">{t('insightsProducts', { count: totals.products })}</span>
              <span className="chip chip--success">{t('insightsActive', { count: totals.active })}</span>
              <span className="chip">{t('insightsRevoked', { count: totals.revoked })}</span>
            </div>
            {/* §14 measurement honesty — reach is in entitlements, not dollars. */}
            <p className="muted u-fs-13">{t('insightsNoMoney')}</p>
          </section>

          <section className="surface-card" aria-label={t('insightsPerProductHeading')}>
            <h2 className="u-fs-13 muted">{t('insightsPerProductHeading')}</h2>
            <ul role="list" className="list-plain">
              {rows.map((r) => (
                <li key={r.productId} className="list-row">
                  <div>
                    {/* The human title leads (0437 §5.2: ids are metadata in
                        the mono channel, never the row title). */}
                    <strong>{challengeTitle(r.challengeId) ?? t('insightsUntitled')}</strong>
                    <div><span className="studio-id">{r.challengeId} · v{r.challengeVersion}</span></div>
                    <div className="action-bar">
                      <span className="chip chip--success">{t('insightsActive', { count: r.activeEntitlements })}</span>
                      {r.revokedEntitlements > 0 && <span className="chip chip--muted">{t('insightsRevoked', { count: r.revokedEntitlements })}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

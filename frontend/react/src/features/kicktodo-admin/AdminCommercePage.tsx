/**
 * Commerce & payouts reconciliation (ADR 0438 A5). The ADR's design law: a
 * paid-but-unfulfilled order is a FIRST-CLASS incident with a retry/reconciliation
 * path — never a silent gap. Fulfilment observers are best-effort by design, so
 * this surface exposes the operator reconciliation (KTFULL-B13): re-grant the
 * entitlements paid-for orders are owed.
 *
 * Composes the EXISTING admin-scoped reconcile (`requireKicktodoManage`,
 * idempotent — a healthy tenant repairs zero), not a second money path. The result
 * is reported honestly (scanned vs repaired), and the money truth stays the
 * server's order-row CAS — this only triggers + reports it.
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { TextField } from '../../ui/Field.js';
import { formatCurrencyMinor, formatPercent } from '../../i18n/format.js';
import { confirm } from '../../ui/confirm.js';
import {
  reconcileCommerce,
  reconcileSeats,
  getSharePolicy,
  setSharePolicy,
  listPayoutRuns,
  createPayoutRun,
  confirmPayoutRun,
  cancelPayoutRun,
  shareLedgerCsvUrl,
  type PayoutRun,
  type SharePolicy,
} from '../../client/kicktodoSeatClient.js';

/** Literal keys (KTUX-9 rule) for the run-state chip. */
function runStateKey(s: PayoutRun['state']): string {
  switch (s) {
    case 'open': return 'payoutRunOpen';
    case 'confirmed': return 'payoutRunConfirmed';
    default: return 'payoutRunCanceled';
  }
}

export function AdminCommercePage(): JSX.Element {
  const { t } = useTranslation('kicktodo-admin');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ordersScanned: number; entitlementsRepaired: number } | null>(null);
  const [error, setError] = useState(false);

  // KTUX-6 / KTFULL-B12 — the seat-repair operator entry. Paste-in circle id
  // (no cohort browser: the operator repairs a specific stranded cohort a coach
  // reported). The result is the post-state, never a fabricated delta.
  const [circleId, setCircleId] = useState('');
  const [seatBusy, setSeatBusy] = useState(false);
  const [seatResult, setSeatResult] = useState<{ seatsTaken: number; capacity: number } | null>(null);
  const [seatError, setSeatError] = useState(false);

  const onReconcile = async () => {
    setBusy(true); setError(false);
    try { setResult(await reconcileCommerce()); }
    catch { setError(true); }
    finally { setBusy(false); }
  };

  const onReconcileSeats = async () => {
    if (!circleId.trim()) return;
    setSeatBusy(true); setSeatError(false); setSeatResult(null);
    try { setSeatResult(await reconcileSeats(circleId.trim())); }
    catch { setSeatError(true); }
    finally { setSeatBusy(false); }
  };

  // ADR 0445 P3/D4 — share policy + payout runs (operator records over the
  // derived ledger; confirmation is the operator's attested external evidence).
  const [policy, setPolicy] = useState<SharePolicy | null>(null);
  // Screen-polish (the KTUX-19 class): never assert "no runs / no policy"
  // before the first read settles.
  const [payoutLoaded, setPayoutLoaded] = useState(false);
  // UX-KTA-1 — …and "the read FAILED" is a third state the KTUX-19 guard didn't
  // have. Kept separate per read so one failure never speaks for the other.
  const [policyFailed, setPolicyFailed] = useState(false);
  const [runsFailed, setRunsFailed] = useState(false);
  const [policyInput, setPolicyInput] = useState('');
  const [runs, setRuns] = useState<PayoutRun[]>([]);
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [payoutError, setPayoutError] = useState(false);
  const [payoutInvalid, setPayoutInvalid] = useState(false); // grade-ux: range validation ≠ action failure
  const [payoutEmpty, setPayoutEmpty] = useState(false);
  const [reference, setReference] = useState<Record<string, string>>({});

  const loadPayouts = async (): Promise<void> => {
    // UX-KTA-1 — the KTUX-19 guard above stops us asserting "no runs / no policy"
    // BEFORE the first read settles. A FAILED read also settles, so it sailed
    // through that guard and made both assertions anyway:
    //   • "No payout runs yet."  → an operator reconciling payouts concludes
    //     nothing has ever been paid out.
    //   • "no share policy set"  → and this one invites a MONEY WRITE. The Set
    //     CTA calls setSharePolicy(bps), which overwrites; an operator told there
    //     is no policy can silently replace an existing basis-points policy they
    //     were never shown.
    // The file's own design law is "never a silent gap ... reported honestly"
    // (ADR 0438 A5), so unknown must read as unknown, not as zero.
    const [p, r] = await Promise.allSettled([getSharePolicy(), listPayoutRuns()]);
    setPolicyFailed(p.status === 'rejected');
    setRunsFailed(r.status === 'rejected');
    if (p.status === 'fulfilled') setPolicy(p.value);
    if (r.status === 'fulfilled') setRuns(r.value);
    setPayoutLoaded(true);
  };
  useEffect(() => { void loadPayouts(); }, []);

  const onSetPolicy = async () => {
    const bps = Number(policyInput.trim());
    setPayoutInvalid(false);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10000) { setPayoutInvalid(true); return; }
    setPayoutBusy(true); setPayoutError(false);
    try { await setSharePolicy(bps); setPolicyInput(''); await loadPayouts(); }
    catch { setPayoutError(true); }
    finally { setPayoutBusy(false); }
  };

  const onCreateRun = async () => {
    setPayoutBusy(true); setPayoutError(false); setPayoutEmpty(false);
    try {
      const run = await createPayoutRun();
      if (!run) setPayoutEmpty(true); // nothing accrued — an honest no-op
      await loadPayouts();
    } catch { setPayoutError(true); }
    finally { setPayoutBusy(false); }
  };

  const onConfirmRun = async (runId: string) => {
    const ref = (reference[runId] ?? '').trim();
    if (!ref) return;
    setPayoutBusy(true); setPayoutError(false);
    try { await confirmPayoutRun(runId, ref); await loadPayouts(); }
    catch { setPayoutError(true); }
    finally { setPayoutBusy(false); }
  };

  // Screen-polish (0438 §4.4 consequence symmetry): cancel walks a money
  // record away — it gets the canonical confirm, like every consequential
  // decision (confirm-run already requires attested evidence).
  const onCancelRun = async (runId: string) => {
    const ok = await confirm({
      title: t('payoutCancelConfirmTitle'),
      body: t('payoutCancelConfirmBody'),
      confirmLabel: t('payoutCancelCta'),
      danger: true,
    });
    if (!ok) return;
    setPayoutBusy(true); setPayoutError(false);
    try { await cancelPayoutRun(runId); await loadPayouts(); }
    catch { setPayoutError(true); }
    finally { setPayoutBusy(false); }
  };

  return (
    <div className="page">
      <div className="action-bar">
        <Link className="btn-ghost btn-sm" to="/admin/kicktodo">{t('backToConsole')}</Link>
        <Link className="btn-ghost btn-sm" to="/admin/kicktodo/commerce/paid-challenges">{t('openPaidChallenges')}</Link>
      </div>
      <header className="page-header">
        <h1 className="page-header__title">{t('commerceTitle')}</h1>
        <p className="page-header__lede">{t('commerceLede')}</p>
      </header>

      <section className="surface-card" aria-label={t('reconcileHeading')}>
        <h2 className="kt-eyebrow">{t('reconcileHeading')}</h2>
        <p className="muted u-fs-13">{t('reconcileDescription')}</p>
        <div className="action-bar">
          <Button variant="accent-solid" disabled={busy} aria-busy={busy} onClick={() => void onReconcile()}>
            {busy ? t('reconciling') : t('reconcileCta')}
          </Button>
        </div>
        {error && <Notice variant="error">{t('reconcileError')}</Notice>}
        {result && (
          <Notice variant={result.entitlementsRepaired > 0 ? 'success' : 'info'}>
            {result.entitlementsRepaired > 0
              ? t('reconcileRepaired', { repaired: result.entitlementsRepaired, scanned: result.ordersScanned })
              : t('reconcileHealthy', { scanned: result.ordersScanned })}
          </Notice>
        )}
      </section>

      <section className="surface-card" aria-label={t('seatReconcileHeading')}>
        <h2 className="kt-eyebrow">{t('seatReconcileHeading')}</h2>
        <p className="muted u-fs-13">{t('seatReconcileDescription')}</p>
        <div className="action-bar">
          <TextField label={t('seatCircleLabel')} value={circleId} placeholder={t('seatCirclePlaceholder')}
            onChange={(e) => setCircleId(e.target.value)} />
          <Button variant="accent-solid" disabled={seatBusy || !circleId.trim()}
            aria-busy={seatBusy} onClick={() => void onReconcileSeats()}>
            {seatBusy ? t('reconciling') : t('seatReconcileCta')}
          </Button>
        </div>
        {seatError && <Notice variant="error">{t('seatReconcileError')}</Notice>}
        {seatResult && (
          // Post-state, NOT a repair count: the route returns no delta, so
          // claiming "N repaired" would be a fabricated number.
          <Notice variant="info">{t('seatReconcileResult', { taken: seatResult.seatsTaken, capacity: seatResult.capacity })}</Notice>
        )}
      </section>

      {/* ADR 0445 P3/D4 — author share policy + payout runs. The host NEVER
          moves money: a run is an operator record; confirm attests the external
          payment (observed Connect payout id / note) and only then flips the
          ledger rows accrued→paid. */}
      <section className="surface-card" aria-label={t('payoutHeading')}>
        <h2 className="kt-eyebrow">{t('payoutHeading')}</h2>
        <div className="action-bar">
          <span className="chip chip--muted">
            {!payoutLoaded ? t('common:loading')
              : policyFailed ? t('payoutPolicyUnknown')
              : policy ? t('payoutPolicyCurrent', { pct: formatPercent(policy.shareBps / 10000, { maximumFractionDigits: 2 }) }) : t('payoutPolicyNone')}
          </span>
          <TextField label={t('payoutPolicyLabel')} value={policyInput} placeholder={t('payoutPolicyExample')}
            onChange={(e) => setPolicyInput(e.target.value)} />
          {/* UX-KTA-1 — `setSharePolicy` OVERWRITES. Writing a revenue-share rate
              while the current one is unreadable is a blind money write, so the
              CTA is blocked (not merely warned) until we can show what we would
              be replacing. Same ruling openwop-app-3 applied to commerce-ucp's
              Provision CTA: remove the entry point rather than disable-and-hope. */}
          <Button variant="quiet" size="sm"
            disabled={payoutBusy || !policyInput.trim() || policyFailed}
            {...(policyFailed ? { title: t('payoutPolicyBlockedTitle') } : {})}
            onClick={() => void onSetPolicy()}>
            {t('payoutPolicySetCta')}
          </Button>
        </div>
        <p className="muted u-fs-13">{t('payoutRunNote')}</p>
        <div className="action-bar">
          <Button variant="accent-solid" disabled={payoutBusy} aria-busy={payoutBusy}
            onClick={() => void onCreateRun()}>
            {t('payoutRunCreateCta')}
          </Button>
          {/* ADR 0445 P4 — the operator statement (cookie-authed download). */}
          <a className="btn-ghost btn-sm" href={shareLedgerCsvUrl} download>{t('payoutLedgerCsvCta')}</a>
        </div>
        {payoutInvalid && <Notice variant="error">{t('payoutPolicyInvalid')}</Notice>}
        {payoutError && <Notice variant="error">{t('payoutError')}</Notice>}
        {payoutEmpty && <Notice variant="info">{t('payoutNothingAccrued')}</Notice>}
        {policyFailed || runsFailed ? <Notice variant="warning" announce={t('payoutReadFailed')}>{t('payoutReadFailed')}</Notice> : null}
        {!payoutLoaded ? <p className="muted u-fs-13">{t('common:loading')}</p>
          : runsFailed
          // UX-KTA-1 — on a reconciliation console, "no payout runs" is a
          // financial claim. An unread ledger must never make it.
          ? <p className="muted u-fs-13">{t('payoutRunsUnknown')}</p>
          : runs.length === 0
          ? <p className="muted u-fs-13">{t('payoutRunsEmpty')}</p>
          : (
            <ul role="list" className="list-plain list-nested">
              {runs.map((r) => (
                <li key={r.runId} className="list-row">
                  <div>
                    <span className={r.state === 'confirmed' ? 'chip chip--success' : r.state === 'canceled' ? 'chip chip--muted' : 'chip'}>
                      {t(runStateKey(r.state))}
                    </span>
                    <span className="muted u-fs-13"> · {r.runId}</span>
                    {r.reference && <span className="muted u-fs-13"> · {r.reference}</span>}
                    {/* One-pager pass — the run total as the serif figure (per
                        currency, summed from the entries the server returned). */}
                    <span className="kt-run-amounts">
                      {Object.entries(r.entries.reduce<Record<string, number>>((acc, e) => {
                        acc[e.currency] = (acc[e.currency] ?? 0) + e.totalMinor;
                        return acc;
                      }, {})).map(([cur, minor]) => (
                        <span key={cur} className="kt-run-amounts__figure">{formatCurrencyMinor(minor, cur)}</span>
                      ))}
                    </span>
                    {/* The 0438 §4.2 money channel: right-aligned mono
                        amounts, scannable as a column — not inline prose. */}
                    <ul role="list" className="list-plain kt-money-rows">
                      {r.entries.map((e) => (
                        <li key={`${e.authorSubject}-${e.currency}`} className="kt-money-row u-fs-13">
                          <code>{e.authorSubject}</code>
                          <span className="muted">{t('payoutRowCount', { count: e.rowCount })}</span>
                          <span className="kt-money-amount">{formatCurrencyMinor(e.totalMinor, e.currency)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  {r.state === 'open' && (
                    <div className="action-bar">
                      <TextField label={t('payoutReferenceLabel')} value={reference[r.runId] ?? ''}
                        placeholder={t('payoutReferencePlaceholder')}
                        onChange={(e) => setReference((s) => ({ ...s, [r.runId]: e.target.value }))} />
                      <Button variant="accent-solid" disabled={payoutBusy || !(reference[r.runId] ?? '').trim()}
                        onClick={() => void onConfirmRun(r.runId)}>
                        {t('payoutConfirmCta')}
                      </Button>
                      {!(reference[r.runId] ?? '').trim() && (
                        <span className="muted u-fs-13">{t('payoutConfirmNeedsEvidence')}</span>
                      )}
                      <Button variant="quiet" size="sm" disabled={payoutBusy}
                        onClick={() => void onCancelRun(r.runId)}>
                        {t('payoutCancelCta')}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
      </section>

      {/* Money truth (orders/refunds/disputes/payouts) lives in the platform
          commerce/Connect surfaces — linked, not re-modeled (§2 boundaries). */}
      <p className="muted u-fs-13">{t('commerceMoneyTruthNote')}</p>
    </div>
  );
}

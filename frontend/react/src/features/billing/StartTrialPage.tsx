/**
 * ADR 1097 — the public trial entry, `/start-trial?plan=<tier>` or
 * `/start-trial?bundle=<id>` (optionally `&cadence=year`).
 *
 * A marketing CTA ("Start your 7-day trial") links here. The page walks a visitor
 * into the EXISTING Stripe trial checkout and nothing else:
 *
 *  1. Signed out → the header's own sign-in / sign-up dialog, with the shared
 *     remembered return (`auth/signInReturn`, same-origin allowlist) so the
 *     visitor comes back to this exact URL.
 *  2. Signed in → `listMyWorkspaces()` (which provisions the personal workspace
 *     a new account starts with) and the server's `trial-offer` read for the
 *     active workspace. That read uses the same `trialFor` as checkout and the
 *     same gates (billing toggle, `host:billing:manage`), so the page states a
 *     trial only when the checkout would send one.
 *  3. "Continue to checkout" → the existing `buyPlan` / `buyBundle` routes, which
 *     go through the ONE `createCheckoutSession`. The page redirects only to a
 *     LIVE https session that carries `trialDays`; otherwise it says why not.
 *
 * Every other outcome is a named state with a link to the normal billing, store
 * or pricing page. Nothing on this page grants anything: fulfilment stays the
 * ADR 0786 webhook.
 */
import { useCallback, useEffect, useState, type JSX, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/useAuth.js';
import { useBackendSession } from '../../auth/backendSession.js';
import { openHeaderSignIn, rememberReturn, takeReturn } from '../../auth/signInReturn.js';
import { listMyWorkspaces, switchWorkspace, type MyWorkspaces } from '../../client/workspaceClient.js';
import { ApiError } from '../../client/requestJson.js';
import { errorReasonOf } from '../../client/classifyHttpError.js';
import { applyUnlistedHead } from '../site/siteSeo.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { AlertIcon, LockIcon, SparklesIcon } from '../../ui/icons/index.js';
import { billingErrorMessage, buyBundle, buyPlan, getTrialOffer, type TrialOffer } from './billingClient.js';
import { parseTrialLink, type ParsedTrialLink } from './startTrialRoute.js';

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; offer: TrialOffer; workspaces: MyWorkspaces | null }
  | { kind: 'billing-off' }
  | { kind: 'forbidden'; workspaces: MyWorkspaces | null }
  | { kind: 'signed-out' }
  | { kind: 'no-sign-in' }
  | { kind: 'invalid' }
  | { kind: 'failed' };

/** Where the normal (non-trial) path for this target lives. */
function fallbackHref(link: ParsedTrialLink): string {
  return 'plan' in link.target ? '/billing' : `/marketplace/bundles?bundle=${encodeURIComponent(link.target.bundleId)}`;
}

function Column({ children }: { children: ReactNode }): JSX.Element {
  return <div className="u-p-4 u-mx-auto u-w-full">{children}</div>;
}

export function StartTrialPage(): JSX.Element {
  const { t } = useTranslation('billing');
  const location = useLocation();
  const navigate = useNavigate();
  const link = parseTrialLink(location.search);
  const { user, loading: authLoading } = useAuth();
  const { user: backendUser, resolved } = useBackendSession();
  const signedIn = Boolean(user || backendUser);
  const authPending = authLoading || (!user && !resolved);

  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  /** A checkout attempt that did not redirect: the server's refusal, or why the page stopped. */
  const [checkoutProblem, setCheckoutProblem] = useState<string | null>(null);

  useEffect(() => applyUnlistedHead(t('trialPageTitle')), [t]);

  // Back from sign-in: consume the remembered return. If it names another allowed
  // URL (the visitor started elsewhere), continue there, as the store does.
  useEffect(() => {
    if (!signedIn) return;
    const url = takeReturn();
    if (url && url !== `${location.pathname}${location.search}`) navigate(url);
  }, [signedIn, navigate, location.pathname, location.search]);

  const targetKey = link ? ('plan' in link.target ? `plan:${link.target.plan}` : `bundle:${link.target.bundleId}`) : '';
  const cadence = link?.cadence ?? 'month';
  useEffect(() => {
    if (!link) { setLoad({ kind: 'invalid' }); return; }
    if (authPending) { setLoad({ kind: 'loading' }); return; }
    if (!signedIn) { setLoad({ kind: 'signed-out' }); return; }
    let live = true;
    setLoad({ kind: 'loading' });
    setCheckoutProblem(null);
    void (async () => {
      // The personal workspace is provisioned by this read for a brand-new account.
      // A failure here only costs the workspace name, never the offer.
      const workspaces = await listMyWorkspaces().catch(() => null);
      try {
        const offer = await getTrialOffer(link.target, cadence);
        if (live) setLoad({ kind: 'ready', offer, workspaces });
      } catch (err) {
        if (!live) return;
        const status = err instanceof ApiError ? err.status : 0;
        if (status === 404) setLoad({ kind: 'billing-off' });
        else if (status === 401 || (status === 403 && errorReasonOf(err) === 'anonymous_session')) setLoad({ kind: 'signed-out' });
        else if (status === 403) setLoad({ kind: 'forbidden', workspaces });
        else if (status === 400) setLoad({ kind: 'invalid' });
        else setLoad({ kind: 'failed' });
      }
    })();
    return () => { live = false; };
    // targetKey + cadence stand in for `link` (a fresh object every render). The
    // backend user id re-reads once an OIDC sign-in's session finalizes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, cadence, authPending, signedIn, backendUser?.userId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const signIn = useCallback(() => {
    rememberReturn(`${location.pathname}${location.search}`);
    // No sign-in UI on this host: say so, rather than leave a button that does nothing.
    if (!openHeaderSignIn()) { takeReturn(); setLoad({ kind: 'no-sign-in' }); }
  }, [location.pathname, location.search]);

  const pricing = <Link className="btn-ghost" to="/pricing">{t('trialSeePlans')}</Link>;

  if (!link || load.kind === 'invalid') {
    return <Column><StateCard icon={<AlertIcon size={20} />} title={t('trialInvalidTitle')} body={t('trialInvalidBody')} action={pricing} /></Column>;
  }
  const name = 'plan' in link.target
    ? t(`plan_${link.target.plan}`)
    : (load.kind === 'ready' && load.offer.label) || link.target.bundleId;
  const elsewhere = <Link className="btn-ghost" to={fallbackHref(link)}>{t('trialOtherOptions')}</Link>;

  if (load.kind === 'loading') {
    return (
      <Column>
        <div role="status" aria-busy="true" aria-label={t('trialLoading')} className="u-flex u-flex-col u-gap-2">
          <Skeleton width="60%" height={26} />
          <Skeleton width="90%" height={13} />
        </div>
      </Column>
    );
  }
  if (load.kind === 'signed-out') {
    return (
      <Column>
        <StateCard
          icon={<SparklesIcon size={20} />}
          title={t('trialSignInTitle', { name })}
          body={t('trialSignInBody')}
          action={<Button variant="primary" aria-haspopup="dialog" onClick={signIn}>{t('trialSignInAction')}</Button>}
        />
      </Column>
    );
  }
  if (load.kind === 'no-sign-in') {
    return <Column><StateCard icon={<LockIcon size={20} />} title={t('trialNoSignInTitle')} body={t('trialNoSignInBody')} action={pricing} /></Column>;
  }
  if (load.kind === 'failed') {
    return <Column><StateCard icon={<AlertIcon size={20} />} title={t('trialFailedTitle')} body={t('trialFailedBody')} announce action={<Button onClick={retry}>{t('trialRetry')}</Button>} /></Column>;
  }
  if (load.kind === 'billing-off') {
    return <Column><StateCard icon={<AlertIcon size={20} />} title={t('trialBillingOffTitle')} body={t('trialBillingOffBody')} action={pricing} /></Column>;
  }
  if (load.kind === 'forbidden') {
    const ws = load.workspaces;
    const activeWs = ws?.workspaces.find((w) => w.active);
    const canSwitch = ws !== null && ws.active !== ws.personal;
    const switchToPersonal = async (): Promise<void> => {
      if (!ws) return;
      setBusy(true);
      try { await switchWorkspace(ws.personal); retry(); } catch { setLoad({ kind: 'failed' }); } finally { setBusy(false); }
    };
    return (
      <Column>
        <StateCard
          icon={<LockIcon size={20} />}
          title={t('trialForbiddenTitle')}
          body={t('trialForbiddenBody', { workspace: activeWs?.name ?? t('trialThisWorkspace') })}
          action={canSwitch
            ? <Button variant="primary" disabled={busy} onClick={() => { void switchToPersonal(); }}>{t('trialUsePersonal')}</Button>
            : elsewhere}
        />
      </Column>
    );
  }

  const { offer, workspaces } = load;
  const workspaceName = workspaces?.workspaces.find((w) => w.active)?.name ?? t('trialThisWorkspace');
  if (offer.status !== 'available' || !offer.trialDays) {
    const v = { name, workspace: workspaceName };
    // `available` without days cannot come from the server; it reads as no trial.
    const [title, body] = offer.status === 'not_for_sale' ? [t('trialNotForSaleTitle', v), t('trialNotForSaleBody', v)]
      : offer.status === 'trial_used' ? [t('trialUsedTitle', v), t('trialUsedBody', v)]
      : offer.status === 'already_subscribed' ? [t('trialSubscribedTitle', v), t('trialSubscribedBody', v)]
      : offer.status === 'included_in_plan' ? [t('trialIncludedTitle', v), t('trialIncludedBody', v)]
      : [t('trialNoTrialTitle', v), t('trialNoTrialBody', v)];
    return <Column><StateCard icon={<AlertIcon size={20} />} title={title} body={body} action={elsewhere} /></Column>;
  }
  if (offer.checkout !== 'live') {
    return <Column><StateCard icon={<AlertIcon size={20} />} title={t('trialDemoTitle')} body={t('trialDemoBody')} action={pricing} /></Column>;
  }

  const days = offer.trialDays;
  const start = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setCheckoutProblem(null);
    try {
      const session = 'plan' in link.target ? await buyPlan(link.target.plan, cadence) : await buyBundle(link.target.bundleId, cadence);
      // Redirect only to a real Stripe session that carries the trial this page promised.
      if (session.mode === 'live' && session.trialDays && /^https:\/\//.test(session.url)) {
        window.location.assign(session.url);
        return;
      }
      setCheckoutProblem(session.mode === 'live' && !session.trialDays ? t('trialCheckoutNoTrial') : t('trialCheckoutUnavailable'));
    } catch (err) {
      setCheckoutProblem(billingErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Column>
      <h1 className="page-header__title">{t('trialReadyTitle', { days, name })}</h1>
      <p className="muted u-mt-1">{t('trialReadyWorkspace', { workspace: workspaceName })}</p>
      <p className="muted u-mt-1">{offer.cardRequired === false ? t('trialNoCard') : t('trialCardNeeded', { days })}</p>
      {checkoutProblem ? <div className="u-mt-2"><Notice variant="error" announce={checkoutProblem}>{checkoutProblem}</Notice></div> : null}
      <div className="u-flex u-gap-2 u-mt-3">
        <Button variant="primary" disabled={busy} onClick={() => { void start(); }}>{busy ? t('opening') : t('trialContinue')}</Button>
        {checkoutProblem ? elsewhere : null}
      </div>
    </Column>
  );
}

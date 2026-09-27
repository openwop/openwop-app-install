/**
 * ADR 0544 P3 — the public verification page.
 *
 * The reader is an employer who received an application, followed a link, and
 * has no account here and no reason to want one. Every decision on this page
 * follows from that: no sign-in, no product pitch, no "learn more about
 * <product>" CTA. They came to answer one question — is this application what it
 * says it is — and the page's job is to answer it and get out of the way.
 *
 * ## The page states facts and then states its own limits
 *
 * The footer is not boilerplate. An attestation page that showed only its
 * strongest claims would read as an endorsement, and the thing being sold here
 * is credibility — which survives exactly as long as nobody catches the page
 * overstating. So it says plainly what is NOT attested: no match score, no
 * assessment of the candidate. The claim vocabulary has no room for those
 * (backend `claims.ts`), and saying so is what makes the falsifiable claims
 * worth reading.
 *
 * ## Three outcomes, and the third is not about the applicant
 *
 * `not-found` covers unknown, revoked and malformed as ONE state — the backend
 * refuses them identically on purpose, and a page that guessed at the reason
 * would put the oracle back. `unavailable` is separate and says so in the
 * copy ("a problem on our side, not with the link"), because reporting a dropped
 * connection as an invalid link is a claim about a person made from no evidence.
 *
 * Rendered in the bare `PublicShell` above `AppGate`, and `noindex` — a
 * capability-token URL must never reach a search index if it leaks.
 */
import { useCallback, useEffect, useState, type JSX, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat.js';
import { applyUnlistedHead } from '../site/siteSeo.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Button } from '../../ui/Button.js';
import { AlertIcon, ShieldIcon } from '../../ui/icons/index.js';
import { ClaimList, useRenderedClaims } from './ClaimList.js';
import { resolveAttestation, type VerifierClaim, type VerifyOutcome } from './attestationVerifyClient.js';

/** Reading column, matched to the share viewer so public pages feel like one app. */
const COLUMN: React.CSSProperties = { maxWidth: '42rem' };

function Shell({ children }: { children: ReactNode }): JSX.Element {
  return <div className="u-p-4 u-mx-auto u-w-full" style={COLUMN}>{children}</div>;
}

export function AttestationVerifyPage({ token }: { token: string }): JSX.Element {
  const { t } = useTranslation('job-search');
  const fmt = useFormat();
  const [outcome, setOutcome] = useState<VerifyOutcome | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => applyUnlistedHead(t('verifyTitle')), [t]);

  useEffect(() => {
    let active = true;
    setOutcome(null);
    void resolveAttestation(token).then((o) => { if (active) setOutcome(o); });
    return () => { active = false; };
  }, [token, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (outcome === null) {
    return (
      <Shell>
        <div role="status" aria-busy="true" aria-label={t('verifyLoading')} className="u-flex u-flex-col u-gap-2">
          <Skeleton width="60%" height={26} />
          <Skeleton width="90%" height={13} />
          {['92%', '78%', '85%'].map((w, i) => <Skeleton key={i} width={w} height={16} />)}
        </div>
      </Shell>
    );
  }

  if (outcome.kind === 'unavailable') {
    return (
      <Shell>
        <StateCard
          icon={<AlertIcon size={20} />}
          title={t('verifyUnavailableTitle')}
          body={t('verifyUnavailableBody')}
          announce
          action={<Button onClick={retry}>{t('verifyRetry')}</Button>}
        />
      </Shell>
    );
  }

  if (outcome.kind === 'not-found') {
    // ONE state for unknown, revoked and malformed. The copy is careful not to
    // guess: "may have been mistyped, or may have been withdrawn" describes the
    // possibilities without asserting either, which is the honest rendering of
    // an answer the page genuinely does not have.
    return (
      <Shell>
        <StateCard
          icon={<ShieldIcon size={20} />}
          title={t('verifyNotFoundTitle')}
          body={t('verifyNotFoundBody')}
          announce
        />
      </Shell>
    );
  }

  const { view } = outcome;

  return (
    <Shell>
      <h1 className="page-header__title">{t('verifyTitle')}</h1>
      <p className="muted u-mt-1">{t('verifyLede')}</p>
      <p className="muted u-text-sm u-mt-1">{t('verifyIssued', { date: fmt.date(view.issuedAt) })}</p>

      <div className="u-mt-3"><ResolvedClaims claims={view.claims} /></div>

      <p className="muted u-text-sm u-mt-3">{t('verifyFooter')}</p>
    </Shell>
  );
}

/**
 * Split out because `useRenderedClaims` is a hook and the parent returns early
 * for the loading/refused states — calling it up there would violate the rules
 * of hooks the moment an outcome changes.
 */
function ResolvedClaims({ claims }: { claims: VerifierClaim[] }): JSX.Element {
  const { t } = useTranslation('job-search');
  const rendered = useRenderedClaims(claims);
  if (rendered.length === 0) return <></>;
  return (
    <>
      <ClaimList claims={rendered} />
      <details className="u-mt-3">
        <summary className="u-text-sm muted">{t('verifyReferences')}</summary>
        <p className="u-text-sm muted u-mt-1">{t('verifyReferencesBody')}</p>
        <ul className="u-text-sm muted u-mt-1 u-list-none">
          {rendered.map(({ claim }) => <li key={claim.sourceDigest} className="u-mono">{claim.sourceDigest}</li>)}
        </ul>
      </details>
    </>
  );
}

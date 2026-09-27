/**
 * Invitation accept page (`/invitations/accept?token=…` — ADR 0004 UI; closes
 * UX-ASSESSMENT AUTH-3's join half). A signed-in user redeems the one-time
 * token; the backend's email-ownership check is the gate. Signed-out visitors
 * are prompted to sign in first (the token survives in the URL).
 *
 * UX_UPGRADE-invitations (2026-07-24):
 *  - IN-G1/IN-G2 the page PREVIEWS the invitation and requires an explicit
 *    Accept. It used to redeem on load, so anything that merely FOLLOWED the
 *    link — a mail-client link scanner, a chat unfurler, a browser prefetch —
 *    silently joined the recipient to an org. Joining an organisation is a
 *    consequential act and should take a deliberate click.
 *  - IN-G3 the page is `noindex` (it is a capability-token URL, same family as
 *    a share link).
 *  - IN-G4 the failure state no longer prints a raw API error string.
 */
import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { StateCard } from '../ui/StateCard.js';
import { Notice } from '../ui/Notice.js';
import { confirm } from '../ui/confirm.js';
import { MailIcon } from '../ui/icons/index.js';
import { SignInButton } from '../auth/SignInButton.js';
import { useAuth } from '../auth/useAuth.js';
import { signOut } from '../auth/firebase.js';
import { setBackendSessionUser } from '../auth/backendSession.js';
import { logout } from '../features/users/usersClient.js';
import { announce as announceToScreenReader } from '../ui/announce.js';
import { useFormat } from '../i18n/useFormat.js';
import { applyUnlistedHead } from '../features/site/siteSeo.js';
import { acceptInvite, declineInvitation, inviteErrorDetails, previewInvite, type InvitePreview } from './invitesClient.js';
import { listMyWorkspaces, switchWorkspace } from '../client/workspaceClient.js';
import { invalidateOrgMembers } from './orgMembers.js';

/** R2 IN-SP-2 — the old single `invalid` bucket swallowed expired / revoked /
 *  network / 500 under copy claiming "the link is missing its token" (false
 *  for all of them). Discriminated now: `noToken` (genuinely missing),
 *  `expired` (the server's reason), `gone` (a real 4xx — revoked/used/
 *  never-existed, indistinguishable by design), `loadFailed` (network/5xx —
 *  retryable, the invite most likely still exists).
 *  ADR 0564 D3 — `declining` (the confirmed POST in flight), `declined` (the
 *  recipient JUST declined, or an accept found it declined: user-initiated, so
 *  announced + focused like `done`), `declinedGone` (the preview read said the
 *  token holder declined it earlier — a load-time terminal state, silent like
 *  `expired`/`gone`). Both render the same card; only the announcement differs. */
type Phase = 'loading' | 'ready' | 'accepting' | 'done' | 'alreadyMember' | 'noToken' | 'expired' | 'gone' | 'loadFailed' | 'failed'
  | 'declining' | 'declined' | 'declinedGone';

/** The failure kinds a signed-in ACTION (accept or decline) can land in.
 *  `mismatch` = the 403 email-ownership gate (no reason on the wire);
 *  `unverified` = 403 `reason: email_unverified` (ADR 0622 D7 — the address
 *  matches but was self-set); `generic` = everything else (retryable). The two
 *  403s cannot succeed for the SAME account, so they disable the actions and
 *  offer the in-card account switch instead. */
type Failure = 'mismatch' | 'unverified' | 'generic';
const failureOf = (err: unknown): Failure => {
  const status = (err as { status?: number }).status ?? 0;
  if (status !== 403) return 'generic';
  return inviteErrorDetails(err).reason === 'email_unverified' ? 'unverified' : 'mismatch';
};
const failureReason = (err: unknown): string | undefined => inviteErrorDetails(err).reason;

export function InviteAcceptPage(): JSX.Element {
  const { t } = useTranslation('orgs');
  const fmt = useFormat();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { user, loading } = useAuth();
  const [phase, setPhase] = useState<Phase>('loading');
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [failure, setFailure] = useState<Failure>('generic');
  // ADR 0564 D3 — which ACTION failed picks the generic copy (an accept's
  // "may be expired, revoked…" is wrong for a decline that hit a 500) and
  // which control gets focus back.
  const [failedAction, setFailedAction] = useState<'accept' | 'decline'>('accept');
  // R3 (review F9 follow-on) — a cross-tenant invite used to land on the plain
  // /orgs list under the WRONG active workspace, where the org just joined is
  // invisible. When the accepted membership lives in a shared workspace other
  // than the active one, the CTA switches first (member-gated server-side);
  // when the caller holds no workspace-root membership there, we say so
  // honestly instead of offering a door that opens on the wrong room.
  const [crossWs, setCrossWs] = useState<{ workspaceId: string; name?: string; switchable: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const accepting = useRef(false);
  // ORGINV-UX-6 — Accept is the focused element when it UNMOUNTS (the done /
  // already-member card replaces it), so focus fell to <body> and nothing was
  // spoken after the page's one consequential click. The outcome card's primary
  // CTA takes focus; when there is none (the honest no-access cross-workspace
  // state) the card itself does (tabIndex=-1). On a failure the Accept button is
  // re-enabled from `loading` (which disabled it, dropping focus) and refocused —
  // or, on a mismatch, the recovery action is.
  const cardRef = useRef<HTMLDivElement>(null);
  const ctaRef = useRef<HTMLElement | null>(null);
  const setCta = useCallback((el: HTMLElement | null) => { ctaRef.current = el; }, []);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const declineRef = useRef<HTMLButtonElement>(null);
  const switchRef = useRef<HTMLButtonElement>(null);
  /** A 403 of either kind: THIS account cannot accept OR decline. */
  const accountBlocked = phase === 'failed' && failure !== 'generic';

  // IN-G3 — a capability-token URL must never be indexed if it leaks.
  useEffect(() => applyUnlistedHead(t('acceptHeadTitle')), [t]);

  // Resolve the invitation WITHOUT redeeming it. Runs regardless of sign-in
  // state, so a signed-out recipient can see what they're being asked to join
  // before deciding whether to create an account.
  useEffect(() => {
    if (!token) { setPhase('noToken'); return; }
    let live = true;
    setPhase('loading');
    previewInvite(token)
      .then((p) => { if (live) { setPreview(p); setPhase('ready'); } })
      .catch((err: unknown) => {
        if (!live) return;
        // R2 IN-SP-2/8 — discriminate: a backend outage must not tell the
        // recipient their link is malformed.
        const status = (err as { status?: number }).status ?? 0;
        const reason = failureReason(err);
        if (reason === 'expired') setPhase('expired');
        // ADR 0564 / 0622 D4 — the token holder declined it earlier: say so
        // (the disclosure is theirs already) instead of the generic "gone".
        else if (reason === 'declined') setPhase('declinedGone');
        else if (status >= 400 && status < 500) setPhase('gone');
        else setPhase('loadFailed');
      });
    return () => { live = false; };
  }, [token, attempt]);

  const accept = useCallback(() => {
    if (accepting.current) return;
    accepting.current = true;
    setPhase('accepting');
    acceptInvite(token)
      // R2 IN-SP-3 — an existing member gets the honest state, not a duplicate.
      .then(async (m) => {
        // CLNP-2(d) — joining changes a member list this tab may have cached.
        invalidateOrgMembers();
        if (m.tenantId?.startsWith('ws:')) {
          // Best-effort: a failed workspace read must not fail the accept —
          // fall back to the same-workspace CTA (the server keeps enforcing).
          try {
            const mine = await listMyWorkspaces();
            if (mine.active !== m.tenantId) {
              const target = mine.workspaces.find((w) => w.workspaceId === m.tenantId);
              setCrossWs({ workspaceId: m.tenantId, switchable: Boolean(target), ...(target?.name ? { name: target.name } : {}) });
            }
          } catch { /* keep the plain CTA */ }
        }
        setPhase(m.alreadyMember ? 'alreadyMember' : 'done');
      })
      .catch((err: unknown) => {
        accepting.current = false;
        // ADR 0564 — declined meanwhile (another tab, or before this page
        // loaded): the terminal state, not a generic failure banner.
        if (failureReason(err) === 'declined') { setPhase('declined'); return; }
        // IN-G4, hardened by R2 IN-SP-10 — discriminate by the STATUS CODE
        // (403 = the ownership gate) + the typed `reason`, never by matching
        // English prose.
        setFailure(failureOf(err));
        setFailedAction('accept');
        setPhase('failed');
      });
  }, [token]);

  // ADR 0564 D3 — Decline is consequential the other way (the inviter SEES the
  // refusal, and undoing it needs a fresh invite), so it is confirm-gated and
  // named for the org; the POST itself never fires on load (the IN-G1
  // posture). Shares the accept's in-flight guard: the two are exclusive.
  const decline = useCallback(async () => {
    if (accepting.current) return;
    const org = preview?.orgName ?? '';
    const ok = await confirm({
      title: t('acceptDeclineTitle', { org }),
      body: t('acceptDeclineBody', { org }),
      confirmLabel: t('acceptDeclineConfirm'),
      danger: true,
    });
    if (!ok || accepting.current) return;
    accepting.current = true;
    setPhase('declining');
    try {
      await declineInvitation(token);
      accepting.current = false;
      setPhase('declined');
    } catch (err) {
      accepting.current = false;
      setFailure(failureOf(err));
      setFailedAction('decline');
      setPhase('failed');
    }
  }, [token, preview, t]);

  // ORGINV-UX-6 — the outcome is USER-initiated, so it is announced assertively
  // (the `StateCard announce` prop is polite by design — it exists for failed
  // READS on load; see its docblock). The failure branch is announced by its
  // `<Notice announce>` below; only focus is managed here.
  useEffect(() => {
    if (phase === 'done' || phase === 'alreadyMember') {
      announceToScreenReader(phase === 'alreadyMember' ? t('acceptAlreadyMemberTitle') : t('acceptDoneTitle'), { assertive: true });
      (ctaRef.current ?? cardRef.current)?.focus();
    } else if (phase === 'declined') {
      // ADR 0564 D3 — user-initiated (or an accept that found it declined):
      // spoken assertively; the card has no CTA (the undo path is a person,
      // not a button), so the card itself takes focus — never <body>.
      announceToScreenReader(t('acceptDeclinedTitle'), { assertive: true });
      cardRef.current?.focus();
    } else if (phase === 'failed') {
      (failure !== 'generic' ? switchRef.current : failedAction === 'decline' ? declineRef.current : acceptRef.current)?.focus();
    }
  }, [phase, failure, failedAction, t]);

  // ORGINV-UX-11 — "Sign in with that address" needs a door IN the card, not
  // only the header account menu. Same triple the menu's Sign out runs
  // (`auth/SignInButton.tsx` — Firebase session + backend cookie + the shared
  // session store); the token stays in the URL so the flow resumes right here.
  const switchAccount = useCallback(async () => {
    await signOut().catch(() => {});
    await logout();
    setBackendSessionUser(null);
    accepting.current = false;
    setFailure('generic');
    setFailedAction('accept');
    setPhase('ready');
  }, []);

  if (phase === 'noToken') {
    return <StateCard icon={<MailIcon size={20} />} title={t('acceptNoTokenTitle')} body={t('acceptNoTokenBody')} />;
  }
  // R2 IN-SP-2/8 — expired says EXPIRED, and ends in the one actionable next
  // step (the Slack model): ask the person who invited you for a new one.
  if (phase === 'expired') {
    return <StateCard icon={<MailIcon size={20} />} title={t('acceptExpiredTitle')} body={t('acceptExpiredBody')} />;
  }
  if (phase === 'gone') {
    return <StateCard icon={<MailIcon size={20} />} title={t('acceptGoneTitle')} body={t('acceptGoneBody')} />;
  }
  // ADR 0564 D3 — the terminal declined state: names the org when the preview
  // is in hand (a just-declined recipient) and ends in the one undo path —
  // "ask them to re-invite you". `declinedGone` (the preview itself said
  // declined) has no org name to give; same card, load-time silent.
  if (phase === 'declined' || phase === 'declinedGone') {
    return (
      <div ref={cardRef} tabIndex={-1}>
        <StateCard
          icon={<MailIcon size={20} />}
          title={t('acceptDeclinedTitle')}
          body={preview ? t('acceptDeclinedBodyNamed', { org: preview.orgName }) : t('acceptDeclinedBody')}
        />
      </div>
    );
  }
  // R2 IN-SP-2 — a failed READ is not a dead link: retryable, honest copy.
  if (phase === 'loadFailed') {
    return (
      <StateCard
        icon={<MailIcon size={20} />}
        announce
        title={t('acceptLoadFailedTitle')}
        body={t('acceptLoadFailedBody')}
        action={<Button variant="secondary" onClick={() => setAttempt((a) => a + 1)}>{t('common:retry')}</Button>}
      />
    );
  }
  if (phase === 'loading' || loading) {
    // R2 IN-SP-6 — the old copy said "Accepting your invitation…" during the
    // deliberately-NON-accepting preview read.
    return <StateCard loading title={t('acceptLoadingTitle')} />;
  }
  if (phase === 'done' || phase === 'alreadyMember') {
    return (
      <div ref={cardRef} tabIndex={-1}>
      <StateCard
        icon={<MailIcon size={20} />}
        title={phase === 'alreadyMember' ? t('acceptAlreadyMemberTitle') : t('acceptDoneTitle')}
        body={[
          phase === 'alreadyMember'
            ? (preview ? t('acceptAlreadyMemberBodyNamed', { org: preview.orgName }) : t('acceptAlreadyMemberBody'))
            : (preview ? t('acceptDoneBodyNamed', { org: preview.orgName }) : t('acceptDoneBody')),
          // R3 F9 follow-on — disclose the workspace switch (a whole-app
          // context change deserves a sentence), or the honest no-access state.
          crossWs
            ? (crossWs.switchable
                ? (crossWs.name ? t('acceptCrossWorkspaceNoteNamed', { workspace: crossWs.name }) : t('acceptCrossWorkspaceNote'))
                : t('acceptCrossWorkspaceNoAccess'))
            : null,
        ].filter(Boolean).join(' ')}
        // R2 IN-SP-13 — land IN the org just joined (orgId was always in hand).
        // R3 F9 follow-on — a cross-workspace org needs the ACTIVE workspace
        // switched first, or the landing shows a list the org is not on.
        action={crossWs ? (
          crossWs.switchable ? (
            <Button
              ref={setCta}
              variant="primary"
              onClick={() => {
                // Same landing either way — a FAILED switch falls back to the
                // exact URL the plain CTA uses, where the OrgsPage controller
                // (R2 review F9) already clears an unknown selection cleanly.
                const dest = preview ? `/orgs?org=${encodeURIComponent(preview.orgId)}` : '/orgs';
                void switchWorkspace(crossWs.workspaceId)
                  .then(() => { window.location.assign(dest); })
                  .catch(() => { window.location.assign(dest); });
              }}
            >
              {/* ORGINV-UX-4 — the CTA deep-links into THIS org (and may switch
                  workspace): name it, instead of the generic "Open Organizations". */}
              {preview ? t('acceptGoToOrgNamed', { org: preview.orgName }) : t('acceptGoToOrg')}
            </Button>
          ) : undefined
        ) : (
          <Link ref={setCta} className="btn" to={preview ? `/orgs?org=${encodeURIComponent(preview.orgId)}` : '/orgs'}>
            {preview ? t('acceptGoToOrgNamed', { org: preview.orgName }) : t('acceptGoToOrg')}
          </Link>
        )}
      />
      </div>
    );
  }

  // The invitation resolved: show WHAT is being joined before asking for a
  // decision — org, role, the address it was issued to, and when it lapses.
  // R2 IN-SP-9 — invitable roles are the built-in trio; localize the label
  // instead of interpolating the raw wire id into all four locales.
  const roleKey = preview?.role === 'admin' ? 'roleLabelAdmin' : preview?.role === 'editor' ? 'roleLabelEditor' : 'roleLabelViewer';
  // ADR 0622 D7 — `unverified` gets its ONE actionable step (an admin sets the
  // address, or sign in through the IdP); a generic DECLINE failure must not
  // borrow the accept's "may be expired, revoked…" guess.
  const failureKey = failure === 'mismatch' ? 'acceptErrorMismatch'
    : failure === 'unverified' ? 'acceptErrorUnverified'
      : failedAction === 'decline' ? 'acceptDeclineFailed'
        : 'acceptErrorBody';
  const details = preview ? (
    <div className="u-grid u-gap-1 u-text-sm">
      {/* R2 IN-R2-1 — WHO invited: the recipient's primary phishing check. */}
      {preview.invitedBy ? <p className="u-m-0">{t('acceptInvitedBy', { name: preview.invitedBy })}</p> : null}
      <p className="u-m-0">{t('acceptPreviewRole', { role: t(roleKey) })}</p>
      <p className="u-m-0 muted">{t('acceptPreviewEmail', { email: preview.email })}</p>
      <p className="u-m-0 muted">
        {t('acceptPreviewExpires')} <time dateTime={preview.expiresAt}>{fmt.date(preview.expiresAt)}</time>
      </p>
      {/* ORGINV-UX-6 — a failed ACTION is announced assertively through the
          shell region (`ui/Notice.tsx:18` disclaims the inline role=alert). */}
      {phase === 'failed' ? (
        <Notice variant="error" announce={t(failureKey)}>
          {t(failureKey)}
        </Notice>
      ) : null}
    </div>
  ) : null;

  // Signed out: the same preview, but the next step is signing in. The token
  // stays in the URL, so the flow resumes here afterwards.
  if (!user) {
    return (
      <StateCard
        icon={<MailIcon size={20} />}
        title={preview ? t('acceptPreviewTitle', { org: preview.orgName }) : t('acceptSignInTitle')}
        // ADR 0564 D2/D3 — no Decline here: the decline gate is the accept
        // gate (signed-in + the invited address), so the copy says so instead
        // of offering a button that would only bounce to sign-in.
        body={<>{t('acceptSignInBody')} {t('acceptSignInDeclineNote')}{details}</>}
        // Review F8 — SignInButton renders NOTHING when Firebase isn't
        // configured (the password-appGate white-label case this page's
        // public-branch move exists for). Always offer the home-page door too:
        // AppGate's own flow takes over there, and this link keeps working.
        action={(
          <span className="u-flex u-items-center u-gap-2">
            <SignInButton />
            <Link className="btn secondary" to="/">{t('acceptSignInFallback')}</Link>
          </span>
        )}
      />
    );
  }

  return (
    <StateCard
      icon={<MailIcon size={20} />}
      title={preview ? t('acceptPreviewTitle', { org: preview.orgName }) : t('acceptSignInTitle')}
      body={details}
      action={(
        <>
          {/* ORGINV-UX-10 — `loading` = aria-busy + disabled with the label kept.
              ORGINV-UX-11 — after a 403 the SAME account cannot succeed, so
              Accept stays disabled until the account changes. */}
          <Button ref={acceptRef} variant="primary" onClick={accept} loading={phase === 'accepting'} disabled={accountBlocked || phase === 'declining'}>
            {t('acceptCta')}
          </Button>
          {/* ADR 0564 D3 — the secondary, confirm-gated Decline. Same 403
              posture as Accept: a blocked account cannot decline either. */}
          <Button ref={declineRef} variant="secondary" onClick={() => void decline()} loading={phase === 'declining'} disabled={accountBlocked || phase === 'accepting'}>
            {t('acceptDeclineCta')}
          </Button>
          {accountBlocked ? (
            <Button ref={switchRef} variant="secondary" onClick={() => void switchAccount()}>
              {t('acceptSwitchAccount')}
            </Button>
          ) : null}
        </>
      )}
    />
  );
}

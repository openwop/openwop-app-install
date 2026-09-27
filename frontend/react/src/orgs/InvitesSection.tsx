/**
 * Email invitations for an org (ADR 0004 UI; closes UX-ASSESSMENT AUTH-3).
 * The enterprise on-ramp: invite by EMAIL with a role, see pending invites,
 * revoke, and copy the accept link when the host exposes the one-time token
 * (non-production). Rendered inside MembersPanel above the direct-add form —
 * direct add stays for service/local accounts, but invite is the primary path.
 *
 * Gated on the `orgs` feature toggle (the invitation feature's own gate);
 * when the toggle is off this renders nothing and the panel behaves as before.
 */
import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../ui/Notice.js';
import { toast } from '../ui/toast.js';
import { confirm } from '../ui/confirm.js';
import { MailIcon } from '../ui/icons/index.js';
import { useFeatureAccess } from '../featureToggles/FeatureAccessContext.js';
import { acceptLinkFor, createInvite, inviteErrorDetails, listInvites, revokeInvite, type OrgInvite } from './invitesClient.js';
import { formatDateTime, formatRelativeTime } from '../i18n/format.js';
import { copyToClipboard } from '../ui/copyToClipboard.js';

export function InvitesSection({ orgId, canManage, assignableRoleIds, roleLabel }: {
  orgId: string;
  canManage: boolean;
  assignableRoleIds: string[];
  roleLabel: (id: string) => string;
}): JSX.Element | null {
  const { t } = useTranslation('orgs');
  const orgsFeature = useFeatureAccess('orgs');
  const [invites, setInvites] = useState<OrgInvite[] | null>(null);
  const [email, setEmail] = useState('');
  // Invitable roles are the built-ins minus owner (service contract); custom
  // roles are granted post-join. Default viewer — least privilege.
  const invitableRoles = assignableRoleIds.filter((r) => ['viewer', 'editor', 'admin'].includes(r));
  const [role, setRole] = useState('viewer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** ORGINV-UX-7(b) — the server REJECTED the address (400 invalid_email): the
   *  input reads as invalid and points at the message. Cleared on the next
   *  edit — the flag describes the value that was rejected, not the field. */
  const [emailInvalid, setEmailInvalid] = useState(false);
  const errorId = useId();
  const [lastLink, setLastLink] = useState<string | null>(null);
  /** R2 IN-SP-7 — a failed list read is NOT "no pending invites". */
  const [listFailed, setListFailed] = useState(false);

  const refresh = useCallback(() => {
    setListFailed(false);
    listInvites(orgId).then(setInvites).catch(() => setListFailed(true));
  }, [orgId]);
  useEffect(() => {
    if (orgsFeature.enabled && canManage) refresh();
  }, [orgsFeature.enabled, canManage, refresh]);

  if (!orgsFeature.enabled || !canManage) return null;

  /** Shared mint path for the form submit AND the expired-row Resend
   *  (ORGINV-UX-2 — the backend replaces-at-mint, so resend is one create).
   *  Returns whether the invite was issued, and on refusal the server's
   *  reason so the FORM caller can mark its input (a Resend has no input). */
  const issueInvite = async (invitedEmail: string, invitedRole: string): Promise<{ issued: true } | { issued: false; reason?: string }> => {
    try {
      const { token, delivery } = await createInvite(orgId, invitedEmail, invitedRole);
      // ORGINV-UX-3 — a SUCCESSFUL action retires any stale failure banner.
      setError(null);
      refresh();
      if (delivery === 'sent') {
        // Phase A: the accept link was EMAILED (ADR 0193 transactional send).
        toast.success(t('inviteEmailed', { email: invitedEmail }));
        if (token) setLastLink(acceptLinkFor(token)); // non-prod echo still handy
      } else if (token) {
        setLastLink(acceptLinkFor(token));
      } else {
        toast.success(t('inviteCreated'));
      }
      return { issued: true };
    } catch (err) {
      // R2 IN-SP-7/IN-SP-1 — no raw API strings; the 422 undeliverable
      // refusal (the mint was rolled back) gets its operator-actionable copy.
      const { reason, priorInviteStillValid } = inviteErrorDetails(err);
      // Review F1 — configuration vs transient get DIFFERENT guidance.
      // Review F4 — an invalid address gets fix-the-input copy, never a
      // retry-flavored message (retrying the same junk cannot succeed).
      // ADR 0622 D5 — a re-invite whose delivery failed was rolled back and
      // the EARLIER invitation is still live: "nothing was kept" would be a
      // lie about the row the recipient can still redeem, so say which.
      setError(t(
        reason === 'invalid_email' ? 'inviteInvalidEmail'
          : reason === 'undeliverable' ? (priorInviteStillValid ? 'inviteUndeliverablePriorValid' : 'inviteUndeliverable')
            : reason === 'delivery_failed' ? (priorInviteStillValid ? 'inviteDeliveryFailedPriorValid' : 'inviteDeliveryFailed')
              : 'inviteCreateFailed',
      ));
      return { issued: false, ...(reason ? { reason } : {}) };
    }
  };

  const onInvite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setLastLink(null);
    setEmailInvalid(false);
    const result = await issueInvite(email.trim(), role);
    if (result.issued) setEmail('');
    else if (result.reason === 'invalid_email') setEmailInvalid(true);
    setBusy(false);
  };

  // ORGINV-UX-2 — one-click resend for an EXPIRED row. Under the hood it is
  // `createInvite` again, whose replace-at-mint semantics KILL any previously
  // sent link — the confirm states that consequence before it happens.
  // ADR 0564 D4 — on a DECLINED row the confirm also says the recipient
  // refused the previous one: re-inviting after a decline is the inviter's
  // explicit, informed choice (no cooldown — ADR 0622 answered OQ1).
  const onResend = async (inv: OrgInvite) => {
    const bodyKey = inv.status === 'declined' ? 'inviteResendBodyDeclined' : 'inviteResendBody';
    if (!(await confirm({ title: t('inviteResendTitle'), body: t(bodyKey, { email: inv.email }) }))) return;
    setBusy(true);
    setLastLink(null);
    await issueInvite(inv.email, inv.role);
    setBusy(false);
  };

  const onRevoke = async (inv: OrgInvite) => {
    if (!(await confirm({ title: t('inviteRevokeTitle'), body: t('inviteRevokeBody', { email: inv.email }), danger: true }))) return;
    try {
      await revokeInvite(orgId, inv.inviteId);
      // ORGINV-UX-3 — the stale create-failure banner used to survive a later
      // SUCCESSFUL revoke (it was only cleared at invite-submit start).
      setError(null);
      setEmailInvalid(false);
      refresh();
      // ORGINV-UX-7(c) — the row vanishing was the only feedback; a screen-
      // reader user heard nothing. `toast.success` routes through `announce`.
      toast.success(t('inviteRevoked', { email: inv.email }));
    } catch {
      setError(t('inviteRevokeFailed'));
    }
  };

  const copyLink = () => {
    if (!lastLink) return;
    void copyToClipboard(lastLink, t('inviteLinkCopied'));
  };

  return (
    <div className="u-mb-4">
      <h4 className="u-fs-13 u-flex u-items-center u-gap-1-5 u-mb-2">
        <MailIcon size={14} /> {t('invitesHeading')}
      </h4>
      <form onSubmit={(e) => void onInvite(e)} className="action-bar u-wrap u-mb-2">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => { setEmail(e.target.value); setEmailInvalid(false); }}
          placeholder={t('inviteEmailPlaceholder')}
          aria-label={t('inviteEmailAriaLabel')}
          {...(emailInvalid ? { 'aria-invalid': true, 'aria-describedby': errorId } : {})}
        />
        <select value={role} onChange={(e) => setRole(e.target.value)} aria-label={t('inviteRoleAriaLabel')}>
          {invitableRoles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
        </select>
        {/* ORGINV-UX-10 — `loading` sets aria-busy + disabled and KEEPS the
            accessible name; the old label swap renamed the control mid-flight. */}
        <Button variant="primary" type="submit" loading={busy} disabled={!email.trim()}>{t('inviteSend')}</Button>
      </form>
      {/* ORGINV-UX-7(a) — a FAILED action is announced (assertive, via the shell
          region — `ui/Notice.tsx:18` disclaims the inline role=alert). The
          wrapper carries the id the rejected input's `aria-describedby` targets:
          `Notice` makes `id`/`announce` exclusive because LIVE validation would
          speak on every keystroke, but this error fires once per SUBMIT, and the
          description is only re-read when focus next lands on the input — the
          recovery step (WCAG 3.3.1 identify + associate). */}
      {error && <div id={errorId}><Notice variant="error" announce={error}>{error}</Notice></div>}
      {lastLink && (
        <Notice variant="success" announce={t('inviteLinkReady')}>
          {t('inviteLinkReady')}{' '}
          <Button variant="secondary" size="sm" onClick={copyLink}>{t('inviteCopyLink')}</Button>
        </Notice>
      )}
      {listFailed ? (
        <Notice variant="warning" announce={t('invitesListFailed')}>
          {t('invitesListFailed')}{' '}
          <Button variant="quiet" size="sm" onClick={refresh}>{t('common:retry')}</Button>
        </Notice>
      ) : null}
      {/* ORGINV-UX-1 — loading and true-empty were both "render nothing", so an
          admin reading "nothing pending" during a slow load could re-send and
          silently invalidate a live link (replace-at-mint). Each state now says
          what it is. */}
      {invites === null && !listFailed && (
        <p className="muted u-fs-12 u-m-0 u-py-1">{t('invitesLoading')}</p>
      )}
      {invites !== null && invites.length === 0 && !listFailed && (
        <p className="muted u-fs-12 u-m-0 u-py-1">{t('invitesEmpty')}</p>
      )}
      {invites && invites.length > 0 && (
        <ul className="u-m-0 u-p-0" role="list">
          {invites.map((inv) => {
            // R2 IN-SP-7 — expired rows linger up to 30d server-side; an
            // expired invite must not look pending. ORGINV-4 + review F5 — the
            // server marker is serialization-TIME state, so OR the local clock
            // in: a row that lapses while the page sits open must flip to
            // Expired (and gain Resend) without a refresh.
            const expired = inv.expired || Date.parse(inv.expiresAt) < Date.now();
            // ADR 0564 D4 — a declined row is a dead one the inviter can SEE.
            // It outranks Expired (the more informative fact), keeps Revoke
            // (cleanup) and gains Resend (a fresh mint replaces the row).
            const declined = inv.status === 'declined';
            return (
              <li key={inv.inviteId} className="u-flex u-wrap u-items-center u-gap-2 u-py-1">
                <span className="u-flex-1 u-truncate">{inv.email}</span>
                {/* ORGINV-UX-9 — WHO invited (the wire has carried it since
                    mint; the client type used to drop it). */}
                {inv.createdByName ? <span className="muted u-fs-12 u-truncate">{t('inviteInvitedBy', { name: inv.createdByName })}</span> : null}
                <span className="chip chip--muted">{roleLabel(inv.role)}</span>
                {/* ORGINV-UX-9 — relative phrasing ("expires in 3 days") in a
                    `<time dateTime>` like the accept page; the absolute stamp
                    rides `title`. */}
                {/* ADR 0564 D4 — `chip--warning`, the register THIS list already
                    uses for the terminal-negative Expired row (a state to
                    leave-and-resend, not a fault — DESIGN.md §5.1); the label
                    carries the meaning, never the colour alone (§5.3). The
                    absolute `declinedAt` rides the chip's title (the ADR's
                    wording) and, like a pending row's expiry, a relative
                    `<time dateTime>` beside it so it is visible without hover. */}
                {declined ? (
                  <>
                    <span className="chip chip--warning" {...(inv.declinedAt ? { title: t('inviteDeclinedAt', { when: formatDateTime(inv.declinedAt) }) } : {})}>
                      {t('inviteDeclinedChip')}
                    </span>
                    {inv.declinedAt ? (
                      <time className="muted u-fs-12" dateTime={inv.declinedAt} title={formatDateTime(inv.declinedAt)}>
                        {t('inviteDeclinedWhen', { when: formatRelativeTime(inv.declinedAt) })}
                      </time>
                    ) : null}
                  </>
                ) : expired
                  ? <span className="chip chip--warning">{t('inviteExpiredChip')}</span>
                  : (
                    <time className="muted u-fs-12" dateTime={inv.expiresAt} title={formatDateTime(inv.expiresAt)}>
                      {t('inviteExpires', { when: formatRelativeTime(inv.expiresAt) })}
                    </time>
                  )}
                {(expired || declined) && (
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onResend(inv)}>{t('inviteResend')}</Button>
                )}
                <Button variant="secondary" size="sm" onClick={() => void onRevoke(inv)}>{t('inviteRevoke')}</Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

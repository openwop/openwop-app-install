/**
 * Circles (ADR 0419 P5) — consensual accountability management: create a
 * circle from an enrollment, invite with EXPLICIT scopes (the disclosure is
 * the UI), see exactly what members see (the projected feed), revoke
 * instantly. Cohesion classes + labeled chips; 4-locale copy; loading +
 * designed empty states.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { UserIcon } from '../../ui/icons/index.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { TextField } from '../../ui/Field.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { loadOrgMembers } from '../../orgs/orgMembers.js';
import type { OrgMember } from '../../client/accessClient.js';
import { listEnrollments, type Enrollment } from '../../client/kicktodoClient.js';
import {
  listCircles,
  createCircle,
  listGrants,
  invite,
  revoke,
  getFeed,
  listSessions,
  scheduleSession,
  listProposals,
  resolveProposalAction,
  type Circle,
  type Grant,
  type CircleFeed,
  type CohortSession,
  type PlanChangeProposal,
} from '../../client/kicktodoCirclesClient.js';
import { formatDate } from '../../i18n/format.js';
import { useAuth } from '../../auth/useAuth.js';
import { SignInButton } from '../../auth/SignInButton.js';

const SCOPES = ['progress-summary', 'action-status', 'check-in-note', 'message', 'coach-plan-proposal'] as const;

function scopeKey(scope: string): string {
  switch (scope) {
    case 'progress-summary': return 'scopeProgressSummary';
    case 'action-status': return 'scopeActionStatus';
    case 'check-in-note': return 'scopeCheckInNote';
    case 'message': return 'scopeMessage';
    default: return 'scopeCoachProposal';
  }
}

/** The concrete "what this person will actually see" copy for each scope — the
 *  §5.9 privacy preview: a share never hides what it reveals behind a scope name. */
function revealKey(scope: string): string {
  switch (scope) {
    case 'progress-summary': return 'revealProgressSummary';
    case 'action-status': return 'revealActionStatus';
    case 'check-in-note': return 'revealCheckInNote';
    case 'message': return 'revealMessage';
    default: return 'revealCoachProposal';
  }
}

export function CirclesPage() {
  const { t } = useTranslation('kicktodo-circles');
  const { user, isConfigured } = useAuth();
  const anonymous = isConfigured && !user;
  const [circles, setCircles] = useState<Circle[] | null>(null);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [grantsByCircle, setGrantsByCircle] = useState<Record<string, Grant[] | null>>({});
  const [feedByCircle, setFeedByCircle] = useState<Record<string, CircleFeed>>({});
  const [error, setError] = useState(false);
  // Per-ACTION busy (screen-polish: one global boolean froze every control in
  // every circle while any single action was in flight).
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Workspace members — grant subjects render as PEOPLE (display names), never
  // opaque ids (ADR 0436 §1's one hard rule). Empty on fetch failure → the
  // honest mono fallback renders instead.
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [inviteSubject, setInviteSubject] = useState<Record<string, string>>({});
  const [inviteScopes, setInviteScopes] = useState<Record<string, string[]>>({});
  const [sessionsByCircle, setSessionsByCircle] = useState<Record<string, CohortSession[] | null>>({});
  // ADR 0459 P2 — read-only coach-proposal history (owner-gated; null = not the
  // owner / failed, so the section stays hidden). The DECISION happens on the
  // approval card in the conversation, never here.
  const [proposalsByCircle, setProposalsByCircle] = useState<Record<string, PlanChangeProposal[] | null>>({});
  const [sessionAt, setSessionAt] = useState<Record<string, string>>({});
  const [sessionTitle, setSessionTitle] = useState<Record<string, string>>({});
  // grade-ux: mutation failures are NOT load failures — separate signal.
  const [actionError, setActionError] = useState(false);

  const nameOf = (subject: string): string | null =>
    members.find((m) => m.subject === subject)?.displayName ?? null;

  // ADR 0459 grade-fix — the honest fallback for a DEGRADED proposal (raised with no
  // approval card): decide it on the retained per-enrollment route. Only rendered for a
  // pending proposal that has no card — a carded proposal is decided on the card.
  const onResolveProposal = async (enrollmentId: string, proposalId: string, action: 'apply' | 'dismiss') => {
    setBusyKey(`proposal:${proposalId}`); setActionError(false);
    try {
      await resolveProposalAction(enrollmentId, proposalId, action);
      await reload();
    } catch { setActionError(true); }
    finally { setBusyKey(null); }
  };

  const onScheduleSession = async (circleId: string) => {
    const local = (sessionAt[circleId] ?? '').trim();
    if (!local) return;
    setBusyKey(`session:${circleId}`); setActionError(false);
    try {
      await scheduleSession(circleId, new Date(local).toISOString(), (sessionTitle[circleId] ?? '').trim());
      setSessionAt((s) => ({ ...s, [circleId]: '' }));
      setSessionTitle((s) => ({ ...s, [circleId]: '' }));
      await reload();
    } catch { setActionError(true); }
    finally { setBusyKey(null); }
  };

  // grade-ux: revoke is a CONSENT control — it must never fail silently, and
  // it must not be double-clickable in flight.
  const onRevoke = async (circleId: string, granteeSubject: string) => {
    setBusyKey(`revoke:${circleId}:${granteeSubject}`); setActionError(false);
    try { await revoke(circleId, granteeSubject); await reload(); }
    catch { setActionError(true); }
    finally { setBusyKey(null); }
  };

  const reload = useCallback(async () => {
    if (anonymous) return;
    try {
      setError(false);
      const [cs, es, ms] = await Promise.all([
        listCircles(),
        listEnrollments(),
        loadOrgMembers().catch(() => [] as OrgMember[]),
      ]);
      setCircles(cs);
      setEnrollments(es);
      setMembers(ms);
      const grants: Record<string, Grant[] | null> = {};
      const feeds: Record<string, CircleFeed> = {};
      const sess: Record<string, CohortSession[] | null> = {};
      const props: Record<string, PlanChangeProposal[] | null> = {};
      await Promise.all(cs.map(async (c) => {
        // null = the section FAILED to load (rendered as an error line, never
        // conflated with a truly empty section — grade-ux). Proposals are
        // owner-gated: a non-owner 404s → null → the history section stays hidden.
        const [g, f, s, p] = await Promise.all([
          listGrants(c.id).catch(() => null),
          getFeed(c.id).catch(() => null),
          listSessions(c.id).catch(() => null),
          listProposals(c.enrollmentId).catch(() => null),
        ]);
        grants[c.id] = g;
        if (f) feeds[c.id] = f;
        sess[c.id] = s;
        props[c.id] = p;
      }));
      setGrantsByCircle(grants);
      setFeedByCircle(feeds);
      setSessionsByCircle(sess);
      setProposalsByCircle(props);
    } catch {
      setError(true);
    }
  }, [anonymous]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onCreate = async () => {
    // A circle per enrollment: the next ACTIVE enrollment that doesn't have one
    // yet (screen-polish: the create path used to exist only inside the empty
    // state — a second enrollment could never get a circle).
    const enrollment = enrollments.find((e) => e.state === 'active' && !(circles ?? []).some((c) => c.enrollmentId === e.id));
    if (!enrollment) return;
    setBusyKey('create');
    setActionError(false);
    try {
      await createCircle(enrollment.id, 'partner', t('title'));
      await reload();
    } catch {
      setActionError(true);
    } finally {
      setBusyKey(null);
    }
  };

  const onInvite = async (circleId: string) => {
    const subject = (inviteSubject[circleId] ?? '').trim();
    const scopes = inviteScopes[circleId] ?? ['action-status'];
    if (!subject) return;
    setBusyKey(`invite:${circleId}`);
    setActionError(false);
    try {
      await invite(circleId, subject, scopes);
      setInviteSubject((s) => ({ ...s, [circleId]: '' }));
      await reload();
    } catch {
      setActionError(true);
    } finally {
      setBusyKey(null);
    }
  };

  const toggleScope = (circleId: string, scope: string) => {
    setInviteScopes((s) => {
      const current = s[circleId] ?? ['action-status'];
      let next = current.includes(scope) ? current.filter((x) => x !== scope) : [...current, scope];
      // KT-EXP-2 (grade-data): the backend nests check-in notes INSIDE the action
      // array, so `check-in-note` only discloses anything when `action-status` is
      // also granted. Model that dependency both ways so the preview can never
      // promise a note disclosure the feed won't actually make: picking notes pulls
      // in action-status; dropping action-status drops notes with it.
      if (scope === 'check-in-note' && next.includes('check-in-note') && !next.includes('action-status')) {
        next = [...next, 'action-status'];
      }
      if (scope === 'action-status' && !next.includes('action-status')) {
        next = next.filter((x) => x !== 'check-in-note');
      }
      return { ...s, [circleId]: next };
    });
  };

  return (
    <div className="page" data-walkthrough="kicktodo-circles.page">
      <PageHeader
        title={t('title')}
        lede={t('lede')}
        actions={!anonymous ? (
          <>
            {/* ADR 0501 (console) — the coach's desk; static link, so the page
                needs no caseload read of its own (the console shows its own
                honest empty state when nobody has invited you to coach). */}
            <Link className="btn-ghost btn-sm" to="/circles/coach">{t('coachOpenConsole')}</Link>
            {enrollments.some((e) => e.state === 'active' && !(circles ?? []).some((c) => c.enrollmentId === e.id)) ? (
              <Button variant="accent" size="sm" disabled={busyKey === 'create'}
                aria-busy={busyKey === 'create'} onClick={() => void onCreate()}>
                {t('createCta')}
              </Button>
            ) : null}
          </>
        ) : undefined}
      />

      {anonymous ? (
        <StateCard
          icon={<UserIcon aria-hidden />}
          title={t('signedOutTitle')}
          body={t('signedOutBody')}
          action={
            <div>
              <p className="muted u-fs-13">{t('signedOutPrivacy')}</p>
              <SignInButton />
            </div>
          }
        />
      ) : null}

      {/* KTX-1 — a load failure always carries its retry. */}
      {!anonymous && error && (
        <Notice variant="error">
          {t('loadError')}{' '}
          <Button variant="quiet" size="sm" onClick={() => void reload()}>{t('common:retry')}</Button>
        </Notice>
      )}
      {!anonymous && actionError && <Notice variant="error">{t('actionError')}</Notice>}
      {!anonymous && !circles && !error && <StateCard loading title={t('title')} />}

      {!anonymous && circles && circles.length === 0 && !error && (
        <StateCard
          icon={<UserIcon aria-hidden />}
          title={t('emptyTitle')}
          body={t('emptyBody')}
          action={
            enrollments.some((e) => e.state === 'active') ? (
              <Button variant="accent-solid" disabled={busyKey === 'create'} aria-busy={busyKey === 'create'} onClick={() => void onCreate()}>
                {t('createCta')}
              </Button>
            ) : undefined
          }
        />
      )}

      {!anonymous && circles?.map((c) => {
        const grants = grantsByCircle[c.id] ?? null;
        const feed = feedByCircle[c.id];
        return (
          <section key={c.id} className="surface-card" aria-label={c.name}>
            {/* The circle's NAME is content, not chrome — title register (the
                13px name was smaller than its own body text). */}
            <div className="action-bar">
              <h2 className="kt-circle-name">{c.name}</h2>
              <span className="chip">{t(`type${c.type.charAt(0).toUpperCase()}${c.type.slice(1)}`)}</span>
            </div>

            <h3 className="kt-eyebrow">{t('membersHeading')}</h3>
            {grants === null && <p className="muted u-fs-13">{t('sectionLoadError')}</p>}
            <ul role="list" className="list-plain">
              {(grants ?? []).map((g) => (
                <li key={g.granteeSubject} className="list-row">
                  <div>
                    {/* A person, not an id (ADR 0436 §1): resolve via the
                        workspace roster; someone no longer resolvable renders
                        the honest label with the id demoted to a tooltip. */}
                    {nameOf(g.granteeSubject)
                      ? <strong>{nameOf(g.granteeSubject)}</strong>
                      : <strong title={g.granteeSubject}>{t('formerMemberLabel')}</strong>}
                    <div className="action-bar">
                      {g.scopes.map((s) => (
                        <span key={s} className="chip chip--muted">{t(scopeKey(s))}</span>
                      ))}
                    </div>
                  </div>
                  <span className={g.state === 'active' ? 'chip chip--success' : g.state === 'revoked' ? 'chip chip--muted' : 'chip'}>
                    {g.state === 'active' ? t('activeBadge') : g.state === 'revoked' ? t('revokedBadge') : t('invitedBadge')}
                  </span>
                  {g.state !== 'revoked' && (
                    <Button
                      variant="quiet" size="sm"
                      disabled={busyKey === `revoke:${c.id}:${g.granteeSubject}`}
                      aria-busy={busyKey === `revoke:${c.id}:${g.granteeSubject}`}
                      onClick={() => void onRevoke(c.id, g.granteeSubject)}
                      aria-label={`${t('revokeCta')}: ${nameOf(g.granteeSubject) ?? t('formerMemberLabel')}`}
                    >
                      {t('revokeCta')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>

            <h3 className="kt-eyebrow">{t('inviteHeading')}</h3>
            {/* A PICKER of workspace members — nobody types an opaque subject
                id (the ADR §1 breach this screen shipped with). Members already
                granted (or yourself) are excluded. Roster unavailable → the
                honest id field remains as the fallback. */}
            {members.length > 0 ? (
              <div className="field">
                <label className="field-label" htmlFor={`kt-invite-${c.id}`}>{t('inviteMemberLabel')}</label>
                <select id={`kt-invite-${c.id}`} value={inviteSubject[c.id] ?? ''}
                  onChange={(e) => setInviteSubject((s) => ({ ...s, [c.id]: e.target.value }))}>
                  <option value="">{t('inviteMemberPrompt')}</option>
                  {members
                    .filter((m) => !!m.subject && !(grants ?? []).some((g) => g.granteeSubject === m.subject && g.state !== 'revoked'))
                    .map((m) => <option key={m.subject} value={m.subject}>{m.displayName}</option>)}
                </select>
              </div>
            ) : (
              <TextField
                label={t('inviteMemberLabel')}
                value={inviteSubject[c.id] ?? ''}
                onChange={(e) => setInviteSubject((s) => ({ ...s, [c.id]: e.target.value }))}
              />
            )}
            <div className="action-bar" role="group" aria-label={t('scopesGroupLabel')}>
              {SCOPES.map((s) => {
                const selected = (inviteScopes[c.id] ?? ['action-status']).includes(s);
                return (
                  <button key={s} type="button" className={selected ? 'chip chip--accent' : 'chip'}
                    aria-pressed={selected} onClick={() => toggleScope(c.id, s)}>
                    {t(scopeKey(s))}
                  </button>
                );
              })}
            </div>
            {/* §5.9 — a concrete "who can see what" preview BEFORE the invite is sent:
                the person sees exactly what each selected scope reveals about them. */}
            {(() => {
              const selected = inviteScopes[c.id] ?? ['action-status'];
              return (
                <Notice variant="info" aria-live="polite">
                  <strong className="u-fs-13">{t('privacyPreviewHeading')}</strong>
                  {selected.length === 0 ? (
                    <p className="u-fs-13">{t('privacyNothingSelected')}</p>
                  ) : (
                    <ul>{selected.map((s) => <li key={s}>{t(revealKey(s))}</li>)}</ul>
                  )}
                </Notice>
              );
            })()}
            <div className="action-bar">
              <Button variant="accent-solid"
                disabled={busyKey === `invite:${c.id}` || !(inviteSubject[c.id] ?? '').trim() || (inviteScopes[c.id] ?? ['action-status']).length === 0}
                aria-busy={busyKey === `invite:${c.id}`}
                onClick={() => void onInvite(c.id)}>
                {t('inviteCta')}
              </Button>
            </div>

            {feed?.summary && (
              <>
                <h3 className="kt-eyebrow">{t('feedHeading')}</h3>
                <p className="muted u-fs-13">
                  {t('feedProgress', {
                    current: feed.summary.currentDay,
                    total: feed.summary.durationDays,
                    done: feed.summary.completedActivities,
                    required: feed.summary.totalRequiredActivities,
                  })}
                </p>
              </>
            )}

            {/* ADR 0459 P2 + grade-fix — coach plan-proposals. When a proposal raised
                an approval CARD, the decision (accept / decline) happens on that card in
                the circle conversation or the reviews rail — this list is read-only
                history and points there. When the card raise DEGRADED (no card), the
                decision would otherwise be unreachable, so the honest apply/dismiss
                fallback on the retained route is rendered inline for that row only.
                Load state: null = the section FAILED to load (→ sectionLoadError, the
                grants-section convention); [] = loaded-but-empty (→ discoverability
                empty-state line); a non-empty list renders the history. */}
            {(() => {
              const proposals = proposalsByCircle[c.id];
              const heading = <h3 className="kt-eyebrow">{t('proposalsHeading')}</h3>;
              if (proposals === null) {
                return <>{heading}<p className="muted u-fs-13">{t('sectionLoadError')}</p></>;
              }
              if (!proposals || proposals.length === 0) {
                return <>{heading}<p className="muted u-fs-13">{t('proposalsEmptyHint')}</p></>;
              }
              const anyCarded = proposals.some((p) => !!p.approvalId);
              return (
                <>
                  {heading}
                  <ul role="list" className="list-plain">
                    {proposals.map((p) => {
                      const noCardPending = p.state === 'proposed' && !p.approvalId;
                      return (
                        <li key={p.id} className="list-row">
                          <div>
                            <span className="u-fs-13">{t('proposalByLabel')} <strong>{nameOf(p.coachSubject) ?? t('formerMemberLabel')}</strong></span>
                            {/* KT-HONESTY-1 — the note is the coach's PROSE and is never
                                executed; nothing structured exists to execute. Label it as
                                advice at the point of reading, so the CTA below cannot be
                                mistaken for "the coach's change was made". */}
                            <span className="chip chip--muted u-fs-12">{t('proposalAdviceLabel')}</span>
                            <p className="u-fs-13 muted">{p.note}</p>
                            <span className="u-fs-13 muted">
                              {p.resolvedAt
                                ? t('proposalDecidedAt', { when: formatDate(p.resolvedAt, { dateStyle: 'medium' }) })
                                : t('proposalRaisedAt', { when: formatDate(p.createdAt, { dateStyle: 'medium' }) })}
                            </span>
                          </div>
                          {noCardPending ? (
                            <div>
                              {/* State the consequence BEFORE the click. The action
                                  re-materializes from the participant's OWN current
                                  settings — it does not perform the coach's change. */}
                              <p className="u-fs-12 muted u-mt-0">{t('proposalApplyHint')}</p>
                            <div className="action-bar">
                              <Button variant="accent-solid" size="sm" disabled={busyKey === `proposal:${p.id}`}
                                aria-busy={busyKey === `proposal:${p.id}`}
                                onClick={() => void onResolveProposal(c.enrollmentId, p.id, 'apply')}>
                                {t('proposalApplyCta')}
                              </Button>
                              <Button variant="quiet" size="sm" disabled={busyKey === `proposal:${p.id}`}
                                onClick={() => void onResolveProposal(c.enrollmentId, p.id, 'dismiss')}>
                                {t('proposalDismissCta')}
                              </Button>
                            </div>
                            </div>
                          ) : (
                            <span className={p.state === 'applied' ? 'chip chip--success' : p.state === 'dismissed' ? 'chip chip--muted' : 'chip chip--warning'}>
                              {p.state === 'applied' ? t('proposalApplied') : p.state === 'dismissed' ? t('proposalDismissed') : t('proposalPending')}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {anyCarded && (
                    <Notice variant="info">
                      {t('proposalsDecideHint')}{' '}
                      <a href={`/?conversation=${encodeURIComponent(c.conversationId)}`}>{t('proposalsDecideLink')}</a>
                    </Notice>
                  )}
                </>
              );
            })()}

            {/* ADR 0444 S1/S2 — cohort sessions: a scheduled moment in THIS
                circle's chat (the ONE chat — join deep-links the conversation). */}
            <h3 className="kt-eyebrow">{t('sessionsHeading')}</h3>
            {sessionsByCircle[c.id] === null && <p className="muted u-fs-13">{t('sectionLoadError')}</p>}
            {(sessionsByCircle[c.id] ?? []).length === 0
              ? sessionsByCircle[c.id] !== null && <p className="muted u-fs-13">{t('sessionsEmpty')}</p>
              : (
                <ul role="list" className="list-plain">
                  {(sessionsByCircle[c.id] ?? []).map((s) => (
                    <li key={s.atIso} className="list-row">
                      <div>
                        <strong>{s.title}</strong>
                        <span className="muted u-fs-13"> · {formatDate(s.atIso, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                      </div>
                      <a className="btn-ghost btn-sm" href={`/?conversation=${encodeURIComponent(s.conversationId)}`}>{t('sessionJoin')}</a>
                    </li>
                  ))}
                </ul>
              )}
            {/* A form is a form, not a button cluster (the ≤760px action-bar
                wrap defect this page shipped with). */}
            <div className="kt-inline-form">
              <TextField label={t('sessionTitleLabel')} value={sessionTitle[c.id] ?? ''}
                placeholder={t('sessionTitlePlaceholder')}
                onChange={(e) => setSessionTitle((s) => ({ ...s, [c.id]: e.target.value }))} />
              <div className="field">
                <label className="field-label" htmlFor={`kt-session-at-${c.id}`}>{t('sessionScheduleLabel')}</label>
                <input id={`kt-session-at-${c.id}`} type="datetime-local"
                  value={sessionAt[c.id] ?? ''} onChange={(e) => setSessionAt((s) => ({ ...s, [c.id]: e.target.value }))} />
              </div>
              <div className="action-bar">
                <Button variant="quiet" size="sm"
                  disabled={busyKey === `session:${c.id}` || !(sessionAt[c.id] ?? '').trim()}
                  aria-busy={busyKey === `session:${c.id}`}
                  onClick={() => void onScheduleSession(c.id)}>
                  {t('sessionScheduleCta')}
                </Button>
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}

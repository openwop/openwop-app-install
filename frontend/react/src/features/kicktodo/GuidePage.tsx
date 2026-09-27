/**
 * KickTodo Guide (ADR 0436 §5.8 → ADR 0442 Guide wave) — the participant's
 * durable relationship with their named KickBot, now a CHAT-FIRST coaching
 * surface (the Studio precedent). It embeds the ONE shared chat scoped to
 * `host:kickbot` IN PLACE via `EmbeddedChatPanel` (CLAUDE.md "reuse, never
 * recreate" — never a second chat panel), keeping the full-chat deep-link as the
 * durable-thread escape hatch. KickBot grounds its coaching in the participant's
 * real state through its read tools (today, progress, plan, journal, awards,
 * leaderboard, circles, coach proposals); the live reads this page already makes
 * (next action + pending proposals) seed the welcome so the first message can be
 * about what's actually in front of them.
 *
 * ADR 0436 §5.8 correction: this page previously deliberately stayed a LANDING
 * surface ("not a chat"); the Guide wave overturns that — see the ADR 0436
 * correction note. The agent's CHOSEN NAME still opens the page in the serif
 * human register (§4.2); a load failure renders as a failure with retry.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { TextField } from '../../ui/Field.js';
import { confirm } from '../../ui/confirm.js';
import { EmbeddedChatPanel } from '../../chat/EmbeddedChatPanel.js';
import { getToday, listEnrollments, type TodayView } from '../../client/kicktodoClient.js';
import { listProposals, type PlanChangeProposal } from '../../client/kicktodoCirclesClient.js';
import { getRosterEntry, updateRosterEntry } from '../../agents/rosterClient.js';
// §5.8 memories — the SAME curated-notes lane the /agents workspace uses
// (workspace-scoped routes; reuse-never-recreate, the shared `orgs/orgMembers` loader precedent).
import { listNotes, deleteNote, type MemoryNote } from '../agent-knowledge/agentKnowledgeClient.js';
import { formatDate } from '../../i18n/format.js';
import { GuideWelcome } from './GuideWelcome.js';
import { useAuth } from '../../auth/useAuth.js';
import { SignInButton } from '../../auth/SignInButton.js';
import { CalendarIcon, ShieldIcon, SparklesIcon } from '../../ui/icons/index.js';

const KICKBOT_ROSTER_ID = 'host:kickbot';
const KICKBOT_CHAT = `/?agent=${KICKBOT_ROSTER_ID}`;

export function GuidePage() {
  const { t } = useTranslation('kicktodo');
  const { user, isConfigured } = useAuth();
  const anonymous = isConfigured && !user;
  // undefined = loading; null = FAILED (rendered as a failure + retry, never
  // conflated with "nothing due" — the failure-as-empty fix).
  const [today, setToday] = useState<TodayView | null | undefined>(undefined);
  const [guideName, setGuideName] = useState<string | null>(null);
  /** undefined = loading; null = we could not check; [] = checked, none pending. */
  const [proposals, setProposals] = useState<PlanChangeProposal[] | null | undefined>(undefined);
  // §5.8 — memories with review/delete, IN surface. null = the notes lane is
  // unavailable to this caller (read failed / no scope): the section simply
  // doesn't render and the /agents shortcut below stays the honest path.
  const [notes, setNotes] = useState<MemoryNote[] | null>(null);
  const [noteBusy, setNoteBusy] = useState<string | null>(null);
  const [noteError, setNoteError] = useState(false);
  // §5.8 — rename-without-losing-continuity (label-only roster patch).
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState(false);

  /**
   * Guards every continuation in `reload()` below. Each read here is
   * fire-and-forget, so a `.then`/`.catch` can land after the page unmounts and
   * call setState on a dead component. Under jsdom that is
   * `ReferenceError: window is not defined` (React's `getCurrentEventPriority`
   * touches `window`) — an UNHANDLED REJECTION that fails the whole frontend
   * suite while every test still reports green. Observed on `listNotes` here;
   * the other four reads in `reload()` have the same shape.
   *
   * Re-armed INSIDE the effect, never cleanup-only: StrictMode mounts → cleans
   * up → remounts, so a ref only set false in cleanup is already false when the
   * component is really live and the guard disables what it protects (the
   * ADR 0517 Phase E trap). Same shape as `memory/MemoryBrowser`.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const reload = useCallback(() => {
    setToday(undefined);
    setProposals(undefined);
    void getToday().then((r) => { if (mounted.current) setToday(r); }).catch(() => { if (mounted.current) setToday(null); });
    // The chosen name — best-effort; the sans title stands in until it loads
    // (never a fabricated placeholder name).
    void getRosterEntry(KICKBOT_ROSTER_ID)
      .then((e) => { if (mounted.current) setGuideName(e.label ?? e.persona); })
      .catch(() => { if (mounted.current) setGuideName(null); });
    // Participant-governed plan-change proposals across active enrollments.
    // Promise.all is deliberate: a partial list could understate the decisions
    // waiting on the participant, so any unreadable enrollment makes the whole
    // summary honestly unavailable instead of fabricating a smaller count.
    void listEnrollments()
      .then(async (es) => {
        const active = es.filter((e) => e.state === 'active');
        const lists = await Promise.all(active.map((e) => listProposals(e.id)));
        if (mounted.current) {
          setProposals(lists.flat().filter((p) => p.state === 'proposed'));
        }
      })
      .catch(() => { if (mounted.current) setProposals(null); });
    // The guide's curated memories (fails soft to "lane unavailable" — never a
    // fabricated empty; the /agents shortcut remains the fallback path).
    void listNotes(KICKBOT_ROSTER_ID)
      .then((n) => { if (mounted.current) setNotes(n); })
      .catch(() => { if (mounted.current) setNotes(null); });
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const nextActionTitle = (today ?? undefined)?.enrollments
    .filter((e) => e.state === 'active')
    .flatMap((e) => e.actions)
    .find((a) => !a.card?.completed)?.card?.title;
  const pendingProposalCount = proposals?.length ?? null;

  const onDeleteNote = async (note: MemoryNote) => {
    const ok = await confirm({
      title: t('guideMemoryDeleteTitle'),
      body: t('guideMemoryDeleteBody'),
      confirmLabel: t('guideMemoryDelete'),
      danger: true,
    });
    if (!ok) return;
    setNoteBusy(note.id);
    setNoteError(false);
    try {
      await deleteNote(KICKBOT_ROSTER_ID, note.id);
      setNotes((prev) => prev?.filter((n) => n.id !== note.id) ?? prev);
    } catch {
      setNoteError(true);
    } finally {
      setNoteBusy(null);
    }
  };

  const onRename = async () => {
    const label = renameDraft.trim();
    if (!label) return;
    setRenameBusy(true);
    setRenameError(false);
    try {
      const entry = await updateRosterEntry(KICKBOT_ROSTER_ID, { label });
      setGuideName(entry.label ?? entry.persona);
      setRenaming(false);
    } catch {
      setRenameError(true);
    } finally {
      setRenameBusy(false);
    }
  };

  return (
    <div className="page" data-walkthrough="kicktodo-guide.page">
      {/* The named agent, named — the §4.2 serif human moment. Falls back to
          the generic title until (or unless) the roster read resolves. */}
      {guideName ? (
        <header className="page-header">
          <div>
            <p className="page-header__eyebrow">{t('guideTitle')}</p>
            <h1 className="kt-guide-name">{guideName}</h1>
            <p className="page-header__lede">{t('guideLede')}</p>
            {/* §5.8 — rename WITHOUT losing continuity: a label-only roster
                patch; memories and history stay attached to the same agent. */}
            {!renaming && (
              <Button variant="quiet" size="sm"
                onClick={() => { setRenameDraft(guideName); setRenaming(true); }}>
                {t('guideRename')}
              </Button>
            )}
            {renaming && (
              <form className="kt-inline-form" onSubmit={(e) => { e.preventDefault(); void onRename(); }}>
                <TextField label={t('guideRenameLabel')} value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)} required maxLength={60} />
                <p className="muted u-fs-13">{t('guideRenameContinuity')}</p>
                {renameError && <Notice variant="error">{t('guideRenameError')}</Notice>}
                <div className="action-bar">
                  <Button type="submit" variant="accent-solid" size="sm" disabled={renameBusy || !renameDraft.trim()} aria-busy={renameBusy}>
                    {t('guideRenameSave')}
                  </Button>
                  <Button variant="quiet" size="sm" onClick={() => { setRenaming(false); setRenameError(false); }}>
                    {t('common:cancel')}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </header>
      ) : (
        <PageHeader title={t('guideTitle')} lede={t('guideLede')} />
      )}

      <Notice variant="info">{t('guideAiDisclosure')}</Notice>

      {/* The Guide brief separates observed context from conversation. It never
          treats missing reads as an empty day or an empty decision queue. */}
      <section className="surface-card kt-guide-brief" aria-labelledby="guide-brief-title">
        <header className="kt-guide-brief__header">
          <div>
            <p className="kt-eyebrow">{t('guideBriefEyebrow')}</p>
            <h2 id="guide-brief-title">{t('guideBriefTitle')}</h2>
            <p>{t('guideBriefBody')}</p>
          </div>
          <span className="chip chip--muted">{t('guideBriefTrust')}</span>
        </header>

        <div className="kt-guide-brief__grid">
          <article className="kt-guide-context-card">
            <div className="kt-guide-context-card__label">
              <CalendarIcon />
              <span>{t('guideTodayContext')}</span>
            </div>
            {today === undefined ? (
              <div className="kt-guide-context-loading" aria-busy="true">
                <span className="sr-only">{t('guideContextLoading')}</span>
                <span className="skeleton" />
                <span className="skeleton" />
              </div>
            ) : today === null ? (
              <div className="kt-guide-context-state" role="alert">
                <h3>{t('guideContextUnavailable')}</h3>
                <Button variant="quiet" size="sm" onClick={reload}>{t('common:retry')}</Button>
              </div>
            ) : nextActionTitle ? (
              <div className="kt-guide-context-state">
                <h3>{nextActionTitle}</h3>
                <p>{t('guideTodayActionBody')}</p>
                <Link className="btn-ghost btn-sm" to="/today">{t('guideOpenToday')}</Link>
              </div>
            ) : (
              <div className="kt-guide-context-state">
                <h3>{t('guideTodayEmptyTitle')}</h3>
                <p>{t('guideNoContext')}</p>
              </div>
            )}
          </article>

          <article className="kt-guide-context-card kt-guide-decisions">
            <div className="kt-guide-context-card__label">
              <ShieldIcon />
              <span>{t('guideDecisionsHeading')}</span>
            </div>
            {proposals === undefined ? (
              <div className="kt-guide-context-loading" aria-busy="true">
                <span className="sr-only">{t('guideDecisionsLoading')}</span>
                <span className="skeleton" />
                <span className="skeleton" />
              </div>
            ) : proposals === null ? (
              <div className="kt-guide-context-state" role="status">
                <h3>{t('guideWaitingUnknown')}</h3>
                <Button variant="quiet" size="sm" onClick={reload}>{t('common:retry')}</Button>
              </div>
            ) : proposals.length === 0 ? (
              <div className="kt-guide-context-state">
                <h3>{t('guideDecisionsNoneTitle')}</h3>
                <p>{t('guideDecisionsNoneBody')}</p>
              </div>
            ) : (
              <div className="kt-guide-proposal-list">
                <p className="kt-guide-decision-count">{t('guideWaitingOnYou', { count: proposals.length })}</p>
                {proposals.map((proposal) => (
                  <div className="kt-guide-proposal" key={proposal.id}>
                    <p className="kt-guide-proposal__note">{proposal.note}</p>
                    <p className="kt-guide-proposal__meta">
                      {t('guideDecisionMeta', { date: formatDate(proposal.createdAt, { dateStyle: 'medium' }) })}
                    </p>
                    <div className="kt-guide-proposal__footer">
                      <span>{t('guideDecisionGuardrail')}</span>
                      <Link className="btn-accent-solid btn-sm" to="/circles">{t('guideWaitingReview')}</Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </article>
        </div>
      </section>

      {/* The coaching conversation IN PLACE: the ONE chat embedded here, scoped
          to KickBot (never a second chat system). The full-chat deep-link is the
          durable-thread escape hatch; this embed is task-scoped (ADR 0073). */}
      <section className="surface-card studio-author-panel" aria-label={t('guideChatHeading')}>
        <div className="action-bar">
          <h2 className="kt-eyebrow">{t('guideChatHeading')}</h2>
          <Link className="btn-ghost btn-sm" to={KICKBOT_CHAT}>{t('guideOpenFullChat')}</Link>
        </div>
        <EmbeddedChatPanel
          agentId={KICKBOT_ROSTER_ID}
          byokFallback={anonymous ? (
            <StateCard
              icon={<SparklesIcon aria-hidden />}
              title={t('guideSignInTitle')}
              body={t('guideSignInBody')}
              action={<SignInButton />}
            />
          ) : (
            <StateCard
              icon={<SparklesIcon aria-hidden />}
              title={t('guideActivateTitle')}
              body={t('guideActivateBody')}
              action={<Link className="btn-accent-solid" to={KICKBOT_CHAT}>{t('guideActivateCta')}</Link>}
            />
          )}
          renderEmptyState={(onPick) => (
            <GuideWelcome
              onPick={onPick}
              pendingProposals={pendingProposalCount}
              {...(nextActionTitle ? { nextActionTitle } : {})}
            />
          )}
        />
      </section>

      {/* §5.8 — memories with review/delete, IN surface. Renders only when the
          curated-notes lane is readable by this caller; the entry text is shown
          verbatim (it's the participant's own record), deletion is confirmed and
          per-row busy. An unavailable lane hides the section — the /agents
          shortcut below stays the honest management path. */}
      {notes !== null && (
        <section className="surface-card" aria-label={t('guideMemoriesHeading')}>
          <h2 className="kt-eyebrow">{t('guideMemoriesHeading')}</h2>
          {noteError && <Notice variant="error">{t('guideMemoryDeleteError')}</Notice>}
          {notes.length === 0
            ? <p className="muted u-m-0">{t('guideMemoriesEmpty')}</p>
            : (
              <ul role="list" className="list-plain">
                {notes.map((n) => (
                  <li key={n.id} className="list-row">
                    <div>
                      <p className="u-m-0">{n.content}</p>
                      <p className="muted u-fs-13 u-m-0">{formatDate(n.createdAt, { dateStyle: 'medium' })}</p>
                    </div>
                    <Button variant="quiet" size="sm" className="u-text-danger"
                      disabled={noteBusy === n.id} aria-busy={noteBusy === n.id}
                      onClick={() => void onDeleteNote(n)}>
                      {t('guideMemoryDelete')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
        </section>
      )}

      {/* Subordinate shortcuts — the relationship's other surfaces, below the
          conversation (the deep-links the landing page used to lead with). */}
      <section className="surface-card">
        <ul role="list" className="list-plain">
          <li className="list-row">
            <span>{t('guideShortcutProgress')}</span>
            <Link className="btn-ghost btn-sm" to="/today">{t('navTodayLabel')}</Link>
          </li>
          <li className="list-row">
            <span>{t('guideShortcutRemember')}</span>
            <Link className="btn-ghost btn-sm" to="/agents">{t('guideManage')}</Link>
          </li>
        </ul>
        <p className="muted u-fs-13">{t('guideManageHint')}</p>
      </section>
    </div>
  );
}

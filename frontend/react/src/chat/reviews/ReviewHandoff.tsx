/**
 * ADR 0854 D1 — "Ask someone else to decide" on one pending review, and the
 * note that came with a handoff. A handoff moves the work and adds context; it
 * never grants authority (the server refuses a target who could not already
 * decide, and the decide routes re-check everything). Always shown (no toggle
 * since 2026-10-07).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { loadOrgMembers } from '../../orgs/orgMembers.js';
import type { OrgMember } from '../../client/accessClient.js';
import { HandoffNoteCard } from '../../runs/HandoffNoteCard.js';
import { readHandoffNote } from '../../runs/handoffNote.js';
import { getReviewHandoff, handOffReview, type ReviewHandoff as Handoff } from './reviewHandoffClient.js';

const lines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

export function ReviewHandoff({ reviewId, canHandOff }: { reviewId: string; canHandOff: boolean }): JSX.Element | null {
  const { t } = useTranslation('chat');
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [membersFailed, setMembersFailed] = useState(false);
  const [to, setTo] = useState('');
  const [intent, setIntent] = useState('');
  const [questions, setQuestions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getReviewHandoff(reviewId).then((h) => { if (live) setHandoff(h); }).catch(() => undefined);
    return () => { live = false; };
  }, [reviewId]);
  useEffect(() => {
    if (!open) { setMembersFailed(false); return; }
    if (members || membersFailed) return;
    loadOrgMembers().then(setMembers).catch(() => setMembersFailed(true));
  }, [open, members, membersFailed]);

  const note = handoff ? readHandoffNote({ 'openwop-handoff': handoff.note }) : null;
  const nameOf = (subject: string): string => members?.find((m) => (m.subject ?? m.memberId) === subject)?.displayName ?? subject;

  const send = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const h = await handOffReview(reviewId, to, { intent: intent.trim(), ...(lines(questions).length ? { openQuestions: lines(questions) } : {}) });
      setHandoff(h); setOpen(false); setIntent(''); setQuestions(''); setTo('');
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(status === 422 ? t('reviewHandoffNotApprover') : t('reviewHandoffFailed'));
    } finally { setBusy(false); }
  };

  return (
    <div className="u-mt-2">
      {note ? <HandoffNoteCard note={note} title={t('reviewHandoffNoteTitle')} headingLevel={3} variant="inline" /> : null}
      {canHandOff && !open ? (
        <Button variant="quiet" size="sm" onClick={() => setOpen(true)}>{t('reviewHandoffAsk')}</Button>
      ) : null}
      {canHandOff && open ? (
        <form className="u-mt-1" onSubmit={(e) => { e.preventDefault(); if (to && intent.trim() && !busy) void send(); }}>
          {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
          {membersFailed ? <Notice variant="error" announce={t('reviewHandoffPeopleFailed')}>{t('reviewHandoffPeopleFailed')}</Notice> : null}
          <label className="field">
            <span className="field-label">{t('reviewHandoffTo')}</span>
            <select value={to} onChange={(e) => setTo(e.target.value)} disabled={busy || members === null}>
              <option value="">{t('reviewHandoffPick')}</option>
              {(members ?? []).map((m) => <option key={m.memberId} value={m.subject ?? m.memberId}>{nameOf(m.subject ?? m.memberId)}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{t('reviewHandoffIntent')}</span>
            <textarea rows={2} maxLength={500} value={intent} onChange={(e) => setIntent(e.target.value)} disabled={busy} />
          </label>
          <label className="field">
            <span className="field-label">{t('reviewHandoffQuestions')}</span>
            <textarea rows={2} value={questions} onChange={(e) => setQuestions(e.target.value)} disabled={busy} />
          </label>
          <p className="muted u-fs-12">{t('reviewHandoffHint')}</p>
          <div className="action-bar">
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)} disabled={busy}>{t('common:cancel')}</Button>
            <Button type="submit" variant="accent-solid" size="sm" disabled={!to || !intent.trim() || busy}>{t('reviewHandoffSend')}</Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

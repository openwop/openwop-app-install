/**
 * CommentsPanel (ADR 0021) — a reusable threaded-comment view for ONE resource.
 * Self-loads the thread for (orgId, resourceType, resourceId); supports add / reply
 * / resolve-reopen / edit-own / delete. Exported so it can later be embedded in the
 * CMS page editor + KB collection view; for v1 it backs the standalone CommentsPage.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../../ui/confirm.js';
import { useFormat } from '../../i18n/useFormat.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { MessageSquareIcon, SendIcon, CheckIcon, RotateCwIcon, TrashIcon } from '../../ui/icons/index.js';
import {
  listThread, postComment, updateComment, deleteComment,
  type Comment, type ResourceType,
} from './commentsClient.js';

const statusChip = (s: Comment['status']): string => (s === 'resolved' ? 'chip chip--success' : 'chip chip--muted');
// Comment status → catalog key (the persisted enum value never reaches the UI).
const STATUS_KEY: Record<Comment['status'], string> = { open: 'statusOpen', resolved: 'statusResolved' };

export function CommentsPanel({ orgId, resourceType, resourceId }: { orgId: string; resourceType: ResourceType; resourceId: string }): JSX.Element {
  const { t } = useTranslation('comments');
  const f = useFormat();
  // Locale-aware timestamp; falls back to the raw ISO if it can't be parsed.
  const when = (iso: string): string => { try { return f.dateTime(iso); } catch { return iso; } };
  // Agent-authored comments carry an opaque `agent:<runId>` author — render a friendly
  // label (the raw run id isn't meaningful to a human). Human ids have no display-name
  // source on this surface yet (tied to the ADR's @mentions/identity open question).
  const authorLabel = (id: string): string => (id.startsWith('agent:') ? t('authorAgent') : id);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [replyDraft, setReplyDraft] = useState('');

  const load = useCallback(() => {
    setError(null); setComments(null);
    void listThread(orgId, resourceType, resourceId)
      .then(setComments)
      .catch((e) => { setComments([]); setError(e instanceof Error ? e.message : t('loadFailed')); });
  }, [orgId, resourceType, resourceId, t]);
  useEffect(() => { if (orgId && resourceId) load(); }, [load, orgId, resourceId]);

  const add = useCallback(async (body: string, parentId?: string) => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await postComment(orgId, { resourceType, resourceId, body: body.trim(), ...(parentId ? { parentId } : {}) });
      setDraft(''); setReplyTo(''); setReplyDraft(''); load();
    } catch (e) { toast.error(e instanceof Error ? e.message : t('postFailed')); }
    finally { setBusy(false); }
  }, [orgId, resourceType, resourceId, load, t]);

  const setStatus = useCallback(async (c: Comment, status: Comment['status']) => {
    setBusy(true);
    try { await updateComment(orgId, c.commentId, { status }); load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('updateFailed')); }
    finally { setBusy(false); }
  }, [orgId, load, t]);

  const remove = useCallback(async (c: Comment) => {
    // The cascade removes the replies the actor is allowed to remove; a non-admin
    // deleting a root others replied under is refused server-side (409 → toast).
    if (!(await confirm({ title: t('deleteConfirm'), danger: true, confirmLabel: t('common:delete') }))) return;
    setBusy(true);
    try { await deleteComment(orgId, c.commentId); load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); }
    finally { setBusy(false); }
  }, [orgId, load, t]);

  if (!comments) return <Skeleton />;

  const roots = comments.filter((c) => !c.parentId);
  const repliesOf = (id: string): Comment[] => comments.filter((c) => c.parentId === id);

  const row = (c: Comment, isReply: boolean): JSX.Element => (
    <div key={c.commentId} className={`surface-inset u-gap-1 u-flex u-flex-col${isReply ? ' u-ml-2' : ''}`}>
      <div className="u-flex u-gap-2 u-items-center u-wrap">
        <code className="u-flex-1">{authorLabel(c.authorId)}</code>
        <span className={statusChip(c.status)}>{t(STATUS_KEY[c.status])}</span>
        <span className="u-label-sm">{when(c.createdAt)}</span>
      </div>
      <div>{c.body}</div>
      <div className="action-bar">
        {!isReply ? <button type="button" className="btn-ghost" onClick={() => { setReplyTo(replyTo === c.commentId ? '' : c.commentId); setReplyDraft(''); }}><SendIcon /> {t('reply')}</button> : null}
        {c.status === 'open'
          ? <button type="button" className="btn-ghost" disabled={busy} onClick={() => void setStatus(c, 'resolved')}><CheckIcon /> {t('resolve')}</button>
          : <button type="button" className="btn-ghost" disabled={busy} onClick={() => void setStatus(c, 'open')}><RotateCwIcon /> {t('reopen')}</button>}
        <button type="button" className="btn-ghost" disabled={busy} title={t('deleteComment')} aria-label={t('deleteComment')} onClick={() => void remove(c)}><TrashIcon /></button>
      </div>
      {replyTo === c.commentId ? (
        <div className="u-flex u-gap-1 u-items-start">
          <textarea className="u-flex-1" rows={2} value={replyDraft} onChange={(e) => setReplyDraft(e.target.value)} placeholder={t('replyPlaceholder')} aria-label={t('replyAria')} />
          <button type="button" className="btn-primary" disabled={busy || !replyDraft.trim()} onClick={() => void add(replyDraft, c.commentId)}>{t('reply')}</button>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="u-gap-2 u-flex u-flex-col">
      {error ? <Notice variant="error">{error}</Notice> : null}
      <div className="surface-card u-p-4 surface-form">
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('addCommentLabel')}</span>
          <textarea rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('newCommentPlaceholder')} aria-label={t('newCommentAria')} />
        </label>
        <button type="button" className="btn-primary" disabled={busy || !draft.trim()} onClick={() => void add(draft)}><MessageSquareIcon /> {t('commentButton')}</button>
      </div>

      {roots.length === 0 ? (
        <StateCard icon={<MessageSquareIcon />} title={t('noCommentsTitle')} body={t('noCommentsBody')} />
      ) : (
        <div className="surface-card u-gap-2">
          {roots.map((r) => (
            <div key={r.commentId} className="u-gap-1 u-flex u-flex-col">
              {row(r, false)}
              {repliesOf(r.commentId).map((rep) => row(rep, true))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * CommentsPanel (ADR 0021) — a reusable threaded-comment view for ONE resource.
 * Self-loads the thread for (orgId, resourceType, resourceId); supports add / reply
 * / resolve-reopen / edit-own / delete. Exported so it can later be embedded in the
 * CMS page editor + KB collection view; for v1 it backs the standalone CommentsPage.
 */
import { useCallback, useEffect, useState } from 'react';
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
const when = (iso: string): string => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };
// Agent-authored comments carry an opaque `agent:<runId>` author — render a friendly
// label (the raw run id isn't meaningful to a human). Human ids have no display-name
// source on this surface yet (tied to the ADR's @mentions/identity open question).
const authorLabel = (id: string): string => (id.startsWith('agent:') ? 'Agent' : id);

export function CommentsPanel({ orgId, resourceType, resourceId }: { orgId: string; resourceType: ResourceType; resourceId: string }): JSX.Element {
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
      .catch((e) => { setComments([]); setError(e instanceof Error ? e.message : 'Failed to load comments.'); });
  }, [orgId, resourceType, resourceId]);
  useEffect(() => { if (orgId && resourceId) load(); }, [load, orgId, resourceId]);

  const add = useCallback(async (body: string, parentId?: string) => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await postComment(orgId, { resourceType, resourceId, body: body.trim(), ...(parentId ? { parentId } : {}) });
      setDraft(''); setReplyTo(''); setReplyDraft(''); load();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Post failed.'); }
    finally { setBusy(false); }
  }, [orgId, resourceType, resourceId, load]);

  const setStatus = useCallback(async (c: Comment, status: Comment['status']) => {
    setBusy(true);
    try { await updateComment(orgId, c.commentId, { status }); load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed.'); }
    finally { setBusy(false); }
  }, [orgId, load]);

  const remove = useCallback(async (c: Comment) => {
    // The cascade removes the replies the actor is allowed to remove; a non-admin
    // deleting a root others replied under is refused server-side (409 → toast).
    if (!window.confirm('Delete this comment? Its replies are removed too (an org admin is required if other people have replied). This can’t be undone.')) return;
    setBusy(true);
    try { await deleteComment(orgId, c.commentId); load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed.'); }
    finally { setBusy(false); }
  }, [orgId, load]);

  if (!comments) return <Skeleton />;

  const roots = comments.filter((c) => !c.parentId);
  const repliesOf = (id: string): Comment[] => comments.filter((c) => c.parentId === id);

  const row = (c: Comment, isReply: boolean): JSX.Element => (
    <div key={c.commentId} className={`surface-inset u-gap-1 u-flex u-flex-col${isReply ? ' u-ml-2' : ''}`}>
      <div className="u-flex u-gap-2 u-items-center u-wrap">
        <code className="u-flex-1">{authorLabel(c.authorId)}</code>
        <span className={statusChip(c.status)}>{c.status}</span>
        <span className="u-label-sm">{when(c.createdAt)}</span>
      </div>
      <div>{c.body}</div>
      <div className="action-bar">
        {!isReply ? <button type="button" className="btn-ghost" onClick={() => { setReplyTo(replyTo === c.commentId ? '' : c.commentId); setReplyDraft(''); }}><SendIcon /> Reply</button> : null}
        {c.status === 'open'
          ? <button type="button" className="btn-ghost" disabled={busy} onClick={() => void setStatus(c, 'resolved')}><CheckIcon /> Resolve</button>
          : <button type="button" className="btn-ghost" disabled={busy} onClick={() => void setStatus(c, 'open')}><RotateCwIcon /> Reopen</button>}
        <button type="button" className="btn-ghost" disabled={busy} title="Delete comment" aria-label="Delete comment" onClick={() => void remove(c)}><TrashIcon /></button>
      </div>
      {replyTo === c.commentId ? (
        <div className="u-flex u-gap-1 u-items-start">
          <textarea className="u-flex-1" rows={2} value={replyDraft} onChange={(e) => setReplyDraft(e.target.value)} placeholder="Write a reply…" aria-label="Reply" />
          <button type="button" className="btn-primary" disabled={busy || !replyDraft.trim()} onClick={() => void add(replyDraft, c.commentId)}>Reply</button>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="u-gap-2 u-flex u-flex-col">
      {error ? <Notice variant="error">{error}</Notice> : null}
      <div className="surface-card u-p-4 surface-form">
        <label className="u-grid u-gap-1"><span className="u-label-sm">Add a comment</span>
          <textarea rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Leave a note on this resource…" aria-label="New comment" />
        </label>
        <button type="button" className="btn-primary" disabled={busy || !draft.trim()} onClick={() => void add(draft)}><MessageSquareIcon /> Comment</button>
      </div>

      {roots.length === 0 ? (
        <StateCard icon={<MessageSquareIcon />} title="No comments yet" body="Be the first to leave a note on this resource." />
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

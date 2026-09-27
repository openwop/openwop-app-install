/**
 * CommentsPanel (ADR 0021 / ADR 0659 D2 + D7) — a reusable threaded-comment view
 * for ONE resource. Self-loads the thread for (orgId, resourceType, resourceId);
 * supports add / reply / resolve-reopen / delete. Mounted at four sites: the
 * `/comments` hub, the inline chat-message affordance, the document toolbar's
 * whole-document thread, and a document's inline range-anchored thread. All four
 * pass the same three props, so every state below lands on all four.
 *
 * ── FAILED IS NOT EMPTY (CMNT-UX-2 / CMNT-7) ────────────────────────────────
 *
 * `load`'s catch used to do `setComments([]); setError(…)`, which rendered the
 * error Notice AND the "No comments yet — Be the first to leave a note" card on
 * the same screen (one honest signal, one false claim), with the composer still
 * live — so a reader was told nobody had commented and could post a duplicate
 * into a thread they could not see. On all FOUR mount sites. The class was fixed
 * one level up in this same feature (`CommentsPage`'s `resourcesFailed`) and the
 * panel was STUBBED OUT of both of that fix's test files, which is exactly why
 * its copy of the shape survived.
 *
 * The failed read is now a distinct sentinel: `comments` stays `null`, `failed`
 * goes true, the empty StateCard is suppressed, the failure card ANNOUNCES and
 * offers Retry, and the composer is disabled with a named reason.
 *
 * ── A GONE TARGET IS NOT AN EMPTY THREAD (CMNT-UX-19, Blocker — ADR 0659 D2) ─
 *
 * The same false-empty on a DIFFERENT premise, and it survived the fix above
 * because the premise was a SUCCESSFUL read. The GET never resolved the target,
 * so a deleted page — or a subject-bound knowledge collection the caller is not
 * bound to — answered `200 {comments:[]}` and this panel rendered "Be the first
 * to leave a note on this resource" with a LIVE composer, over a resource that
 * does not exist or that the reader may not see. The post then came back as raw
 * English server prose.
 *
 * ADR 0659 D1 makes that read a UNIFORM `404 not_found` — deliberately the same
 * answer for "deleted" and "not visible to you", because distinguishing them is
 * an existence oracle. So this panel must NOT distinguish them either: `gone`
 * renders ONE honest state and NO composer. 403 is folded into the same state in
 * case the final contract differs; nothing downstream may branch on which.
 *
 * ── A WRITE MUST NOT DESTROY THE READER'S PLACE (CMNT-UX-3 / CMNT-UX-16) ─────
 *
 * CORRECTED — the docblock that used to sit here CERTIFIED a fix that had only
 * half landed, which is how `CMNT-UX-16` went unseen for a release. What DID
 * land: refreshes hold the previous list (`refreshing`) instead of passing
 * through `null`, outcomes are announced, `busy` is PER-ROW, and the first load
 * shows the LABELLED `SkeletonRows` (`role="status"`) rather than the bare
 * `aria-hidden` `Skeleton`.
 *
 * What did NOT land is the row's own headline. `ui/Button.tsx:75` emits a real
 * HTML `disabled`, and the browser blurs a focused control the instant it is
 * disabled — so `posting` / `busyId` / `!draft.trim()` each dropped the keyboard
 * user to `<body>` mid-write, and after a successful post the Comment button
 * STAYED disabled (the draft had just been cleared). Worst instance: **Retry
 * unmounted itself** — it called `load()` with no `keepList`, which nulled
 * `comments` and returned `SkeletonRows` for the whole panel, contradicting
 * `DESIGN.md:386-388` ("a user-initiated retry keeps focus on the button that
 * triggered it") verbatim.
 *
 * The cure is BUSY-WITHOUT-DISABLING (the ADR 0657 `CONS-UX-29` shape): a
 * control that is unavailable carries `aria-disabled` + `.is-disabled` (dimmed,
 * `not-allowed`, still focusable) and its handler REFUSES the activation, rather
 * than a native `disabled` that takes focus away to say so. Retry additionally
 * reloads with `keepList`, so its own node stays mounted and busy while the read
 * runs. The one native `disabled` left is the composer TEXTAREA, whose
 * unavailability is a property of the screen (the thread failed, or the caller
 * is read-only) and never toggles under a user's hands mid-action.
 *
 * ── PERMISSION IS A FACT OR IT IS NOTHING (CMNT-UX-20 / ADR 0659 D7) ─────────
 *
 * The read needs `workspace:read` and every write `workspace:write`, and this
 * panel used to ask for neither — a read-only member got a live composer,
 * Resolve and Delete, and learned by 403. It now resolves the caller's effective
 * access IN THIS ORG (`useOrgEffectiveAccess`) and gates the write controls on
 * the same scope the route requires. Three states, and the third is the point:
 * an UNRESOLVED or failed access read (`null`) claims nothing and leaves the
 * controls live — the backend stays the authority and now refuses in the user's
 * own language (CMNT-UX-18) — because "we could not check" is not "you lack
 * permission", which is the §4.6 false-read shape this feature already fixed
 * once.
 *
 * ── ONE POLITE SLOT (CMNT-UX-22) ────────────────────────────────────────────
 *
 * `announce()` has a single polite slot, so two announcements in one paint mean
 * the first is silently lost. `namesFailed` and `failed` come from two
 * INDEPENDENT reads and could coincide; the directory caveat is now suppressed
 * while the thread itself is unreadable (it is moot then — there are no authors
 * on screen to mislabel), which makes the exclusion structural rather than a
 * matter of JSX order. Pinned by `ui/__tests__/noticeSweepTranche.test.tsx`.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../../ui/confirm.js';
import { useFormat } from '../../i18n/useFormat.js';
import { announce } from '../../ui/announce.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { MessageSquareIcon, SendIcon, CheckIcon, RotateCwIcon, TrashIcon, AlertIcon } from '../../ui/icons/index.js';
import { loadOrgMembers } from '../../orgs/orgMembers.js';
import { useOrgEffectiveAccess } from '../../client/useEffectiveAccess.js';
import { Notice } from '../../ui/Notice.js';
import {
  listThread, postComment, updateComment, deleteComment, CommentsHttpError,
  type Comment, type ResourceType,
} from './commentsClient.js';

/** CMNT-UX-8 — mirrors `MAX.body` in `commentsService.ts`. Over it, the server
 *  SILENTLY truncates (`cleanString(body, 4000)`) and returns 201, so the
 *  author's first sight of the loss is after the refetch, unexplained. */
const BODY_MAX = 4000;

/** CMNT-UX-16 — the busy/unavailable dress for a control that must stay
 *  FOCUSABLE. `.is-disabled` mirrors `button:disabled` in `global.css`; the
 *  handler is what actually refuses, so the control never moves under focus. */
const inertProps = (inert: boolean, busy = false): {
  'aria-disabled'?: true; 'aria-busy'?: true; className?: string;
} => ({
  ...(inert ? { 'aria-disabled': true as const, className: 'is-disabled' } : {}),
  ...(busy ? { 'aria-busy': true as const } : {}),
});

const statusChip = (s: Comment['status']): string => (s === 'resolved' ? 'chip chip--success' : 'chip chip--muted');
// Comment status → catalog key (the persisted enum value never reaches the UI).
const STATUS_KEY: Record<Comment['status'], string> = { open: 'statusOpen', resolved: 'statusResolved' };

/**
 * CMNT-UX-21 — the composer owns its OWN draft.
 *
 * `draft` used to live beside `comments` in the panel, so every keystroke
 * re-rendered the whole thread (and, before the index below, re-ran an O(n²)
 * reply scan with it). Lifting it DOWN costs nothing and bounds a keystroke to
 * this subtree. `onSubmit` resolves `true` only on a real 201, which is also
 * what clears the box — a failed post keeps the author's text.
 */
function Composer({ disabled, reason, posting, onSubmit }: {
  disabled: boolean; reason: string | null; posting: boolean;
  onSubmit: (body: string) => Promise<boolean>;
}): JSX.Element {
  const { t } = useTranslation('comments');
  const [draft, setDraft] = useState('');
  const inert = disabled || posting || draft.trim().length === 0;
  return (
    <div className="surface-card u-p-4 surface-form">
      <label className="u-grid u-gap-1"><span className="u-label-sm">{t('addCommentLabel')}</span>
        <textarea
          rows={2} value={draft} onChange={(e) => setDraft(e.target.value)}
          placeholder={t('newCommentPlaceholder')} aria-label={t('newCommentAria')}
          // CMNT-UX-8 — the server truncates at 4000 and returns 201; without a
          // cap here the loss is invisible until the refetch, unexplained.
          maxLength={BODY_MAX}
          // CMNT-UX-2 / CMNT-UX-20 — a live composer over an unreadable thread
          // invites a duplicate of a comment the reader was never shown, and a
          // live composer for a read-only member invites a refusal. Native
          // `disabled` is correct HERE and only here: this is a property of the
          // screen, not a transient that flips under the user's hands.
          disabled={disabled}
        />
      </label>
      {/* Counter appears only as the cap approaches — a permanent counter on a
          two-row box is noise for the 99% of comments nowhere near it. */}
      {draft.length > BODY_MAX * 0.8 ? (
        <span className="u-label-sm">{t('bodyCounter', { used: draft.length, max: BODY_MAX })}</span>
      ) : null}
      <Button
        variant="primary"
        {...inertProps(inert, posting)}
        onClick={() => {
          // CMNT-UX-16 — refuse the activation instead of removing the control.
          if (inert) return;
          void onSubmit(draft).then((ok) => { if (ok) setDraft(''); });
        }}
      >
        <MessageSquareIcon /> {t('commentButton')}
      </Button>
      {reason ? <span className="u-label-sm">{reason}</span> : null}
    </div>
  );
}

/** CMNT-UX-21 — same reasoning as `Composer`, for the per-row reply box. */
function ReplyBox({ posting, onSubmit }: {
  posting: boolean; onSubmit: (body: string) => Promise<boolean>;
}): JSX.Element {
  const { t } = useTranslation('comments');
  const [draft, setDraft] = useState('');
  const inert = posting || draft.trim().length === 0;
  return (
    <div className="u-flex u-gap-1 u-items-start u-wrap">
      <textarea
        className="u-flex-1" rows={2} value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t('replyPlaceholder')} aria-label={t('replyAria')}
        // CMNT-UX-8 — the SAME cap as the root composer, and not optional.
        // Both boxes feed `add()` → `postComment` → `cleanString(body, 4000)`,
        // which truncates and still returns 201. Capping only the root
        // composer fixed the instance and left the class: a 5,000-char reply
        // was accepted and silently lost 1,000 characters on the refetch.
        maxLength={BODY_MAX}
      />
      <Button
        variant="primary"
        {...inertProps(inert, posting)}
        onClick={() => { if (inert) return; void onSubmit(draft).then((ok) => { if (ok) setDraft(''); }); }}
      >
        {t('reply')}
      </Button>
      {draft.length > BODY_MAX * 0.8 ? (
        <span className="u-label-sm u-w-full">{t('bodyCounter', { used: draft.length, max: BODY_MAX })}</span>
      ) : null}
    </div>
  );
}

export function CommentsPanel({ orgId, resourceType, resourceId }: { orgId: string; resourceType: ResourceType; resourceId: string }): JSX.Element {
  const { t } = useTranslation('comments');
  const f = useFormat();
  // Locale-aware timestamp; falls back to the raw ISO if it can't be parsed.
  const when = (iso: string): string => { try { return f.dateTime(iso); } catch { return iso; } };
  // CMNT-UX-5 — a human thread used to read as a column of opaque subject ids in
  // a monospace face, because `authorLabel` mapped `agent:*` to "Agent" and
  // returned the RAW id for everyone else. `orgs/orgMembers.loadOrgMembers` is a
  // cached, org-keyed `subject → displayName` loader already consumed by
  // `ProjectMembersTab`, crm and sales-commissions, and it shares its IN-FLIGHT
  // promise (`orgs/__tests__/orgMembersDedupe.test.ts`), so N panels mounting in
  // one tick cost ONE `GET /orgs/:id/members` against the per-IP budget.
  //
  // `OrgMember.subject` IS the value the backend stamps as `authorId`
  // (`createMember({subject: user.userId})` ↔ `createComment({authorId: user.userId})`),
  // so this is a real join, not a guess at an id space.
  const [names, setNames] = useState<Map<string, string> | null>(null);
  const [namesFailed, setNamesFailed] = useState(false);
  useEffect(() => {
    if (!orgId) return;
    let live = true;
    loadOrgMembers(orgId)
      .then((ms) => { if (!live) return; setNames(new Map(ms.filter((m) => m.subject).map((m) => [m.subject!, m.displayName]))); setNamesFailed(false); })
      // The `ProjectMembersTab` posture: SAY that names may be missing rather
      // than silently showing ids as though they were the person's name.
      .catch(() => { if (live) { setNames(null); setNamesFailed(true); } });
    return () => { live = false; };
  }, [orgId]);
  // Agent-authored comments carry an opaque `agent:<runId>` author — render a friendly
  // label (the raw run id isn't meaningful to a human).
  const authorLabel = (id: string): string => (id.startsWith('agent:') ? t('authorAgent') : (names?.get(id) ?? id));

  // CMNT-UX-20 — the caller's write access IN THIS ORG. `null` = not answered;
  // see the docblock for why that is deliberately NOT treated as a refusal.
  const access = useOrgEffectiveAccess(orgId);
  const readOnly = access !== null && !access.scopes.includes('workspace:write');

  const [comments, setComments] = useState<Comment[] | null>(null);
  // CMNT-UX-2 — the read FAILED. Distinct from `comments === null` (not answered
  // yet) and from `comments.length === 0` (a genuinely empty thread), because
  // the empty state makes a FACTUAL CLAIM the failed read cannot support.
  const [failed, setFailed] = useState(false);
  // CMNT-UX-19 — the target did not RESOLVE: deleted, or not visible to this
  // caller. One sentinel for both, because the wire answers one status for both.
  const [gone, setGone] = useState(false);
  // CMNT-UX-3 — a refresh after a write holds the previous list on screen.
  const [refreshing, setRefreshing] = useState(false);
  // CMNT-UX-3 — per-ROW busy. It was panel-global, so resolving one comment
  // disabled Resolve/Reopen/Delete on every other row (while leaving Reply on).
  const [busyId, setBusyId] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [replyTo, setReplyTo] = useState('');
  // CMNT-UX-16 — the re-entry guard lives in a REF, not in `posting`. Reading
  // the state variable would put it in every write callback's dependency list,
  // re-minting the handlers mid-flight; the ref makes "ignore a repeat
  // activation" independent of render.
  const inFlight = useRef(false);

  const load = useCallback((opts?: { keepList?: boolean }) => {
    if (opts?.keepList) setRefreshing(true);
    else { setComments(null); setFailed(false); setGone(false); }
    return listThread(orgId, resourceType, resourceId)
      .then((rows) => { setComments(rows); setFailed(false); setGone(false); })
      // NEVER `setComments([])` here: that is the false-empty. `null` + `failed`
      // keeps "we do not know what is here" distinguishable from "there is
      // nothing here", which is the whole point.
      //
      // CMNT-UX-19 — and a 404 is a THIRD thing: we know exactly what is here,
      // which is nothing we may show. It is not a transport failure (Retry is
      // unlikely to help) and it is certainly not an empty thread. 403 folds in
      // deliberately: the contract answers one status for "deleted" and for "not
      // yours to see", and this branch must never become the oracle that splits
      // them.
      .catch((e: unknown) => {
        setComments(null);
        const unresolved = e instanceof CommentsHttpError && (e.status === 404 || e.status === 403);
        setGone(unresolved);
        setFailed(!unresolved);
      })
      .finally(() => setRefreshing(false));
  }, [orgId, resourceType, resourceId]);
  useEffect(() => { if (orgId && resourceId) void load(); }, [load, orgId, resourceId]);

  /**
   * CMNT-UX-18 — a refusal in the reader's own language, on EVERY lane.
   *
   * The raw `Error.message` is the BACKEND's prose: English, written for an API
   * consumer, with backticks and RFC-2119 keywords in it (`` `body` is required
   * and MUST be a non-empty string. ``). It must never reach a toast, so this
   * maps (status, code) → a catalog key and the fallback is a localized key too,
   * never `e.message`.
   */
  const refusalCopy = useCallback((e: unknown, fallbackKey: string, byStatus: Record<number, string> = {}): string => {
    if (e instanceof CommentsHttpError) {
      const own = byStatus[e.status];
      if (own) return t(own);
      // Uniform with the read: 404 says nothing about which of the two it was.
      if (e.status === 404) return t('writeGone');
      if (e.status === 403) return t(e.code === 'forbidden_scope' ? 'writeForbiddenScope' : 'writeForbidden');
      if (e.status === 400) return t('writeInvalid');
    }
    return t(fallbackKey);
  }, [t]);

  /** A write that came back 404 means the target stopped resolving under us —
   *  re-read so the panel shows the gone state rather than leaving a composer
   *  over a resource the server has just refused. */
  const reresolveIfGone = useCallback((e: unknown) => {
    if (e instanceof CommentsHttpError && (e.status === 404 || e.status === 403)) void load({ keepList: true });
  }, [load]);

  const add = useCallback(async (body: string, parentId?: string): Promise<boolean> => {
    if (!body.trim()) return false;
    if (inFlight.current) return false; // CMNT-UX-16 — ignore a repeat activation
    inFlight.current = true;
    setPosting(true);
    try {
      await postComment(orgId, { resourceType, resourceId, body: body.trim(), ...(parentId ? { parentId } : {}) });
      setReplyTo('');
      // CMNT-UX-3 — announce the outcome. Nothing in the success path said
      // anything at all before; the only signal was a full-panel flash.
      announce(parentId ? t('replyPosted') : t('commentPosted'));
      await load({ keepList: true });
      return true;
    } catch (e) {
      toast.error(refusalCopy(e, 'postFailed'));
      reresolveIfGone(e);
      return false;
    } finally { inFlight.current = false; setPosting(false); }
  }, [orgId, resourceType, resourceId, load, t, refusalCopy, reresolveIfGone]);

  const setStatus = useCallback(async (c: Comment, status: Comment['status']) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusyId(c.commentId);
    try {
      await updateComment(orgId, c.commentId, { status });
      announce(status === 'resolved' ? t('markedResolved') : t('markedReopened'));
      await load({ keepList: true });
    } catch (e) { toast.error(refusalCopy(e, 'updateFailed')); reresolveIfGone(e); }
    finally { inFlight.current = false; setBusyId(null); }
  }, [orgId, load, t, refusalCopy, reresolveIfGone]);

  const remove = useCallback(async (c: Comment) => {
    // The cascade removes the replies the actor is allowed to remove; a non-admin
    // deleting a root others replied under is refused server-side (409 → toast).
    if (inFlight.current) return;
    if (!(await confirm({ title: t('deleteConfirm'), danger: true, confirmLabel: t('common:delete') }))) return;
    inFlight.current = true;
    setBusyId(c.commentId);
    try {
      await deleteComment(orgId, c.commentId);
      announce(t('commentDeleted'));
      await load({ keepList: true });
    } catch (e) {
      // CMNT-UX-9 — the two refusals are DIFFERENT and the user's next move
      // differs with them: 403 means it is not yours to delete, 409 means other
      // people have replied and you should RESOLVE it instead. Both used to
      // arrive as the raw server sentence (or a bare status code) in a toast.
      toast.error(refusalCopy(e, 'deleteFailed', { 403: 'deleteForbidden', 409: 'deleteHasForeignReplies' }));
      reresolveIfGone(e);
    }
    finally { inFlight.current = false; setBusyId(null); }
  }, [orgId, load, t, refusalCopy, reresolveIfGone]);

  // CMNT-UX-21 — ONE pass over the thread builds `parentId → replies`. `repliesOf`
  // used to re-filter the WHOLE array once per root (O(n²)) and, because `draft`
  // lived in this component, re-ran that on every keystroke. The drafts now live
  // in `Composer` / `ReplyBox`; the index makes the render itself linear.
  // (Deliberately NOT virtualization or pagination — a bounded first page is a
  // backend change and is tracked separately.)
  const roots = useMemo(() => (comments ?? []).filter((c) => !c.parentId), [comments]);
  const replyIndex = useMemo(() => {
    const m = new Map<string, Comment[]>();
    for (const c of comments ?? []) {
      if (!c.parentId) continue;
      const bucket = m.get(c.parentId);
      if (bucket) bucket.push(c); else m.set(c.parentId, [c]);
    }
    return m;
  }, [comments]);

  // CMNT-UX-16 — Retry reloads with `keepList`, so THIS button keeps its node
  // (and the user's focus) while the read runs, per DESIGN.md:386-388. Without
  // it, `load()` nulled `comments` and the whole panel — Retry included — was
  // replaced by a skeleton the instant it was pressed.
  const retry = useCallback(() => { if (refreshing) return; void load({ keepList: true }); }, [load, refreshing]);

  // FIRST load only — a refresh after a write holds the list (CMNT-UX-3).
  if (comments === null && !failed && !gone) {
    return <SkeletonRows rows={2} columns={['40%', '100%']} />;
  }

  // CMNT-UX-19 (Blocker) — the target does not resolve. ONE state, NO composer:
  // a thread cannot invite a note onto a target that is gone, and the copy must
  // not say WHICH of "deleted" / "not yours to see" it was.
  if (gone) {
    return (
      <div className="u-gap-2 u-flex u-flex-col">
        <StateCard
          icon={<AlertIcon />} announce
          title={t('resourceGoneTitle')} body={t('linkedResourceMissing')}
          action={<Button variant="quiet" size="sm" {...inertProps(false, refreshing)} onClick={retry}>{t('common:retry')}</Button>}
        />
      </div>
    );
  }

  const row = (c: Comment, isReply: boolean): JSX.Element => {
    const rowBusy = busyId === c.commentId;
    return (
      <div key={c.commentId} className={`surface-inset u-gap-1 u-flex u-flex-col${isReply ? ' u-ml-2' : ''}`}>
        <div className="u-flex u-gap-2 u-items-center u-wrap">
          <code className="u-flex-1 u-min-w-0">{authorLabel(c.authorId)}</code>
          <span className={statusChip(c.status)}>{t(STATUS_KEY[c.status])}</span>
          <span className="u-label-sm">{when(c.createdAt)}</span>
        </div>
        <div>{c.body}</div>
        {/* CMNT-UX-20 — every verb below is a `workspace:write` route. A member
            the server has told us holds only `workspace:read` is not offered
            them; the reason is stated ONCE, under the composer, rather than as a
            disabled control on every row. */}
        {!readOnly ? (
          <div className="action-bar">
            {!isReply ? (
              <Button variant="quiet" aria-expanded={replyTo === c.commentId}
                onClick={() => setReplyTo(replyTo === c.commentId ? '' : c.commentId)}>
                <SendIcon /> {t('reply')}
              </Button>
            ) : null}
            {c.status === 'open'
              ? <Button variant="quiet" {...inertProps(rowBusy, rowBusy)} onClick={() => { if (rowBusy) return; void setStatus(c, 'resolved'); }}><CheckIcon /> {t('resolve')}</Button>
              : <Button variant="quiet" {...inertProps(rowBusy, rowBusy)} onClick={() => { if (rowBusy) return; void setStatus(c, 'open'); }}><RotateCwIcon /> {t('reopen')}</Button>}
            <Button variant="quiet" {...inertProps(rowBusy, rowBusy)} title={t('deleteComment')} aria-label={t('deleteComment')} onClick={() => { if (rowBusy) return; void remove(c); }}><TrashIcon /></Button>
          </div>
        ) : null}
        {replyTo === c.commentId && !readOnly ? (
          <ReplyBox posting={posting} onSubmit={(body) => add(body, c.commentId)} />
        ) : null}
      </div>
    );
  };

  return (
    <div className="u-gap-2 u-flex u-flex-col">
      <Composer
        disabled={failed || readOnly}
        posting={posting}
        reason={failed ? t('composerBlockedByFailure') : readOnly ? t('composerBlockedByReadOnly') : null}
        onSubmit={(body) => add(body)}
      />

      {/* CMNT-UX-5 — the directory read failed, so the ids below are ids, not
          names. Say so; showing a raw subject id as though it were a person's
          name is the quiet version of this failure.
          CMNT-UX-22 — suppressed while the thread itself is unreadable: there
          are no authors on screen to mislabel then, and `announce()` has ONE
          polite slot, so leaving both wired would silently drop whichever lost
          the race. The exclusion is in the PREDICATE, not in JSX order. */}
      {namesFailed && !failed ? <Notice variant="warning" announce={t('directoryNamesFallback')}>{t('directoryNamesFallback')}</Notice> : null}

      {failed ? (
        // §4.6 — one honest signal, a Retry, and it ANNOUNCES. The old shape had
        // an unannounced Notice carrying the raw transport string, beside a card
        // saying there were no comments.
        <StateCard
          icon={<AlertIcon />} announce
          title={t('common:loadFailedTitle')} body={t('threadFailedBody')}
          action={<Button variant="quiet" size="sm" {...inertProps(false, refreshing)} onClick={retry}>{t('common:retry')}</Button>}
        />
      ) : roots.length === 0 ? (
        <StateCard icon={<MessageSquareIcon />} title={t('noCommentsTitle')} body={t('noCommentsBody')} />
      ) : (
        <div className="surface-card u-gap-2" aria-busy={refreshing || undefined}>
          {roots.map((r) => (
            <div key={r.commentId} className="u-gap-1 u-flex u-flex-col">
              {row(r, false)}
              {(replyIndex.get(r.commentId) ?? []).map((rep) => row(rep, true))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

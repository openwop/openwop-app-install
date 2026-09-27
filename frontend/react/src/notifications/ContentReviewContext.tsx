/**
 * ADR 0593 D4 — the reviewer's context + decide controls for a `content-publish`
 * approval.
 *
 * ONE pair of components, rendered by BOTH deciding surfaces (`ApprovalsInbox`
 * on `/profile` and the dashboard tile, `NeedsYouInbox` on `/inbox`), because
 * part of the defect was that the two surfaces said different things about the
 * same row and offered different affordances.
 *
 * What this closes:
 *  - `CMSAU-1` (Blocker) — the reviewer could not SEE what they were approving.
 *    `orgId`/`pageId`/`pageTitle` rode the row and the deep-linkable route
 *    (`/cms/p/:orgId/:pageId`) existed; no card read either. ADR 0066 Phase 3
 *    prescribed exactly this link ("a content-publish row links to the CMS
 *    page") and it was never built — a seam with no reader, on a flow whose
 *    backend motto is "approve what you saw".
 *  - `CMSAU-4` (Blocker) — machine-draft provenance. The durable `aiDrafted`
 *    stamps (ADR 0592 §3) the EDITOR renders as `chip--ai` were read by no
 *    approval surface; the reviewer got a one-shot English sentence that emptied
 *    itself on the first resubmit. `aiDraftedLocales` is derived from those
 *    stamps at queue AND repin time, so the disclosure cannot decay.
 *  - `CMSAU-5` (Blocker) — rejection was reason-less. Rejecting is now a
 *    two-step in-card action that collects a reason and doubles as the confirm
 *    the destructive verb never had (`CMSAU-17`).
 *  - `CMSAU-14` — `aria-busy` parity with the spend groups (CMPUX-9).
 *  - `CMSAU-18` — the pinned version, so "approve what you saw" is legible
 *    rather than merely enforced.
 */

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { PendingApproval } from '../agents/approvalsClient.js';
import { Button } from '../ui/Button.js';
import { CheckIcon, ExternalLinkIcon, SparklesIcon, XIcon } from '../ui/icons/index.js';

export function ContentReviewContext({ a }: { a: PendingApproval }): JSX.Element | null {
  const { t } = useTranslation('notifications');
  const canLink = Boolean(a.orgId && a.pageId);
  const hasAi = (a.aiDraftedLocales?.length ?? 0) > 0;
  if (!canLink && !hasAi && typeof a.pageVersion !== 'number') return null;
  return (
    <div className="u-flex u-items-center u-gap-2 u-wrap u-fs-12">
      {canLink && (
        // The affordance the whole gate depends on: read it, then decide it.
        <Link
          to={`/cms/p/${encodeURIComponent(a.orgId ?? '')}/${encodeURIComponent(a.pageId ?? '')}`}
          className="u-flex u-items-center u-gap-1"
        >
          <ExternalLinkIcon size={12} />
          {t('approvalsOpenPage', { title: a.pageTitle ?? '' })}
        </Link>
      )}
      {typeof a.pageVersion === 'number' && (
        <span className="muted">{t('approvalsPinnedVersion', { version: a.pageVersion })}</span>
      )}
      {hasAi && (
        // DESIGN.md §5.3's model-provenance token, the SAME marker the editor
        // shows on these overlays — the reviewer and the author see one truth.
        //
        // CORRECTED (review F7.1): the load-bearing sentence — "drafted by a
        // model and not reviewed by a person" — was in `title` ONLY, i.e.
        // invisible to keyboard users, touch users and most screen readers. A
        // Blocker cure whose meaning lives in a tooltip is not a cure. It is now
        // real text in the accessibility tree, kept out of the visual chip so
        // the card still scans.
        <span className="chip chip--ai" title={t('approvalsAiDraftedTitle')}>
          <SparklesIcon size={11} /> {t('approvalsAiDrafted', {
            count: a.aiDraftedLocales?.length ?? 0,
            locales: (a.aiDraftedLocales ?? []).join(', '),
          })}
          <span className="sr-only"> — {t('approvalsAiDraftedTitle')}</span>
        </span>
      )}
    </div>
  );
}

/**
 * Approve / Reject for a content-publish row, with the reason step folded into
 * the reject arm. Deliberately in-card rather than a modal: the reviewer needs
 * the proposal and the page link still on screen while they type why.
 */
/**
 * The approve / reject-with-reason bar. Despite living beside the content-review
 * context, NOTHING here is content-specific: it takes `busy` and two callbacks and
 * speaks only `notifications` strings. It was named for its first consumer, and that
 * name is why the strategy-activation group in the same inbox shipped bare buttons
 * instead — losing the reason step AND the two focus behaviours earned by bugs
 * (F7(4): focus restore when the reason step closes; F7(5): a failed reject keeps the
 * typed text). Renamed to say what it is; `ContentReviewContext` above stays specific
 * because it genuinely is.
 */
export function ApprovalDecideBar({
  busy,
  onApprove,
  onReject,
}: {
  busy: boolean;
  onApprove: () => void;
  /** Returns `false` (or a promise of it) when the reject FAILED, so the reason
   *  step stays open with the typed text intact. */
  onReject: (note?: string) => void | boolean | Promise<void | boolean>;
}): JSX.Element {
  const { t } = useTranslation('notifications');
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  /** F7(4) — where focus returns when the reason step closes (WCAG 2.4.3);
   *  it used to drop to <body>. The Reject button is NOT mounted while the
   *  reason step is open, so the ref is null at close time — the restore has to
   *  wait for the re-render, hence the flag + effect rather than a direct call
   *  (the first cut called `.focus()` inline and silently did nothing). */
  const rejectRef = useRef<HTMLButtonElement | null>(null);
  const [refocus, setRefocus] = useState(false);
  useEffect(() => {
    if (!asking && refocus) { rejectRef.current?.focus(); setRefocus(false); }
  }, [asking, refocus]);

  if (asking) {
    return (
      <div className="u-grid u-gap-2">
        <label className="u-grid u-gap-1 u-fs-12">
          <span className="muted">{t('rejectReasonLabel')}</span>
          <textarea
            className="input"
            rows={2}
            value={note}
            autoFocus
            maxLength={2000}
            placeholder={t('rejectReasonPlaceholder')}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <span className="action-bar">
          {/* F7(5) — this used to unmount the reason step BEFORE the request
              resolved, so a failed reject swapped the UI out from under its own
              error toast and the typed reason vanished. It now closes only when
              the caller reports success. */}
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            aria-busy={busy}
            onClick={() => {
              void Promise.resolve(onReject(note.trim() || undefined)).then((ok) => {
                if (ok !== false) { setAsking(false); setNote(''); setRefocus(true); }
              });
            }}
          >
            <XIcon size={13} /> {t('rejectSendLabel')}
          </Button>
          <Button variant="quiet" size="sm" disabled={busy} onClick={() => { setAsking(false); setNote(''); setRefocus(true); }}>
            {t('rejectCancelLabel')}
          </Button>
        </span>
      </div>
    );
  }

  return (
    <span className="action-bar">
      <Button variant="primary" size="sm" disabled={busy} aria-busy={busy} onClick={onApprove}>
        <CheckIcon size={13} /> {t('approveLabel')}
      </Button>
      <Button ref={rejectRef} variant="secondary" size="sm" disabled={busy} aria-busy={busy} onClick={() => setAsking(true)}>
        <XIcon size={13} /> {t('rejectLabel')}
      </Button>
    </span>
  );
}

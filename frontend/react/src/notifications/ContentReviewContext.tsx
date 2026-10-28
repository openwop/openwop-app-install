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
import type { PendingApproval, StrategyActivationSnapshot as Snapshot } from '../agents/approvalsClient.js';
import { Button } from '../ui/Button.js';
import { CheckIcon, ExternalLinkIcon, InfoIcon, SparklesIcon, XIcon } from '../ui/icons/index.js';

export function ContentReviewContext({ a }: { a: PendingApproval }): JSX.Element | null {
  const { t } = useTranslation('notifications');
  const canLink = Boolean(a.orgId && a.pageId);
  const hasAi = (a.aiDraftedLocales?.length ?? 0) > 0;
  const liveCount = a.liveReferenceSections?.length ?? 0;
  const outdated = a.outdatedTranslationLocales ?? [];
  const pageHref = `/cms/p/${encodeURIComponent(a.orgId ?? '')}/${encodeURIComponent(a.pageId ?? '')}`;
  if (!canLink && !hasAi && liveCount === 0 && outdated.length === 0 && typeof a.pageVersion !== 'number') return null;
  return (
    <div className="u-flex u-items-center u-gap-2 u-wrap u-fs-12">
      {canLink && (
        // The affordance the whole gate depends on: read it, then decide it.
        <Link to={pageHref} className="u-flex u-items-center u-gap-1">
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
      {liveCount > 0 && (
        // ADR 0859 D5 (ADR 0594 D1) — the condition ADR 0594 accepted the lane on:
        // the reviewer is TOLD these sections keep changing after approval. The whole
        // sentence is visible text, never a tooltip (review F7.1). Plain text, not a
        // chip: a pill does not wrap, and the sentence overflows a phone-width card
        // (UX grade CMSA2UX-9).
        <span className="muted u-flex u-items-center u-gap-1">
          <InfoIcon size={11} /> {t('approvalsLiveData', { count: liveCount })}
        </span>
      )}
      {outdated.length > 0 && (
        // ADR 0861 D6 addendum (ADR 0859 OQ-1) — INFORMATION, never a block: the
        // decide bar is unchanged. Derived server-side from the editor's own
        // translation-status read, so the card and the editor say the same thing.
        // It links to the page editor, where that status is shown (toolbar summary
        // + per-section chips) — the editor has no separate translation tab.
        // Wrapping text, not a chip, for the phone-width reason above.
        canLink ? (
          <Link to={pageHref} className="u-flex u-items-center u-gap-1">
            <InfoIcon size={11} /> {t('approvalsOutdatedTranslations', { count: outdated.length, locales: outdated.join(', ') })}
          </Link>
        ) : (
          <span className="muted u-flex u-items-center u-gap-1">
            <InfoIcon size={11} /> {t('approvalsOutdatedTranslations', { count: outdated.length, locales: outdated.join(', ') })}
          </span>
        )
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
  approveLabel,
  rejectLabel,
  approveDisabled = false,
}: {
  busy: boolean;
  /** A review without its exact evidence may still be rejected. */
  approveDisabled?: boolean;
  onApprove: () => void;
  /** Kind-true verbs (ADR 0785 P4: approving a Claude Code prompt ALLOWS a tool). */
  approveLabel?: string;
  rejectLabel?: string;
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
      <Button variant="primary" size="sm" disabled={busy || approveDisabled} aria-busy={busy} onClick={onApprove}>
        <CheckIcon size={13} /> {approveLabel ?? t('approveLabel')}
      </Button>
      <Button ref={rejectRef} variant="secondary" size="sm" disabled={busy} aria-busy={busy} onClick={() => setAsking(true)}>
        <XIcon size={13} /> {rejectLabel ?? t('rejectLabel')}
      </Button>
    </span>
  );
}

/**
 * ADR 0845 D6 — APPROVE WHAT YOU SEE, on the card. A `strategy-activation` approval
 * binds to a digest of the strategy's protected content plus where it lives; the
 * decide handler refuses if the live strategy no longer matches. The card used to say
 * only `Activate strategy "X"`, so the approver signed off on objectives they were
 * never shown.
 *
 * Rendered: period (label + dates), horizon, accountable executive, every objective
 * and key result with its target and its metric source (the field that authorizes
 * confirmed sync writes). NOT rendered here, and reachable through the "Open
 * strategy" link: weights, the measure's baseline/direction, and the org/scope (the
 * inbox only lists this row to approvers in that org). Long plans fold into a
 * `<details>` so the decide bar stays reachable.
 *
 * Lives in this module (not its own file) so it rides the chunk both inboxes already
 * share: a new shared chunk adds its name to the ENTRY chunk's preload map.
 */

/** Above this many objectives the list starts folded. */
const OPEN_UP_TO = 5;

export function StrategyActivationSnapshot({ strategyId, strategyTitle, snapshot }: { strategyId?: string | undefined; strategyTitle?: string | undefined; snapshot?: Snapshot | undefined }): JSX.Element | null {
  const { t } = useTranslation('notifications');
  const open = strategyId ? (
    <Link to={`/strategy/${encodeURIComponent(strategyId)}`} aria-label={strategyTitle ? `${t('strategySnapshotOpen')}: ${strategyTitle}` : undefined}>
      {t('strategySnapshotOpen')}
    </Link>
  ) : null;
  if (!snapshot) {
    // No snapshot: a legacy row (queued before ADR 0845), or a row re-opened after a
    // failed decide (resolving drops the snapshot). Say so rather than render an empty
    // list that reads as "no objectives"; the digest still binds the decision.
    return strategyId ? <p className="u-m-0 u-fs-12 muted">{t('strategySnapshotLegacy')} {open}</p> : null;
  }
  const period = snapshot.period
    ? [snapshot.period.label, [snapshot.period.startDate, snapshot.period.endDate].filter(Boolean).join(' – ')].filter(Boolean).join(' ')
    : null;
  const meta = [
    period,
    t('strategySnapshotHorizon', { horizon: snapshot.planningHorizon }),
    snapshot.accountableExecutive ? t('strategySnapshotExecutive', { name: snapshot.accountableExecutive }) : null,
  ].filter(Boolean).join(' · ');
  const list = (
    <ul className="u-m-0 u-grid u-gap-1">
      {snapshot.objectives.map((o) => (
        <li key={o.id}>
          <strong>{o.title}</strong>
          {o.keyResults.length > 0 && (
            <ul className="u-m-0 u-fs-12">
              {o.keyResults.map((k) => {
                const target = k.target ?? (k.measure?.target !== undefined ? String(k.measure.target) : undefined);
                const unit = k.unit ?? k.measure?.unit ?? '';
                return (
                  <li key={k.id}>
                    {k.title}
                    {target ? ` — ${t('strategySnapshotTarget', { target, unit }).trim()}` : ''}
                    {k.measure?.source ? <span className="muted"> · {t('strategySnapshotSource', { kind: k.measure.source.kind })}</span> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="u-grid u-gap-1">
      <p className="u-m-0 u-fs-12 muted">{meta}</p>
      {snapshot.objectives.length === 0 ? (
        <p className="u-m-0 u-fs-12 muted">{t('strategySnapshotNoObjectives')}</p>
      ) : (
        <details open={snapshot.objectives.length <= OPEN_UP_TO}>
          <summary>{t('strategySnapshotLabel')} ({snapshot.objectives.length})</summary>
          {list}
        </details>
      )}
      {open}
    </div>
  );
}

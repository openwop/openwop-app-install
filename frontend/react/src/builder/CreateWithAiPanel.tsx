/**
 * "Create with AI" panel (ADR 0073 Phase 3) — the builder's entry into AI
 * workflow authoring. It does NOT implement a chat or a BYOK gate: it owns only
 * the builder's drawer chrome (heading + Close + the hand-off) and delegates the
 * AI surface to the shared <EmbeddedChatPanel> (chat/), supplying its agent + a
 * context-aware empty state.
 *
 * THE HAND-OFF (ADR 0596 / `WFAU-1`). Four locales, the agent's system prompt and
 * the persist tool's `note` all promised the authored workflow "opens on the
 * canvas", and NOTHING implemented it: the panel had no `useNavigate`, no
 * workflow-id state, no completion callback, and `fetchRegisteredWorkflow` — the
 * function whose docblock names this exact use — had zero builder callers. The
 * user's only route to their new workflow was to read an id out of model prose.
 *
 * It is wired here, but NOT the way the promise was worded, for two measured
 * reasons:
 *   1. The id cannot come from the chat. `agent.toolReturned` (RFC 0064,
 *      `host/toolHooks.ts` `ToolReturnedFields`) carries `{toolName, status,
 *      durationMs}` — no result payload — so the `workflowId` the persist tool
 *      returns never reaches the browser. Relaying it would be a WIRE change,
 *      which needs an RFC in `openwop`, not a host ADR. So the panel learns what
 *      was authored from an AUTHORITATIVE HOST READ (`listWorkflows`, the
 *      tenant-scoped list) diffed against the baseline it took when it opened.
 *   2. Auto-navigating would be destructive. This drawer lives inside
 *      `/builder/:workflowId`; routing away unmounts the canvas the user is
 *      standing on — and the surface has no dirty-state guard. So the hand-off
 *      is an explicit LINK the user chooses, which is also the shape the sibling
 *      `propose` lane already ships (`chat/reviews/ComposedWorkflowSection`).
 * The copy was corrected to match in all four locales.
 *
 * EmbeddedChatPanel is **lazy-imported** from `chat/` so the builder doesn't add
 * a static import edge into chat/ (chat/ already imports builder/ — a static
 * builder→chat edge would create a cycle; the dynamic import is a separate chunk).
 * Features that `chat/` does NOT import back may static-import EmbeddedChatPanel.
 *
 * @see docs/adr/0073-embeddable-conversation-view.md
 * @see docs/adr/0596-workflow-author-honesty-and-reachability.md
 */

import { Button } from '../ui/Button.js';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { WorkflowAuthorWelcome } from './WorkflowAuthorWelcome.js';
import { listWorkflows } from './persistence/backendStore.js';
import { WorkflowIcon } from '../ui/icons/index.js';
import { announce } from '../ui/announce.js';

const EmbeddedChatPanel = lazy(() =>
  import('../chat/EmbeddedChatPanel.js').then((m) => ({ default: m.EmbeddedChatPanel })),
);

/** The agent the builder's "Create with AI" scopes the chat to (ADR 0072 pack). */
const WORKFLOW_ARCHITECT_AGENT_ID = 'feature.workflow-author.agents.workflow-architect';

/** A `seedPrompt` (ADR 0137 — from an accepted Ambient Work Graph suggestion) kicks the
 *  Workflow Architect with the recurring pattern: the empty state auto-submits it ONCE so
 *  the handoff actually carries the work across (no more no-op accept). Absent ⇒ the
 *  normal welcome. */
export function CreateWithAiPanel(
  { onClose, seedPrompt, open = true }: { onClose(): void; seedPrompt?: string; open?: boolean },
): JSX.Element {
  const { t } = useTranslation('builder');
  /** Ids the tenant owned at the start of the CURRENT window. `null` = we have no
   *  clean baseline, in which case the hand-off stays SILENT rather than
   *  presenting every pre-existing workflow as "just authored". A read we could
   *  not do is not a result.
   *
   *  ADR 0596 §Correction 7 — the window used to be the PANEL'S WHOLE LIFETIME,
   *  which is not what `R8` claimed. `BuilderShell` mounts this panel once
   *  (`aiHasOpened` only ever goes true; the drawer hides via CSS, not unmount)
   *  and SURVIVES navigation between workflows (`/builder/:workflowId` renders
   *  one un-keyed `<BuilderShell/>`), so a baseline taken in a mount-only effect
   *  never refreshed for the rest of the browser session. It is now re-taken on
   *  every drawer OPEN and after every settled TURN. */
  const baseline = useRef<Set<string> | null>(null);
  const [authored, setAuthored] = useState<ReadonlyArray<{ id: string; name?: string }>>([]);
  /** Mirror of `authored` for the async callback — a `useCallback` closure would
   *  read a stale array, and computing the merge inside a state updater cannot
   *  hand the new length back out for the announcement. */
  const authoredRef = useRef<ReadonlyArray<{ id: string; name?: string }>>([]);

  // Re-baseline whenever the drawer OPENS (this also covers mount, since it opens
  // to `true`). Cleared to `null` FIRST and on purpose: a turn that settles before
  // this read lands then finds no baseline and stays silent for that turn rather
  // than diffing against a stale one. Silence is the safe direction; a false
  // attribution is not.
  useEffect(() => {
    if (!open) return;
    let live = true;
    baseline.current = null;
    authoredRef.current = [];
    setAuthored([]); // the copy says "since you opened this panel" — so start empty
    void listWorkflows({ includeArchived: true })
      .then((rows) => { if (live) baseline.current = new Set(rows.map((r) => r.id)); })
      .catch(() => { /* no baseline ⇒ silent this window; `onTurnSettled` recovers */ });
    return () => { live = false; };
  }, [open]);

  const onTurnSettled = useCallback(() => {
    void listWorkflows({ includeArchived: true })
      .then((rows) => {
        const base = baseline.current;
        // ONE read, TWO jobs (§Correction 7 + §Correction 8):
        //  · it re-baselines, so the next turn's diff is bounded by THIS turn;
        //  · when the window's own read lost (offline, or the documented per-IP
        //    429 the builder's load fan-out can trip), it ADOPTS this read as the
        //    baseline. Failing silent is right; failing silent FOREVER was not —
        //    the panel never unmounts, so there was no recovery path at all.
        baseline.current = new Set(rows.map((r) => r.id));
        if (!base) return; // silent THIS turn, working from the next one on
        const fresh = rows.filter((r) => !base.has(r.id));
        if (fresh.length === 0) return;
        // ACCUMULATE across turns rather than replace. Because the baseline now
        // moves every turn, a plain replace would delete the link the user was
        // about to click the moment the next turn settled. Everything in this
        // list appeared after the drawer opened, which is exactly what the copy
        // claims — nothing more.
        const seen = new Set(authoredRef.current.map((p) => p.id));
        const next = [
          ...authoredRef.current,
          ...fresh.filter((r) => !seen.has(r.id)).map((r) => ({ id: r.id, ...(r.name ? { name: r.name } : {}) })),
        ];
        authoredRef.current = next;
        setAuthored(next);
        // ADR 0596 §Correction 6 — announce through the region that ALREADY
        // EXISTS. This block used to carry its own `role="status"`, which
        // DESIGN.md §8 forbids by name: a live region MOUNTED WITH ITS TEXT
        // already inside is not reliably announced, because AT registers the
        // region on insertion and announces subsequent MUTATIONS. This block is
        // conditionally mounted, so it announced approximately nothing while
        // looking perfectly correct in the DOM. `GlobalLiveRegion` (ADR 0363 P4)
        // is on the page long before this message. Polite, not assertive: the
        // user asked the Architect for this, but it arrives on a background
        // re-read, not as the direct result of a keystroke.
        announce(t('aiAuthoredReady', { count: next.length }));
      })
      .catch(() => { /* a failed re-read shows nothing; it never invents a link */ });
  }, [t]);

  return (
    <div className="builder-ai-panel surface-card u-flex u-flex-col u-minh-0" role="region" aria-label={t('aiPanelHeading')}>
      <div className="u-flex u-items-center u-justify-between u-gap-2">
        <h3 className="u-m-0">{t('aiPanelHeading')}</h3>
        <Button variant="secondary" size="sm" onClick={onClose}>{t('aiClose')}</Button>
      </div>
      <p className="muted u-fs-13 u-m-0">{t('aiPanelHint')}</p>
      {authored.length > 0 ? (
        <div className="u-flex u-flex-col u-gap-1">
          <p className="u-fs-12 u-m-0">{t('aiAuthoredReady', { count: authored.length })}</p>
          <div className="u-flex u-gap-2 u-wrap">
            {authored.map((w) => (
              <Link key={w.id} to={`/builder/${encodeURIComponent(w.id)}`} className="secondary btn-sm u-flex u-items-center u-gap-2">
                <WorkflowIcon size={14} aria-hidden /> {t('aiOpenOnCanvas', { name: w.name ?? w.id })}
              </Link>
            ))}
          </div>
        </div>
      ) : null}
      <Suspense fallback={<div className="muted u-fs-13 u-p-3">{t('aiAuthoring')}</div>}>
        <EmbeddedChatPanel
          agentId={WORKFLOW_ARCHITECT_AGENT_ID}
          onTurnSettled={onTurnSettled}
          renderEmptyState={(onPick) => <WorkflowAuthorWelcome onPick={onPick} {...(seedPrompt ? { seedPrompt } : {})} />}
        />
      </Suspense>
    </div>
  );
}

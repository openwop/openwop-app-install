/**
 * Scrollable message feed with auto-scroll-to-bottom on new content.
 * EVERY message that carries open interrupts (`activeInterrupts` —
 * assistant turns AND workflow_run bubbles) renders one interrupt card
 * per entry via the `CardHost` registry below itself. A workflow with
 * parallel branches can open several gates at once, so this is a list.
 * The chat thread is where the user takes action. The right-side `WorkflowProgressPanel` is for
 * *tracking* the run's shape, not for responding to gates.
 *
 * **History (informational, no API impact):**
 *   - 2026-05-24 — progress UI moved out of the bubble into the
 *     right-side panel; interrupt cards moved with it.
 *   - 2026-05-25 — interrupt cards REVERTED to the chat thread per
 *     user feedback that the split forced users to swivel between
 *     two surfaces every gate. The panel now shows a pointer chip.
 *
 * **Current prop surface:** `onCancelWorkflowRun` was removed during
 * the 2026-05-24 split (cancel lives on the panel); added
 * `onOpenWorkflowProgress` (callback to focus a run + open the panel)
 * and `focusedWorkflowMessageId` (mirrors panel state so the bubble's
 * "View progress" link can flip to "Showing in panel"). Adopters
 * forking this file need to thread these through.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageBubble } from './MessageBubble.js';
import { WorkflowRunBubble } from './WorkflowRunBubble.js';
import { CardHost } from './registry/CardHost.js';
import { a2uiInterruptCard } from './a2ui/interruptBridge.js';
import { HitlDecisionCard } from './HitlDecisionCard.js';
import { WorkflowCompletionCard } from './WorkflowCompletionCard.js';
import { ArtifactPreviewModal } from './ArtifactPreviewModal.js';
import { ArrowDownIcon } from '../ui/icons/index.js';
import type { ChatMessage } from './hooks/useChatSession.js';

/** Normalize historical `@<slug>` user-message text to `/<slug>` when
 *  the message is immediately followed by a `workflow_run` bubble.
 *
 *  Why this exists: the 2026-05-28 mention-symbol swap moved workflow
 *  dispatch from `@` to `/`. New chats write `/<slug>` directly (see
 *  `runWorkflowMention` in `useChatSession.ts`), but chats persisted
 *  before the swap still have `@<slug>` in their user-message content.
 *  Without normalization, an old chat reads "I dispatched the
 *  workflow with `@uppercase`" while a new chat reads "with
 *  `/uppercase`" — the same surface, two syntaxes.
 *
 *  The transformation is purely display-time: the persisted content
 *  stays as-is on disk (it's an immutable history record). The
 *  workflow-run bubble it precedes already shows `/slug` from the
 *  `workflowRun.slug` field via the B3 update.
 *
 *  We narrow the transformation to user messages immediately before a
 *  `workflow_run` so we don't accidentally rewrite an actual `@`-prefixed
 *  literal in a non-workflow user message. */
function normalizeWorkflowMentions(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  return messages.map((m, i) => {
    if (m.role !== 'user') return m;
    if (typeof m.content !== 'string') return m;
    const next = messages[i + 1];
    if (!next || next.role !== 'workflow_run') return m;
    if (!/^@[a-z0-9][a-z0-9-]*(\s|$)/i.test(m.content)) return m;
    return { ...m, content: '/' + m.content.slice(1) };
  });
}

function runIdFor(m: ChatMessage): string {
  // `workflow_run` messages carry the dispatched runId on their state.
  // Assistant messages set meta.runId after createRun resolves. If
  // neither is present we pass an empty string — the card will surface
  // a no-op resolve to the user rather than a 4xx.
  return m.workflowRun?.runId ?? m.meta?.runId ?? '';
}

/** The inline interrupt cards beneath a message — one `CardHost` per open
 *  interrupt (a parallel-gate fan-out suspends on several at once). Extracted
 *  from the message map so it can own a focus-handoff effect: when one gate is
 *  resolved and its card unmounts while siblings remain, keyboard focus would
 *  otherwise fall to `<body>`. We move it to a remaining card instead (a11y —
 *  don't strand focus on removal). Each card container is `tabIndex={-1}` so it
 *  is a programmatic focus target. */
function InterruptCardStack({
  message,
  tenantId,
  onResolveInterrupt,
}: {
  message: ChatMessage;
  tenantId: string;
  onResolveInterrupt: (messageId: string, value: unknown, nodeId?: string) => Promise<void>;
}): JSX.Element | null {
  const open = message.activeInterrupts ?? [];
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevIds = useRef<string[]>(open.map((i) => i.interruptId));
  const idsKey = open.map((i) => i.interruptId).join('|');

  useEffect(() => {
    const ids = open.map((i) => i.interruptId);
    const prev = prevIds.current;
    // A gate resolved (the set shrank) but siblings remain — move focus to a
    // remaining card so it doesn't vanish to <body>. Prefer the card that took
    // the removed one's slot; fall back to the last remaining card.
    if (ids.length > 0 && ids.length < prev.length) {
      const removedIdx = prev.findIndex((id) => !ids.includes(id));
      const targetId = ids[Math.min(removedIdx === -1 ? ids.length - 1 : removedIdx, ids.length - 1)];
      if (targetId) cardRefs.current.get(targetId)?.focus();
    }
    prevIds.current = ids;
    for (const id of [...cardRefs.current.keys()]) {
      if (!ids.includes(id)) cardRefs.current.delete(id);
    }
    // Keyed on the id set so the effect fires only when gates open/close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  if (open.length === 0) return null;

  return (
    <>
      {open.map((interrupt) => {
        // ADR 0051 Phase 3: render a surface-bearing interrupt as an A2UI form
        // (ui.a2ui-surface) instead of the default interrupt.<kind> card; falls
        // back to the default when there's no valid surface.
        const a2ui = a2uiInterruptCard(interrupt);
        // Each card carries its gate's friendly name (e.g. "Legal review") as an
        // in-card eyebrow so the approver always knows WHICH gate it is — for a
        // single gate AND when several fan out at once. Falls back to the raw
        // nodeId when the run has no name map.
        const nodeName = message.workflowRun?.nodeNames?.[interrupt.nodeId] ?? interrupt.nodeId;
        return (
          <div
            key={interrupt.interruptId}
            className="msgfeed-card-indent"
            tabIndex={-1}
            ref={(el) => {
              if (el) cardRefs.current.set(interrupt.interruptId, el);
              else cardRefs.current.delete(interrupt.interruptId);
            }}
          >
            <CardHost
              cardType={a2ui ? a2ui.cardType : `interrupt.${interrupt.kind}`}
              payload={a2ui ? a2ui.payload : interrupt}
              context={{
                runId: runIdFor(message),
                nodeId: interrupt.nodeId,
                tenantId,
                ...(nodeName ? { nodeName } : {}),
                ...(message.workflowRun?.workflowName ? { workflowName: message.workflowRun.workflowName } : {}),
              }}
              onAction={async (_actionId, payload) => {
                await onResolveInterrupt(message.id, payload, interrupt.nodeId);
              }}
            />
          </div>
        );
      })}
    </>
  );
}

interface Props {
  messages: readonly ChatMessage[];
  tenantId: string;
  onResolveInterrupt: (messageId: string, value: unknown, nodeId?: string) => Promise<void>;
  /** Open the workflow-progress side panel + focus the bubble's run. */
  onOpenWorkflowProgress: (messageId: string) => void;
  /** Workflow-run message id currently shown in the side panel, if any. */
  focusedWorkflowMessageId: string | null;
  /** Re-run the prior user message for this assistant bubble. */
  onRegenerate?: (messageId: string) => void;
  /** Record / clear 👍 / 👎 on an assistant bubble. */
  onFeedback?: (messageId: string, feedback: 'positive' | 'negative' | null) => void;
  /** ADR 0117 Phase 4 — branch a NEW conversation seeded through this turn (fromSeq =
   *  turn index + 1). Only wired through when the conversation is fully loaded
   *  (`!hasOlderMessages`), so a settled message's render index equals its server seq. */
  onBranchFrom?: (fromSeq: number) => void;
  /** Open the BYOK settings wizard (from the error-card CTA). */
  onReconfigureBYOK?: () => void;
  /** ADR 0043 Phase 3b: older messages remain unfetched for this thread. */
  hasOlderMessages?: boolean;
  /** An earlier page is being fetched (disables the control). */
  isLoadingEarlier?: boolean;
  /** Fetch + prepend the next-older page. */
  onLoadEarlier?: () => void;
}

export function MessageFeed({
  messages,
  tenantId,
  onResolveInterrupt,
  onOpenWorkflowProgress,
  focusedWorkflowMessageId,
  onRegenerate,
  onFeedback,
  onBranchFrom,
  onReconfigureBYOK,
  hasOlderMessages,
  isLoadingEarlier,
  onLoadEarlier,
}: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const endRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  // "Stick to bottom" = the user is at (or within a threshold of) the bottom, so
  // new content should auto-follow. The moment they scroll up, this goes false and
  // streaming tokens stop yanking them down — a "Jump to latest" pill appears
  // instead. `stickRef` is the synchronous source of truth the scroll effect
  // reads; `atBottom` mirrors it into render state for the pill's visibility.
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  // Display-time normalization for the 2026-05-28 mention-symbol swap.
  // Pre-swap chats have `@<workflow-slug>` in user-message content;
  // we render them as `/<workflow-slug>` to match the new syntax.
  // Memoize so we don't rewalk + re-rewrite on every render that
  // doesn't change messages.
  const displayMessages = useMemo(() => normalizeWorkflowMentions(messages), [messages]);

  // Distance from the bottom (px) under which we consider the user "at the
  // bottom" and keep auto-following. Generous enough that a stray wheel tick or a
  // newly-appended line doesn't drop stickiness.
  const BOTTOM_THRESHOLD_PX = 80;

  // Track the thread's first/last ids + the streaming message's length so the
  // scroll effect can tell three cases apart:
  //   - thread SWITCH (first AND last id both change, or first content) → always
  //     land at the bottom and re-arm stickiness, regardless of prior scroll.
  //   - content at the BOTTOM (append: last id changes; or streaming delta: last
  //     id same, length grows) → follow ONLY if the user is sticking to bottom.
  //   - pure PREPEND (load-earlier, ADR 0043 Phase 3b — first id changes, last
  //     unchanged) → hold position; never scroll.
  const prevFirstIdRef = useRef<string | null>(null);
  const prevLastIdRef = useRef<string | null>(null);
  const prevLastLenRef = useRef<number>(-1);
  useEffect(() => {
    const first = messages[0];
    const last = messages[messages.length - 1];
    const firstId = first?.id ?? null;
    const lastId = last?.id ?? null;
    const lastLen = last ? (typeof last.content === 'string' ? last.content.length : -1) : 0;

    const hadMessages = prevLastIdRef.current !== null;
    const threadSwitched = !hadMessages
      || (firstId !== prevFirstIdRef.current && lastId !== prevLastIdRef.current);
    const bottomChanged = lastId !== prevLastIdRef.current || lastLen !== prevLastLenRef.current;

    prevFirstIdRef.current = firstId;
    prevLastIdRef.current = lastId;
    prevLastLenRef.current = lastLen;

    if (threadSwitched) {
      stickRef.current = true;
      setAtBottom(true);
      endRef.current?.scrollIntoView({ block: 'end' });
      return;
    }
    // Instant (not smooth) follow: smooth scrolling fights each token's append
    // and reads as jitter during a fast stream.
    if (bottomChanged && stickRef.current) {
      endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    }
  }, [messages]);

  // Re-evaluate stickiness as the user scrolls. Setting state only on a boolean
  // flip keeps this ~60Hz handler from re-rendering the feed every frame.
  const onScroll = (): void => {
    const el = logRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = distanceFromBottom <= BOTTOM_THRESHOLD_PX;
    stickRef.current = near;
    setAtBottom((prev) => (prev === near ? prev : near));
  };

  const jumpToBottom = (): void => {
    stickRef.current = true;
    setAtBottom(true);
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  };

  // Artifact preview modal state. Single global instance so multiple
  // completion cards in history (one per past workflow run in this
  // session) share the same modal without each component owning one.
  const [preview, setPreview] = useState<{
    nodeId: string;
    label: string;
    output: unknown;
  } | null>(null);

  return (
    <div className="msgfeed-wrap">
    <div
      ref={logRef}
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-label={t('conversationLog')}
      className="msgfeed-log"
      onScroll={onScroll}
    >
      {hasOlderMessages && onLoadEarlier && (
        <div
          className="u-flex u-flex-col u-items-center u-p-2 u-gap-2"
          role="status"
          aria-live="polite"
        >
          {isLoadingEarlier ? (
            <div className="msgfeed-skeleton" aria-label={t('common:loading')}>
              <span className="skeleton msgfeed-skel-line msgfeed-skel-in" />
              <span className="skeleton msgfeed-skel-line msgfeed-skel-out" />
              <span className="skeleton msgfeed-skel-line msgfeed-skel-in" />
            </div>
          ) : (
            <button
              type="button"
              className="secondary u-fs-12"
              onClick={onLoadEarlier}
            >
              {t('loadEarlierMessages')}
            </button>
          )}
        </div>
      )}
      {displayMessages.map((m, i) => (
        <div key={m.id}>
          {m.role === 'workflow_run'
            ? <WorkflowRunBubble
                message={m}
                onOpenProgress={onOpenWorkflowProgress}
                isFocusedInPanel={m.id === focusedWorkflowMessageId}
              />
            : <MessageBubble
                message={m}
                {...(onRegenerate ? { onRegenerate } : {})}
                {...(onFeedback ? { onFeedback } : {})}
                {...(onBranchFrom && !hasOlderMessages ? { onBranchFrom, branchSeq: i + 1 } : {})}
                {...(onReconfigureBYOK ? { onReconfigureBYOK } : {})}
              />}
          {/* Inline interrupt card — renders below the bubble for
              every message kind (chat-turn AND workflow_run). The
              right-side WorkflowProgressPanel is for *tracking* the
              run's overall shape (step list, status, outputs); the
              chat thread is where the user takes the action. Keeping
              the approval / clarification card here means the user
              doesn't have to swivel between two surfaces to respond. */}
          <InterruptCardStack
            message={m}
            tenantId={tenantId}
            onResolveInterrupt={onResolveInterrupt}
          />
          {/* Persistent HITL decision artifacts — one per resolved
              interrupt. Survives the open interrupt being cleared.
              Renders only the resolved entries; an open interrupt is
              still shown above via the interactive CardHost. */}
          {m.workflowRun?.interruptHistory?.filter((h) => h.resolvedAt).map((entry) => (
            <div
              key={`decision-${entry.interruptId}`}
              className="msgfeed-card-indent"
            >
              <HitlDecisionCard
                entry={entry}
                {...(m.workflowRun?.nodeNames?.[entry.nodeId] ? { nodeName: m.workflowRun.nodeNames[entry.nodeId] } : {})}
              />
            </div>
          ))}
          {/* Workflow-completion artifact — renders once the run
              reaches a terminal state. Each terminal node surfaces a
              View button that opens the shared preview modal. */}
          {m.role === 'workflow_run' && m.workflowRun && (
            <div className="msgfeed-card-indent">
              <WorkflowCompletionCard
                run={m.workflowRun}
                onPreviewArtifact={(nodeId, output, label) =>
                  setPreview({ nodeId, output, label })
                }
              />
            </div>
          )}
        </div>
      ))}
      <div ref={endRef} />
      <ArtifactPreviewModal
        open={preview !== null}
        nodeId={preview?.nodeId ?? ''}
        label={preview?.label ?? ''}
        output={preview?.output}
        onClose={() => setPreview(null)}
      />
    </div>
    {!atBottom && (
      <button
        type="button"
        className="msgfeed-jump"
        onClick={jumpToBottom}
        title={t('jumpToBottom')}
        aria-label={t('jumpToBottom')}
      >
        <ArrowDownIcon size={16} />
        <span>{t('jumpToBottom')}</span>
      </button>
    )}
    </div>
  );
}

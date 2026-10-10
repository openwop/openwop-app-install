/**
 * ADR 0074 — the single client source of truth for review status.
 *
 * Every review surface (chat Reviews tab, in-chat interrupt card, Runs screen,
 * inbox) reads status from here and writes decisions through here, so approving
 * a review anywhere updates everywhere — live and cross-client.
 *
 * How it stays live without a second connection: the notifications SSE stream
 * (the app's one global live feed) carries transient `review.updated` frames,
 * which the notification store forwards to the `signalBus`. This store
 * subscribes to that bus and patches/evicts the affected review the instant a
 * decision lands — regardless of which surface, client, or user made it.
 *
 *   decision owner (BE) → review.updated signal → notifications SSE
 *     → notificationStore → signalBus → reviewStatusStore → every surface
 *
 * State held:
 *   - `reviews`: the pending inbox (full ReviewRequest objects, hydrated once
 *     via listReviews and kept fresh by frames + decisions).
 *   - `statusById`: status learned from frames, keyed by reviewId. Lets a card
 *     whose review was never in the pending list (e.g. an in-chat interrupt)
 *     still observe "resolved" — keyed by reviewId AND addressable by run+node.
 *
 * @see notifications/signalBus.ts — the transient frame channel
 * @see chat/reviews/reviewClient.ts — list/get/decide over the ADR 0068 projection
 * @see docs/adr/0074-live-review-status-sync.md
 */

import { useMemo } from 'react';
import { create } from 'zustand';
import {
  listReviews,
  decideReview,
  ReviewRequestError,
  type ReviewRequest,
  type ReviewStatus,
} from './reviewClient.js';
import { subscribeReviewSignal } from '../../notifications/signalBus.js';
import type { Notification } from '../../notifications/types.js';

/** A review is terminal (drops out of the pending inbox) for any status but
 *  `pending`. The projection's resolved/approved/rejected/expired/cancelled all
 *  mean "no longer actionable". */
function isTerminal(status: ReviewStatus): boolean {
  return status !== 'pending';
}

/** Quorum progress carried on a `pending` frame / review. */
type ReviewPolicy = ReviewRequest['policy'];

/** Status learned from a signal frame (or a local decision), addressable by
 *  reviewId and — for run-scoped cards that hold runId+nodeId, not reviewId —
 *  by the run/node secondary index the frame carries. */
interface StatusEntry {
  reviewId: string;
  status: ReviewStatus;
  runId?: string;
  nodeId?: string;
  policy?: ReviewPolicy;
}

interface ReviewSignalFrame {
  reviewId?: string;
  status?: ReviewStatus;
  policy?: ReviewPolicy;
}

export type DecideOutcome = 'recorded' | 'already-resolved';

interface ReviewStatusState {
  /** The pending inbox — full review objects for rendering lists/cards. */
  reviews: ReviewRequest[];
  /** Status overrides keyed by reviewId (from frames + optimistic decisions). */
  statusById: Record<string, StatusEntry>;
  loading: boolean;
  error: string | null;
  /** ADR 0778 (`APUX-5`) — the load failure itself, so the panel can localize
   *  it (`error` is the raw server text, kept for existing readers). */
  errorCause: unknown;
  /** ADR 0778 (`APUX-1`) — the last failed decision per review, kept HERE
   *  because the optimistic drop unmounts the card that made the call. Cleared
   *  when that review is decided again. */
  failureById: Record<string, unknown>;
  /** True after the first list read settles. Distinguishes a proven empty
   * inbox from the store's pre-hydration empty array. */
  initialized: boolean;
  /** Unsubscribe handle for the signal-bus subscription. */
  _busCleanup: (() => void) | null;
  /** Count of live `connect()` callers, so the last `disconnect()` tears down. */
  _refcount: number;

  /** Subscribe to the signal bus + hydrate the pending list once. Idempotent;
   *  ref-counted so multiple surfaces can share one subscription. */
  connect: () => Promise<void>;
  disconnect: () => void;
  /** Re-hydrate the pending list from the server (reconcile after a gap). */
  refresh: () => Promise<void>;
  /** Decide a review (optimistic: drop locally, then dispatch). Resolves
   *  `'recorded'`, or `'already-resolved'` on a plain 409 (someone else decided
   *  first — the drop stands, but it was not THIS decision); a
   *  `proposal_stale`/`proposal_expired` 409 (ADR 0473 — the row REOPENED
   *  server-side) restores + rethrows; other errors reconcile + rethrow. */
  decide: (reviewId: string, action: string, body?: { value?: unknown; note?: string; expectedDefinitionHash?: string; expectedContentHash?: string }) => Promise<DecideOutcome>;
  /** ADR 0778 (closing review I1) — hand a kept failure to the card that will
   *  show it, ONCE: the card copies it into its own state and the entry goes,
   *  so a later remount (reopening the tab) or a second surface showing the
   *  same review does not announce it again. */
  consumeFailure: (reviewId: string) => void;
  /** Apply a `review.updated` signal frame (also used by tests). */
  _applySignal: (frame: Notification) => void;
}

/** Upper bound on retained status overrides. A terminal entry is only needed
 *  briefly — until the run's own SSE swaps the resolved card — so we keep a
 *  generous recent window and FIFO-evict the oldest beyond it. Bounds both
 *  memory and the `useReviewStatusByRunNode` scan over a long-lived session. */
const STATUS_CAP = 500;

/** Add an entry, FIFO-trimming the oldest keys past STATUS_CAP. Object string
 *  keys preserve insertion order, so the first keys are the oldest. */
function withCappedStatus(
  prev: Record<string, StatusEntry>,
  entry: StatusEntry,
): Record<string, StatusEntry> {
  const next = { ...prev, [entry.reviewId]: entry };
  const keys = Object.keys(next);
  if (keys.length <= STATUS_CAP) return next;
  for (const k of keys.slice(0, keys.length - STATUS_CAP)) delete next[k];
  return next;
}

/** Record a status entry + evict-or-update the pending list to match. */
function applyStatus(state: ReviewStatusState, entry: StatusEntry): Partial<ReviewStatusState> {
  const statusById = withCappedStatus(state.statusById, entry);
  let reviews = state.reviews;
  const policy = entry.policy;
  if (isTerminal(entry.status)) {
    // Resolved/approved/rejected ⇒ drop it from the pending inbox.
    reviews = state.reviews.filter((r) => r.reviewId !== entry.reviewId);
  } else if (policy) {
    // Still pending with updated quorum progress ⇒ patch the policy in place.
    reviews = state.reviews.map((r) =>
      r.reviewId === entry.reviewId ? { ...r, policy } : r,
    );
  }
  return { statusById, reviews };
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRefresh(get: () => ReviewStatusState): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; void get().refresh(); }, 400);
}

export const useReviewStatusStore = create<ReviewStatusState>((set, get) => ({
  reviews: [],
  statusById: {},
  loading: false,
  error: null,
  errorCause: null,
  failureById: {},
  initialized: false,
  _busCleanup: null,
  _refcount: 0,

  async connect() {
    const next = get()._refcount + 1;
    set({ _refcount: next });
    if (next > 1) return; // already connected by an earlier caller
    // Subscribe to live frames BEFORE the hydrate so a decision that lands
    // mid-hydrate isn't dropped (the frame just patches the hydrated list).
    const cleanup = subscribeReviewSignal((frame) => get()._applySignal(frame));
    set({ _busCleanup: cleanup });
    await get().refresh();
  },

  disconnect() {
    const next = Math.max(0, get()._refcount - 1);
    set({ _refcount: next });
    if (next > 0) return; // other surfaces still using it
    const c = get()._busCleanup;
    if (c) c();
    set({ _busCleanup: null });
  },

  async refresh() {
    set({ loading: true });
    try {
      const list = await listReviews('pending');
      // Re-apply any terminal overrides learned from frames during the fetch,
      // so an in-flight resolution isn't resurrected by a slightly-stale list.
      const overrides = get().statusById;
      const reviews = list.filter((r) => {
        const o = overrides[r.reviewId];
        return !(o && isTerminal(o.status));
      });
      // A kept failure for a review that has left the list can never be shown.
      const live = new Set(reviews.map((r) => r.reviewId));
      const failureById = Object.fromEntries(Object.entries(get().failureById).filter(([id]) => live.has(id)));
      set({ reviews, loading: false, error: null, errorCause: null, failureById, initialized: true });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err), errorCause: err, initialized: true });
    }
  },

  async decide(reviewId, action, body = {}) {
    // ADR 0778 (`APUX-1`) — a retry starts clean.
    if (get().failureById[reviewId] !== undefined) {
      const { [reviewId]: _cleared, ...others } = get().failureById;
      set({ failureById: others });
    }
    // Optimistic: drop the review from the pending inbox immediately.
    const prev = get().reviews;
    set(applyStatus(get(), { reviewId, status: action === 'reject' ? 'rejected' : 'approved' }));
    try {
      await decideReview(reviewId, action, body);
      // The authoritative reconcile arrives via the broadcast frame; nothing
      // more to do on success.
      return 'recorded';
    } catch (err) {
      // ADR 0473 (review F1) — a `proposal_stale`/`proposal_expired` 409 means
      // the row is STILL PENDING (the server reopened it): the optimistic drop
      // is WRONG. Restore + reconcile + rethrow so the card re-renders and
      // surfaces why. Only the classic already-resolved conflict stays a
      // treat-as-success.
      const reason = err instanceof ReviewRequestError ? err.reason : undefined;
      // ADR 0862 — `action_changed`: an assistant action changed after this card rendered;
      // the server refused BEFORE consuming (or reopened both rows), so it is pending too.
      const stillPending = reason === 'proposal_stale' || reason === 'proposal_expired' || reason === 'action_changed';
      // 409 / already-resolved ⇒ someone else decided first. The optimistic
      // drop is correct (ADR 0068 stale-safe contract) — but it is NOT the
      // caller's decision, so it is reported as such (`APUX-2`: the inbox said
      // "Decision recorded" for a decision that was not). Keyed on the STATUS:
      // the message regex this replaced matched any error mentioning "conflict".
      if (!stillPending && err instanceof ReviewRequestError && err.httpStatus === 409) return 'already-resolved';
      // Any other failure: the decision didn't take. Restore + reconcile, then
      // rethrow so the card can surface the error. The failure is ALSO kept
      // here, keyed by review (`APUX-1`): the optimistic drop unmounted the
      // card that made the call, so the restored card is a new instance and
      // its caller's local error state is gone.
      set({ reviews: prev, failureById: { ...get().failureById, [reviewId]: err } });
      const { [reviewId]: _dropped, ...rest } = get().statusById;
      set({ statusById: rest });
      void get().refresh();
      throw err;
    }
  },

  consumeFailure(reviewId) {
    if (get().failureById[reviewId] === undefined) return;
    const { [reviewId]: _consumed, ...rest } = get().failureById;
    set({ failureById: rest });
  },

  _applySignal(frame) {
    const meta = (frame.metadata ?? {}) as ReviewSignalFrame;
    const reviewId = meta.reviewId;
    const status = meta.status;
    if (!reviewId || !status) return;
    // ADR 0776 — a frame for a PENDING review this inbox has never seen means a
    // new approval opened (frames only patch/evict, they never add). Re-read the
    // inbox, debounced + single-flight, so "waiting on you" counts do not stay
    // stale until the next navigation.
    if (!isTerminal(status) && !get().reviews.some((r) => r.reviewId === reviewId)) scheduleRefresh(get);
    set(applyStatus(get(), {
      reviewId,
      status,
      ...(frame.runId ? { runId: frame.runId } : {}),
      ...(frame.nodeId ? { nodeId: frame.nodeId } : {}),
      ...(meta.policy ? { policy: meta.policy } : {}),
    }));
  },
}));

// ── Selector hooks ─────────────────────────────────────────────────────────

/** The live pending review inbox. */
export function useReviewList(): ReviewRequest[] {
  return useReviewStatusStore((s) => s.reviews);
}

/** The live pending count (the Reviews-tab badge source of truth). */
export function useReviewCount(): number {
  return useReviewStatusStore((s) => s.reviews.length);
}

/** Live status for one reviewId — from a signal/decision override first, else
 *  the pending list. `undefined` ⇒ unknown (never observed). */
export function useReviewStatus(reviewId: string | undefined): ReviewStatus | undefined {
  return useReviewStatusStore((s) => {
    if (!reviewId) return undefined;
    const override = s.statusById[reviewId]?.status;
    if (override) return override;
    return s.reviews.find((r) => r.reviewId === reviewId)?.status;
  });
}

/** Live status for a run-scoped card that holds runId+nodeId (an in-chat or Runs
 *  interrupt card) rather than a reviewId. Matches the frame's secondary index. */
export function useReviewStatusByRunNode(runId: string | undefined, nodeId: string | undefined): ReviewStatus | undefined {
  return useReviewStatusStore((s) => {
    if (!runId || !nodeId) return undefined;
    const hit = Object.values(s.statusById).find((e) => e.runId === runId && e.nodeId === nodeId);
    if (hit) return hit.status;
    const inList = s.reviews.find((r) => r.runId === runId && r.nodeId === nodeId);
    return inList?.status;
  });
}

/**
 * ADR 0776 — pending reviews per conversation, from the ONE inbox (the same
 * authorized list the Reviews tab shows — never a second counter). Keys are the
 * `conversationId` the backend stamps from the run's `chatSessionId`. Memoized on
 * the list identity so consumers do not re-render on unrelated store changes.
 */
export function useReviewCountsByConversation(): ReadonlyMap<string, number> {
  const reviews = useReviewStatusStore((s) => s.reviews);
  return useMemo(() => {
    const m = new Map<string, number>();
    for (const r of reviews) if (r.conversationId) m.set(r.conversationId, (m.get(r.conversationId) ?? 0) + 1);
    return m;
  }, [reviews]);
}

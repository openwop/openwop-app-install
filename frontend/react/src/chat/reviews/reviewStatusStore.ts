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

import { create } from 'zustand';
import {
  listReviews,
  decideReview,
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

interface ReviewStatusState {
  /** The pending inbox — full review objects for rendering lists/cards. */
  reviews: ReviewRequest[];
  /** Status overrides keyed by reviewId (from frames + optimistic decisions). */
  statusById: Record<string, StatusEntry>;
  loading: boolean;
  error: string | null;
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
  /** Decide a review (optimistic: drop locally, then dispatch). 409 (already
   *  resolved) is treated as success; other errors reconcile + rethrow. */
  decide: (reviewId: string, action: string, body?: { value?: unknown; note?: string }) => Promise<void>;
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

export const useReviewStatusStore = create<ReviewStatusState>((set, get) => ({
  reviews: [],
  statusById: {},
  loading: false,
  error: null,
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
      set({ reviews, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async decide(reviewId, action, body = {}) {
    // Optimistic: drop the review from the pending inbox immediately.
    const prev = get().reviews;
    set(applyStatus(get(), { reviewId, status: action === 'reject' ? 'rejected' : 'approved' }));
    try {
      await decideReview(reviewId, action, body);
      // The authoritative reconcile arrives via the broadcast frame; nothing
      // more to do on success.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 409 / already-resolved ⇒ someone else decided first. The optimistic
      // drop is correct; treat as success (ADR 0068 stale-safe contract).
      if (/\b409\b/.test(msg) || /already[_-]?resolved|conflict/i.test(msg)) return;
      // Any other failure: the decision didn't take. Restore + reconcile, then
      // rethrow so the card can surface the error.
      set({ reviews: prev });
      const { [reviewId]: _dropped, ...rest } = get().statusById;
      set({ statusById: rest });
      void get().refresh();
      throw err;
    }
  },

  _applySignal(frame) {
    const meta = (frame.metadata ?? {}) as ReviewSignalFrame;
    const reviewId = meta.reviewId;
    const status = meta.status;
    if (!reviewId || !status) return;
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

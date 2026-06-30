# ADR 0074 - Live cross-surface review-status sync

**Status:** implemented
**Date:** 2026-06-19
**Depends on / composes:** ADR 0068 (unified review projection — the SSoT this builds on), ADR 0070 (quorum review policies), ADR 0050 (addressed vs broadcast notifications), `notifications/emitter.ts`, `routes/interrupts.ts` (`resolveAndResume`), `host/approvalDecision.ts` (`claimApproval`/`rejectApproval`), `chat/registry/` (card registry seam).
**Surface:** host-extension under `/v1/host/openwop-app/*` + a frontend feature-local store. No core route/nav edits.
**RFC gate:** **Host work only — no RFC needed.** Every new surface is non-normative (`/v1/host/openwop-app/*`), reuses the existing `node.interrupt.resolved` wire event, and adds no required field, capability, or normative event to the OpenWOP wire. (A standard cross-host "review changed" event would need a new OpenWOP RFC; this is deliberately host-local.)

## Why this exists

A review (a workflow approval interrupt or a pending approval) is surfaced in **four** places, and resolving it in one does not update the others:

| Surface | Component | Reads | Writes | Live? |
|---|---|---|---|---|
| Chat Reviews tab | `chat/reviews/ReviewInboxPanel` + `ReviewCard` | `listReviews('pending')` once on mount | `decideReview` (projection) | ❌ pull-once, no stream |
| In-chat interrupt card | `chat/registry/defaultCards` `ApprovalCard` | `message.activeInterrupts` | `resolveByRun` | ✅ but only that run's stream |
| Runs screen | `runs/RunDetailPage` + `interrupts/ApprovalCard` | `listOpenInterrupts(runId)` | `resolveByRun` | ✅ but only that run's stream |
| Inbox | `notifications/NeedsYouInbox` | `listApprovals('pending')` | `claimApproval`/`rejectApproval` | notifications SSE, but the list is local state |

Symptom (reported): approving in the Reviews tab leaves a stale, still-approvable card in the chat feed and the inbox; approving on the Runs screen does not clear the Reviews-tab count. The user requirement: **one review status consumed by every review notification, card, and list, and approving anywhere auto-updates everywhere — live, cross-client.**

## Feature-refinement audit

| Concept | Existing owner | Decision |
|---|---|---|
| Review identity + normalized shape | ADR 0068 `ReviewRequest` (`reviewId`, carries `runId`/`nodeId`/`interruptId`/`approvalId`/`status`/`policy`) | **Remains the SSoT.** No new identity. The unifying key is `reviewId`. |
| Decision dispatch (one decision owner) | `routes/reviews.ts` POST action → `resolveAndResume` (interrupt) / `host/approvalDecision.ts` (approval) | **Remains owner.** The global signal is emitted *here*, at the backend decision owner — not at any FE write path. |
| Run interrupt resolve | `resolveAndResume` (`routes/interrupts.ts`) | Remains owner; emits the broadcast signal on success (and on quorum `pending`). |
| Pending-approval resolve | `claimApproval`/`rejectApproval` (`host/approvalDecision.ts`) | Remains owner; emits the broadcast signal on success. |
| Cross-tenant live fanout | Notifications emitter + SSE stream; **broadcast frames (no `recipientUserId`) already reach every tenant member** (ADR 0050, `routes/notifications.ts:100`) | **Reuse.** No second SSE stream. Add a *non-persisted* signal frame so the inbox is not polluted. |
| Client review state | Missing — four independent local states | Add ONE frontend feature-local store (mirrors `notificationStore` zustand), the single client read/subscribe surface. |
| Card extensibility | `chat/registry/` (ADR-documented seam) | Cards read the store via a hook; no registry change. |

This composes from existing primitives. The only genuinely new pieces are (1) a non-persisted broadcast frame on the emitter and (2) the client store — neither is a parallel copy of an existing system.

## Decision

Two additions, one on each side of the wire, both hanging off owners that already exist.

### 1. Backend — emit a non-persisted `review.updated` broadcast at the decision owners

The notifications emitter persists every notification, and a broadcast (no `recipientUserId`) already fans out to all tenant subscribers (ADR 0050). We do **not** want a tenant-wide inbox row per resolution, so add a sibling that fans out **without** inserting storage:

```ts
// notifications/emitter.ts — reuses the same `subscribers` Set + the route's
// tenant/recipient filter; no storage write, so no inbox pollution.
getNotificationEmitter().signal({
  tenantId,
  type: 'review.updated',          // NOT an ACTION_NEEDED type — pure cache hint
  // no recipientUserId ⇒ tenant broadcast (ADR 0050)
  data: { reviewId, runId, nodeId, interruptId, approvalId, status, policy },
});
```

Emit it at the two decision owners, after a successful state transition:

- `resolveAndResume` — on resolve (`status: 'resolved'`) **and** on quorum `pending` (`status: 'pending'` + updated `policy` counts, so other surfaces re-render quorum progress without a full refetch — ADR 0070).
- `claimApproval` / `rejectApproval` — on `approved` / `rejected`.

Because emission is at the decision owner, it is correct **regardless of which FE surface, client, or user** drove the decision. The existing `node.interrupt.resolved` run-event is unchanged and still drives per-run surfaces.

### 2. Frontend — one `reviewStatusStore`, every surface reads/subscribes through it

A feature-local zustand store (mirrors `notifications/notificationStore.ts`), keyed by `reviewId`, that is the single client source of truth for review status:

```ts
useReviewStatus(reviewId): { status, policy, loading }   // one card
useReviewList(filter): ReviewRequest[]                    // the inbox / tab + badge count
reviewStatusStore.decide(reviewId, action, body)          // optimistic → server → reconcile
reviewStatusStore.connect()                               // subscribe to review.updated frames
```

- **Subscribe once, app-wide:** the store consumes `review.updated` frames off the *existing* notifications stream (the connection the notification bell already opens). On a frame it patches/evicts that `reviewId` and recomputes the pending count/badge — no per-surface SSE, no polling.
- **All four surfaces become thin readers.** `ReviewInboxPanel`, the chat `ApprovalCard`, the Runs `ApprovalCard`, and `NeedsYouInbox` read status from the store and render resolved state (read-only `StatusBadge`, actions hidden) the instant a frame arrives.
- **Writes stay where they are.** Cards keep their current client call (`decideReview` for the tab, `resolveByRun` for run-scoped cards that already hold `runId`+`nodeId`). The store wraps the call for an **optimistic** local patch; the authoritative reconcile arrives via the broadcast frame the backend owner emits. We do **not** force all writes onto `decideReview` — that churn buys nothing once the signal is emitted backend-side.
- **Stale-safety:** a 409 (`interrupt_already_resolved`) is treated as success — the review is already resolved; the store reconciles to `resolved` rather than surfacing an error (the ADR 0068 contract).
- **Quorum:** a `pending` frame updates `policy` counts in place; the card stays actionable for other eligible approvers and shows progress.

## Alternatives considered

1. **Dedicated `/v1/host/openwop-app/reviews/stream` SSE.** Rejected as the default: a second always-on global connection to manage (reconnect/backfill/heartbeat) for a signal the notifications stream already fans out tenant-wide. Kept as the documented fallback if review traffic ever needs isolation from notification traffic.
2. **Persisted `review.updated` notification (an inbox row).** Rejected: pollutes every tenant member's bell/inbox and grows storage unbounded. The non-persisted `signal()` frame gives the same fanout with neither cost. (`ACTION_NEEDED_TYPES` would also have to explicitly exclude it.)
3. **Force every FE write through `decideReview` so one route emits the event.** Rejected as unnecessary: the global signal is emitted at the *decision owner* (`resolveAndResume` / `approvalDecision`), which both write paths already funnel through. Routing-all-through-one-client is churn with no correctness gain.
4. **Polling / refetch-on-focus only (no live signal).** Rejected — the user explicitly asked for live, cross-client updates; focus-refetch leaves a co-watcher's card stale until they re-focus.

## Phased implementation plan

| Phase | Scope | Gate |
|---|---|---|
| 1 | `emitter.ts`: add non-persisted `signal()` fanout + `review.updated` type (FE+BE type unions; exclude from `ACTION_NEEDED_TYPES`). | `tsc` + emitter unit test (fans out, no storage write). |
| 2 | Emit `review.updated` at `resolveAndResume` (resolve + quorum-pending) and `claimApproval`/`rejectApproval`. | Backend route test: resolve → a tenant-broadcast frame observed on the stream. |
| 3 | `reviewStatusStore` (zustand) + `useReviewStatus`/`useReviewList` + `connect()` consuming the notifications stream. | `npm run build` (FE gate) + store unit test (frame patches/evicts, count recompute). |
| 4 | Re-point `ReviewInboxPanel`/`ReviewCard` onto the store (drop the mount-once local fetch). | Build + manual: approve in tab → card resolves, badge decrements. |
| 5 | Re-point chat `ApprovalCard` + Runs `ApprovalCard` + `NeedsYouInbox` onto the store. | Build + manual cross-surface: approve on Runs → chat card + tab + inbox update live. |
| 6 | Cross-client manual verification + ADR → `implemented`; record phase→commit table. | Two-browser smoke (DEPLOY-SMOKE-style). |

*(Phases 4–5 are independently shippable: each surface that adopts the store gets live sync incrementally; un-migrated surfaces keep working as today.)*

### Phase → commit (implemented 2026-06-19)

| Phase | Commit | What landed |
|---|---|---|
| 1 | `dbc523ec` | Emitter `signal()` non-persisted fanout + `review.updated` type (BE+FE), shared `buildRecord`/`fanOut`, fanout-without-persistence tests |
| 2 | `7fbd3d62` | `emitReviewUpdatedSignal` at the decision owners — `resolveAndResume` (resolve / quorum-pending / quorum-reject) + `claimApproval`/`rejectApproval` (`announceReview`), all AFTER the durable transition; stream-subscriber route test |
| 3 | `3483ac4b` | `reviewStatusStore` (zustand) + `signalBus` + hooks (`useReviewList`/`useReviewCount`/`useReviewStatus`/`useReviewStatusByRunNode`); store unit test (evict / quorum-patch / optimistic / 409 / ref-count) |
| 4 | `7b0a3793` | Reviews tab + badge re-pointed onto the store (drop mount-once fetch); stale-while-error |
| 5 | `a80f73e1` | In-chat + Runs `ApprovalCard` observe live status (disable stale actions + "resolved elsewhere"); `NeedsYouInbox` refetch-on-signal; `App.tsx` app-wide store connect; `reviewResolvedElsewhere` (en + pt-BR) |

Verification: BE `tsc` clean + 58 review/approval/notification tests; FE `npm run build` (all token/i18n/CSS gates) + 15 review/notification tests.

## Open questions / decisions checklist (resolved)

- [x] **Identity for run-scoped cards.** RESOLVED: the `review.updated` frame carries BOTH the unified `reviewId` AND the `runId`/`nodeId` secondary index. The store keys `statusById` by `reviewId` and exposes `useReviewStatusByRunNode(runId, nodeId)` for the chat/Runs cards (which hold runId+nodeId, not reviewId). No client-side reviewId reconstruction needed.
- [x] **`signal()` vs `emit()` API shape.** RESOLVED: a separate `signal()` method on the emitter — the call sites are semantically "broadcast a transient hint," not "create a notification." Both share `buildRecord`/`fanOut` so they can't drift.
- [x] **Anon / no-tenant clients.** RESOLVED: `signal()` reuses the SAME tenant/recipient filter the notifications stream route already applies (`routes/notifications.ts`) — a frame's `tenantId` is set from the run/approval, and the route drops frames whose `tenantId !==` the subscriber's resolved tenant. No new leak path: the broadcast rides the existing, already-tenant-gated channel. (A subscriber with no resolved tenant gets the same union behavior it already had for notifications.)
- [x] **Backfill on (re)connect.** RESOLVED: `connect()` calls `refresh()` (one `listReviews('pending')`) on the first ref, and `refresh()` re-applies terminal `statusById` overrides so a slightly-stale list can't resurrect an in-flight resolution. Cost is one read on open — the same the inbox already did.
- [x] **`getReview` 404 vs evict.** RESOLVED: patch from the frame — a terminal frame evicts the review from the pending list and records `statusById`; a `pending` frame patches `policy` in place. No extra `getReview` round-trip.
- [x] **Scope of the badge count.** RESOLVED: `ChatSidebar` reads `useReviewCount()` from the store (single source); the old local `reviewCount` state + mount fetch + `onCountChange` plumbing were removed.
- [x] **Test seam.** RESOLVED: Phase 2 has a `createApp` + emitter-subscriber route test (`reviews-route.test.ts`) asserting the broadcast on resolve; Phase 1/3 add emitter + store unit tests.

This ADR is implemented. Correct the record inline (don't rewrite) if later work overturns a decision.

# ADR 0050 — Per-recipient notification targeting (two-channel inbox)

**Status:** implemented (Phases 1–3). Per-user **Web-Push** targeting shipped too:
`push_subscriptions` gained a `user_id` column (sqlite mig 27 / postgres mig 24) so an
addressed notification pushes ONLY to its recipient's devices (legacy null-owner subs
receive broadcasts only). **`recipientRole` (role-addressed broadcast) implemented
2026-06-22** — see § Implementation ledger below.
**Date:** 2026-06-15
**Toggle:** none — extends **core** notification infrastructure (ADR 0010 § Correction
removed the toggle; notifications is core platform, not a feature-package toggle).
**Capability:** no new capability id; host-internal.
**Depends on / composes:** ADR 0010 (Notifications — the surface this extends), ADR 0015
(workspace = tenant — the multi-user reality that makes this necessary), ADR 0006 (RBAC —
recipient must be in-tenant; future `recipientRole`). Prerequisite for ADR 0049 (kanban
card assignment) and any future "addressed to you" notification (approvals-to-initiator,
@mentions).
**Surface:** host-internal — `NotificationRecord`, the emitter, the inbox routes/storage.
No wire change.
**RFC gate:** **NO new RFC** — host-internal product state, no OpenWOP wire surface.

## Why this exists

Today every notification is **tenant-scoped and only tenant-scoped**. `NotificationRecord`
(`types.ts:232-252`) carries `tenantId` with **no recipient field**, and the inbox query
filters by `tenantId` alone (`routes/notifications.ts:100`; `storage.listNotifications`
filter is `{tenantId, status, …}` — `storage/storage.ts:397-406`). Under ADR 0015
(**workspace = tenant**, many users per tenant) this means a notification meant for one
person is **visible to the entire workspace** — and there is no way to deliver "this is
addressed to *you*" at all.

This blocks ADR 0049 (an assignment notification would broadcast to the whole workspace)
and every other per-person signal we will want (an approval waiting on the run's
initiator, an @mention, "your scheduled agent finished"). The fix is small, additive, and
foundational, so it is its own decision rather than a phase buried inside ADR 0049.

## Decision — two channels, one optional field (NOT a user-only refactor)

Add **one optional field**, `recipientUserId?: string`, to `NotificationRecord`. This
creates **two coexisting delivery channels** — we explicitly do **not** make notifications
user-only:

| Channel | `recipientUserId` | Meaning | Examples |
|---|---|---|---|
| **Addressed** | set | "This is yours to act on" — visible to that one user (+ workspace admins). | card assigned to you (ADR 0049); approval/clarification waiting on the run initiator; @mention; "your scheduled run finished". |
| **Broadcast** | absent (`null`) | "The workspace should see this; no single owner." Unchanged from today. | shared run completed/failed; workspace quota/billing/system alert; a shared board changed. |

**Why both, not user-only:** some notifications have **no single owner** — forcing a
recipient onto a quota warning or a shared-run event means inventing one (which of N
members "owns" it?). That artificiality is the tell that broadcast is a genuine, distinct
mode. A user-only refactor would also be *more* work and *lose* a capability: it would
require retrofitting a recipient onto every existing broadcast emit site
(`executor.ts` run events, `suspendManager.ts`, `system.alert`). Additive targeting keeps
the broadcast path working untouched and adds addressed delivery where it is meant.

**Backward-compatible by construction:** every existing notification has no
`recipientUserId`, so it stays broadcast — today's behavior is exactly preserved.

### Inbox visibility rule
A notification is visible to user *U* in tenant *T* iff:

```
n.tenantId === T && (n.recipientUserId === U || n.recipientUserId == null)
```

i.e. **my addressed items + the workspace's broadcast items.** Workspace admins may
additionally view another member's addressed items only through an explicit admin/audit
path (not the default inbox), preserving privacy by default.

### New notification type
Add `'workflow.assigned'` (or the more general `'task.assigned'`) to `NotificationType`
(`types.ts:221`) for ADR 0049 to emit; the enum already tolerates arbitrary strings
(`NotificationType | string`) so this is additive.

## Data model (additive)

```
// types.ts — NotificationRecord
recipientUserId?: string   // NEW. set = addressed to one user; absent = tenant broadcast.

// types.ts — NotificationType (additive member; string union already open)
| 'task.assigned'

// storage/storage.ts — listNotifications filter (additive)
recipientUserId?: string   // when provided, return rows where
                           // recipient_user_id = U OR recipient_user_id IS NULL
```

Storage adapters (`storage/sqlite/schema.ts`, `storage/postgres/schema.ts`) add a nullable
`recipient_user_id` column (no migration of existing rows — NULL = broadcast, the current
semantics). `markAllNotificationsRead` gains an optional recipient scope so "mark all read"
clears *my* inbox view (addressed-to-me + broadcast), not another member's addressed items.

## Phase 3 — role-addressed broadcast (`recipientRole`) — IMPLEMENTED 2026-06-22

Some "broadcast" items really belong to a **role** (billing/quota → admins, not literally
everyone). The additive `recipientRole?: string` is the middle channel between a plain
broadcast and a single-user address.

**Resolution source (the open question, now settled):** **ADR 0006/0015 workspace-root
(tenant) RBAC roles**, resolved at **read time** via `listWorkspacesForSubject(subject)` →
the workspace whose `orgId === tenantId` → its `roles`. A role row is visible iff its
`recipient_role ∈ caller's tenant roles`; an empty role set hides all role rows
(**default-deny**). A row with `recipient_role` set is **never a plain broadcast** — the
leak-safe filter treats `recipient_user_id IS NULL` as a broadcast only when
`recipient_role IS NULL` too.

| Piece | Where |
|---|---|
| `recipientRole` field | `types.ts` `NotificationRecord` |
| `recipient_role` column | sqlite `schema.ts` (`addColumnIfTableExists`) + postgres `schema.ts` (`ADD COLUMN IF NOT EXISTS`) — NULL default → legacy rows stay broadcasts |
| Leak-safe filter | `listNotifications` + `markAllNotificationsRead` in BOTH adapters: `(user=me OR (user IS NULL AND (role IS NULL OR role IN :myRoles)))` |
| Read-time role resolution | `routes/notifications.ts` `callerTenantRoles` → list + mark-all + the SSE stream gate + `assertTenantOwnership` (a role row is mutable only by a holder) |
| Anon SSE hardening | the stream now drops all rows for an unauthenticated (non-wildcard) subscriber — heartbeats only |
| Tests | `notifications.test.ts` — role row visible only to holders (no broadcast leak); mark-all clears a role row only for a holder |

The `recipientRole` channel is now available to any emitter (e.g. billing/quota → `admin`);
existing per-user emitters (kanban/escalation) keep using `recipientUserId`. Finer
per-org role scoping (admin-of-A vs admin-of-B) is a future refinement — v1 matches the
tenant role name, matching the "workspace admins" example.

## Phased plan

- **Phase 1 — type + storage.** Add `recipientUserId?` to `NotificationRecord`; nullable
  `recipient_user_id` column in both adapters; extend the `listNotifications` filter and
  `markAllNotificationsRead` scope. No behavior change yet (all rows NULL).
- **Phase 2 — emitter + inbox.** Emitter passes `recipientUserId` through
  (`notifications/emitter.ts:34`); inbox route applies the visibility rule
  (`routes/notifications.ts`); Web-Push fan-out targets the recipient's subscriptions when
  set (it currently fans out to all tenant subscriptions — `pushNotification`).
- **Phase 3 — frontend.** Inbox already calls the route; no UI shape change. Optionally
  badge "addressed to me" vs "workspace" if product wants the distinction surfaced.

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | N/A — core infra extension (`types.ts`, `notifications/`, `routes/notifications.ts`, storage adapters). |
| 2 | Toggle | None — notifications is core (ADR 0010 § Correction). |
| 3 | Workflow surface | None net-new. |
| 4 | Node pack | None. |
| 5 | AI-chat envelopes | None. |
| 6 | Agent pack | None. |
| 7 | Public surface | None — inbox is auth-scoped. |
| 8 | RBAC + isolation | Recipient must be in-tenant (fail-closed); addressed items private to recipient + admin audit path; tenant isolation unchanged. |
| 9 | Replay / fork | None — product state, not run config. |
| 10 | Frontend | No shape change; optional addressed/broadcast badge. |

## RFC gate

**NO new RFC.** `recipientUserId` is host-internal notification state on the ADR 0010
surface; nothing reaches the OpenWOP wire (no event type, capability flag, or normative
MUST). Inbox routes are non-normative host endpoints.

## Alternatives weighed

- **User-only (drop tenant broadcast).** Rejected — loses a used capability, requires
  retrofitting a recipient onto every broadcast emit site, and has no honest owner for
  shared events.
- **Separate `user_notifications` table.** Rejected — doubles the read path and the
  status-lifecycle/Web-Push machinery for no benefit; one nullable column expresses the
  same thing.
- **Recipient as an array (`recipientUserIds[]`).** Deferred — multi-recipient addressed
  delivery (e.g. role queues) is better modeled by `recipientRole` resolution at read
  time than by fanning out N rows; revisit only if a real fan-out case appears.

## Open questions

- Admin visibility of another member's addressed items — default-hidden here; confirm
  whether an explicit workspace-admin "all notifications" audit view is wanted.
- `recipientRole` resolution source (RBAC roles vs roster roles) — settle when that phase
  is picked up (shared with ADR 0049 D2).

## Phase → commit/test (filled on implementation)

| Phase | Status | Tests |
|---|---|---|
| 1 — type + storage (`types.ts`, sqlite mig 26, postgres mig 23, `storage.ts` filter + markAll scope) | implemented | `test/kanban-assignment-0049.test.ts` (ADR 0050 block); existing `migration-journey` + `storage-adapter-parity` green |
| 2 — emitter + inbox (`emitter.ts`, `routes/notifications.ts` recipientFilter + per-row privacy; Web-Push `user_id` on push subs, sqlite mig 27 / postgres mig 24, `pushSubscriptions.ts` + `webPush.ts`) | implemented | `test/notifications.test.ts` green; addressed/broadcast visibility asserted |
| 3 — frontend | minimal — inbox unchanged (server-filtered); `projectNotification` exposes `recipientUserId` for a future badge | — |

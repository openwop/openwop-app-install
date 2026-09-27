# ADR 0457 — KickTodo respects the shared notification + UX seams (quiet-hours, PageHeader)

| | |
|---|---|
| **Status** | implemented (P1 + P2) — 2026-07-20 |
| **Feature** | EXTENDS `kicktodo-core` / `kicktodo-integrations` / `kicktodo-studio` to consume shared host seams they currently bypass. No new toggle. |
| **Source** | KickTodo leverage map #8 — re-scoped after audit (chat-embed dropped, see correction). |
| **RFC verdict** | Host work, no RFC (consumes existing host seams; no wire). |
| **Composes** | ADR 0214 (notification mute policy), ADR 0073 (the one chat / EmbeddedChatPanel), DESIGN.md (PageHeader) |

## Boundaries audit (verified file:line)

- **The notification emitter does NOT auto-consult quiet-hours — each producer must.** `notifications/emitter.ts:76-158` fans out with zero mute check; `host/notificationPolicy.ts:36` `isNotificationMuted(tenantId, userId, ctx)` is the seam (fail-open), registered by `notifications/preferencesRoutes.ts:149` (quiet-hours + global/per-type/per-conversation mute, `allowUrgent` bypass at `:129`). The reference producer that gates correctly: `host/channelActivityNotify.ts:52` filters recipients via `isNotificationMuted` BEFORE `emitMany` (`:66`).
- **KickTodo reminder producers skip it (the real gap).** `kicktodo-integrations/calendarWriteService.ts:124` `routeReminder()` emits a reminder (`task.assigned`, WhatsApp channel) gated only by `liveConsent` (`:121`) — no mute/quiet-hours check. `kicktodo-core/enrollmentService.ts:293` emits the invite-accepted notification directly. Grep for `isNotificationMuted` across both packages: nothing.
- **PageHeader is shared and KickTodo uses it 0×.** `ui/PageHeader.tsx:28` `{eyebrow?, title, lede?, actions?}` (imported 79× app-wide). KickTodo hand-rolls the same `<header className="page-header">` markup instead: `GuidePage.tsx:35-37`, `PlanPage.tsx:55-56`, `kicktodo-studio/StudioPage.tsx:132-133`; `TodayPage.tsx:147` uses a bespoke greeting header.
- **CORRECTION — the GuidePage chat deep-link is CORRECT, not a gap.** `GuidePage.tsx:16` deep-links `'/?agent=host:kickbot'`; its header comment states "This is a LANDING surface, not a chat." That IS the sanctioned ADR 0073 pattern ("deep-link the main chat"). The map's "could embed EmbeddedChatPanel" is an optional UX choice, **not a fix** — embedding a landing page into a chat panel would be a regression, not leverage. Dropped from scope (recorded as considered-and-declined).

## Decision

Two real fixes; one explicit non-change.

1. **Quiet-hours respect (correctness).** KickTodo notification producers consult `isNotificationMuted` before emitting, mirroring `channelActivityNotify.ts:52`:
   - `calendarWriteService.routeReminder` and the `enrollmentService` invite-accepted emit check the recipient's mute state and skip (or defer) when muted. A genuinely time-critical reminder MAY set `allowUrgent` to ride the quiet-hours bypass — but a routine daily nudge respects the user's quiet hours. This closes a real "the app messaged me at 2am" defect.
2. **PageHeader adoption (consistency).** Replace the hand-rolled `<header className="page-header">` in `GuidePage`, `PlanPage`, and `StudioPage` with `ui/PageHeader`. `TodayPage`'s greeting is an intentional signature variant (ADR 0436 "One Thing" focus) — keep it, optionally feeding its greeting through PageHeader's `eyebrow`/`title` slots if it reads cleanly (a /ux-review call).
3. **Non-change:** GuidePage keeps its deep-link to the one chat (no embed). Documented so a future pass doesn't "fix" it into a second chat surface.

## PRD-vs-architecture corrections
- **Chat-embed removed from scope** (above) — the deep-link is the correct pattern.
- The quiet-hours fix is a **producer-side** obligation (the emitter can't do it — it lacks the per-recipient policy call site); this ADR does not change the emitter.

## Data model
None. Behavioral (mute check) + presentational (PageHeader) changes only.

## Phased plan
| Phase | Ships | Status |
|---|---|---|
| P1 | `routeReminder` (`calendarWriteService.ts`) + invite-accepted emit (`enrollmentService.ts`) consult `isNotificationMuted` before emitting (SKIP when muted — a time-anchored reminder deferred is stale noise, OQ1); tests pin muted-recipient-no-emit for both | ✅ implemented 2026-07-20 (`kicktodo-calendar` + `kicktodo-schedule-mapping` tests) |
| P2 | adopt `ui/PageHeader` in GuidePage/PlanPage/StudioPage; /ux-review | ⏳ pending — overlaps the active `ux-layer` FE teammate's KickTodo scope; deconflict before editing (they were doing a KickTodo FE inventory) |

> **P1 correction (2026-07-20):** the `routeReminder` doc comment previously claimed
> "opt-in/quiet-hours stay [downstream in the whatsapp owner]." That conflated two
> layers: the WhatsApp owner's *channel-delivery windows* vs the user's *app-level*
> notification mute/quiet-hours (`preferencesRoutes`). `getNotificationEmitter().emit`
> also inserts the in-app notification + web-push fan-out, which bypassed the app-level
> mute entirely. P1 adds the `isNotificationMuted` gate (fail-open) so a muted user is
> genuinely not notified; the comment now scopes the downstream claim to channel-delivery.

## Alternatives weighed
- **Make the emitter auto-consult `isNotificationMuted`**: rejected — it lacks the recipient/context call site and would change behavior for every existing producer (some intentionally urgent); the seam is deliberately producer-driven (ADR 0214 D2).
- **Embed EmbeddedChatPanel in GuidePage**: rejected — see correction (deep-link is correct).

## Open questions
- OQ1: muted reminder — SKIP (drop) or DEFER (re-queue past quiet hours)? A calendar reminder is time-anchored → skip is honest (a stale reminder is noise); a streak nudge → defer. Decide per producer in P1.
- OQ2: TodayPage greeting — keep bespoke or route through PageHeader `eyebrow`? Defer to /ux-review in P2.

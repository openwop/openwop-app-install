# ADR 0566 — Notification retention: bounded rows, with unactioned HITL approvals exempt

Status: Proposed
Date: 2026-08-14
Feature: notifications (core, ADR 0010) — data-lifecycle pass
Origin: UX_UPGRADE-inbox IB-SP-14 ("notification rows grow unbounded — GitHub
bounds at 5 months, Linear at 2000"), deferred in R2 with the rule this ADR
formalizes: **"never auto-expire an unactioned HITL approval."**

## Context

Notification rows are written by every feature's emit site and never deleted
except by the user's per-row delete. A long-lived tenant accumulates rows
without bound — a real cost on the primary store AND the reason the >100-row
count-truthfulness regime (IB-SP-6) arrives for every tenant eventually.
Both market anchors bound retention (GitHub 5mo, Linear 2000 rows).

## Boundaries audit

- **Storage**: notifications live in the primary storage adapters
  (`storage.listNotifications`/`updateNotificationStatus`/…), NOT in
  `hostExtPersistence` KV — so the existing `registerKvAgeOut` reaper
  (invitations precedent, `invitationsService.ts:20`) does NOT apply as-is;
  its PATTERN (boot-registered age-out with a TTL + timestamp field) does.
- **HITL linkage**: an approval-bearing notification carries
  `interruptId`/`metadata.approvalId`; the approval's own lifecycle lives in
  the interrupts surface. A notification row is the USER'S POINTER to a
  pending decision — deleting the pointer can orphan a live approval.
- **Emitter**: `notifications/emitter.ts` is the single write door — a
  retention sweep belongs beside it (one owner), never per-feature.

## Decision (proposed)

1. **Policy**: age out notification rows past a retention window (default
   **180 days**, `OPENWOP_NOTIFICATIONS_RETENTION_DAYS`, 0 = disabled), and
   additionally cap per-recipient rows at **2000** (Linear's anchor; oldest
   non-exempt archived/read rows evicted first). Both knobs operator-visible.
2. **The exemption rule (the R2 rule, verbatim)**: a row whose linked HITL
   approval/interrupt is still OPEN is **never** auto-expired — regardless of
   age. Exemption is resolved at sweep time against the interrupts surface
   (read the linked interrupt's state; unresolvable link = NOT exempt after
   the window ×2, so a dangling pointer cannot pin rows forever — the
   double-window grace is the honesty valve, named here deliberately).
3. **Mechanism**: a boot-registered periodic sweep beside the emitter
   (the kvAgeOut pattern applied to the storage adapter; batched deletes,
   per-tenant bounded per pass), with a `notification_retention_swept` log
   line carrying counts (`deleted`, `exempt`, `tenants`).
4. **Order of eviction**: archived → read → unread (an unread row only falls
   to the age window, never the count cap — silence about unseen items is
   worse than an over-long list).

## Alternatives weighed

- **Pure count cap (Linear)** — simple but a burst evicts recent unread rows;
  rejected alone, kept as the secondary bound with the unread carve-out.
- **Pure age window (GitHub)** — unbounded within the window for noisy
  tenants; kept as primary with the count cap as backstop.
- **Archive instead of delete** — retention that never deletes is not
  retention; archived rows are already reachable and count toward growth.
  Rejected.

## Open questions

1. Should per-tenant operators get a knob (per-tenant override) or is the
   host-global envelope enough for v1? (Assume host-global.)
2. Does the erasure/GDPR lane need notification rows in its reachability
   audit regardless of this ADR? (Flag for the LLM-EXCHANGE/erasure steward —
   likely yes, independently.)

## RFC verdict

Host work only — storage lifecycle + boot sweep; nothing on the OpenWOP wire.

## Phased implementation record

| Phase | Scope | Status |
|---|---|---|
| 1 | sweep + age window + exemption rule + log line + tests (incl. the dangling-pointer double-window case) | not started |
| 2 | per-recipient count cap + eviction order tests | not started |

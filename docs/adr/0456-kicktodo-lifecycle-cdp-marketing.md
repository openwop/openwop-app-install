# ADR 0456 — KickTodo lifecycle events → CDP → segments / journeys / email

| | |
|---|---|
| **Status** | implemented (P1 + P2 + P3 + P4) — 2026-07-21 · COMPLETE |
| **Feature** | EXTENDS `kicktodo-core` to emit lifecycle events into the `cdp` collect seam. No new toggle (rides `cdp` + the `kicktodo-core` toggle). |
| **Source** | KickTodo leverage map #7 — the Marketing column dead-ends today. |
| **RFC verdict** | Host work, no RFC (`collectEvent` is a host-ext surface; CDP→segment→journey rides the existing daemon). |
| **Composes** | ADR 0449 (the subject→Contact bridge — the identity + consent tie), ADR 0262/0268 (CDP graduation, Gate 0 consent/identity), CRM segments + journeys |

## Boundaries audit (verified file:line)

- **The CDP collect seam is ready and KickTodo uses it 0×.** `cdp/collectService.ts:38` `collectEvent(tenantId, eventType, payload, dedupeKey?)` → validates, PII-tags (`:63`), stores `cdp:collected-event` (`:26`), deterministic at-most-once via `dedupeKey` (`:50-58`). Today ONLY funnels emit (`funnels/routes.ts:80`, `formsAttributionSink.ts:59`); no KickTodo or commerce caller.
- **The event→segment→journey→email path already runs.** `cdp/segmentEntryDaemon.ts:47` `sweepSegmentEntries` diffs each watched segment and emits `crm.segment.entered{segmentId, contactId}` (`:60`), the type a journey/email workflow binds to; segments resolve from `crm/segmentsService`. Fleet-safe via per-slot `claimIdempotency` (`:53`).
- **CDP is NOT a second identity authority — it resolves through the CRM Contact.** `cdp/identityService.ts:4-6,61` `resolveIdentity` → CRM `GoldenRecord`; the stored event row carries tenant + props + PII tags but **no identity field** (`collectService.ts:15-24`). Identity is joined via the CRM Contact — exactly the `contactId` the ADR 0449 bridge produces (`contactBridgeService.ts:29`, sources `paid-checkout|reminder-consent|leaderboard-optin`, merge-following read `:77-83`).
- **Consent is the CALLER's responsibility (Gate 0).** `collectEvent` does not enforce consent inline; the funnels precedent gates upstream ("callers pass a vk that already passed the consent gate", `funnels/routes.ts:72-73`). CDP governance (purpose/consent labels) is a separate layer (`cdp/purposeLabels.ts`, `routes.ts:173`).

## Decision

Emit **consent-gated** KickTodo lifecycle events into `collectEvent`, keyed to the participant's CRM Contact (via the ADR 0449 bridge), so the existing segment/journey/email machinery can run KickTodo marketing — with **no new identity store and no PII leaving the opaque-subject boundary**.

- **Events** (host-ext types): `kicktodo.participant.enrolled`, `kicktodo.participant.completed`, `kicktodo.participant.stalled` (missed N days), `kicktodo.challenge.purchased`. Payload carries `{ contactId, challengeId, challengeVersion, … non-PII props }` — the `contactId` is resolved host-side via `resolveContactForSubject`; the opaque `ownerSubject` NEVER goes in the payload (ADR 0426).
- **Consent gate (Gate 0):** emit ONLY when `resolveContactForSubject(tenant, subject)` returns a live Contact — i.e. the subject already crossed a consent touchpoint (paid checkout / reminder consent / leaderboard opt-in) that produced the Contact. A subject with no linked Contact produces **no event** (fail-closed, the ADR 0449 D3 privacy floor extended to marketing). This mirrors the funnels "already passed the consent gate" precedent.
- **Downstream is unchanged:** operators build CRM segments over these events (e.g. "stalled in an active challenge"), attach a journey/email — the `segmentEntryDaemon` + journey workflow already deliver. KickTodo ships **no** new segment/journey/email code.
- **Dedupe:** each lifecycle transition emits with a deterministic `dedupeKey` (`${subject}:${challengeId}:${event}:${version}`) so retries/replays don't double-count.

## PRD-vs-architecture corrections
- **No KickTodo-owned identity or email.** The map said "lifecycle → CDP → email"; the honest architecture is KickTodo only *emits* consent-gated events tied to the CRM Contact — CRM/CDP own identity, segments, journeys, and the send. KickTodo must not resolve emails or send mail (that would fork the marketing engine).
- **Depends on ADR 0449 being live** (the bridge is the consent+identity tie). Without a linked Contact there is deliberately no marketing signal — this is a feature (privacy floor), not a gap.

## Data model
No new store. New host-ext event TYPES registered with the CDP schema (so `validateEvent` + PII-tagging apply). Emission call sites in `kicktodo-core` enrollment/progress/completion + `kicktodo-commerce` purchase, each behind `resolveContactForSubject`.

## Phased plan
| Phase | Ships | Gate |
|---|---|---|
| P1 | ✅ **implemented 2026-07-20** — `kicktodo-core/lifecycleEvents.ts` `emitKicktodoLifecycle(tenant, subject, event, props)`: resolves the Contact via the ADR 0449 bridge and NO-OPs when absent (Gate 0); payload = `{ contactId, challengeId?, challengeVersion? }` — opaque subject NEVER emitted; deterministic `dedupeKey` per transition; best-effort. `test/kicktodo-lifecycle-cdp.test.ts` green (no-Contact ⇒ no event, contactId-keyed, subject not in payload, dedupe). | /architect on consent gate + PII boundary |

> **P1 correction (2026-07-20):** the gate wording said "register the 4 event schemas."
> `registerEventSchema` mints a NEW VERSION on every call (not idempotent), so it must
> NOT run on the emit path — and PII tagging (`tagPiiFields`) + acceptance both happen
> WITHOUT a registered schema. The helper's payload is closed-world (constructed from
> typed args), so schema validation would only re-check the helper's own construction.
> Schema registration is therefore **deferred** to a seed/operator step with an
> idempotency guard (`registerEventSchema` only when `validateEvent().hasSchema` is
> false) — not a per-emit concern. Events emit as unregistered types (accepted; PII-tagged).
| P2 | ✅ **implemented 2026-07-20** — wired 3 of 4 emissions: `enrolled` (`enrollmentService.enroll` end), `completed` (`todayService.submitCheckIn`, only on a NEW activity completion that finishes the challenge — `progressFor` completedActivities≥total), `purchased` (`entitlementService.reprocessOrder` grant path — dedupe keeps the idempotent repair-sweep from re-emitting). All consent-gated (no-op without a linked Contact) + best-effort. `test/kicktodo-lifecycle-wiring.test.ts` green (enrolled/completed/purchased fire for a consented subject, nothing for an unlinked one). ✅ **`stalled` implemented 2026-07-20** — emitted in `applyMissedWindowPolicy` (`todayService`) when a participant goes past `COLLAPSE_CAP_DAYS` (the plan stopped working = off-track), the existing missed-window detection point (ADR 0429). Consent-gated + deduped; test in `kicktodo-plan-flexibility.test.ts`. **All 4 lifecycle events now wired.** | P1 |
| P3 | ✅ **implemented 2026-07-20** — the operator playbook (`docs/kicktodo-marketing-commerce-playbook.md` §2): the "re-engage stalled" recipe (CRM segment over `kicktodo.participant.stalled` → journey/email via `segmentEntryDaemon`) + the completed/purchased/enrolled segment recipes + the consent/PII/purpose guardrails. No engine code — the deliverable is the operator recipe (no template-registration mechanism exists; the segment/journey are operator-created data). |
| P4 (node pack) | ✅ **implemented 2026-07-21** — `feature.kicktodo.nodes.lifecycle-status` (pack v1.15.0, role:read): a lightweight lifecycle read for automation authors — enrolled + state + progress (completedActivities/total) + completed, found by (ownerSubject, challengeId), WITHOUT the heavyweight freeze/judge of `evaluate-progress`. New `ctx.features.kicktodo-core.lifecycleStatus` surface method; `index.mjs` handler + manifest (parity green); 7 `requiredPacks` repinned 1.14.0→1.15.0. Agent-pack: none. |

## Alternatives weighed
- **KickTodo emits directly to CRM segments/journeys**: rejected — bypasses the CDP collect+governance seam (schema validation, PII tagging, purpose labels); the funnels precedent shows `collectEvent` is the front door.
- **Emit for all participants (identity-resolve later)**: rejected — violates Gate 0 / ADR 0426; only consented (Contact-linked) subjects generate marketing signal.

## Open questions
- OQ1: "stalled" definition — N missed days is a rhythm concept (ADR 0443); does the rhythm job emit, or does a CDP-side derived segment compute it from `enrolled`+activity events? Prefer the rhythm job emits an explicit `stalled` event (simpler, deterministic).
- OQ2: purpose label for these events (ADR 0268) — `marketing` vs `product-analytics`? They serve journeys/email → `marketing` purpose; confirm the consent that produced the Contact covers a marketing purpose, else emit under analytics-only.
- OQ3: retention of KickTodo lifecycle events (unbounded `cdp:collected-event` growth) — confirm the CDP retention/TTL policy covers these types (ADR 0380 size-retention).

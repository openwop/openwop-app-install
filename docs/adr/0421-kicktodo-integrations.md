# ADR 0421 — `kicktodo-integrations`: calendar, wearable evidence, and messaging reminders as Connections

Status: **implemented with an INERT lane** (P1–P5 2026-07-18; **corrected 2026-07-19** — see the P2 correction note)

**Requirements source:** `docs/kicktodo-prd.md` §8.1 (Integrations row), §12 Wave 4, §13 Scheduling/notification; the F3 gate in `docs/kicktodo-implementation-plan.md`.
**Depends on:** ADR 0414 (occurrences/check-ins are what integrations project/import), Connections (ADR 0024; RFC 0095 connection packs), notifications (ADR 0010), WhatsApp (ADR 0394 — the EXISTING messaging channel), scheduler (RFC 0052), consent.
**Surface:** host-extension. **NO new RFC** (rides the Accepted RFC 0095 connection-pack contract).

## Why this exists

Wave 4 extends the loop beyond the app: today's actions appear on the participant's calendar, wearable data can serve as check-in evidence, and reminders can arrive over messaging channels — each ONLY as an explicit, consented Connection with host-side credentials, SSRF/egress controls, and replay-safe writes (the PRD's Wave-4 exit gate, verbatim).

## Boundaries audit (Step 3 — verified against live code)

- **Connections is the single credential owner** (ADR 0024; BYOK refs, never plaintext): every integration here is a Connection; this feature stores CONNECTION REFS + per-enrollment consent records, never tokens.
- **Messaging already exists:** the `whatsapp` feature (ADR 0394) is the official BSP channel with live-connection requirements and opt-in semantics — Wave-4 "WhatsApp reminders" **extend that owner** with a KickTodo notification category; no second messaging integration. (Its seed-coverage ACK already documents the live-connection posture.)
- **Notification policy is centralized:** quiet hours/preferences/delivery ride the notifications owner; this feature only adds channel routing preferences per category (PRD §13: "quiet hours and per-category preferences are enforced server-side before push delivery").
- **Egress:** all outbound calendar/wearable calls ride `guardedEgressFetch` (ADR 0405) or the provider SDK surface the Connections feature already brokers — no raw fetch (the KTC-1 lesson, generalized).
- **No existing `/kicktodo/integrations` registrant**; route table joins the collision union.

## Decision + data model

New feature package `src/features/kicktodo-integrations/`:

```text
IntegrationConsent
  tenantId, ownerSubject, enrollmentId?
  kind: calendar-project|calendar-write|wearable-evidence|messaging-reminders
  connectionId                  // the Connections owner's ref
  scopes[] (provider-scoped, minimal), grantedAt, revokedAt?

CalendarProjection              // read-only ICS/feed lane (P1)
  tenantId, ownerSubject, feedToken (hashed at rest), enrollmentIds[]|all

WearableEvidenceRule            // P3 — evidence import mapping
  tenantId, enrollmentId, stableActivityId
  metric (e.g. steps|active-minutes), threshold, source connectionId
```

**Lanes (each independently consented, narrowest first):**
- **Calendar projection (P1):** a tokenized read-only feed (ICS) of the participant's occurrences — no provider write scope at all; the token is capability-style (hashed at rest, revocable, uniform 404). Public path via `PUBLIC_PATH_PREFIXES`, tenant derived from the token.
- **Calendar write (P2):** per-enrollment event creation through a calendar Connection; **replay-safe**: deterministic external-event idempotency keys `(enrollmentId, occurrenceDate, activityId)` — a replayed/re-fired materialization updates, never duplicates; deletion on supersession follows the plan-revision cascade.
- **Wearable evidence (P3):** a metric-threshold rule maps imported values to a check-in for a specific activity — the check-in stays the evidence owner (idempotent: recorded evidence wins, exactly the ADR 0414 rule); raw provider payloads are not retained beyond the mapped value + provenance ref.
- **Messaging reminders (P4):** a notification-category channel preference routing KickTodo nudges through the EXISTING WhatsApp owner (and future channels), consent + quiet-hours enforced by the notifications owner before delivery.

## Phased plan

| Phase | Ships |
|---|---|
| **P1** | Package + consent CRUD + the calendar FEED lane (tokenized ICS; hashed tokens; revocation; public-prefix entry + uniform 404 + rate limits). |
| **P2** | Calendar WRITE lane via a calendar connection pack (RFC 0095): deterministic idempotency keys; supersession-driven deletes; egress via the guarded seam; DST/timezone tests (the enrollment timezone is truth). |
| **P3** | Wearable evidence rules + import mapping → idempotent check-ins with provenance; per-metric consent granularity. |
| **P4** | Messaging-reminder routing through the whatsapp owner (category preference + consent record here; policy/delivery there). |
| **P5 (core-app extension surface)** | `ctx.features.kicktodo-integrations` (read: consent state; the calendar-write op for the daily-loop workflow); node additions; LLM-EXCHANGE row. |

## Implementation record (phase → PR)

| Phase | Landed |
|---|---|
| P1 — consent CRUD (revocable, kind-scoped) + the tokenized read-only ICS feed (raw token minted ONCE, stored sha256-hashed, resolved by hash; `/public/kicktodo/feed/:token` on `PUBLIC_PATH_PREFIXES` with tenant-from-token; titles + day numbers ONLY — instructions never leak, test-pinned; consent revocation kills every live token immediately) | kicktodo/0421-p1p3 |
| P3 — wearable evidence (metric-threshold rules owner-scoped to an enrollment; consent-gated ingest converts today's matching occurrence into an IDEMPOTENT check-in carrying mapped value + provenance only — recorded evidence wins, test-pinned; below-threshold converts nothing) | kicktodo/0421-p1p3 |
| P2 — calendar WRITE lane: consent-gated `syncEnrollmentCalendar` behind a REGISTERED transport port (production = the RFC 0095 connection-pack transport, egress-guarded there; absent transport fails CLOSED); deterministic external ids `(enrollmentId\|dateLocal\|activityId)` — a re-fired sync UPDATES, never duplicates (test-pinned); a written-event ledger drives supersession DELETES (the ADR 0414 cascade extended outward); cross-owner sync uniformly denied | kicktodo/0421-final |
| P4 — messaging reminders: `routeReminder` emits through the CENTRALIZED notification owner ONLY under live `messaging-reminders` consent, channel-tagged (`metadata.channel: whatsapp`, `category: kicktodo-reminder`) for the ADR 0394 owner to deliver; policy/quiet-hours/opt-in stay with the owning features; content is the action title only | kicktodo/0421-final |
| P5 — `ctx.features.kicktodo-integrations` surface (consent reads + the calendar-sync op) + the `feature.kicktodo.nodes.calendar-sync` node; pack **v1.5.0** with pin lockstep across kicktodo-core / kicktodo-creator / kicktodo-accountability (parity-test-enforced) | kicktodo/0421-final |

## Post-merge review record (architect + code-review + ux-review)

The /architect + /code-review + /ux-review ritual ran against the merged P1–P5
surface (2026-07-18). Findings and dispositions:

- **HIGH (fixed):** the public ICS feed kept serving after the tenant toggle was
  turned OFF — minting was gated but `renderFeed` never re-checked, so the
  operator kill-switch failed OPEN for already-minted feeds. Fixed: `renderFeed`
  resolves the toggle for the TOKEN's tenant and throws the uniform denial when
  disabled; test-pinned (toggle OFF → 404, re-enable → serves again).
- **MEDIUM (documented):** `revokeConsent`'s token-kill loop is a full-collection
  scan (the feed store is keyed by token hash — no prefix scan possible).
  Accepted: revocation is rare AND correctness never depends on it (`renderFeed`
  re-checks live consent per request); the invariant is now stated in code so a
  hot-path caller can't inherit it silently.
- **LOW (noted):** a foreign enrollment surfaces from `syncEnrollmentCalendar`
  as the transport-unavailable error — uniform failure (enumeration-resistant),
  message mildly misleading; acceptable.
- **ux-review:** no mode matched (backend-only delta); the ADR-0419 Circles UI
  was reviewed in its own phase.

## Feature matrix

1. Package ✔. 2. Toggle `kicktodo-integrations`, **OFF**, `bucketUnit: tenant`. 3. Workflow surface: P5 (consent reads + calendar-write op). 4. Node pack: extends `feature.kicktodo.nodes` (calendar-sync node for the daily loop). 5. Envelopes: none. 6. Agent pack: none (integrations are not an agent surface; KickBot READS consent state via the existing kicktodo tools). 7. Public surface: the ICS feed only — tokenized, hashed at rest, tenant-from-token, uniform 404, rate-limited. 8. RBAC: consents are owner-subject-scoped (uniform 404); provider scopes minimal and displayed at consent time; automated runs without an acting user FAIL CLOSED on personal connections (PRD §13, the existing connections posture). 9. Replay/fork: external writes carry deterministic idempotency keys; a replay/fork never re-sends a reminder or duplicates a calendar event (PRD §8.7). 10. Frontend: a Connections-composed settings slice (per-lane consent toggles + scope display) + feed-URL management; i18n ×4.

## Alternatives weighed

- **Direct provider SDKs inside this feature** — rejected: Connections owns credentials/brokering (ADR 0024); this feature owns only consent + mapping.
- **A KickTodo push/messaging channel** — rejected: ADR 0394's owner exists; a second WhatsApp integration would be the classic parallel-surface failure.
- **Skipping the read-only feed lane** — rejected: it delivers calendar value with ZERO provider write scope — the narrowest-consent-first order is the PRD's trust posture.

## PRD-vs-architecture corrections

- The PRD's "wearable evidence imports" are scoped to metric-threshold → check-in mapping (evidence stays in the check-in owner); continuous health-data sync/storage is explicitly out of scope (privacy floor + the PRD's own narrow-scope language).
- Native-app calendar/wearable capabilities (ADR 0413 E-stream) are CLIENTS of these host lanes, not separate integrations.

## Open questions

1. First calendar provider (Google vs CalDAV-generic) — recommend whichever connection pack ships first as an RFC 0095 pack; the lane is provider-agnostic by construction.
2. Wearable provider set + metric vocabulary (steps/active-minutes/sleep?) — Wave-4 product decision; the rule model is metric-string + threshold to avoid premature enum lock.
3. ICS feed content granularity (titles only vs instructions) — recommend titles + day numbers only (calendar entries are semi-public on shared calendars).

## RFC verdict

**Host work, no new RFC.** Calendar/wearable/messaging integrations ride the Accepted RFC 0095 connection-pack contract and existing owners (Connections, notifications, whatsapp). Nothing new is advertised on the wire; provider capabilities are honesty-gated on a live configured connection.

## Correction note — P2 calendar WRITE is BUILT but INERT (2026-07-19, KTFULL-B20)

The implementation record called the calendar write lane "implemented". That
overstates it. The lane's logic, idempotency, supersession cascade and
fail-closed posture are real and tested — but **no production boot registers a
`CalendarTransport`**; registrations exist only in tests
(`calendarWriteService.ts` `registerCalendarTransport`, `feature.ts` has no
call). In production `syncEnrollmentCalendar` therefore always throws
`CalendarUnavailableError`.

That is honest at RUNTIME (it fails closed rather than pretending to write),
but the ADR text was not honest about it. Corrected here rather than silently:

- **What exists:** the write lane, its deterministic external ids, the
  supersession delete cascade, the consent gate, and the transport PORT.
- **What does not:** any concrete transport. Wiring one requires an RFC 0095
  calendar connection pack, which is not built — the ADR's own open question 1
  ("first calendar provider") was never answered.
- **Consequence:** the Wave-4 exit gate is NOT met by this ADR alone. Treat
  calendar write as a port awaiting its adapter, not a shipped integration.

## Correction note — the calendar-write lane is now IGNITABLE (2026-07-22, chat-first-port G5)

The KTFULL-B20 note (transport built but inert) was resolved for the *transport*
by ADR 0466 (a concrete REST adapter + Google Calendar MCP adapter, both
honesty-gated). But a second gap remained: even with a transport, **nothing ever
created a calendar-sync run** — `syncEnrollmentCalendar` / the `calendar-sync`
node had no igniter, and integration setup was REST-only with no chat visibility.
Closed here:

- **Ignition = an opt-in per-enrollment SCHEDULE BINDING.** New builtin workflow
  `openwop-app.kicktodo.calendar-sync` (registered on
  `kicktodoIntegrationsFeature.builtinWorkflows`, composing the shared
  `feature.kicktodo.nodes.calendar-sync` adapter). `calendarSyncService.setCalendarSyncEnabled`
  arms/disarms a deterministic per-enrollment job (mirrors the reminder-loop
  binding), fired daily in the enrollment's timezone. A REST write with the
  acting human (`POST …/kicktodo/integrations/calendar-sync/schedule`) — setup
  opt-ins stay route-level, never a chat tool. Multiply gated so NOTHING syncs by
  default: owner-checked, refuses to arm without a live `calendar-write` consent
  or a configured transport (the lane still ships gated-off), and the fired run's
  node fails closed on a later consent-revoke / transport removal.
- **Chat visibility = the `openwop:kicktodo.integrations-status` READ tool** (own
  consents + linked wearables + calendar-transport readiness; acting-user-only,
  fails empty without a human principal, honest-empty when the toggle is off).
  On KickBot's read allowlist so the guide can honestly answer "is my
  calendar/wearable connected?". No WRITE tool was added — consent grants /
  wearable links / feed mints stay REST with the acting human (the accountability
  precedent). Tests: `test/kicktodo-integrations-agent-tools.test.ts`.

# ADR 0444 — KickTodo invite & coached-session loops ("challenge a friend" + the coach session ritual)

| | |
|---|---|
| **Status** | Implemented — 2026-07-20 |
| **Feature** | EXTENDS `kicktodo-core` (invite links) + `kicktodo-accountability`/`kicktodo-commerce` (coached sessions). **No new toggle, no new package.** |
| **Source** | `docs/kicktodo-original-intent-coverage.md` §5 gaps **4, 5** (business plan "challenge a friend"/"tell your friends"; deck slides 7–8: coach-led daily live chats, seat-limited premium groups) |
| **RFC verdict** | **Host work, no RFC.** Invite links are a non-normative public host-ext surface (mirrors the ADR 0421 feed-token pattern); sessions compose existing host primitives. Nothing on the wire. |
| **Composes** | ADR 0414 (`kicktodo-core` catalog/enroll), ADR 0419 (circles — the consent law), ADR 0431 (cohort seats — capacity/holds), ADR 0421 (notification/reminder consent), ADR 0442 (KickBot), platform `scheduled-agent-chats` + the ONE chat (ADR 0005/0058/0073), ADR 0426 (community moderation — abuse surface) |

## 1. Why this exists

The original's growth loop was social: *"challenge a friend"*, *"tell your
friends"*, and the premium ritual of a coach leading a seat-limited group through
**daily live chats at a prearranged time** (deck slide 8). The implementation has
the heavyweight halves — consent-scoped circles and capacity-guarded cohort seats
— but no lightweight *join-me* invite, and the coach-session ritual is
uncomposed: seats know *who*, scheduled chats know *when*, the chat knows *where*,
and nothing joins them.

## 2. Boundaries audit (verified 2026-07-20)

- **Public tokenized precedent exists** — `/public/kicktodo/feed`
  (`PUBLIC_PATH_PREFIXES` in `middleware/auth.ts:150`; token store hash-keyed with
  tenant IN CONTENT — purge-safe per the KTD-1 finding). Invite links mirror this
  exactly; no second public-auth pattern.
- **Enrollment attribution needs no new store** — an optional field on
  `ChallengeEnrollment` (the ADR 0429/0443 point-write pattern).
- **Seats are owned by `kicktodo-commerce`/`kicktodo-seats`** (capacity, holds,
  reconcile — KTFULL-B12); sessions must READ seat membership, never re-model it.
- **The ONE chat law (CLAUDE.md):** any "live chat" ritual MUST be a conversation
  in the existing chat (deep-link / scoped conversation) — a bespoke session chat
  panel is the forbidden recreate. `scheduled-agent-chats` already schedules
  agent-led conversations.
- **Circles own disclosure consent** (ADR 0419) — session participation reveals
  presence to the cohort; that disclosure must be stated at purchase (seat
  product), not silently implied.

## 3. Decision

### D1 — "Challenge a friend" invite links (gap 4)
- **Mint:** `POST …/kicktodo/challenges/:id/invites` (authed participant/creator)
  → a capability token (hash-keyed row: tenant, challengeId, inviterSubject,
  optional expiry/max-uses IN CONTENT). One row per (inviter, challenge) — CAS,
  re-mint returns the same live token.
- **Land:** `GET /public/kicktodo/invite/:token` → uniform-404, rate-limited,
  published-challenge-only redirect payload `{ challengeId, inviterDisplay }` →
  the SPA lands on **Challenge Detail** (the ADR 0436 commitment preview — an
  invite never skips the preview) with "«name» invited you" framing.
- **Attribution:** enrolling from an invite stamps `invitedBy?: subject` on the
  enrollment (analytics + the inviter's "joined you" notification via the
  existing emit seam). **An invite grants NOTHING else** — no scopes, no circle
  membership; a circle invite remains the explicit ADR 0419 consent flow.
- **Abuse:** invite tokens are revocable by the inviter; catalog-published-only;
  per-IP + per-inviter mint caps; uniform 404 on revoked/unknown.

### D2 — Coach session ritual (gap 5)
A **session** = a scheduled, seat-scoped conversation:
- `cohort-sessions` rows owned by `kicktodo-accountability` (`${tenant}::${cohortId}
  ::${sessionNo}`): schedule (recurrence in the coach's tz), the backing
  **conversation id** in the ONE chat, state (`scheduled|live|ended`).
- **Membership = seat truth:** joining the session conversation requires an
  active seat (read from `kicktodo-commerce`, never copied).
- **Ritual mechanics:** reminder at T-minus via the consent-gated reminder seam;
  the session conversation is created scoped to the cohort (participants +
  coach); KickBot may co-host via `scheduled-agent-chats` (recap, roll-call,
  today's-action framing) — an agent in the SAME conversation, not a second bot
  surface. Coach = the challenge author/cohort owner (ADR 0431's operator).
- **Disclosure:** the seat product's commitment preview states that sessions
  reveal your presence + messages to the cohort (the ADR 0419 honesty law
  applied at purchase time).

## 4. Feature-evaluation matrix (deltas only)

| Dim | Decision |
|---|---|
| Package/toggle | Extends `kicktodo-core` (D1) + `kicktodo-accountability` (D2); toggles stable |
| Workflow surface | `ctx['kicktodo-accountability']` gains `listSessions`/`scheduleSession` (coach-gated) |
| Node pack | `feature.kicktodo.nodes`: `session-schedule` + `invite-mint` nodes |
| Agent | KickBot co-host prompt addition to `feature.kicktodo.agents` (no new agent) |
| Public | ONE new prefix `/public/kicktodo/invite` (mirrors feed: uniform 404, rate-limit, tenant-from-token) |
| RBAC | Mint = authed member; revoke = inviter; session schedule = cohort owner/coach; join = live seat; all fail-closed |
| Replay | Session/conversation ids durable on the row; invite tokens random-minted at REST time (not in-run) — no replay surface |
| Frontend | Invite button on Challenge Detail + "invited you" landing framing; Sessions card on the circle/cohort surface; 4-locale |

## 5. Phased plan

| Phase | Ships | Gate |
|---|---|---|
| I1 | Invite mint/revoke + public landing + Detail framing + attribution stamp | — |
| I2 | Inviter notification + Discover "invited" affordance | I1 |
| S1 | `cohort-sessions` rows + schedule + seat-gated conversation creation | /architect on the conversation-scoping seam before build |
| S2 | Reminders + KickBot co-host + session state on the cohort surface | S1 |

## 6. Alternatives, corrections, open questions

- **Correction to the original:** Facebook-native sharing stays dropped
  (coverage doc §4); the invite link is the consent-clean remnant — it shares a
  *challenge*, never the inviter's activity.
- **Alternative (rejected):** modeling sessions as calendar events only — loses
  the seat-gated conversation, which IS the ritual; the calendar entry is a
  projection (ICS feed already exists).
- **OQ1:** do sessions belong on the ADR 0431 seat product as a variant flag
  (`withSessions`) or on every cohort? Leaning product-flag (premium framing per
  the deck). — decide at S1's architect gate.
- **OQ2:** human-coach video/audio is OUT of scope (the chat is text + existing
  platform voice surfaces); recorded honestly as a non-goal.

## 7. Implementation record (2026-07-20)

| Phase | Shipped | PR |
|---|---|---|
| I1 invites | `inviteService` (tokenHash-keyed, re-mint revokes, tenant-checked resolve) + enroll-time `inviteAttribution` (self/invalid ⇒ no stamp) + ?invite= landing framing + copy-link CTA | #2250 |
| I2 inviter notification | Content-minimal notify via the ONE emitter after `kicktodo_enrolled` (never leaks joiner identity) | #2250 |
| S1 cohort sessions | `sessionService`: sessions on the circle's EXISTING conversation (ONE chat), coach=owner, membership=`getCircleFor`, deterministic `${t}::${circleId}::${atIso}` key + CirclesPage sessions card (join deep-links `/?conversation=`) | #2251 |
| S2 reminders | Live grantees notified content-minimally on schedule | #2251 |

Corrections vs the proposal: invite mint/revoke routes live under
`/kicktodo/invites` (NOT `/challenges/*` — the adversarial authz canon:
all `/challenges/*` POSTs are authoring-gated); the public invite landing
endpoint was deferred (no consumer; less public surface). KickBot session
co-host via `scheduled-agent-chats` DEFERRED: that seam requires an
org/channel-scoped conversation (ADR 0202 D3) and the circle's is a
private group — not force-fit.

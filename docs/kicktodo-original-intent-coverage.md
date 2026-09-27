# KickTodo — Original-Intent Coverage Analysis

> Sources: `KickTodo: Architectural Description` (AI-generated, Flutter/Firebase era),
> `kicktodo Business Plan` (kicktodo.com LLC plan), `Project Kickbot by Kicktodo`
> (16-slide concept deck, "DO"/"GROW" branding era). Compared against the shipped
> implementation on openwop-app (ADRs 0412–0441, the `kicktodo-*` feature packages,
> and the 0436/0437/0438 experience layer), 2026-07-20. Mobile is **React Native**
> (ADR 0413), not the originally-planned Flutter.

---

## 1. What the original artifacts actually promise

Stripped of era-specific tech (Flutter, Firebase, Facebook), the three artifacts
converge on **one product thesis and four pillars**:

> **Thesis (Business Plan):** *"life-hack meets life-coach"* — expert-authored
> **Challenges** = a series of daily achievable activities, one per day, in a
> timeframe, that build on each other. Mark today's assignment **Done**; track
> completion.

| Pillar | Original expression |
|---|---|
| **P1 — Expert daily-challenge content** | Challenges by category (health, fitness, finance, business, leadership, personal development, spiritual); daily "Lessons"/activities; templates as the accessible entry; content depth levels (Beginner/Intermediate/Advanced); calls-to-action (up to 3/day: personal, community, social) |
| **P2 — Fit-to-need accountability** (the self-declared *"secret sauce"*) | Personal (self check-off) → Peer (friends/groups see each other's progress) → Coach (author-led, seat-limited, premium, daily live chats); "challenge a friend", accountability partner/group, hire a coach |
| **P3 — AI coach "Kickbot"** | Conversational, personalized, per-challenge activation ($3/mo premium); tracks progress, celebrates milestones, answers questions, sends reminders/encouragement; positive, **never guilt-tripping** tone; Snooze pauses everything |
| **P4 — Creator economy + monetization** | Free (ads) / $3 subscription / paid 99¢–$29 / coached group $69–$129 / corporate branded portals $599–$3,000-yr; **authors get a revenue share**; author product store (store.kicktodo.com) |

Supporting UX intent: goals dashboard with progress; flexible scheduling
(morning/afternoon/evening, weekdays-only, specific days); calendar view across
challenges with checkboxes; streaks, badges, points, opt-in leaderboard; journaling
per activity; reminders + app badge; mood tracker (recommended); social sharing as
viral loop; **omni-channel continuity** (web, iOS/Android, watch, voice assistants —
"pick up where you left off").

---

## 2. Coverage verdict — pillar by pillar

Legend: ✅ covered (often exceeded) · ◑ partially covered · ❌ not covered
(deliberate or gap). Every claim cites the owning package/ADR (verified in source,
not from the docs).

### P1 — Expert daily-challenge content: ✅ covered, substantially exceeded

| Original | Current | Verdict |
|---|---|---|
| Challenge = daily activities in a timeframe, mark Done, track % | `kicktodo-core`: versioned immutable challenges, enrollment pins a version, daily occurrence materialization, check-ins, progress views (ADR 0414) | ✅ |
| Templates / catalog by category | Discover catalog + Challenge Detail **commitment preview** (ADR 0436 §5.4 — enroll only after seeing what you commit to) | ✅ improved |
| Expert-produced content | **Challenge Factory** (ADR 0415/0437): research → evidence graph → plan → decomposition → gates → **signed immutable release**, with fail-closed stub/claims/rights gates | ✅ far exceeded — the original said "produced by experts"; the current system *proves* research provenance |
| Mark "Done" | Evidence-policy check-ins: attestation / note / photo / **measurement** (KTFULL-B6) — Done can carry proof | ✅ exceeded |
| Content depth levels (Beginner/Int/Adv) | Not modeled (verified: no difficulty/depth field on `ChallengeDefinition`) | ❌ gap |
| Calls-to-action — 3/day: personal + community + social | One action per occurrence with evidence; **substitution alternatives** (ADR 0429) but no community/social CTA lanes | ◑ |
| Multilingual reach (implied by founder's pt-BR bio) | 4-locale content + UI (en/es/fr/pt-BR, ADR 0430 content-locale negotiation) | ✅ beyond original |

### P2 — Fit-to-need accountability: ✅ covered, with a privacy-first redesign

| Original | Current | Verdict |
|---|---|---|
| Personal accountability | Today loop + honest Progress (recovery-framed, never guilt) — ADR 0436 §5.6 | ✅ |
| Peer/group — see each other's progress | **Circles** (`kicktodo-accountability`): consent-scoped grants with an explicit **privacy preview** of exactly what each scope reveals; projected feed; instant revoke; nudges | ✅ redesigned — the original assumed friends just *see* your progress; the current one makes disclosure *consensual and legible* (a genuine improvement, and the consent copy is grade-verified honest) |
| Coach-led group, seat-limited, premium | **Cohort seats** (`kicktodo-commerce`/`kicktodo-seats`, ADR 0431): capacity, holds, seat reconciliation; coach-plan-proposal scope in circles | ✅ (structure) / ◑ the *daily live-chat with the coach* ritual isn't a first-class surface |
| "Challenge a friend" viral invite | Circle invites exist; no lightweight one-tap "challenge a friend" share loop | ◑ |
| Group chat per daily activity | Circles nudges + the platform's ONE chat; no per-activity group thread | ◑ |
| Leaderboard for instant feedback | Opt-in leaderboard + stats (`kicktodo-engagement`, consent-first, recompute-from-source) | ✅ improved (opt-in, not forced) |

### P3 — AI coach "Kickbot": ✅ covered, architecture far beyond the original

| Original | Current | Verdict |
|---|---|---|
| Conversational personal coach | **KickBot is real**: `host:kickbot` agent through the app's ONE chat (ADR 0058 pattern); Guide destination (ADR 0436 §5.8) is the named-relationship landing with AI disclosure | ✅ |
| Tracks progress, answers questions | Agent tools over the kicktodo surfaces; specialist agents (plan-builder, safety-reviewer, sim personas) for the creator side | ✅ exceeded |
| Reminders + encouragement | Daily loop scheduling (per-fire seeded inputs, #2218) + consent-gated reminder routing (`routeReminder`, WhatsApp BSP-only lane, quiet hours at platform) | ✅ |
| Never guilt-trip; Snooze | **Snooze is a first-class enrollment state** (`snoozed`, kicktodo-core) + Today-page recovery framing; the 0436 design law is explicitly recovery-not-failure | ✅ — the original's *tone* intent became design **law** |
| $3/mo per-challenge AI activation | Morphed: AI rides platform BYOK/billing + paid feature bundles (ADR 0419), not per-challenge $3 add-on | ◑ deliberate re-model (see §4) |

### P4 — Creator economy + monetization: ◑ structurally complete, commercially dormant

| Original | Current | Verdict |
|---|---|---|
| Paid challenges (99¢–$29) | Challenge↔product links → platform orders → **entitlements** with paid-observer CAS fulfilment + operator reconciliation (KTFULL-B13) | ✅ structure; **no prices set, toggles OFF** |
| Coached group premium ($69–$129) | Cohort seat products (capacity-guarded holds) | ✅ structure |
| Author revenue share | Creator **insights**: per-product entitlement counts (`revenueProjectionFor`, ADR 0437 UX-2.7 — honest units-not-dollars) | ◑ — reach is visible, but **no payout/revenue-share mechanism exists** (Stripe Connect exists at platform level, ADR 0385, not wired to challenge authors) |
| Free-with-ads tier | No ads anywhere | ❌ deliberate drop (right call — see §4) |
| $3/mo subscription | Paid feature **bundles** (ADR 0419) — a different shape | ◑ re-modeled |
| Author product store (books, supplements) | Platform commerce/UCP exists; no author-merch lane wired to challenges | ◑ |
| Corporate branded portals ($599–$3k/yr) | **White-label + trust tiers** (ADR 0366/0367) + `kicktodo-organizations` (org programs, cohorts, k-anonymous reports, B16 consent gates) | ✅ structure exceeds the original; pricing unset |

### Supporting UX intent

| Original | Current | Verdict |
|---|---|---|
| Goals dashboard w/ progress + red/yellow/green status | Today "One Thing" dawn-arc hero + honest Progress. Traffic-light shame-coloring **deliberately replaced** by recovery framing | ✅ (intent-improving divergence) |
| Flexible scheduling (time-of-day, weekdays-only, per-habit times) | A daily materialization slot + missed-window policy + substitution (ADR 0429). **No participant-chosen time-of-day/weekday schedule** (verified) | ◑ gap |
| Calendar view across challenges | Public **ICS feed** (tokenized) + calendar-write port (honest "awaiting adapter", B20); the in-app §5.5 Plan/Week/Calendar view was **deferred** (data-limited) | ◑ gap |
| Streaks & badges | Streaks + deterministic awards (`kicktodo-engagement`, ADR 0425) | ✅ |
| Points | Not modeled (streaks/awards instead) | ◑ minor |
| Journaling + notes per activity | Check-in **note** evidence; not a browsable journal | ◑ |
| Reminders + app badge | Reminder routing ✅; app badge = native concern (blocked with ADR 0413) | ◑ |
| Mood tracker | Not built (wearable-rules ingestion exists as a richer signal lane) | ❌ (was only a "recommended extra") |
| Social-media sharing as the viral loop | **Deliberately absent.** Community moved *in-app*: creator profiles, proof-gated reviews, moderation (`kicktodo-community`, ADR 0426) | ❌→✅ re-founded (see §4) |
| Community forums | In-app reviews + circles; no forum | ◑ |
| Omni-channel continuity ("pick up where you left off" on any device) | **The OpenWOP protocol is the answer the 2016 deck couldn't have**: one wire, any conformant client. Web SPA ✅; **React Native participant app** = ADR 0413 (Accepted; externally blocked on devices/store accounts; host min-build handshake shipped #2124); voice exists at platform level; watch/Alexa/TV not built | ◑ — the *architecture* finally matches the slide-16 ambition; the client fleet doesn't yet |
| AI goal recommendations | Discover is curated; no personalized recommendation lane (platform recommendations feature exists, unwired to kicktodo) | ◑ |

---

## 3. Where the implementation exceeds the original intent

The pivot onto OpenWOP didn't just port the idea — it fixed the four things the
2016-era concept would have gotten wrong:

1. **Content trust.** The original trusted "experts" by assertion. The Challenge
   Factory *proves* it: research dossiers with derived (unspoofable) provenance,
   unsupported-claim flagging, deterministic risk classification with prohibited-
   topic refusal, separation-of-duties publication, signed immutable releases, a
   kill switch that never deletes participant progress. This is the strongest
   possible reading of "challenges produced by experts."
2. **Accountability without surveillance.** "Friends see your progress" became
   consent-scoped, preview-honest, instantly-revocable Circles — with the k-anon
   floor on org aggregates (B16) and privacy-floored metrics. The "secret sauce"
   survived; the 2016 Facebook-shaped privacy model did not.
3. **Honest measurement.** The deck's "visual tracker + points" became
   evidence-gated check-ins, privacy-floored metrics with verifier sampling
   (ADR 0432), and a design law that no surface asserts what the server can't back.
4. **Platform leverage.** Auth, chat/AI, commerce, notifications, orgs, white-label,
   localization, audit — all inherited from openwop-app instead of hand-built on
   Firebase. The omni-channel slide is now an actual protocol property.

---

## 4. Deliberate divergences (documented as intent *decisions*, not gaps)

| Original | Divergence | Assessment |
|---|---|---|
| Facebook login + social-media sharing as THE viral loop | Dropped; community is in-app | **Keep dropped.** 2016 growth mechanics; conflicts with the consent-first accountability that is now the product's spine. If a share loop returns, make it an *invite link* (challenge-a-friend), not activity broadcasting. |
| Free-with-ads tier | No ads | **Keep dropped.** Ads inside a habit/behavior product undermine the trust posture the Factory earns. |
| $3/mo per-challenge AI add-on | AI via platform bundles/BYOK | **Keep the new model**, but note the original's *simplicity* ("$3 turns your coach on for this challenge") is a pricing-page decision still open when commerce flips on. |
| Red/yellow/green goal status | Recovery-not-failure framing | **Keep.** The deck itself demanded "never tell you off or make you feel guilty" — the current design honors the deck better than the deck's own mockup did. |
| Spiritual-content tilt of the Kickbot deck (slides 5/8: Scripture-specific copy, "GROW") | Current catalog is content-neutral; categories carry any vertical | **Keep neutral** at the platform layer; a faith-vertical catalog is a white-label/distribution decision (ADR 0366/0367 makes branded portals possible), not a core-product one. |

---

## 5. Genuine gaps worth closing (ranked)

These are the places the original intent is **not** yet honored and no ADR records
a deliberate drop:

1. **Participant scheduling flexibility** (deck slide 6; business-plan "time to do"
   reminders). Today materializes on a fixed early-morning slot; there is no
   per-enrollment time-of-day/weekday preference. This was core to the original
   "fits your life" promise and directly feeds reminder quality. *(Backend: an
   enrollment schedule preference + materializer/reminder honoring it; FE: a small
   schedule picker on enroll + Today.)*
2. **The in-app Plan/Calendar view across challenges** (deck slide 10; ADR 0436
   §5.5 deferred as data-limited). The ICS feed proves the data exists; the
   cross-challenge daily checklist view is the missing surface.
3. **Creator payouts** (business plan: "authors receive a percentage of every
   transaction"). Entitlement counts are visible, but there is no revenue-share
   ledger or payout lane — the one *commercial* promise of the original still
   unimplemented end-to-end. Stripe Connect (ADR 0385) is the obvious seam.
4. **"Challenge a friend" invite loop** (business plan, deck slide 7). A one-tap
   invite link into a specific challenge (join-me), distinct from Circles'
   heavier consent flow. Cheap, on-brand, and the honest remnant of the viral
   intent.
5. **Coach-led session ritual** (deck slide 8: "daily live chats at a prearranged
   time"). Cohort seats + scheduled chats (platform `scheduled-chats`) are both
   present but not composed into a coach-session surface.
6. **Content depth levels** (deck slide 5). A `difficulty`/depth facet on the
   challenge definition + Discover filter. Small, real discoverability intent.
7. **Journal view.** Check-in notes exist; a participant-facing chronological
   journal (their own notes across challenges) is a thin read over existing data.

Not recommended: mood tracker (superseded by wearable-rules signals), points
(streaks/awards cover the motivation intent), ads, Facebook integration, forums
(reviews + circles cover it), smart-fridge/TV clients (protocol-ready if ever
wanted).

---

## 6. The React Native mobile lens

The original was **mobile-first** (Flutter + FCM push + app badge + swipe-Done).
The current implementation is web-first with the mobile client specified:

- **ADR 0413** (Accepted): Expo/**React Native** participant client — matching the
  chosen direction (not Flutter). It is **externally blocked** (devices, Apple/
  Google accounts, APNs/FCM credentials, store listings; the ADR forbids headless
  simulation). The host side is ready: min-build handshake shipped (#2124,
  `GET /client-support`), push-registration deferred with it.
- What the RN app must carry from the original mobile intent when it unblocks:
  **push reminders** (the original's core retention mechanic), **app icon badge**
  (remaining actions today), one-thumb **swipe-Done** on the One Thing card,
  offline-tolerant Today, and the Snooze affordance one tap deep.
- The participant web experience (ADR 0436) was explicitly designed as the design
  law the RN client inherits (One Thing card, evidence-gated Done, recovery
  framing), so the mobile build is a rendering of an already-settled UX, not a
  second design effort.

---

## 7. Bottom line

**The original intent is not merely covered — its four pillars are all standing,
and three of them are stronger than the 2016 concept imagined.** Daily expert
challenges, fit-to-need accountability, and the Kickbot AI coach are implemented
with a rigor (provenance, consent, honesty-by-law) the original never specified.
The fourth pillar — the creator *economy* — is structurally complete but
commercially dormant: entitlements, seats, and org portals exist with toggles OFF,
and the single largest unhonored original promise is **author revenue share /
payouts**. The most participant-visible gaps against the original UX are
**schedule flexibility** and the **cross-challenge calendar view**; the mobile-
first promise rests on unblocking ADR 0413's React Native client, whose host seams
are already in place.

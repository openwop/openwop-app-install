# ADR 0436 — "My KickTodo" participant experience (frontend design law over the existing KickTodo packages)

| | |
|---|---|
| **Status** | **implemented (web)** — 2026-07-19 · P-UX1 + P-UX1.5 shipped + graded (code #2192 / ux #2193 / data #2194); native P-UX4 deferred. See §12. |
| **Feature** | Frontend experience/design over the existing KickTodo feature-packages — **no new toggle, no new package**. Rides the `kicktodo-core` toggle (ADR 0414). |
| **RFC verdict** | **Host work, no RFC.** No wire surface, no capability advert, no new event/envelope. See §10. |
| **Requirements source** | `docs/kicktodo-ux-ui-recommendation.md` §3–§5 (participant), §8–§13, §15–§16; the Project KickBot deck; `docs/kicktodo-prd.md` §4–§9. |
| **Extends (does not create)** | ADR 0414 (`kicktodo-core`), 0413 (native client), 0419 (accountability), 0429 (plan flexibility), 0420 (commerce), 0430 (content localization), 0425 (engagement). |
| **Siblings** | ADR 0437 (Creator Studio experience), ADR 0438 (Admin & Trust experience) — all three name the SAME shared foundations (SSoT: the recommendation doc §8/§9/§10 + `DESIGN.md`), each applied in its own register. |

---

## 1. Why this exists

KickTodo's participant promise is **"one relationship, one next step"**: a calm, intelligent achievement companion that shows the single most meaningful thing to do now, remembers who you are across challenges, and grows accountability only when you ask for it (`docs/kicktodo-ux-ui-recommendation.md:13`, PRD §4). The backend spine for that promise already exists and is `implemented` — enrollment, the daily-action loop, check-ins, the Today projection, progress, the per-user KickBot named agent (ADR 0414), plus accountability (0419), pacing/pause (0429), commerce (0420), localization (0430) and engagement (0425).

What does **not** yet exist as a cohesive, designed whole is the **participant-facing experience over those packages**. ADR 0414 P5 shipped a functional Today + Discover pair as contract material; it did not ship the five-destination workspace, the first-run onboarding, the plan/progress/circles/guide surfaces, or the designed state machine the recommendation demands. This ADR records the **design law** for that workspace — the information architecture, the flows, the designed states, and the visual language — as durable decisions binding the frontend, so the participant experience is authored deliberately rather than accreted screen-by-screen. It is a **frontend cohesion decision, not a feature**: it adds no route to the wire, no toggle, no pack, no table.

The one hard rule that governs every screen below: **do not expose OpenWOP's implementation vocabulary to participants** (`:40`). They experience "Today," "My plan," "Ask Nova," "Share with my circle" — never runs, node packs, workflow definitions, interrupts, or agent-dispatch provenance. That vocabulary is progressively revealed only in the Guide's advanced drawers and the operator workspaces (ADR 0437/0438).

---

## 2. Boundaries audit (Step 3 — what already exists; this adds nothing to the wire)

Everything this experience needs to render already has an owner. This ADR reuses; it stands up **no** parallel workspace, nav, component, token, or route system — the orgs↔accessControl cautionary tale (a second overlapping model that had to be reconciled later) is the failure this audit exists to prevent.

| Concern | Existing owner (reuse — do not shadow) | Ref |
|---|---|---|
| Workspace + nav shell, sidebar, workspace switcher | The app's existing workspace model + nav tiers + the **menu registry** (`GROUP_ORDER`), which already carries a `KickTodo` group | ADR 0414 P5; §4.1 says explicitly "use the existing app workspace model" |
| Design tokens, `ui/` primitives, component cohesion | `DESIGN.md` (§2 editorial tokens, §3 functional tokens, §4.5 collection canon, §5 components) + `frontend/react/src/ui/*` | `DESIGN.md` |
| Today / enrollment / check-in / progress / KickBot read+write | `kicktodo-core` — `/v1/host/openwop-app/kicktodo/{today,enrollments,check-ins,progress,kickbot}`, `kicktodoClient.ts` | ADR 0414 |
| Daily-action loop, occurrences, materialization | `kicktodo-core` (deterministic occurrence/card ids; plan-revision supersession) | ADR 0414 |
| Substitute + pause/recovery + missed-window policy | `kicktodo-core` extension | ADR 0429 |
| Circles / partners / cohorts / coach | `kicktodo-accountability` — `/kicktodo/circles/*`, `/kicktodo/coach/*` | ADR 0419 |
| Purchases / entitlements / fulfilment states | `kicktodo-commerce` (adapter over Commerce/Billing/Connect) | ADR 0420 |
| Opt-in leaderboard / awards | `kicktodo-engagement` | ADR 0425 |
| UI locale vs content locale | app i18n (ADR 0065) + `kicktodo` UI catalogs (4-locale, ADR 0414 P5) + challenge-content locale (ADR 0430) | ADR 0430 |
| The AI conversation (Guide) | **The ONE shared chat** — deep-linked `/?agent=host:kickbot`; embedded via `chat/EmbeddedChatPanel` where a surface needs inline chat | `CLAUDE.md` "AI chat — reuse, never recreate"; ADR 0414 P5 |
| Native surfaces | ADR 0413 shared-contract client (`kicktodoClient.ts`) — the participant screens are its first consumers | ADR 0413 |

**Assertion.** This ADR introduces **no new feature-toggle, no new feature-package, no new node/agent/artifact/connection pack, and no wire surface.** The participant workspace is design/IA/frontend-cohesion law layered over the packages above.

**The one place a new endpoint could be needed (flagged, not assumed).** First-run onboarding screens P2–P4 (choose starting outcome → define constraints → *challenge recommendations*, §5.1) want a small "recommend 3–5 challenges from stated outcome+constraints" read. Discover's published-catalog read already exists; a *personalized-recommendation* read does not. If a genuinely-new read is required, it is a **host-private `/v1/host/openwop-app/kicktodo/recommendations` GET** (non-normative host-ext, never advertised) — but the honest first cut can compose the existing Discover catalog + goal-fit filtering client-side and defer the endpoint. Recorded as Open Question OQ-1; nothing here is advertised on the wire either way.

---

## 3. Decision — the "My KickTodo" information architecture

### 3.1 Five destinations, one workspace (mirrors §4.2)

The participant workspace is exactly five top-level destinations, rendered as the `KickTodo` sidebar group on web/PWA and as the five bottom-tab destinations on native (ADR 0413). Order and labels are fixed:

1. **Today** — the home. "What is the smallest meaningful thing I can do now?"
2. **Discover** — find and preview a challenge.
3. **Progress** — transformation, consistency, evidence — not activity volume.
4. **Circles** — accountability relationships (partner / circle / cohort / coach).
5. **Guide** — the user's *named* KickBot (labeled with the chosen name when space permits, else "Guide"). Deep-links the ONE shared chat scoped to `host:kickbot`.

The tab bar / sidebar group is **navigation only, never an action bar** (Apple HIG; `:183`). A person with creator or admin authority gets the **existing workspace switcher** (§4.1) to cross into ADR 0437/0438 — participant actions and operator queues never mix in one list. The switch is URL-addressable and remembered per device (existing behavior; not re-built here).

Settings sub-surfaces (`/kicktodo/settings/notifications`, `/kicktodo/settings/privacy`) and `/kicktodo/purchases` hang off the account menu, not the five destinations (§15 route map). Every route in §15 is honored verbatim as the URL contract; every opened entity has a URL and inner tabs bind to `?tab=` via `useUrlTab` (DESIGN.md §4.5 rule 12).

### 3.2 The designed flows (per surface)

Each flow below is authored to the recommendation section named; the point of recording them here is that they are **law**, not suggestions — a surface is not "done" until its flow and all its states exist (§17).

- **First-run onboarding** (§5.1, screens P0–P9): a *revisable plan*, not a one-way wizard (the deck's chief structural flaw, `:69`). Welcome (≤20s promise + AI disclosure) → sign-in preserving the deep-link intent → outcome (two paths: "I know what I want" / "Help me choose") → success + constraints (each question says *why*, "Skip for now" always) → 3–5 high-confidence recommendations (never an infinite wall) → **one-week plan preview with a compact change ledger** ("Reduced daily time 25→15 min") → schedule (weekly timetable, low-notification default) → **accountability choice with a literal "what they can see" preview** → meet+name the guide (rename ≠ new identity; memory controls) → Ready summary where every field links back to edit. The durable enrollment is created **only on final confirm**.
- **Today** (§5.2): greeting + truthful workload summary → **one hero action** → compact rows for other due actions → "Coming up" strip → circle/coach activity → recovery/offline notices. **Never lead with streaks, points, or a chart.** Progress updates after evidence is accepted — no "Check progress" button to understand.
- **Daily action detail** (§5.3): outcome connection → time+evidence expectations → primary content → "Do this now" → "Why this matters" → accessibility/alternatives → **evidence capture derived from the challenge policy** → optional reflection → "Ask the guide about this action" (embedded chat) → circle discussion only when explicitly enabled. **Never render a generic "Done" when the challenge requires evidence** — show exactly what is required *before* the user starts.
- **Plan / week / calendar** (§5.5): Week (default) / Calendar / Challenge views; move-within-window, publisher-approved substitute (ADR 0429), request re-plan, **compare current vs proposed and approve/reject**. Drag has a keyboard/touch equivalent (WCAG 2.2 dragging). KickTodo is the source of truth; external-calendar state is disclosed (connected/syncing/stale/error/revoked) and a sync failure never hides the action.
- **Progress trace** (§5.6): "meaningful progress this week" narrative → milestones → **outcome → achievements → actions → evidence trace** → consistency with recovery *distinguished from failure* → verifier decisions in plain language → "What remains" + "Adjust plan" → completion certificate only after authoritative completion. **No single false-precision percentage** unless its basis is explained.
- **Pause & recovery** (§5.7): pause previews exactly what pauses (reminders, scheduled actions, proactive messages, cohort expectations) and what does not (access, messages, submitted evidence, financial terms); return offers three bounded choices (continue from today / one recovery action / lighter plan). Copy is "Welcome back," **never "You broke your streak."**
- **Guide** (§5.8): the durable relationship — continue conversation, today's context, pending proposal/approval, recent milestone, and the agent profile (name, AI disclosure, style, autonomy, human-language schedules, approved knowledge, **memories with review/delete**, connected services, rename-without-losing-continuity). Plan/evidence/approval cards are **visually distinct from ordinary chat**; a plan change is a structured proposal with a diff + approval controls, never prose. Tool activity collapses to "Checked your plan and calendar" with an expandable audit. This is the ONE shared chat scoped to the named agent — no second chat panel (`CLAUDE.md`).
- **Circles** (§5.9): relationships, invitations requiring action, privacy-filtered encouragement, cohort sessions, and a **"who can see what" privacy preview** on every share. No social screen exposes raw journal content by default.
- **Purchases / commerce** (§5.10): product type + included support + limits in understandable units + price/tax/renewal/refund/access → **the checkout return is not the entitlement confirmation** — show "Confirming access…" until the verified fulfilment state arrives (processing / active / needs attention / refunded / disputed).

### 3.3 Every state is designed (§3.6, §12)

"Nothing happened" is never acceptable. Two contracts bind here:

- **The action-card state machine** (§5.2): Ready → In progress → Evidence needed → Submitted/verifying → Complete → Needs clarification → Alternative selected → Rescheduled → Missed (choice required) → Superseded by plan change → Unavailable offline. **Every state names an explicit next action.**
- **The universal designed states** every major surface renders: loading, empty (celebrated, per DESIGN.md §4.5 rule 1 — "You're all caught up"), no-match (with clear-filters, DESIGN.md §4.5 rule 13), offline (cached Today + freshness timestamp + outbox), partial-data, permission-denied (explain without leaking a hidden resource, §13), approval-waiting, provider-unavailable (**Today, plan, schedule, evidence continue without AI**; the guide explains the limit and offers deterministic actions, §12), retrying, superseded, retired, success.

---

## 4. Design language — "Daybreak" (layered over DESIGN.md, never a parallel system)

The participant workspace must feel calmer and more spacious than the operator chrome, yet it **must not fork the token or font system**. DESIGN.md's editorial voice (warm paper, clay accent, Geist + Instrument Serif, the `--weight-*` ladder, the motion tokens, the collection canon) is the substrate. "Daybreak" is a thin **semantic layer** over it, plus **one signature device**. It deliberately avoids the two AI-default looks the frontend-design lens warns against: it is neither the generic cream/serif/terracotta broadsheet (that is literally the operator chrome, and reusing it wholesale would make the participant home feel like an admin console) nor the black/acid-green AI look.

### 4.1 Palette — 6 semantic values, only 2 genuinely additive

Named as participant-semantic tokens that **alias onto existing DESIGN.md functional tokens** wherever one exists — that is the disciplined "layer over" move. Hex values are the design record; the real tokens land as `oklch` in `global.css :root` in lockstep with DESIGN.md §2/§3.

| Token | Light | Dark (lifted) | Meaning | Source |
|---|---|---|---|---|
| `--kt-focus` | `#4f5d92` | `#9aa6dd` | **The single-next-action accent** — the focus device's arc, its left rail, links, and the `:focus-visible` ring. A calm dusk-periwinkle. | **NEW** (the one additive brand hue; sits between info hue 240 and ai hue 280 but is used only at participant altitude where node categories never appear) |
| `--kt-dawn` | `#f3e9dd` | `rgb(255 255 255 / 0.05)` | Participant-calm surface tint — anchors the time-of-day wash on Today. | **NEW** (a warmer sibling of `--paper-2`) |
| `--kt-verified` | → `var(--color-success)` | (lifts w/ token) | **Verified completion only** — never every primary button. | reused (DESIGN.md §3) |
| `--kt-recover` | → `var(--color-warning)` | (lifts w/ token) | Attention + recovery, **never punishment**. | reused |
| `--kt-guard` | → `var(--color-danger)` | (lifts w/ token) | Safety / destructive / payment+incident failure only. | reused |
| `--kt-neutral` | → `var(--paper)` / `var(--ink-*)` | (lifts w/ token) | Calm, reflection, long-form content. | reused |

**Load-bearing restraint (DESIGN.md button law is preserved).** `--kt-focus` is **not** a button fill. The participant primary CTA ("Start action," "Start my plan") still uses the app-wide `.btn-accent-solid` clay fill — DESIGN.md's "primary actions fill with the brand clay; never an inverted ink slab" is absolute and not overridden here. `--kt-focus` colors only the *focus device* and links. This keeps the app's button hierarchy intact while giving the participant surface its own identity through geometry and the signature, not through a competing brand button. (This resolves the recommendation's §9.1 "KickTodo blue = primary brand actions" against DESIGN.md's clay law — see §9 corrections.)

### 4.2 Type — role assignment over the existing triple (no new face)

Introducing a participant-specific typeface would violate DESIGN.md §1 and is **rejected**. The pairing is the existing triple with a participant-specific *rule*:

- **Geist** (the `--weight-*` ladder) carries all structure, headings, body, and controls — it is already the "friendly, highly legible sans" §9.2 asks for.
- **Instrument Serif** (`--serif`, DESIGN.md's sanctioned accent) is reserved for the **human/relational moments only**: the Today greeting ("Good morning, David"), the completion-moment reflection ("This moves you toward…"), and the guide's chosen name. This is the existing serif-accent allowance applied with intent, not a new axis.
- **Geist Mono** stays for ids, versions, and audit metadata — which participants see only in the Guide's advanced drawer.

### 4.3 Signature — "The One Thing" focus card

The single memorable element, and the only place boldness is spent. Everything around it stays quiet.

Today's hero action renders as **"The One Thing"**: one generously-spaced `.surface-card` carrying the day's single most-relevant action, wrapped by a **dawn-arc** — a thin `--kt-focus` arc (not a progress *bar*) that traces the card's top edge and completes as the day's action is verified — over a **time-of-day wash** (`--kt-dawn` at low alpha, gradient anchor keyed to the participant's local morning/afternoon/evening). The effect: Today literally feels like it belongs to *this moment* of *this person's* day — grounding the "daily companion" subject in the one screen they open most. This is deliberately **not** the generic big-number-hero template; the hero is a single human action, and the number (if any) is the arc's quiet completion, not a dashboard figure.

Discipline floor (not announced, just met): the arc respects `prefers-reduced-motion` (fills instantly, no sweep); the time-wash is static under reduced-motion and never animates value; the card meets 44×44 touch targets and a theme-safe `:focus-visible` ring in `--kt-focus`; contrast is AA in both themes; nothing about the wash lowers text contrast below the DESIGN.md floor. One signature — no confetti, no countdown pressure except a real server-backed seat hold or expiring approval (§8.5).

---

## 5. Phased plan (maps §16; each item gates on its surface's blocker)

**Phase UX-0 blocker-gate is law here:** UI polish over a surface WAITS until that surface's `KTFULL-B*` blockers (grade-D re-audit, `docs/steward/CODEBASE-ASSESSMENT.md`) are closed — polishing UI over unsafe behavior is forbidden (§16 UX-0). Another session is actively closing these; current status is recorded per row so the gate is checkable. A "landed" blocker unblocks polish; an "open" one caps that surface at functional-not-polished.

### Phase P-UX1 — participant web loop (maps §16 UX-1)

| Surface (this ADR §3.2) | Recommendation | Blocker-gate prerequisite | Blocker status (2026-07-19) |
|---|---|---|---|
| Today + "The One Thing" signature | §5.2 | **B5** (daily loop scheduled via `armContinuation`) — Today can only trust "today's cards exist" once the loop is armed | **B5 landed** ✅ (kicktodo/b5) |
| Daily action + evidence detail | §5.3 | **B6** (declared evidence enforced before write; check-in→card saga forward-repairable; verifier judges required-activity identity, not counts) | **B6 partial** ⚠️ — evidence enforcement landed; the saga-forward-repair + verifier-identity half is **still open** → the "Submitted/verifying" and "Needs clarification" states stay functional-only until that half closes |
| First-run onboarding (P0–P9) | §5.1 | none blocking; OQ-1 (recommendations endpoint) may gate P4 only | — |
| Plan / week / calendar + substitute + pause/recovery | §5.5, §5.7 | rides ADR 0429 (implemented) + B5 (materialization) | **landed** ✅ |
| Progress trace | §5.6 | rides ADR 0414 P3 progress (implemented) + B6's verifier-identity fix for honest "verifier decisions" copy | **B6 partial** ⚠️ (verdict copy waits on the verifier-identity half) |
| Guide (named-agent profile + structured proposals) | §5.8 | rides the ONE shared chat + ADR 0414 P2 KickBot | **landed** ✅ |
| Purchases / entitlement states | §5.10 | **B13** (paid-order fulfilment has a reconciliation caller — no permanently-unfulfilled paid order) | **B13 open** ⚠️ → the "Confirming access… / needs attention" fulfilment states stay functional-only until B13 lands |

**Exit evidence (§16 UX-1):** a participant can discover, approve, schedule, complete-with-required-evidence, recover, and finish a multi-week challenge without operator intervention.

### Phase P-UX1.5 — Circles (participant slice of §16 UX-1)

| Surface | Recommendation | Blocker-gate | Status |
|---|---|---|---|
| Circles home + circle detail + privacy preview | §5.9 | **B10/B11** (cohort seat oversell/strand under concurrency) | **B10 + B11 landed** ✅ |
| Cohort capacity / hold / "needs attention / refunded" states | §5.9, §5.10 | **B12** (seat expiry/confirmation/refund is a durable, reconciled sequence — no stranded capacity or access) | **B12 open** ⚠️ → capacity-countdown + refund states stay functional-only until B12 lands (and any countdown must be backed by durable reservation state per §8.5) |

### Phase P-UX4 — React Native participant app (maps §16 UX-4)

Delivers Today, action/evidence, Discover, plan, progress, circles, guide as native screens over the **shared `kicktodoClient.ts` contract** (ADR 0413) — no DOM component sharing (§8.2). **Externally blocked:** ADR 0413's P1 device legs and P2–P5 (Expo scaffold, real-device OIDC spike, push credentials, offline outbox, store pipeline — `KTFULL-B9`) wait on **operator resources** (devices, push creds, store accounts) and are deliberately not simulated headless. This ADR's native work is gated behind that block; the web loop (P-UX1) is the unblocked path and ships first.

---

## 6. Composes (one line each — what this workspace surfaces from each)

- **ADR 0414 `kicktodo-core`** — Today projection, enrollment, daily loop, check-ins, progress, and the named KickBot agent: the substance of Today, Progress, and Guide.
- **ADR 0413 native client** — the React-free `kicktodoClient.ts` contract the P-UX4 native screens render; the web surfaces consume the same client so the two never drift.
- **ADR 0419 accountability** — the Circles destination (partner/circle/cohort/coach) and every "who can see what" privacy preview.
- **ADR 0429 plan flexibility** — the Plan surface's Substitute control and the Pause & recovery flow's missed-window behavior.
- **ADR 0420 commerce** — the Purchases surface's entitlement + fulfilment states and the "Confirming access…" checkout-return contract.
- **ADR 0430 content localization** — the UI-locale-vs-content-locale split every surface honors (a pt-BR interface truthfully labeling English content until a pt-BR version exists).
- **ADR 0425 engagement** — the opt-in leaderboard/awards Progress can surface, always behind an explicit opt-in projection (never the record).

---

## 7. Shared design foundations (SSoT: the recommendation doc §8/§9/§10 + DESIGN.md; ADR 0437/0438 name the same law)

These cross-cutting foundations are authored once, in the recommendation doc + DESIGN.md, and are **shared law** across all three experience ADRs. This ADR points to them; it does not restate them, and the sibling ADRs cite the same anchors so the three workspaces stay one system:

- **Component system** — reuse the existing cohesion layer (`PageHeader`, `.surface-card`, `.card-grid`, `.list-row`, `.chip`, `.action-bar`, `Notice`, `StateCard`, `Tabs`/`useUrlTab`, `ViewToggle`, `DataTable`, shared `confirm()`, quick-look drawer, shared Kanban renderer). New KickTodo product components (`OutcomePicker`, `ChallengeCard`/`ChallengeRow`, `PlanWeek`, `ActionCard`, `EvidenceCapture`, `ProgressTrace`, `PrivacyPreview`, `AccountabilityLevelCard`, `AgentProposalCard`) land **only** when genuinely reusable, and each carries a `DESIGN.md` registry entry + loading/error/empty states + keyboard behavior + localization contract + native-equivalent decision. (`docs/kicktodo-ux-ui-recommendation.md` §8.1; DESIGN.md §5.)
- **Visual direction** — §9: verified-green for completion only, amber for attention not punishment, warm neutrals for reflection, muted red for safety; retain the check-mark idea without a check on every card; distinctive editorial challenge covers, not stock "happy productivity" art.
- **Accessibility floor** — §10 + DESIGN.md: WCAG 2.2 AA; 44×44 preferred / 24×24 minimum touch targets; visible theme-safe focus never obscured by sticky bars; keyboard alternatives for drag/swipe/long-press; no chart without a table/narrative equivalent; reduced-motion, contrast, dark/light; 320px web width; errors that identify the field, explain, and suggest a fix.
- **Route-intent vocabulary** — §15: the shared deep-link intents (action, enrollment, conversation, circle, invitation, approval, checkout-return) that web and native both resolve; every entity has a URL; inner tabs use `?tab=`.
- **Permission/action contract** — §13: the UI renders **server-authoritative allowed actions**, never derives permission from a display-role label, and explains an unavailable action without leaking a hidden resource.
- **Evidence-capture contract** — §5.3/§8: evidence controls derive from the challenge policy and are shown *before* the action; a generic "Done" is forbidden where evidence is required.
- **Status/error vocabulary** — §8.4: neutral/info/success/warning/danger semantics, always label + icon/dot (+ optional color), never color alone — mapped onto DESIGN.md's functional tokens and the §4.5 chip/dot/ring system.

---

## 8. Alternatives weighed

1. **A bespoke KickTodo SPA / second nav shell** (a "consumer app" separate from the operator app). *Rejected* — it forks the workspace, token, and component systems the boundaries audit (§2) exists to protect; it is the orgs↔accessControl mistake at product scale. The five destinations ride the existing nav model and menu registry.
2. **A KickTodo-blue primary button system** (literal reading of §9.1 "blue = primary brand actions"). *Rejected* — it violates DESIGN.md's absolute clay-primary law and would split the app's button hierarchy. Resolved by scoping `--kt-focus` to the focus device + links, keeping clay as the CTA fill (§4.1).
3. **A new participant typeface** for a "friendlier consumer" feel. *Rejected* — Geist already satisfies §9.2, and a second family violates DESIGN.md §1. The participant warmth comes from the serif-accent *rule* (§4.2) and the signature, not a new font.
4. **Polish all surfaces now, fix blockers later.** *Rejected* — §16 UX-0 forbids polishing UI over unsafe behavior; §5's per-surface blocker-gate makes the dependency explicit and checkable.
5. **A second embedded "talk to your coach" chat** in Today/Guide. *Rejected* — there is ONE chat (`CLAUDE.md`); the Guide deep-links it scoped to `host:kickbot`, and inline needs use `EmbeddedChatPanel`.

---

## 9. PRD-vs-architecture corrections

- **"KickTodo blue is the primary brand action" (§9.1)** → the app's primary is **clay** (DESIGN.md law). Reshaped: `--kt-focus` is the *next-action focus device + link* accent, not a button fill; clay remains the CTA. The recommendation's intent (a distinct agency color) is honored without breaking the button hierarchy.
- **"KickTodo semantic design tokens and brand assets" as a UX-0 deliverable (§16)** → reshaped from "a token set" to a **thin semantic layer aliasing DESIGN.md's tokens** (§4.1) with only two genuinely additive hues. A parallel token system is forbidden.
- **"Three role shells and workspace switcher" (§16 UX-0)** → not new infrastructure: the app already has the workspace model + switcher + menu registry; this is a reuse, not a build (§2).
- **The deck's linear onboarding wizard** → replaced by a **revisable plan** (P0–P9 with edit-back on every field, enrollment created only on confirm) — the deck's chief structural flaw (`:69`).
- **"Snooze" as a feature name** → **"Pause & adjust"** at the nav/action level; "Snooze" survives only as a short control label (§5.7).
- **Personalized challenge recommendations (P4)** → flagged as the one possible new host-private read (OQ-1); the honest first cut composes existing Discover client-side and defers the endpoint. No wire advert either way.

---

## 10. Open questions

- **OQ-1 — recommendations read.** Does first-run P4 need a `/v1/host/openwop-app/kicktodo/recommendations` host-ext GET, or can goal-fit filtering over the existing Discover catalog carry MVP? Decide before P-UX1 onboarding lands; default to the client-side compose (no new endpoint) unless quality demands it.
- **OQ-2 — `--kt-focus` hue vs `--color-info`/`--color-ai`.** The dusk-periwinkle sits between info (240) and ai (280). It never co-occurs with node-category chrome at participant altitude, but confirm during token authoring that it reads as distinct from the info/ai functional tokens in both themes (contrast + hue separation), or nudge it.
- **OQ-3 — B6 verifier-identity half.** Progress "verifier decisions with plain-language explanation" (§5.6) depends on the verifier judging required-activity *identity*, not done-counts. Until B6's open half lands, verdict copy stays generic ("completed") rather than per-activity — track and upgrade the copy when the blocker closes.
- **OQ-4 — time-of-day wash + localization.** The dawn-arc wash keys on the participant's *local* time; confirm it composes with the timezone/week-start locale-awareness (§10) and degrades to static under reduced-motion + high-contrast without a separate code path.

---

## 11. RFC verdict

**Host work — no RFC, no new toggle, no new package, no wire surface.** This ADR is frontend experience/design law over already-`implemented` KickTodo packages. It advertises nothing on `/.well-known/openwop`; it adds no run-event, capability flag, endpoint contract, or envelope kind. The only endpoint it might introduce (OQ-1) is a **non-normative host-private read** under `/v1/host/openwop-app/*`, which never touches the wire and needs no RFC. A new RFC becomes mandatory only on the ADR 0414 §17 / PRD §17 triggers (a `kicktodo`/`challenges` capability advert, normative `/v1/challenges` endpoints, `challenge.*` run-event types, a portable cross-host challenge schema, or cross-host accountability semantics) — none of which this experience introduces.

---

## 12. Implementation record (2026-07-19)

**Status: implemented (web) — P-UX1 + P-UX1.5 shipped; P-UX4 native deferred.**

| Phase | Ships | Status | Evidence |
|---|---|---|---|
| **P-UX1** | Participant web loop — Today (hero "One Thing" + dawn-arc + evidence-gated Done), Discover (decision cards → detail, no card-enroll), Challenge Detail (commitment preview + enroll), Progress (honest figures, recovery-not-failure), Guide (KickBot deep-link) | ✅ implemented | `features/kicktodo/{TheOneThing,TodayPage,DiscoverPage,ChallengeDetailPage,ProgressPage,GuidePage}.tsx`; grade-code #2192, grade-ux #2193, grade-data #2194 (remediated) |
| **P-UX1.5** | Circles — consensual accountability with an explicit scope-selector + live privacy preview | ✅ implemented | `features/kicktodo-circles/CirclesPage.tsx`; consent-surface honesty fixes (KT-EXP-1/2/3) #2194 |
| **P-UX4** | React Native participant app | ⏸ deferred | separate native client (ADR 0413); out of the web-experience scope of this ADR |

**Graded + remediated:** all three grades ran on this surface and every actionable fix landed — code (KTEXP-1 auth blocker + fan-out + tests, #2192), UX (A−; enum labels, heading order, enrollment reflect, search gating, #2193), data (B→A−; Circles consent-preview honesty, #2194). Deferred sub-surfaces within recommendation §5 (§5.3 action-detail, §5.5 plan/calendar, §5.10 purchases) are data-limited today (the enrolled challenge *version*'s activities aren't reliably in the served catalog; per-day completion state isn't exposed; commerce/entitlement reads aren't surfaced) — tracked, not faked.

**Correction note (2026-07-22, ADR 0442 Guide wave) — the Guide is now chat-first, fulfilling §5.8.** P-UX1 shipped the Guide (§5.8) as an interim **landing** surface that deep-linked the shared chat ("a LANDING surface, not a chat") — a phasing decision, not the §5.8 target, which always described the durable relationship happening *in* the shared conversation (continue-conversation, structured proposals, collapsed tool activity). The Guide wave overturns the interim landing: `GuidePage.tsx` now embeds the ONE shared chat scoped to `host:kickbot` in place (`EmbeddedChatPanel` + `GuideWelcome`, the Studio precedent; never a second panel), and KickBot gains the grounding reads (journal/plan/achievements/leaderboard/proposals) that make its coaching relevant to "today" and the user's real progress. This brings the implementation *toward* §5.8, not away from it. Full §5.8 profile management (memories review, rename-with-continuity in-surface) still links out to `/agents`; self-owned writes (log-checkin from chat) are the deferred Wave-2. Owned by **ADR 0442** (KickBot composition) — see its Implementation record "Guide wave" row.

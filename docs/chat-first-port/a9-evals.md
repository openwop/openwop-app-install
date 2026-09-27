# A9 — Evals leaderboard + model arena — chat-first port review

**Scope:** `backend/typescript/src/features/evals/*` + `frontend/react/src/features/evals/*`
(ADR 0123 — leaderboard + head-to-head arena). Single-feature mode.

**One-line verdict:** This feature is **mostly page-shaped and already rides the
real owners** — the leaderboard is honest read-only reporting over the ADR 0071
`MessageFeedback` store, and the arena dispatch rides the ONE conversation
transport (no second runtime). The only genuine defect is that the arena **hand-rolls
the conversation feed + composer** (`ArenaPage.tsx:33-74,177-188`) that
`ConversationView`/`EmbeddedConversation` already own — a third copy of chat-bubble
styling now lives beside `CompareView.Pane`. The real chat-first *opportunity* is
unbuilt-but-honestly-deferred: ADR 0123 Phase 5's `ctx.features.evals` read surface /
"which model wins for X" agent tool never shipped, so the ONE chat cannot answer a
model-choice question from the leaderboard it already computes.

---

## Contract scouting (pinned evidence)

**Declared vs ignited.** The feature declares **no workflow, no node pack, no agent
pack** — `feature.ts:11-15` registers only routes; there is no `feature.evals.nodes`
and no agent persona (grep: zero `registerFeatureAgentTool` in the package, no
`*eval*` pack). So there is nothing orphaned to ignite; the surface is routes + math
+ two React pages.

**Routes → engine.** Three host-ext routes (`routes.ts:40,52,69`):
- `GET …/evals/orgs/:orgId/leaderboard` → `buildTenantLeaderboard` (`routes.ts:43`).
- `POST …/evals/orgs/:orgId/arena/match` → `recordArenaMatch` (`routes.ts:61`).
- `GET …/evals/orgs/:orgId/arena/rating` → `getArenaRating` (`routes.ts:74`).

All three call `requireOrgScope(req, 'workspace:read'|'workspace:write')`
(`routes.ts:42,54,71`) — a real authorization predicate, org-scoped. The arena
rater is **session-bound, never client-supplied**: `raterSubject: \`user:${user.userId}\``
(`routes.ts:63`) — the ADR 0071 posture, correctly preserved.

**Who creates the two live model runs?** The frontend arena, through the **existing
transport** — `openConversationSession({ provider, model })` + `sendConversationTurn`
(`ArenaPage.tsx:112-114`), the same `conversationTransport.ts:316` the ONE chat uses,
with the model pinned at session-open and **no `chatSessionId`** so the runs are
ephemeral and never hit the conversations rail (`ArenaPage.tsx:110-113`). This is
genuine reuse of the conversation runtime — **not** a second dispatch path. Model
pickers are the shared `ModelSwitcher` (`ArenaPage.tsx:26,57`).

**Owners instantiated vs shadowed.**
- Feedback signal → `listFeedbackForTenant` (`leaderboardService.ts:12,24`) — reads the
  ADR 0071 `messageFeedbackStore` owner, no parallel feedback store. **RIDES.**
- Elo/rating persistence → `DurableCollection('evals:arena-match')` /
  `('evals:arena-rating')` (`arena.ts:30-31`) — the shared host persistence primitive,
  not a bespoke table. **RIDES.**
- Conversation runtime → the shared transport (above). **RIDES.**
- Conversation **feed + composer rendering** → **shadowed.** `ArenaPage.Pane`
  hand-rolls bubbles with inline `MSG`/`USER_MSG` CSS (`ArenaPage.tsx:33-36,60-63`)
  and a bespoke `<input>`+`<button>` composer (`ArenaPage.tsx:177-188`), duplicating
  what `ConversationView`/`EmbeddedConversation` own. Note the ADR's own comment
  claims "the CompareView pattern" (`ArenaPage.tsx:15`) — but `chat/CompareView.tsx`
  is **not** imported; it is a settled-transcript modal (`CompareView.tsx:8-11`), so
  it can't back a *live* two-model dispatch. The result: chat-bubble styling now
  exists in **three** places (`ConversationView`, `CompareView.tsx:19-20`,
  `ArenaPage.tsx:33-36`).

**Chassis constraint that bounds the port.** `CompareView.tsx:8-9` is deliberately
read-only ("does NOT spin up two live sessions"). The arena needs two *live* streams
sharing one prompt + a cross-pane vote — so it is a legitimately distinct **compare
surface**, not something the single-stream ONE chat renders and not something
`CompareView` can host. The port target is therefore "compose the shared read-only
feed renderer inside the two panes," not "move the arena into the main chat."

**Lifecycle gap (scouting BLOCKER).** `evals:arena-match` stores
`raterSubject = user:<id>` (`arena.ts:24,53`) — a per-user PII subject key — yet the
package registers **no `registerSubjectKeyResolver` and no `registerRetentionPurger`**
(grep: zero in `features/evals/`), and neither collection appears in any subject-erasure
enumeration. A DSAR erase of a user leaves their arena votes behind.

---

## Verdict table

| # | Capability | Today | Verdict | Port target |
|---|---|---|---|---|
| C1 | View per-model quality leaderboard (win-rate + Elo, org picker) | Read-only `DataTable` over `fetchLeaderboard` (`LeaderboardPage.tsx:77-85`) | **PAGE-LEGIT** | Keep. Reporting is page-shaped; honesty loop is closed (real reads, unattributable rows dropped `leaderboardService.ts:39`). |
| C2 | Arena: two models answer one prompt, side-by-side, live | Transport RIDES (`ArenaPage.tsx:112-114`); **feed+composer hand-rolled** (`ArenaPage.tsx:33-36,60-63,177-188`) | **PARALLEL** (render layer only) | Keep the two-pane compare chrome + shared prompt + vote; **replace the bespoke bubbles/composer with the shared `ConversationView` read-only feed renderer.** |
| C3 | Vote a winner → head-to-head Elo | 3 bespoke `secondary btn-sm` buttons → `POST /arena/match` (`ArenaPage.tsx:190-196`), rater session-bound (`routes.ts:63`) | **PAGE-LEGIT** | Keep. Sibling to the sanctioned inline thumbs capture; no approvals-owner is shadowed (no durable-content gate here). |
| C4 | Arena match/rating persistence + Elo math | `DurableCollection` + `eloMatch` (`arena.ts:30-56`, `elo.ts:20-42`) | **RIDES** (with lifecycle blocker) | Keep the stores/math; **add erasure + retention coverage** for the subject-keyed rows. |
| C5 | Leaderboard aggregation service (feedback→model join) | `buildTenantLeaderboard` over `messageFeedbackStore` (`leaderboardService.ts:23-43`) | **RIDES** | Keep. Reuses the ADR 0071 owner + recorded model attribution; pure, bounded fan-out (`leaderboardService.ts:21`). |
| C6 | Chat "which model wins for X" — `ctx.features.evals` read surface / agent tool | **Declared** ADR 0123 Phase 5 + matrix rows 3–4; **never built** (no tool/pack/ctx surface) | **DEFERRED (honest)** → build as ADAPTER | The one real chat-first add: a `registerFeatureAgentTool('evals.leaderboard')` **read** tool sharing the `workspace:read` leaderboard predicate, so the ONE chat answers model-choice from the board it already computes (ADR 0058 chat-drivability). |

**Counts (graded capabilities C1–C5; C6 is deferred-honestly, not graded):**
**R=2  A=0  P=1  T=0  PL=2.** No THEATER: nothing claims a capability it lacks — the
ADR marks Phase 5 as a "clean follow-on"/"future" (ADR 0123:82-83,99), so its absence
is honest deferral, not a painted-green lie.

---

## Blockers (from scouting) — each with the honest alternative

1. **Live-compare cannot ride the ONE main chat or `CompareView`.** The main chat is a
   single stream; `CompareView` is settled-transcript-only (`CompareView.tsx:8-9`).
   *Honest alternative:* the arena stays a distinct **compare page** (PAGE-LEGIT chrome),
   but its two panes each render the **shared read-only conversation feed** (a
   `ConversationView` display twin / `EmbeddedConversation` in a read-only mode) instead
   of hand-rolled bubbles — kill the drift, keep the surface.

2. **Subject-keyed arena rows have no erasure/retention.** `evals:arena-match` keys on
   `raterSubject=user:<id>` (`arena.ts:24,53`) with no resolver/purger.
   *Honest alternative:* register a `registerSubjectKeyResolver` that maps
   `user:<id>` → the arena-match rows and a retention purger, in the **same phase** as
   any arena change — the keyed-registry contract the rest of the host follows.

3. **C6's read surface is a lane, not a page.** The ADR frames Phase 5 as
   `ctx.features.evals` (`ADR 0123:99`). *Honest alternative:* ship it as a chat-time
   **read tool** (LLM-EXCHANGE lane 1), pack-allowlisted, sharing the leaderboard route's
   access predicate (one helper, route + tool both call it; fail EMPTY without an acting
   user) — not a new envelope kind, not MCP.

---

## Demolition list (with regression pins)

- **`ArenaPage.Pane` bespoke bubbles** (`ArenaPage.tsx:33-36,49-74`) — replace with the
  shared read-only feed renderer. *Pin:* a test asserting the arena panes render via the
  shared conversation-feed component (import assertion) so a re-hand-rolled `MSG`/`USER_MSG`
  const fails the suite.
- **Bespoke arena composer** `<input>`+`<button>` (`ArenaPage.tsx:177-188`) — fold into the
  shared composer primitive (one prompt fanned to both panes). *Pin:* assert the composer
  is the shared component, not a raw `<input type="text">` inside `features/evals`.
- **Nothing else is demolished.** The leaderboard table, org picker, vote buttons, math,
  and stores are all keep-as-is (PAGE-LEGIT/RIDES). This feature is **not** a theater
  teardown — it is a small de-duplication + two compliance seams + one deferred tool.

---

## New-code inventory (small, as it should be)

1. **A read-only feed adapter** for the arena panes — reuse `ConversationView`'s bubble
   rendering in a display-only mode (additive chassis prop; other consumers byte-unchanged).
   No new bubble styling.
2. **`registerSubjectKeyResolver` + `registerRetentionPurger`** for `evals:arena-match`
   (+ decide `evals:arena-rating` is a rebuildable cache, so purge-and-replay, per the
   ADR's own "rebuildable cache" framing, ADR 0123:66).
3. **One agent read-tool** `evals.leaderboard` (`registerFeatureAgentTool`) sharing the
   leaderboard route predicate — the C6 chat-first add. Pack-allowlisted, not added to the
   ADR 0315 default-on baseline.
4. Regression pins above. **No new workflow, no node pack, no envelope kind, no RFC** —
   confirmed host-ext (ADR 0123:14,114).

---

## Phased plan (each phase closes with /code-review + /ux-review, fixes applied)

- **Phase 1 — compliance seams first (never demolish before the replacement works).**
  Add the arena-row subject-erasure resolver + retention purger (Blocker 2). Gate: backend
  vitest green + an erasure test proving a DSAR erase removes a user's arena matches.
- **Phase 2 — de-duplicate the arena feed.** Introduce the read-only feed adapter and
  route `ArenaPage.Pane` through it; then delete the bespoke `MSG`/`USER_MSG` consts and
  the raw composer, landing the regression pins. Gate: `( cd frontend/react && npm run build )`
  (the token/CSS integrity chain) + the existing `ArenaPage.test.tsx` still green.
- **Phase 3 — the deferred chat-first surface (C6).** Ship the `evals.leaderboard` read
  tool + pack allowlist so the ONE chat answers "which model wins for X" from the existing
  board. Gate: the LLM-exchange parity tests + a tool-authz-parity test (tool and route
  share the predicate; tool fails EMPTY without an acting user). Add its `docs/steward/LLM-EXCHANGE-AUDIT.md`
  row + tripwire.

## Deferred honestly

- **C6 chat model-picker tool** — declared by the ADR (Phase 5, matrix rows 3–4), not
  built. Deferred visibly here; do NOT paint it as present.
- **OQ-1 cold-start / low-N confidence note, OQ-2 query-aware re-rank** (ADR 0123:108-109)
  — real follow-ons, out of this port's scope; leave stated, not faked.

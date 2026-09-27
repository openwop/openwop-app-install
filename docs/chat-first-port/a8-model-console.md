# Model console (unit A8) — chat-first port review

Scope: `backend/typescript/src/features/{model-router, models, prompts}` +
`frontend/react/src/features/{model-router, models}` + the prompts UI
(`frontend/react/src/prompts/`, `frontend/react/src/chat/promptCommands.ts`).
Read-only audit. Cited `file:line` throughout.

> **Headline:** This unit is overwhelmingly operator-config + read-only
> projection + a chat-composer affordance that **already rides the ONE chat** —
> very little here is "intelligence expressed by intent," and what exists is
> wired correctly. The per-turn router genuinely RIDES the dispatch engine
> (`dispatchTurn.ts:70` stamps `run.metadata.modelRoute`, read verbatim on
> fork). The one real defect is **THEATER inside** the router config: of the six
> rule kinds the admin UI offers, the `attachment` and `intentIs` kinds — and
> the multimodal/intent bumps of `difficultyAtLeast`, and the ADR's headline
> "attachment ⇒ vision-only" invariant — **can never fire**, because the single
> ignition site never populates `features.hasAttachment` or `features.intent`,
> and the entire intent-classifier subsystem has zero non-test callers.

---

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Per-turn model routing at dispatch | `maybeStampModelRoute` → `resolveModelRoute` → `run.metadata.modelRoute`, read verbatim by `resolveConversationModelTarget` at every dispatch site (`dispatchTurn.ts:56,70,92,193,298`; `conversationExchange.ts:487`) | **RIDES** | Leave alone — genuine, replay-safe engine ride |
| Enable/disable routing per org | `setRouterEnabled` gates `resolveModelRoute` (returns null when `!enabled`, `resolveRoute.ts:24`) | **RIDES** (thin) | Leave |
| Routing-rule config manager (`/model-router`) | Admin CRUD of `when → target` rules (`ModelRouterPage.tsx`) | **PAGE-LEGIT** | Keep as operator page; optionally add a chat-driven "set a routing rule" agent tool later (enhancement, not demolition) |
| `attachment` rule kind | Offered in UI (`ModelRouterPage.tsx:29`), validated + stored (`configService.ts:38`), but `hasAttachment` never set at ignition | **THEATER** | Populate `features.hasAttachment` at the stamp site, or drop the kind |
| `intentIs` rule kind + classifier | UI offers it (`ModelRouterPage.tsx:29`); `classifyTurnIntent`/`resolveModelRouteWithIntent`/`parseIntentLabel` have **zero non-test callers** | **THEATER** | Wire `resolveModelRouteWithIntent` at ignition, or remove the kind + dead files |
| `difficultyAtLeast` rule kind | Token tiers work; attachment + intent bumps (`routeTurn.ts:63-64`) are dead (inputs never set) | **THEATER (partial)** | Same fix as above unblocks the bumps |
| `cooldownMs` sticky window | Validated + stored (`configService.ts:78`); UI never sets it; ignition passes no `state` (`dispatchTurn.ts:70`), and stamp-once makes it moot | **THEATER (latent)** | Drop the field or document it as inert under stamp-once |
| "attachment ⇒ vision-capable target" invariant | `eligible()` gates on `features.hasAttachment` (`routeTurn.ts:104-107`) — never true in prod | **THEATER** | Same root cause; fixed by populating `hasAttachment` |
| Models console hub (`/models`) | Projects tabs from FEATURES manifest via `visibleHubRoutes` — no second registry (`ModelsHubPage.tsx:31`) | **PAGE-LEGIT** | Leave — exemplary no-parallel projection |
| Leaderboard tab | Projected from `evals` feature into the hub | **PAGE-LEGIT** | Out of unit; leave |
| Models walkthrough spotlight | One-step `registerPageSpotlight` over shared registry (`walkthroughActions.ts`) | **ADAPTER** | Leave |
| Prompt-library catalog CRUD (backend `prompts`) | Org-scoped entries that **reference** prompt-store templates (`promptRef`), never copy (`promptLibraryService.ts:52-59`) | **ADAPTER** | Leave — explicitly "no parallel prompt store"; SSoT preserved |
| `/p-<slug>` chat commands | Library entries surfaced as slash commands via the existing `CommandRegistry` (`promptCommands.ts:28`) — no bespoke composer | **RIDES** | Leave — this is the chat-first win |
| `ctx.features.prompts` workflow surface | Node reads/renders entries mid-run through ADR 0014 seam, reusing the same `renderEntry` (`promptSurface.ts:14`) | **RIDES** (thin) | Leave |
| Prompt-store editor (`/prompts`) | CRUD of user prompts in **localStorage only** (`userPrompts.ts:2,32`) merged with bundled samples | **PAGE-LEGIT** | Keep; see SSoT-split note below |

Verdict tally: **R=4, A=2, P=0, T=5, PL=4** (the five THEATER rows are all
sub-capabilities of the ONE otherwise-RIDES router feature — inert rule kinds and
a dead invariant, not five separate features; no PARALLEL architecture found in
this unit).

---

## Blockers (from scouting) — each with the honest alternative

**B1 — The router's ignition site starves the selector of half its inputs (the
core THEATER).**
`maybeStampModelRoute` (`dispatchTurn.ts:56-80`) is the ONLY caller of
`resolveModelRoute` (grep: `dispatchTurn.ts:70` is the sole non-test caller). It
builds `TurnFeatures` with **only** `tokenEstimate` and `conversationKind`
(`dispatchTurn.ts:66-69`). It never sets `hasAttachment`, and it calls
`resolveModelRoute` (not `resolveModelRouteWithIntent`), so `features.intent` is
never populated. Consequences, all invisible to the operator:
- an `attachment` rule never matches (`matches()` reads `hasAttachment`,
  `routeTurn.ts:112`);
- an `intentIs` rule never matches (`features.intent` is always `undefined`);
- `difficultyAtLeast` collapses to a pure token tier — its attachment/intent
  bumps (`routeTurn.ts:63-64`) never apply;
- the ADR's headline safety invariant "an attachment turn MUST route to a
  vision-capable target" (`routeTurn.ts:104-107`) never engages.

The operator saves "when intent is code → route to Opus", the UI renders it as a
live rule (`ModelRouterPage.tsx:42` `condLabel`), and every code turn silently
falls through to `fallback`. Painted green; law #2 + law #6.
*Honest alternative:* at the stamp site, (a) pass `hasAttachment` derived from
the turn's message parts, and (b) call `resolveModelRouteWithIntent` (which
already gates the classify LLM call on `rules.some(intentIs)`,
`resolveRouteWithIntent.ts:33`) instead of `resolveModelRoute`. That is exactly
the wiring `resolveRouteWithIntent.ts` was built for and never received. If that
wiring is not wanted, **remove** `classifyIntent.ts` + `resolveRouteWithIntent.ts`
and drop `attachment`/`intentIs` from `COND_KINDS` — do not ship inert rule kinds.

**B2 — ADR 0130 status line is stale in both directions.** It says Phase 3c
(write-side stamp) is "pending" and Phase 4 (classify) is "pending"
(`docs/adr/0130-...md:3`). In fact Phase 3c **did ship** (`maybeStampModelRoute`
is wired at `conversationExchange.ts:487`), while Phase 4 genuinely did NOT — yet
Phase 5 FE ships the `intentIs` rule kind to operators anyway. The ADR must be
corrected (per the CLAUDE.md "correct, don't rewrite" rule): 3c → implemented,
and Phase 5 should not have exposed a Phase-4-dependent rule kind ahead of its
classifier.

**B3 — Prompt-store SSoT split (data-integrity, not chat-first).** User-authored
prompts live in **localStorage only** (`userPrompts.ts:2`, "local-ONLY, with no
backend counterpart"). The library catalog's `assertPromptRef` validates
`promptRef` against the **backend** `getTemplate`/`promptStore`
(`promptLibraryService.ts:54-58`), which cannot see a localStorage user prompt.
So a prompt authored in `/prompts` cannot be referenced by a library entry — the
two "prompt stores" don't share a source of truth across the client boundary.
Not a chat-first blocker; filed as a cross-layer TODO (record, don't hack).

---

## Demolition list (with regression pins)

This unit has **almost nothing to demolish** — no bespoke "talk to AI" panel, no
parallel approvals/conversation/owner shadowing. The only removals are the inert
theater, and only if B1 is resolved by *dropping* rather than *wiring*:

- **If not wiring the classifier:** delete `classifyIntent.ts` and
  `resolveRouteWithIntent.ts`; remove `'intentIs'` and `'attachment'` from
  `COND_KINDS` (`ModelRouterPage.tsx:29`) and from `asCondition`
  (`configService.ts`). *Regression pin:* a test asserting the router config UI
  offers no rule kind whose feature the ignition site cannot populate (a
  resurrected `intentIs` option fails the suite).
- **`cooldownMs`:** drop from `ModelRouterConfig` + `validateRouterConfig`
  (`configService.ts:78`) unless a re-resolving (non-stamp-once) path is ever
  built. *Regression pin:* assert `TurnFeatures`/route state is never threaded
  unused.

**Do NOT demolish:** `ModelRouterPage` (legitimate operator config),
`ModelsHubPage` (exemplary projection), `promptCommands.ts` (rides the chat),
the prompt-library catalog (rides the prompt-store SSoT). No form here
substitutes for a platform primitive.

---

## New-code inventory (SMALL — this is a wiring fix, not a port)

1. At `maybeStampModelRoute` (`dispatchTurn.ts:66`): add `hasAttachment`
   (derived from the exchange's message parts, already available to
   `conversationExchange` at the call site `:487`).
2. Swap `resolveModelRoute` → `resolveModelRouteWithIntent` at the same site,
   passing `userText` (already in scope) so an `intentIs` rule triggers the
   gated classify call.
3. ADR 0130 correction notes (3c implemented; intentIs gated on Phase 4).
4. Regression pins above.
5. (Optional enhancement, not required) a `registerFeatureAgentTool`
   `model-router.setRule` sharing `requireOrgScope('workspace:write')` so an
   admin can add a routing rule from the ONE chat — turning the config page into
   a chat-drivable surface per the ADR 0058 pattern. Deferred; the page is
   legitimately page-shaped without it.

No new workflows, nodes, canvases, interrupt cards, or A2UI surfaces are needed —
this unit exposes no in-chat card of its own (the `/p-` commands render as plain
user turns, `promptCommands.ts:33-34`), so the card-mechanism test is n/a.

---

## Phased plan (gated on real gates)

- **Phase 1 — honesty first (compliance seam):** correct ADR 0130 status; add
  the regression pin that forbids an un-ignitable rule kind. Gate: backend
  vitest + `/code-review`.
- **Phase 2 — ignite or amputate:** either wire `hasAttachment` +
  `resolveModelRouteWithIntent` at the stamp site (preferred — the classifier is
  built and gated), OR remove the `attachment`/`intentIs` kinds + dead files.
  Gate: backend vitest (a new test asserting an `intentIs` rule actually routes a
  classified turn), `/code-review`, `/ux-review` on `ModelRouterPage`.
- **Phase 3 — tidy latent config:** resolve `cooldownMs` (drop or document).
  Gate: `npm run ci`.
- **Phase 4 (optional) — chat-drive the config:** ship the `model-router.setRule`
  agent tool. Gate: `/grade-ai-exchange` (authority-parity: tool shares the
  route predicate), `/code-review`, `/ux-review`.

Never demolish before the replacement (the wiring) is green.

---

## Deferred honestly

- **B3 prompt-store SSoT split** (localStorage user prompts unreachable by
  library `promptRef`) — a cross-layer data-integrity gap, filed as a TODO for
  the prompts/data owner, not patched locally.
- **`/p-<slug>` `{{var}}` insert-for-edit** — already deferred in-code
  (`promptCommands.ts:8`), needs a composer `setText` API; v1 fires the canned
  prompt. Honest deferral, left as-is.
- **Chat-driven routing config (Phase 4)** — genuinely optional; the operator
  page is page-legit today, so this is an enhancement, explicitly not a blocker.

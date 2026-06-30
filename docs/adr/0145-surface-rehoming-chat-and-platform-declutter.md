# ADR 0145 — Surface re-homing: a Chat-deployment console, a Models console, and Platform declutter

Status: implemented

Owner: openwop-app frontend platform

Composes: ADR 0001 (feature-package), ADR 0144 (Access Hub — reuses its `hubTab`
projection + `ui/Tabs` + embedded-context primitive), ADR 0123 (eval leaderboard),
ADR 0125 (scheduled chats), ADR 0126 (channels), ADR 0127 (chat widget),
ADR 0137 (ambient work graph). Touches the nav contract in `chrome/features.tsx`.

RFC verdict: **none — frontend information-architecture only; touches no wire.**
(A thin **toggle-only** backend feature per console was needed after all — see the
implementation record's correction note; it adds no route/service/endpoint.)

## Implementation record (2026-06-26)

All phases shipped on branch `feat/adr-0145-rehoming`. Phase 0's gate (ADR 0144 on
`main`) was satisfied by PR #889; the work is built directly on the merged primitive.

| Phase | Commit | What |
|---|---|---|
| 1 | `6ca4670e` | Generalize the hub primitive — `HubId` discriminator + optional `group`; move projection→`chrome/hubProjection.ts` + context→`chrome/hubContext.tsx` (core); `useAccessHub`→`useHub` |
| 2 | `6797f2b2` | Models console (`/models`) + toggle-only backend feature; tag model-router + evals |
| 3 | `4ef59a50` | Chat deployment console (`/chat-deployment`) + toggle-only backend feature; tag scheduled-chats + chat-widget |
| 4 | `eae86c26` | Channels → Workspace tier/rail; Work patterns → Operations |
| 5 | `92ef7648` | Value-framing lede copy for the five surfaces (en/es/fr/pt-BR) |
| 6 | `90c0ee4a` | Manifest/projection tests (`chrome/__tests__/adr0145-rehoming.test.ts`) + `resolveNav` invariant generalization |

Gates: frontend `tsc` + `npm run build` (token/CSS/i18n integrity) + backend `tsc`
all green; new tests pass. The full vitest suite shows 6 failures that **pre-exist
on `origin/main`** (order-dependent `useFeatureAccess`-mock flakiness in unrelated
page/sandbox tests — verified by running them on a pristine `origin/main` checkout);
they are not regressions from this work.

**Correction notes (decisions that overturned the plan below — kept per the
ADR-history rule):**

- **Backend half exists (RFC verdict refined).** §Feature-Evaluation-Matrix row 1
  said "frontend-only — no backend half anywhere." In practice each console needs a
  **toggle-only `BackendFeature`** (`backend/.../{models,chat-deployment}/feature.ts`,
  `registerRoutes: () => {}`) so the toggle resolves **server-side** — the FE is never
  the gate authority (ADR 0001 §3.4). This mirrors the shipped `access-hub/feature.ts`.
  Still no route/service/endpoint/wire.
- **`hubTab` shape (vs §1).** Shipped as `hub?: HubId` **optional, default `'access'`**
  + kept `group?: string` (not the proposed required `hub` + renamed `section`). The
  default means the Access Hub's existing tabs needed **no migration** — zero churn on
  the just-merged 0144 surface. The projection helper + embed context were **moved to
  `chrome/` (core)**, not aliased, so all three consoles import them without a
  feature→feature edge.
- **Nav collapse via `hiddenWhenFeature`, not redirects (vs §2/§3/Phase 6).** ADR 0144
  shipped an inverse-gate (`nav.hiddenWhenFeature`) rather than redirects; ADR 0145
  adopts the same precedent. Legacy paths (`/leaderboard`, `/model-router`,
  `/scheduled-chats`, `/widgets`) stay **directly reachable** (deep links render the
  standalone page); only their **nav entries** collapse when the console toggle is ON.
  No `Navigate` redirects were added; the Phase-6 test asserts this "no-redirect"
  behavior. Reversible by reverting the manifest.
- **OQ-2 resolved:** both consoles live in the existing **`Platform`** nav group (no new
  top-level group) — the lean stated in the open question.
- **Tab gating — each tab mirrors its surface's toggle state.** A `hubTab.featureId`
  is set **iff** the surface is toggle-gated. model-router + chat-widget are
  always-on → no `featureId` (tab always shows, like Keys/Orgs in 0144). evals +
  scheduled-chats were **re-graduated to toggle-gated** on `main` between this
  branch's fork and merge (PR #895) → their tab **and** their standalone nav both
  carry the toggle id (`evals` / `scheduled-agent-chats`), so a disabled feature
  shows in **neither** the rail nor the console (no disabled-but-clickable tab).
  > *Correction (post-merge review follow-up):* an earlier revision left the
  > re-graduated tabs un-gated to match an un-gated standalone nav. The review
  > called the disabled-but-clickable tab out; the resolution gates **both** the
  > tab and the nav on the toggle (the standard toggle-gated pattern), which is the
  > fully-consistent end state. Direct-URL deep links still resolve and render the
  > page's own disabled state.

> Authored from an `/architect` + `/frontend-design` evaluation (2026-06-25) of five
> admin surfaces a reviewer flagged as "UI bloat with no explanation":
> `/leaderboard`, `/scheduled-chats`, `/channels`, `/widgets`, `/work-patterns`.
> The finding: **none is bloat and none is a parallel chat system** — every one
> correctly reuses the ONE chat / the run store / the scheduler. The problem is
> purely **information architecture + value-framing**: five unrelated verbs dumped
> as sibling tables into the `Platform` nav group (a junk drawer), each with a
> table-describing lede that never says *why it exists* or *how it relates to the
> chat the user already knows*.

---

## Context

The `Platform` admin nav group has become a catch-all. Five of its entries are
each a *different kind of thing* wearing the same costume (admin-tier · org-picker
→ DataTable → row actions), so they read as undifferentiated clutter:

| Surface | Path | ADR | What the operator is really doing | Relationship to the ONE chat |
|---|---|---|---|---|
| Model leaderboard | `/leaderboard` | 0123 | **Analyze** model quality (Elo/win-rate from feedback) | Reads `MessageFeedback` the chat captured — a lens *over* chat output |
| Scheduled chats | `/scheduled-chats` | 0125 | **Automate** — run a chat turn on a cadence | Drives the existing chat tool-loop on a cron tick |
| Channels | `/channels` | 0126 | **Host** team messaging | A `type:'channel'` on the existing `Conversation`; an end-user *destination* |
| Chat widgets | `/widgets` | 0127 | **Distribute** the chat to public sites | Public gateway mounts `EmbeddedConversation` |
| Work patterns | `/work-patterns` | 0137 | **Discover** reusable workflows from run history | A read-model over the run store; hands off to the builder |

The pain is purely **information architecture**, identical in shape to the pain
ADR 0144 fixed for credentials/access:

1. **Five verbs, one bucket.** Analyze / automate / host / distribute / discover are
   not one concept; co-locating them flat hides each one's purpose.
2. **No through-line to the chat.** Nothing on `/scheduled-chats` or `/widgets`
   says "this is *your AI chat*, scheduled / embedded." The ledes describe the
   grid, not the value.
3. **A misfiled destination.** `/channels` is where people *go to send messages* —
   an end-user surface like the chat itself — yet it sits in `admin / Platform`.

This ADR re-homes the five by verb, reusing the ADR 0144 console primitive where
consolidation helps, and fixes the value-framing copy on each. It is the IA
correction; it ships no new behavior.

## Boundaries & pre-existing-surface audit (MANDATORY — Step 3)

The lead risk on any consolidation is standing up a *second* system. Verified it is
not one here:

- **No new owner, store, endpoint, or wire.** Each surface keeps its existing owner
  (`leaderboardService`, `scheduledChatService`, `channelService`, `widgetService`,
  the work-graph projection) verbatim. This ADR moves **nav entries and page
  chrome only**. No backend half.
- **No parallel read model (the `build-on-orchestration` invariant).** The two new
  consoles **project from the existing `FEATURES` manifest** exactly as ADR 0144's
  Access Hub does — `FEATURES.filter(r => r.hubTab)`, gated by the same
  `resolveNav`/`isVisible` path. No `*Registry`, no second nav system, no demo-seed,
  no bespoke dashboard. (This is the failure mode the `/insights-suite` review
  caught; this ADR explicitly does not repeat it.)
- **Route/id collision check.** `grep -rn "'/models'" "'/chat-deployment'"` across
  `frontend/react/src` + `backend/typescript/src` → **0 hits**; the
  `chat-deployment` and `models` feature ids and the `'chat'`/`'models'` hub-group
  values are free.
- **Import direction.** The consoles render Evals, Scheduled-chats, Chat-widget,
  Model-router (all **feature-packages**) as tab bodies. As in ADR 0144, the legal
  aggregation point is `chrome/` (the composition root that already builds
  `FEATURES`); the consoles project from `FEATURES`, so there is **no
  feature→feature import**.
- **Dependency on ADR 0144 (sequencing, not duplication).** The `hubTab` field,
  `ui/Tabs`, the `AccessHub*` embedded-context, and the `FEATURES`-projection
  selector are being built **right now** on `feat/adr-0144-access-hub` (Phases 1–3
  landed). This ADR **must not fork them**. It is sequenced to land **after ADR 0144
  merges**, then generalizes that primitive (see Decision §1) rather than copying it.

## Decision

Re-home the five surfaces by verb into **four destinations**, and fix each page's
value-framing copy. Two destinations are new **consoles** built on the ADR 0144
projection primitive; two are re-files into existing groups.

### 1. Generalize the ADR 0144 hub primitive from one console to many

ADR 0144 shipped a single `/access` console whose `hubTab.group` is a 2-value enum
(`'credentials' | 'identity'`) describing *sub-sections within that one console*.
To host additional consoles without a second nav system, generalize the annotation
(in `chrome/featureTypes.ts`, **after** ADR 0144 merges) so a route declares **which
console** it joins and **which section** within it:

```ts
interface FeatureHubTab {
  hub: 'access' | 'chat-deployment' | 'models';  // which console (was implicit = 'access')
  section?: string;                              // sub-group within the console (the old `group`)
  scopes?: ('workspace' | 'personal')[];         // ADR 0144 — unchanged
  order?: number;
  featureId?: string;
}
```

- The Access Hub's selector becomes `FEATURES.filter(r => r.hubTab?.hub === 'access')`;
  the two new consoles filter on their own `hub` value. **One manifest, one gating
  path, one `ui/Tabs`, one embedded-context** — three thin console shells over the
  same projection. No `accessHubRegistry`, no per-console read model.
- The `AccessHubProvider`/`useAccessHub()` embedded context (page suppresses its own
  `PageHeader` when `embedded`) is renamed/generalized to a `HubProvider` the three
  consoles share. Each tab body already has (or gains, per ADR 0144 Phase 4) a
  header-less variant.
- **Migration of ADR 0144's two values** (`group:'credentials'|'identity'` →
  `hub:'access', section:'credentials'|'identity'`) is a mechanical rename done in
  the same change, with the 0144 author's sign-off (OQ-1).

### 2. Chat-deployment console (`/chat-deployment`) — Scheduled chats + Widgets

The one place the reviewer's "AI chat admin settings" intuition is exactly right.
Both surfaces answer **"how does the AI chat reach people without someone sitting in
the UI?"** — automatically on a schedule, or embedded on a public website.

```
┌─ Chat deployment ─────────────────────────────────────┐
│  Put your AI chat to work without someone in the seat. │
│                                                        │
│  [ Scheduled runs ] [ Website widget ]   ← tabs        │
│                                                        │
│   <mounted owner: ScheduledChatsPage / WidgetsPage>    │
└────────────────────────────────────────────────────────┘
```

- Tabs are `scheduled-chats` (`hubTab:{hub:'chat-deployment', section:'automate',
  order:1}`) and `chat-widget` (`section:'distribute', order:2}`). Both drop their
  standalone `Platform` `nav` blocks; the console gets
  one nav entry (`group:'Platform'` or a new `'Chat'` group — see OQ-2),
  `featureId:'chat-deployment'`.
- Old paths `/scheduled-chats` and `/widgets` persist as routes and **redirect** to
  `/chat-deployment?tab=…` (no broken deep links), reversible by reverting the
  manifest diff.

### 3. Models console (`/models`) — Model routing + Leaderboard

`model-router` (today stranded in `Access & data`) and `evals/leaderboard` (today in
`Platform`) are the **same concern from two sides**: *which model handles a turn*
(routing) and *which model is winning* (leaderboard). They belong together.

```
┌─ Models ──────────────────────────────────────────────┐
│  Choose which model answers, and see which performs.   │
│  [ Routing ] [ Leaderboard ]                           │
│   <mounted owner: ModelRoutingPage / LeaderboardPage>  │
└────────────────────────────────────────────────────────┘
```

- Tabs: `model-router` (`hubTab:{hub:'models', section:'route', order:1}`) and
  `evals` (`section:'measure', order:2}`). Both drop their standalone `nav`; one
  console nav entry, `featureId:'models'`. Old paths redirect.
- This also removes `model-router` from `Access & data`, which it never thematically
  fit (it is not a credential/identity surface and was **not** in ADR 0144's
  consolidation set).

### 4. Channels → Workspace nav (a destination, not a setting)

`/channels` is where end users **send and read messages** — a sibling of the chat
itself, not an admin setting. Re-tier it `workspace` and move it to the `Workspace`
nav group, slotting between **Chat** (`order:10`) and **Agents** (`order:20`):

- `features/channels/routes.tsx`: `tier: 'admin' → 'workspace'`,
  `nav.group: 'Platform' → 'Workspace'`, `nav.order: 15`.
- Route-level authz is unchanged (channel membership is already default-deny at the
  service); the tier change only governs **nav visibility**, not access — message
  routes stay membership-gated server-side.

### 5. Work patterns → Operations (a read-model over run history)

`/work-patterns` mines the run store for recurring tool-sequences and suggests
workflows, handing accepted ones to the builder. It is the canonical "build on
orchestration, surface via the existing run surfaces" feature — so it belongs with
the other run-derived surfaces (Runs, Mission Control, Boards, Library) in
**Operations**, not in the Platform junk drawer:

- `features/ambient-work-graph/routes.tsx`: `nav.group: 'Platform' → 'Operations'`
  (tier stays `admin`; ordered after Library). No console — it is a single,
  self-explanatory surface once its lede is fixed (§6).

### 6. Value-framing copy (every surface, console or not)

Each page's `lede` and empty state is rewritten to say *what it is for, in chat /
run terms*, with the canonical example — the placement-independent fix that directly
answers "I have no idea what these are for." Examples (final copy in i18n):

- **Widget:** "Put your AI chat on your public website. Visitors talk to it without
  signing in — you choose which sites and set usage limits."
- **Scheduled runs:** "Have an agent run a chat on a schedule — a daily standup
  digest, a Monday report — and post the result to a conversation."
- **Leaderboard:** "See which model your team prefers, ranked by thumbs-up/down on
  real answers."
- **Routing:** "Send each chat turn to the right model by rule — cheaper models for
  simple turns, stronger ones when it matters."
- **Channels:** "Group messaging for your team and agents, on the same conversation
  engine as chat."
- **Work patterns:** "We noticed these steps repeating across your runs. Turn a
  pattern into a reusable workflow in one click."

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package (ADR 0001)** | Two new frontend-only shells: `features/chat-deployment/` + `features/models/` (each a `routes.tsx` projecting from `FEATURES`). Appended to `FRONTEND_FEATURES`. Channels/work-patterns/model-router/evals: **manifest edits only** (group/tier/`hubTab`). **No backend half anywhere.** |
| 2 | **Toggle + admin UI** | New toggles `chat-deployment`, `models`, `bucketUnit:'tenant'`, **default OFF** (OFF = today's scattered nav; ON = consoles + redirects + collapsed nav — instant rollback). Channels/work-patterns keep their existing toggles; only their `nav.group`/`tier` change. |
| 3 | **Workflow surface (ADR 0014)** | **None.** Pure IA. |
| 4 | **Node pack** | **None.** |
| 5 | **AI-chat envelopes** | **None.** |
| 6 | **Agent pack** | **None.** |
| 7 | **Public surface** | **None added.** (The chat-widget's *existing* public gateway is unchanged and unmoved — only its admin CRUD page is re-homed.) |
| 8 | **RBAC + isolation (ADR 0006)** | **No new routes, no new authz.** Each mounted/​moved surface keeps its route-level authz verbatim. Console tab visibility reuses the same `resolveNav`/`isVisible` gate as the rail. Channels' `tier:'workspace'` changes **nav visibility only**; message routes stay membership-gated server-side (fail-closed unchanged). |
| 9 | **Replay / fork** | **N/A** — changes no run behavior; stamps nothing on `run.metadata`. |
| 10 | **Frontend** | Two console shells reuse the generalized `hubTab` primitive + `ui/Tabs` + the shared `HubProvider` (ADR 0144); value-framing copy via i18n (en/es/fr/pt-BR); `ui/` cohesion, a11y (roving tabs, visible focus), tokens, light/dark (`/ux-review`, `/browser`). |

## Phased plan

0. **Gate: ADR 0144 merges to `main`.** This ADR builds on its primitive; do not
   start console work until then (avoids churn on the in-flight branch).
1. **Generalize the hub primitive** — `hubTab.group` → `{hub, section}`
   (`chrome/featureTypes.ts`); migrate the two Access-Hub values; rename
   `AccessHubProvider`/`useAccessHub` → shared `HubProvider`/`useHub`; selector
   filters by `hub`. Verify `/access` still renders identically (render/router test).
2. **Models console** — `features/models/` shell (`hub:'models'`); tag `model-router`
   + `evals` with `hubTab`; drop their standalone `nav`; add the `models` nav entry +
   `models` toggle; redirect `/model-router` + `/leaderboard` → `/models?tab=…`.
3. **Chat-deployment console** — `features/chat-deployment/` shell
   (`hub:'chat-deployment'`); tag `scheduled-chats` + `chat-widget`; drop their `nav`;
   add the `chat-deployment` nav entry + toggle; redirect `/scheduled-chats` +
   `/widgets` → `/chat-deployment?tab=…`.
4. **Re-file Channels + Work patterns** — manifest-only: Channels →
   `Workspace`/`tier:'workspace'`/`order:15`; Work patterns → `Operations`.
5. **Value-framing copy** — rewrite `lede` + empty-state strings across all five
   surfaces + the two console intros, in all four locales.
6. **Verify** — `( cd frontend/react && npm run build )`; a render/router test
   asserting the four legacy paths redirect into their consoles, Channels appears in
   the workspace rail, Work patterns under Operations, and each console rail shows
   one entry when its toggle is ON; `/browser` light+dark; flip toggles ON.

## Alternatives weighed

- **One "AI chat settings" console with all five as tabs** (the original ask) —
  **rejected**: it merges five unrelated verbs (analyze/automate/host/distribute/
  discover). Leaderboard is observability, not chat config; Channels is an end-user
  destination, not a setting; Work-patterns is run-history discovery. Same
  scope-incorrectness ADR 0144 rejected for its flat-tab-strip alternative.
- **A new bespoke aggregator page with its own read model** — **rejected**: the
  `build-on-orchestration-not-parallel-surfaces` invariant. The consoles project
  from `FEATURES`; no second system.
- **Leave Channels in admin** — rejected: it is a messaging destination users open
  to *do work*, not configure; admin burial hurts discoverability.
- **A standalone Models *group* (two flat nav entries) instead of a console** —
  viable, lighter. Chose a console for parity with the chat-deployment console and
  to keep the rail to one entry; revisit if a console feels heavy for two tabs (OQ-3).
- **Copy-fix only, keep all nav** — rejected as the *whole* answer (defers the
  clutter), but its copy work is folded in as Phase 5 — the placement-independent win.
- **Leave as-is** — rejected: the reported clutter + opacity.

## PRD-vs-architecture corrections

- The plain-language ask ("an AI chat admin settings page where these are
  configuration tabs") implied one bucket; corrected to **four homes by verb**,
  because the five surfaces are genuinely analyze / automate / host / distribute /
  discover — one tab strip would be scope-incorrect, not just dense. Two of the five
  (scheduled + widgets) *do* form the coherent "chat deployment" pair the ask
  intuited.

## Open questions

1. **`hubTab` generalization sign-off.** The `{hub, section}` rename touches the
   in-flight ADR 0144 surface. Confirm with the 0144 author whether to (a) land the
   generalization *in* the 0144 branch before merge, or (b) as the first commit of
   this ADR's branch after 0144 merges. (Leaning **b** — keeps 0144 shippable.)
2. **Console nav group.** Do the two consoles sit under the existing `Platform`
   group, or do we add a thin top-level placement (e.g. a `Chat` group holding the
   chat-deployment console)? (Leaning: keep both in `Platform` — they are admin
   tooling; adding groups re-fragments what we just consolidated.)
3. **Models as console vs group.** Two tabs is the floor for a console; if it reads
   thin, demote to a flat `Models` nav group (two entries). Decide after `/browser`.
4. **Channels tier change & RBAC.** Confirm no route currently relies on Channels'
   `admin` *tier* for visibility-as-authz (it should not — message routes are
   membership-gated server-side). Verify during Phase 4.
5. **Work-patterns home.** Operations (run-derived read-model) vs an Author-adjacent
   placement (it feeds the builder). Chose Operations per the "surface via run
   surfaces" rule; revisit if operators look for it next to Workflows.

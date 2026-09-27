# Chat widget + deployment console (unit A5) — chat-first port review

Scope: `backend/typescript/src/features/chat-widget`, `backend/typescript/src/features/chat-deployment`,
`frontend/react/src/features/chat-widget`, `frontend/react/src/features/chat-deployment`.

**Headline verdict: this unit already rides the engine.** It declares NO workflows, NO node
packs, NO agent packs, and creates NO runs — so there is no orphaned orchestration to ignite and
no second conversation/approval owner to reconcile. The chat-deployment console is a pure
composition surface (PAGE-LEGIT), and the chat-widget admin is honest config CRUD. The one real
finding is a **capability gap, not parallel architecture**: the public visitor dispatch runs a
bare single-turn completion with only the agent's `systemPrompt`, so a widget "bound to an agent"
delivers the persona's words but **none of the agent's tools/actions** — and the ADR defers this
honestly. Nothing here should be demolished; the port work is narrow and additive.

---

## Step 1 — Contract scouting (pinned evidence)

- **No workflow / node / agent / artifact packs declared.** A repo grep for
  `startWorkflowRun | conversationToolLoop | registerFeatureAgentTool | WorkflowDefinition | agent pack`
  across both backend packages returns **nothing**; `packs/` has no `chat-widget` reference. Both
  features are registered as plain `BackendFeature`s in `src/features/index.ts:187`. → There is no
  declared-but-unignited orchestration in this unit (no THEATER-of-workflow risk).

- **The public visitor dispatch does NOT ride the ONE chat engine.**
  `publicGateway.ts:118-123` calls `dispatchManagedChat({...})` directly with a two-message array
  (`{role:'system', content: agent.systemPrompt}` + the fenced visitor turn,
  `publicGateway.ts:112-117`). `dispatchManagedChat` is the shared **single-turn** managed-provider
  completion (same primitive `host/headlessAi.ts:141` and `host/exchange/dispatchTurn.ts:206` use).
  It is **not** `conversationToolLoop` (the tool-driving loop), and no `agentProfile`/tool grants are
  loaded. → The agent's tool allowlist is effectively **empty at runtime**; the persona is
  read-only-by-omission. The ADR states this: "Multi-turn sessions + tool-enabled dispatch are
  deferred follow-ons" (`publicGateway.ts:20-21`).

- **The embed renderer is a bespoke second chat UI — by necessity.** `EMBED_JS`
  (`publicGateway.ts:148-175`) is a self-contained vanilla-JS chat panel (button + list + input,
  `textContent`-only, JS-applied styles) served as a static string. It does **not** reuse
  `frontend/react/src/chat` / `EmbeddedConversation` — and cannot: the ONE chat is an auth+BYOK-gated
  React SPA component that can't be injected into an arbitrary third-party page. This is a justified
  divergence, not a demolishable parallel.

- **Owners it instantiates (RIDES), not shadows.** Config persists via the shared
  `DurableCollection` owner (`chatwidget:config`/`:tokenidx`/`:session`/`:day`,
  `widgetService.ts:37,44`, `capsTracker.ts:17-18`); dispatch rides the shared managed-provider owner
  (`dispatchManagedChat`) and the shared `getAgentRegistry()` (`publicGateway.ts:100`); roster
  lifecycle rides the shared `onRosterMemberDeleted` seam (`feature.ts:35`, ADR 0288). No second chat
  store, no conversation rows minted (dispatch is **stateless single-turn**, `publicGateway.ts:18-19`).

- **Authz predicate parity.** Admin routes all go through `requireOrgScope(req, 'workspace:read'|'write')`
  with IDOR-404 (`routes.ts:16-33`). The public gateway is deliberately unauth, gated by the
  unguessable `wgt_` capability token + Origin/Referer allowlist (`publicGateway.ts:54-68`,
  `originAllowlist.ts:34-42`), fail-closed with a uniform 404 to avoid an existence oracle. Tenant is
  always derived from the stored config, never the request (`widgetService.ts:110-128`).

- **chat-deployment is frontend-only by construction.** `chat-deployment/feature.ts:16` registers an
  empty `registerRoutes: () => {}` and a single `toggleDefault` (default OFF, tenant-bucketed) purely
  so the FE nav gate resolves server-side. The hub page projects its tabs from the `FEATURES` manifest
  via `visibleHubRoutes(FEATURES, isVisible, 'chat-deployment')` (`ChatDeploymentHubPage.tsx:31`) —
  no second registry; it composes existing owners' routes (Scheduled runs = the separate
  `scheduledAgentChatsFeature`; Website widget = this unit's `/widgets` tab, `chat-widget/routes.tsx:23`).

- **Executor/chassis constraints bounding the port.** Because the runtime is stateless single-turn
  over a HOST-owned managed key, giving the widget agent tools means driving `conversationToolLoop`
  from an **unauthenticated, cross-origin public surface charged to the tenant** — a new security
  perimeter (tool authz for an anonymous actor, prompt-injection→tool-action escalation). That is the
  real reason the ADR defers it, and any port MUST treat tool-enablement as its own security pass.

---

## Step 2 — Capability inventory + verdicts

### Verdict table
| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Provision / list / edit / rotate-token / delete a widget config (admin) | Org-scoped CRUD page → `requireOrgScope` routes (`routes.ts:16-33`, `WidgetsPage.tsx`) | **PAGE-LEGIT** | Keep. Honest config admin; rides `DurableCollection` + org-scope authz. |
| Copy the paste-ready embed snippet | `embedSnippet(token)` shown in a card (`WidgetsPage.tsx:115-133`) | **PAGE-LEGIT** | Keep. Read-only provenance of a capability credential. |
| Public config bootstrap (`GET /public/widget/config`) | Origin-gated public projection (`publicGateway.ts:72-78`) | **ADAPTER** | Keep. Thin read; returns only `{widgetId, agentId, caps}`, never token/tenant. |
| Public embed script (`GET /public/widget/embed.js`) | Static served vanilla-JS chat panel (`publicGateway.ts:139-175`) | **ADAPTER (justified 2nd UI)** | Keep. Cannot reuse the SPA chat on a third-party page; XSS/CSP-safe. Watch for drift vs the ONE chat's UX. |
| Public visitor dispatch (`POST /public/widget/message`) | Bare single-turn `dispatchManagedChat`, systemPrompt only, no tools/loop (`publicGateway.ts:81-125`) | **ADAPTER with a THEATER-adjacent gap** | Rides the managed-provider owner honestly, BUT the agent is toothless (tools ignored). Deferred honestly — see Blocker B1. |
| Per-session / per-day abuse caps | CAS-atomic counters (`capsTracker.ts:29-56`) | **RIDES** | Keep. Deterministic, replay-neutral, fail-closed. |
| Disable widgets when their agent/roster member is deleted | `onRosterMemberDeleted` consumer (`feature.ts:35`, `widgetService.ts:149-158`) | **RIDES** | Keep. Rides the shared roster-lifecycle seam (ADR 0288). |
| Always-on chat "deployment" console | Tabbed hub projecting FEATURES (`ChatDeploymentHubPage.tsx`) | **PAGE-LEGIT (composition)** | Keep. No second registry; composes existing owners. Nothing to port. |
| chat-deployment backend | Empty routes + one toggle (`chat-deployment/feature.ts`) | **PAGE-LEGIT** | Keep. Honestly frontend-only; the toggle exists only to gate the nav server-side. |

### Verdict tally
- RIDES = 2 (caps, roster-lifecycle disable)
- ADAPTER = 3 (public config, embed.js, visitor dispatch)
- PARALLEL = 0
- THEATER = 0 (the dispatch gap is a *deferred, declared* capability hole, not a claimed-but-fake one — counted as the ADAPTER's honest-deferral, not a standalone THEATER)
- PAGE-LEGIT = 4 (widget admin CRUD, embed-snippet card, deployment console, chat-deployment backend)

---

## Step 3 — Port tests (the ones that bite)

- **Agency test (fails, honestly deferred).** The widget binds an `agentId` and runs its
  `systemPrompt`, but `dispatchManagedChat` carries no tools and is not the tool loop
  (`publicGateway.ts:118`). Per the skill this is a "persona with no action tools driving nothing" —
  THEATER-adjacent. It escapes a hard THEATER verdict only because the ADR **declares** the limit
  (`publicGateway.ts:20-21`) rather than painting tool-use as working. → **Blocker B1.**
- **Ignition test (N/A — no workflows).** No `WorkflowDefinition` is declared, so there is no run to
  ignite and no missing igniter. This unit intentionally sits below the orchestration layer.
- **Card-mechanism test.** The public runtime renders plain assistant text in a bespoke panel; there
  are no A2UI surfaces, typed renderers, or interrupt cards — correct for a stateless single-turn
  public proxy. If tool-enablement lands (B1), any HITL it needs would surface in the authenticated
  reviews inbox (the agent's owning tenant), never on the anonymous embed.
- **Lifecycle test (one gap).** `chatwidget:config` has a lifecycle seam (roster-delete → disable) and
  the token index is maintained on mint/rotate/delete. But `chatwidget:session` and `chatwidget:day`
  counters (`capsTracker.ts:17-18`) have **no retention/TTL seam** — they accrue one row per
  `(widgetId, sessionId)` and per `(widgetId, day)` forever. Low severity (anonymous, no PII; keys are
  client-supplied opaque session ids), but it is unbounded growth on an unauthenticated write path.
  → **Deferred item D1.**
- **Honesty-loop test (passes).** Every status the admin page shows is backed by a real read:
  `enabled` → `StatusBadge` from the config row (`WidgetsPage.tsx:85`); the snippet → `embedSnippet`
  over the live token. No painted-green state.
- **Authority-parity test (passes).** One org-scope predicate gates all admin routes; the public
  surface has its own explicit (token + origin) predicate shared by both public routes via the single
  `gateWidget` helper (`publicGateway.ts:54-68`) — no per-route drift.

---

## Blockers (from scouting) — each with the honest alternative

- **B1 — Toothless widget agent (declared, deferred).** A widget bound to an agent runs only the
  persona text; the agent's tools/`agentProfile` grants are never loaded because dispatch is a bare
  `dispatchManagedChat` completion, not `conversationToolLoop` (`publicGateway.ts:112-123`).
  *Honest alternative / when to port:* keep it deferred **until** the security perimeter is designed —
  driving the tool loop from an unauthenticated cross-origin surface on a host-owned key means solving
  anonymous-actor tool authz and prompt-injection→action escalation first. When ported, it rides
  `conversationToolLoop` with a **read-only / explicitly-allowlisted** tool set per widget (never the
  ADR 0315 default action baseline), each tool sharing its HTTP route's access predicate, failing
  EMPTY without an acting user. This is a new RFC-scoped security pass, not a quiet flag flip.

- **B2 — The embed renderer can't be the ONE chat, and that's correct.** The skill's "reuse, never
  recreate" rule assumes an authenticated SPA surface. `EMBED_JS` is a legitimate exception (third-party
  page, no SPA/auth/BYOK). *Honest alternative:* do NOT demolish it; instead pin it against drift — its
  job is bounded (send text, render text). If it ever grows conversation state, tool cards, or
  interrupts, that is the signal to reconsider a shared headless conversation client, not to fork chat
  UX further.

---

## Demolition list (with regression pins)

**Nothing to demolish.** There is no bespoke approve/submit button duplicating HITL, no second chat
store, no orphaned workflow, no shadowed owner. The two "second surfaces" (config CRUD page, embed.js)
are PAGE-LEGIT / justified-ADAPTER and stay.

Regression pins to ADD (guard the honest boundaries, since there is nothing to tear out):
- **PIN-1 (agency honesty):** a test asserting the public dispatch path calls `dispatchManagedChat`
  with `messages` limited to `[system(persona), user(fenced)]` and **no tools** — so if someone wires
  tools onto the public surface without the B1 security pass, the suite goes red until the authz seam
  exists.
- **PIN-2 (origin default-deny):** assert `originAllowed(undefined|'', domains) === false` and
  `originAllowed('https://acme.com.evil.com', ['acme.com']) === false` (the eTLD+1 spoof) — regression
  guard on `originAllowlist.ts:27-42`.
- **PIN-3 (tenant never on the wire):** assert the `/public/widget/config` and `/message` responses
  contain no `token`/`tenantId` keys (`publicGateway.ts:76,125`).
- **PIN-4 (no-second-chat-store):** assert a public dispatch mints **zero** conversation/run rows
  (statelessness is a security property, not an accident).

---

## New-code inventory (small, and only if B1 is chosen later)

- Nothing required to keep the unit honest today.
- **If/when B1 is ported:** (1) a per-widget tool allowlist field on `WidgetConfig` +
  `cleanWidgetTools()` validator; (2) a thin `dispatchWidgetTurn` that drives `conversationToolLoop`
  with that allowlist and the shared route-authz predicate; (3) the security RFC/ADR for
  anonymous-actor tool authz. No new node pack, no new workflow, no new agent pack.
- **For D1:** one `registerRetentionPurger` (classification-based) over `chatwidget:session` /
  `chatwidget:day`, or a TTL on those two `DurableCollection`s.

---

## Phased plan — gated on real gates

- **Phase 0 (now, no behavior change): pin the honesty boundaries.** Add PIN-1..PIN-4. Close D1 with a
  retention purger/TTL on the two counter stores. Ends with `npm run ci` green + /code-review.
- **Phase 1 (only if the product wants tool-driven widgets): design the anonymous-actor security
  perimeter.** RFC/ADR for tool authz on an unauthenticated cross-origin host-key surface; no code
  until Accepted (per CLAUDE.md wire-gate). Ends with /architect (security track).
- **Phase 2 (post-Accept): implement B1 as an additive path.** Per-widget tool allowlist +
  `conversationToolLoop`-driven dispatch, tools sharing route predicates, failing empty for anon.
  Regression PIN-1 is rewritten to assert the allowlist, not "no tools." Ends with /code-review +
  /ux-review + /grade-ai-exchange.

Never demolish anything; there is no replacement to stand up first.

## Deferred honestly

- **B1 / tool-enabled public dispatch** — blocked on an anonymous-actor tool-authz + prompt-injection
  security pass (new RFC). The persona-only widget is honest today because the ADR says so; it must not
  be described as "the agent, on your website" until B1 ships.
- **B2 / multi-turn public sessions** — deferred with B1 for the same perimeter reasons
  (`publicGateway.ts:20-21`).
- **D1 / counter-store retention** — `chatwidget:session` + `chatwidget:day` grow unbounded; low
  severity (anonymous, no PII), fixable with one purger.

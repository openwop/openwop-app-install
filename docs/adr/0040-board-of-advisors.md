# ADR 0040 — Board of Advisors (multi-persona advisory councils)

**Status:** implemented (Phases 1–6; Phase 6 landed once RFC 0101 reached Accepted)
**Date:** 2026-06-14
**Toggle:** `advisory-board` (default OFF, `bucketUnit: tenant`)
**Capability:** reuses the core `assistant` + `knowledge` `AgentCapabilityId`s, activated
per advisor's `agentProfile` (no new capability id).
**Depends on / composes:** ADR 0031 (rich `agentProfile` — persona vehicle, extended
additively), ADR 0032 (work-twin persona reconciliation — seed/runtime persona path),
ADR 0038 (per-agent knowledge & memory — per-advisor RAG corpus), ADR 0011 (KB/RAG —
`kbService`/`KnowledgeBackend`), ADR 0023 (assistant capability — moderator/synthesis),
ADR 0025 (user/agent orchestration symmetry — board ownership), ADR 0024/0021 (Connections
+ Sharing/consent — private/shared), ADR 0006 (RBAC), ADR 0015 (workspace = tenant), ADR
0001 (feature-package), ADR 0014 (`ctx.features.*`). Reuses the host multi-agent
conversation seam (`host/conversationExchange.ts`, `host/agentPromptScaffold.ts`,
`host/conversation.ts`) and `rosterService` + `DurableCollection`.
**Surface:** host-internal product config + chat under `/v1/host/openwop-app/advisors/*`
(NOT `/boards/*` — that namespace is owned by `host.kanban`, see § "Boundaries").
**RFC gate — PHASED (maintainer call, 2026-06-14).** MVP is **host work, NO blocking RFC**:
it rides **already-Accepted** RFC 0005 (Conversation), RFC 0002 §A8 (`shared:<groupId>`
agent context), RFC 0086 (roster), RFC 0004 (memory). A **non-blocking** companion wire
RFC — **RFC 0101 (multi-party group conversation)** — is opened concurrently to upstream a
*normative* multi-party shape (participant roster on `conversation.opened`, REQUIRED
per-turn `speakerId`, a `multiPartyConversation` capability). The host MVP ships unblocked;
cross-host-observable multi-party honesty is a later phase gated on RFC 0101 reaching
Accepted. See § "RFC gate".

## Why this exists

The plan (`docs/board-of-advisors.md`): *"a user-assembled group of named agents — each a
distinct digital-clone persona with its own RAG corpus — summoned together into one chat
(via `@@`) to advise on strategy and brainstorm. Advisors address the user and each other
by name, build on and challenge each other; boards are created by anyone, private or
shared."* Example board: Elon Musk, Steve Jobs, Ben Franklin, Leonardo da Vinci, Jeff Bezos.

A boundaries audit (2026-06-14, via `/feature-refinement` + four parallel `/Explore`
passes over host code and the `openwop` wire) found the plan's premise is **largely already
shipped at the primitive level**, and that the only net-new product surface is the
**grouping + the multi-party orchestration loop + the curation/sharing UI**. What already
exists:

- **Named advisors = roster agents** — `host/rosterService.ts` `createRosterEntry()`
  (`:119-150`); runtime creation already exposed at `POST /v1/host/openwop-app/roster`
  (`routes/roster.ts:147`). Personas are seeded *and* user-creatable today.
- **Persona = `agentProfile`** (ADR 0031) — `types.ts:336-387`: `systemPrompt` on the
  manifest + `configParameters` (voice/heuristics/decision-frameworks) + `capabilities[]`.
  Capability activation is **core-not-named** (`agentProfileService.ts:144-160`
  `activateAgentCapability`) — David's law holds.
- **Per-advisor RAG = the `agent-knowledge` feature** (ADR 0038) — bind a KB collection
  per agent (`features/agent-knowledge/routes.ts` `bindCollection`), each advisor's
  retrieval composed **independently at dispatch** (`host/agentKnowledgeComposition.ts:38-100`
  `resolveAgentKnowledgeRetrieve` → `KnowledgeBackend.retrieve(tenantId,{collectionIds})`).
  **N advisors each with their own corpus + citations + trusted/untrusted fencing is
  already supported** — no change to ADR 0038.
- **Multi-agent chat scaffold already exists in the host** — `host/conversationExchange.ts`
  `handleConversationResolve()` (`:131-221`) exchanges turns, resolves an addressed agent
  (`turn.to` → `getAgentRegistry().resolve`), dispatches a reply, and writes per-turn
  `agentId`-attributed messages to the `messages` channel (`:214-218`). `ConversationTurn`
  (`host/conversation.ts:19-38`) already carries `from`/`to`/`groupId`/`agent.agentId`/
  `role`/`turnIndex`. `host/agentPromptScaffold.ts:40-62` `composeAgentSystemPrompt` already
  wraps each advisor's persona with a CONVERSATION CONTEXT block that names the user, marks
  `[Name]:`-prefixed lines as *other* agents, and guards the three documented multi-agent
  failure modes (**conformity, confabulation, impersonation**).

**The genuine gap** (net-new, what this ADR delivers):
1. No **grouping primitive** for "a named, ordered set of advisor agents" (a *board*).
2. No **broadcast `@@`-summon orchestration** — fan one user prompt to N advisors in one
   shared transcript, with turn-taking + a synthesizing moderator turn.
3. No **curation / sharing UI** for boards, and no private/shared model wired to them.
4. No **likeness/disclaimer governance** for digital clones of real (esp. living) people.

## Boundaries — the one hard naming collision

`host.kanban` **owns the word "board"** — `KanbanBoard` (`host/kanbanService.ts:101-125`),
routes `/v1/host/openwop-app/kanban/boards/*`, polymorphic `boardOwner()` (`:117-125`). A
kanban board is a *work-tracking* surface (columns + cards); an *advisory board* is a
*conversational cohort*. They are semantically distinct and MUST NOT be fused (the
`orgs`↔`accessControl` failure mode). **Decision:** the feature is named **`advisory-board`**,
its entity is `AdvisoryBoard`, and all routes live under **`/v1/host/openwop-app/advisors/*`**
— never `/boards/*`. The advisory board does **not** instantiate or shadow a `KanbanBoard`
(no fake board id — the no-parallel-architecture law).

## Decision

Ship a feature-package **`advisory-board`** that **composes** the existing primitives into:

1. **An `AdvisoryBoard` grouping entity** — an ordered list of advisor `rosterId`s + a
   moderator binding + visibility, stored in a `DurableCollection<AdvisoryBoard>`, tenant-
   scoped (ADR 0015), created by any member, shareable via the existing Sharing registry.
2. **Advisor personas as `agentProfile` (extends ADR 0031/0032)** — each advisor is a
   roster agent whose `systemPrompt` + `configParameters` encode the digital-clone voice/
   heuristics, bound to its own KB corpus via the **unchanged** `agent-knowledge` feature
   (ADR 0038). Personas are authored at runtime (`createRosterEntry`) **or** seeded as a
   template pack (`tmpl.advisors.*`, ADR 0032 path) — no hardcoded named-agent logic.
3. **A `@@`-summon multi-party orchestration loop** that **extends `conversationExchange.ts`**:
   a broadcast turn (`to` absent) fans the user prompt to each board member; each advisor's
   reply is dispatched with its own knowledge retrieval + the existing multi-agent prompt
   scaffold; turns are persisted to one `groupId`-scoped transcript with per-turn `agentId`
   attribution. `@<advisor>` keeps the existing addressed (1:1) path.
4. **A moderator/synthesizer turn** (reuses the `assistant` capability, ADR 0023) that, after
   a round, summarizes the panel, surfaces agreements/dissents, and frames the decision/
   options for the user — engineered for **productive disagreement**, not convergence.

### Data model — `AdvisoryBoard` (new host-ext type) + `agentProfile` note

```ts
// features/advisory-board/types.ts — new host-extension entity (non-normative)
interface AdvisoryBoard {
  boardId: string;            // host:advisory:<slug>
  tenantId: string;           // workspace (ADR 0015)
  orgId: string;              // owning org (RBAC scope)
  name: string;               // "@@founders"
  handle: string;             // the @@ summon token (unique per tenant)
  advisors: string[];         // ordered rosterIds — the cohort (the grouping; NOT a KanbanBoard)
  moderatorRosterId?: string; // synthesizer; defaults to the workspace assistant (Iris)
  visibility: 'private' | 'shared';   // resolved server-side; 'shared' rides the Sharing registry
  turnPolicy?: { rounds?: number; order?: 'declared' | 'round-robin'; allowCrossTalk?: boolean };
  createdBy: string;
  createdAt: string; updatedAt: string;
}
```

No new persona type — an advisor *is* a roster agent + its `agentProfile`. No new RAG store —
the corpus *is* a bound KB collection (ADR 0038). No new board-owner model — the
`AdvisoryBoard` is its own entity and does **not** touch `host.kanban`.

### Seam map (no feature→core import — ADR 0001 boundary)

| Concern | Owner | Mechanism |
|---|---|---|
| Advisor agent + persona | `rosterService` + `agentProfileService` | `createRosterEntry` + `systemPrompt`/`configParameters`; capability activated per profile |
| Per-advisor RAG corpus | `agent-knowledge` feature (ADR 0038) | `bindCollection(tenant, advisorId, collectionId)` — **unchanged**, each advisor retrieves independently at dispatch |
| Multi-party transcript + turns | host (`conversationExchange.ts`, `conversation.ts`) | broadcast turn (`to` absent) → fan-out dispatch; `groupId`-scoped `messages` channel, per-turn `agentId` |
| Persona-safe prompting | host (`agentPromptScaffold.ts`) | `composeAgentSystemPrompt` multi-agent CONVERSATION CONTEXT (conformity/confabulation/impersonation guards) — **reused as-is** |
| Moderator/synthesis | `assistant` capability (ADR 0023) | a moderator advisor with `capabilities:['assistant']` runs the closing synthesis turn |
| Board entity, summon, curation UI, toggle, sharing | **`advisory-board` feature** | `src/features/advisory-board/` (service + routes + feature.ts + surface.ts) |
| Private/shared | Sharing registry (ADR 0013) + accessControl (ADR 0024) | register an `advisory_board` `ShareResolver`; `authorizeOrgScope` gates mutators |

The feature package owns *only* the board entity + the summon/orchestration loop + curation
UI. Every primitive it fans into (`rosterService`, `agentProfileService`, `KnowledgeBackend`,
the conversation seam) is **host-owned**, so orchestration needs **no import from the feature
into core** — the orchestration entry sits in the host route/conversation layer exactly as
ADR 0038's retrieval composition does.

## Feature evaluation matrix

| # | Decision |
|---|---|
| 1 Feature-package | `src/features/advisory-board/` + `frontend/react/src/features/advisory-board/`; appended to `BACKEND_FEATURES`/`FRONTEND_FEATURES`; composes `rosterService` + `agentProfileService` + `agent-knowledge` + the host conversation seam + Sharing; **no core route/nav edits** (the fan-out loop sits in the host conversation layer). |
| 2 Toggle + admin UI | `advisory-board`, **default OFF**, `bucketUnit: tenant` (boards + roster are workspace-scoped, ADR 0015); manageable in `FeatureTogglePanel`. No new capability id — reuses core `assistant`/`knowledge`. |
| 3 Workflow surface (ADR 0014) | `ctx.features['advisory-board'].convene(boardId, prompt)` (read-mostly: returns the synthesized panel result) + `listBoards()` — behind toggle + RBAC, advertised at `/.well-known/openwop` only when honored. |
| 4 Node pack | `feature.advisory-board.nodes` — `conveneBoard` (`role:action` — runs a panel round, records the transcript ref so replay reads the recorded result, no re-dispatch); signed (Ed25519 + SRI), in `requiredPacks`. |
| 5 AI-chat envelopes | `advisory-board.convene` envelope — the `@@<handle>` chat affordance is parsed host-side and routed to the convene service (the `@@` parse is host UI, not wire — see RFC gate). |
| 6 Agent pack | **none net-new** — advisors are roster agents seeded via a **template pack** `tmpl.advisors.*` (ADR 0032 path), not a feature agent pack. The moderator reuses the `assistant` agent. Honest "no new agent pack." |
| 7 Public surface | **none in MVP** — boards are private/workspace-shared only; no `PUBLIC_PATH_PREFIXES` entry. (A public "ask this board" page is a deferred follow-on with the usual published-only + capability-token + rate-limit guards.) |
| 8 RBAC + isolation (ADR 0006) | every mutating route gated toggle + scope: list/convene = `workspace:read`, create/edit/share/delete = `workspace:write`; tenant + org IDOR-guarded (board's `orgId`); advisor-membership validated against tenant-owned roster (reuse `requireOwnedAgent`); **fail-closed**. Sharing a board mints a Share link via the existing registry. |
| 9 Replay / fork | a board *convene* run stamps the **resolved cohort** (`advisors[]` + each advisor's `agentRef@version` + `moderatorRosterId` + `turnPolicy`) into `run.metadata.advisoryBoard` at creation, read **verbatim** on `:fork`/replay — so a historical panel re-runs with the same members even if the live board is later edited. Per-advisor knowledge retrieval stays live-read (consistent with ADR 0038 §9). Packs decoupled from toggle state. |
| 10 Frontend | `advisoryBoardClient.ts` + a **Boards** surface (create board, pick advisors from roster, set moderator + turn policy, share private/shared) + a **council chat** view rendering the multi-speaker transcript with per-advisor avatars/citations and a `@@`/`@` composer; nav via the menu registry (`GROUP_ORDER`); `ui/` cohesion + a11y + tokens (per `/ux-review`, `DESIGN.md`). |

## Phased plan

1. **Board entity + curation (feature backend + FE).** `AdvisoryBoard` `DurableCollection`,
   CRUD under `/v1/host/openwop-app/advisors/*`, toggle `advisory-board`, RBAC, the Sharing
   `advisory_board` resolver. FE Boards surface (compose existing roster picker). Route tests.
2. **`@@`-summon orchestration (host conversation layer).** Extend `conversationExchange.ts`
   with a broadcast fan-out: one user turn → N advisor dispatches (each with its own ADR 0038
   retrieval + the existing scaffold) → `groupId` transcript with per-turn `agentId`. `@<advisor>`
   keeps the addressed path. Stamp `run.metadata.advisoryBoard` (matrix §9).
3. **Moderator/synthesis turn.** A moderator advisor (reuses `assistant`, ADR 0023) runs the
   closing synthesis — agreements, dissents, decision framing. Engineer turn policy for
   diversity (anti-groupthink), not convergence.
4. **Persona authoring + likeness governance (extends ADR 0031/0032).** Runtime persona
   creation via `createRosterEntry` + an example **`tmpl.advisors.*`** seed pack (the five
   demo advisors). Add the disclaimer/likeness governance (below). Record the extension as a
   correction-note pointer in ADR 0031 + ADR 0032.
5. **Core-app extension surface.** `ctx.features['advisory-board'].convene` (ADR 0014) +
   `feature.advisory-board.nodes` pack + `advisory-board.convene` envelope + `/.well-known/openwop`
   advertisement (only what is honored).
6. **(Deferred, gated on RFC 0101) normative multi-party.** When RFC 0101 reaches Accepted,
   add the participant roster to `conversation.opened`, the REQUIRED per-turn `speakerId`, and
   advertise the `multiPartyConversation` capability — making the council cross-host observable.

## Implementation (2026-06-14)

Shipped Phases 1–5 in one PR (Phase 6 deferred — gated on RFC 0101). Phase → artifact map:

| Phase | Artifact |
|---|---|
| 1 Board entity + curation | `src/features/advisory-board/{types,service,routes,feature}.ts` — `AdvisoryBoard` + `AdvisorySession` in two `DurableCollection`s keyed `${tenantId}:${id}`; CRUD under `/v1/host/openwop-app/advisors/*`; toggle `advisory-board` (off, tenant); RBAC (`workspace:read` list/get/convene/session, `workspace:write` create, owner-check update/delete); `private`/`shared` visibility fail-closed (a private board the caller doesn't own 404s — no existence leak). Cohort + moderator validated against the tenant's roster (no cross-tenant / no `KanbanBoard` id). |
| 2 `@@` convene orchestration | `src/host/advisoryBoardConvene.ts` — `conveneAdvisors()` fans the prompt to each advisor in declared order, resolving persona from the roster entry + its `ResolvedAgentManifest.systemPrompt`, grounding each in its OWN bound corpus (`resolveAgentKnowledgeRetrieve`, ADR 0038 — trusted chunks only, untrusted dropped), wrapping with `composeAgentSystemPrompt` (the conformity/confabulation/impersonation guards) + a diversity note; cross-advisor turns are narrative-cast `[Name]: …`. The `reply` seam is injected (default managed/mock per the request provider). The resolved cohort is stamped on the session at first convene (the host-ext analog of the §9 run.metadata stamp). |
| 3 Moderator synthesis | `conveneAdvisors()` appends a closing moderator turn (a `moderatorRosterId` persona, else a generic "Moderator") that names agreements + disagreements + a recommended decision; `synthesize` from `board.turnPolicy`. |
| 4 Persona authoring + likeness governance | Advisors ARE roster agents (ADR 0031/0032 — runtime `createRosterEntry` already exists; no new persona store). `personaKind` + a persistent simulated-persona **disclaimer** in every projection; a **living-individual ack gate** (`livingPersonaAck`, fail-closed 422 at create AND convene); a `SIMULATION NOTICE` prepended to every advisor + the moderator (no fabricated quotes/endorsements). |
| 5 Core-app extension surface | `src/features/advisory-board/surface.ts` — read-mostly `ctx.features['advisory-board'].{listBoards,convene}` (shared boards only; toggle-gated at the registry seam, auto-advertised at `/.well-known/openwop`). |
| FE | `frontend/react/src/features/advisory-board/{advisoryBoardClient.ts,AdvisoryBoardPage.tsx,routes.tsx}` — a toggle-gated **Board of Advisors** workspace page: list/create boards (pick advisor roster agents, visibility, persona kind, living-ack), and a multi-speaker **council chat** rendering attributed turns + the disclaimer banner; nav via the menu registry. Registered in `BACKEND_FEATURES` + `FRONTEND_FEATURES`. |

Tests: `test/advisory-board-route.test.ts` (8) — toggle gating (404 off); create + cohort validation (empty 400, cross-tenant advisor 404); living-persona ack gate (422 without it); visibility (a private board invisible to a co-tenant member, shared visible, cross-tenant fail-closed); owner-only update/delete; and the convene orchestration via an injected reply stub (1 user + N attributed advisor turns + a moderator turn, cohort stamped, cross-talk narrative-cast `[Name]:`, session continuation appends). FE `npm run build` green (canonical gate: tsc + token/CSS/spacing checks + vite + built-CSS + bundle budget + CSP).

### Phase 6 (2026-06-22) — normative cross-host multi-party (RFC 0101 Accepted)

RFC 0101 (multi-party group conversation) reached **Accepted** upstream, un-gating
Phase 6. The council ALREADY rides the real RFC 0005 conversation wire
(`conversation.opened`/`conversation.exchanged` via the chat — § Correction
2026-06-15), so Phase 6 added the three RFC 0101 elements ON that wire — **no
parallel system**:

| RFC 0101 element | Artifact |
|---|---|
| (1) participant roster on `conversation.opened` | `bootstrap/nodes.ts` — the `core.conversationGate` node accepts an optional `participants` config and emits `participants: AgentRef[]` on `conversation.opened` (additive: absent ⇒ omitted, a 1:1 chat opens with no roster). |
| (2) per-turn `speakerId` (agent INSTANCE id) | `host/conversation.ts` — `ConversationTurn.speakerId` (optional field; `additionalProperties:true` schema accepts it). `host/conversationExchange.ts` stamps `speakerId = answeringId` on BOTH agent-turn build sites (the single-completion turn + the deep-investigation `workflow_run` turn). "Turn N spoken by advisor X" is now an explicit attributed field, not only the narrative `[Name]:` cast. |
| (3) non-participant rejection | `host/multiPartyConversation.ts` (`participantRosterOf` / `isParticipant`) derives the roster from the chat's `ConversationMeta` (`agent:<id>` members stamped by `markAsBoardGroup` at `@@`-summon — the SAME cohort) and `conversationExchange.ts` rejects a `role:'agent'` turn from a non-participant (422, fail-closed). The roster applies ONLY to board-group conversations (`type:'group'` + `boardId`), so 1:1/ungrouped chats are untouched (additive). |
| capability | `routes/discovery.ts` — `multiPartyConversation: { supported: true, maxParticipants: 8 }` (8 = the cohort cap, `MAX_MULTI_PARTY_PARTICIPANTS`). Honest because (2)+(3) are enforced unconditionally; the capabilities schema's open root accepts the additive block (vendored schema lacks the prop, but advertising rides `additionalProperties`). |

Tests: `test/multi-party-conversation.test.ts` (3) — the capability is advertised;
`participantRosterOf`/`isParticipant` derive the cohort from a board-group meta (and
return `null` for a 1:1 chat); a convened council carries `participants` on
`conversation.opened`, each advisor turn carries a `speakerId` IN the roster, the
moderator/chair turn is attributed + in-roster, and an injected non-participant turn
is rejected (422, no turn appended). The living-persona disclaimer + SIMULATION
NOTICE behavior is unchanged (it rides the feature's persona-prompt + board controls,
not the conversation wire). Full backend suite green (2644 pass / 0 fail).

### Deferred (logged, not silent)
- **Signed `feature.advisory-board.nodes` pack + `advisory-board.convene` chat envelope** (matrix §4/§5) — need the pack-build/sign pipeline; the read-mostly `ctx.features` surface ships now, the node pack is a follow-on. The feature is fully functional via REST + the surface without it.
- ~~**`tmpl.advisors.*` celebrity-persona seed**~~ — **DONE (2026-06-14, see § Demo seed below)**, though NOT as a `tmpl.*` agent pack: the demo seed creates each advisor as its own **user-agent + roster member + `agentProfile`** (the same path the agent editor uses), which is simpler and carries per-advisor authored instructions natively. A signed `tmpl.advisors.*` pack remains a future option for cross-host portability.
- ~~**Phase 6 (normative cross-host multi-party)**~~ — **DONE (2026-06-22, see § Phase 6 above)** once RFC 0101 reached Accepted.
- **Multi-round (`turnPolicy.rounds > 1`) within one convene + a public "ask this board" surface** — reserved; one fan-out per convene call today.

### Code-review follow-ups (2026-06-14, `/code-review`)
- **HIGH (fixed):** the convene loop keyed per-advisor knowledge/memory by `entry.agentRef.agentId`
  (the shared **manifest pack id**) instead of the **`rosterId`** (`agentProfile.profileId`) that
  ADR 0038 binds + scopes by — so the headline "each advisor draws from its own corpus" never
  resolved, and advisors sharing a manifest would have collided. `host/advisoryBoardConvene.ts`
  now passes `rosterId`; a regression test binds a corpus to one advisor and asserts only that
  advisor's turn is `grounded:true`.
- **MEDIUM (fixed):** `convene` read a client-supplied `provider` from the request body and could
  select the conformance `mock` provider in prod. The provider is now a server decision (always
  managed); tests inject via the `replyOverride` seam, not an HTTP field.
- **LOW (accepted):** untrusted KB chunks are **dropped** from an advisor's prompt rather than
  fenced (ADR 0038 §C fences). Dropping is strictly more conservative for the council surface; kept
  as-is. And `getSession` gates on **board visibility** only, so any member who can read a `shared`
  board reads every transcript on it — intended for a shared board (the transcript is the shared
  artifact); a private board's sessions stay owner-only.

### Demo seed (2026-06-14)

`host/advisoryBoardSeed.ts` + `host/seed-data/advisorAgents.json` seed **eight simulated-persona
advisors** (riffed names modeled on public figures — Elon Trask · Geoff Bezor · Steve Jobes · Sam
Oltman · Leo da Vincio · Ben Franklan · Andru Carnagie · Walt Disnae) into **two demo boards**:
*Titans of Tech & Industry* (`personaKind: 'living'`, ack-gated) and *Timeless Minds*
(`personaKind: 'historical'`). It **composes the same owners** the feature uses — no parallel store:

- each advisor is its **own user-agent** (`ensureUserAgentRegistered`) carrying that persona's
  authored instructions (`systemPrompt`, in the StructuredPromptEditor `## Role/Responsibilities/
  Voice/Guardrails/Examples` format) + description, so convene resolves a **distinct** prompt per
  advisor (not a shared pack prompt);
- a **roster member** (`createRosterEntry`, `roleKey: 'advisor'`) references it; its `agentProfile`
  activates the core `knowledge` capability with `retrieval.sources: ['memory','kb']`;
- **memory is preseeded** — each persona's documented principles/heuristics (first-principles, moral
  algebra, customer-obsession, "say no", plussing, …) are written into its RFC-0004 namespace
  (`agentMemoryScope(rosterId)`, tagged `advisor:seeded`) via the deterministic offline embedder, and
  **recall in council chats** (a convene returns advisor turns `grounded: true` — proven in
  `advisory-board-seed.test.ts`);
- boards are created via the feature service (`createBoard`).

Gated on the **`advisory-board` toggle** being enabled for the tenant (keeps the default demo roster
clean until an operator turns the feature on + reseeds), wired best-effort into `seedEverything`, and
idempotent (advisors matched by deterministic user-agent id, memory by the seed tag, boards by handle;
profile + memory re-written only for a new advisor or on `heal`, so user curation survives). The
likeness guardrails ride the feature's existing controls: every persona prompt carries the simulation
notice, and the boards surface the "simulated — not the real person" disclaimer.

### Correction (2026-06-15) — the convene path was a parallel chat runtime; rebuilt on the AI chat

The Phase-2 `conveneAdvisors` + `AdvisorySession` store + `POST …/convene` route + the in-page
council-chat screen stood up a **second multi-agent chat** beside the app's real one
(`openwop-app.chat.turn` + the `activeAgents` lineup + `composeProviderMessages`), violating the
no-parallel-architecture rule (and the screen shipped broken). **Retired and replaced** (architect
pass 2026-06-15):

- **One runtime — the existing AI chat.** Typing **`@@<handle>`** in the chat composer
  (`detectBoardMention`) resolves the board's cohort (`GET /advisors/boards/by-handle/:handle`,
  visibility-gated) and **activates every advisor (chair first) into the chat's active-agents
  lineup** — the sidebar fills with the whole council and the conversation rides the existing
  `chat.turn` multi-agent infra. Checked **before** the single `@` so `@@x` ≠ `@x`.
- **Retired:** `host/advisoryBoardConvene.ts` (deleted), `convene`/`getSession` + `AdvisorySession`/
  `CouncilTurn` + the session store (removed). The board **entity** (cohort CRUD + `@@`-handle
  resolution) stays; the `ctx.features['advisory-board']` surface keeps read-only `listBoards`.
- **`/advisors` is now a management page** (create/curate/delete boards) — the in-page chat is gone;
  a notice points users to convene via `@@handle` in the AI chat.

**Deferred to a focused increment 2:** (a) the **sequential auto-cascade** boardroom controller — one
advisor at a time, chair-framed, bounded (the architect's recommended cadence) — which needs a
per-turn completion signal added to the `chat.turn` SSE handler so the loop can sequence; and (b)
wiring **ADR 0038 knowledge into the `chat.turn` agent path** (`bootstrap/nodes.ts` resolves persona
but not `resolveAgentKnowledgeRetrieve`) so advisors recall their preseeded memory in chat. Both were
held until **ADR 0041 (subject memory, #274)** merged — now in `main` — to compose with the unified
memory primitive rather than collide with its refactor. Today: `@@` seats the whole council in the
chat (the user's literal ask) and advisors carry their full authored persona instructions; the
auto-cadence + memory recall land next, on the same `chat.turn` substrate (no parallel runtime).

## RFC gate

**Verdict: PHASED — host MVP needs NO blocking RFC; a non-blocking companion RFC upstreams the
normative shape.**

- **MVP rides Accepted RFCs.** The multi-party transcript is expressed with **RFC 0005**
  (Conversation: `conversation.opened`/`exchanged`, `ConversationTurn`) + **RFC 0002 §A8**
  (`shared:<groupId>` agent context = the board's shared memory/transcript scope) + **RFC 0086**
  (roster) + **RFC 0004** (per-advisor memory). Speaker attribution uses the *already-present*
  `ConversationTurn.from = <agentId>` + `agent.agentId`. The `@@`/`@` parse is host UI. All
  net-new routes live under the non-normative `/v1/host/openwop-app/advisors/*` namespace.
  Nothing here is a new `/v1` wire contract → **no blocking RFC**.

- 🚧 **Honesty boundary (the one real wire gap).** On the *wire*, per-turn `speakerId` is
  **optional**, there is **no participant roster** on `conversation.opened`, and there is **no
  `multiPartyConversation` capability flag** — so a cross-host peer/auditor/replayer cannot
  *normatively discover or enforce* "this conversation has advisors A,B,C and turn N was
  spoken by X." The MVP therefore keeps multi-party attribution **host-observable only** and
  MUST NOT advertise a normative multi-party-conversation capability it does not honor
  (`OPENWOP_REQUIRE_BEHAVIOR=true` would fail a dishonest claim).

- **Companion RFC 0101 (multi-party group conversation) — non-blocking, author via `/prd`.**
  Upstreams: (a) `participants: AgentRef[]` on `ConversationOpenedPayload`; (b) a REQUIRED
  `speakerId` on `ConversationTurn` when `role:'agent'`; (c) a `multiPartyConversation`
  capability (`{ supported, maxParticipants? }`). A stub is filed at
  `../openwop/RFCS/0101-multi-party-group-conversation.md` (Status: Draft). It **gates only
  Phase 6** (cross-host honesty), not the MVP.

## Market / research design notes (from the brief's analysis)

- **Digital-clone fidelity = RAG grounding, not mimicry.** The differentiator over a styled
  system prompt is that each advisor cites its *own* corpus (ADR 0038 already returns cited
  chunks + fences untrusted ones). Advisors should ground claims and **flag speculation beyond
  their sources** (encode in the persona prompt + the moderator's "evidence vs. opinion" pass).
- **Engineer for productive disagreement.** Multi-agent-debate / mixture-of-agents research
  shows panels that critique each other beat one model wearing N hats — but only if they
  *diverge*. The `turnPolicy` + the scaffold's anti-conformity guard exist to prevent
  sycophantic convergence; the moderator surfaces dissent rather than averaging it away.
- **Board templates + addressing.** Ship example templates ("founders board", "product board")
  via `tmpl.advisors.*`; support `@<advisor>` to address one panelist mid-thread and follow-up
  rounds (`turnPolicy.rounds`).
- **Legal / likeness governance (design constraint, not optional).** Cloning real — especially
  **living** — individuals raises right-of-publicity, likeness, and defamation/misattribution
  risk. MVP rules: (1) every advisor renders a persistent **"Simulated persona — not the real
  person"** disclaimer in chat + on the board; (2) the persona prompt forbids fabricated
  first-person quotes/endorsements and claims of present-day statements; (3) **historical /
  public-domain figures are the seeded default**; living-person personas are a workspace-admin
  opt-in with an acknowledgement gate; (4) corpora must be lawfully sourced (no scraped
  paywalled text). Tracked in § Open questions; a deeper pass is a `/architect` follow-on.

## Alternatives weighed

- **Reuse `host.kanban` board as the cohort.** Rejected — a kanban board is a work surface;
  overloading it with advisor membership shadows a primitive with a foreign meaning (the
  `orgs`↔`accessControl` failure mode). A distinct `AdvisoryBoard` entity is cleaner and
  collision-free.
- **One agent role-playing all advisors (a single dispatch with a "panel" prompt).** Rejected —
  collapses the distinct-minds + per-advisor-RAG premise into one context (no independent
  retrieval, no genuine dissent); the brief explicitly rejects "one model wearing five hats."
- **Block the feature on RFC 0101 (normative-first).** Considered and rejected by the
  maintainer call — the host conversation seam + RFC 0005/0002 §A8 already express the MVP
  honestly under the host-ext namespace; blocking on an upstream RFC would stall a shippable
  product for a cross-host-observability property the demo does not yet need. Phased instead.
- **A net-new conversation runtime for multi-party.** Rejected — `conversationExchange.ts` +
  `agentPromptScaffold.ts` already do the hard part (cross-agent narrative casting, the three
  failure-mode guards); extending the broadcast path reuses that, no parallel runtime.

## PRD-vs-architecture corrections

- ❌ "the board is a new board concept" → ✅ a distinct **`AdvisoryBoard` entity under
  `/advisors/*`**, explicitly **not** a `KanbanBoard` and not shadowing `host.kanban`.
- ❌ "each advisor needs its own RAG memory system" → ✅ **compose the unchanged
  `agent-knowledge` feature (ADR 0038)** — per-advisor binding + independent dispatch
  retrieval already exists; no new per-agent store (no-parallel-architecture).
- ❌ "build a multi-party chat orchestration runtime" → ✅ **extend the existing host
  conversation seam** (`conversationExchange.ts` already dispatches addressed agents with a
  multi-agent scaffold); the net-new part is only the **broadcast fan-out + synthesis turn**.
- ❌ "multi-party chat needs a new RFC before host work" → ✅ **phased** — MVP rides Accepted
  RFC 0005/0002 §A8 as host-ext; RFC 0101 upstreams the *normative* shape non-blockingly.
- ❌ persona capability unique to a named advisor → ✅ **persona = `agentProfile` content;
  capabilities stay core, activated per advisor** (David's law).

## Open questions

- **Living vs. historical personas — gating depth.** MVP seeds historical/public-domain
  figures + a living-person admin opt-in with acknowledgement. Is an explicit consent/usage
  record per living persona required before GA? (→ `/architect` + legal follow-on.)
- **Turn-taking on the wire.** MVP turn policy (declared order / round-robin / N rounds) is
  host-local. Which parts (if any) become normative in RFC 0101 vs. stay host product policy?
- **Synthesis ownership.** Is the moderator always the workspace assistant (Iris), or a
  per-board-selectable advisor with `capabilities:['assistant']`? MVP allows both; default Iris.
- **Cost / fan-out caps.** N advisors × rounds multiplies provider calls — MVP must cap
  members + rounds and surface the cost; revisit batching/streaming once usage is observed
  (cf. the rate-limit fan-out gotcha in CLAUDE.md).
- **Public "ask this board" surface.** Deferred; when built, follows the published-only +
  capability-token + rate-limit + payload-cap pattern (ADR 0012/0013).

# Board of Advisors (unit A11) — chat-first port review

**Scope:** `backend/typescript/src/features/advisory-board/` +
`frontend/react/src/features/advisory-board/` + the chat-side summon glue
(`frontend/react/src/chat/`), doc `docs/board-of-advisors.md`, ADR 0040.

**Headline verdict: already ported.** This is the reference example of a feature
that was BUILT parallel and then genuinely demolished-and-reconciled onto the
engine. ADR 0040 § Correction 2026-06-15 retired a standalone "convene runtime";
the boardroom conversation now rides the ONE shared multi-agent exchange engine
(`host/conversationExchange.ts`), the ONE conversation owner
(`host/conversationStore.ts`), RFC 0101 speaker attribution, the agent-knowledge
KB owner (ADR 0038), and the core board-context seam. There is **no PARALLEL and
no THEATER** to report. The only chat-first *gap* is that board authoring
(assemble/edit a council) is form-only — there is no agent tool to build a board
by describing intent — and that is an optional enhancement, not a demolition.

---

## Step 1 — Contract scouting (with evidence)

**What the feature declares vs. what actually creates runs of it**

- **Node pack `feature.advisory-board.nodes`** declares exactly ONE node,
  `…list-boards`, `role:"action"`, read-only, over the `listBoards` surface
  (`packs/feature.advisory-board.nodes/pack.json:22-30`;
  `backend/.../advisory-board/surface.ts:22-25`). No workflow is declared, so
  there is no orphaned `WorkflowDefinition` to ignite. The node is an ordinary
  catalog read node any workflow may call — not a feature-owned pipeline. ✔ no
  ignition gap.
- **The boardroom "run" is a `chat.turn`**, not a bespoke runtime. The `@@`
  summon → `buildBoardInterceptor` activates the cohort into the chat's
  active-agents lineup and starts `useBoardroomCadence`, which drives **one
  advisor turn at a time off the completion of the prior turn** via the shared
  `send` path (`frontend/.../chat/ChatSidebar.tsx:200-206`,
  `:583` boardInterceptor; `frontend/.../chat/conversations/convene.ts:108-171`;
  `useBoardroomCadence.ts:11-56`). Each turn is a real `chat.turn` run on
  `conversationExchange.ts` — the SAME engine 1:1 chat uses.
- **`turnPolicy` (rounds / order / synthesize) is honored, not painted.**
  `planBoardroomTurns(..., board.turnPolicy)` + `orderConveneCohort(moderator,
  advisors, cap)` plan the advisor turns and the optional moderator synthesis
  (`convene.ts:79-80, 158-161`; `boardroomCadence.ts`). Closes the honesty loop
  on the ADR's "a moderator synthesizes" claim.

**Agents' tool allowlists vs. what the tools can do**

- The **advisors themselves are roster agents** with real `agentProfile`
  personas + per-agent KB (ADR 0031/0038); their intelligence rides the existing
  ADR 0089 conversation tool loop in `conversationExchange.ts:295-320` (a
  tool-bearing addressed agent runs observe→act, not a single narration). ✔ not
  a toothless persona.
- **There is NO `registerFeatureAgentTool` in this package** (grep: none in
  `backend/.../advisory-board/`). No agent can create/edit/convene a board as a
  turn-time action. Board authoring is exclusively the management form
  (`AdvisoryBoardPage.tsx`). This is the one honest chat-first gap (see G1).

**Which owners it instantiates vs. shadows (the RIDES grep)**

- **Conversation owner — instantiated.** `POST …/boards/:id/chat` calls
  `storage.createChatSession` + `ensureConversationMeta` + `markAsBoardGroup`
  with a deterministic `subjectConversationId(tenant, boardSubject(id))`
  (`routes.ts:152-213`) — the ADR 0278 canonical, join-by-subject-access
  conversation, the exact `ProjectChatTab` precedent. No second chat store.
- **KB owner — ridden, not shadowed.** Shared-knowledge binds via the
  `agent-knowledge` owner's `bindCollection`/`unbindCollection` (ADR 0038) over
  the core `shareableKb` provider registry
  (`advisoryBoardKnowledgeService.ts:18-20,99-112`). No parallel RAG store — the
  ADR's explicit non-goal.
- **Board-context — core seam, one-directional.** `registerBoardContextResolver(
  resolveBoardStrategyContext)` (`routes.ts:57`; `service.ts:404-416`) injects
  strategy/project context; strategy/projects never import advisory-board.
- **Board entity is a distinct grouping, NOT host.kanban.** `boardId =
  host:advisory:<slug>` under `/advisors/*`, never `/boards/*`
  (`types.ts:5-8`, `service.ts:227`, `boardSubject` kind `'board'` ≠ kanban) —
  it honestly instantiates a new owner rather than shadowing a fake kanban id.
- **Roster-lifecycle — seam.** `onRosterMemberDeleted('advisory-board', …)`
  prunes a deleted advisor from every board (`feature.ts:37-39`;
  `service.ts:433-445`).
- **Subject-access — per-kind resolver.** `registerSubjectAccessResolver('board',
  resolveBoardAccess)` (`feature.ts:44-46`; `service.ts:355-363`) is what makes
  the one conversation joinable and keeps authority parity.

**Executor/chassis constraints that bound anything**

- RFC 0101 multi-party speaker enforcement lives in the PARENT conversation
  (`conversationExchange.ts:286-294`), and `participantRosterOf` only returns a
  roster for a `type:'group'` meta carrying `boardId`
  (`multiPartyConversation.ts:48-58`) — so the boardroom's speaker guard is
  already at the shared chassis, not a child run. No child-interrupt-visibility
  problem exists here because there is no child run in the convene path.

---

## Step 2/3 — Capability inventory + verdicts (ten port tests folded in)

| # | Capability | Today | Verdict | Port target |
|---|---|---|---|---|
| 1 | Convene a board (`@@<handle>`) → shared boardroom conversation | Chat summon → cohort into active-agents lineup → sequential `chat.turn` cadence | **RIDES** | none — instantiates the conversation owner + runs on `conversationExchange.ts` |
| 2 | Canonical board conversation (ensure-or-join, ADR 0278) | `POST …/boards/:id/chat` → deterministic subject-keyed group conversation | **RIDES** | none — `ProjectChatTab` pattern, join by subject-access |
| 3 | Turn-taking / moderator synthesis (rounds, order, synthesize) | `planBoardroomTurns(board.turnPolicy)` over shared `send` | **RIDES** | none — `turnPolicy` (shared ADR 0054 D6 primitive) honored; honesty loop closed |
| 4 | Share a KB with the whole cohort | `bindCollection` (ADR 0038) over `shareableKb` registry | **ADAPTER** | leave; thin binder, no parallel store — watch reconcile drift |
| 5 | Inject strategy/project context into the boardroom | `registerBoardContextResolver` core seam, RBAC-filtered, snapshotted | **ADAPTER** | leave; one-directional import |
| 6 | Prune a deleted advisor from live membership | `onRosterMemberDeleted` seam | **RIDES** | none |
| 7 | Board CRUD — create / edit / clone / delete the cohort | Management page + `/advisors/boards` REST | **PAGE-LEGIT** (config-entity CRUD) | keep as a page; OPTIONAL G1 agent tool completes the chat-first story |
| 8 | `list-boards` workflow node | single read node over the surface | **PAGE-LEGIT** | keep; read-only, replay-safe |
| 9 | Preview strategy context before convening | `GET …/strategy-context` read | **PAGE-LEGIT** | keep |
| 10 | Persona/likeness governance (disclaimer + living-ack) | server-authoritative fail-closed validation | **PAGE-LEGIT** | keep; it is a durable validation gate, not intelligence |
| 11 | `@@`/`@` mention discoverability (autocomplete) | chat chrome (`BoardMentionAutocomplete`) | **PAGE-LEGIT** | keep; parse/UI concern (ADR 0040 correctly kept it host-local) |

**Verdict tally: R=4, A=2, P=0, T=0, PL=5.**

Port-test notes worth recording:
- **Agency test** — the cohort agents pass (real tools via ADR 0089). The
  *feature package* itself exposes no agent tool, so "author a board by
  describing intent" is unavailable in chat (G1). Not theater: the form works
  and is honest.
- **Authority-parity test** — passes and was hardened: the `…/chat` mutate route
  adds the org-scope floor the sibling reads use (`routes.ts:151`, GRADE-5),
  closing the co-tenant "shared-visibility ⇒ can stamp/mutate" gap the skill's
  0458-B1 lesson warns about.
- **Lifecycle test** — passes unusually well: cohort-change + delete reconcile KB
  bindings (`service.ts:299-336, 462-483`), delete releases the conversation
  owner-subject (`service.ts:479`), keys are tenant-scoped deterministic
  (`DurableCollection('advisory:board', …)`, `service.ts:44`), and roster
  deletion prunes membership.

---

## Blockers (from scouting) — each with the honest alternative

**None.** Every mechanic the feature relies on holds:
- The boardroom is a real multi-agent `chat.turn`, not a claimed runtime →
  ignition path verified end-to-end (summon → cadence → `send` → exchange).
- `turnPolicy`/moderator synthesis are consumed, not painted → no honesty-loop
  gap to defer.
- KB/context/conversation owners are instantiated, not shadowed → nothing to
  reconcile.

The scouting-value output here is the *inverse* of a normal port: the assumptions
the skill usually falsifies (orphaned workflow, toothless agent, painted status,
shadowed owner) were all **checked and found already satisfied**.

---

## Demolition list (with regression pins)

**Nothing to demolish.** The parallel convene runtime that WOULD be the
demolition target was already removed in ADR 0040 § Correction 2026-06-15. To
keep it removed, the pins that matter (present-tense guards, verify they hold —
do not add duplicates):

- A regression that a **board group conversation rejects a non-participant
  speaker** (RFC 0101) — guards against a resurrected side-channel that seats
  non-cohort agents (`conversationExchange.ts:286-294`;
  test `backend/.../test/advisory-board-chat.test.ts`).
- A regression that **there is no second chat/transcript store** — the board
  conversation id is always `subjectConversationId(tenant, boardSubject(id))`
  (`routes.ts:152`), never a feature-local session table.
- A regression that **`/advisors/*` never mints `/boards/*` or a kanban id**
  (existing boundary test intent; `types.ts:5-8`).

---

## New-code inventory (small — one optional enhancement only)

**G1 (optional): a board-author agent tool** so a user can assemble/refine a
council by describing intent in the ONE chat, instead of only the form.

- ONE `registerFeatureAgentTool` action tool per verb
  (`advisory.createBoard` / `advisory.updateBoard`), each sharing the route's
  access predicate — the tool and the `POST/PATCH /advisors/boards` handler both
  call the same org-scope helper (`requireOrgScopeFor`), failing typed (not
  empty) without an acting user. Pack-allowlisted, not added to the ADR 0315
  default-on baseline.
- Reuse the existing `createBoard`/`updateBoard` service closed-world validators
  verbatim (`service.ts:211-338`) — the tool is a thin call, no new persistence,
  no new envelope kind. Roster-id resolution stays the `resolveCohort` gate.
- The likeness-governance gate (`assertLivingAck`) already fails closed, so a
  living-persona board authored via the tool still requires the ack — surfaced
  back to the model as a typed validation error to repair once.

No new workflow, no new node beyond the existing read node, no new store, no
wire/RFC surface. If G1 is not built, the feature remains honest — board
authoring is page-shaped config CRUD, which is a legitimate page.

---

## Phased plan (gated on real gates)

- **Phase 0 (already done, verify only):** confirm the three demolition pins
  above are green under `npm run ci`. No code change; this unit is already on the
  engine.
- **Phase 1 (optional, G1):** add the two allowlisted board-author agent tools
  sharing the route predicate; pack-allowlist them; add a `promptCatalogParity`
  row + `agent-prompt-tool-ids` coverage so the tool schema is pinned to the
  service SSoT. Close with `/code-review` + `/ux-review` (chat surface: the
  tool's confirmation should render as a normal turn, no bespoke card) and apply
  fixes. Ship the toggle-scoped tool OFF-by-default in the pack until reviewed.

Because there is no demolition, Phase 1 is purely additive and can be deferred
indefinitely without leaving anything dishonest behind.

---

## Deferred honestly

- **G1 board-author agent tool** — deferred as an enhancement, not a gap that is
  faked anywhere. The management page truthfully presents board CRUD; nothing
  claims chat can author a board today.
- **Public capability-token board sharing** — `types.ts:24` marks the
  `link`-shared visibility as an explicit deferred follow-on; the doc's "shared
  via link" bullet is honestly scoped to `private`/`shared` for now. No painted
  surface.
- **Cross-host normative multi-party shape** — the boardroom is a non-normative
  `chat.turn`; RFC 0101 is the Parked companion for the cross-host case
  (`feature.ts:17-19`). Correctly deferred to the wire process, not faked as a
  host capability.

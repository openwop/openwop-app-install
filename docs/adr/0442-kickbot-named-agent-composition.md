# ADR 0442 — KickBot named-agent composition (closing audit blocker KTFULL-B8)

**Status:** **implemented** — P1–P6 complete (2026-07-19/20). **P5 live specialist
advice is now COMPLETE** (async convene via the existing scheduler→turn-workflow→
managed agent-runner seam, posting the specialist's reply back into the chat — see
the "P5 live-convene completion" note). The only remaining deferral is a P4 KickBot
calendar/messaging *integration tool* (the connection providers already exist; it's
a product-scope decision, not blocked infra — see the P4 correction). Everything is
composed onto existing owners; KickBot is a first-class "@"-mention named agent in
the ONE chat and every KickTodo AI surface deep-links it (no parallel chat/agent/
turn-runner/dashboard — audited 2026-07-20).
The current `kickbotService.ts` provisions three of the ten composition elements
(roster identity, agent-work board, welcome conversation); the other seven
(agent profile + capability activation, branded agentRef, roster-bound
schedules / Daily Coach presentation, knowledge bindings, per-user memory,
connections, specialist dispatch) are **not wired**. This ADR designs *how* they
will be composed. **It deliberately does not claim KickBot is composed today.**

> **Recorded lesson honored.** A KickTodo-audit finding was that "ADR prose
> outran implementation" — an ADR asserted behavior the code did not have. This
> ADR is written the opposite way: every "DONE" below is verified against a
> `file:line`, every gap is named as a gap, and the phased plan lands each
> element at a real gate. Do not upgrade the Status line, and do not mark any
> phase implemented, until the cited artifact exists in code.

Relates to: ADR 0414 (KickTodo core — P2 provisioned today's roster/board/
conversation), ADR 0031 (agent profiles + capability activation), ADR 0379
(persona-scoped agent identity — rename continuity), ADR 0025
(user/agent orchestration symmetry — `ensurePersonalWorkspace`), ADR 0412
(standing-goals owner), PRD `docs/kicktodo-prd.md` §6.8.

---

## Why this exists

PRD §6.8 promises KickBot is "**not merely a prompt, avatar, chat tab, agent
pack, or stateless assistant**" — it is one persistent named standing-agent
instance provisioned "with its own governed workflows, schedules, knowledge,
memory, Kanban workspace, conversations, connections, and activity history," that
"convenes bounded specialist roles for planning, coaching, accountability,
safety, and verification," coordinates a daily plan, and can be **renamed by the
user without losing continuity**.

Audit blocker **KTFULL-B8** records the gap between that promise and the code.
`backend/typescript/src/features/kicktodo-core/kickbotService.ts` today
(verified) provisions only:

- a tenant roster row — deterministic id `host:kickbot`, role `kicktodo-guide`,
  persona `KickBot`, heartbeat explicitly OFF, autonomy `review`
  (`kickbotService.ts:74-98`);
- an agent-work Kanban board (`kickbotService.ts:100-114`);
- a durable welcome conversation (`kickbotService.ts:116-119`);

using the **generic** `core.openwop.agents.react` agentRef
(`kickbotService.ts:31-34`). The other seven elements the PRD names are absent.

The tempting-but-wrong reaction is to *build* those seven — a KickBot profile
store, a KickBot scheduler, a KickBot memory/KB store, a KickBot specialist
registry. That is exactly the parallel-system failure `ARCHITECTURE.md`
§"Architecture contract for new work" forbids and that the KickTodo audit
punished elsewhere. **KickBot is a composition, not a subsystem.** This ADR's job
is to map each promised element to the ONE existing owner that already models it,
and to sequence the wiring — not to add infra.

The one design tension the PRD leaves genuinely open — *one shared named instance
with per-user state, or one instance per user?* — is resolved here (§Decision D1),
and the one composition element whose existing owner does **not** cleanly give
per-user isolation (agent memory) is flagged as the single place needing a small
owner extension, §Decision D3 / §Findings F1.

---

## Boundaries audit — every element maps to an existing owner

The compose-don't-duplicate discipline is the whole point of this ADR, so each
PRD §6.8 capability is pinned to its owner and seam, with the current state
(DONE / GAP) verified against code. **No element requires a net-new store,
scheduler, registry, or dispatch loop.**

| PRD §6.8 capability | Existing owner (`ARCHITECTURE.md` seam) | Seam entry point (`file:line`) | Current state |
|---|---|---|---|
| Stable identity + persona | `rosterService` + `agentIdentity` (standing roster) | `createRosterEntry` / `resolveAgentIdentity` (`host/agentIdentity.ts:117`, `host:kickbot` point-get) | **DONE** — `kickbotService.ts:78-89` |
| Agent work board | `kanbanService` | `createBoard`/`getBoard` (`kickbotService.ts:100-114`) | **DONE** |
| Conversation | RFC 0005 conversation primitive | `subjectConversationId` + `ensureConversationMeta` (`kickbotService.ts:116-119`) | **DONE** |
| Rename without losing continuity | persona-scoped identity (ADR 0379) | identity fields (`rosterId`/`roleKey`/`agentRef`) decoupled from `persona`/`label` — `kickbotService.ts:8-15` header + `agentIdentity.ts:123` | **DONE** — structural today; §D4 confirms composition preserves it |
| Governance, tools, autonomy, HITL | agent profile + capability activation (ADR 0031) | `PUT /v1/host/openwop-app/agents/:id/profile` (`routes/agentProfile.ts:323`); `AgentProfile.capabilities` | **GAP** — no profile is written; capabilities never activated |
| Branded named-agent (vs generic react agent) | `AgentRegistry` + pack `agents[]` (signed guide manifest) | agentRef currently `core.openwop.agents.react` (`kickbotService.ts:31-34`) | **GAP** — generic agentRef; the branded `feature.kicktodo.agents` guide manifest is not the ref |
| Schedules / check-ins / Daily Coach | `schedulingService` + `scheduleDaemon` + `armContinuation` | `registerJob`/`personalScheduleId`/`scheduleSubject`/`listJobsByRoster` (`host/schedulingService.ts:178,266,284`); `armContinuation` (`enrollmentService.ts:210`) | **PARTIAL** — daily-loop is armed on the *goal* (`enrollmentService.ts:198-223`) but **not bound to / presented by** KickBot's roster identity |
| Knowledge base | KB/notebook owner + subject-scoped retrieval | `composeAgentKnowledgeContext` / `resolveSubjectKnowledgeRetrieve` (`host/agentKnowledgeComposition.ts:42,130`) | ~~GAP~~ **[P3: CLOSED]** — managed `kicktodoKnowledgeService` binds challenge content + guidance via `setAgentKnowledge` |
| Memory | agent/subject memory owner (ADR 0041/0045) | `subjectMemoryScope` / `createSubjectMemoryPort` (`host/subjectMemory.ts:49,114`) | ~~GAP + F1 hazard~~ **[P3: CLOSED]** — per-user scope via generic `resolveAgentMemoryScope` (Option B, the participant's `user:<id>`); F1 isolation test-enforced |
| Connections | BYOK secret resolver + Connections broker | Connections host-ext (ADR 0024/0033) | **[P4: INVARIANT LOCKED]** — none bound (fail-closed by construction); consent = the user's grant; `connectionReadiness`+heartbeat force-review is the enforcement; actual binding Wave-3-deferred |
| Specialist roles (plan/coach/safety/verify/accountability) | `feature.kicktodo.agents` HANDOFF skills + manifest runtime + `agentDispatch` | pack `agents[]` (`packs/feature.kicktodo.agents/pack.json`), dispatched via the shared tool loop | **[P5: CLOSED (deterministic)]** — `openwop:kicktodo.convene` dispatches the 4 skills via `runAgentDispatch` with typed handoff schemas + read-only confinement; live LLM advice deferred to the workflow path |
| History / activity / observability | run / activity / artifact / metrics owners | `projectAgentActivity` (ADR 0025 Activity tab), run metadata | **DONE (rides existing)** — no KickBot-specific work needed |

Reading of the table: **eleven capabilities, eleven existing owners, zero new
subsystems.** Three DONE, two PARTIAL (wiring only), five GAP, one DONE-by-riding.
The audit therefore turns entirely into *composition sequencing*, which is what
§Phased plan does.

---

## Decisions

### D1 — One named instance per **workspace-tenant**, with per-USER continuity as subject-keyed STATE. NOT one roster row per user.

The PRD says "each user receives one persistent named standing-agent instance in
their personal workspace," and its own §18 architecture review resolved the
mechanism: **per-user provisioning rides `ensurePersonalWorkspace` (ADR 0025)**.
We adopt that reading explicitly:

- **Solo participants (the Wave-0 MVP):** every solo user already gets their own
  personal workspace — a distinct tenant — auto-provisioned at
  `ensurePersonalWorkspace` (`accessControlService.ts`, ADR 0025 §Phase 1). The
  existing **tenant-scoped** `ensureKickBot(tenantId)` therefore *already* yields
  exactly one KickBot per solo user, with **zero fan-out and zero new keying.**
- **Shared cohort / org tenants:** the SHARED named identity (`host:kickbot`)
  serves all members; each member's *continuity* is already subject-keyed in the
  code — participant board per `ownerSubject` (`ensureParticipantBoard`), goal
  `principal` per user (`enrollmentService.ts:167`), `subjectConversationId` per
  subject, `personalScheduleId(tenant, ownerUserId, …)` per user
  (`schedulingService.ts:300`). The named coworker is shared (a cohort has one
  guide); the plan/schedule/board/conversation/memory are per-subject state.

**Rejected: one roster row per user.** It explodes the roster registry, fragments
the "one named agent" taxonomy (ADR 0031), multiplies the heartbeat/schedule
surface per participant, and fights `resolveAgentIdentity`'s `host:*` single
point-get model (`agentIdentity.ts:123`). It is reserved as a *future* option
only if a product need for **per-user rename inside a shared tenant** appears
(open question OQ2); the solo-workspace path already satisfies per-user rename
today because each solo tenant owns its own `host:kickbot`.

### D2 — Specialists are HANDOFF SKILLS KickBot dispatches, NOT named agents.

This is already the shipped taxonomy and we keep it. `feature.kicktodo.agents`
declares plan-builder, safety-reviewer, progress-verifier, accountability-steward
and the sim personas as **task-scoped HANDOFF workers** — scratchpad-only memory,
typed contracts, read-tool allowlists, no domain writes
(`packs/feature.kicktodo.agents/pack.json`, its own description says "HANDOFF
workers, not named agents"). KickBot (the roster instance) is the ONE named
agent; it *convenes* a specialist by dispatching the skill through the shared
manifest runtime + `agentDispatch` tool loop, exactly as any named agent invokes
a handoff. The composition work (Phase 5) is **wiring the dispatch + allowlist**,
not creating a specialist registry. The "safety, coaching, accountability,
verification, planning" roles the PRD lists = these five skills; the "coaching"
operating-rhythm is a **core capability activated via `agentProfile.capabilities`
(ADR 0031)**, never a `roleKey` special-case (David's-law, `ARCHITECTURE.md`
§"Agent capabilities are CORE, not named").

### D3 — Daily Coach = the existing daily-loop + goal continuation, PRESENTED through KickBot's roster; not a new loop.

"KickBot coordinates the plan" decomposes to primitives that already exist and,
for the solo path, already run:

- **materialize/evaluate cadence:** the `openwop-app.kicktodo.daily-loop`
  workflow, armed per-enrollment via `armContinuation` on the standing goal
  (`enrollmentService.ts:198-223`, the KTFULL-B5 fix). This is the *only*
  time-of-day cadence engine (PRD §1); heartbeat stays OFF.
- **check-in observers + goal evaluation:** the standing-goals owner (ADR 0412)
  evaluating completion from board/check-in evidence.

The composition GAP is **presentation/ownership**, not orchestration: today the
daily-loop schedule is bound to the *goal*, so it does not appear as KickBot's
work. Phase 2 binds the schedule to KickBot's roster identity
(`registerJob({ rosterId: 'host:kickbot', … })` / `scheduleSubject` /
`listJobsByRoster`, `schedulingService.ts:266,284`) and projects it onto the
agent-work board, so the daily plan reads as "KickBot's schedule + KickBot's
work" in the profile Schedules/Board tabs (ADR 0025) **without a second loop and
without moving completion truth off the participant board** (PRD §6.8 keeps the
two boards distinct — `kickbotService.ts:44-47`).

### D4 — Rename-without-losing-continuity is already honored; composition must not regress it.

Continuity is structural today: identity is `rosterId` / `roleKey` / `agentRef`
(the guide is found by `roleKey === 'kicktodo-guide'`, never by name —
`kickbotService.ts:58-60`); rename touches only `persona` / `label` / avatar /
alias (ADR 0379). The composition **constraint** this ADR adds: every element
Phase-1..5 binds MUST key off the stable identity, never the display name —
memory scope off the subject id, schedules off `rosterId`, KB bindings off
`profileId`, conversation off the subject. A `kickbot-rename-continuity.test.ts`
(Phase 6) renames KickBot and asserts board ownership, schedule ids, memory
scope, KB bindings, conversation id, and goal attribution are byte-identical
before/after — the tripwire that stops a future composition step from
accidentally coupling a binding to the name.

### D5 — RFC verdict: host work, NO new wire.

Every owner above is an existing OpenWOP/host surface; KickBot binds to them, it
does not extend the protocol. No new run-event field, capability flag, agent wire
shape, schedule wire shape, or normative MUST is introduced — the guide is a
roster instance + profile + existing bindings, all under `/v1/host/openwop-app/*`
non-normative host-ext routes. This matches the PRD's own Track-B conclusion
(§18: "host-private / additive, no OpenWOP RFC required"). **No new RFC in
`../openwop/` is required.** If a later wave needs a *new* connection category or
a new envelope kind for specialist dispatch, that is a separate RFC gate at that
time — not this ADR.

---

## Findings — where an owner needs a small extension (still not a parallel system)

**F1 (the one real gap): per-user agent memory has no first-class isolated
scope under a shared instance.** `subjectMemoryScope(subject)` isolates by
subject (`subjectMemory.ts:49`), but a *shared* `host:kickbot` has ONE subject —
`agent:host:kickbot` — so durable facts written there are **visible across all
members of a shared tenant**: KickBot could surface user A's private preference to
user B. The PRD names "the existing per-agent memory namespace" as if that
suffices; under D1's shared-instance model it does not.
- **Resolution (Phase 3) — implemented as Option B (see the P3 correction note):**
  per-user durable facts KickBot retains about a participant are keyed to the
  **participant** subject (`user:<subject>`) scope, NOT the agent subject and NOT
  the composite. *[P3 correction: the composite `agent × user` scope this line
  originally offered as an option is INERT (no writer targets it) and un-purgeable
  (exact-delete, not prefix-scan) in this host — so it was rejected in favor of the
  participant's own `user:<id>`, which a writer already fills and which is
  teardown-trivial.]* This rides the *same* `subjectMemory` owner via a generic
  `resolveAgentMemoryScope(profile,{actor})` seam (keyed off host-local
  `AgentProfile.memoryScope`, no agent-id special-case), **not** a new memory
  store. Global, user-independent facts (product guidance) stay in the shared KB.
- For the **solo** path this hazard is already moot (one user per tenant), so F1
  only bites when Wave-1+ introduces shared cohort tenants — which is why Phase 3
  can land the solo binding first and the composite-scope helper with the cohort
  wave. Flagging it now prevents a future "shared KickBot leaks memory" incident.

No other element needs an owner extension: profile, schedules, KB, connections,
board, conversation, dispatch all bind through their owners' existing public
seams as-is.

---

## Correction notes (P1 architecture review, 2026-07-19)

The P1 review (recorded per this repo's "correct, don't rewrite history" rule)
overturned two P1 assumptions written above:

1. **The branded agentRef is NOT a `feature.kicktodo.agents` guide manifest.**
   That pack is handoff-skills-only and its own parity test enforces
   `memoryShape: scratchpad-only` for every agent in it — a conversational named
   guide (which needs `conversation:true`) cannot live there without breaking the
   test and corrupting the pack's enforced identity, and the pack description
   already states the named KickBot is host-provisioned "NOT defined here." The
   established precedent for a named standing agent (Iris/chief-of-staff and every
   seeded member) is a **host-registered user-agent** via
   `ensureUserAgentRegistered` carrying persona + systemPrompt + toolAllowlist +
   `conversation:true`. **P1 brands KickBot that way** — a fixed
   `KICKBOT_AGENT_ID = 'user.kicktodo-guide'` (fixed, never persona-derived, so a
   rename never strands the ref). No pack change, no pin bump.

2. **The `coaching` capability did not exist and had to be DEFINED.** No
   `'coaching'` member was in `AgentCapabilityId`; reusing `assistant` would break
   `findAssistantAgent` (a second holder), and `advisor` means advisory-board
   eligibility. P1 adds `'coaching'` to the core `AgentCapabilityId` (host-ext
   type, no wire schema — D5 holds) plus a by-capability resolver
   (`features/kicktodo-core/coachingCapability.ts`, never resolving by `roleKey`).
   Like `cognition` (ADR 0048), the RUNTIME that reads it lands incrementally —
   P1 ships the flag + resolver; P2/P5 consume it.

Also corrected: the profile write is **get-or-create + capability-heal**, never
an unconditional `upsertAgentProfile` (which would clobber a user's
autonomy/HITL/permission edits on every re-provision).

## Correction notes (P3 architecture review, 2026-07-19)

The P3 review overturned three premises this ADR wrote for the memory half:

1. **`memoryShape` is WIRE-FROZEN — the per-user mode moved to `AgentProfile`.**
   `schemas/agent-manifest.schema.json` defines `memoryShape` with
   `additionalProperties:false` (RFC 0003/0004). The originally-floated Q1
   mechanism (a `memoryShape.perUser`/`memoryShape.scope` flag) would be a WIRE
   change and break D5. P3 instead adds a **host-local** `AgentProfile.memoryScope?:
   'agent' | 'per-user'` (default `'agent'`) — the same non-normative host-ext
   record that already owns capabilities/knowledge/autonomy. No `schemas/` change,
   no RFC; D5 holds.

2. **OQ1 decided → Option B (the acting participant's own `user:<subject>`), NOT
   the composite `agent:<id>:user:<uid>`.** The composite the ADR's F1 leaned
   toward is, in this host, both **inert** (no writer targets it — ADR 0120
   auto-extract writes the participant's own `user:<id>`) and **un-purgeable** (the
   in-memory `clearMemoryScope` is an exact `Map.delete`, not a prefix scan, so
   `rosterCascade` could never reap the composites → a NEW orphan/leak). Option B
   dissolves both: KickBot recalls the acting participant's own `user:<id>` scope —
   F1-safe by construction (A reads `user:A`, B reads `user:B`) and
   teardown-trivial (KickBot does not OWN that scope; the participant does and
   outlives it, so the cascade correctly leaves it alone). The generic resolver
   keeps a future switch to the composite a one-line change (plus a prefix-clear
   teardown) if a product ever needs agent-private per-user notes.

3. **The memory + KB halves unlock together through the `knowledge` capability.**
   The interactive chat's only durable-memory-into-turn path
   (`chatContext.ts` → `resolveAgentKnowledgeRetrieve`) is gated on the `knowledge`
   capability. So enabling per-user memory recall REQUIRES activating `knowledge`,
   which `setAgentKnowledge` does when the KB collection binds — the two halves are
   correctly one phase. The scope decision itself is a single generic seam:
   `resolveAgentMemoryScope(profile, { actor })` (`agentMemoryAdapter.ts`), used
   inside `resolveAgentKnowledgeRetrieve`, keyed off `profile.memoryScope` and the
   acting user — **no `if (agentId === 'host:kickbot')` anywhere** (David's law).
   Fail-closed: `per-user` with no acting user recalls from an agent-unique empty
   sentinel scope, never the shared `agent:<id>` scope.

Also corrected on the KB half: enrollment context stays **tool-mediated**
(`KICKBOT_READ_TOOLS`), NOT forced into the tenant KB (per-user + dynamic vs
tenant-scoped collections); and the KB collection is a **new managed
`kicktodoKnowledgeService`** (reserved `_kickbot` sentinel org, `managed:'kickbot'`,
challenge-publish/retire lockstep) — bigger than "bind an existing collection,"
because no challenge-sources KB collection existed. Its teardown (drop the
collection when KickBot is deleted, since the cascade reaches the binding but not
the collection) is wired in P3 via the ADR 0288 roster-lifecycle seam.

## Correction notes (P4 architecture review, 2026-07-19)

The P4 review settled the honest scope of "consent-gated connections" against the
existing host code, and corrected two framings:

1. **There is NO consent record to invent — a user's Connection (BYOK) GRANT is
   the consent.** The originally-implied "consent to timezone/cadence/quiet-hours/
   tool access" is already composed from existing signals: timezone is
   per-enrollment; cadence is `heartbeatIntervalMs` (KickBot's is OFF); quiet-hours
   is enrollment **snooze** (`setEnrollmentSnooze` — a first-class, no-guilt pause);
   tool access is the allowlist. A calendar/messaging connection is consented by the
   user granting it in the Connections broker (ADR 0024). No new store, no new
   surface.

2. **The fail-closed enforcement already EXISTS and is generic — P4 does not build
   a KickBot-specific gate.** `resolveConnectionReadiness` (`connectionReadiness.ts`)
   resolves an agent's `requiredConnections` (concrete provider OR `capability:`
   token) against the user's ACTIVE connections, fail-closed (unmet ⇒ `missing`);
   `gateAutonomyByReadiness` forces `review` whenever `!allConfigured`, and the
   heartbeat composes it (ADR 0033 §3.3) — so a twin never autonomously acts on an
   integration it cannot reach. This is profile-driven, no agent-id special-case
   (David's law).

**What P4 ships now vs Wave-3 (the real gate):** KickBot is ALREADY fail-closed by
construction — it declares NO `requiredConnections`, carries read-only tools
(today/progress; no connection/egress/write tool), heartbeat OFF, autonomy
`review`. It uses zero connections and never acts autonomously. So the actual
calendar/messaging *binding* is genuinely **Wave-3** (no provider tool is wired for
KickBot; wiring one would contradict its read-only / propose-not-act posture) — a
real external gate, not scope-cutting. P4's buildable-now deliverable is the
**fail-closed TRIPWIRE** (`kicktodo-kickbot-connections.test.ts`) that LOCKS this
posture so P5 (dispatch) / P6 (teardown) cannot silently give KickBot a connection
or a hidden cadence, PLUS a positive proof that the generic gate would force-review
KickBot the instant it ever declared a connection it can't reach. When Wave-3 wires
a real integration, the consent = the user's grant and the enforcement is the
already-tested `resolveConnectionReadiness` + `gateAutonomyByReadiness` path — no
new mechanism.

*[**CORRECTION (2026-07-20):** "no provider tool is wired" is precise, but "Wave-3"
overstates the gap. The Connections BROKER + the `email-calendar` capability
category (`connectionsService.ts:275` — gmail/microsoft-graph) + outbound MESSAGING
providers (`messagingOutbound.ts:17` — slack/discord/telegram/whatsapp) already
EXIST. So the deferral is not "the providers don't exist" — it is that KickBot
declares no `requiredConnections` and there is no KickBot integration tool/node that
USES a calendar/messaging connection. That is a PRODUCT-scope decision (should a
guide post calendar reminders?), not blocked infra. The fail-closed invariant P4
shipped is correct either way; building the KickBot-uses-calendar integration is a
future product phase that would ride the existing broker + `connectionReadiness`
gate — no new mechanism.]*

---

## Correction notes (P5 architecture review, 2026-07-19)

The P5 review settled the "convene a specialist" mechanism against a HARD
architectural seam the ADR's D2 prose didn't anticipate:

1. **A chat feature tool is SECRET-LESS, so live LLM specialist advice is
   structurally impossible from the chat-time path.** `BuiltinTool.run(input,
   scope)` receives a `BundleScope` with `secrets:{}` and no provider adapter, so
   the convene tool CANNOT call `runAgentDispatchLive` (which needs BYOK/provider).
   The tool-available dispatch is the DETERMINISTIC `runAgentDispatch` — the same
   seam `a2aServer`/`workforceEval` use ("as any named agent invokes a handoff") —
   which validates the handoff task/return contract and confines the specialist to
   its own allowlist, credential-free.
   *[**CORRECTION — see the "P5 live-convene completion" note below.** This
   "structurally impossible" claim is FALSE. A chat tool cannot reach the caller's
   BYOK, but it CAN make a live **managed** model call: `dispatchManagedChat` needs
   only `tenantId` and resolves the host server key itself, `conversationToolLoop`
   itself already runs on it, and `WEB_RESEARCH` (a secret-less chat tool) already
   reaches a host key. The accurate reason live is not run SYNCHRONOUSLY in the tool
   is (a) the credential-less tool layer is a deliberate prompt-injection boundary
   (OWASP) and (b) a synchronous nested live sub-agent is the discouraged pattern
   (cost/blocking/recursion). The tool CANNOT `startWorkflowRun` (its scope has no
   `storage`/`hostSuite` deps) — but it CAN reach the scheduler, which is exactly
   how live convening is now completed, async.]*

2. **The specialists shipped with NO handoff schemas, so the deterministic
   contract was vacuous.** `feature.kicktodo.agents` v1.2.0 declared read-only
   allowlists + scratchpad memory but no `handoff.{task,return}SchemaRef`, so
   `runAgentDispatch` validated nothing and returned `{ok:true}`. P5 adds a shared
   typed handoff contract (`schemas/specialist.task.schema.json` +
   `specialist.return.schema.json`, referenced by all 4 specialists), bumping the
   pack to **1.3.0** and its pin in `feature.ts` in lockstep. This is what makes
   "KickBot dispatches a specialist; specialist cannot write domain state (typed
   contract holds)" real and test-enforced, not a vacuous stub.

3. **The convene tool returns a DISPATCH RECORD, never fabricated advice
   (David's-law honesty).** `openwop:kicktodo.convene` (a `registerFeatureAgentTool`
   chat-time tool, pack-allowlisted onto KickBot — never the ADR 0315 default
   baseline, fail-empty without a human principal) resolves the specialist from a
   CLOSED allowlist (never a free-form agentId from the model), dispatches it
   deterministically, and returns `{status, persona, toolSurface, provenance,
   error?}` — the schema stub is NOT surfaced as advice. Confinement is enforced by
   `filterTools` intersecting the offered read-only surface with the specialist's
   own read-only allowlist, so a convened specialist can never receive (much less
   call) a domain-write/egress tool. The convening is attributed via
   `provenance.parentAgentId = scope.agentProfileId` — generic, no agent-id
   special-case.

## Correction notes (P5 live-convene completion, 2026-07-20)

A follow-up `/architect` review (Track A, boundaries) + web research overturned
the P5 note's item-1 premise and completed the live half:

- **The "secret-less ⇒ impossible" justification was factually wrong** (see the
  item-1 correction). The `openwop:tasks.schedule-followup` tool is an
  already-shipped, secret-less, `registerFeatureAgentTool` chat-time tool that
  convenes a **live** agent on `managed:openwop-free` and posts real output back —
  a direct in-tree refutation, and the exact seam convene should use. The real
  constraint is narrower: a tool's scope carries no run-starter deps, so it can
  reach the **scheduler** (`registerJob`) but not `startWorkflowRun`.
- **The DESIGN (validate the contract synchronously, run the live specialist
  async) is best-practice** — a synchronous nested live sub-agent inside a tool
  turn is the discouraged pattern (cost/blocking/recursion; Anthropic
  orchestrator-workers, OpenAI code-orchestration, Temporal durable handoffs all
  favor the async split), and a credential-less tool layer is a deliberate
  prompt-injection boundary (OWASP). So the fix keeps the sync contract-check and
  ADDS the endorsed async live execution — it does NOT run a synchronous nested
  model call.
- **Live convening is now COMPLETE, not deferred.** `conveneSpecialist` (1) runs
  the sync contract-check + confinement (unchanged), then (2) registers a fire-now
  one-shot scheduler job firing a new feature-owned turn-workflow
  (`openwop-app.kicktodo.convene-turn` — a single host `agent-runner` node, the
  `scheduled-agent-chats`/`channels` per-feature precedent, NO parallel run model)
  that runs the specialist LIVE on `managed:openwop-free` and posts its advisory
  reply back into KickBot's conversation. Bounded (per-participant pending cap),
  deterministic jobId (retry-safe), fail-SOFT to the validated contract when there
  is no conversation or the run can't be scheduled. No BYOK, no new run/dispatch/
  scheduler model, no wire/RFC.
- **LIVE confinement (code-review BLOCKER, fixed).** The initial cut claimed the
  read-only allowlist confined the live turn "identically" — FALSE. `runAgentDispatchLive`
  computes `effectiveToolAllowlist(manifest, override)`, which — absent an override
  — UNIONS the ADR 0315 default-on baseline (`kanban.add-todo`, `documents.draft`,
  `email.draft`, `ai.research.web` egress, `tasks.schedule-followup` recursion, …)
  onto the agent's allowlist. So a convened "read-only advisory" specialist would
  have gotten live write + egress + a fan-out-bypassing recursion vector. FIX:
  before firing, `conveneSpecialist` sets an ADR 0104 FULL-REPLACE override =
  the specialist's read-only manifest allowlist, so `effectiveToolAllowlist`
  returns EXACTLY the read-only set (no baseline). The live offering is now the
  specialist's read tools only — test-enforced (`effectiveToolAllowlist` excludes
  every baseline id WITH the override, includes them WITHOUT — non-vacuity pinned).
  Leave-no-trace: the durable per-(tenant,agent) override is cleared on KickBot
  teardown (`clearConvenedSpecialistOverrides` on the ADR 0288 hook), so a convene
  leaves no residue after the guide is gone.

## Correction notes (P6 architecture review, 2026-07-19)

P6 is tripwires only — the host cascade + the P3 KB-teardown hook already do the
right thing; P6 LOCKS the two invariants after P1-P5 composed every binding.

1. **Teardown of the P2 daily-loop = Option A (accept deletion), because "detach"
   is unrepresentable without re-architecting P2.** `deleteRosterMemberCascade`
   deletes every job from `listJobsByRoster(host:kickbot)`, and P2 gave the
   participant's daily-loop `rosterId:host:kickbot` (its owner-subject). Since
   `ScheduledJob` is `rosterId` XOR `ownerSubject`, there is NO field for
   "attributed-to-KickBot but owned-by-participant" — so the generic cascade
   cannot distinguish this job from a genuinely KickBot-owned one, and a re-arm
   hook would recreate the same `continuationJobId` STILL under `host:kickbot`
   (the very orphan §6.8 forbids). So the cascade deletes it, leaving no orphan
   under the retired identity — the David's-law-clean outcome (no `host:kickbot`
   branch). Crucially the cascade deletes the guide's **daily-loop JOB, not the
   challenge**: the participant's enrollment/goal/board are user-owned and never
   cascade-reached, and their `user:<id>` memory (P3 Option B) survives. **A guide
   teardown stops the participant's daily cadence, not their goal — an idempotent
   re-arm on re-provision (deterministic `continuationJobId`) is the recovery
   path.** A per-job attribution-vs-owner field is a possible Wave-1 refinement,
   but it is a generic `schedulingService` change that re-opens P2 — out of scope.

2. **No teardown gap for any P1-P5 binding.** Board/profile (capabilities +
   memoryScope + knowledge binding)/agent-memory/twin grants are reaped by the
   host cascade; the P3 KB collection by the ADR 0288 `registerKickbotLifecycleHooks`
   hook (fires LAST); the P5 convene tool dies with the profile + user-agent. The
   only residue — the goal's `host.armedJobRef` dangling after its job is deleted —
   is harmless (idempotent re-arm converges; clearing it would be a cross-owner
   write into user-owned goal state, which is worse).

3. **Rename continuity (D4): a rename touches NOTHING but persona/label.**
   `updateRosterEntry({persona,label})` patches only the roster row — it
   structurally cannot reach the profile/KB/user-agent/job stores. So the STRONG
   guarantee the tripwire proves is that identity is never patched by the rewrite
   (rosterId, roleKey, agentRef survive); the cross-store bindings (board +
   conversation ids, profile capabilities [coaching+knowledge], `memoryScope:
   'per-user'`, the knowledge/KB binding, the P5 convene tool, the P2 daily-loop
   attribution) are pinned byte-identical as a GUARD — they are constructionally
   untouched today, and the tripwire fails if a future rename ever re-provisions or
   wipes them. (Honest scoping: it is a re-provision guard on the cross-store
   fields, not a coupling test — there is no coupling for a rename to break.)

---

## Phased plan

Ordered so each phase lands at a real gate and each element is independently
verifiable. **None implemented.** Each phase is behind the existing KickTodo
feature toggle and provisioned heartbeat-OFF / review-autonomy (never a hidden
cadence).

| Phase | Composes | Owner seam | Lands when | Verifies |
|---|---|---|---|---|
| **P1 — Identity + profile + branded agentRef** | brand a host-registered user-agent `user.kicktodo-guide` (the Iris `ensureUserAgentRegistered` precedent — NOT a pack manifest, see correction note); write the AgentProfile (tools, autonomy, HITL) get-or-create + heal; **define + activate the new `coaching` capability** | `ensureUserAgentRegistered` (`routes/userAgents.ts:354`); `agentProfileService` upsert/activate; ADR 0031 activation | `ensureKickBot` registers the user-agent + writes the profile idempotently; no pack change | profile round-trips; capability active; agentRef pinned; **rename still structural** |
| **P2 — Schedule / Daily Coach presentation** | bind the daily-loop schedule to `rosterId: host:kickbot` and project it onto the agent-work board; render in profile Schedules/Board tabs | `registerJob`/`scheduleSubject`/`listJobsByRoster` (`schedulingService.ts:266,284`); `armContinuation` (`enrollmentService.ts:210`); ADR 0025 tabs | the daily-loop already fires (KTFULL-B5) — this phase re-attributes/presents it, no new loop. **P2 correction: does NOT project onto the board** — mirroring daily occurrences would create a second completion truth (D3); schedule attribution alone lights up the Schedules + Activity tabs | daily plan shows as KickBot's schedule; heartbeat still OFF; completion truth stays on the participant board |
| **P3 — Knowledge + memory** | bind challenge content + product guidance as a managed KB (enrollment context stays TOOL-mediated); wire per-user memory with the F1-safe scope | generic `resolveAgentMemoryScope(profile,{actor})` (`agentMemoryAdapter.ts`) inside `resolveAgentKnowledgeRetrieve`; host-local `AgentProfile.memoryScope`; new `kicktodoKnowledgeService` (managed collection + publish/retire lockstep + teardown) | ✅ implemented — **Option B** (participant `user:<id>` scope), NOT the composite (inert + un-purgeable here); `knowledge` capability unlocks both halves | retrieval cites sources; **cross-user memory isolation test** (F1) passes (non-vacuity verified) |
| **P4 — Connections (consent-gated)** | ✅ the fail-closed INVARIANT is tripwire-locked now (consent = the user's Connection GRANT; the generic `connectionReadiness` + heartbeat force-review IS the enforcement); actual calendar/messaging BINDING is Wave-3-deferred (no provider tool wired — would break KickBot's read-only posture) | `resolveConnectionReadiness`/`gateAutonomyByReadiness` (`host/connectionReadiness.ts`); Connections broker grant = consent (ADR 0024/0033) | ✅ implemented — tripwire in place; real binding waits on the Wave-3 integrations gate (see P4 correction note) | fail-closed without consent + no autonomous connection use — **test-enforced** (non-vacuity verified) |
| **P5 — Specialist dispatch** | ✅ `openwop:kicktodo.convene`: sync handoff-CONTRACT check (`runAgentDispatch`) + async LIVE run of the specialist via the scheduler→`openwop-app.kicktodo.convene-turn` workflow→managed `agent-runner`, posting advice back into the chat; typed handoff schemas on the 4 skills (pack 1.3.0 + pins) | `runAgentDispatch` + `filterTools` confinement; `registerFeatureAgentTool` (pack-allowlisted); `registerJob` + `agent-runner` (the `schedule-followup` seam) | ✅ implemented — **live convening complete** (async, managed, post-back — corrected from the deferral premise) | KickBot convenes a specialist that runs LIVE + posts advice back; **typed contract** enforced (task-schema violation = typed failure, nothing run); read-only confinement on BOTH the sync check and the live turn — **cannot write domain state**; bounded fan-out (test-enforced) |
| **P6 — Continuity + teardown tripwires** | ✅ `kicktodo-kickbot-lifecycle.test.ts` — rename-continuity (identity never patched; cross-store P1-P5 bindings pinned as a re-provision guard) + the no-orphan teardown tripwire (the cascade + P3 KB hook already do the right thing; P6 LOCKS it) | `rosterLifecycle` (ADR 0288) + `deleteRosterMemberCascade`; `updateRosterEntry` | ✅ implemented — teardown = Option A (delete the daily-loop JOB, not the challenge; §6.8 no-orphan) | rename byte-identical across all bindings; teardown leaves no armed job under the retired identity; participant state survives |

**Gate rationale (not scope-cutting):** P1 must precede P2–P5 because every later
binding keys off the profile/identity P1 establishes; P3's cohort half waits on
the Wave-1 shared-tenant gate (F1); P4 waits on the Wave-3 integrations + explicit
consent gate; P6 is last so its continuity tripwire covers all prior bindings.
The full §6.8 vision stays in scope — this is sequencing, per `ARCHITECTURE.md`
§Scope Rule.

---

## Alternatives weighed

1. **Build a KickBot subsystem (profile store + scheduler + memory/KB store +
   specialist registry).** *Rejected* — the parallel-system anti-pattern
   `ARCHITECTURE.md` §"Architecture contract" forbids and the exact class of
   failure the KickTodo audit punished. Two owners for one concept drift and
   disagree; it also duplicates replay/fork, RBAC, and BYOK per store. Composition
   makes the existing system more capable instead of standing a second copy beside
   it.
2. **One roster row per user (D1 alternative).** *Rejected for now* — see D1.
   Explodes the roster, fragments identity, multiplies heartbeat/schedule surface;
   the solo-workspace boundary already delivers per-user instances for free.
   Reserved for a future per-user-rename-in-shared-tenant need (OQ2).
3. **Specialists as named roster agents (D2 alternative).** *Rejected* — would put
   five more named agents per tenant on the roster, invert the shipped
   named-vs-handoff taxonomy, and give safety/verifier agents standing identity +
   memory they must not have (they are stateless, scratchpad-only reviewers). Skills
   dispatched by the one named agent is the correct grain.
4. **A KickBot-specific "Daily Coach" workflow loop (D3 alternative).** *Rejected* —
   a second cadence engine beside the scheduler + heartbeat, forbidden by PRD §1
   ("the scheduler is the only time-of-day cadence engine"). The existing
   daily-loop + goal continuation already does the orchestration; KickBot only
   needs to *present/own* it.
5. **Store per-user memory in the shared agent scope (F1 alternative).**
   *Rejected* — the cross-user leak in F1. The subject-keyed / composite scope is
   the isolation-preserving choice and rides the same owner.

---

## Open questions

- **OQ1 (F1 shape) — DECIDED at P3: Option B (the participant's own `user:<id>`).**
  The composite `agent × user` is inert (no writer) + un-purgeable (exact-delete,
  not prefix-scan) in this host, so P3 keys KickBot's recall on the acting
  participant's own `user:<subject>` — F1-safe by construction, teardown-trivial.
  The generic `resolveAgentMemoryScope` seam keeps the composite a reversible
  one-line future change (plus a prefix-clear teardown). See the P3 correction
  note. Trade-off accepted: KickBot's "memory of the user" IS the user's own
  namespace (shared with their twin/other granted agents) — apt for a personal
  guide in the user's own workspace.
- **OQ2:** does any product surface need per-user **rename** inside a *shared*
  cohort tenant? If yes, revisit D1's rejected per-user-instance option for that
  tenant class only. No evidence of the need in Waves 0–2.
- **OQ3:** teardown retention (P6) — does disabling KickBot erase per-user memory
  or retain it under the retirement contract? Defer to the product retention
  policy (PRD §6.8 teardown paragraph); the code path must support both.
- **OQ4:** should specialist dispatch (P5) ever ride an RFC 0021 envelope rather
  than an in-loop handoff? Only if cross-host portability of the dispatch is
  needed — that is a future RFC gate, out of scope here (D5).

---

## Feature-matrix (evaluation rubric)

| Dimension | Verdict for this ADR |
|---|---|
| **Feature-package architecture (ADR 0001)** | Pass — all work lands in `features/kicktodo-core/kickbotService.ts` + the `feature.kicktodo.agents` pack; no core route/nav edits; binds owners via their public seams. |
| **Toggle / admin UI** | Pass — gated by the existing KickTodo feature toggle; KickBot surfaces reuse the ADR 0025 profile tabs (Schedules/Board/Activity/Connections), no bespoke admin surface. |
| **Workflow + node packs** | Pass — reuses `openwop-app.kicktodo.daily-loop` + `feature.kicktodo.nodes`; no new workflow engine; specialist skills already in `feature.kicktodo.agents`. |
| **AI-chat envelopes + agent packs** | Pass — the ONE chat (RFC 0005) renders the guide's durable conversation; specialists dispatch through the shared manifest runtime; capability activation via `agentProfile` (ADR 0031), not a `roleKey` special-case. |
| **RBAC / tenant isolation** | Pass with **F1 caveat** — all bindings tenant + subject scoped; per-user memory MUST use the isolated scope (F1) before shared cohort tenants ship. |
| **Replay / fork** | Pass — identity/agentRef/profile bindings are stamped structurally and read verbatim (ADR 0379); the daily-loop run already carries its seeded inputs (KTFULL-B5); rename never re-resolves historical attribution. |
| **RFC gate** | Pass — host-private, additive, no wire change (D5); no new `../openwop/` RFC. |

---

## Implementation record

*(empty — nothing implemented. Populate a phase→commit/test row here only when the
cited artifact lands, then advance the Status line. Do not pre-fill.)*

| Phase | Status | Commit | Test |
|---|---|---|---|
| P2 | **implemented** 2026-07-19 | (this PR) | `kicktodo-daily-loop-attribution.test.ts` — job attributed to host:kickbot, listJobsByRoster returns it, heartbeat still OFF, NO board mirror (single completion truth), idempotent | 
| P1 | **implemented** 2026-07-19 | (this PR) | `kicktodo-kickbot.test.ts` — profile round-trip, coaching capability by-capability resolve, branded agentRef, idempotent no-clobber, capability self-heal, rename-structural, tenant isolation, assistant-invariant-intact |
| P3 | **implemented** 2026-07-19 | (this PR) | `kicktodo-kickbot-memory-isolation.test.ts` — `resolveAgentMemoryScope` decision (per-user/shared/fail-closed-sentinel), F1 cross-user isolation (A recalls A, never B; no-actor recalls neither), profile carries per-user + knowledge, forward-repair heal without clobber, KB ingest+publish/retire lockstep, teardown drops the collection while participant memory survives. Non-vacuity verified (F1 tests fail against the shared-scope neuter). |
| P4 | **implemented** 2026-07-19 (invariant; binding Wave-3-deferred) | (this PR) | `kicktodo-kickbot-connections.test.ts` — KickBot declares no required connections + read-only tools + heartbeat OFF + review autonomy; trivially connection-ready (needs none); an unmet required connection reports missing → `gateAutonomyByReadiness` forces review; the gate is a pure consent switch. Non-vacuity verified (tripwires fail if KickBot gains a required connection). |
| P5 | **implemented** 2026-07-19 (deterministic; live advice deferred) | (this PR) | `kicktodo-kickbot-convene.test.ts` — convene dispatches a specialist (status completed + echoed provenance); a contract-violating task is a TYPED failure (`task_schema_violation`, non-vacuity verified vs a no-validator neuter); a convened specialist is confined to its read-only allowlist (write/egress filtered from the surface — cannot write domain state); closed-allowlist rejects an unknown/free-form specialist; fails empty without an actor; pack-parity (every convenable specialist is a handoff-typed pack agent). Convene tool added to the P4 allowlist tripwire. |
| P6 | **implemented** 2026-07-19 | (this PR) | `kicktodo-kickbot-lifecycle.test.ts` — rename changes only persona/label (rosterId/roleKey/agentRef/board/conversation/profile [coaching+knowledge]/memoryScope/KB binding/P5 convene tool/P2 attribution all byte-identical); teardown leaves NO armed job under `host:kickbot`, reaps board+profile+agent-memory+KB collection, and the participant's own `user:<id>` memory + enrollment SURVIVE (guide deleted, not the challenge). |
| Guide wave — chat-first + fuller grounding | **implemented** 2026-07-22 | (this PR) | The Guide page (`GuidePage.tsx`) becomes CHAT-FIRST — embeds the ONE shared chat scoped to `host:kickbot` via `EmbeddedChatPanel` + a `GuideWelcome` empty state with context-aware seeds (next action, pending coach proposal), keeping the full-chat deep-link escape hatch (the Studio precedent; fulfils ADR 0436 §5.8's chat vision — see that ADR's correction note). KickBot's GROUNDING reads grow +3 (plus `circles` allowlisted) so coaching is relevant to "today" + real progress: `journal`, `plan` (forward), `proposals` (coach plan-changes), and `circles` (tool already existed). Engagement standing + awards ride the chat-first-port `engagement-summary` tool KickBot already carries — the Guide wave adds NO separate achievements/leaderboard tool (that would DUPLICATE it; the boundaries check caught this when the chat-first-port work landed in parallel). All new reads are self-scoped fail-empty READS sharing their route owner-predicate, pack-allowlisted onto KickBot via `KICKBOT_READ_TOOLS`, none default-on. Tests: `kicktodo-guide-tools.test.ts` (registration + fail-empty for journal/plan/proposals + 31-day span cap), `kicktodo-kickbot-connections.test.ts` (P4 tripwire re-pinned to the exact new set — still NO write/egress/connection tool). Self-owned WRITES (log-checkin/add-note) deferred to a Wave-2 behind the existing HITL approval-card gate. |
| Guide wave — Wave 2 (the action loop) | **implemented** 2026-07-22 | (this PR) | KickBot gains its FIRST bounded WRITE, `openwop:kicktodo.log-checkin(cardId required-exact, note?, measuredValue?)` — the participant completes today's action from chat ("mark my run done, felt great"). It composes the ONE governed write `submitCheckIn` (owner-check + declared evidence policy + idempotent — no second write path), so its predicate EQUALS the `POST /kicktodo/check-ins` route's. `add-journal-note` FOLDS IN (the journal is a projection over check-in notes — no separate store, so a note rides `evidence.note`; no separate tool). **Doctrine held via the existing HITL card, not a workflow** (`/architect`: a workflow would be overkill/duplicative for a single idempotent write): `log-checkin` is added to `SENSITIVE_APPROVAL_TOOLS` (`firewallHook.ts`), so in `safe` mode (KickBot's default; `permissionMode` defaults to safe) it is deferred for the one-click `interrupt.approval` card — nothing writes until the user approves. **Read-before-write** guards mis-mapping (no undo): the tool REQUIRES an exact `cardId` (never fuzzy NL), and the prompt makes KickBot read `today`, name the action, and log only what the user confirms; it echoes the card's human title. The P4 tripwire is relaxed from "no write tool" to **"exactly one, approval-gated, self-only"** — `kicktodo-kickbot-connections.test.ts` now pins the write set = `[log-checkin]` AND `log-checkin ∈ SENSITIVE_APPROVAL_TOOLS` (a second/unGated write turns it red). Tests: `kicktodo-log-checkin-tool.test.ts` (fail-empty, cardId-required, foreign→not_found owner-check, evidence-policy refusals, idempotent happy path, title echo). `recover`/`substitute` writes DEFERRED to Wave 3. No RFC (chat-time tool). |

## Grade-trio review (2026-07-20)

Terminal holistic grade over the composed P1-P6 delta — `/grade-code` **A−**,
`/grade-data` **A−**, `/grade-ux` **N/A** (backend-only; KickBot rides the existing
chat + ADR 0025 profile tabs — no new frontend surface). No blockers. Fixes applied:

- **[FIXED] Hot-path write amplification (grade-code).** `ensureKickBot` runs on
  every enroll / daypart-set / `GET /kickbot`, and step 1c (KB ensure + bind) ran
  UNCONDITIONALLY → a profile write + KB doc upsert on every read (the SPA-poll
  fan-out CLAUDE.md warns about). Now GUARDED: bind only when the managed collection
  isn't already bound (first provision or forward-repair). New challenges stay
  current via the `publishChallenge` sync hook, not this path.
- **[FIXED] `collectionIds` clobber (grade-data — the top data finding).**
  `setAgentKnowledge`'s shallow-merge REPLACES the array, so a re-provision could
  drop a collection an admin/curator bound to KickBot (a real roster agent). The
  bind is now ADDITIVE — it unions the managed id with any existing binding.
- **[FIXED] `SPECIALIST_PACK_VERSION` drift (grade-code).** The hand-held `'1.3.0'`
  is gone; `convene` now stamps `provenance.specialistVersion` from the RESOLVED
  manifest's `packVersion` (the loaded pack is the source; the existing
  `required-packs-pin-parity` test already pins feature.ts↔pack.json).

Acknowledged (not fixed — correct-as-is / future):
- **Deferred live-advice memory (grade-code).** The P5-deferred `agentRunnerNode`/
  workflow path (`bootstrap/nodes.ts`) calls `resolveAgentKnowledgeRetrieve` with
  NO actor, so a `per-user` agent there fails closed (recalls the empty sentinel,
  never another user). When live specialist advice lands, thread the acting
  principal into that dispatch (or accept agent-scope-only memory there). Fail-safe
  today; noted for the deferred phase.
- **Reminder jobs (ADR 0443) share KickBot attribution + teardown fate.** They also
  carry `rosterId:host:kickbot`, so the cascade reaps them alongside the daily-loop
  — the SAME Option-A rationale (idempotent re-arm on re-provision). Documented here
  so the P6 teardown note covers the whole KickBot-attributed schedule set.
- **Stale challenge-version KB docs** faithfully mirror the challenge model
  (multiple published versions can coexist; `listPublished` returns all). A KB
  concern only if single-live-version is ever intended — not a KB defect.
- **Lifecycle-hook registration** is boot-time + toggle-INDEPENDENT
  (`registerBackendFeatures` calls `registerRoutes` unconditionally), so the
  KB-teardown hook is always present whenever a KickBot can exist — verified.

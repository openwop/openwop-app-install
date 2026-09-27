# ADR 0414 — `kicktodo-core` feature package (participant loop + KickBot named agent)

Status: **implemented** — all phases P1–P5 landed 2026-07-18 (phase record at the end of this file)

**Requirements source:** `docs/kicktodo-prd.md` §5–§9 (the executable design lives there; this ADR records the boundaries, decision, phasing, matrix, corrections, and RFC verdict).
**Depends on:** ADR 0412 (goals controller — one goal per enrollment), ADR 0413 (native client — participant screens), and the existing owners it composes: roster/agent-profile (ADRs 0031/0379), scheduler (RFC 0052 / ADR 0025), Kanban (ADRs 0045/0046), conversation (RFC 0005), KB+memory (ADR 0038), notifications (ADR 0010), media (ADR 0007), distribution (ADR 0366), workspace-as-tenant (ADR 0015).
**Surface:** host-extension `/v1/host/openwop-app/kicktodo/*`. **NO new RFC.**

## Why this exists

`kicktodo-core` is the consumer product spine: challenge enrollment, the daily-action loop, check-ins, the Today projection, progress, and the per-user **KickBot** named agent. It composes existing owners — it must add no parallel run/goal/schedule/board/agent/notification/money model.

## Boundaries audit (Step 3 — verified against live code)

- **Route namespace is clean:** no existing `/v1/host/openwop-app/kicktodo` registrant. Feature routes mount after the core `ROUTE_MODULES`, so the prefix is collision-free **only if all KickTodo packages coordinate under one owner** — a route-registration test must enumerate the full prefix and fail on any intra-KickTodo method/path collision.
- **Board (daily actions):** `kanbanService.ts` is the subject-owned owner — `KanbanBoard.ownerSubject` (`:139`, ADR 0045/0046 forward field), `ensureSubjectBoard`/`subjectBoardId` (`:288-300`), terminal-column completion (`KanbanColumn.terminal`/`terminalKind` `:47-52`, `KanbanCard.completedAt` `:113`). **No free-form metadata bag** — KickTodo meaning goes in a *separate* `KickTodoActionOccurrence` record keyed by the deterministic card id, not on the card (cleaner than metadata-on-card).
- **KickBot named agent:** a `RosterEntry` (`rosterService.ts:44-91`). **Rename-continuity is already structural** — `rosterId` is minted once (`rosterService.ts:145`) and `updateRosterEntry` never touches it (`:203-245`); board/schedules/`agent:<id>` memory/activity all key on `rosterId`; `roleKey` is the name-independent handle (`:82-88`, ADR 0379 decouples id from tenant *and* name). Every §6.8 capability maps to an existing owner (profile/workflows/schedules/KB/memory/board/conversation/connections/activity).
- **Per-user provisioning:** the roster is per-tenant, but every user has a **personal workspace** (`user:<userId>`, ADR 0015; `ensurePersonalWorkspace`, `accessControlService.ts:641-647`), and **ADR 0025 already auto-provisions a per-user board at that choke point**. KickBot is the mirror: provision a per-user roster entry there. Pattern exists as `ensureSeededAgentByRole` (`exampleDataSeed.ts:409-437`).
- **David's law (`ARCHITECTURE.md:162-168`):** coaching capabilities MUST be a **core `AgentCapabilityId` activated via `agentProfile`**, specialists shipped as handoff skills in the signed pack — never source hard-coded to "KickBot."

## Decision + data model

New feature package `src/features/kicktodo-core/` owning (PRD §6): `ChallengeDefinition` (published-immutable, content-addressed), `ChallengeEnrollment` (pins challenge version + `goalId` → ADR 0412 owner), `KickTodoActionOccurrence` (deterministic `cardId` from `(enrollmentId, localDate, stableActivityId, planRevision)`), `CheckIn` (user-owned, private-by-default), a **rebuildable** progress projection, and the **KickBot provisioning saga**. Enrollment/daily-loop are the sagas in PRD §8.3–§8.4.

### M3 build+test items promoted to explicit work (review finding M3)
1. **Kanban `createCard({cardId})` idempotency + cross-board fail-closed** — ~~verify or establish~~ **VERIFIED + PINNED (B1, 2026-07-18):** the exact semantic already existed (`kanbanService.ts` createCard — ADR 0311 deterministic-id path + grade-pass fix GC-0311-1: same-board re-create returns the prior card untouched; cross-board collision throws), but was un-tested. Now pinned by `test/kanban-deterministic-card.test.ts` (idempotent retry preserves human state; fail-closed hijack; random-id path unaffected).
2. **Rename mention-alias uniqueness** — ~~build~~ **BUILT (B2, 2026-07-18):** `updateRosterEntry` now refuses a persona rename that collides case-insensitively with another same-tenant entry (`PersonaCollisionError` → route 409) — mentions stay unambiguous and a user-renamed KickBot cannot impersonate an existing coworker; rename-path-only so existing seeds are untouched. Pinned by `test/roster-persona-collision.test.ts` (incl. rename-continuity: `rosterId`/`roleKey`/`agentRef` survive). The AI-disclosure guarantee is a UI concern — carried to C5's participant surfaces.
3. **Resource-conversation binding seam** — cross-workspace circles need it; generic chat resolves storage from the caller's active tenant today. **Owned by the later `kicktodo-accountability` ADR (Wave 2)** — stub the seam boundary here, do not weaken generic chat.

### Plan-revision supersession (second-pass review finding, 2026-07-18)

Deterministic occurrence/card ids include `planRevision`, so idempotency holds only **within** one revision. An approved re-plan increments `planRevision`; without an explicit transition step, already-materialized not-yet-terminal cards keyed under the prior revision survive while the next materialization mints new ids for the same logical day/activity — two live cards for one action, a polluted Today, and double-counted progress evidence feeding the ADR 0412 verifier (a second completion truth through the side door). The enrollment/materialization saga therefore gains an explicit **plan-revision transition step**: atomically supersede/cancel the prior revision's non-terminal occurrences and cards *before* materializing the new revision; terminal (completed) cards keep their history and evidence. Required test: an approved re-plan — including one landing mid-day after materialization has already run — yields exactly one live card per `(enrollment, localDate, stableActivityId)` across the revision boundary.

### Provisioning invariant (review finding, roster audit)
A new roster entry with an **absent `heartbeatIntervalMs` inherits the host default and runs autonomously** (`rosterService.ts:70-74`). KickBot provisioning MUST **explicitly** write `HEARTBEAT_OFF` (-1) + `autonomyLevel:'review'` and a **fixed role-derived id** (`host:kickbot`, not slugified from a user-chosen name); a test must assert both.

## Phased plan

| Phase | Ships |
|---|---|
| **P1** | Feature package + `/kicktodo/challenges|enrollments|today|check-ins` REST; enrollment saga (deterministic keys; goal via ADR 0412); occurrence/board materialization **including the plan-revision supersession step**; Today bounded aggregate read (no write-on-GET, no cross-tenant scan). |
| **P2** | KickBot provisioning saga (heartbeat-off/review, fixed id, rename-continuity + alias-uniqueness tests); welcome conversation via the shared chat. |
| **P3** | Progress projection (rebuildable) over board/check-ins/goal events/runs; completion + recovery flows; frozen `kicktodo.progress-evidence` snapshot feeding the ADR 0412 verifier (as the **opaque immutable ref + content hash** contract decided in ADR 0412 — KickTodo owns the snapshot schema; goals stores ref+hash on the verdict). |
| **P4 (core-app extension surface)** | `feature.kicktodo.nodes` (thin adapters over `ctx.features.kicktodo-*`); `feature.kicktodo.agents` (handoff specialist skills — Plan Builder, Safety Reviewer, Progress Verifier; scratchpad-only); host-native `kicktodo.*` artifact schemas; `builtinWorkflows` (enrollment, daily-loop). `/.well-known/openwop`: **nothing** (host-private). |
| **P5** | React web participant surfaces (`<id>Client.ts` + pages + nav via menu registry); native surfaces land through ADR 0413. |

## Feature matrix

1. Feature-package ✔ `src/features/kicktodo-core/`, appended to registries, no core route/nav edits. 2. Toggle `kicktodo-core`, **default OFF** (ON when compiled into the KickTodo distribution), `bucketUnit: user` (personal product; accountability/commerce use `tenant`). 3. Workflow surface: typed `ctx.features.kicktodo-core` read/write behind toggle+RBAC. 4. Node pack `feature.kicktodo.nodes` (signed). 5. Envelopes: none in MVP (host-private routes); a `kicktodo.*` envelope would trigger an RFC. 6. Agent pack `feature.kicktodo.agents` (specialist skills). 7. Public surface: challenge Discover = published-immutable projection only, uniform-404, rate-limited. 8. RBAC (0006): RFC 0048 owner triple + opaque subject; every mutation route-gated + IDOR-guarded; fail-closed; by-id denial uniform-404. 9. Replay/fork: stamp challenge version/hash + plan revision + pack/model versions into run metadata; verifier judges a frozen snapshot; no duplicate nudge/charge/card on replay. 10. Frontend: participant pages web + RN (ADR 0413), `ui/` cohesion + i18n (4-locale) + a11y.

## PRD-vs-architecture corrections

- The PRD's loose "layer KickTodo metadata on the card" is superseded by its own §6.3 (separate occurrence record) — confirmed correct: `KanbanCard` has no free-form bag; keep meaning off the card.
- `CheckIn` is net-new `kicktodo-core` (the `strategy/checkIns.ts` precedent is KR-bound) — correct not to force-fit; reuse its human/agent provenance *pattern*.

## Open questions

1. `ChallengeDefinition` executable structure: host-native rows only in MVP (agreed); the optional workflow-chain-pack export is deferred to real portability need.
2. **H2 (commerce):** paid challenges need a new challenge listing/product type + per-buyer entitlement in `resolveEntitlements` (an ADR 0385 Phase-4 deferral). **Deferred to a `kicktodo-commerce` ADR (Wave 3)**; MVP sells curated first-party challenges through ordinary Commerce. Recorded here so it is not assumed present.

## Implementation record (phase → PR)

| Phase | Landed |
|---|---|
| P1 — `src/features/kicktodo-core/` (types/challengeService/enrollmentService/todayService/routes/feature); `/kicktodo/{challenges,enrollments,today,check-ins}` routes-as-data + collision test (`test/kicktodo-route-collision.test.ts`); enrollment saga (deterministic ids; create-CAS + loser goal-cleanup; ONE principal-owned ADR 0412 goal; ONE trigger-free board per user); occurrence materialization incl. **plan-revision supersession** with the one-live-card invariant (a materialization-duplicate bug was caught by the test and fixed); bounded Today; idempotent check-ins completing the terminal card; toggle `kicktodo-core` OFF/user-bucket + registry append + seed-coverage ACK + `distributions/kicktodo.json` features[]. Storage: DurableCollections with deterministic point keys — NO SQL migration needed at P1 (recorded decision; indexed tables revisit at scale). | kicktodo/c1-core |
| P2 — KickBot provisioning saga (`kickbotService.ts`: fixed `host:kickbot` identity via create-time persona slugging; stable `kicktodo-guide` role; EXPLICIT `heartbeatIntervalMs: -1` + `autonomyLevel: 'review'` — the inherit-default hazard is test-asserted; single-flight idempotent + forward-repairable; roster-bound agent-work board distinct from the participant board; deterministic agent-subject welcome conversation via `ensureConversationMeta` — the shared chat reopens it, no second chat system; persona-squat surfaces a conflict rather than adopting the wrong row; lazy provisioning on first enroll + `GET /kicktodo/kickbot`) | kicktodo/c2-kickbot |
| P3 — progress + judged completion (`progressService.ts`: rebuildable projection; `freezeProgressEvidence` — immutable content-hashed `kicktodo.progress-evidence` rows, the decided ADR 0412 ref+hash contract with a host-private `tenant|enrollment|id` ref encoding; the registered `kicktodo:progress-evidence` verifier re-hashes before judging — tamper is a typed failure, never a verdict — and judges DETERMINISTICALLY (all required activities completed); `evaluateEnrollment` freezes → judges via the goals owner → projects `satisfied→completed`/`escalated→escalated` onto the enrollment (the goal stays the truth); snooze/resume recovery halts/restores materialization; end-to-end replay of the recorded verdict observed through the route) | kicktodo/c3-progress |
| P4 — packs + exchange surface (`feature.kicktodo.nodes` v1.0.0 — 5 thin role:action adapters over the new `ctx.features.kicktodo-core` surface; `feature.kicktodo.agents` v1.0.0 — Plan Builder / Safety Reviewer / Progress Verifier as scratchpad-only handoff skills, read-only tool allowlists; both version-pinned in `requiredPacks`; chat tools `openwop:kicktodo.today`/`.progress` — fail-empty without acting user, owner-scoped; host-native `kicktodo.progress-evidence` + `kicktodo.completion-certificate` artifact types; `builtinWorkflows` enrollment + daily-loop; LLM-EXCHANGE-AUDIT row A− + `kicktodo-artifact-parity` tripwires: real-snapshot schema parity, prompt discipline (no hand-copied typeIds/schema fields), scratchpad-only enforcement, pack-pin lockstep) | kicktodo/c4-packs |
| P5 — React web participant surfaces (`features/kicktodo/`: Today — one-tap Done, snooze/resume, progress verdicts, deep-link to the ONE shared chat `/?agent=host:kickbot`; Discover — published catalog + enroll; `kicktodoClient.ts` React-free client (ADR 0413 contract material); 4-locale i18n catalogs (en/es/fr/pt-BR, auto-globbed namespace); nav group `KickTodo` added to `GROUP_ORDER` (+ drive-by repair: the pre-existing missing `Canvas` group); lazy chunks — entry budget preserved; /ux-review cohesion fixes applied: `.btn*`/`.page-header__*`/`.list-row`/`.list-plain`, labeled chips, designed StateCard empty states) | kicktodo/c5-frontend |

## RFC verdict

**Host-ext, no RFC.** All records are host-private (routes, tables, run metadata, `kicktodo.*` artifacts). A new RFC becomes mandatory only on the PRD §17 triggers (a `kicktodo`/`challenges` capability advert, normative `/v1/challenges` endpoints, `challenge.*` run-event types, a portable cross-host challenge schema, or cross-host accountability semantics).

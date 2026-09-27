# KickTodo Accountability (unit G3) — chat-first port review

**Scope:** `backend/typescript/src/features/kicktodo-accountability/` +
`frontend/react/src/features/kicktodo-circles/` (the accountability UI). Judged
against the app's real primitives: the ONE chat / `EmbeddedChatPanel`, agent
packs + `registerFeatureAgentTool`, `startWorkflowRun` + the existing node
catalog, the HITL approvals/reviews machinery, the scheduling / conversation /
notification / approval single owners, and the DSAR/retention seams.

**Headline verdict:** this unit **already rides the engine**. Circles, grants,
projected feeds, nudges, the conversation binding seam, coach plan-proposals,
cohort sessions, and the session-reminder workflow all instantiate the real
owners; there is **no PARALLEL and no THEATER** of consequence. The bespoke UI
that remains is consent-management (invite/scope/revoke) and read-only history —
both legitimately page-shaped, deliberately *not* chat-driven because consent
writes must stay route-level with the acting human (PRD §8.5.2,
`surface.ts:1-6`). The findings below are a small latent-surface cleanup, one
agency wiring gap, and one drift-watch — not demolitions.

---

## Verdict table

| # | Capability | Today | Verdict | Port target / note |
|---|---|---|---|---|
| 1 | Create circle (partner/circle/cohort/coach) | `CirclesPage` form → `POST …/circles` (`routes.ts:74`) | **PAGE-LEGIT** | Keep. Creation instantiates the conversation owner (`ensureConversationMeta`, `circleService.ts:106`); no primitive shadowed. |
| 2 | Invite grantee + explicit scopes + privacy preview | form → `POST …/invite` (`routes.ts:165`); reveal-preview `CirclesPage.tsx:288-302` | **PAGE-LEGIT** | Keep. The scope-selection + concrete "who sees what" disclosure IS the interface — structured consent, not describe-intent. |
| 3 | Accept invitation (cross-tenant, opaque id) | `POST …/accept` (`routes.ts:187`) → `acceptGrant` (`circleService.ts:202`) | **PAGE-LEGIT** | Keep. |
| 4 | Revoke grant (immediate) | `CirclesPage` button → `POST …/revoke` (`routes.ts:199`) | **PAGE-LEGIT** | Keep — an immediate owner consent control, not a HITL approval. Best-effort seat heal rides `releaseRevokedSeat` (`routes.ts:219`). |
| 5 | List members / grants | `GET …/grants` (`routes.ts:227`) | **PAGE-LEGIT** | Keep (owner-or-live-grantee gated read). |
| 6 | View projected progress feed | `GET …/feed` (`routes.ts:242`) → `circleFeedFor` (`projectionService.ts:67`) | **RIDES** | Pure field-allowlist over kicktodo-core `progressFor`/`todayFor`; live-grant re-checked per read. |
| 7 | Nudge participant (content-free) | `POST …/nudge` (`routes.ts:257`) → `nudgeParticipant` (`projectionService.ts:94`) | **RIDES** | Instantiates the notification owner (`getNotificationEmitter().emit`). |
| 8 | Circle conversation binding seam | `GET …/conversation` (`routes.ts:398`) → `resolveCircleConversation` (`circleService.ts:147`) | **RIDES** | Opaque id → conversation handle after a live-grant proof under the owning tenant; the ONE conversation owner, never a second chat. |
| 9 | Cohort detail + pinned capacity | `POST …/cohort` (`routes.ts:272`) → `createCohortDetail` (`cohortService.ts:100`) | **PAGE-LEGIT** | Domain resource; CAS-held seat count. |
| 10 | Join cohort (CAS seat) | `POST …/join` (`routes.ts:308`) → `joinCohort` (`cohortService.ts:135`) | **PAGE-LEGIT** | Domain capacity claim; capacity check inside the CAS (`claimSeat`, `cohortService.ts:333`). |
| 11 | Seat holds / confirm / release (commerce money path) | `holdSeat`/`confirmSeat`/`releaseSeat` (`cohortService.ts:346/390/441`) | **ADAPTER** | Seat *occupancy* truth is domain state; the money record is the commerce order — the host never moves money here. Fail-closed on oversell; idempotent by `(circle,buyer)`. Watch for drift against the commerce webhook caller. |
| 12 | Operator reconcile-seats | `POST …/reconcile-seats` admin-gated (`routes.ts:329`) → `reconcileSeats` (`cohortService.ts:262`) | **PAGE-LEGIT** | Honest operator repair — recomputes occupancy from durable truth, safe after any partial failure. |
| 13 | Coach caseload console (cross-workspace) | `GET …/coach/caseload` (`routes.ts:341`) → `coachCaseload` (`cohortService.ts:519`) | **PAGE-LEGIT** | Read across workspaces via the grantee pointer index; every row live-grant + `coach-plan-proposal`-scope checked. |
| 14 | Coach proposes plan change (inert) | `POST …/proposals` (`routes.ts:350`) → `proposePlanChange` (`cohortService.ts:551`) | **PAGE-LEGIT** | Proposal row is durable truth; *additionally* raises the participant-facing approval card (item 15). |
| 15 | Participant decides a proposal | approval card (`planProposalApproval.ts:38`) via core decide path; degraded inline apply/dismiss (`CirclesPage.tsx:361-371`) | **RIDES** | Primary path instantiates the approvals owner (`createKicktodoPlanProposalApproval` + `registerPlanProposalApprovalHandler`); card renders inline in the circle conversation / reviews rail with a durable decision record. |
| 16 | Schedule cohort session | `POST …/sessions` (`routes.ts:132`) → `scheduleSession` (`sessionService.ts:70`) | **RIDES** | Instantiates the scheduling owner (`registerJob`, one-shot, deterministic id) + the notification owner; the session "happens" in the circle's existing conversation (join deep-links `/?conversation=`). |
| 17 | Session T-minus reminder | builtin `openwop-app.kicktodo.session-reminder` (`builtinWorkflows.ts:18`); node `feature.kicktodo.nodes.session-reminder` → `sendSessionReminder` (`sessionService.ts:181`) | **RIDES** | Real igniter: the scheduler daemon fires the stamped `workflowId` (`sessionService.ts:124`); one thin adapter node over the notification owner. This is the textbook composition. |
| 18 | List / cancel sessions | `GET/POST …/sessions[/cancel]` (`routes.ts:117/149`) | **PAGE-LEGIT** | Owner-or-grantee read; cancel is coach-only + disarms the reminder job. |
| 19 | Accountability Steward agent (read-only drafting) | `feature.kicktodo.agents.accountability-steward`, tools `[openwop:kicktodo.circles, openwop:kicktodo.progress]` | **RIDES** (agency) | Honest read-only drafting persona — deliberately holds NO write tools (`accountability-steward.md`); drives real *projected* read tools. Both allowlist entries project into conversational tools, so it is **not** silently dropped at dispatch. Gap: no entry point from the accountability surface (item B below). |
| 20 | `accountability-summary` node (workflow-composable feed read) | node → `k.feed` (`packs/feature.kicktodo.nodes/index.mjs:205`) | **RIDES** | Thin adapter over the projected-feed surface op; composable into any workflow. |

**Tally: RIDES 8 · ADAPTER 1 · PARALLEL 0 · THEATER 0 · PAGE-LEGIT 11** (20 capabilities).

Cross-cutting silent-drop check (lead's flag): **CLEAR.** Every entry in every
kicktodo agent's `toolAllowlist` is an `openwop:*` conversational tool
(`openwop:kicktodo.candidates|circles|factory.run|progress|today`); **no node
typeIds** appear in any allowlist, so no agent tool is dropped at dispatch. The
two accountability *nodes* (`accountability-summary`, `session-reminder`) are
workflow-run nodes, correctly absent from agent allowlists.

---

## Blockers (from scouting) — each with the honest alternative

None fatal. Two design realities that bound any further port:

- **B0 — Consent writes must not be chat-driven.** Grant invite/accept/revoke
  and proposal-raise are deliberately route-level with the acting participant
  (PRD §8.5.2; `surface.ts:1-6` — "READ + PROPOSE only … a workflow/agent can
  never expand consent"). The Steward prompt hard-codes this ("Draft; never
  send, invite, revoke, or change any grant … no such tools by design").
  **Honest alternative:** these stay PAGE-LEGIT forms; chat contributes
  *drafting*, never the consent write. Do not "port" them into agent tools.

- **B1 — Circle conversation is a private group, so KickBot co-host is
  deferred.** The scheduled-agent-chat co-host binding needs an org/channel-
  scoped conversation (ADR 0202 D3); a circle's is a private group
  (`sessionService.ts:10-17`). **Honest alternative:** already recorded as
  deferred; the session reminder rides a plain scheduler job + notification fan-
  out instead, which is sufficient. Do not force-fit the co-host seam.

---

## Findings to act on (low severity — cleanup, not demolition)

- **A — Latent surface ops with no igniter.** `surface.ts` exposes `propose`,
  `caseload`, and `listCircles` on `ctx.features['kicktodo-accountability']`,
  but **no node or feature consumes them** (only `feed` and
  `sendSessionReminder` have node consumers — `index.mjs:205`, `:1075`).
  `propose` in particular advertises a *write-capable* surface path that nothing
  ignites. Severity LOW (they are inert `ctx.features` ops, not user-facing
  claims). **Action:** either land a consumer (e.g. a coach-side composable node
  that reads `caseload`) or drop the unused ops so the surface stays honest.

- **B — Steward has no accountability-surface entry point.** The read-only
  drafting persona is reachable only via the generic agents page; `CirclesPage`
  never deep-links `/?agent=feature.kicktodo.agents.accountability-steward`
  (grep: no such link). **Action (port opportunity, additive):** add a "Draft an
  update for this circle" affordance on `CirclesPage` that deep-links the ONE
  chat scoped to the Steward (the agents-page / `ProjectChatTab` precedent) — no
  new chat surface, no new write capability.

- **C — Dual-path proposal decision (drift-watch).** The degraded inline
  apply/dismiss buttons (`CirclesPage.tsx:361-371`) are a second decision path
  next to the approval card. It is honest today: rendered **only** for a
  `proposed` proposal with no `approvalId` (the best-effort card-raise
  degraded), and `reconcileProposalCard` (`cohortService.ts:612`) keeps the two
  paths converged. **Action:** keep, but pin it (regression below) so it can
  never silently become the default path — that would make the card RIDES into
  theater.

---

## Demolition list (with regression pins)

Nothing to demolish. The pins below **protect the existing RIDES posture** so a
future change can't regress it:

- **Pin the card as the primary decision path.** A test asserting that a
  proposal raised while the approvals store is healthy carries an `approvalId`
  and the FE renders the "decide on the card" `Notice` (deep-link), NOT the
  inline apply/dismiss buttons — so the degraded fallback (finding C) can never
  become default.
- **Pin the reminder ignition.** A test asserting `scheduleSession` arms a job
  whose `workflowId === 'openwop-app.kicktodo.session-reminder'`
  (`sessionService.ts:124`) — the KT-PORT-3 fix; without it the workflow is
  declared-but-unignited (the exact THEATER shape). (Covered today by
  `kicktodo-session-reminder.test.ts` / `kicktodo-0459-pack.test.ts`; keep.)
- **Pin the allowlist projection.** A test asserting no kicktodo agent
  `toolAllowlist` entry is a node typeId (all are `openwop:*`), so the
  silent-drop-at-dispatch pattern can't reappear.

---

## New-code inventory (should be SMALL)

Only findings A/B are additive; both are optional cleanup:

- **B:** one FE affordance on `CirclesPage` + a deep-link string
  (`/?agent=…accountability-steward`). No new component, no new chat, no new
  backend.
- **A:** either delete 3 unused surface ops, OR add one thin composable node
  over `caseload` (a `registerFeatureAgentTool`-free workflow node, same shape
  as `accountability-summary`).
- Regression pins from the demolition section (test-only).

No new workflow, no new agent, no new owner, no new durable store is warranted —
the unit already has its erasure/retention/redactor seams
(`compliance.ts:59-75`), deterministic tenant-scoped keys throughout, and
supersession-safe reconciliation.

---

## Phased plan (gated on real gates)

- **Phase 1 (protect):** land the three regression pins. Gate: `npm run ci`
  green. Closes with `/code-review`.
- **Phase 2 (honest surface):** resolve finding A — drop the 3 latent surface
  ops or land a consumer. Gate: `npm run ci`; `/grade-node-packs` shows no
  dead surface op. Closes with `/code-review`.
- **Phase 3 (agency reach, optional):** finding B — the Steward deep-link
  affordance on `CirclesPage`. Gate: frontend build + `/ux-review` (4-locale
  copy, designed affordance). Purely additive; other consumers unchanged.

Never demolish (there is nothing to demolish); every phase is additive or
subtractive-of-dead-code and leaves the RIDES surfaces byte-for-byte.

---

## Deferred honestly

- **KickBot session co-host** — deferred; needs an org/channel-scoped
  conversation the private circle chat can't provide (`sessionService.ts:10-17`;
  ADR 0202 D3). Recorded, not faked.
- **Sensitive-metrics projection scope** — measured values never project in P2
  by design; a `sensitive-metrics` scope is a deliberate future addition
  (`projectionService.ts:8-11`), not a gap painted green.
- **Steward write tools** — permanently deferred *by design* (consent
  invariant B0), not a missing capability.

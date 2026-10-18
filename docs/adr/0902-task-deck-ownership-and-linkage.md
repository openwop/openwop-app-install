# ADR 0902 — Task deck: one owner rule, host-only linkage, honest bounds and real links

**Status:** implemented (2026-10-17, branch `feat/fl2-50-task-deck`)
**Date:** 2026-10-17
**Feature:** `task-deck` (extends ADR 0133; ALWAYS-ON since ADR 0134, no toggle, none added)
**Origin:** feature loop round 2 row 50 — `/grade-workflows task-deck` graded **C**
(`docs/steward/WORKFLOWS-ASSESSMENT.md` § "Task deck", ids `TD2WF-1..9`), 9 of 12 probes RED on
`b0bd1bfec` (`backend/typescript/test/adr0902-task-deck-authority.test.ts`).
**RFC verdict:** **host-extension — no RFC.** The deck is `GET /host/openwop-app/tasks` (non-normative)
and a chat tool. D2 changes what `POST /runs` persists from caller `metadata` into HOST keys; the
caller's metadata still round-trips unchanged under `callerMetadata` (the §Run-options echo), so the
wire contract is untouched. No event, capability or field is added.

## Context

ADR 0133 built the deck as a read projection over runs: "my runs, plus the runs they delegated",
bucketed pending / running / blocked / delegated / completed / failed. It was right not to build a
tasks table. Its implementation has three faults the grade proved, and a UX that promises more than it
does.

### Boundaries audit (what already exists — compose, don't fork)

| Concern | Owner today | Finding |
|---|---|---|
| "Is this run mine?" | `host/runOwner.ts` `runOwner` (RFC 0165 owner stamp, then anon markers, then legacy `actingUserId`) + `features/dashboard/ownRuns.ts` (`opaquePrincipal(subject)`, and "every run in my personal workspace is mine", #4511) | The deck has its OWN rule, `metadata.actingUserId === userId` (`task-deck/routes.ts:72`). Two rules for one question (`TD2WF-4`). |
| Parent linkage | the `parent_run_id` column (written by `:fork` with `forkMode`, and by in-process dispatch) + `metadata.parentRunId`/`delegatedBy` (ADR 0133 P1, written by `subruns/subRunDispatcher.ts:134` through `POST /runs`) | `POST /runs` spreads caller `metadata` into the run (`routes/runs.ts:717`), so the metadata linkage is caller-writable (`TD2WF-1`). The column also marks forks, which the deck reads as delegation (`TD2WF-3`). |
| Caller-metadata hygiene | `host/runDispatch.ts` `stripCallerAttribution` (host-written blocks a caller must not supply; applied where caller metadata enters) and `RESERVED_RUN_METADATA_KEYS` (stripped on every path, host too) | The linkage keys belong in the FIRST class: host writers (`conversationExchange.ts:483` `startDeepRun`, the dispatcher) legitimately set them, so they cannot be reserved. |
| Protocol scope for a run read | `requireProtocolScope(req, 'runs:read')` on `GET /runs`, `/dashboard/my-runs`, `loadReadableRun` | The deck checks none (`TD2WF-2`). |
| Bounded scan honesty | `ownRuns.ts` returns `truncated` | The deck logs truncation server-side only (`TD2WF-6`). |
| Who may open a run page | `chat/runDetailAccess.ts` `useCanOpenRunDetail` (ADR 0844 D4: `/runs/:runId` is admin-tier; "no link a viewer cannot follow") | Cards are inert today; FEATURES.md claims deep links (`TD2WF-7`). |
| "What needs me" | `/inbox` (notifications, "approvals, blockers") | The natural resume target for a member's blocked card. |

Route collision: `git grep "/host/openwop-app/tasks"` — one registrant. No new route.

## Decision

**D1 — the deck is a `runs:read` read.** The route calls `requireProtocolScope(req, 'runs:read')` before
building, exactly like `/dashboard/my-runs`. A key without it gets the standard 403 + insufficient-scope
challenge. The chat tool needs no scope: it runs inside a run its human started, as every
`registerFeatureAgentTool` read does.

**D2 — parent linkage is host-written.** `parentRunId` and `delegatedBy` join the caller-stripped
attribution set (`stripCallerAttribution`), so a caller's value is never persisted at the top level of
`run.metadata` (it still echoes under `callerMetadata`). The ONE caller that legitimately supplies them
over HTTP — the sub-run dispatcher, which authenticates as the wildcard service principal — keeps them
through an explicit admission in `POST /runs`: honoured only when the principal holds `tenants:['*']`
(the operator lane `resolveInternalToken` uses) AND the named parent exists in the run's tenant.
In-process host writers (`startDeepRun`) are unaffected: they never pass through `stripCallerAttribution`.

> Why not reserve them: `RESERVED_RUN_METADATA_KEYS` is stripped on host paths too, which would delete
> `startDeepRun`'s linkage. Why not verify at read time instead: the deck cannot tell a dispatcher's
> stamp from a member's after the fact; the write is the only place the principal is known.

**D3 — a fork is not delegation.** A run whose `forkMode` is set is never a child in the deck. It is a
top-level task of whoever owns it (its own owner stamp, `:fork` re-mints `actingUserId` to the forker).
Linkage = `run.parentRunId` when `forkMode` is unset, else `metadata.parentRunId`.

**D4 — one owner rule.** Ownership is `runOwner(run)?.principal === opaquePrincipal(subject)`, or the
whole tenant when the caller is in their own personal workspace — the `ownRuns.ts` rule, extracted to
one exported predicate both read. The HTTP lane takes `subject = req.userId ?? principal.principalId`
and `isOwnPersonalWorkspace(req)`; the tool lane takes `scope.actingUserId` and
`isPersonalTenantId(scope.personalTenant) && scope.tenantId === scope.personalTenant`. One builder
(`buildOwnedTaskDeck`) takes `{ subject, wholeTenant }` so the two lanes cannot drift.

**D5 — the whole delegation tree, within the window.** In scope = owned runs plus every descendant
reachable through D3 linkage inside the scan window (iterative, cycle-safe, depth ≤ 8). A child keeps
its parent's bucket placement rules from ADR 0133 (nested, never double-counted).

**D6 — honest bounds.** The scan is the tenant's newest `TASK_DECK_SCAN_CAP` (1000) runs, fetched as
`cap + 1` to know whether more exist. The response adds `truncated` (older runs exist beyond the scan)
and `counts` (per bucket, before the per-bucket card cap of 50, newest first). The dashboard tile reads
`counts`. The modal shows a one-line notice when `truncated` and "showing N of M" when a bucket is capped.

**D7 — cards lead somewhere.** Each card carries `conversationId` when the run is a chat run (the
host-written `metadata.conversationId`, read only on runs in scope). The modal links:
- a card with a conversation → "Open conversation" (`/?conversation=<id>`, the main chat — the server
  re-checks visibility on open);
- a blocked card → "Open Inbox" (`/inbox`, where approvals and blockers are resolved) for everyone;
- "Open run" (`/runs/:id`) only when `useCanOpenRunDetail()` (admin), per ADR 0844 D4.
The modal adds a Refresh control and re-fetches while open every 20 s when the tab is visible
(LobeHub's task manager and Temporal's list both update live; ours needs no SSE for a poll this cheap).
Times render relative (`updatedAt`), and the blocked reason uses a translated label per interrupt kind
(`approval`, `input`, `external`, other → generic "Waiting").

**D8 — doc honesty.** FEATURES.md row: replace the deep-link + unified-review claims with what ships;
ADR 0133 gets a correction note (toggle graduated; blocked bucket reads `listOpenInterrupts`; P5 not
needed); stale toggle comments in `task-deck/routes.ts` and `taskDeckClient.ts` fixed.

## Pre-code `/architect` pass (2026-10-17) — corrections to the decisions above

Adversarial read of the decision text against the code, before any implementation. 0 CRITICAL, 3 HIGH,
4 MEDIUM. Each is folded into the decision it corrects; the original text above is left as written.

- **A1 (HIGH, D2 is incomplete) — there is a second planting lane: the scheduler.** `routes/scheduler.ts:92`
  strips its OWN key set (`RESERVED_JOB_METADATA_KEYS`), not `stripCallerAttribution`, and
  `host/scheduleDaemon.ts:220` spreads the job's metadata onto every fired run. A member who schedules a
  job with `metadata.parentRunId: <A's run>` plants a card on every fire. **Correction:** one exported
  constant `CALLER_LINKAGE_KEYS = ['parentRunId','delegatedBy']` in `host/runDispatch.ts`, used by
  `stripCallerAttribution`, by the scheduler's reserved job keys, and by the daemon's spread filter
  (defence in depth for jobs written before the fix). A ratchet test asserts all three sites import it.
- **A2 (HIGH, D7 poll cost) — a 20 s poll of a 1000-full-row scan is a load multiplier.** `listRuns`
  returns whole `RunRecord`s (inputs, variables), and the run-snapshot incident shows tenant-wide reads
  are the DB's weak point. **Correction:** poll every 30 s, only while the modal is open AND the tab is
  visible AND the last deck had a pending, running, blocked or delegated card; a deck of only terminal
  work does not poll. The dashboard tile does not poll. The owner-indexed scan stays OQ-3.
- **A3 (HIGH, D7 wrong URL and wrong id) — `/?conversation=` is the legacy root form.** The chat's own
  deep link is `/chat?conversation=<sessionId>` (`chat/ChatSidebar.tsx:444`); the root form only
  survives through `RootRedirect`. And the link needs the chat SESSION id. **Correction:** link
  `/chat?conversation=<id>` and carry `conversationId` only after confirming at implementation that the
  run's `metadata.conversationId` is the session id the sidebar keys on (else omit the link and record it).
- **A4 (MEDIUM, D7 Inbox is not where every blocker is)** — a gate addressed to another approver never
  reaches the owner's Inbox, so "Open Inbox" can lead nowhere. **Correction:** a blocked card links to its
  conversation when it has one (the interrupt card is rendered there), else to `/inbox` labelled "See what
  needs you", and the reason text says who/what it waits on by kind, never promises an action.
- **A5 (MEDIUM, D7 kinds)** — interrupt kinds are `approval | clarification | refinement | cancellation |
  external-event | conversation | timer | tour-step | walkthrough-step | credential` (`types.ts:159`), not
  `input/external`. **Correction:** labels for approval, clarification, external-event, timer, credential;
  every other kind reads "Waiting".
- **A6 (MEDIUM, D2 legacy rows)** — D2 protects new rows only; a row planted before deploy still reads as
  linked. **Correction:** the prod count asked of the lead (`md_linked_cross_actor`) decides: zero ⇒ no
  read-side rule; non-zero ⇒ a follow-up backfill that clears the linkage keys on those rows.
- **A7 (MEDIUM, D1 tool lane)** — a run started by an `owk_` key holding `runs:create` but not `runs:read`
  can call `openwop:tasks.deck` and reach the deck through the run. Bounded (the deck is the key issuer's
  own runs, the same data `runs:create` callers already write) and identical to every other feature read
  tool; recorded, not fixed here (a per-key tool scope is ADR 0755 territory).

## Corrections found during implementation

- **A3 resolved — the conversation link reads `metadata.chatSessionId`, not `metadata.conversationId`.**
  Chat-turn runs carry the chat SESSION id as `chatSessionId` (`host/exchange/authorizeResolve.ts:48`),
  which is the key `/chat?conversation=` opens. `metadata.conversationId` is written by
  `startDeepRun` with the exchange's conversation id, which may be the gate-derived id, so it is not
  linked. Only the session id becomes `card.conversationId`.
- **A8 (found while writing D3's witness) — a fork belongs to its SOURCE's owner of record.** `:fork`
  re-stamps `actingUserId` to the forker but copies the RFC 0165 owner stamp verbatim
  (`routes/runs.ts` fork handler; §B.4: "nothing rewrites a subject key already stamped on a run").
  Under D4 a member's fork of my run therefore appears in MY deck as my own top-level task (never nested
  as delegated work, per D3), and not in the forker's. That is the same answer the home tiles give, and
  the first draft of D3's probe (which seeded the fork with the forker's stamp) tested a shape the host
  never writes. The witness now seeds the real shape.

- **TD2CD-1 (closing `/grade-code`) — D2's "authenticates as the wildcard service principal" is true only
  where an operator key is configured.** `OPENWOP_INTERNAL_TOKEN` is verified by nothing; the API-key
  fallback presented the whole `k1:*` entry (fixed: it now presents the key); and an enforced deploy with
  no operator key cannot authenticate the dispatcher at all. So `admittedLinkage` is the right gate but is
  reachable only on deploys with a wildcard key — on the demo it is unreachable, and HTTP sub-runs carry
  no linkage there (OQ-1). In-process children (the column) are unaffected.
- **A1 location** — `CALLER_LINKAGE_KEYS` lives in the leaf module `host/runLinkage.ts` (not
  `runDispatch.ts`): the scheduler and daemon must not import the executor. Redrive
  (`routes/workflowDebug.ts`) is the fourth reader (TD2CD-2); the ratchet covers all five sites.
- **TD2CD-7 (accepted residue)** — a fork of a delegated child keeps the service owner and loses its
  linkage (D3), so it shows in no member's deck. A fork of a sub-run is an operator act; recorded.

## Prod exposure (measured 2026-10-17, read-only, by the lead)

0 of 31,403 prod runs carry `metadata.parentRunId` or `metadata.delegatedBy`. The query is not inert:
1,796 runs have the `parent_run_id` column set. So `TD2WF-1` was never used in prod, and A6 needs **no
backfill**. Real sub-runs link through the column only, which also suggests OQ-2 (column-only linkage)
loses nothing. Shipped in #4914 (`4cdb132c3`).

## Implementation record

| Decision | Commit | Witness (all RED under sabotage on a clean tree) |
|---|---|---|
| D1 `runs:read` | `0d91ed561` | `adr0902-task-deck-authority.test.ts` D1 (S1) |
| D2 host-only linkage (POST /runs, scheduler, daemon, redrive) + service admission | `0d91ed561`, `ef4b46283`, `9df9a965f` | D2 + A1 + legacy-job + redrive legs + ratchet (S2–S6, S14) |
| D3 forks never children | `0d91ed561` | D3 legs (S7) |
| D4 one owner rule, both lanes | `0d91ed561` | D4 + tool-parity legs (S8, S10, S11) |
| D5 delegation tree | `0d91ed561` | grandchild leg (S9); cycle-safe nesting (S15) |
| D6 truncated + counts + cap; cap-first lookups | `0d91ed561`, `9df9a965f`, `1feb9be0b` | D6 legs (S12, S13, S19) |
| D7 links, waits, refresh, poll | `213662ecf`, `9df9a965f` | `taskDeckModal.test.tsx` (FS1–FS13) |
| D8 docs | `83f63cdad` | — |
| grade fixes (titles, cancelled, token entry) | `9df9a965f` | S16–S18 |

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Stays `features/task-deck/`. D2 touches core `routes/runs.ts` + `host/runDispatch.ts` (core-owned caller-metadata seam); D4 moves the owner predicate into `host/runOwner.ts` (core) so `dashboard` and `task-deck` both import it — features → core only. |
| 2 | Toggle | None (always-on, ADR 0134). No new toggle. |
| 3 | Workflow surface | None. ADR 0133's deferred `ctx.tasks` stays unbuilt: no chain needs it (no consumer found). |
| 4 | Node pack | None. |
| 5 | AI chat | `openwop:tasks.deck` unchanged in name/schema; its output gains `truncated` + `counts` and loses planted cards. Stays `contentTrust:'untrusted'` (titles are user text). |
| 6 | Agent pack | None new (chief-of-staff already allowlists the tool). |
| 7 | Public surface | None. |
| 8 | RBAC | D1 `runs:read`; D4 owner = the canonical owner; an anon caller gets an empty deck (unchanged, ADR 0839). |
| 9 | Replay / fork | D3 makes forks non-children. The projection stays pure (no clock). D2 changes only what a NEW run persists; existing rows are read as before (the prod read asked of the lead measures whether any planted linkage exists). |
| 10 | Frontend | `taskDeck/TaskDeckModal.tsx` links + refresh + relative time + bounds notice; `TaskDeckTile` reads `counts`; i18n × 4 locales. |

## Phased plan

1. **Backend (one PR, tests first — the probe file is the witness):** D1, D2, D3, D4, D5, D6. Each fix
   sabotaged on a clean tree.
2. **Frontend:** D7 + tile `counts` + i18n.
3. **Docs:** D8, tracker closeout.

## Alternatives weighed

1. **Reserve `parentRunId`/`delegatedBy`.** Rejected — reserved keys are stripped on host paths too, so it
   would delete `startDeepRun`'s linkage (`conversationExchange.ts:483`).
2. **Make the dispatcher write the `parent_run_id` column.** Better long-term (one linkage), but it is an
   HTTP self-call; the column is set by the run builder, so it needs a new admitted body field. Left as
   OQ-2; D2's admission is the same trust decision with less surface.
3. **Use `listRunSummaries` (owner predicate in SQL).** It returns only five columns + owner keys, and
   the deck needs titles, linkage and children (which are owned by the service principal, so an owner
   predicate would drop them). Extending three storage adapters for this is a separate perf change
   (OQ-3); the window stays 1000 full rows, as today.
4. **Hide the deck from keys entirely.** Rejected — the CLI reads runs with `runs:read`; the scope is the
   honest gate.

## Open questions

- **OQ-1** — HTTP sub-run dispatch in an enforced deploy presents `OPENWOP_INTERNAL_TOKEN` (verified
  nowhere) or `dev-token` (withdrawn). Whether those children land in the parent's tenant in prod is a
  subruns question (`TD2WF-9`), asked of the lead as a read-only query; not changed here.
- **OQ-2** — one linkage (column only), per alternative 2.
- **OQ-3** — owner-indexed scan for large shared workspaces.
- **OQ-4** — "Delegated by" shows the raw `agent:<id>`; resolving a roster display name is a follow-up.
- **OQ-5** — `TD2CD-5`: depth > 8 is cut silently and `children[]` is uncapped (Low).
- **OQ-6** — `TD2UX-8`: a member-safe failure summary on failed cards.

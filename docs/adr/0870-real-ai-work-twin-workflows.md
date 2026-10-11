# ADR 0870 — Real-AI Work-Twin workflows: chain packs with new ids, an honest demo label until they land

Status: Accepted for the §Stopgap only, which is implemented (honest demo cards, #4675).
D1–D6 remain Proposed and are not implemented.

Composes ADR 0032 (work-twin agents), ADR 0058 (chat-drivability = agent pack + node
pack), ADR 0163 (tenant ownership index / from-chain), ADR 0190 §Phase 6 (the `tmpl.*`
mocks stay out of the gallery), ADR 0195 DUR-3 (seeding is opt-in under `auth`), ADR 0472
(chain-backed workflows), ADR 0498 (provider frozen at instantiation), ADR 0775 (ARWF-1,
P2 chain migration), ADR 0794 (workflow-id grammar). Settles the ADR 0775 open question
"P2 reachability (product call)" (`docs/adr/0775-agents-roster-authority-and-work-twin-chains.md:349-354`).

## Context

### What a Work-Twin portfolio actually runs today

The ten Work-Twin agents are seeded from `backend/typescript/src/host/seed-data/exampleAgents.json`
(Ava, Felix, Cleo, Idris, Mira, Ren, Pax, Quill, Iris, Ezra). Nine of them bind a
portfolio of five or six `tmpl.*` ids (37 distinct ids). Iris (chief-of-staff) binds
none. `workflowIdsForSpec` (`host/exampleDataSeed.ts:343-345`) returns the spec's
list verbatim, and `createSeededRosterMember` writes it into `RosterEntry.workflows`
(`host/rosterService.ts:53-55`).

Every one of those ids resolves in catalog source A to a pinned module constant
(`host/index.ts:672-673`, `getWorkflowTemplate` → `host/workflowTemplates.ts:220`),
and every AI step in those constants is `local.sample.demo.mock-ai`
(`workflowTemplates.ts:80`, `const AI = 'local.sample.demo.mock-ai'`). The node
fabricates `"Mock response to: …"`. So a Work-Twin's portfolio is a set of
deterministic demo graphs. It is not an AI workflow.

The twins' chat agents are seeded with `toolAllowlist: []` (`exampleDataSeed.ts:362`,
`:531`), so a twin can talk but cannot drive any of its own work through chat either.

### Why that is now a user-facing defect, not just debt

`bootstrap/nodes.ts:3592-3597` (LEAK-3) does not register the mock node under
`OPENWOP_DEPLOY_POSTURE=auth`, which is the posture a white-label adopter of v0.3.0
runs. On such a deployment:

- the demo seed is opt-in (`exampleDataSeedEnabled`, `exampleDataSeed.ts:201-209`), but
  an operator who opts in gets ten twins whose every portfolio card fails at dispatch
  with `node module not registered`;
- even without the seed, the portfolio's "Assign a workflow" picker offers every
  `tmpl.*` id from the bundled `ALL_WORKFLOW_OPTIONS`
  (`frontend/react/src/agents/roleTemplates.ts:179`), so any user can assign one;
- the "Run now" button was gated on `known`, which came from that same bundled id list
  (`isKnownWorkflow`, `roleTemplates.ts:175`), and is true for every pinned id in every
  posture. The button was enabled and failed on click.

Production `app.openwop.dev` runs `cookie-per-visitor`, where the mock is registered,
which is why this never showed there.

### What is already in flight, and what this ADR must not touch

PR #4670 (`feat/adr-0775-p2-chain-migration`, ADR 0775 P2a) moves 16 `tmpl.*`
definitions into `examples/workflow-chain-packs/work-twin-templates/pack.json`, same
id, still `local.sample.demo.mock-ai`, every chain `internal: true`, byte-identical by
`revisionHashOf`. That is the right home for the mocks as **replay archives**: a
historical run must still `:fork` against the definition it ran. The user decided
(2026-10-10) that the `tmpl.*` templates stay hidden and are never shown in `/builder`.
This ADR builds on that decision and does not reopen it.

### Real-AI material that already exists

ADR 0190 §Phase 6 records that real-AI chains cover the `tmpl.*` categories
(`docs/adr/0190-evidence-based-template-catalog-expansion.md:111-113`). Verified at `origin/main`, under
`examples/workflow-chain-packs/`: meeting-ops (`meeting.agenda-prep`,
`meeting.notes-to-actions`), reporting (`exec-ops.daily-briefing`,
`digest.team-status`), intake-triage (`support.ticket-routing`, `inbox.triage`),
approvals (`approvals.request-sign-off`, `approvals.two-stage-sign-off`), knowledge
(`knowledge.policy-qa`, `knowledge.doc-summarizer`), people (`people-hr.onboarding`,
`people-hr.offboarding`, `people-hr.pto-routing`), finance
(`finance.month-end-close`, `finance.expense-approval`), commercial (`crm-ops.*`,
`csm-ops.renewal-risk`), it (`it-support.incident-triage`), comms
(`release.internal-announce`). **Scheduling has no dedicated pack**; the nearest are
`assistant.action.calendar-invite` and `inbox.followup-nudger`. "Every category is
covered" is therefore true for ten of eleven.

These are general-purpose gallery chains, not twin-shaped ones. Many need
connection params (`it-support` requires `slackChannel`, `orgId`, `collectionId`,
`examples/workflow-chain-packs/it-support/pack.json:19`), so they cannot be bound
zero-config into a seeded portfolio as they stand.

### How a real AI node picks its provider

`core.ai.chatCompletion` / `core.ai.structuredOutput` (`packs/core.openwop.ai/pack.json:25`,
`:40`) call `ctx.callAI({ provider, model, … })` with the provider from their own config
(`packs/core.openwop.ai/index.mjs:127-139`). The host resolves the credential through
`pickCredentialRef` (`aiProviders/credentialRefLadder.ts:89-110`): explicit ref, then the
run's `configurable.ai.credentialRef` if it names the same provider, then an exact or
prefixed provider-named secret, else `no_default_credential`. **Nothing picks a
provider for the node.** ADR 0498 freezes the provider into the definition at
instantiation (`it-support/pack.json:22`, `"provider": "{{params.provider}}"`), because a
concrete provider is what keeps replay deterministic. The reference app-builder pack
hard-codes `provider: "anthropic"` (`examples/workflow-chain-packs/app-builder/pack.json:43-45`).
"Runs on the tenant's BYOK provider" therefore means *the provider is chosen from the
tenant's stored keys when the chain is materialised for that tenant, and frozen*.

## Decision

### §Stopgap — honest demo cards (implemented with this ADR)

Until D1–D6 land, the portfolio must not offer a button it knows will fail, and must
say when a card is a demo.

- **The signal is the host's, not the bundle's.** `GET /host/openwop-app/workflows/availability?ids=a,b`
  (`backend/typescript/src/routes/workflows.ts:850`) answers per id
  `{ workflowId, known, demo, runnable, reason? }`, computed by
  `assessWorkflowAvailability` (`backend/typescript/src/host/workflowDemoAvailability.ts`):
  - `known`: the id resolves through the SAME `workflowCatalog.getWorkflow` that
    `POST /runs` uses, AND passes the same `isForeignOwned` predicate as
    `GET /workflows/{id}`. Unknown and foreign answer alike, so there is no
    cross-tenant existence oracle.
  - `demo`: the definition, or any `core.subWorkflow` child it binds by
    `config.workflowId` (depth-bounded, cycle-safe), contains `local.sample.demo.mock-ai`.
  - `runnable: false`, `reason: 'demo-node-unavailable'`: `demo` and
    `getNodeRegistry().isResolvable(mock-ai)` is false. That is the same two-lane check
    `registry.resolve()` walks (`executor/nodeRegistry.ts:51`), so the answer tracks
    LEAK-3 without re-reading the posture.
  - It deliberately predicts nothing else. A connection-less or BYOK-less run still
    fails the way it does today. The field answers exactly one question.
- **The picker.** "Assign a workflow" does not offer a candidate the host marks
  `demo-node-unavailable`, and says how many it left out. The cards and the picker
  share ONE batched availability read (the assigned ids plus the built-in template
  candidates), never one read per row. If the read fails, the picker offers everything.
- **The card** (`frontend/react/src/agents/AgentWorkflowPortfolioPanel.tsx`) shows a
  `chip chip--muted` "Demo" with the `FlaskIcon` and a one-line explanation. When the
  host says `demo-node-unavailable`, Run now is `disabled` and `aria-describedby` the
  visible reason. If the availability read fails, the card falls back to the previous
  `known` logic rather than disabling every card on a transient error.
- Host-extension route, non-normative. No OpenWOP wire change, so no RFC.

This is containment. It makes the failure honest. It does not give an auth-posture
tenant a working twin.

### D1 — Ship twin workflows as NEW-id real-AI chain packs, never by editing `tmpl.*`

Author one workflow-chain pack per twin role family
(`examples/workflow-chain-packs/work-twin-<role>/pack.json`, `kind: "workflow-chain"`),
with chain ids in a new namespace, **`twin.<role>.<flow>`** (e.g.
`twin.executive-ops.daily-summary`). Each chain:

- uses only real nodes: `core.ai.structuredOutput` / `core.ai.chatCompletion` for model
  steps, `core.approvalGate` / `core.chat.approvalGate` for every side effect (ADR 0032:
  twins run at draft/recommend autonomy on day 1), `core.flow.router` for branching,
  and feature nodes (`feature.kb.nodes.rag`, `feature.crm.nodes.*`, …) where the twin
  reads app state. No `local.sample.*` node may appear. A pack test asserts it.
- declares `provider` and `model` parameters with defaults, copying the
  `it-support` shape (`it-support/pack.json:22-23`), so ADR 0498's freeze applies
  unchanged.
- is **zero-config after provider selection**. Anything a gallery chain takes as a
  required connection param (Slack channel, KB collection) is either dropped from the
  twin version or becomes an approval-gated draft that names the missing connection,
  so a seeded portfolio runs on first click. Where a real gallery chain already does the
  job with zero config, the twin chain composes it via `subChainRef` rather than copying
  it (RFC 0013 sub-chain nesting is first-class).
- is NOT `internal`. These are the workflows a user is meant to see, open and edit.

**Why new ids and not same-id replacement.** A same-id swap of `tmpl.x` from mock to
real AI changes the definition behind historical runs, so a `:fork` of a 2026-09 run
would re-execute different nodes. That is the replay-law violation ADR 0775 P2 was
written to avoid (its `postProcess` restores bare node ids so a fork is
def-identical). New ids keep the archive and the live workflow separate by construction.

### D2 — Materialise per tenant through the from-chain ownership path, idempotently

A twin workflow becomes a tenant-owned, `/builder`-editable workflow the same way every
other chain does: `expandChain → registerWorkflowDurable → recordRevision →
recordOwnership` (`routes/workflows.ts:1117-1222`, the from-chain route). Two changes are
needed:

- **Deterministic ids.** The from-chain route mints `wf.copy.<slug>.<rand16>`
  (`routes/workflows.ts:1199`, `host/workflowId.ts:39`), which is not idempotent: a
  re-seed would create "X-2, X-3". Twin materialisation uses a deterministic,
  per-tenant id. Following the `cadenceWorkflowId` precedent (`host/workflowId.ts:71`,
  `wf.cadence.<slug>.<tenantHash>`), add `twinWorkflowId(tenantId, chainId)` →
  `wf.twin.<slug>.<tenantHash>`, registered in the ADR 0794 grammar and its ratchet.
  It is per tenant, not shared like `wf.seed.*` (`host/seedWorkflows.ts:33`), because the
  provider is frozen per tenant (D3), so two tenants' definitions legitimately differ.
- **One materialiser** (`host/twinWorkflows.ts`), called by the example seed and by the
  migration (D4). It is the only writer of `wf.twin.*`: `getOwned` short-circuits a
  re-run, and a tenant who edited their copy keeps the edit (the `commitSubChainChild`
  "reused if edited" rule, `routes/workflows.ts:270-277`).

### D3 — The provider is the tenant's, chosen once at materialisation

**Recommended (see open question 1).** The app already has a workspace default AI
provider: the ADR 0110 headless default, `getHeadlessAiDefault(tenantId)`
(`backend/typescript/src/host/headlessAi.ts:79`), which holds
`{ provider, model, credentialRef }` (`:43-55`). A workspace admin sets it in
Settings → Secrets Vault. ADR 0706 already freezes it into a chain at instantiation
through `resolveIgnitionAiBinding` (`headlessAi.ts:109`; `source: 'workspace-default'`
at `:133`). The materialiser reuses that resolver, so there is one rule for every
chain the host instantiates on a tenant's behalf:

1. If the workspace default is set, use its provider, model and `credentialRef`.
2. If it is not set, use the first provider for which `pickCredentialRef`
   (`credentialRefLadder.ts:89`) finds a stored key, in the host catalog's order.
   The choice is **surfaced in the twin's settings** and changeable there.
3. With no key at all, the workflow is still materialised, and its runs fail with
   the existing typed `byok_required_but_unresolved`. The card then shows the existing
   BYOK gate copy, not a Demo chip.

The choice is frozen into the definition (ADR 0498) and recorded on the ownership row,
so the card can say which provider a twin uses. **The host never silently re-picks
later:** adding a key or changing the workspace default does not rewrite an existing
twin workflow. Changing provider is an explicit edit, either in the twin's settings or
in `/builder`.

### D4 — Portfolios move to the real chains; existing bindings migrate, `tmpl.*` stays resolvable

Bindings to `tmpl.*` exist in four places. Each one migrates differently:

| Binding | Shape | Migration |
|---|---|---|
| Roster portfolio | `RosterEntry.workflows: string[]` (`rosterService.ts:53-55`) | Rewrite each `tmpl.x` to the tenant's `wf.twin.*` id from a checked-in `tmpl → twin` map. An id with no mapping stays (it remains a Demo card). |
| Schedules | `ScheduledJob.workflowId` (`schedulingService.ts:93`, seed `exampleDataSeed.ts:309`) | Same map, through the existing PATCH path (`schedulingService.ts:760`). The job id is unchanged, so its history stays attached. |
| Board trigger lane | `KanbanColumn.triggerWorkflowId` (`kanbanService.ts:48`, seed `exampleDataSeed.ts:135-137`) | Same map. The heartbeat reads it (`heartbeatService.ts:179`), so it picks up the real chain with no heartbeat change. |
| Card-level `workflowId` and historical runs | run rows / card rows | **Never rewritten.** A run records the id it ran, and replay re-resolves that id. That is why `tmpl.*` must stay resolvable. |

- The migration is a versioned app migration (`host/appMigrations.ts`), idempotent and
  per tenant, with the same "examined / rewritten / skipped" log line as
  `app_migration_reseed_deferred`. It runs only for tenants that already have a seeded
  twin roster entry (`roleKey` set), so a user's hand-assigned `tmpl.*` on a custom
  agent is left alone and keeps its Demo chip.
- The example seed binds `wf.twin.*` directly for new tenants. `exampleAgents.json`
  changes its `workflows` arrays to chain ids, and the seeder materialises them via D2.
- **`tmpl.*` stays internal and resolvable for replay only**, in the PR #4670 chain pack.
  It is removed from `ALL_WORKFLOW_OPTIONS`, so it is no longer *assignable* in the
  portfolio picker. `roleTemplates.ts` stops hand-copying ids (already ADR 0775 P2d's
  stated end state) and reads the twin catalog from the host.
- Under `auth` the migration still runs, because twins can exist there when the operator
  opted into the seed. A twin that only ever had `tmpl.*` bindings ends up with
  real-AI ones.

### D5 — Each twin becomes chat-drivable: agent pack + node pack

Per CLAUDE.md "chat-drivability = agent + nodes" (ADR 0058, e.g.
`packs/vendor.openwop-app.crm.agents` + `packs/feature.crm.nodes`): ship one agent pack,
`vendor.openwop-app.work-twins.agents`, whose ten personas carry a `toolAllowlist`
naming the tools that start or inspect *their own* twin workflows. The seed then stops
writing `toolAllowlist: []`. The tools are an allowlisted node pack, not additions to the
ADR 0315 default-on baseline. Driving a twin is then the existing chat, deep-linked
`/?agent=<agentId>` from the agent page. No new chat surface is built.

### D6 — The Demo chip's lifecycle

The chip is derived, never stored: it shows exactly when the host says `demo: true`.
After D4, a migrated twin's cards carry no chip, because `wf.twin.*` contains no mock
node. The chip remains for:

- unmigrated custom assignments of a `tmpl.*` id (until the user swaps it);
- any other demo-node workflow a tenant authored or imported.

When the last `tmpl.*` assignment path is gone (no picker entry, migration complete,
no residual bindings measured in prod), the chip stays as the general "this
workflow uses the sample node" label. It costs nothing and remains true. The
`demo-node-unavailable` disable stays as long as LEAK-3 does.

## RFC gate

No OpenWOP wire change. The availability route is a `/host/openwop-app/*` host
extension. Chain packs use the existing RFC 0013 / 0133 / 0135 format: `subChainRef`,
`internal`, and `parameters` all exist. Provider freezing is ADR 0498 host behaviour.
The agent pack uses the existing agent manifest (`toolAllowlist`). If D1's "approval-gated
draft that names the missing connection" needs a new interrupt kind, that would be an
RFC. Every current twin side effect fits `core.approvalGate`, so none is expected.

## Phases

| Phase | Scope | Status |
|---|---|---|
| **S** | §Stopgap: availability route, honest cards, and an Assign picker that drops demos this deployment cannot run (one batched read). Tests included. | implemented (this PR) |
| P1 | D1 for the two highest-traffic roles (executive-ops, finance-close; 11 ids), plus the "no `local.sample.*` in a twin pack" test. D2 materialiser + `wf.twin.*` grammar. D3 provider pick through `resolveIgnitionAiBinding`. Iris gets no flows of her own here (gap 1). | open |
| P2 | D1 for the remaining seven roles. Scheduling gets new draft-only chains, because no real-AI gallery chain exists to compose (gap 2): they propose slots and need approval to send. | open |
| P3 | D4 migration + seed switch + `roleTemplates.ts` reads the host catalog. Migrated and seeded twin schedules start **disabled**, with an in-app notice and a one-click enable. Measure prod `tmpl.*` bindings before and after. | open |
| P4 | D5 agent pack + tool node pack, seeded allowlists. | open |
| P5 | Iris as orchestrator: the chief-of-staff routes work to the other twins as kanban stack todos (the ADR 0311 `openwop:kanban.add-todo` pattern), so she owns a stack, not chains. | open |

**Gaps found while grounding this ADR**, each owned by a phase above:

1. **Iris (chief-of-staff) has no portfolio.** `exampleAgents.json` gives her no
   `workflows`, and `roleTemplates.ts` excludes her role. Owned by P5.
2. **Scheduling has no real-AI chain.** It is the one `tmpl.*` category ADR 0190's
   "every category has a real chain" claim does not hold for. The nearest are
   `assistant.action.calendar-invite` and `inbox.followup-nudger`. Owned by P2.

P1 must land after PR #4670 (the replay archive) is merged, so `tmpl.*` has its final
home before anything points away from it.

## Alternatives weighed

- **Same-id replacement (make `tmpl.x` real AI).** This is the least migration work, since
  no binding changes. Rejected because it breaks replay (a fork re-runs different nodes)
  and because it would make the mock archive and the live workflow the same object, which
  is the ambiguity PR #4670 resolves.
- **Make `tmpl.*` ownership-reachable and real in place** (the ADR 0775 P2 (ii) option).
  This puts 44 flows in every tenant's `/builder`. The user has decided against it.
- **Register the mock node under `auth` (revert LEAK-3).** This would make the buttons
  "work" by serving fabricated LLM output to signed-in enterprise tenants. That is the
  exact leak LEAK-3 closed. Rejected.
- **Bind twins straight to the existing gallery chains.** It ships fast, but those chains
  need connection params (`it-support` requires three), so a seeded portfolio would not
  run on first click, and their personas do not match the twin roles. Composition via
  `subChainRef` keeps the reuse without the zero-config failure.
- **Hide the Run now button on demo cards instead of disabling it (§Stopgap).** Rejected:
  a hidden control explains nothing, and the user would not learn why the card is inert.
  A disabled button with a described reason is honest and accessible.
- **Shared `wf.seed.*`-style ids for twins.** Rejected because the provider is frozen per
  tenant (D3), so the definitions differ per tenant.

## Open questions

The answers marked **Recommended** are the coordinator's recommendations (2026-10-10).
They are not final user decisions; each needs the user's confirmation before its phase
starts.

- [ ] **1. Provider choice (D3).** *Recommended:* use the workspace default provider/model
  (ADR 0110, `headlessAi.ts:79`) via `resolveIgnitionAiBinding`. If it is unset, use the
  first stored key at materialisation, surfaced and changeable in the twin's settings.
  Never silently re-pick later.
- [ ] **2. Iris (chief-of-staff).** *Recommended:* no flows of her own in P1. As
  chief-of-staff she orchestrates: she routes work to the other twins as kanban stack
  todos (ADR 0311), which fits the chains-or-stacks doctrine. Later phase (P5).
- [ ] **3. Scheduling chains.** *Recommended:* yes, draft-only on day one. The chain
  proposes slots and sending needs approval, consistent with D1's approval gate on every
  side effect (P2).
- [x] **4. Picker under `auth` before P3.** *Done in the §Stopgap.* The Assign picker drops
  any candidate the host marks `demo-node-unavailable` and shows a one-line count note.
  The read is one batched availability call shared with the cards. If the read fails,
  the picker shows everything.
- [ ] **5. Cost.** *Recommended:* yes. Migrated and seeded twin schedules start
  **disabled**, with an in-app notice and a one-click enable, so nothing spends a tenant's
  BYOK budget unannounced (P3).
- [ ] **6. Residual measurement.** How many prod tenants carry hand-assigned `tmpl.*` on
  non-seeded agents? This decides whether D6's long-tail chip matters. Measure in P3.

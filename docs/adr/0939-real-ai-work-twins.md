# ADR 0939 — Real-AI Work-Twins: agent-run chains beside the frozen mock archives

Status: Proposed (adversarial `/architect` pass 2026-10-19 folded in: 4 Blockers + 5 High + 5 Medium, see § Architect pass; open USER decisions OQ-1..5, OQ-7)

- **Asked for by:** the user, directly. `backend/typescript/src/host/workflowTemplates.ts:24`
  says "Real-AI Work-Twin chains are a separate ADR". This is that ADR.
- **Composes:** ADR 0032 (the ten twins), ADR 0775 (P2 moved the 44 `tmpl.*` into a chain
  pack and kept them `internal`; P3c/P3e/P3f put knowledge, memory and the autonomy gate on
  the agent-runner), ADR 0190 §Phase 6 (no mock-AI cards in the gallery), ADR 0472
  (chain-backed workflows), ADR 0789 (seeded-workflow copy-on-write and the fork re-point
  hooks), ADR 0058 (chat-drivability = agent + nodes), ADR 0308 / ADR 0315 (agent tools and the
  default-on baseline), ADR 0477 / ADR 0480 (workflow eval sets and online scoring), ADR 0482
  (per-workflow daily budgets), ADR 0821 (managed credits), ADR 0903 (no hard-coded vendor).
- **Toggle:** none new (see D3).
- **RFC verdict:** host-only (§ RFC verdict).

## Context

### What the twins run today

The ten twins are seeded from `backend/typescript/src/host/seed-data/exampleAgents.json`. Nine
carry a standing portfolio (`workflows[]`). Iris (Chief of Staff) has none: her standing work
is the assistant's perception loops (`exampleDataSeed.ts:115-117`). The nine portfolios hold
**46 bindings over 37 distinct `tmpl.*` ids** (measured from the JSON). Seven of the 44 ids
are bound by no twin: `approvals.threshold-based`,
`intake-triage.{escalation-routing,required-field-completion}`,
`knowledge.{policy-summarization,source-pack-assembly}` and
`reporting.{monthly-scorecard,quarterly-retrospective}`.

The portfolio is used in three places for each seeded member:

| Use | Where |
|---|---|
| roster `workflows[]` | `exampleDataSeed.ts:404` (`createRosterEntry`) |
| schedule jobs, `workflowIndex` into the portfolio | `exampleDataSeed.ts:333`, e.g. Ezra's `daily-brief` (`exampleAgents.json:1167`) and Ava's `pipeline-risk` (`:44`) |
| the board's To-Do column trigger (`triggerWorkflowId` = the first portfolio entry) | `exampleDataSeed.ts:165-167`, `:301` |

All 44 chains live in `examples/workflow-chain-packs/work-twin-templates/pack.json`
(`vendor.openwop-app.workflows.work-twin-templates@1.0.0`). Every chain is `internal: true`.
Their 94 nodes are **81 `local.sample.demo.mock-ai@0.1.0`**, 11 `core.approvalGate` and
2 `core.subWorkflow` (measured). No chain reads anything. They are registered same-id with a
`postProcess` that restores bare node ids, so each pre-migration run's `definitionRevision`
still matches byte for byte (`workflowTemplates.ts:115-148`).

### Why that is a problem, not just a gap

- **In the enterprise (`auth`) posture the twins cannot run at all.** LEAK-3 does not register
  the mock node there (`bootstrap/nodes.ts:3597-3601`). Every seeded portfolio and every
  enabled schedule fails with "node module not registered". `workflowDemoAvailability.ts:35,62`
  can only label them `runnable:false`.
- **In every other posture, a twin "does work" by fabricating it.** The node returns
  `Mock response to: <prompt>` (`nodes.ts:1388`). A Sales Execution twin whose system prompt
  says "grounded in system data" (`exampleAgents.json`, Ava) delivers a pipeline-risk digest
  that read no pipeline. That is the simulated-work dishonesty ADR 0190 §Phase 6 kept out of
  the gallery. It is still on the agents' own boards and schedules.
- ADR 0190 §Phase 6 called `tmpl.*` "the work-twins' deterministic no-BYOK substrate". Since
  ADR 0821 that reason is gone: the managed tier serves a zero-BYOK turn under daily caps
  (`providers/managedProvider.ts:190`), and the agent dispatch prefers it by default
  (`host/agentDispatch.ts:880`).

### What already exists to build on (measured)

- **Real-AI gallery chains cover every template category** (ADR 0190 §Phase 6's claim, checked
  against the packs). For example: `exec-ops.daily-briefing` (`exec-ops/pack.json:12`) reads
  CRM deals, analytics and CRM tasks and only then drafts. `csm-ops.renewal-risk`
  (`csm-ops/pack.json:110`) is the reference gate: the artifact comes off the read on a
  port-qualified edge (`:191-192`) and the write edge is conditioned `truthy approved`
  (`:195-200`). `crm-ops.deal-hygiene` (`crm-ops/pack.json:44`) covers stale deals. The same
  holds for `meeting.notes-to-actions`, `finance.month-end-close`,
  `it-support.incident-triage`, `people-hr.*`, `knowledge.*` and `approvals.*`.
  **These chains are persona-less, though.** Their judgment step is `core.ai.chatCompletion`
  with a hard-coded role prompt ("You are a chief of staff…"). It is not the twin.
- **The agent-runner node is where an agent acts inside a workflow**
  (`host/agentRunnerNode.ts`, `local.openwop-app.agent-runner`). It runs through the one gated
  dispatch owner. It carries the agent's own system prompt, its knowledge on the run path
  (ADR 0775 P3c) and its untrusted-fenced run memory (P3e). It does **not** carry the agent's
  `modelClass` or the workspace BYOK key when nothing is pinned (gap G5, below). It also checks the
  autonomy gate: paused → `agent_paused`, `never` → `policy_denied`, and `hitl` pauses on the
  approval interrupt (`agentRunnerNode.ts:147-165`, P3e/P3f). Five shipped chain packs already
  use it, e.g. `scheduled-chat-turn`. `offerTools` is a per-node confinement lever: `[]` means a
  zero-tool surface regardless of allowlist or baseline (`agentRunnerNode.ts:84-97`).
  Replay: the node is unclassified, so a `:fork` re-executes it. Its provider calls are served
  from the ADR 0326 invocation log, and in-loop effects stay under the ADR 0531 default-deny
  guard (`:26-34`).
  **Its inputs are `agentId`, `task` (a string), provider, model, credentialRef,
  conversationId and `offerTools`, and nothing else** (`agentRunnerNode.ts:65-97`). An edge from
  a read node into the runner lands on no input and is silently dropped (gap G0).
- **Read surfaces exist as nodes and as agent tools:** CRM (`feature.crm.nodes.list-deals`,
  `get-company`, `list-tasks`, …; tools in `features/crm/agentTools.ts`), CSM (`health-read`,
  `renewals-due`), analytics (`analytics.query`), documents (`documents.get`), service desk
  (`servicedesk.list-tickets`) and KB (`feature.kb.nodes.rag`).
- **Cost rails exist, with caveats:**
  - The managed tier has three daily token caps (`managedProvider.ts:190,458,468`), which fail
    `daily_limit_reached` (`:559`):
    - **per subject.** A schedule-fired run has no acting subject, so its bucket is the bare
      tenant id (`providers/managedUsageScope.ts:47-49`). That gives each workspace one extra
      150k-token allowance for unattended work.
    - **per tenant.** This cap is **off unless `OPENWOP_MANAGED_TENANT_DAILY_TOKEN_CAP` is set**
      (`:468-471`).
    - **global.**
  - An `anon:` tenant fails `sign_in_required` in the `auth` posture (`:520`).
  - the autonomous-run budget of 120 runs per tenant per hour, which drops a schedule fire with
    reason `budget` (`runBudgetService.ts:38-45`, `scheduleDaemon.ts:194`);
  - ADR 0482's per-workflow daily USD budget with a hard cap checked at run start
    (`host/workflowBudgets.ts:21-28,294`).
  - **No per-run token ceiling exists for workflow runs.**
- **No-key behaviour is already honest:**
  - A workflow AI node with no credential fails `byok_required` / `no_default_credential`, with
    "deliberately no silent fallback" (`aiProviders/aiProvidersHost.ts:1976-1989`).
  - The runner with no pin prefers the managed tier (`agentRunnerNode.ts:338`).
  - The runner fails `no_model_available` when no model surface is wired (`:124`).
- **The ADR 0789 fork re-point is tenant-wide, so it cannot re-point one twin.**
  `runWorkflowForkHooks(tenantId, from, to, only?)` (`host/workflowsRegistry.ts:201-230`) rewrites
  every row in the tenant that names `from`. That includes the roster
  (`rosterService.ts:408-419`), kanban (`kanbanService.ts:2309`) and jobs
  (`schedulingService.ts:1168`). Seven `tmpl.*` ids are bound by more than one twin. For example,
  `tmpl.commercial.risk-digest` is Ava's index 2 and Cleo's index 1. No fork hook covers agent
  profiles, whose `hitl`/`never` rules use the workflow id as the action class
  (`autonomousDispatchPolicy.ts:40-50`).
- **The dispatch already has a return-schema path**, which the runner does not use. When the
  agent declares a `returnSchema`, dispatch sends it as `responseSchema`
  (`agentDispatch.ts:910`) and fails `return_schema_violation` (`:937-946`). Dispatch also returns
  `escalated` with **no result** on low confidence or a gating RFC 0090 verifier (`:930-955`).
  The runner treats `escalated` as success (`agentRunnerNode.ts:404-405`).
- **Two honesty gaps in the nodes the twins would use:**
  - `core.ai.chatCompletion` returns `status:'success'` with `content: result.content ?? ''`
    (`packs/core.openwop.ai/index.mjs:141-145`), which is success-with-empty.
  - The agent-runner returns `success` with whatever `text` the dispatch produced
    (`agentRunnerNode.ts:406-411`), with no output schema.
  - `core.ai.structuredOutput` is the honest one. It runs schema-check, then an error-fed retry,
    then fails `structured_output_invalid` (`index.mjs:221-261`). Its checker has no
    `minLength`, so `""` passes a `type:string` field.

### Competitive frame

From `docs/steward/UX_UPGRADE-agents.md` (round 2) and `docs/research/deep-research-agent-evals.md`:

- **Relevance AI** ships the closest "AI workforce", with role-titled agents, and it **gates
  publishing on evals** ("a failing version never ships").
- **Agentforce Testing Center** grades topic routing, action selection and response quality in
  batches.
- The evals research's market consensus: grade **outcomes first, trajectory only for hard
  constraints** (a forbidden side effect, a required approval), start with 20–50 tasks mined
  from real failures, and report pass^k for consistency.
- The whitespace for us is the replayable, forkable event log as the test fixture.

D5 takes the eval-gated switch-over from Relevance AI and the outcome-first and
trajectory-as-constraint split from the research. No competitor ships a persona-bound
scheduled workflow whose reads are structural rather than tool-discretionary. D2 is that
shape.

## Decision

### D1 — Add, never replace: the 44 `tmpl.*` stay frozen replay archives

The `work-twin-templates` pack, its registration and `restoreTemplateShape` are **not
touched**, and the 44 chains stay `internal`. Every historical run keeps resolving its pinned
revision and `:fork`s def-identically, which `test/work-twin-template-chains.test.ts` already
holds.

Real-AI twins get **new** chains in a **new** pack (D2). A twin moves to real AI by
**re-pointing one member's portfolio entry**, never by editing a `tmpl.*` definition. A run
started before the re-point carries its own `workflowId` (`tmpl.*`). That id stays registered,
so the run replays and forks unchanged. A run started after the re-point carries the new id.

**The re-point is member-scoped, not the ADR 0789 fork fan-out.** The fork hooks rewrite every
row in the tenant (§ Context), so re-pointing Ava's `risk-digest` that way would also move
Cleo's portfolio and jobs onto a chain bound to `user.ava`. One host function,
`repointTwinPortfolioEntry(tenantId, rosterId, fromId, toId)`, rewrites only that member's rows:

- that roster row's `workflows[]` entry;
- the jobs whose `rosterId` is that member (`schedulingService.ts` job rows carry `rosterId`);
- the `triggerWorkflowId` of that member's board column;
- **that member's agent-profile rules** (`hitl`, `never`, `withinPolicyActions`) that name
  `fromId`. If those were left alone, a person's "ask me before `tmpl.reporting.daily-summary`"
  would silently stop applying the moment the twin went real.

Each write is a CAS. The function is idempotent, so a re-run after a partial failure finishes
the job. A witness asserts that a co-bound twin in the same tenant is untouched.

The seven `tmpl.*` ids no twin binds get no real-AI equivalent. They stay archive-only.

### D2 — Chain shape: structural reads → ONE twin judgment step → validate → gate → write

Ship `vendor.openwop-app.workflows.work-twins` (`examples/workflow-chain-packs/work-twins/`),
an RFC 0013 chain pack loaded by the built loader. Each chain is a **role chain parameterized
by `agentId`**. The twin is the default binding, and any roster agent can be bound. Every
chain has this shape and no other:

1. **Reads are nodes, never model discretion.** The chain's first nodes are the shipped read
   nodes that the matching gallery chain already uses. For example, the daily summary uses
   `feature.crm.nodes.list-deals` + `feature.analytics.nodes.query` +
   `feature.crm.nodes.list-tasks`, as `exec-ops.daily-briefing` does. Reading before writing is
   then a property of the graph, not of the prompt.
2. **The reads reach the twin through a fenced `context` input (gap G0).** The runner gains one
   additive input, `context`, a map of named read outputs. The read outputs bind to it on
   **port-qualified** edges, for example `list-deals.deals → judge.context.deals`. Bare edges
   are not used (the WF-ANL-6 lesson). The runner serializes `context` beside `task`, wrapped in
   the same untrusted markers `chatCompletion` applies (`applyUntrustedMarkers`,
   `core.openwop.ai/index.mjs:135`): CRM text is data an outsider may have typed. This is
   preferred over an RFC 0133 produced-variable bag (the `kicktodo-challenge-factory`
   precedent, `pack.json:487-491`), because a variable needs a feature node to build a string.
   That composer node would only re-implement `context` with worse fencing.
3. **An empty read short-circuits before the model.** When every read is empty, the run takes a
   `nothing-to-report` branch and completes without a model call. This is the
   `csm-ops.renewal-runway` `nothing-due` shape (`csm-ops/pack.json:425-436`). A brief drafted
   from nothing is the fabrication this ADR exists to remove. Gap G3 covers the read nodes that
   emit no emptiness signal.
4. **ONE judgment step: `local.openwop-app.agent-runner` with `offerTools: []`.** This step
   carries the twin's own persona, knowledge, memory and autonomy gate. Its tool surface is
   empty, which is verified to be one `callAI` (`agentDispatch.ts:860,889-915`). The chain
   carries only the **task** instruction. The persona stays on the agent record, so there is no
   prompt copy and no drift.
5. **Closed-world validation through the dispatch's own return-schema path (gap G1).** The node
   passes a per-chain `returnSchema` into the existing `responseSchema` /
   `return_schema_violation` path (`agentDispatch.ts:910,937-946`). It does not add a second
   checker on the node. G1 also makes three outcomes a **typed failure, never a success**:
   - an empty result;
   - `escalated` (today it is a success with `text: ''`);
   - an off-schema result after ONE error-fed repair.
   The failure code is `agent_output_invalid`, or `agent_escalated`. Every source id the draft
   cites must have appeared in `context` (gap G2). The schema text the model sees is generated
   from that schema (the `promptCatalogParity` rule).
6. **Declared outputs.** Each chain declares `outputs` with a primary role. The validated draft
   is the primary output, as `exec-ops.daily-briefing` declares `outputs.briefing`. Eval
   `output-*` assertions and ADR 0480 scoring read run outputs.
7. **Durable writes only behind a human gate.** The pilot writes nothing durable except the
   deliverable. That is a `feature.notifications.nodes.notify` to the person, with the validated
   draft on a port-qualified edge into `message` and a title saying it is an AI draft by the
   named twin. This matches every twin's "draft-only / recommends" charter in
   `exampleAgents.json`. From P2, any **domain** write goes through `core.chat.approvalGate` in
   the `csm-ops.renewal-risk@1.1.0` shape (the artifact comes off the validated draft, the write
   edge is conditioned `{truthy approved}`, and the write node has no unconditional incoming
   edge). Examples of domain writes:
   - a CRM task;
   - a ticket status;
   - a KB or FAQ document.

When a chain needs a capability no shipped node has, this pack does **not** get a bespoke node.
The gap is named (§ Gaps) and closed in its owning feature's node pack first.

### D3 — Reachability: listed, instantiated per tenant and twin; portfolios bind tenant-owned ids

- **Listed, not `internal`.** These are real-AI chains, so ADR 0190 §Phase 6's objection does
  not apply. They show in the `/builder` gallery and the `/` picker, and a person instantiates
  one with `…/workflows/from-chain` (`routes/workflows.ts:1096`) and `params`. Each chain
  requires `agentId` and its domain params, so the zero-config seed never touches it
  (`seedWorkflows.ts:87`).
- **The twin seed uses the from-chain sequence, not the `wf.seed.*` lane.** The `wf.seed.*`
  lane seeds zero-config chains only, and it shares one global definition across tenants. A
  shared deferred definition cannot carry a per-tenant `orgId`, for two reasons:
  - Deferred expansion **freezes** non-liftable `config` tokens (`workflowChainPackLoader.ts:1532-1548`),
    and the CRM nodes take `orgId` in `config`.
  - Deferred variable names are expansion-prefixed (`:1464`), but the schedule and board-trigger
    lanes seed variables by exact name or not at all (`runStarter.ts:205`,
    `heartbeatService.ts:179`).
  So the seed does Path A, once per (tenant, twin, chain):
  1. `expandChain` with `agentId` and `orgId` **frozen**;
  2. a deterministic id from the one mint module (`workflowId.ts`, ADR 0794), keyed on tenant,
     `rosterId` and chain, so a re-seed is idempotent;
  3. `registerWorkflowDurable` → `recordRevision` → `recordOwnership`, the same calls
     `from-chain` makes (`routes/workflows.ts:1202-1206`).
  The definition is tenant-owned and builder-editable. Every lane can start it with no inputs,
  including the board trigger, which supplies none.
- **Portfolios bind the tenant-owned id, never a bare chain id.** An owned id is what makes a
  workflow visible and editable (CLAUDE.md "Workflows — never hard-code").
- **Precondition, fail-closed.** A twin chain is bound only when its params resolve. If the seed
  cannot resolve the workspace's CRM `orgId`, the entry keeps its archive id and shows as
  "needs setup". A bound chain with no org would read `[]` forever, because CRM reads match
  `orgId` exactly (`exec-ops/pack.json:21`).
- **Where the binding lives.** `exampleAgents.json` keeps `workflows[]` as the archive ids. A
  sibling `realAi` map (`{"tmpl.reporting.daily-summary": "twin.daily-summary"}`) in the same
  brand-surface file names the chain for each entry. The seed applies a mapping only when the
  entry's precondition holds. There is no second, hard-coded map in TypeScript.
- **Existing tenants: opt-in per twin.** `POST /v1/host/openwop-app/roster/:rosterId/real-ai`
  instantiates the twin's chains and runs the D1 member-scoped re-point. It is gated by the
  agent-area write authority (ADR 0775 D1). **Calling it is the person's authorization for that
  twin's schedules**: its jobs keep their enabled state. Deletions stay deleted, so the seed's
  "the user's curation sticks" rule (`exampleDataSeed.ts:241-243`) holds. Whether to migrate
  existing tenants automatically is USER decision OQ-2.
- **No new toggle.** A chain is inert until something instantiates it. The switch for new seeds
  is the D5 CI gate on a code-reviewed change to the `realAi` map, not a runtime flag.

### D4 — Model, cost and the no-key path

- **Model (gap G5, confirmed by reading the code).** With no pin, the runner passes no
  `modelOptions` (`agentRunnerNode.ts:338`). Dispatch then defaults to
  `{preferManaged: true}` (`agentDispatch.ts:880`), and the resolver returns the managed tier
  **before it reads the model class** (`modelClassResolver.ts:93-96`). The result today:
  - Ezra's `reasoning` class does nothing;
  - a workspace's own BYOK key is ignored.
  P1 fixes this in the runner, not in the chains. The order follows chat:
  1. the agent's pin;
  2. the workspace's active BYOK binding (the ADR 0903 rung 2 reader, `runAiDefault.ts:49-56`);
  3. the managed tier for the agent's `modelClass`.
  Chains pin no provider or model (ADR 0903).
- **Per-run bound, structural.** A twin chain makes **at most two model calls per run**: one
  runner step with `offerTools: []`, plus G1's single repair. A ratchet test enforces the
  shape:
  - every chain in the pack has exactly one runner node;
  - that node has `offerTools: []`;
  - no node is a `core.ai.*` node.
  No new per-run token mechanism is built.
- **Per-workflow and per-tenant bounds.**
  - Each seeded twin workflow gets an ADR 0482 budget row with `hardCap: true`. The default is
    USER decision OQ-3 (proposed $0.50/day). The hard cap is checked at run start only and fails
    open (`workflowBudgets.ts:21-28`), so one run can overshoot. That is accepted because the
    per-run cost is bounded structurally.
  - The 120 runs/hour autonomous budget applies.
  - **The managed tenant cap is off by default**, and unattended runs draw one extra tenant-level
    bucket (§ Context). Turning on `OPENWOP_MANAGED_TENANT_DAILY_TOKEN_CAP` before the pilot
    reaches production tenants is operator decision OQ-7. Without it, the per-tenant AI spend
    bound is the ADR 0482 rows alone.
- **Schedules.** Seeded real-AI schedules start **disabled for every tenant**, not only `anon:`
  ones (`exampleDataSeed.ts:335`). ADR 0775 P3b's premise is that "a person who created a
  schedule already authorized it". A seed is not a person. The schedule stays visible, and
  turning it on is the authorization. This is USER decision OQ-4: it changes today's behaviour
  and amends `test/anon-seed-schedules-disabled.test.ts:39`, which asserts that every signed-in
  seeded job is enabled. Archive-bound schedules keep today's behaviour.
- **No key and no credit is a typed failure, never a pretend success.** The run fails with the
  dispatch's own code:
  - `byok_required`
  - `daily_limit_reached`
  - `sign_in_required`
  - `no_model_available`
  - `agent_paused`
  - `policy_denied`
  - `agent_escalated` (G1)
  The schedule's last-run status shows the code, and no card moves to Done. The twin never falls
  back to `tmpl.*` or to the mock node. In the `auth` posture the mock node is unregistered
  anyway.
- **A hitl fire is approved once.** An approved `hitl` schedule fire reaches the runner with
  `triggeredBy` and no `actingUserId` (`approvalDecision.ts:677-682`). The runner's own P3f check
  must not suspend it a second time. That is a P1 witness, and a runner fix if it reddens.

### D5 — Evaluation: a twin goes real-AI by default only when its CI evals are green

- **The switch is a CI suite, not the ADR 0477 promote gate.** ADR 0477's `requiredForPromote`
  gates one tenant's draft→published save (`routes/workflows.ts:758-775`) over per-tenant rows,
  so it cannot gate a seed. Each twin chain instead ships a **committed fixture suite** under
  `backend/typescript/test/`, which runs in `npm run ci` on the conformance `mock` provider. That
  provider needs no credential (`aiProvidersHost.ts:1937-1939`), and the suite pins it per run
  because the chains pin no provider. A change that adds an entry to the `realAi` map must keep
  its chain's suite green. The suite holds these witnesses, each sabotage-checked (the named
  sabotage must turn it red):
  1. On empty reads, the runner node did not run (`node-not-run`).
  2. On an off-schema, empty or escalated draft, the run fails `agent_output_invalid` /
     `agent_escalated` after exactly one repair.
  3. A draft citing an id that is not in `context` is refused (G2, a status assertion).
  4. A rejected gate reaches no write node (P2 onward). The gate is resumed in-test, because an
     eval run suspends at a gate into a timeout (`workflowEvalRunner.ts:271`).
  5. With no credential, the run fails typed and the card is not Done.
  6. A pre-re-point `tmpl.*` run still `:fork`s def-identically.
  7. The member-scoped re-point moves one member only, profile rules included.
  8. The graph shape: every runner input edge comes from a read node, and the runner has
     `offerTools: []`. Ordering is asserted on the graph, because the eval assertion vocabulary
     has no ordering kind (`workflowEvalSets.ts:23-28`).
- **Quality judgment is not in CI.** The ADR 0477 `llm-judge` needs a judge model
  (`workflowEvalRunner.ts:141`).
  - Each tenant's copy ships with an ADR 0477 eval set **seeded beside it**, which the tenant can
    run and extend.
  - ADR 0480 scores sampled production runs into daily trend buckets, with the same graders
    online as offline (point 8 of the evals research).
  - A per-twin `AgentEvalSuite` (`host/evals/suiteStore.ts:52-61`), run by the
    `agent-eval-regression-gate` chain, catches a persona edit that regresses the twin across
    its portfolio. It is wired in P2.
- **No-mock-in-prod guard, two halves:**
  - (a) A ratchet test fails if any chain in `work-twins`, or any chain it composes, resolves
    to `local.sample.demo.mock-ai`.
  - (b) A shrink-only ratchet pins the number of portfolio entries in `exampleAgents.json` that
    have **no** `realAi` mapping. It starts at 46 and only falls, so a new mock-only binding
    cannot land. The LEAK-3 runtime refusal (`nodes.ts:3597-3601`) stays as the production
    backstop.

### D6 — Pilot by measured value: Ezra `daily-summary` + Ava `risk-digest`

"Value" is measured from the repo. Prod usage was **not** read, because this ADR authorizes no
prod reads; a usage measurement is USER decision OQ-1. Each bound portfolio entry is scored on
three axes:

1. Does a real-AI gallery chain already prove the read shape, and is it graded clean?
2. Are all of the entry's reads **in-app**, or does it need an external Connection (ERP, HRIS,
   calendar, ITSM)?
3. Is the entry **scheduled**? A schedule is where a twin's work shows up unprompted, and a
   high-frequency schedule multiplies cost.

| Twin · entry | Gallery read shape | In-app reads | Scheduled (fires/week) | Verdict |
|---|---|---|---|---|
| **Ezra · `reporting.daily-summary`** | `exec-ops.daily-briefing`, WF-ANL-5/6 closed | CRM deals + tasks, analytics | `daily-brief`, 5 | **Pilot** |
| **Ava · `commercial.risk-digest`** | `crm-ops.deal-hygiene` (`list-deals`) | CRM deals | `pipeline-risk`, 1 | **Pilot** |
| Ava · `commercial.account-brief` | `exec-ops.meeting-prep` (`get-company`) | CRM, but **which account** needs the calendar | `account-brief`, 5 | P2: needs a target-selection decision |
| Cleo · `renewal-pack`, `risk-digest` | `csm-ops.*` | CSM + CRM | 2 | P2 |
| Idris · `it.incident-triage` | `it-support.incident-triage` | service desk + KB | `*/30`, **336** | P3: cost exposure 56× Ezra; needs budget evidence first |
| Felix · finance close | `finance.month-end-close` | **ERP connector** | ~1.4 | P4 (connector-gated, ADR 0033) |
| Ren · scheduling, Ezra · `meeting-brief` | `exec-ops.meeting-prep` | **calendar connector** | 5 / 1 | P4 |
| Pax · people | `people-hr.*` | **HRIS connector** | 1 | P4 |
| Mira, Quill | `knowledge.*` | KB + documents | 1 / 1 | P3 |

Both pilot chains write only the drafted deliverable to a person (D2 step 7), so **the pilot
has no domain-write path at all**. The first gated write lands in P2. Note that
`tmpl.commercial.risk-digest` is also Cleo's index 1. The pilot moves **Ava's** binding only,
which is why D1 is member-scoped.

### What the twin shows when it is not real yet

A portfolio entry still bound to a `tmpl.*` archive renders as "demo, not run by AI", using the
existing `workflowDemoAvailability` signal. It never renders as the twin's own work. This
applies the existing seam to the agent workspace's portfolio list; nothing new is built.

## Gaps (named, each closed in its owner first)

| Id | Gap | Owner / smallest shape |
|---|---|---|
| G0 | The runner has no input for structured read data. An edge into it is dropped (`agentRunnerNode.ts:65-97`) | `local.openwop-app.agent-runner`: an additive `context` map input, serialized beside `task` inside untrusted markers. Existing chains are unaffected. |
| G1 | The runner succeeds with empty, escalated or off-schema output (`agentRunnerNode.ts:404-411`) | The runner passes an optional per-node `returnSchema` into the existing dispatch `responseSchema` / `return_schema_violation` path (`agentDispatch.ts:910,937-946`), with ONE error-fed repair. When `returnSchema` is set, `escalated` and empty results become typed failures. Opt-in, so the `@mention` and scheduled-chat lanes are unchanged. |
| G2 | Nothing checks that a draft's cited ids came from the run's own reads | A post-check inside G1: a schema field marked `x-openwop-cites` must be a subset of the ids present in `context`. No new node. |
| G3 | Read nodes emit no emptiness signal. `list-deals` returns `{deals: []}` (`packs/feature.crm.nodes/index.mjs:136`), whereas `renewals-due` emits `any` | `feature.crm.nodes` / `feature.analytics.nodes`: an additive `any` output, following the `renewals-due` precedent, with a pack minor bump. |
| G4 | `structuredOutput`'s checker has no `minLength` (`core.openwop.ai/index.mjs:173-199`) | Upstream `core.openwop.ai`. D2 does not need it. It is recorded so that nobody "fixes" G1 by reaching for `structuredOutput`. |
| G5 | With no pin, the runner ignores `modelClass` and the workspace BYOK binding (`agentRunnerNode.ts:338`, `modelClassResolver.ts:93-96`) | The runner's model options follow the chat order (D4). Confirmed by reading the code, not by a run; P1 adds the witness. |

## RFC verdict

Host-only, with no new RFC. Applying the three-part test from CLAUDE.md:

- **Nothing new reaches the wire.**
  - The chains use the existing RFC 0013 chain format, Path-A expansion, and RFC 0135
    `internal` semantics (unchanged).
  - They need no sub-chain nesting. D2 step 2 chose the runner's `context` input (G0) over the
    RFC 0133 produced-variable bag, which is already shipped (`kicktodo-challenge-factory`), so
    either choice stays inside existing RFCs.
  - The runner, its `context` input and its `returnSchema` (G0/G1) are host-local node config
    (`local.openwop-app.*`).
  - G3's `any` outputs are additive feature-pack ports.
  - The re-point route, budgets and seeded eval sets are host extensions under
    `/v1/host/openwop-app/*`.
  - The runner emits the existing RFC 0064 `agent.*` events.
- No event type, capability flag, endpoint contract or normative MUST changes.
- No capability is newly advertised, so the test's shape-lock and advertisement-gate conditions
  are vacuous here.

## Phases

| Phase | Scope | Exit evidence |
|---|---|---|
| P0 | Reserve the pack name. Land the D5(a) no-mock ratchet against an empty `work-twins` pack, and the D5(b) shrink-only ratchet at 46. Add the `realAi` map field (empty) to the seed spec. | both ratchets red on sabotage |
| P1 | Runner G0 + G1 + G2 + G5, with the hitl-once witness. G3 for CRM and analytics. The `work-twins` pack with `twin.daily-summary` and `twin.risk-digest`. The seed's Path-A instantiation and fail-closed precondition. `repointTwinPortfolioEntry` + the opt-in route. CI witnesses 1–3 and 5–8. Then map Ezra and Ava in `realAi`. | the CI suites are green; the ratchet goes 46 → 44; a co-bound Cleo is untouched |
| P2 | First gated write: Ava `next-step-draft` → CRM task behind the `renewal-risk` gate shape (witness 4). Cleo `renewal-pack` + `risk-digest`. Decide Ava's `account-brief` target selection. Wire the per-twin `AgentEvalSuite`. | gate-rejection witness red on sabotage |
| P3 | KB- and documents-backed entries: Mira (comms, `faq-update`), Quill (`comparison-summary`) and Idris (`kb-recommendation`). Idris's `incident-triage` goes only with budget evidence (OQ-3) from P1/P2 ADR 0480 scores. | CI suites green; ADR 0480 online scores at or above the tenant eval-set pass bar for 14 days |
| P4 | Connector-dependent entries: Felix (ERP), Pax (HRIS), Ren and Ezra (calendar). Bound only where ADR 0033 `requiredConnections` is satisfied; otherwise fail-closed with a typed refusal. | connected-tenant e2e; unconnected → typed refusal |
| P5 | Every bound entry is mapped. The ratchet reaches 0. The archives stay `internal` forever (replay law). | ratchet at 0; `work-twin-template-chains` replay witness still green |

## Alternatives weighed

- **Re-pin portfolios to the existing gallery chains as-is.** Cheapest, and the read shapes are
  already graded. Rejected because a gallery chain is not the twin:
  - it has no persona, no agent knowledge and no memory;
  - it skips the P3e/P3f autonomy gate on non-schedule lanes, so a paused Ezra's portfolio would
    still run when a trigger started it;
  - its `chatCompletion` succeeds with an empty draft.
  The gallery chains stay the **reference for the read wiring**. A parity test pins each twin
  chain's read-node set against its named gallery reference, which bounds the cost of the
  duplicated wiring (about four nodes per chain).
- **Make the gallery chains agent-aware**, with an optional `agentId` that swaps the judgment
  step. Rejected: a chain cannot swap a node's type on a param. Branching on it would double
  every gallery chain and leak twin concerns into chains every user sees.
- **Agent-runner with read tools instead of read nodes** (the twin decides what to read).
  Rejected for scheduled portfolio work:
  - reading before writing becomes model discretion;
  - the run becomes a tool loop of up to `DEFAULT_MAX_TOOL_ROUNDS` = 5 rounds
    (`agentDispatch.ts:67`) instead of one call;
  - evals then need trajectory matching that the assertion vocabulary lacks.
  Chat with the twin keeps the tool-using lane: the ONE chat, deep-linked `/?agent=<id>`,
  unchanged.
- **The `wf.seed.*` lane with a shared deferred definition.** This was the first draft. The
  architect pass refuted it (B3): `orgId` freezes in `config`, prefixed variable names never
  reach the schedule or board lanes, and the lane skips non-zero-config chains.
- **Re-point through the ADR 0789 fork hooks.** This was the first draft too. The architect pass
  refuted it (B1): the hooks are tenant-wide and co-bound ids are common.
- **Edit the `tmpl.*` chains in place to real AI.** Rejected: that breaks byte identity (the
  ADR 0775 P2 replay note), and the user decided on 2026-10-10 that the chains stay archives.
- **Retire the portfolios and let the twins work only through chat.** Rejected: schedules and
  board triggers are ADR 0032's standing-work promise. Removing them hides the dishonesty
  instead of fixing it.
- **All 44 at once.** Rejected: 37 bound ids across 9 twins, four of which need connectors. One
  CI-gated pilot proves the shape and the cost model before scale.

## Open questions

- [ ] **OQ-1 (USER).** Authorize a read-only prod measurement of twin usage (board activity,
  schedule enablement, chat turns per twin) to re-rank P2–P4? The pilot ranking rests on repo
  measurements only.
- [ ] **OQ-2 (USER).** For existing tenants: opt-in per twin through the re-point route
  (recommended), or automatic migration once a twin's mapping lands?
- [ ] **OQ-3 (USER).** The default ADR 0482 daily budget per seeded twin workflow (proposed
  $0.50, `hardCap: true`). Should Idris's 30-minute triage ship at that cadence or a slower one?
- [ ] **OQ-4 (USER).** Should seeded real-AI schedules start disabled for signed-in tenants too
  (recommended: a seed is not a person's authorization)? This amends the enabled-by-default seed
  and its test.
- [ ] **OQ-5 (USER).** Should the twin chains be listed in the `/builder` gallery and `/` picker
  (recommended: they are real AI and agent-parameterized), or only on the agent workspace?
- [ ] **OQ-6.** Should the deliverable also post into the twin's conversation (the runner's
  `conversationId` lane, under ADR 0879 D7 write authority), so that "the twin reported" shows in
  the ONE chat as well as the inbox? An engineering call, to decide in P1.
- [ ] **OQ-7 (USER / operator).** Set `OPENWOP_MANAGED_TENANT_DAILY_TOKEN_CAP` in production
  before twins run unattended on the managed tier? Without it, a tenant's free unattended AI is
  bounded only by the per-subject bucket and the ADR 0482 rows.

## Architect pass

An adversarial `/architect` review (Track A; read-only, with every claim checked against the
code) ran on the first draft on 2026-10-19. It found **4 Blockers, 5 High and 5 Medium**. All are
folded into the decision text above. None was waived.

| # | Sev | Finding | Fold |
|---|---|---|---|
| B1 | Blocker | The ADR 0789 fork hooks are tenant-wide (`rosterService.ts:408-419`, `kanbanService.ts:2309-2328`, `schedulingService.ts:1168-1175`), and seven `tmpl.*` ids are co-bound. Re-pointing Ava's `risk-digest` would have moved Cleo onto a chain acting as `user.ava`. | D1: the member-scoped `repointTwinPortfolioEntry`; witness 7; the D6 note |
| B2 | Blocker | The runner has no input for read output (`agentRunnerNode.ts:65-97`), so D2's edges went nowhere. The RFC verdict's "no produced-variable bag needed" was unsupported. | G0 `context` input; D2 step 2; RFC verdict rewritten |
| B3 | Blocker | A shared deferred definition cannot carry `orgId`: config tokens freeze (`workflowChainPackLoader.ts:1532-1548`), and prefixed variables never reach the schedule or board lanes (`runStarter.ts:205`, `heartbeatService.ts:179`). The `wf.seed.*` lane is also zero-config only (`seedWorkflows.ts:87`). The chain would have read `[]` and reported "nothing" forever. | D3: per-tenant Path-A expansion with frozen params, a deterministic id, revision + ownership |
| B4 | Blocker | The ADR 0477 promote gate gates one tenant's save (`routes/workflows.ts:758-775`), not a seed. | D5: the committed CI fixture suite gates the `realAi` map change |
| H1 | High | The runner ignores `modelClass` and the workspace BYOK key when unpinned (`agentRunnerNode.ts:338`, `modelClassResolver.ts:93-96`). | G5 confirmed; the D4 model order |
| H2 | High | `escalated` succeeds with `text: ''` (`agentDispatch.ts:930-955`, `agentRunnerNode.ts:404-405`). | G1: typed `agent_escalated` |
| H3 | High | G1 would have duplicated the dispatch's `responseSchema` / `return_schema_violation` path. | G1 rides that path |
| H4 | High | Agent-profile `hitl` / `never` rules are keyed by workflow id and no hook re-points them (`autonomousDispatchPolicy.ts:40-50`). | D1: the re-point covers profile rules |
| H5 | High | Unattended runs bill a bare-tenant bucket (`managedUsageScope.ts:47-49`); the tenant cap is off by default (`managedProvider.ts:468-471`); `sign_in_required` was missing. | D4 and Context rewritten; OQ-7 |
| M1 | Medium | An approved hitl fire could be suspended a second time by the runner (`approvalDecision.ts:677-682`). Inferred, not run. | D4: the hitl-once witness in P1 |
| M2 | Medium | The eval assertion vocabulary has no ordering or subset kind (`workflowEvalSets.ts:23-28`); gates suspend eval runs (`workflowEvalRunner.ts:271`); `llm-judge` needs a judge. | D5: graph-shape witness, gate resumed in-test, judge kept out of CI |
| M3 | Medium | The 46 ratchet counted JSON while the fallback needed the `tmpl` id to survive elsewhere. | D3 `realAi` map in the same JSON; D5(b) counts unmapped entries |
| M4 | Medium | Disabling seeded schedules reddens `anon-seed-schedules-disabled.test.ts:39`; the opt-in route's authorization was unstated. | D4 names the test amendment; D3: the route call is the authorization |
| M5 | Medium | Chains need declared `outputs`; CRM text reached the model unfenced. | D2 step 6; G0 fences `context` |

Verified true by the same pass:
- `offerTools: []` yields zero tools and one `callAI` (`agentDispatch.ts:860,889-915`).
- LEAK-3 does not register the mock node in the `auth` posture (`nodes.ts:3597-3602`).
- The scheduler hook leaves job `inputs` alone, and old `tmpl.*` runs keep their own id.
- `user.<slug>` is the same in every tenant (`exampleDataSeed.ts:385`).
- No `work-twins` pack name collides.
- The ADR 0482 hard cap is checked at run start and fails open.

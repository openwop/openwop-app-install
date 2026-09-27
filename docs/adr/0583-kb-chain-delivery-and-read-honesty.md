# ADR 0583 — The KB chains deliver what they promise, and a failed read stops reading as an empty one

Status: implemented

Supersedes nothing. Follows **ADR 0581** (KB detectors + cross-org vector
namespace + teardown reclamation, PR #3333 — "batch 1"). This is batch 2.

Findings closed here are from `docs/steward/{WORKFLOWS,UX,CODEBASE}-ASSESSMENT.md`
§ "Knowledge Base / RAG" (pass of 2026-08-17): **WF-KB-5, WF-KB-15, WF-KB-7,
WF-KB-16, WF-KB-17, WF-KB-9, WF-KB-4** and **KB-UX-1, KB-UX-2, KB-UX-3, KB-UX-4,
KB-UX-10, KB-UX-14, KB-UX-16**.

## Context

Two families, one shape. In both, a **failure was rendered as a success** — not
by a bug that threw, but by a code path that produced the same value success
produces, so nothing downstream could tell.

### 1. The chains reported success while delivering nothing (WF-KB-5)

All three `knowledge.*` chains ran green and delivered no product. The mechanism
is one line of the scheduler: `buildNodeInputs` (`executor/scheduler.ts`) writes
each inbound edge's value to `e.targetInput ?? 'input'`. A **bare** edge
(`{from:"route", to:"deliver"}`) therefore lands the *entire upstream output map*
under the single port `input` — it is never spread by output name. So:

| Node | Reads | Was bound? | What shipped |
|---|---|---|---|
| `feature.notifications.nodes.notify` | `inputs.message` | no | a titled inbox row with an **EMPTY BODY**, `emitted:true`, run green |
| `core.chat.approvalGate` | `inputs.artifact` | no | a **BLANK** "Approval Required" card — approve-what-you-see, with nothing to see |
| `core.openwop.integration.slack-message` | `inputs.text` | no | `postMessage({text: undefined})`; the pack's `required:["text"]` is decorative — there is no runtime node-input validation |

`knowledge.doc-summarizer` has one outbound leg and no gate, so its **entire
product** was lost on every run, silently.

This is a known family with a known cure in this repo: `csm-ops.health-from-crm`
hit it, was root-caused, and was fixed with PORT-QUALIFIED edges
(`workflow-chain-csm-ops-execution.test.ts:12-32`); #3344 re-applied the same fix
to `csm-ops.renewal-risk`. We copied that cure rather than inventing one.

### 2. Reads rendered their failure as an empty result (KB-UX-1..4)

Four Blockers, all the same shape:

- **KB-UX-1** — `runSearch` toasted and returned WITHOUT clearing `hits`. After a
  successful empty search it re-rendered "No matches — add documents, or try a
  different question"; after a successful non-empty one it left the PREVIOUS
  query's hits on screen under the new query. A toast is not a state: it expires,
  and the false claim stays.
- **KB-UX-2** — `runToCompletion` returns on any non-`running` status and `start`
  then fired `toast.success('Reindex complete')` unconditionally, so `failed`,
  `cancelled` and `paused` all reported success and the `reindexFailed` string
  was unreachable from a job that reports failure.
- **KB-UX-3** — `agentKnowledgeComposition.ts` catches a KB/memory fault and
  contributes nothing, so the three retrieval previews got
  `{chunks:[], hasResults:false}` at **HTTP 200** — the same value an empty
  corpus produces. Each panel's `.catch` was unreachable for the entire class.
- **KB-UX-4** — a failed org/collection/document read left `null`, the same value
  as "not read yet", so the page rendered a **skeleton with no terminal
  condition** and no retry anywhere. The page used neither `useOrgSelection` (64
  adopters) nor `ui/OrgSelectionState` (67), whose docstring names this exact bug.

## Decision

### D1 — Port-qualify every delivery edge; make the primary the happy path

`examples/workflow-chain-packs/knowledge/pack.json` @ `1.0.4 → 1.2.0`;
`policy-qa` + `compliance-review` `1.0.0 → 1.2.0`, `doc-summarizer`
`1.0.0 → 1.1.0`:

```
route.value → deliver.message                 (cond: branch == "then")
route.value → approveEscalation.artifact      (cond: branch == "else")
approveEscalation.artifact → escalate.text    (cond: truthy approved)
summarize.content → notify.message
retrieve.augmentedPrompt → answer.prompt        (WF-KB-17)
```

> **CORRECTION, 2026-08-18 — the first cut of D1 ARMED the hole §Open deferred.**
>
> D1 originally routed the escalation content STRAIGHT off the router
> (`route.value → escalate.text`, conditioned `branch == "else"`) and left
> `approveEscalation → escalate` bare. That is strictly WORSE than the bug it
> replaced, and the §Open note below claimed the opposite:
>
> - **Before**, a REJECT still fired `escalate` — the bare edge plus
>   `approvalGate`'s `status:'success'` on reject satisfies `all_success` — but
>   `text` was never bound, so it posted `undefined`. **Nothing left the org.**
> - **After**, the sibling `route.value → escalate.text` edge was `completed` on
>   the else branch *regardless of the decision*, so a rejected escalation posted
>   the full uncovered-policy answer to `#people-ops` and the full compliance
>   deviation list to `#compliance`. **Five of six gate outcomes leaked**
>   (reject, timeout, refine, ask, and the card's unmapped `defer`/`escalate`
>   verbs, which fall through to `refine`) — while the manifest gained the line
>   *"Every external send waits on a human approval gate."*
>
> The cure is **two lines per chain** and was already merged, documented and
> exemplified in this repo:
> `packs/vendor.myndhyve.chat/schemas/approvalGate.output.json` §`artifact`
> ("so the effect node has no unconditional incoming edge that would fire it on a
> rejection"), restated with its measurement at
> `packs/vendor.myndhyve.chat/index.mjs:386-394`, and shipped by
> `csm-ops.renewal-risk@1.1.0` (#3344). **The effect node takes its content BACK
> OFF THE GATE.** `approvedArtifact = resumePayload?.editedArtifact ??
> inputs.artifact` (`index.mjs:395`), so an approval still carries the content —
> and an *edit-accept* now carries the reviewer's edited version, which the old
> wiring structurally could not.
>
> `escalate` therefore has **exactly ONE incoming edge, and it is conditioned**.
> On every non-approving outcome that sole upstream folds to `skipped`
> (ADR 0208), `all_success` sees `allTerminal && !anyCompleted`, and the node
> skips. Held by four new reject/refine/timeout witnesses, each verified RED
> against the pre-correction wiring — with the **egress** assertion ordered
> FIRST, because under sabotage the node-state assertion fires first and would
> mask whether the egress assertion discriminates at all.

**The condition on the escalation edge is load-bearing, not decoration.**
Edge conditions are CONTROL FLOW (ADR 0208 — `evaluateTrigger` folds a
false-conditioned completed upstream to `skipped`), and `all_success` fires a
target as soon as ANY upstream completed. An UNconditioned edge into `escalate`
— from the router OR from the gate — makes it fire on a path it must not: that
is the single mechanism behind both the original WF-KB-5 routing bug and the
correction above.

**WF-KB-15**: `expandChain` stamps `outputRole:'primary'` on the LAST terminal in
declaration order (`workflowChainPackLoader.ts:1090-1092`). `deliver`/`pass` were
declared *before* `escalate`, so the primary was the else-branch Slack post — a
node that does not run at all on the happy path. The nodes are reordered so the
happy-path terminal is declared last.

> **WF-KB-15 is RELOCATED, not eliminated — say so rather than closing it.**
> The positional rule ("last terminal in declaration order") cannot be *correct*
> for a two-terminal BRANCHING chain: whichever terminal is declared last, the
> other branch's run has no primary output. Reordering moved the gap from the
> common path (covered questions / clean documents, where it was permanent) to
> the escalation path (where the run now has no primary). That is a real net
> improvement and it is all a node ORDERING can buy. The actual fix is an
> explicit per-node `outputRole` in the chain format — an additive RFC 0013
> extension, out of scope here and not claimed as done.

**WF-KB-9**: the dead `config.query` on both `feature.kb.nodes.rag` nodes is
deleted (the node reads `ctx.inputs` only).

### D2 — The witnesses drive the REAL scheduler

**WF-KB-7.** The old execution test drove `core.openwop.integration.notification-push`
— a *different node type from a different pack* — hand-authored its inputs so
`buildNodeInputs` never ran, and asserted the non-delivery
`{sent:false, error:'notification_not_connected'}` as the expected outcome. It
was structurally unable to see the defect it was written to cover.

It now walks the chain with `buildGraph` / `freshSnapshot` / `evaluateTrigger` /
`buildNodeInputs` **imported from `executor/scheduler.ts`**, not re-implemented.
(The `walkChain` harnesses in the marketing/finance execution tests re-implement
the port semantics by hand, which is precisely how a port-mapping bug stays
invisible.) Only two lines are reproduced — the executor's single-`input` unwrap
and its `node.inputs`-wins merge — and they are quoted from `executor.ts`.
Assertions are on DELIVERY: the durable notification's `message`, the approval
card's `artifact`, the Slack `text`.

**WF-KB-16.** The structural test expanded `knowledge.policy-qa` with
`{question: …}` — a param the pack **renamed to `query`** — so its determinism and
single-primary assertions ran against a state no real instantiation produces.
Sample params corrected; a **required-param ratchet** added (which immediately
found the same drift in BOTH inbox chains); the expected primary is asserted **by
node id**, not counted; and a **delivery-port binding check** covers the WF-KB-5
class for this pack.

### D3 — `failedSources`, reported by the server (KB-UX-3)

The SPA cannot distinguish two identical 200s, so the cure had to be server-side.
`AgentKnowledgeRetrieve` gains an **optional** `onSourceError` sink:

```ts
type AgentKnowledgeRetrieve = (
  query: string,
  onSourceError?: (source: 'kb' | 'memory') => void,
) => Promise<ReadonlyArray<Chunk>>;
```

Dispatch and chat still call `retrieve(query)` and are byte-identically
unaffected — the best-effort property that keeps a KB blip from failing a live
agent turn is deliberately preserved. The three preview services
(`retrieveForAgent`, `retrieveForProject`, `retrieveForProfile`) pass the sink and
return `failedSources`, which the two panels render as "part of this knowledge
could not be searched" **instead of** "No matches".

*Alternative weighed and rejected:* changing the retriever's return type to
`{items, failedSources}`. It ripples through six call sites including live
dispatch and chat context — a large blast radius on the hot path, to fix a
preview. The optional sink is additive and typed, needs no cast, and leaves every
existing caller unchanged.

### D4 — Three renderable states per read (KB-UX-1, KB-UX-2, KB-UX-4)

- Search is `idle | results | failed`. The `results` state **carries its own
  query**, so hits and the question they answer cannot drift apart; `noMatches`
  is reachable ONLY from a resolved empty response; failure is a `StateCard
  announce` + Retry.
- Orgs ride the shared `useOrgSelection` + `ui/OrgSelectionState` (the branch
  ORDER — failed → empty → children — is the component's, and taking the layout
  as its CHILD makes it unskippable). Collections and documents get the same
  failed/loading/empty split with their own retry.
- Reindex: `runToCompletion` now RETURNS its terminal job and one `reportTerminal`
  helper branches it. `done` → success; `cancelled` → info; `paused` → nothing
  (the budget `Notice` already says it, on screen and persistently); anything
  else → the error, carrying `job.error`.
- **KB-UX-10**: `busy` is split into `starting` and `draining` so Cancel is live
  during the drain — it was disabled for the whole job, i.e. exactly when a user
  wants it. `resume` gained the `.catch` it never had.
- **KB-UX-14**: `h.score ?? 0` rendered an ABSENT score as a confident `0.000`;
  it is now an em-dash with an sr-only explanation.

**The trap in this cure**, which this repo has reintroduced three times in a
week: a retry that clears the failure FLAG while stale empty DATA remains
re-renders the false-empty state for the frame between the click and the settle.

> **CORRECTED, 2026-08-18 — this paragraph claimed more than the code does.**
> It said *"Every retry here clears data and flag together"* and *"the test
> asserts the DOM between the click and the resolve"*. Both are overstated:
>
> - The **org** retry does NOT clear data and flag together.
>   `ui/useOrgSelection.ts:113` bumps `reload` only; `orgs` and `orgsFailed`
>   keep their values until the refetch settles. It is safe anyway — but for a
>   DIFFERENT reason than the one stated: `ui/OrgSelectionState` branches
>   **failed-first**, so the stale `orgsFailed` keeps the failure state on
>   screen rather than falling through to an empty one. The protection is
>   BRANCH ORDER, not the clearing mechanism. Naming the wrong mechanism is
>   how the next author "simplifies" the branch order and reintroduces the bug.
>   `runSearch` and `reloadDocs` *do* clear data and flag together.
> - Only the **search** retry is asserted between the click and the resolve
>   (the deferred-promise arm). The others use `waitFor`, which by construction
>   skips past the frame that holds this bug. So the between-frames property is
>   witnessed for ONE of the three retries, not all of them.

### D5 — The knowledge-sync daemon honours its toggle (WF-KB-4)

`processDueSyncs` resolves the per-tenant `knowledge-sync` gate per tick and
skips a gated-out tenant before listing anything — **fail-CLOSED** on a resolver
error. The write path was gated on all eight routes and the RECURRING path was
not: a tenant that enabled → configured → **disabled** kept paying scheduled
third-party egress and embedding spend forever, with no product surface left to
see or stop it.

> **CORRECTION, 2026-08-18 — BOTH halves of the route gate, not one.**
> `requireFeatureEnabled` gates on the toggle **and**, for an
> `isSellableBundleFeature` id, the tenant's plan entitlement
> (`features/featureRoute.ts:37-53`). `knowledge-sync` is in the `content`
> bundle (`distributions/bundles.json:124`), so it **is** sellable. Gating only
> the toggle reproduced the identical hole one layer over: a tenant whose plan
> stopped covering the feature gets 404/403 on all eight routes while
> `processDueSyncs` keeps paying for scheduled Drive egress and embedding spend.
>
> The seam gained a **tenant-scoped** sibling —
> `registerTenantEntitlementCheck` / `checkTenantEntitlement`
> (`host/entitlementSeam.ts`), registered by billing at boot, backed by
> `requireEntitledFeatureForTenant` which shares ONE `assertEntitled` decision
> with the request-scoped guard so the two verdicts cannot drift. A daemon has a
> tenant id and no `Request`, and it cannot reuse `EntitlementCheck` (which reads
> `req.principal` for the ADR 0176 shopper exemption — a daemon has no principal
> to exempt). Nothing is registered when billing is absent, so an unrestricted
> host is byte-identically unaffected.

The env var at the start site (`OPENWOP_KNOWLEDGE_SYNC_DAEMON_ENABLED`) is an
operator kill-switch and **defaults ON, deliberately**. The assessment suggested
matching the neighbouring opt-in daemons; making it opt-in would silently stop
every already-configured tenant's scheduled sync, which is a regression wearing a
fix's clothes. The per-tenant gate is the actual fix.

**But defaulting ON inverts the flag's failure mode, so the flag needs a real
parser.** Every neighbouring daemon is `=== 'true'` — an opt-in where a typo
fails CLOSED (nothing starts). This one is an opt-OUT where a typo fails **OPEN**
(it keeps spending), and it is the control an operator reaches for *during an
egress incident*, typed by hand under pressure. A strict `=== 'false'` silently
ignored `0`, `off`, `no` and `FALSE`. It is now the named, tested
`knowledgeSyncKillSwitchEngaged()` accepting the normal falsy set
(case-insensitive, trimmed), documented in DEPLOY.md § incident-response env
knobs with the `gcloud run services update` line to reach for.

### D6 — A source that could not be searched is never an empty one, on EVERY lane

Two gaps D3 left open, both the same shape it was written to close:

- **The ABSENT backend** (`host/agentKnowledgeComposition.ts`). The KB leg was
  `if (wantKb && backend)`, so with no backend registered the leg was skipped
  entirely: `onSourceError('kb')` never fired and a binding that names
  collections reported the same `{chunks:[], hasResults:false}` an empty corpus
  produces. The sink covered the `throw` path and left the *absent* path
  reporting "No matches". Absence is now reported as a source failure. The same
  line also read `getKnowledgeBackend()` at RESOLVE time, outside the closure, so
  a retriever built before the backend registered stayed permanently
  backendless — it is read per call now.
- **The WORKFLOW-NODE lane** (`features/agent-knowledge/surface.ts` +
  `packs/feature.agent-knowledge.nodes` @ `1.1.0 → 1.2.0`). The surface projected
  only `{chunks, hasResults}` and DROPPED `failedSources`, so on the one lane
  whose consumer is usually a **model**, a faulted backend still arrived as
  `hasResults:false` — and the model then confidently answers "there is nothing
  in your knowledge base". Projected now, `[]` on the happy path, so a chain that
  ignores it is unaffected.

## Consequences

**Replay note.** The pack change is a definition-shape change. Existing
instantiations keep their old expansion id AND their old (broken) behaviour —
`deterministicExpansionId` is a hash of `(chainId@version, params)` and the chain
versions moved, so nothing re-expands in place. **Re-instantiate via
`…/workflows/from-chain` to pick up the fix.** No wire change; no RFC gate.

**Operator note — the fix does not reach a running host until the pack is
republished.** See §Open: the registry copy shadows `examples/`, so a merge alone
changes nothing for `npm run dev`, `scripts/e2e-routes.sh`, or any self-hosted
install.

**Wire.** None. `failedSources` rides host-extension routes under
`/v1/host/openwop-app/*`, which are non-normative.

## Implementation record

| Finding | Where | Witness |
|---|---|---|
| WF-KB-5 | `examples/workflow-chain-packs/knowledge/pack.json` | `workflow-chain-knowledge-execution.test.ts` (5 tests, real scheduler) |
| WF-KB-15 | same, node ordering | same + `workflow-chain-knowledge-inbox.test.ts` (primary by NAME) |
| WF-KB-17 / WF-KB-9 | same | `…-execution.test.ts` (named `prompt` port) |
| WF-KB-7 / WF-KB-16 | both test files | self |
| WF-KB-4 (toggle) | `features/knowledge-sync/knowledgeSyncDaemon.ts`, `index.ts` | `knowledge-sync-daemon.test.ts` (+2) |
| WF-KB-4 (entitlement + kill-switch) | `host/entitlementSeam.ts`, `features/billing/{entitlementGuard,routes}.ts`, `knowledgeSyncDaemon.ts`, `index.ts`, `DEPLOY.md` | `knowledge-sync-daemon.test.ts` (+4) |
| WF-CSM-1 on this pack (the D1 correction) | `examples/workflow-chain-packs/knowledge/pack.json` | `…-execution.test.ts` — 2 reject legs, 1 refine leg, 1 timeout leg, all on the REAL `{action}` UI payload |
| KB-UX-3 | `host/agentDispatch.ts`, `host/agentKnowledgeComposition.ts`, 3 services, 3 clients, 2 panels | `agent-knowledge-partial-retrieval.test.ts` (6), `knowledge/__tests__/retrievePartialNotEmpty.test.tsx` (4) |
| KB-UX-3 (D6: absent backend + node lane) | `host/agentKnowledgeComposition.ts`, `features/agent-knowledge/surface.ts`, `packs/feature.agent-knowledge.nodes` | `agent-knowledge-partial-retrieval.test.ts` (+5) |
| KB-UX-1/2/4/10/14/16 | `features/kb/KnowledgeBasePage.tsx` | `features/kb/__tests__/readHonesty.test.tsx` (14) |
| Registry-shadow visibility | `scripts/check-registry-parity.sh` | self — its first run found 10 stale packs (LIVE lane) |

**Non-vacuity.** Every new assertion was run against the pre-fix code and
observed RED, then restored: the pack edges reverted (5/5 execution tests), the
node order reverted (2 primary assertions), the delivery
ports un-named (3 structural), the daemon toggle check removed (2), the
`onSourceError` calls removed (3 backend), the search failure returned to a toast
(3 frontend), the reindex success toast made unconditional (3), Cancel re-disabled
(1), the list-read failure flags dropped (2), and `orgsFailed` forced false (1).

For the D1 CORRECTION specifically, the probe restored this PR's own
pre-correction wiring (`route.value → escalate.text` + the bare
`approveEscalation → escalate`) on both routing chains: **6 escalation-lane tests
went RED**, and the reject leg failed on
`a rejected escalation must post NOTHING to #people-ops: expected [ { channel: '#people-ops', … } ] to have a length of +0 but got 1`
— i.e. the probe witnessed the actual egress, not merely a node-state difference.
That assertion is ordered BEFORE the `escalate === 'skipped'` one on purpose:
with the state assertion first, it aborts the test and the egress assertion never
runs, so the probe could not have told whether it discriminated at all.

For D6 the probe removed the two lines independently: dropping the
absent-backend `onSourceError` reddened 1 test, and dropping the surface's
`failedSources` projection reddened 2. For the kill-switch, the parser's own
truth table is asserted in both polarities (11 accepted spellings, 7 rejected).

**One probe that FOUND something rather than confirming it.** The first cut of
the registry-parity version check read the index field `version`. The live index
publishes `latestVersion`; `version` is absent, so every pack compared as UNKNOWN
and the check printed a clean bill of health while `core.openwop.workflows.csm-ops`
sat a full minor version behind. A wrong predicate returns nothing, and nothing is
what "healthy" looks like — the field name was verified against the live payload
before the check was trusted.

## Open / deliberately not closed

- ~~**The approval gate on both routing chains still does not GATE.**~~
  **CLOSED in this ADR — see the D1 correction note.** This entry deferred the
  fix on two premises, and **both were false**:

  1. *"#3344 is establishing the corpus-wide cure."* #3344 **MERGED** at
     2026-08-18T14:40:46Z (`cdae6af27`) and is an ancestor of this branch.
     `csm-ops.renewal-risk@1.1.0` is the working example. This pack was a
     CONSUMER of a landed fix, not a chain waiting on one.
  2. *"It cannot be half-fixed here: conditioning only the gate edge leaves the
     sibling content edge completed on reject."* A false dilemma — the cure
     **removes** the sibling content edge, re-parenting it onto the gate. There
     is no sibling left to be completed.

  The cost of not checking either premise was not neutral. Deferring here while
  shipping the *content* edge converted a hole that leaked NOTHING (unbound
  `text: undefined`) into one that leaks the full answer on five of six
  decisions. A deferral that ARMS the thing it defers is not a deferral.

- **`WF-CSM-1` remains open as a CORPUS-WIDE finding** — this ADR fixes the two
  `knowledge.*` chains and claims nothing beyond them. The class spans ~30 packs
  and needs the structural check (`WF-KB-6`'s sibling: every `role:action` node
  downstream of an `approvalGate` must have no unconditional incoming edge),
  report-only first per ADR 0504's measured lesson.

- **The fixed pack is SHADOWED by a stale registry install — operators must
  republish + reinstall.** `defaultWorkflowChainPackRoots()`
  (`host/workflowChainPackLoader.ts:376-383`) is **first-root-wins**: operator
  override → `~/.openwop-packs` (registry installs) → `examples/`. MEASURED
  2026-08-18: `packs.openwop.dev` publishes
  `core.openwop.workflows.knowledge@1.0.4` and the local install dir holds
  **1.0.0**, both with every delivery edge bare. So merging this PR does **not**
  reach `npm run dev`, `scripts/e2e-routes.sh`, or any self-hosted install —
  they keep expanding the broken chains. Backend vitest cannot see it (per-worker
  `isolatePackDir` points at an empty temp dir), which is exactly why the new
  tests are green while a dev boot still runs the bug.

  Two actions, neither of which this repo can perform on its own:
  1. **Publish `core.openwop.workflows.knowledge@1.2.0`** via an
     `openwop/openwop-registry` PR (`docs/trusted-pack-publishing.md`), then
     re-install so `~/.openwop-packs` stops shadowing `examples/`.
  2. Until then, boot with
     `OPENWOP_WORKFLOW_CHAIN_PACKS_DIR=<repo>/examples/workflow-chain-packs`
     (the first, highest-precedence root) to run the fixed chains locally.

  `scripts/check-registry-parity.sh` now makes this **visible instead of
  silent**: it compares VERSIONS, not just names, and reports
  `STALE ON REGISTRY` when the published copy is behind the repo's. Its first
  run found **10** such packs — including `core.openwop.workflows.csm-ops`
  (registry 1.0.0 vs repo 1.1.0), i.e. **#3344's own fix is shadowed the same
  way**. Name-parity alone could not see any of them. (LIVE lane —
  `OPENWOP_CI_LIVE=1` / `npm run ci:full` — it needs the network.)
- `WF-KB-1` / `WF-KB-2` — the boot-path in-tree `WorkflowDefinition` in
  `features/agent-knowledge/feature.ts:38` and the ratchet that structurally
  cannot see it. Both are M-effort and independent of this batch.
- `WF-KB-3` / `WF-KB-8` / `WF-KB-10` — `runKnowledgeSyncOnce` has no workflow
  identity and the reindex driver lives in the browser. Both are blocked on the
  KB surface being read-only (`WF-KB-10`), which is the prerequisite work.
- `WF-KB-6` — the corpus-wide "required input port is bound" check. This batch
  ships it **scoped to the knowledge pack**; the repo-wide version must be
  report-only first (ADR 0504's measured lesson: a correct gate would have
  blocked 114/169 chains).
- The built-but-unreachable lane: `ragQuery`, `bindCollection`, `ingestMedia`,
  the search `mode` preview, the Cohere `rerank` setter, `drain`'s `maxChunks`.
- `KB-UX-5` (`contentTrust` dropped at the `/kb` client type), `KB-UX-6`
  (`embedding.mode` / `rerank.applied` discarded while the chip still says
  "cosine score"), `KB-UX-7` (no server-side ingestion state), `KB-UX-13` (hits
  link nowhere despite carrying `documentId`).
- `KB-12` (prune reports success on a failed delete), `KB-6` (the embed budget
  guards only the admin reindex lane), `KB-13`, `KB-5` (org-blind `kb:veccache` /
  `kb:docrev` prefixes), `KB-14`.

## Correction 2026-09-18 — the STALE shape this ADR added was reading the frozen tree

The `STALE ON REGISTRY` half of `scripts/check-registry-parity.sh` (added here,
2026-08-18) compared the repo against `${REGISTRY_URL}/v1/index.json`. After
**ADR 0663** moved the host's installer onto `.well-known` endpoint resolution,
`/v1` became the FROZEN tree and the host stopped installing from it — so the
rationale printed with every finding ("the published copy SHADOWS this repo's fix
for every non-vitest boot") stopped being true for the rows it named.

Measured on the live registry: 49 findings against `/v1` versus 35 against `/v2`
— **14 were fiction**. The check now resolves the tree through the same discovery
document the installer uses. Full detail in **ADR 0663 § Addendum 2026-09-18**.

The STALE *shape* was right and is retained; only its source was wrong.

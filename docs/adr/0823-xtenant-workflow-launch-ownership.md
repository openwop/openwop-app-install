# ADR 0823 — A run executes only a workflow its tenant may read: one ownership predicate at the launch funnel

Status: Accepted (implementation on `fix/xtenant-run-start`)

- **Found by:** feature loop 2026-10 row 16 (workflow-author), proved on
  `ce2abbde3` with a real-HTTP witness. Carried as a separate security fix.
- **Composes:** ADR 0163 (the ownership index), ADR 0440 P4 (`isForeignOwned`, the
  M7 read guard), ADR 0474 P1b (`resolveLaunchWorkflow`, the published pin),
  ADR 0789 (`isSharedWorkflowId`), ADR 0794 (derivable `wf.sub.*` / `wf.cadence.*`
  ids), row 16's derivable-id pre-squat fix in the author lanes (in flight, `fl2-16`).
- **Toggle:** none. This is an authorization fix on an always-on core surface.
- **RFC verdict:** host-only. Run-create, `:fork` and resume already answer an
  unresolvable `workflowId` with `404 workflow_not_found` (v1 and v2 share the
  handler); this decision makes a foreign-owned id resolve the same way. No new
  error code, field, event or capability.

## Context

The workflow REGISTRY is a global by-id store (ADR 0163): its job is to resolve
any id on any instance. The ownership index is the authz layer over it, and the
READ guard (`GET /v1/workflows/{id}` → `isForeignOwned`) answers a workflow owned
by another tenant with an indistinguishable 404.

Nothing applied that guard to EXECUTION. `hostSuite.workflowCatalog.getWorkflow`
is untenanted and `resolveLaunchWorkflow` used the tenant only to look up the
published pin. So:

- `POST /v1/runs {workflowId: <B's id>}` from tenant A returned **201** and ran
  B's definition **inside A's tenant**: A's BYOK keys, A's connections, A's run
  history, B's prompts and node config. It also disclosed B's definition through
  the run's events and outputs, which defeats the read guard outright.
- A's own workflow with `core.subWorkflow {config.workflowId: <B's id>}` ran B's
  definition as the child, through the same resolver.

Practical exposure: blank/copy/fork ids carry 64 random bits, but `wf.sub.*` and
`wf.cadence.*` ids are DERIVABLE from the victim's tenant id (ADR 0794). Prod held
one such derivable id (single-owned) and showed no exploitation.

### Launch-site enumeration (`aa8e6160a`)

Every site that turns a workflow id into an executing definition, grepped from
`resolveLaunchWorkflow`, `workflowCatalog.getWorkflow`, `resolveRunDefinition`,
`startWorkflowRun` and `insertRunWithStartContext`:

**Through `resolveLaunchWorkflow` (fixed by D2, no per-site change):**

| Site | Launcher |
|---|---|
| `routes/runs.ts` run-create | `POST /v1/runs` and the v2 equivalent (one handler) |
| `host/runStarter.ts` `startWorkflowRun` | schedules (`scheduleDaemon`), heartbeat, agents (`routes/agents.ts`), host events (`hostEventDispatcher`, `routes/hostEvents.ts`), kanban (`kanbanService`, `kanbanWorkItemDaemon/Delivery`), A2A, approvals (`approvalDecision`, `approvalService`), inbound webhooks (`connections/inboundWebhooks`), channel turns, conversation exchange, agent mentions, compose tool, every feature agent tool (~45 callers) |
| `executor/subWorkflowDispatcher.ts` | `core.subWorkflow` children |
| `host/kanbanTriggerDelivery.ts` | kanban triggers |
| `host/triggerIngestionService.ts` | external trigger ingest |
| `routes/triggerBridge.ts` fire | trigger bridge |
| `host/mcpCaller.ts` / `host/mcpSemantics.ts` | MCP `tools/call` |
| `features/crm/routes.ts` | CRM launch |
| `features/connections/routes.ts` | runnable probe |
| `routes/durabilitySeam.ts` | test seam |

**Through `resolveRunDefinition` (D3 — as corrected, only `:fork` and redrive re-check):** `:fork` (`routes/runs.ts`),
resume (`routes/runs.ts`), redrive (`routes/workflowDebug.ts`), interrupt resume
(`routes/interrupts.ts` ×2), the dispatch sweeper (`host/runDispatchSweeper.ts` ×2).

**Direct `workflowCatalog.getWorkflow` with a caller-chosen id (fixed by D4):**

| Site | Before | After |
|---|---|---|
| `host/canvasSurface.ts` cross-canvas invoke (wired in `index.ts`) | untenanted lookup, executes | `resolveTenantWorkflow(tenantId, …)` |
| `index.ts` compensation definition resolver | child's definition by id | `resolveTenantWorkflow(child.tenantId, …)` |
| `routes/hostEvents.ts` binding create | existence check (oracle + a binding that can never fire) | tenant-aware, same 422 |
| `routes/triggerBridge.ts` subscription create | existence check | tenant-aware, same 404 |
| `host/approvalDecision.ts` proposal approve | existence pre-check (start refuses anyway) | tenant-aware, same 422 |
| `host/hostEventDispatcher.ts` lineage check | narrows only; `startRun` re-resolves | tenant-aware for honesty |
| `features/voice/realtime/routes.ts` work-snapshot name | name oracle | tenant-aware |

**Direct lookups that stay direct (fixed host ids or already guarded):**
`routes/workflows.ts` GET (it IS the read guard), `features/workflow-author/routes.ts`
(`WORKFLOW_AUTHOR_META_ID`), `features/creative-briefs/routes.ts`
(`CREATIVE_BRIEFS_REEL_ID`), `features/kicktodo-creator/agentTools.ts`
(`CHALLENGE_FACTORY_WORKFLOW_ID`), `features/kicktodo-creator/routes.ts` (already
calls `isForeignOwned` first), `host/workflowComposeTool.ts` (an id-collision check
on a composed draft — row 16's author lane owns it).

Not launchers: `host/workflowEvalRunner.ts` (its only caller passes the owner-gated
`loadOwnedHead` definition), `host/workforceService.ts` (seeds historical records
for host-defined workforces; executes nothing), the conformance seams that mint
their own definitions (`artifactTypeSeam`, `compensationSeam`, `effectSeamFireSeam`).

## Decision

**D1 — one predicate.** `isWorkflowForeignTo(tenantId, workflowId)` in
`host/workflowOwnership.ts`:

1. a shared id (`isSharedWorkflowId`, ADR 0789) is never foreign;
2. an id the tenant owns (`getOwned` point lookup) is never foreign;
3. otherwise it is foreign iff another tenant owns it (`isAuthoredByOtherTenant`).

An UNOWNED id (host system workflows, the hard-coded catalog source A, unowned
chain-backed host defs, conformance fixtures) is not foreign: it stays runnable by
every tenant, exactly as it stays readable. The read guard `isForeignOwned`
(`routes/workflows.ts`) becomes `wildcard ⇒ false; PUBLIC ⇒ false; else
isWorkflowForeignTo`, so read and run cannot drift. Because SHARED ⊇ PUBLIC, the
only read change is that the two seeded walkthrough ids become readable by an
unseeded tenant. They are one shared demo definition with no tenant content, so
this is the honest posture, not a widening.

**D2 — enforced inside the funnel, not per site.** `resolveLaunchWorkflow` asks D1
after the catalog lookup and returns `null` for a foreign id. Every caller already
maps `null` to its own not-found (`404 workflow_not_found` at run-create,
`subworkflow_child_not_found`, the starter's `null`), so the refusal is
indistinguishable from an unknown id. A new `resolveTenantWorkflow(catalog,
tenantId, workflowId)` is the same lookup + D1 without the published pin, for the
direct sites in D4 whose semantics are head-only.

**D3 — re-execution of an existing run** *(narrowed to `:fork` + redrive — see the correction under D6)*. `resolveRunDefinition(run, catalog)`
applies D1 with `run.tenantId` before EITHER branch (pinned revision or head). A
run minted through the hole before this fix (or by any future lane that skips the
funnel) cannot be forked, resumed, redriven or re-dispatched into executing a
foreign definition. The refusal surfaces as each caller's existing not-found.

**D4 — the direct sites** in the table above move to `resolveTenantWorkflow`.

**D5 — fail closed by THROWING, except in a test process with no store.** If
the ownership store throws, D1 logs `workflow_ownership_check_failed` and
RETHROWS, so each caller takes its error path (500, retry). It does not answer
"foreign". That answer would be read as not-found, and some callers act on
not-found permanently: interrupt reject emits a terminal failure, and the dispatch
sweeper dead-letters with "workflow not found". A database blip must not kill a run.
If host-ext persistence was never initialised AND the process is a test
(`VITEST` / `NODE_ENV=test`: executor-arm unit tests), no rows exist, so D1
answers `false`. Outside tests an unbound store throws like every other host-ext
read, so a future entry point that runs before `initHostExtPersistence` cannot
silently disable the check. This splits the ADR 0474 F4 posture correctly: the PIN
degrades to head on error because it is a launch semantic, and OWNERSHIP refuses
because it is authz.

**D5a — no oracle, but a server-side signal.** `resolveTenantWorkflow` asks D1
BEFORE the catalog lookup, so a foreign id and an unknown one pay the same reads.
A refusal logs `workflow_launch_refused_foreign {tenantId, workflowId}` at warn,
since probing for the derivable `wf.sub.*` / `wf.cadence.*` ids would otherwise be
invisible. The response is unchanged.

**D6 — no wildcard exemption at launch.** ~~The read guard lets a `*` operator
read any tenant's definition. A launch is different: it executes under the
request's tenant with that tenant's secrets, so an operator running B's definition
"as A" is the same cross-tenant execution. The resolver takes no principal and
grants none.~~

> **CORRECTED 2026-10-05 (the gate, before merge) — D6 is reversed: a wildcard
> operator IS exempt at the HTTP launch and relaunch sites.** The first gate went
> red in 13 files / 50 tests, and every one was the same shape. A `Bearer
> dev-token` (`tenants:['*']`) registers a workflow, which records ownership under
> its home tenant, then runs it with `body.tenantId: '_anon'`. The original
> argument was wrong because the premise was wrong: a `*` principal already
> passes `principalAuthorizer` for EVERY tenant, so it could run B's workflow as
> B. Refusing it "as A" grants nothing and protects nothing; it only breaks
> operator tooling and the test harness, and it would have broken any conformance
> driver built the same way.
>
> Now `resolveTenantWorkflow` / `resolveLaunchWorkflow` take `{ operator }`, and
> `resolveRunDefinition` takes `{ relaunch: { operator } }`. Only the three HTTP
> sites that hold the principal set them: run-create, `:fork` and redrive. Every
> internal launcher (the starter, subWorkflow, triggers, MCP, canvas) passes
> nothing, so it is tenant-checked.

> **Who can carry `*` (verified from code, 2026-10-05).** The D6 exemption is
> exactly as wide as the set of wildcard principals:
>
> - **`OPENWOP_API_KEYS` entries written `<key>:*`.** This is the only lane that
>   assigns `tenants: ['*']` (`middleware/auth.ts` API-key branch, through
>   `readKeyTenants`). A bare `<key>` gets `['default']`, and `<key>:t` gets
>   `['t']` (ADR 0561).
> - **`dev-token`.** It applies only when NO keys are configured and auth is not
>   enforced (`middleware/apiKeyTenants.ts:71`). Prod sets `OPENWOP_API_KEYS`, so
>   prod has no dev-token.
> - **Sessions (cookie and anon) and OIDC bearers can never carry it.** They take
>   `tenants: [active]`, and `active` is the personal tenant or a workspace the
>   subject is a MEMBER of, re-validated on every request (`auth.ts` session and
>   OIDC branches).
> - **`owk_` self-service keys never resolve to `*`.** They resolve to
>   `[key.tenantId]`. A key is minted for `req.tenantId ?? 'default'`; a wildcard
>   key leaves `req.tenantId` unset, so even an operator mints `default`. This PR
>   adds two guards: `issueApiKey` refuses `'*'`, and `verifyApiKey` never
>   authenticates a stored `'*'` row. Both are pinned by
>   `test/adr0823-owk-key-never-wildcard.test.ts`, and each was sabotage-proved.
> - **Not a principal source:** `hostSuite.identityResolver.resolveFromBearer`
>   (`host/index.ts`) returns `['*']` for any token but has NO caller.
>
> A run launched by an operator under the exemption executes in the tenant the
> request names (`body.tenantId`), with THAT tenant's secrets. That is the same
> authority the operator already holds for every other tenant-scoped verb.

> **CORRECTED 2026-10-05 — D3 is narrowed to RELAUNCH.** It applies to the lanes
> that MINT a new run from an existing one (`:fork`, redrive). It no longer
> applies to CONTINUATIONS of the same run (resume, interrupt resume, the
> dispatch sweeper), for two reasons:
>
> - A continuation was authorized when its run was created.
> - A continuation carries no principal, so an operator-created cross-tenant run
>   would be stranded mid-flight by the sweeper. `executor-durability-adr0326`
>   showed exactly that.
>
> The accepted residual: a run minted through the hole BEFORE this fix can still
> finish executing. It cannot be forked or redriven. Prod showed no such run.

**D7 — ratchet.** `test/adr0823-launch-ownership-ratchet.test.ts` pins three
inventories over `src/**` (comments stripped). Each entry holds a per-file call
COUNT and the reason the call is safe:

1. direct `catalog.getWorkflow(` / `?.getWorkflow(` reads outside the funnel;
2. run-minting calls (`insertRunWithStartContext(` / `.insertRun(`);
3. `executeRun(` calls, which also covers re-executing an existing run (resume,
   sweeper).

A new call, including a second one in an already-listed file, fails the test until
it goes through the funnel or is classified here. "Fixed host id" entries must pass
an UPPER_CASE constant. A separate block asserts that the funnel,
`resolveRunDefinition` and the read guard all call the one predicate.

## Alternatives weighed

- **Per-site `isForeignOwned` calls** at runs/subWorkflow/schedules/…: the
  enumeration above has ~60 transitive callers; one missed site is the hole again.
  Rejected for the funnel.
- **Tenant-scope the catalog itself** (`getWorkflow(tenantId, id)`): the catalog
  is the SDK `HostAdapterSuite.workflowCatalog` contract, consumed untenanted by
  the conformance surface; changing its signature is a much larger, wire-adjacent
  change. The funnel is host-internal.
- **Refuse UNOWNED ids too** (only owned or shared runs): breaks every host
  system workflow (channels, heartbeat, agents) and the conformance fixtures.
- **403 instead of 404:** confirms existence — the oracle M7 removed.

## Trade-offs

- A non-owned, non-shared launch now pays one `ownersOf` read: `kvListContaining`
  on the `workflow:ownership` prefix (a SQL `LIKE`, the same read the M7 guard pays
  on every un-owned GET since EVID-1). Owned launches stop at the `getOwned` point
  lookup and `openwop-app.*` host ids at D1.1, so the extra read lands on host
  system ids outside that namespace (chain-backed `feature.*`, heartbeat). A
  chain-backed shortcut was considered and rejected: it is a second exemption in an
  authz predicate to save one indexed-prefix read.
- A run legitimately created in tenant A for a workflow later owned ONLY by B
  (ownership moved) becomes non-resumable. The lanes that rekey tenants (the
  anon→account fold, `migrate-tenant`) are the ones to watch; if one ever moved the
  ownership row without the runs, D3 fails CLOSED (a not-found on resume), never
  open. Not verified per lane here — it is a liveness risk, not a leak.

## Residual (out of scope, recorded)

Two READ paths resolve a run's definition by `run.workflowId` without the
predicate: `host/runDiagnoseTool.ts:82` and `host/reviewProjection.ts:481`. Both
start from a run or approval the caller already owns, so after D2/D3 no new run
can carry a foreign id into them; only a run minted through the hole BEFORE this
fix could, and prod showed none. Not changed here, to keep the diff on the launch
funnel.

Also residual, from the grade pass:

- `host/workflowComposeTool.ts:195` answers "already exists" for any registered
  id, a foreign one included. This is inherent to the global keyspace (an id
  collision must refuse), and it is row 16's author lane.
- `host/chainBackedWorkflows.ts:207`: the `hostOwned.ownerTenant` option records
  ownership of a HOST chain-backed workflow for one tenant. It has no callers. If
  one is ever added, that host workflow becomes foreign (unrunnable) to every
  other tenant under D1. Do not use it without revisiting D1.1.

## Architect pass (pre-code, 2026-10-05)

Adversarial review of this ADR before implementation. Outcome:

- **Missed launch sites:** re-swept every `executeRun(` caller (18 files) and every
  `insertRunWithStartContext` caller (23 files); all resolve through the funnel,
  `resolveRunDefinition`, a D4 site, a fixed host id, or an owner-gated head. The
  client cannot pin a foreign revision: `definitionRevision` is a reserved
  metadata key stripped at run-create (`host/runDispatch.ts:66`).
- **D5:** kept. `__hostExtStorage() === null` is the one state in which "no rows"
  is a fact rather than an error.
- **D6:** kept, with the conformance lane as the witness. Conformance fixtures
  are host-registered and unowned, so they stay runnable; a scenario that runs a
  definition registered by a DIFFERENT tenant would go red and must be read, not
  waived.
- **D3:** kept. It refuses re-execution only, through each caller's existing
  not-found.
- **Read change for walkthrough ids:** accepted (D1).
- **Perf:** corrected the Trade-offs line (it is a `LIKE` prefix read, not an
  index), and rejected the chain-backed shortcut.

## Grade pass (2026-10-05, independent grader)

The grader found no Blockers and graded the fix B+. Improvements taken:

- (1) A store error answered "foreign", so a DB blip read as a permanent not-found
  on resume, interrupt and sweeper paths. D5 now rethrows.
- (2) The ratchet was file-level and saw one call shape. It now pins per-file
  counts, matches `?.`, and adds the `executeRun(` inventory.
- (3) Refusals were silent. D5a now logs them.
- (4) D5's no-store branch was a module-global fail-open. It is now test-only.
- (5) The predicate had no unit test. Added
  `test/adr0823-workflow-foreign-predicate.test.ts`: throw ⇒ propagates,
  dual-owned, shared, and no-store.
- (6) The subWorkflow witness could pass for the wrong reason. It now asserts the
  `node.failed` message and includes an own-child positive control.

Nice-to-haves taken: the timing oracle (D5a), and the residuals recorded above.
Not taken: threading the `getOwned` record through to the published pin. It saves
one point lookup per owned launch and would couple D1 to the pin.

## Implementation plan

| Phase | Content |
|---|---|
| P0 | RED real-HTTP witness on `origin/main`: run-create, subWorkflow, `:fork`, host-event bind, trigger bind, `startWorkflowRun`, canvas invoke; positive controls (own, shared seeded, host) |
| P1 | D1 + D2 + D3 + D4 + D5 |
| P2 | D7 ratchet; sabotage-prove witness + ratchet |
| P3 | grade-code pass; gate |

| Phase | Commit | Evidence |
|---|---|---|
| reservation | `5be346f35` | — |
| P0 (RED) | witness run on `origin/main` `aa8e6160a` | 7 refusals red (201s / a child of A's workflow), 4 controls green |
| P1+P2 | `f6fb04f56` | witness 11/11, ratchet green; 4 sabotages each reddened the witness or the ratchet |
| P3 | `3351dd996` (grade pass) | predicate unit test 5/5; ratchet 5/5; witness 11/11 |
| gate 1 | at `fb36b61ac`: RED, 13 files / 50 tests (all the `*`-operator shape) | → D6 reversed, D3 narrowed (`5d3aaa65a`); operator control `ec36ddf91` |
| D6 precondition | `8fb487aae` | `owk_` can never be `*`: 2/2, each guard sabotage-proved |
| watch-item | shared-fork witness | a tenant's ADR 0789 fork runs as OWNED (route + starter), and is foreign to others |

## Open questions

- [ ] Should a `*` operator get an explicit "run as owner" lane? (D6 says no
      until someone needs it.)
- [x] v1/v2 refusal code — `404 workflow_not_found`, already emitted for an
      unknown id by the shared run-create handler.

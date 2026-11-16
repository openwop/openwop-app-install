# ADR 1132 — A client's workflow definitions are read by that client's people

Status: Accepted (2026-11-15). Design reviewed by the release manager (openwop-app-14) before build.

Issue: #5969 (HIGH), reported by DeckTalk and confirmed on main `bff8b2dfd`. This ADR is the
sibling of [ADR 1121](1121-run-client-org-read-scope.md).

## Context

An instantiated chain freezes its params into the stored definition (RFC 0013 Path A). So a
definition can hold one client's own content: for DeckTalk, a script's full source text.
`GET /host/openwop-app/workflows` listed every owned definition in the tenant, and
`GET /workflows/:id` refused only other tenants. A member of client A could therefore list
and read client B's definitions, frozen params included.

Nothing on a definition named its client. The ownership record (`workflow:ownership`) has
only a feature label, `subject` (ADR 0913), which can't be parsed into an org. The from-chain
route took no client.

## Decision

### D1 — Stamp the client on the definition

`WorkflowOwnershipRecord.clientOrgId`: a non-root org of the tenant. It is **sticky and
set-once**. A later save omits it and keeps it, and no path replaces it
(`recordOwnership` keeps the existing value over anything passed).

`POST …/workflows/from-chain` decides it (`resolveInstantiateClient`), in this order:

1. `x-openwop-act-as` names a member of a non-root org: that org.
2. Otherwise, a caller with no workspace-root membership. Count their client orgs where they
   hold `workspace:write`, the scope from-chain needs (read-only memberships don't count):
   - one org: that org;
   - several orgs: `400 client_required`, unless `clientOrgId` names one of them.
3. Otherwise (a root member, a tenant-level grant, a personal workspace): `clientOrgId` if
   given, else none.

An explicit `clientOrgId` gets the uniform 404 if it isn't a non-root org of this tenant, if the
caller can't write in it, or if it disagrees with a derived context. `instantiateOwnedChain`
carries the stamp to the **parent only**. Sub-chain children are shared across instantiations
(their id keys on the chain version), so one client's stamp can't go on them.

The SPA's template dialog offers an optional **For a client** choice when the caller can see
client orgs, and sends it as `clientOrgId`.

### D2 — The rule (ADR 1121's, now one module)

`host/clientOrgGate.ts` holds the floor that ADR 1121's run reader used inline. Both runs and
definitions now call it:

- an unstamped definition is unchanged;
- the tenant-level grants (wildcard, own personal workspace, no-presence tenant, admin
  `host:members:manage`; `runPayloadAccess().all`) pass every client;
- anyone else needs the site's scope **in** the client org, checked live:
  - `workspace:read` to list or read;
  - `workspace:write` to save, delete, archive, promote, roll back or join a live editing room;
  - `runs:create` to launch.

A refusal is the definition's own 404 (`workflow_not_found`), and lists drop the definition.

### D3 — Where it is applied

`host/workflowClientAccess.ts` (`workflowClientReader`, `assertWorkflowClientAccess`,
`filterClientReadableWorkflows`) is called from:

- `GET …/workflows` (the list), `GET /workflows/:id`, and `…/:id/head`, `…/revisions`, `…/estimate`;
- the `…/stats` rows and `…/availability` (another client's definition reads as unknown);
- save (`POST …/workflows`), `DELETE`, archive, unarchive, promote and rollback;
- the debug, evals and budgets routes (their shared `loadOwnedHead`);
- the workflow-collab ticket and claim-seed;
- `POST /runs` (`runs:create`).

### D4 — Runs inherit the client

`insertRunWithStartContext`, the single run-insert seam, stamps a run with
`clientRunStamp(clientOrgId)` when the run names no client yet and its owned definition carries
one. Without this, the frozen params still reach the run's snapshot and events, which are
readable tenant-wide under ADR 1121 because the run is unstamped. A fork keeps its parent's
stamp, and a campaign run keeps its own. A failed ownership read fails the insert rather than
leave the run open. The one exception is where host persistence is not initialized (bare
executor tests), as `resolveLaunchDefinition` already documents.

### D6 — Existing definitions

Definitions from before this change are unstamped, so they stay readable tenant-wide. Root admins
(`host:members:manage` at the workspace root, a superadmin, the wildcard bearer, a personal
owner) get two routes:

- `GET …/workflows/unstamped` lists them, ids and names only.
- `POST …/workflows/:id/client {clientOrgId}` stamps one **once**: `409 client_already_set`
  if it is already stamped, `404` if the org is the root or not in the tenant. It is audited on
  the security chain as `security.workflow.client-stamped {workflowId, clientOrgId, actor}`.

An org admin can't stamp, because claiming a definition for their own client would take it away
from the others.

### D5 — Model-facing lanes (P2)

An agent or an MCP client is the same leak through a different door. P2 floors each one:

- **MCP server.** `McpCaller` is built from the request, and `mcpCallerFor` gives it
  `mayLaunchOwned`, which is `workflowClientReader(req, tenant, 'runs:create')`. A client's
  workflow is neither listed as a tool (`workspaceDefinitions` resolves through it) nor
  callable (`mcpSemantics` checks it): it reads as an unknown workflow. A failed ownership read
  refuses.
- **The workflow-author and agent-author tools and surfaces, and builder-pair.** These run in a
  run or chat turn with no request. `readAuthoredWorkflow` and `listAuthoredWorkflows` take a
  `mayRead` predicate from `workflowClientReaderForScope(scope)`:
  - **the run's person.** That is the actor, else the causing member, read as a `cause`. A
    tenant admin passes every client; anyone else needs `workspace:read` in the client org
    (`assertRunOrgScope`).
  - **No person at all** (a schedule, a trigger): unstamped definitions, plus definitions for
    the run's **own** client (its ADR 1121 stamp), and nothing else. **A deliberate narrowing of
    ADR 0830**, which trusts actorless lanes tenant-wide. The content here is another client's,
    and tenant trust isn't enough for it.

  `host/workflowClientAccess.ts` is the one file that reads `orgScopeSubject`, and it has its ADR
  0832 READERS entry (narrows only).
- **Bindings are checked when created, not on each fire.** These need `runs:create` in the
  workflow's client (404 otherwise):
  - a trigger subscription (`POST /trigger-subscriptions`);
  - a kanban card's `workflowId` (create and patch);
  - a board's `triggerWorkflowId`;
  - a project schedule (create and patch).

  The runs they fire are stamped by D4, so outputs stay protected either way.
- **Existing bindings** were never checked. `GET …/workflows/client-bindings` (root admins,
  read-only) lists every trigger, kanban column or card, and schedule that launches a client's
  definition, with the binding's owner where the store records one, so an operator can review
  them.

Left as they are: `workflowComposeTool.listOwned` counts drafts for the transient cap and
discloses nothing, and `walkthroughs/surface.ts` builds an ownership id set.

## Known limits

- **A root member who forgets.** Agency staff at the root who instantiate for client A without
  choosing a client make an unstamped definition. Nothing in the request says "client A".
  Mitigations: the SPA's **For a client** choice, and the D6 unstamped list.
- **A binding outlives its owner's access.** A binding created by someone who later loses
  access to that client keeps firing. What it fires is stamped for the client (D4), so the
  remaining exposure is launch authority, not content. The admin view above is how an operator
  reviews them. Re-checking the owner at each fire would mean touching four launch lanes, and it
  is not done.
- **Subscriptions record no owner.** Their `owner` in the bindings view is `null`, not a guess.
- **Sub-chain children** are not stamped (D1). Checked, and they need no stamp:
  - **The definition is template-only.** `coRegisterSubChains`
    (`host/workflowChainPackLoader.ts`, the recursive call) expands every child with
    `params: {}`, by design. Its comment says "their values arrive at dispatch from the
    parent". A child variable's `defaultValue` can only be the pack's declared default, never a
    person's value (same file, the `asChild` branch). The test instantiates
    `funnels.blueprint.lead-magnet` with a secret in every param. The parent froze it (the
    control assertion), and no child definition contains it.
  - **Client content reaches a child only through its run**, via the parent's
    `core.subWorkflow` inputMapping. The child run inherits the parent run's client stamp
    (`inheritedRunMetadata`, org only). That inheritance used to be registered only by the
    campaign-ops feature. It is now core (`host/runInsert.ts`, the same projection), so it holds
    in a distribution without that feature.

## Alternatives considered

- **Amend ADR 1121.** Rejected: runs already carried a stamp, and definitions needed a new one,
  a new derivation and an admin backfill.
- **Parse the client out of `subject`.** Rejected: `subject` is a feature's own label, not a
  contract.
- **An X-Org request header.** It doesn't exist. The only per-request org context is
  `x-openwop-act-as` (D1 step 1).

## Implementation record

| Piece | Where | Test |
|---|---|---|
| Shared floor | `host/clientOrgGate.ts` (ADR 1121's reader now calls it) | `test/adr1121-run-client-org-read.test.ts`, unchanged |
| Stamp, set-once | `host/workflowOwnership.ts` | `test/adr1132-workflow-client-scope.test.ts` (D6, sticky across a save) |
| D1 derivation | `host/workflowClientAccess.ts` `resolveInstantiateClient`; `routes/workflows.ts` from-chain | same (act-as, mismatch, root) |
| D2/D3 readers | `host/workflowClientAccess.ts`; the routes above | same (list, by-id, head, revisions; admin and client B read) |
| D4 run stamp | `host/runInsert.ts` | same (run stamped; A gets 404 on read and launch) |
| Child runs inherit the client (core) | `host/runInsert.ts` `registerInheritedRunMetadataKey` | same (child case); the inheritance tests 55/55 |
| D6 admin routes | `routes/workflows.ts` | same (403 for a viewer, set-once 409, audit) |
| D5 MCP | `host/mcpCaller.ts`, `host/mcpSemantics.ts` | `test/adr1132-p2-model-lanes.test.ts` (tool not listed, call refused) |
| D5 author lanes | `host/workflowClientAccess.ts` `workflowClientReaderForScope`; `workflow-author`, `agent-author`, `builder-pair` | same (actor, admin, actorless with and without its client) |
| D5 binding floors and view | `routes/triggerBridge.ts`, `routes/kanban.ts`, `features/projects/routes.ts`; `GET …/workflows/client-bindings` | same (kanban card 404, the admin view lists it, 403 for a member) |
| SPA client choice | `builder/TemplatePreflightModal.tsx`, `persistence/backendStore.ts`, 4 locales | typecheck and static checks |

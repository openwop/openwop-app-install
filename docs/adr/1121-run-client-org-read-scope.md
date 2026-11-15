# ADR 1121 — A client's runs are read by that client's people

Status: Accepted

Issue: #5929 item 1 (HIGH), reported by DeckTalk at the user's request.

## Context

An agency workspace holds several client orgs. Host code stamps a run that is
for a client with one of two keys, which callers cannot set
(`CAMPAIGN_ATTRIBUTION_KEYS`): `metadata['openwop-app.campaignOps'].orgId` or
`metadata.campaignOrchestration.orgId`. `host/runClientOrg.ts` `runClientStamp`
reads them.

Agent memory and the KB and media surfaces already check that stamp against
the person behind a run (ADR 0830, 0832, 0944). The run surface did not:

- `host/runAccess.ts` `loadByScopeAndTenant` and `loadOwnedRun` checked the
  protocol scope and the tenant only;
- `GET /runs` (both contracts) listed by tenant only;
- `:diff`, `DELETE /runs/{id}`, the annotation reads and writes, and
  `:bulk-cancel` hand-rolled the same tenant check.

Protocol `runs:read` is the UNION of a subject's scopes across every org
membership in the tenant (`resolveSubjectScopesUnion`). A viewer in client A
therefore held it tenant-wide and could list and open client B's runs: their
events, inputs and source text.

## Decision

One rule, `host/runClientAccess.ts` `runClientReader`, decided once per request:

1. A run that names no client is unchanged.
2. The tenant-level grants of the #4543 payload rule read every client's runs:
   a wildcard principal, the caller's own personal workspace, a tenant where
   membership does not define presence, and a tenant admin
   (`host:members:manage`). This is `runPayloadAccess`, called rather than
   copied, so the two rules cannot drift. It matches ADR 1118, where org admins
   reach a private project without membership.
3. Anyone else needs the site's scope IN the client org (`assertOrgScope`,
   resolved live): `runs:read` for a read, `runs:cancel` for cancel and delete,
   `runs:create` for `:fork`. A member removed from the client loses its runs,
   including the ones they started. There is no run-starter arm, as in ADR 0944:
   authorization is live, never frozen.
4. A stamp that cannot be read, or two stamps naming different orgs, is
   readable only through step 2. It fails closed.

A refused run is reported as absent (`run_not_found`, 404), with the same
message as a run that does not exist, and is dropped from lists. The protocol
list's cursor follows the unfiltered page, so a short page is not the end of
the list.

The stamp and the grant are resolved lazily: a run that names no client costs
no lookup.

### Where it is applied

- `loadByScopeAndTenant` (every `loadReadableRun` caller: the snapshot, SSE,
  poll, debug bundle and artifact reads) and `loadOwnedRun` (cancel, fork,
  interrupt resolve and the token listing), at the site's scope.
- `GET /runs`, both branches, through `filterClientReadableRuns`.
- `:diff` (both runs), `DELETE`, the annotation POST and GET, and
  `:bulk-cancel`, where each refused id reads `not_found`.

### Alternatives weighed

- **`workspace:read` in the client org**, which the memory binding uses.
  Rejected for runs: the run surface's own authority is `runs:*`, and a site's
  floor should be the scope it already demands, held in the client.
- **Admitting the run's starter.** Rejected: it would freeze authorization at
  start time, and a removed member would keep a client's runs.
- **Filtering in storage.** Rejected for now: the stamp lives in JSON metadata,
  and an index for it is a migration. The page filter is correct, and its only
  cost is short pages.

## Residue (not in this ADR's diff)

Other run listers and readers still answer by tenant. Each is a candidate for
`filterClientReadableRuns` / `assertRunClientReadable` and needs its own read
of what it exposes:

- `routes/workflows.ts` (recent runs), `routes/workforces.ts`,
  `routes/agentEvals.ts`, `features/task-deck/routes.ts`,
  `features/intent-ledger/routes.ts`, `features/walkthroughs/feature.ts`;
- the `routes/interrupts.ts` by-interrupt reads that call `storage.getRun`
  directly rather than `loadOwnedRun`.

Items 2 (org list disclosure) and 3 (non-expiring media URLs) of #5929 are
owned separately.

> **RESOLVED 2026-11-14 (residue PR).** Each site was read for what it
> discloses:
>
> | Site | Discloses | Decision |
> |---|---|---|
> | `routes/workforces.ts` `dashboardRuns` (metrics, governance, trace, shadow) | the trace search returns run ids, correlation ids, outcomes | **Filtered.** Aggregates are computed over the runs the caller may read. The PATCH cutover gate still reads every run, because it decides and does not disclose. |
> | `routes/agentEvals.ts` promote (`fromRunId`) | copies the run's captured tool calls into a fixture | **Gated**: a refused run is `missing_run` (404). |
> | `routes/agentEvals.ts` history and `…/runs/:runId/progress` | eval scores and judge detail | **Filtered / gated**, the same rule. |
> | `routes/workflows.ts` node-disclosure scan and promote gate | existence only ("has a completed run", node ids of the caller's own workflow) | No change: a decision, not a read of client content. |
> | `features/walkthroughs/feature.ts` funnel | counts by status and node | No change: aggregates only. |
> | `features/intent-ledger/routes.ts` reckoning | tool names and statuses for runs stamped with a conversation the caller already passed `requireVisible` on | No change: gated on the conversation. |
> | `features/task-deck/routes.ts` | the caller's own runs and their descendants; `wholeTenant` only in the caller's own personal workspace (the ADR's personal grant) | No change: ownership-scoped. |
> | `routes/interrupts.ts` | the run-scoped routes already go through `loadOwnedRun`, so the ADR's floor applies. The `getRun` calls are the token lanes (`/interrupts/:token`, `interrupt-action`), where the capability token is the authority (RFC 0093), and internal helpers. | No change. |

## Implementation record

| Piece | Where | Test |
|---|---|---|
| The rule | `host/runClientAccess.ts` | `test/adr1121-run-client-org-read.test.ts` |
| By-id gates | `host/runAccess.ts` | same: snapshot and poll, both contracts |
| List and hand-rolled sites | `routes/runs.ts` | same: list, `:diff`, `DELETE` |
| Residue: workforce dashboards | `routes/workforces.ts` | same: the trace-search case |
| Residue: agent evals | `routes/agentEvals.ts` | same: the eval-progress case (a stub eval run stamped for each client) |

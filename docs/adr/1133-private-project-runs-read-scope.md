# ADR 1133 — A private project's runs are read by its people

Status: Accepted

Issue: #5970 (security), reported by DeckTalk. Amends the scope of ADR 1118.

## Context

ADR 1118 made a private project admit its people-members and its org's admins.
The document lane asks that question through the subject seam
(`canReadDocument` → `resolveSubjectAccess`), per ADR 0610 D3′. Runs were never
in ADR 1118's list ("visibility is a read-time filter and is never stamped on a
run"). Two doors therefore served a private project's run content to an org
viewer who is not a member:

- the run reads: `GET /runs/:id`, the event stream and poll, the debug bundle,
  and `GET /runs`. `loadReadableRun` → `assertRunClientReadable` (ADR 1121)
  checks the client org only;
- the artifact library's `run-event:*` lane: `resolveRunArtifact` and the
  `listArtifacts` run filter check org `workspace:read` and the ADR 0996 chat
  gate only.

DeckTalk's probe: a non-member org viewer listed `run-event:<runId>:delivery`
and read its revision (rendered scene HTML, captions, title).

A run carries no `ownerSubject`. Its project is derived from host-written
attribution, and that derivation lived in two partial copies:
`team-intent-ledger/runStamp.ts` `boundProjectId` (board, schedule, then the
ADR 0852 resolvers) and `structured-handoffs/handoffCards.ts` (resolvers, then
board; no schedule branch).

## Decision

**D1. One derivation.** `host/runProjectBinding.ts` `runProject(tenantId,
metadata)` answers which project a run is working on: a card on a project board
(`metadata.kanban.boardId` → the board's `ownerSubject`, same tenant), a
project-fired schedule (`metadata.schedule.ownerScope = 'project:<id>'`), then
the registered feature resolvers. The ledger and the handoff cards call it.

**D2. One reader for both doors.** `host/runProjectAccess.ts`
`runProjectReader(tenantId, subject)` returns a per-request predicate over a
run's metadata. A run with no project, or whose project is not private, is
unchanged (the client-org gate stands). A run of a private project needs read on
`{kind:'project'}` through `resolveSubjectAccess`, the same seam and rule as
`canReadDocument`: its members and its org's admins. The projects feature
registers a probe (`registerPrivateProjectProbe`) that lists the tenant's private
project ids once per request. A probe that throws, or is unregistered, fails
closed to the full check.

- `runClientReader` (ADR 1121) composes it after the client check and behind the
  same #4543 tenant-wide grants (wildcard principal, own personal workspace,
  no-presence tenant, tenant admin). So every run read, list and mutation that
  goes through `assertRunClientReadable` / `filterClientReadableRuns` follows.
- The artifact lane asks it for the row's run (`resolveRunArtifact`, so the GET,
  the revisions, the diff and `listArtifactsForRun`) and in the Library list.

Refusal is the uniform `run_not_found` / artifact 404, and lists drop the item.

**D3. Read-time only.** Nothing is stamped. A fork copies the source's metadata
verbatim, so it derives the same project. A project made private later hides its
old runs, and one made org-visible again shows them. Replay is unaffected.

## Consequences

- Only PRIVATE projects narrow a run. An org-visible project's runs stay under the
  client-org gate, which is what 14 asked for ("if the derived project isn't
  private, skip"). The first draft applied `resolveSubjectAccess` to every bound
  project (the document rule). 14 accepted that draft, but it made every bound run
  pay a project read even on tenants with no private project, so review narrowed
  it to private projects. 14 was told about the change in the PR.
- A run whose project was deleted is not private any more, so it reads as an
  unbound run. Documents differ (a deleted project's documents read as `'none'`),
  and that is deliberate: a run has no owner field to re-point, so a refusal would
  have no exit.
- `metadata.kanban` and `metadata.schedule` are not stripped from `POST /runs`
  caller metadata (runStamp's note). A caller can bind its own run to a private
  project it cannot read. That can only hide the caller's run, never expose another's.
- ADR 1121 is honoured: the artifact row's `orgId` is the run's client stamp
  (`runArtifactStore.artifactOrg`), and the run doors keep the client check first.

## Residue

- `notifications/notify.ts` `runSubjectOf` (ADR 1109 D4) still reads only the schedule
  branch, to name what an interrupt notification is about. It is a display hint, not
  a gate, and it is synchronous. Moving it onto `runProject` would make board-bound
  runs name their project in notifications, which is a product change for ADR 1109
  to make. Tracked as `PPR-1` in
  `docs/steward/workflows-assessment/2026-11-15-private-project-runs.md`.

## Cost

The tenant's private project ids come from a per-tenant cache in
`runProjectAccess.ts`: a 30 s TTL, bounded at 10 000 tenants, failures never
cached. The projects feature clears a tenant's entry in-process on a visibility
change and on a delete. In steady state the run reads (every poll, SSE reconnect,
`GET /runs`, the Library list) make no extra read on a tenant with no private
project: no project list, no run, no board.

When the tenant has private projects, board reads are memoised per board and
project answers per private project, within one request, and the Library loads
each distinct run once. The tenant-wide grants are resolved only when the project
check refuses.

**Accepted staleness.** Eviction is in-process. On another instance, for up to
30 s after a project is made private, its runs stay as readable as they were just
before the change. The other direction fails closed: a project made org-visible,
or deleted, is refused for up to 30 s. The 30 s bound comes from 14's review of the
hot paths; a durable per-tenant marker would cost a point read per request, which
is what the cache exists to avoid.

Pinned by the test's cost cases. On a tenant with only an org-visible project,
`mayRefuse()` is false and a dangling board id answers without a read. Three run
reads share one probe call, and a visibility change re-probes.

## Verification

`backend/typescript/test/adr1133-run-private-project-read.test.ts`, over HTTP:

- run doors: a member gets 200 on the run and its poll and sees it listed; a
  non-member gets the absent 404 (same body as an unknown run) and no list entry;
  an unbound run is unchanged;
- artifact lane: a member gets 200 on the GET and the revision and sees it in the
  Library; a non-member gets 404 on the GET, revision and revisions, the same as
  an unknown artifact, and no Library entry;
- a card run on the project's board is bound the same way;
- a fork of a bound run is refused to a non-member on the run and its events;
- cost: a tenant with no private project refuses nothing and reads nothing;
- cost: three consecutive run reads make one probe call, and a visibility change
  clears the cache in-process;
- a failing probe fails closed: `mayRefuse()` is true, and the non-member still gets
  404 on the run and the artifact and no Library entry, while a member reads;
- an empty `project:` scope binds nothing, even with the probe unknown.

Results, 2026-11-15, `d3/run-artifact-project-scope`, one worker:

- the new test: 8/8;
- the targeted neighbours, 16 more files: adr1121, projects-route, adr0829
  (handoffs), adr0831 (ledger stamp, ledger, handoff source), adr0852
  (campaign project), adr0854 (handoff cards), artifacts-by-run, artifacts-route,
  run-artifacts (+ art3-art4, hardening), adr0957. All green except
  `ce62-f1-chat-artifact-privacy` (2 cases), which fails identically on
  `origin/main`'s source: `node_unavailable` for a pack node the local pack dir
  lacks. Not this change;
- sabotage: `mayReadProject` forced to `true` turned all four access cases red
  (run doors, artifact lane, kanban binding, fork). Only the cost case stayed
  green, as it should, since it doesn't touch that branch. Restored.
  Two more, each red alone and restored: the probe failure answered as "no
  private projects" (the probe case went red), and a bare `project:` binding the
  empty id (the empty-scope case went red).

## Implementation record

| Phase | Commit | Tests |
|---|---|---|
| D1–D3 | `d3/run-artifact-project-scope` | `adr1133-run-private-project-read` 8/8, three sabotages each red |

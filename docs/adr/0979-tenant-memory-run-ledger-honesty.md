# ADR 0979 — Tenant memory: one run-payload rule, no fabricated summaries, and a run lane that asks who is reading

Status: implemented (merged #5234 `70ecf4ff1`, 2026-10-26; Accepted 2026-10-25 after the adversarial `/architect` pass: 0 Blockers, 4 High + 4 Medium folded into D1–D4)

Feature loop round 2, row 56 (Per-agent knowledge & memory: `agent-knowledge`, `core:memory`).
Amends ADR 0195 (durable memory, DUR-2), ADR 0587 §5 (AGMEM-1, `assertMemoryRefAccess`) and
ADR 0664 (AGKM-10, recorded there and not fixed). It is host-only: no wire change, no new
RFC, and no change to what is advertised.

## Context

The round-1 grade was A− / A− / A−. That pass graded the agent-knowledge curation doors,
which it hardened (ADR 0664), and the subject-memory seam. It did not grade the other half
of `core:memory`: the tenant memory ledger (`memoryRef = 'tenant-memory'`, `MEMORY_DEMO_REF`).
The executor writes a run summary into that ledger on every completed run
(`executor.ts`, the RFC 0004 "session-end write"). The `/memory` inspector, the run page's
memory panel and `openwop memory` all read it.

Re-measured on `dfafc439b`, all three probes are red (`test/row56-baseline-probe.test.ts`):

1. **`AKM2-1` — a Viewer reads every member's run output.** Each summary embeds a
   280-character preview of the run's output. `assertMemoryRefAccess` lets
   `tenant-memory` through with no scope check at all ("anything else — only the tenant's
   own demo namespace"). Issue #4543 (`host/runPayloadAccess.ts`) withholds a run's
   payload from a member who neither started it nor administers the workspace. That rule
   reached the run list, the snapshot, the poll, SSE and the debug bundle, but not this
   second copy of the output.
2. **`AKM2-2` — a Viewer deletes any entry, and an Editor deletes another member's.**
   `DELETE /memory/:id` on `tenant-memory` checks nothing. "Mode `write`" only matters for
   the `agent:` arm.
3. **`AKM2-3` — fabricated output is stored as memory.** The Work-Twin `tmpl.*` portfolios
   (ADR 0775, ADR 0939) run `local.sample.demo.mock-ai`, which returns canned
   `Mock response to: …` text. The run completes, and the executor writes that text into
   the ledger as the run's summary.
   - Prod, read-only, 2026-10-25T22:28Z: 5,782 tenant-memory rows in 11 tenants. 2,237 of
     them (39%) are mock output: 2,189 from `tmpl.*` runs and 48 from mock conformance
     fixtures. 104 were written in the last two days.
   - The ledger is capped at 2,000 rows per scope, oldest first, and one scope is at the
     cap. Mock rows therefore **evict real run history**.
4. **`AKM2-4` (AGKM-10, open since ADR 0664) — the retrieve node reads as nobody.**
   `ctx.features['agent-knowledge'].retrieve` calls `retrieveForAgent` with no caller, so a
   workflow author can name any roster agent and read its bound corpora, project-bound
   ones included, into a run output. The HTTP preview re-resolves the reader, and so does
   the agent runner node on the same run lane (`agentRunnerNode.ts`, `ctx.actingUserId ?
   { subject } : undefined`). The retrieve node is the only reader that does not.
5. **`AKM2-5` — the inspector describes a different product.** It says "Reads and deletes
   are scoped to your credential server-side", which is true of the tenant and false of
   the member. It calls itself a memory ledger written "host-internally". It never says
   the one thing a reader most needs: **no agent reads this list.**
   - Measured: every model-facing memory read (dispatch recall, chat composition, the agent
     runner and heartbeat, `chat.turn`, the retrieve node, twins) goes through
     `resolveAgentMemory`. That resolver can only produce `agent:` / `user:` / `org:` or
     sentinel scopes. `tenant-memory` reaches people, never models.
   - The nav hint "Tenant-attributed memory writes" is jargon.

Measured and NOT defects:
- Client scoping holds (ADR 0944). A client dispatch always uses `org:<orgId>`. A refused
  binding is a sentinel, never a fallback to an agency scope.
- 0 mock rows exist in any `agent:` / `user:` / `org:` scope.
- Prod exposure of 1–2 is nil today: 0 shared (`ws:` / `host-*`) tenants hold tenant-memory
  rows. They are latent until a shared workspace runs a workflow.

## Decision

> **Revised after the adversarial `/architect` pass (2026-10-25, before code): 0 Blockers,
> 4 High, 4 Medium, 4 Low.** Two sentences in the first draft were false against the code:
> "run lookups bounded by the 500-row read cap" (H1: the filter runs before the cap, over a
> scope of up to 2,000 rows, on every run page) and "the expression `agentRunnerNode`
> already uses" (H4: its actorless arm is pre-authorised, not subject-less). The draft also
> compared one spelling of the caller (H2), and it silently dropped several kinds of run the
> caller started (H3). The decisions below are the corrected ones. The findings table is at
> the end.

### D1 — Tenant memory reads and deletes follow the ONE run-payload rule, decided from an owner stamped on the row

**The rule.** `host/runPayloadAccess.ts` gains `runPayloadAccess(req, tenantId)`, which
returns the decision itself:
- `{ all: true, grant }`, where `grant` is `wildcard`, `personal`, `no-presence` or `admin`;
- or `{ all: false, principals }`: the caller's opaque principal, in the same spelling
  `ownerStampFromRequest` stamps (`callerSubject`).

`runPayloadReader` becomes a thin wrapper over it, so the snapshot reads (#4543) and the
memory route call the same function.

**Every door uses this predicate.** The route handles the list, get-by-id and delete. The
SPA inspector, `RunMemoryPanel` (`?tag=run-id:<id>`) and `openwop memory` all go through
that route. No second reader exists: model-facing reads cannot resolve `tenant-memory`,
and the conformance probe uses its own refs.

> **CORRECTED during implementation (2026-10-25): H2's "every spelling" arm was built,
> measured and DROPPED.**
> - The arm matched `callerSubjectSpellings`, the canonical `user:<id>` plus the request's
>   raw subject. The state it would serve is an UNBOUND reader of a run stamped with the
>   canonical spelling, and that state cannot arise. After an OIDC bind, the subject's
>   requests present `user:<id>` (`middleware/auth.ts` resolves `boundUserId`). Before the
>   bind, nothing can stamp the canonical spelling.
> - So the arm served nobody, and it added a `resolveCallerUser` (which can create a User
>   row) to every non-admin run read.
> - The real gap runs the other way, and it is pinned as residue (AKM2-R1, filed beside
>   CS-BE-7). A run stamped `oidc:<sub>` BEFORE the bind is not matched AFTER it, in a
>   shared workspace. It stays visible to the workspace admin, so it fails closed and is
>   not lost (`test/adr0979-oidc-spelling.test.ts`).
> - Aliasing the User row's legacy `oidc:<sub>` would close the gap. It is deliberately not
>   added: principal ids are not issuer-qualified, and this comparison runs in SHARED
>   workspaces. #4543 has the same gap.
> - Observed while building that witness: after the bind, a bearer-only request (no
>   cookie) for the same subject is refused `/switch` into a workspace whose membership
>   row is keyed `oidc:<sub>`, while the bound cookie session is admitted. That is a
>   users-row question; it is reported to the lead and not touched here.

**The owner is stamped at write time (H1 + H3).** A tenant-memory row gains a host-internal
`owner` field, the opaque RFC 0165 principal of the run that wrote it (`runOwner(run)?.principal`):
- the executor's run summary reads it from `run`;
- the `memory-write` node reads it from the run's metadata;
- it is projected out of every route response;
- it is never a tag, so the content-free `memory.written` payload is unchanged.

Visibility is then decided with no run lookups at all:
- An entry is visible when the decision is `all`, or when its `owner` is one of the caller's
  `principals`.
- **An unstamped row (every row written before this change: 5,782 in prod on
  2026-10-25), or one from a run with no owner of record, is admins only in a shared
  workspace.** This is the same rule #4543 applies to an unowned run, so it fails closed:
  a Viewer or Editor never sees it.
  - In the caller's own personal tenant, and in a tenant where membership does not define
    presence, the decision is `all`, so the owner keeps their whole history.
  - Witnessed both ways (`adr0979-tenant-memory-ledger.test.ts`, "UNSTAMPED (legacy) row"
    and "unstamped legacy rows included"). Sabotage S14 makes unstamped rows visible and
    goes red.
  - The personal leg is held by a stack of three grants (personal, admin, no-presence),
    exactly as in #4543. Removing all three goes red; any one alone is masked by the
    other two.
  - Measured on prod: all 5,782 rows are in personal or deployment-named tenants, and 0
    are in shared ones, so no one loses history today.
  - **No backfill.** A prod backfill is a prod write. A lazy backfill on read would need a
    `getRun` per row, which is H1 again.
- Because the owner is on the row, the run being deleted by retention later (H3) changes
  nothing.

**What "own" deliberately follows (H3, stated).** It follows the RFC 0165 owner of record,
exactly as #4543 does, so the two rules cannot disagree:
- `core.subWorkflow` children and actorless runs (kanban, triggers, approvals, heartbeats)
  have no owner, so they are admins only.
- A fork's owner of record is the SOURCE run's owner (`runs.ts`, ADR 0902). A branch fork's
  summary is therefore the source owner's.

Changing who owns a fork or a child run is an RFC 0165 question, not a memory one.

**Doors:**
- **List.** Rows are filtered BEFORE `limit` and the RFC 0113 budget, through an optional
  synchronous `admit` predicate on `listMemoryEntries` that runs after TTL, tag and recency.
- **Get by id.** An entry the caller may not see is `404`, the same as an absent one.
- **Delete.** When the decision is `all` with grant `wildcard`, `personal` or `no-presence`,
  delete is allowed as it is today (M1: a scoped API key in a deployment-named tenant must
  not lose `openwop memory delete`). Otherwise it needs `workspace:write`, then visibility:
  `403` for the missing scope, which does not depend on the id, then `404` for an entry that
  is not visible.
- **Wiring (M4).** The route registers with `({ app })` as before. No run lookup is needed,
  so it needs no `storage`.

The response gains two additive fields, `visibility: 'all' | 'own-runs'` and
`canDelete: boolean`. This is a host-extension route, so the wire is untouched.

**The compaction seam (L2).** The test-only `/v1/test/memory/compact` archive carries no
`owner`, so under D1 it is admins only. That is acceptable for an env-gated conformance seam.

### D2 — A run whose output was fabricated writes no summary

At finalisation the executor skips the run-summary write, and with it the `memory.written`
event, when either is true of a COMPLETED node:
- its type id, with any `@version` suffix stripped, is `local.sample.demo.mock-ai`
  (`MOCK_AI_TYPE_ID`, already owned by `workflowDemoAvailability`);
- its recorded output carries a placeholder marker: `stub: true`, or `engine: 'stub' | 'demo'`.
  These are the two shapes `core.web.search` returns with no live provider, and KickTodo
  already refuses them as evidence (M2).
  - *Corrected during implementation:* the first cut keyed on `stub: true` alone. The
    witness found that the default test host takes the `webResearch` surface's
    `engine: 'demo'` path, which has no `stub` flag, and that its summary was still
    written.

Replay and fork:
- A replay fork of such a run re-emits nothing, because nothing was recorded.
- A replay fork of a run recorded before this change re-emits the recorded event verbatim,
  so RFC 0041 §C equivalence holds (L3).
- `conformance-noop`, the RFC 0057 attribution fixture, is only `core.noop`.

**Alternative weighed: write the row with a `mock-output` tag and label it in the UI.**
Rejected. A memory entry is a durable record with its own lifetime. Recording fabricated
output repeats the fabrication in a second store, and under the 2,000-row cap each such row
evicts one real summary.

**Residuals, stated:**
- A parent run whose only fabricating step is inside a `core.subWorkflow` child, or in a
  dynamically spawned node (`core.dispatch`, the supervisor), is not detected. The child's
  own summary is skipped. No `tmpl.*` chain nests one today: the `work-twin-templates` pack
  has 81 mock nodes and 0 sub-workflow nodes.
- **Existing rows** (2,237 in prod, measured 2026-10-25T22:28Z) are not touched. Deleting
  them is a prod write and a user decision (OQ-1, taken to the user by the lead). Until
  then they age out under the cap.
  - **They are exactly identifiable for a later one-off cleanup.** Each has
    `id: runsummary:<runId>`, tag `run-summary`, content beginning `Run <runId> of "<wf>"
    completed → ` and containing `Mock response to:`, and a `run-id:<runId>` tag whose run
    executed the mock-AI node.
  - A cleanup can confirm each row against its run's definition, the same detector the
    executor uses (`runOutputWasFabricated`), rather than trusting the text.
  - D2 decides on what the RUN did (the nodes it completed), never on a `tmpl.` prefix or a
    workflow id. A real run of a workflow that happens to share an id is still summarised.

### D3 — The retrieve node never reads as nobody (AGKM-10)

`buildAgentKnowledgeSurface.retrieve` passes a caller:
- `{ subject: scope.actingUserId }` when the run has an acting user. This is what the HTTP
  preview resolves and what the agent runner passes on the same lane.
- Otherwise `{ orgScopeSubject: scope.orgScopeSubject }` when the run carries the member
  who caused it, so ADR 0832's org floor applies (H4).
- Otherwise `{}`.

In both actorless arms, a subject-bound (project or notebook) corpus is refused, and org
corpora are filtered to the causing member's orgs when known.

> **ADR 0832 compliance (found by the gate, slot 77):** the `orgScopeSubject` arm makes
> `features/agent-knowledge/surface.ts` a reader of that field, so it is now on the
> reviewed list in `test/adr0832-org-scope-subject.test.ts`.
> - The read only NARROWS, which is what ADR 0832 requires ("never a grant"). It is
>   forwarded as `SubjectCaller.orgScopeSubject`, the same as `features/kb/surface.ts`, and
>   only `tenantRetrieve`'s org filter reads it. Without it, the run is tenant-trusted.
> - `subjectReadAllowed` reads `caller.subject` alone, so the causing member is never
>   admitted to a project-bound corpus.
> - Witnessed: the causing-member leg in `kb-subject-gate-doors` ("ADR 0979 D3") is
>   refused although that member IS in the project. A sabotage that forwards it as
>   `subject` turns that leg red.

**Not parity with `agentRunnerNode`, stated (H4).** That node's actorless arm is
pre-authorised, by ADR 0664's decision that an agent's binding is an owner-scoped grant to
whoever uses the agent. The retrieve node is not an agent turn. It is a workflow author
reading corpora into a run output, which is exactly the AGKM-10 exposure, so its actorless
arm is narrower.

**Regression, accepted:** a member's own nested child chain (actorless) loses project-bound
corpora through this node. That is fail-closed. No shipped chain uses the retrieve node: the
auto-ingest chain uses `ingest` only.

**The memory leg is unchanged, deliberately (L4).** The node still reads the named agent's
`agent:<id>` notes. That is what any `workspace:read` member can read through the HTTP
`agent:` arm.

### D4 — The inspector and the run panel say what they are

**Inspector:**
- Plain-language lede: these are short summaries written when a workflow run completes.
  Agents do not read this list; an agent's memories live on its Memory tab.
- When `visibility === 'own-runs'`, it says the list shows only runs the reader started.
- Delete and bulk delete render only when `canDelete`.
- The nav hint "Tenant-attributed memory writes" becomes "Summaries of completed runs".

**Run panel (M3):** `RunMemoryPanel` asks the server for this run's rows
(`?tag=run-id:<runId>`) instead of the latest 50 tenant rows filtered on the client. A run
older than the newest 50 used to show nothing, and its count was other runs' rows.

All four locales.

## Not decided here (filed)

- **`AKM2-R1`** (residue beside CS-BE-7) — identity spellings, two faces of one question.
  - Per-user agent memory keys on `callerSubject(req)`. Personal Memory and the DSAR eraser
    key on the canonical `resolveCallerUser().userId`. For an unbound OIDC caller those
    differ. Prod has 0 `per-user` profiles.
  - A ledger row or run stamped `oidc:<sub>` before an OIDC bind is not its creator's
    afterwards in a shared workspace. It remains admin-visible. This is pinned by
    `test/adr0979-oidc-spelling.test.ts`, which flips on purpose when this is decided.
  - Either fix needs the users-row identity decision, not a memory patch.
- **`AKM2-R2`** — a DSAR does not erase a person's run summaries from tenant memory. Run
  records are erasure-exempt (row 52), and this is a derived copy. It needs a
  retention-classification decision.
  - Since D1, each row also carries the pseudonymous owner principal. The ADR 0464
    inventory must list it with the same decision.
- **`AKM2-R3`** — the retrieve node returns untrusted chunks unfenced (with a `contentTrust`
  flag). A downstream model node that ignores the flag reads them as data it trusts.
  - **Assessed in the `/code-review` pass, not fixed in this row.** The risk is real but
    needs an author to wire `retrieve` → a model node: no shipped chain does, and D3 already
    narrowed WHICH corpora reach the node.
  - The class is wider than this node. An edge-delivered node output binds as an `input`,
    which `promptCompose` treats as trusted by default (RFC 0143 fails closed only for
    `variable` / `context` sources), so web-fetch and mail-read outputs have the same shape.
  - Fencing at this one producer would change its output contract and leave the class open.
    The seam is trust propagation across an edge into `bindingTrust`. That needs its own
    decision, probably an RFC 0143 revision.
- Round-1 items still open: `WF-AKM-4/5/7/9`, `AGKM-2/5/6/9/11`.

## Implementation plan and record

| Phase | What | Witness (as shipped) |
|---|---|---|
| P1 | D1: `runPayloadAccess` + owner stamp (executor summary and `memory-write` node) + `admit` list step + delete rule | `test/adr0979-tenant-memory-ledger.test.ts`. P1–P3 were red on `dfafc439b` and are green. Legs: Viewer read/get/delete, Editor own/other, filter-before-limit, admin + ownerless row, never-served projection, personal workspace, `memory-write` row |
| P2 | D2: fabricated-run summary skip | the same file (a mock run and a placeholder-search run write no row and no `memory.written`; a real run writes both) + `test/adr0979-retrieve-node-reader.test.ts` (detector unit) |
| P3 | D3: retrieve node reader | `test/kb-subject-gate-doors.test.ts` "ADR 0979 D3": a member's run is served the project-bound corpus; a non-member's run, an actorless run and a causing-member-only run are not. Plus the caller-shape unit in `adr0979-retrieve-node-reader.test.ts` |
| P4 | D4: inspector copy + gated controls + run-panel tag query, 4 locales | `frontend/react/src/memory/__tests__/ledgerHonesty.test.tsx` |

**Sabotage witnesses:** 16 backend mutations and 5 frontend mutations, all red. Logs are in
the session scratchpad: `row56-sabotage2.log` and `row56-fe-sabotage.log`.
- The first "admit after limit" mutation was a no-op expression that stayed green. It was replaced by a real move of the filter, which went red.
- The grid-card delete mutation was green until a grid-view leg was added.

**Unwitnessed, stated:**
- The `no-presence` delete grant (a scoped API key in a deployment-named tenant) has no fixture either. The wildcard operator path is exercised by the existing `memory-endpoint.test.ts`.

**Consequences found by the closing grade:**
- `runPayloadAccess` resolved the caller's canonical id through `resolveCallerUser` on every non-admin run read. That went away with the H2 arm (see the D1 correction).
- A replay fork writes no summary (RFC 0057 §D), so in the first cut its run panel showed nothing. Before, it highlighted the parent's row from the re-read event.
  - *Fixed in the `/code-review` pass:* the panel reads the `run-id:` tag off the fork's recorded `memory.written`, which is re-emitted verbatim with the source run's id, and asks for that run's rows.
  - The rows are still decided by D1. A fork's owner of record is the source owner, so the forker sees them exactly when they may read the fork's payload.
  - A frontend test covers this, and the sabotage goes red.

## Open questions

- [x] OQ-1 — delete the 2,237 existing mock rows in prod? **Done by the user-approved
  one-off cleanup on 2026-10-26.** The before-image is in
  `~/dev/openwop-app-recovery-artifacts/cleanup-2026-10-25/`. This ADR's code performed
  no prod write.

## `/architect` findings (pre-code, 2026-10-25)

| # | Sev | Finding | Disposition |
|---|---|---|---|
| H1 | High | "lookups bounded by the 500-row cap" was false: filtering precedes the cap, so up to 2,000 `getRun` calls on every `/memory` load and every run page | D1 stamps `owner` on the row; no lookups |
| H2 | High | one spelling of the caller compared; an owner over the other lane loses their own rows | built, measured unreachable (the bind re-keys every lane), dropped; the real reverse gap is pinned as AKM2-R1 residue |
| H3 | High | children, actorless runs, retention-deleted runs and forks silently mishandled | owner on the row (retention); the rest stated as following RFC 0165, same as #4543 |
| H4 | High | D3's actorless arm is not the agent runner's, and dropped `orgScopeSubject` | three-arm caller; parity claim removed |
| M1 | Med | delete under `no-presence` would regress scoped-key CLI deletes | delete follows the read grant for wildcard/personal/no-presence |
| M2 | Med | `core.web.search` stub output is fabricated too | `stub: true` marker added to D2 |
| M3 | Med | `RunMemoryPanel` reads the latest 50 tenant rows | server-side `run-id` tag query |
| M4 | Med | route wiring unstated | no storage needed once owner is on the row |
| L1–L4 | Low | oracle ordering fine; no second door; conformance safe; memory leg unchanged | recorded in D1–D3 |

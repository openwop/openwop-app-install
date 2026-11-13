# ADR 1103 — Research Notebooks: the run lane acts for its caller

Status: implemented (2026-11-11, row 92; PR pending merge — see § Implementation record)

Feature loop round 2, row 92. Grade record:
`docs/steward/workflows-assessment/2026-11-11-notebooks-row92.md` (finding ids `NBK92-*`).
Builds on ADR 0084 (notebooks), 0085 (audio/YouTube), 0087 (MCP), 0601 (trust boundary,
MCP scope, delete order), 0602 (`topK`, stall honesty), 0678 (writer replay
classification). Corrects one sentence of ADR 0601 (§ C1, below).

## Context

The HTTP doors of this feature are sound. Every one resolves the caller's project access
(`resolveProjectAccess`), answers a uniform 404, and splits read from write. The defects
are in the **run lane**: summarize, transform, transcribe, YouTube, MCP and podcasts all
reach the notebook through `ctx.features.notebooks`, and that surface does not know who
the run acts for.

- **`NBK92-1` (Blocker).** The surface authorizes by "the project is
  `visibility:'org'`", for any run in the tenant (`surface.ts:51-61`). Its methods name a
  `notebookId`, never an `orgId`, so the ADR 0832 seam floor (`featureSurfaces.ts:198-213`,
  keyed on `args.orgId`) never fires for it. A member of org A can read org B's source
  text, and write sources and notes into org B's notebooks, by starting a run. A project
  viewer can write through a run what the door refuses with 403.
- **`NBK92-2` (Blocker).** The four route doors start their runs with no actor
  (`routes.ts:307, 341, 401, 470`). The surface treats them as system runs and refuses
  every private project. Each node then turns the refusal into `status:'success'` with
  `stored:false` / `written:false` / `ingested:false`, after a model call and STT metering.

ADR 0601 § C1 says the org-B case "is closed" at the routes, because
`resolveProjectAccess` gates them. That is true of the routes. It is not true of the MCP
tools, which are backed by this surface, not by the routes. **Correction recorded here;
ADR 0601 gets an inline pointer.**

Prod (lead, read-only, 2026-11-11): toggle `beta`; 16 projects, all `org`-visible, 2 with
`facet:'notebook'`, 0 with a stamped corpus; **0 runs of any notebook chain or MCP
projection, ever**; 0 level rows, 0 summaries, 0 project notes; 0 tenant chain copies.
Every defect is LATENT. Nothing to migrate or purge.

### Boundaries audit

| Concern | Owner | This ADR |
|---|---|---|
| Notebook access rule | `features/notebooks/notebooksService.ts` | NEW `notebookAccess()`, the one rule the route, the agent tools and the surface call |
| Project access level | `features/projects` `resolveProjectAccess` | **no change**, called as-is |
| Run actor stamp | `host/runStarter.ts` (`metadata.actingUserId`) | **no change**; the notebooks routes now pass it, as the agent tool already does |
| Surface org floor | `host/featureSurfaces.ts` | **no change**; the notebooks surface does its own floor because only it can map a notebook to its org and visibility |
| KB document lifecycle | `host/knowledgeLifecycle.ts` `onKnowledgeDocumentChanged` | **no change**; notebooks subscribes |
| Project-delete cascade | `host/subjectDependents.ts` | **no change**; notebooks registers its two stores |
| Chain visibility | `examples/workflow-chain-packs/notebooks` | chains become `internal` |
| Node pack | `packs/feature.notebooks.nodes` | node failure semantics; one new input; version bumps |
| FE | `features/notebooks/*`, `features/projects/ProjectDetailPage.tsx` | existing lazy page and existing `notebooks` namespace only; no route, no namespace |

## Decisions

### D1 — One notebook access rule (closes `NBK92-17`)

`notebooksService.notebookAccess(tenantId, notebookId, subject)` returns
`{ notebook, project, level }` or `null`, where `level` is `resolveProjectAccess`'s
answer and `null` means "no notebook, or `level === 'none'`". It is the ONE rule:

- the route's `requireNotebook` (`routes.ts:109-122`) calls it, and keeps its uniform 404
  and its 403-for-read-on-write;
- the three agent tools call it in place of their hand-rolled `resolveProjectAccess` +
  `getNotebook` pairs (`agentTools.ts:170-174, 213-217, 259-265`);
- the surface calls it (D2).

### D2 — The surface acts for the run's person (closes `NBK92-1`)

Every `ctx.features.notebooks` method resolves its notebook through ONE surface helper,
`resolveForRun(scope, notebookId, need: 'read' | 'write')`:

| Run | Read | Write |
|---|---|---|
| has an actor (`scope.actingUserId`) | `notebookAccess(actor)` level ≠ `none` | level `=== 'write'` |
| no actor, a causing member (`scope.orgScopeSubject`) | org-visible **and** the cause's level ≠ `none` (a cause narrows, never widens) | refused |
| neither (a system run) | org-visible, as today | refused |

- **Writes need an actor.** No legitimate notebook writer is actorless after D3: routes,
  the agent tool, MCP (`mcpSemantics.ts:428`) and a fork (re-stamped) all carry one.
- **Refusals.** The three write methods (`setSourceSummary`, `ingestSource`, `addNote`)
  and the new `transformTarget` (D5) **throw** `OpenwopError`: `not_found` (404) when the
  person cannot read the notebook, `forbidden_scope` (403) when they can read and not
  write. The node receives a typed failure. `getSourceText` throws the same `not_found`
  (its only caller is `read-source`).

  > **CORRECTED during implementation (P1):** the write methods and `getSourceText`
  > do not throw. They RETURN `{ error: { code, message } }` (the documents
  > `createDraftDocument` shape), because a thrown `OpenwopError`'s `details` do not
  > survive every pack-loader lane, and the node needs the code. The codes are the
  > notebooks' own: `notebook_unavailable`, `notebook_write_forbidden`,
  > `notebook_write_needs_person`, `source_unavailable`, `source_changed`,
  > `content_empty`. The node throws them as its failure `code` (D4). The list/get/search/ask read methods keep their
  empty shapes for a refused notebook: they back MCP tools, and an empty answer is the
  existence non-leak the doors also give. `listNotebooks` filters to what the person can
  read, so `notebook-list`'s "you can access" becomes true.
- **The same rule as the door, not the ADR 0832 floor.** `resolveProjectAccess` resolves
  effective access in the PROJECT's org (`projectsService.ts:459-464`). It differs from
  `assertRunScopeOrg` on one arm: a private project's people-member reads without a
  current org-membership check (`levelFor`, `projectsService.ts:450`). D2 deliberately
  applies the door's rule so the run lane and the door give one answer. Whether that arm
  should re-check org membership is a projects decision for both lanes, filed as residue.
- **`listNotebooks`** filters through `listVisibleProjects` (`projectsService.ts:479-496`),
  which resolves access once per org, not once per notebook (the PRJC-3 class).
- **Credential lanes (MCP).** An MCP run's actor is `principal.principalId`
  (`mcpSemantics.ts:428`), and D2 gives it exactly what `resolveProjectAccess` gives that
  subject at the HTTP door:
  - a session or OIDC subject: as above;
  - an `owk_` key (`apikey:<id>`): its issuer's authority, narrowed by the key's declared
    scopes, through the existing delegation resolution (`accessControlService.ts:1928-1940`);
  - an env key (`bearer:<hash>`) and an anonymous session: whatever the door gives them
    (the demo single-principal arm, or nothing). P1 MEASURES each of the four lanes with a
    witness, demo mode OFF and ON, and this ADR records the result. If an env key reads
    nothing, that is the door's answer too and is recorded as a decision, not a regression
    to patch here.
  - P1 also measures whether a bound session's `principalId` can differ from its `userId`
    (the routes act as `req.userId ?? principalId`, `routes.ts:85`).

### D3 — The doors stamp the person they authorized (closes `NBK92-2`, with D4)

The four route doors pass `metadata.actingUserId` (the subject `requireNotebook` just
authorized), as `agentTools.ts:298-302` already does, and the top-level `personalTenant:
req.personalTenant` input (`runStarter.ts:91`; it is a reserved metadata key and would be
stripped there). `personalTenant` serves the run's BYOK and tenant gates; D2 does not read
it. The agent tool gains the same `personalTenant` pass-through. In a private project, a writer's Summarize then
reaches the notebook. The run is attributed to them, and their BYOK resolution applies
(the same as the chat tool lane).

### D4 — A node that wrote nothing fails, typed (closes `NBK92-2`, carried `NBC-8`)

| Node | Was | Now |
|---|---|---|
| `read-source` | blank text → `success, empty:true, messages:[]` | throws `source_empty`; an unavailable notebook or source → the surface's refusal code (`notebook_unavailable`, `source_unavailable`) |
| `store-summary` | empty summary or `stored:false` → `success` | empty → `summary_empty`; refusal → the surface's typed throw |
| `write-transformation` | missing org or empty content → `success, written:false` | empty content → `transformation_empty`; target per D5 |
| `ingest-source` | missing id, empty text or `ingested:false` → `success` | empty text → `transcript_empty`; refusal → typed throw |
| `transcribe-source` | blank bytes → `success, empty:true`; empty transcript → `success` | blank bytes → `validation_error`; empty transcript → `no_transcript` (the YouTube node's code) |
| `mcp-add-source`, `mcp-create-note` | declined → `success, declined:true`; empty after accept → `success, written:false` | declined **stays success** (a human answered); empty after accept → `validation_error`; refusal → typed throw |

The failure codes are this pack's own strings, carried on the thrown error's `code` like
`no_transcript` and `audio_too_large` already are. A thrown `.code` survives both pack
loaders (`packs/tarballLoader.ts:199-202`, `packWorkerRunner.ts:154-160`). `not_found` and
`forbidden_scope` are retryable by omission (`executor.ts:478-485`, only the listed codes
are not), and so would any new notebooks code be. None of the four chains sets
`config.retry`, so no refusal is retried today. Adding the refusal codes to the executor's
non-retryable list is a host change this ADR does not make; a chain that later opts into
`config.retry` must take that up.

**Revision race.** `read-source` also outputs the source's `revision`, an edge carries it
to `store-summary`, and `setSourceSummary` refuses (`source_changed`) a summary whose
revision is not the document's current one. A summary of text that has since changed is
never stored (closes the race D7 alone leaves open).

> **CORRECTED after the code re-grade:** the check and the write are two steps, so a
> revision committed between them could still store a stale summary. The stored row
> now carries the `revision` it was written from, and `deriveContextProjection` skips a
> summary whose revision is not the document's current one. A stale summary can be
> stored in that window; it can never be injected. The routes' `202 {runId}` contract is
unchanged; the FE learns the outcome from the run (D9).

**Replay and fork.** The five writers stay `side-effectful` (ADR 0678 D1), so a
`mode:'replay'` fork serves the recorded outcome of an old run, success or not; the new
semantics apply to new executions only. A `mode:'branch'` fork re-executes the writers
(recorded outcomes exist only for replay, `index.mjs:263-268`), and a fork re-stamps the
actor to the forker (`routes/runs.ts:2081, 2097`), so D2 applies the forker's access.
`read-source` and `transcribe-source` stay unclassified: a typed failure on re-execution
is the honest answer for a source that has since gone. Prod has 0 notebook runs, so no
recorded run is affected.

### D5 — `write-transformation` writes where the notebook is (closes `NBK92-4`)

The node gains a `notebookId` input (the chain passes `{{params.notebookId}}`) and asks the
surface `transformTarget({ notebookId })`, a write-gated (D2) method returning
`{ orgId, ownerSubject }` from the notebook itself. The node writes there. If the inputs
also carry `orgId` or `ownerSubject` and they differ from the target, it fails
`target_mismatch` instead of choosing one. A definition without `notebookId` fails
`notebook_required`. (Prod: 0 tenant copies, so no copy breaks.)

### D6 — The chains are host machinery (closes `NBK92-3`)

All four chains in `core.openwop.workflows.notebooks` become `internal: true`, the
`kb-reindex` precedent: absent from the gallery and the `/` picker, still started by id
from the routes, the agent tool and MCP. **`internal` removes the offer and is not a
guard** (`workflowChainPackLoader.ts:193-196`, "NEVER an authz boundary"): an internal
chain can still be instantiated from-chain and started through `POST /v1/runs`. D2 and D5
are the guards. Version bumps, every place that pins these nodes:
- `feature.notebooks.nodes` pack version and `features/packPins.ts:86`;
- node versions for the nodes D4/D5 change, pinned in `examples/workflow-chain-packs/notebooks/pack.json`
  AND in `examples/workflow-chain-packs/mcp-tool-projections/pack.json` (`mcp-add-source`,
  `mcp-create-note`);
- the in-tree SSoT `transformWorkflow.ts` / `summarizeWorkflow.ts` (the write node's new
  `notebookId` input, the `revision` edge), which `features/index.ts:272-293` restores
  output roles from;
- the generated steward manifest, regenerated and shown before commit.

### D7 — A source's derived state follows the source (closes `NBK92-5`, carried `NBC-7`)

- Notebooks registers `onKnowledgeDocumentChanged('notebooks', …)`. For an event whose
  `collectionId` is a live notebook's corpus, resolved through the PROJECT side
  (`listNotebooks(tenantId)` → the notebook whose `collectionId` matches; the collection
  row is already gone on the collection-delete lane, `kbService.ts:1966` before `:1997`):
  - `deleted` → delete that source's level and summary rows;
  - a content revision → delete its summary (it describes text that no longer exists),
    and reset a `summary` level to `full`;
  - then recompute the binding projection, through the existing per-notebook
    serialization (`recomputeBindingProjection`).
  - No live notebook for the collection (the notebook-delete path deletes the project
    first, `notebooksService.ts:338-350`; D8 has already purged the rows) → no-op, so the
    handler can never re-create a binding.
- The revision event fires only from `upsertDocument` (`kbService.ts:2323`); for a
  notebook corpus that is the media-collection bridge (`kbService.ts:2363`). The race
  between a revision and an in-flight summarize run is closed by D4's `source_changed`,
  not by this handler.
- `deriveContextProjection` skips any level or summary row whose source is not in the
  collection's current document list. The projection can no longer inject a ghost even if
  an event was missed.

> **CORRECTED during implementation (three re-grade rounds):** the consumer does not
> resolve the owner from the project side or the collection row. It reads the two
> notebook stores by tenant prefix and keeps the rows for this document, which name
> their notebook; it then checks that notebook's corpus is this collection. A KB event
> for a document with no such row (every ordinary collection) costs two small prefix
> reads and nothing else; no collection read (the row is gone on the collection-delete
> lane), no project scan, and legacy corpora (an unstamped collection, or a project from
> before the stamp) are followed like any other. The first two cuts (a `listNotebooks`
> scan, then a `boundSubject` fast path with a memoized scan) each failed a re-grade:
> the first scanned every project per KB event, the second skipped unstamped corpora.
> Also: the revision event is unreachable for a notebook corpus TODAY, because
> `kbService.upsertDocument` does not forward its `caller` to the inner ingest and so
> cannot write any subject-bound collection; the revision half is defensive, and the
> revision witnesses fire the event directly (see residue).

### D8 — The two stores are project dependents (closes `NBK92-7`)

`registerSubjectDependent('project', 'notebookSourceState', { count, purge })` covers both
`notebook-source-level` and `notebook-source-summary` by the `${tenant}:${projectId}:`
prefix. `deleteProject` runs it before the row delete (both delete doors), and
`dependentsDeleted` reports it.

### D9 — The notebook chat door matches the project chat door; the panel offers only what the caller may do (closes `NBK92-8`, `-9`, `-12`, `-14`, `-15`, `-16`, `-18`)

- **Server.** `POST /notebooks/:id/chat` requires read, as `POST /projects/:id/chat` does
  for the SAME conversation id (`projects/routes.ts:514`). The two doors also stop
  undoing each other: the projects door's reconcile prunes every seated agent that is not
  a project member (`projects/routes.ts:617-619`), which unseats the researcher the
  notebook door seats; it now keeps the notebook researcher when the project has a
  notebook corpus. Both doors title the room `${name} · project` (one room, one title;
  `refreshEntityChatTitle` no longer flips it). Witness: open through both doors in either
  order; the researcher stays seated and the title is stable.
- **Read-only.** `NotebookWorkspace` takes `readOnly`. A viewer sees sources, levels as
  text, summaries' presence, notes, transformations, Ask and Open chat. They do not see
  add-source (text, file, audio, YouTube), the level toggles, Summarize, Transform, the
  note composer or "Save to notes".
- **Drafts.** The panel reports unsaved source text, YouTube URL and note text through an
  `onDirtyChange` prop. `ProjectDetailPage`'s existing tab guard (the charter editor's
  `confirm`) covers it. Limit, stated: that guard covers a tab switch, not leaving the
  page by route or closing it (the charter editor has the same limit).
- **Run outcomes.** When a poll's run is terminal and not `completed`, or completed
  without the awaited item, the panel says it failed, in the owning panel's existing
  failure card, with the run link. The stall card stays for "still running".
- **Errors.** Client errors map HTTP status and the node failure codes above to
  `notebooks` keys; server English is never rendered.
- **Small.** Open in Documents goes to `/documents/:documentId`. The kind chip is
  localized. Transform becomes a select plus an explicit Apply button. A third-party note
  shows a "from a source" chip.

No new route, no new namespace, no eager string. All copy lives in the existing lazy
`notebooks` namespace (four locales).

### D10 — The analyst is told what its write does (closes `NBK92-10`)

The `write-transformation` tool description and `notebook-researcher.md` say the tool
**starts** a run, and that the result appears in the notebook's Transformations when the
run completes. The template list in the prompt is test-pinned to `NOTEBOOK_TRANSFORMATIONS`
ids. The pack description names all three levels.

### D11 — Documentation (closes `NBK92-21`)

`surface.ts` and `routes.ts` docblocks stop claiming a `facet:'notebook'` guard;
`FEATURES.md:278` drops the withdrawn `/notebooks` route. ADR 0601 § C1 gets a pointer to
this ADR.

## Not decided here (residue, with reasons)

- `NBK92-6` (**High, deferred**): audio bytes in `run.inputs`. The fix is to stage the bytes
  in the RFC 0055 media-asset store and pass a ref. But `transcribe-source` is
  deliberately unclassified, so a replay fork re-executes it, and it would then need the
  staged bytes after their TTL. That couples a storage change to a replay reclassification
  that ADR 0678 declined for a reason (the egress half). Prod has 0 ingest-audio runs. Filed
  for its own ADR.
- `NBK92-11` (Medium): Ask omits `summary`-level sources. Needs a decision on whether Ask
  hits may include a summary as a pseudo-hit with a citation. Filed.
- `NBK92-13` (Medium): no source or note delete on this surface. Note delete needs a
  project-scope subject-memory delete that does not exist yet. Filed.
- `NBK92-19`, `-20`, `-22`, `-23`, `-24` (Low): filed as written in the grade.
- **Podcasts (routed to row 93).** The podcasts doors authorize with
  `resolveProjectAccess` and start an actorless run (`podcasts/routes.ts:132-139`,
  `:236-239`), and `select-content` turns an empty `ask` into success
  (`packs/feature.podcasts.nodes/index.mjs:150-154`). So a private-notebook episode is
  generated ungrounded, with paid TTS: the `NBK92-2` shape in the next feature. D2 keeps
  that lane's behaviour (actorless reads stay org-visible) and makes the podcasts
  agent-tool lane (which stamps an actor, `podcasts/agentTools.ts:221-226`) read what its
  person can read. The podcasts fix (stamp the actor, fail `select-content` typed) belongs
  to the podcasts row, which is next in the loop.
- **Private-member arm.** Whether `levelFor`'s private people-member read should re-check
  current org membership (D2 note). A projects decision for both lanes.
- **STT budget on a direct start.** `POST /v1/runs` of `notebooks.ingest-audio` skips the
  route's STT budget pre-flight. D2 still requires notebook write; the budget is the
  route's. Moving metering into the run is the `NBK92-6` ADR's job (same bytes, same
  replay question).

### Residue added during implementation and the re-grades

- **MCP credential lanes (Medium, filed).** D2 gives an MCP run exactly the door's
  answer for its `principalId` by construction (one function). Whether an `owk_` key
  (resolved through its issuer), an env key (`bearer:`) and an anonymous session get
  what an operator expects was not measured. Before ADR 1103 those lanes could WRITE any
  org-visible notebook; after it they write only if `resolveProjectAccess` grants write
  to that principal. Prod: 0 notebook MCP runs ever (lead's SQL), so no live client
  changed behaviour. Owner: the MCP lane (ADR 0601 C4 provenance is not carried into
  the run).
- **One give-up card per kind (Medium, filed).** The ADR 0602 stall store keys by kind
  (ingest / summarize / transform), so a second same-kind run replaces another source's
  card, including a stated failure. Per-source cards change the panel layout and the
  NBU-6 suppression rule; filed for the next UX pass on this surface.
- **Focus on a busy button (Medium, filed, cross-cutting).** `ui/Button` disables while
  `loading`, which drops focus to the body. Every busy button in the app does this; the
  fix (`aria-disabled` while loading) belongs to `ui/Button`, not to this panel.
- **`kbService.upsertDocument` drops its `caller` (`NBK92-X1`, issue #5756, routed to the KB owner).** It
  passes the caller to its collection gate but not to its inner `ingestDocument`, so a
  subject-bound collection cannot be upserted; with a caller it would delete the prior
  row and then throw. No production caller passes one, so latent.
- **Private-member arm (Low, projects).** See D2.
- **Toggle-fault propagation in the projects reconcile is untested (Low).**
- **"View the run for details" copy assumes a run link (Low).** Every door returns a
  `runId`, so the link is always present in practice.
- **Template-catalog failure has no retry (`NBK92-19`, Low)**, as filed in the grade.
- **UX Lows left by the round-5 pass (filed):** no test for the plain-`<Link>` draft
  guard or the Open in Documents `leave()`; a failure already spoken stays silent if its
  card re-appears in the same mount; the panel-retry repeat announcement has no test.

## Alternatives weighed

- **D2: give every method an `orgId` and let the ADR 0832 seam floor do it.** Rejected. It
  makes the caller name an org it could lie about, and the floor knows nothing about
  `visibility:'private'`, so a member without project membership would still read a
  private notebook's text.
- **D2: keep actorless writes for org-visible notebooks.** Rejected. Nothing legitimate
  needs it after D3, and it is the lane a webhook-bound workflow would use to write into
  any notebook.
- **D4: keep `success` and add an `outcome` field.** Rejected. It is the
  success-with-empty shape CLAUDE.md forbids, and the FE and the run page would each have
  to learn to read it.
- **D6: leave the chains public and validate their params.** Rejected. `systemPrompt` and
  `ownerSubject` are not something a person fills in; the honest answer is not to offer
  them.
- **D7: snapshot-free projection (re-derive on every read).** Rejected for now: the chat
  hot path reads the binding as a point-get. The event plus the ghost-skip keeps the
  snapshot honest.

## Feature evaluation matrix (deltas against ADR 0084 / 0601)

| # | Dimension | Verdict |
|---|---|---|
| 1 | Feature-package | All logic stays in `features/notebooks`. Two host seams are consumed, none changed. |
| 2 | Toggle | `notebooks`, unchanged. |
| 3 | Workflow | Same four chains, now `internal`. Doctrine passes. |
| 4 | Nodes | Failure semantics (D4) and one new input (D5); versions bump. |
| 5 | AI exchange | Model output still reaches durable state only through the surface writes, now gated on the run's person. Invalid outcomes are typed failures. Prompt/tool text says "started". |
| 6 | RBAC | One rule (D1) on every lane; writes need an actor with project write. |
| 7 | Replay | Writers stay served on replay; new failures apply to new executions. |
| 8 | RFC gate | None. Host-extension routes and a host surface; no wire change. |

## Phased plan

| Phase | Scope | Witnesses (planned) |
|---|---|---|
| P1 backend | D1–D8, D10 server half, D11. Every authority witness runs with demo mode OFF in a multi-person `org:` tenant (corrected: the plan said `ws:`), and is shown red against `origin/main`'s surface by sabotage | `notebooks-run-lane-authority.test.ts` (cross-org read and write refused, viewer write refused, private member read, actorless write refused, cause narrowing, `listNotebooks` filter), `notebooks-nodes.test.ts` / `notebooks-ingest-nodes.test.ts` (typed failures), `notebooks-transform-t2.test.ts` (D5 target and mismatch), `notebooks-source-lifecycle.test.ts` (D7 delete and revision), `notebooks-delete-honesty.test.ts` (D8 dependents), `notebooks-chat.test.ts` (D9 read gate, D10 pin) |
| P2 frontend | D9, D10 copy | `projectSourcesReadOnly.test.tsx` (no write controls), `pollTimeoutStates.test.tsx` (failed run renders failed), `workspaceFailureStates.test.tsx` (localized errors), a draft-guard test |
| P3 re-grades | Independent UX and code re-grades, folded | — |

## Open questions

- [x] Does any podcasts path start its `ask` run with no actor? **Yes** (architect pass, finding 2): routed to row 93, see residue.
- [x] Does the executor carry a thrown code onto the node failure? **Yes** (`tarballLoader.ts:199-202`, `packWorkerRunner.ts:154-160`).
- [ ] The four MCP credential lanes under D2, demo mode OFF and ON. **NOT measured; filed** (residue). Only the session lane is witnessed (`notebooks-mcp.test.ts`, `notebooks-note-trust.test.ts`).

## Architect pass (independent, before code)

One adversarial read-only pass, verdict "approve with corrections", 15 findings. All folded
above. Dispositions:

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | High | API-key/env-key residue false both ways | D2 credential lanes; P1 measures all four |
| 2 | High | Podcasts has the `NBK92-2` shape | Residue routed to row 93 (podcasts), named |
| 3 | Med | D7 resolves through a collection row already deleted | D7 resolves via the project side; no-op without a live notebook |
| 4 | Med | Revision race; wrong revision citation | D4 revision edge + `source_changed`; citation corrected |
| 5 | Med | "Org floor equivalence" false on the private-member arm | D2 text corrected; residue filed |
| 6 | Med | The two chat doors prune and retitle each other | D9 reconcile rule + witness |
| 7 | Med | Other pins (MCP projections pack, packPins, in-tree SSoT) | D6 lists all |
| 8 | Med | `internal` is not a guard; budget bypass | D6 text; residue filed |
| 9 | Med | `listNotebooks` per-notebook access scan | D2: `listVisibleProjects` |
| 10 | Med | MCP actor spelling vs `userId` | P1 measures with a bound session |
| 11 | Med | Witnesses vacuous under demo mode | P1: demo OFF, `ws:` tenant, sabotage-red on `origin/main` |
| 12 | Low | `personalTenant` is reserved metadata | D3 corrected |
| 13 | Low | Retryable refusal codes | D4: notebooks codes, no retry |
| 14 | Low | Branch forks | D4 replay paragraph |
| 15 | Low | Draft guard covers tabs only | D9 states the limit |

## Implementation record

| Phase | Commit | Witnesses |
|---|---|---|
| P1 backend (D1–D8, D10, D11) | `c8e4f2fd88` | `notebooks-run-lane-authority.test.ts` S1–S6 (sabotage: removing the surface's actor arm reds S1/S2/S3/S5), `notebooks-node-typed-failures.test.ts`, `notebooks-source-lifecycle.test.ts` L1–L8, `notebooks-transform-t2.test.ts` (all four doors stamp the actor), `notebooks-chat.test.ts` (D9 two doors, D10 prompt pin), `adr0839-projects-delete-dependents.test.ts` (D8 registrant) |
| P2 frontend (D9) | `9bcd0ad19f` | `projectSourcesReadOnly.test.tsx`, `pollTimeoutStates.test.tsx`, `workspaceFailureStates.test.tsx` |
| Re-grade folds, rounds 1–4 | `b2f890af2b`, `0210514279`, `3c05c59255`, + round 4 | as above, extended per round |
| Targeted-test fixes | `f884d6aeb1` | the revision witnesses fire the KB event directly; MCP note-trust runs as its caller; `adr0832-org-scope-subject` reviewed reader added |
| Generated | steward manifest (2 packs), pack-surface parity fixture (assertions +2, exclusions −1) | `gen-steward-manifest --check`, `pack-surface-arg-parity.test.ts` |

**Independent re-grades** (separate read-only agents): code B → B+ → **A−** (round 3);
UX B− → B → B+ → B+ → round 5 "A− once N1 is fixed": viewers' empty states now say who
can add (not "add a source above"), the spoken failure is a sentence (`{{title}}.
{{reason}}`), the read-only level chip carries its context, and the panel is keyed by
project. Round 6 (final, independent): **A−** — no Blocker/High, both UX Mediums
credibly filed; two new Lows filed (Ask's no-hits body tells a viewer to add sources; a
first panel-load failure speaks only its title).

**Prod:** latent (lead, read-only SQL 2026-11-11): 0 runs of any notebook chain or MCP
projection, 0 levels, 0 summaries, 0 private projects. No migration, no purge.

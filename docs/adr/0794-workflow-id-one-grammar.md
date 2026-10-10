# ADR 0794 — One grammar and one mint for workflow ids

Status: implemented

## Context

Every workflow in this app is one `WorkflowDefinition`, stored in one registry,
run by one executor. Their **ids** are not standardized. Measured on
`origin/main` 2026-10-01:

| Origin | Minted by | Spelling |
| --- | --- | --- |
| Blank workflow from the builder | browser, `builder/persistence/localStore.ts` `newWorkflowId` | `wf_<8 hex>` |
| "Use template" copy | `routes/workflows.ts` (from-chain) | `wf.<chain>.<8 hex>` |
| Seeded starter (shared) | `host/seedWorkflows.ts` | `wf.seed.<chain>` |
| Fork of a shared workflow | `host/sharedWorkflowFork.ts` | `wf.fork.<name>.<8 hex>` |
| Sub-chain child | `host/workflowChainPackLoader.ts` | `wf.<child>.sc-<hash>` |
| Strategy cadence | `features/strategy/cadence.ts` | `wf.<chain>.cadence-<tenant>` |

Five mint sites, two separators, no shared function. The protocol treats
`workflowId` as an opaque string, but code read meaning into the spelling
anyway:

- Three chat sites tested `startsWith('wf_')` to mean "an editable workflow".
  Every server-minted workflow failed it and ran with no step count, no step
  names and no "Open in builder" link (fixed in ADR 0768 follow-up C9, #4300).
- `PUBLIC_WORKFLOW_ID = /^(wf\.seed\.|tmpl\.|openwop-app\.)/`
  (`host/workflowOwnership.ts`) is an **authorization** decision keyed on the
  prefix: those ids are one definition shared by every tenant, and no tenant
  route may write them. It is single-sourced (ADR 0788) and stays.

There are no production customers. Backward compatibility and deprecation are
explicitly out of scope (owner decision, 2026-10-01).

## Decision

**D1 — One grammar.** Every workflow id this host mints is

```
wf.<origin>.<name>[.<suffix>]
```

`origin` is a closed set and records HOW the workflow came to exist, which
never changes after creation:

| origin | name | suffix | example |
| --- | --- | --- | --- |
| `seed` | chain slug | — | `wf.seed.approvals-request-sign-off` |
| `copy` | chain slug | 16 hex | `wf.copy.approvals-request-sign-off.1a2b3c4d5e6f7081` |
| `blank` | — | 16 hex | `wf.blank.5b1eeeb59f0c2a71` |
| `dup` | — | 16 hex | `wf.dup.0c2a715b1eeeb59f` |
| `fork` | source slug | 16 hex | `wf.fork.digest.9f8e7d6c5b4a3921` |
| `sub` | child chain slug | hash | `wf.sub.review-step.3fa9c1` |
| `cadence` | chain slug | tenant slug | `wf.cadence.strategy-weekly-checkin.ab12cd34ef` |

**D2 — One mint.** `host/workflowId.ts` is the only module that builds or parses
a workflow id. Every mint site above calls it. It also owns the shared-id
predicate (`PUBLIC_WORKFLOW_ID` moves here; `workflowOwnership.ts` re-exports
it), so the grammar and the authorization rule that depends on it cannot drift.

**D3 — The builder mints the same grammar.** The browser keeps minting (a draft
must exist before the first save, including offline). `builder/persistence/
workflowId.ts` mirrors `mint('blank')`; a parity test pins it to the server
function on a fixed set of inputs.

**D4 — A blank workflow is `wf.blank.<8 hex>`, and the id never follows the
title.** A new workflow has no name when its id is minted. Deriving the id from
the title later would mean renaming an id on every retitle, and every id is
referenced by runs, revisions, schedules and agent portfolios. The segment
records origin, like `seed` and `fork` do; the human name lives in
`metadata.name`, where it can change freely.

**D5 — Existing rows are NOT renamed.** New ids only; a row minted before this
ADR keeps its id until it ages out.

> **CORRECTED 2026-10-01 — D5 first said "existing rows are renamed" by a boot
> migration, and D6 said run history would simply point at a dead id. A storage
> inventory (read from the writers, ~30 stores) overturned both before any
> migration was written:**
>
> - The workflow id is inside each definition, so it is inside the **revision
>   hash** (`host/definitionHash.ts`). A rename changes the hash of the workflow
>   and of every parent that references it; at least seven stored hashes
>   (revision keys, published/minted pointers, eval results, environment pins,
>   approvals, run metadata) would then disagree with the content, and four
>   readers compare a stored hash to live content.
> - Leaving `runs.workflow_id` alone is not a dead link. `resolveRunDefinition`
>   resolves by that id with no alias, so paused and in-flight runs stop
>   resolving; and the transient-definition GC and the delete guard ask
>   `hasRunForWorkflow(newId)`, which would be false — a workflow WITH run
>   history would become eligible for hard delete.
> - About 30 stores carry the id as a key or a field (budgets, eval sets, debug
>   pins, schedules, triggers, kanban, rosters, profiles, projects, webhooks,
>   routing rules, approvals, environment snapshots); a collab snapshot embeds it
>   in a binary document.
>
> Days of migration and those failure modes, for demo data. The owner chose
> new-ids-only. The browser-draft rekey first written for D5 was removed with it
> (a renamed local draft would no longer match its server copy).

**D6 — withdrawn** with D5: nothing is renamed, so run history is untouched.

**D7 — `tmpl.*` and `openwop-app.*` are NOT folded into `wf.`** (owner
decision). They stay as they are. See Recommendations.

**D8 — A ratchet keeps it one.** `test/workflow-id-grammar.test.ts` fails the
gate if any file outside the two mint modules builds a workflow id by hand (a
template literal of any family's shape, or concatenation onto a `wf` prefix) or
reads a `wf` id's spelling (`startsWith`/`includes`/`indexOf`, or a regex that
names the prefix, via `.test`/`.exec`/`.match`/`.replace`). Baseline is empty,
and each form is asserted detectable, so a pattern that cannot fire is caught.

**D9 — A server-minted origin is never CREATED through a tenant route.**
`isWriteProtected` refuses a first write of `seed`, `copy`, `fork`, `sub` or
`cadence`. `sub` and `cadence` ids are deterministic from the tenant id; before
this, a FREE one passed (the guard only refused ids already registered), so
anyone who knew a tenant's id could register its sub-workflow or cadence id
first. `workflow-id-create-guard.test.ts` proves it at the route: with the guard
removed, the victim's ids register with a 201. A tenant still saves an id it
already owns. The browser mints exactly the two origins a tenant may create
(`blank`, `dup`), and a test pins that set to the server's rule.

Ids OUTSIDE the grammar are not refused. Tests, the CLI and import all create
arbitrary ids through this route (133 of ~200 distinct test ids are free-form);
requiring the grammar there is a larger compatibility decision than this ADR.

**D10 — 64-bit suffixes, and a retry where the registry can be asked.** The
registry is one keyspace for every tenant. The old 32-bit suffix reaches even
odds of a clash near 77k ids, and a clash is a refused save that reads as
"workflow not found". Random mints now carry 16 hex; the from-chain copy also
retries against the registry (`mintUnique`), as the fork already did.

**D11 — Tool names hash the whole id.** A provider tool name allows 64
characters and no dots; the unique part of an id is its suffix, so truncating
the sanitized id could hand two copies of one long-named template the same
name. `workflowToolName` is `workflow_<readable ≤46>_<FNV-1a 8 hex>`. It is also
no longer spelled `wf_…`, which read as a workflow id.

**D12 — The other families' mints live in the same module**, spelling unchanged:
`agent-wf-<uuid>` (compose tool), `walkthrough.authored.<uuid>` (tour author),
`walkthrough.recorded.<slug>.<16 hex>` (browser recorder). The ratchet covers
their shapes.

**Not done — the shared-id rule stays a namespace predicate.** The review
recommended replacing `SHARED_WORKFLOW_ID` with a stored `shared: true` flag so
the id stops carrying an authorization meaning. Rejected for now: a flag lives
in the definition, the definition is hashed, and stamping it onto every seeded
row moves every seeded revision hash — the cascade the D5 correction describes.
It would also make a sync, single-sourced, test-pinned predicate async on the
1.5 s autosave path. The predicate now sits beside the mint, so the namespace
and the rule cannot drift, and D9 means no tenant can create into it.

## Alternatives weighed

- **Leave the mints, fix only the readers** (what #4300 did). Stops the visible
  defect, keeps five mint sites and the next reader free to guess again.
- **Opaque random ids everywhere (`wf.<uuid>`).** Simplest grammar, but the
  seeded id must be deterministic (re-seed is idempotent by id) and the shared-id
  authorization needs a namespace, so one segment of meaning is unavoidable.
  Given that, a readable origin costs nothing.
- **Server-only mint (builder asks the server for an id).** One function, no
  parity test, but a blank canvas could not exist offline or before the first
  round trip. Rejected for the builder's local-first save path.

## Recommendations on the families left out (D7)

`tmpl.*` (premade templates) and `openwop-app.*` (built-in examples and host
system workflows) are also workflow ids, and the shared-id predicate already
treats them as one class with `wf.seed.*`. Recommended, in this order, each as
its own change:

1. **Route their mints through `host/workflowId.ts` without changing the
   spelling.** Cheap, and it makes D8's ratchet cover them.
2. **Fold `tmpl.*` into `wf.seed.*`.** Both are "one shared definition a tenant
   can use"; two namespaces for it is the same duplication this ADR removes.
3. **Leave `openwop-app.*` alone.** Those are the host's own system workflows,
   referenced by packs, chains and conformance fixtures. Renaming them touches
   the vendored pack registry (a republish) for no user-visible gain.

## Phases

| Phase | What | Status |
| --- | --- | --- |
| P1 | `host/workflowId.ts` + tests; five mint sites call it; predicate moves | done |
| P2 | Builder mint + parity test | done |
| P3 | ~~Boot migration + browser draft rekey~~ | withdrawn (D5 correction) |
| P4 | Ratchet (D8); fixtures and CLI example updated | done |
| P5 | Create guard (D9), 64-bit suffix + retry (D10), hashed tool names (D11), other families' mints (D12) | done |

**D13 — A workflow summary carries its `kind`.** The list route stamps
`kind: 'workflow' | 'walkthrough'` from `workflowKind()`. The walkthroughs page
filtered the caller's workflows with `startsWith('walkthrough.')`; it reads
`kind` now, and the ratchet's reader rule covers every family's prefix
(`wf`, `tmpl.`, `openwop-app.`, `walkthrough.`, `agent-wf-`), not only `wf`.

## Considered after the review, and NOT done

Both were on the review's list. Measuring them changed the recommendation.

- **Require the grammar on every create.** 76 backend test files and the CLI's
  `workflows create` post author-chosen ids. More to the point, an OpenWOP
  workflow DOCUMENT carries its own `workflowId`, and the protocol treats it as
  opaque: a host that refuses an author-chosen id cannot import a workflow from
  another host. The security property that mattered — no tenant creates into a
  server-minted or shared namespace — is D9 and does not need this.
- **Fold `tmpl.*` into `wf.seed.*`.** `tmpl.*` ids are static, so a fold is a
  RENAME, and it meets everything the D5 correction lists: they are stored in
  rosters, profiles and projects (`workflows[]`), recorded on runs, and
  referenced from 29 source, pack and example files (168 references), some in
  registry-published packs that would need a republish.

## Known remaining

- [ ] Rows minted before this ADR keep their old spelling (D5).
- [ ] Ids outside the grammar are accepted on create, by design (above).

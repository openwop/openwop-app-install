# ADR 0944 — Client-scoped agent memory and per-client context

Status: implemented (P0–P4, 2026-10-20)

Date: 2026-10-19

Program: Campaign Studio (ADRs 0941–0962), Tier 0 foundation. Net-new plan, not a
MyndHyve port. Owner decision (David, 2026-10-18): MyndHyve agent memories are
archived, not migrated; **any shared memory is per CLIENT org, never per agency.**
Depends on ADR 0921 (client = org, the run stamp), 0941 (one client stamp on every
campaign run), 0943 (the team that reads this memory).

## Context

One agency workspace (`ws:`) serves 5–30 client orgs. The same ten team agents
(ADR 0943) work for every client. Today an agent's long-term memory is either one
shared `agent:<profileId>` namespace or the acting person's `user:<id>` namespace.
Neither is right: the first leaks client A's facts into client B's proposals (the
PRD F1/F18 zero-wrong-client rule), the second fragments one client's knowledge
across whichever operator happened to run the job. Competitors keep "brand
memory" per account (Typeface brand graph, Jasper brand voice) but none bind it
to a replayable run, and none offer an agency a provable per-client wall.

## Boundaries audit (state on `origin/main` at `74d5f18bc`)

Paths under `backend/typescript/src/` unless noted.

**Exists and is reused:**

- **One memory primitive.** `host/subjectMemory.ts` serves agents and humans
  (ADR 0041): scope = `subjectScope(subject)` = `${kind}:${id}`
  (`host/subject.ts:32-38`, `subjectMemory.ts:56-58`); `SubjectKind =
  'agent'|'user'|'project'|'board'` (`subject.ts:24`). Writes go through one
  chokepoint `persistAndIndex` (SR-1 secret scrub, then the recall store, then a
  vector upsert carrying `contentTrust`, `:95-137`). Reads rank by cosine and
  fall back to recency (`:143-190`). Curated notes are mirrored to the durable
  `subject-memory:note` collection (`:253`).
- **The one scope decision point.** `resolveAgentMemoryScope`
  (`host/agentMemoryAdapter.ts:84-106`) keys off the host-local profile field
  `memoryScope?: 'agent'|'per-user'` (`types.ts:597-607`, deliberately NOT on the
  wire `memoryShape`). `per-user` with no actor returns a never-written sentinel,
  never the shared scope (`:88-103`).
- **Client stamp on runs.** `CAMPAIGN_OPS_RUN_STAMP = 'openwop-app.campaignOps'`
  with `runStampOf` and `bindRunToClient` (`features/campaign-ops/surface.ts:22-45`;
  `wrong_client` at `:41`).
- **Org-keyed sources.** KB collections are keyed `tenant:orgId:collectionId`
  (`features/kb/kbService.ts:526`) with vector namespace `<orgId>/<collectionId>`
  (`:408-410`); brands are org-scoped (`features/brand/types.ts:202-205`,
  `listBrands(tenantId, orgId)` `brandService.ts:358`); campaigns carry `orgId`
  (`features/campaign-orchestration/types.ts:17`).
- **Run-context seam.** `registerRunContextProvider` / `collectRunContextBlocks`
  (`host/runContextProviders.ts:1-30`): a provider returns ONE pre-fenced block
  and "MUST be deterministic for a given run — read what the run was stamped
  with, never 'latest'". The runner already appends these
  (`host/agentRunnerNode.ts:288-290`).
- **Erasure.** DSAR eraser over every `user:` key form + whole-namespace vector
  purge (`subjectMemory.ts:419-485`); agent teardown purges its namespace the same
  way (`host/rosterCascade.ts:126`).

**Findings:**

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| M1 | No org scope exists | `memoryScope` union `types.ts:607`; `SubjectKind` `subject.ts:24` | every campaign agent shares one memory across clients — the leak David ruled out |
| M2 | **The run lane ignores `memoryScope` entirely** | `agentRunnerNode.ts:346-350` passes `memoryScope: agentMemoryScope(runnerIdentity.profileId)`; only the chat/knowledge lane calls `resolveAgentMemoryScope` (`host/agentKnowledgeComposition.ts:269`) | a `per-user` agent on a workflow node already reads AND writes the shared agent scope; a `per-org` value added only to the resolver would be silently bypassed on the lane campaigns use most |
| M3 | Memory recall is not recorded | dispatch reads live (`host/agentDispatch.ts:620-650`); LLM calls replay from the invocation log (`executor/sideEffects.ts:1-10`); `memory.written` is excluded from divergence (`executor/replayDivergence.ts:10-14`) | a `branch` fork re-reads memory that changed since; nothing records what an approved decision was based on |
| M4 | Org deletion cannot see memory rows | `deleteOrg` refuses only while host-ext rows carry that `orgId` (`host/accessControlService.ts:779-800`, `countOrgHostExtRows` `host/hostExtPersistence.ts:186-198`); note rows are keyed by scope, no `orgId` | archiving/deleting a client would orphan its memory |
| M5 | Brand, KB, performance and decisions are read ad hoc per feature | brand voice injected by generation nodes; KB bound per AGENT profile (`types.ts:621-628`) not per client | per-client context drifts per feature; an agent profile cannot bind "this client's" collections |

## Decision

### D1 — `memoryScope: 'per-org'` and an `org` subject

- `SubjectKind` gains `'org'`; `orgSubject(orgId)` is the only constructor (same
  rule as `personSubject`/`rosterSubject`). A Subject still confers no authority
  (`subject.ts:12-14`).
- `AgentProfile.memoryScope` becomes `'agent' | 'per-user' | 'per-org'` (host-local;
  wire `memoryShape` untouched).
- `resolveAgentMemoryScope(profile, ctx)` takes `{ actor?, orgId? }`:
  `per-org` + `orgId` ⇒ `org:<orgId>`; `per-org` with no org ⇒ sentinel
  `${agentMemoryScope(id)}:no-org` (never written, logged once per profile — the
  AGMEM-12 shape). It **never** falls back to `agent:<id>`.
> **CORRECTED 2026-10-20 (P0, `/architect` review).** As built, the resolver's
> second argument is `{ userId?, client? }`, not `{ actor?, orgId? }`. `userId` is
> the shape every ADR 0442 caller already passed, so existing tests are
> unchanged. `client` is the lane's resolved binding: `{orgId}`, or
> `{refused: 'wrong_client'|'forbidden'|'unreadable'}`. The lane resolves it
> before the call (`host/runClientOrg.ts` on the run lane). A structured
> `resolveAgentMemory` returns `{scope, writable, unavailable?}`, and
> `resolveAgentMemoryScope` returns its `.scope`. Sentinels are
> `writable:false`, and dispatch also refuses to write any sentinel scope
> (`host/memoryScopeSentinel.ts`). The sentinel warn fires once per profile
> and reason.
>
> **Q6 decided (architect review, 2026-10-20): the client binding governs, not
> the profile.** A dispatch for a client resolves to `org:<orgId>` for
> *every* agent, including `agent`- and `per-user`-scoped ones. A refused binding
> gives the `:no-org` sentinel for every profile. With profile-only keying,
> an `agent`-scoped Strategist in a client-A run would write A's facts into
> `agent:<id>`, which a client-B run then reads, so the profile-only rule
> could not hold the zero-wrong-client wall. With no client, `per-org` is the
> sentinel, and `agent`/`per-user` are unchanged. The reused personas therefore
> need no profile change. The rule keys on the binding and never on an agent id.

- **Shared per client, not per agent×client** (David): all team agents recall and
  write one `org:<orgId>` namespace. Every write is tagged with the writing
  agentId so recall can attribute and a per-agent purge stays possible.
- The eight new team manifests (ADR 0943) ship `memoryScope: 'per-org'` via their
  profile seed. The two reused personas (Strategist, Media Buyer) also serve
  non-campaign chats, where `per-org` would hit the no-org sentinel; whether they
  move is Q6. Generic: the resolver never reads an agent id.

### D2 — Where the org comes from (never the arguments)

- **Run lane:** the run tag's `orgId` (ADR 0941 D2b), else ADR 0921's
  `openwop-app.campaignOps` client stamp for a client run that belongs to no
  campaign. Neither ⇒ sentinel.
- **Chat lane:** the conversation's bound campaign (`MarketingCampaign.orgId`) or
  client (0926 inbox / 0960 cockpit deep links carry `?client=`), bound once at
  conversation creation and stored on conversation metadata; never per turn.
> **Decided 2026-10-20 (P0, run lane).** The run lane checks the person behind
> the run with `assertRunScopeOrg`: the actor, else the causing member as a
> cause. An **actorless** client-stamped run (a schedule) is trusted on its
> host-written stamp, as KB and media are under ADR 0832. The org must still
> exist in this tenant. Campaign-ops' stricter `no_acting_user` guards writes to
> client assets. Here the read is the run's own client memory, fenced as
> untrusted, so the stamp is enough. Authorization stays live: a `:fork` whose
> actor lost the client reads no client memory. **Residue for ADR 0941:** child
> runs (sub-chains) do not inherit the stamp today, so an agent in a child run
> fails closed to the sentinel until `stampCampaignRun` copies the tag to
> children.

- **Both lanes** additionally require the acting person to hold `workspace:read`
  on that org (`assertRunOrgScope`, as `bindRunToClient` does at `surface.ts:43`).
  A failure is a typed degradation label shown to the model ("client memory
  unavailable") and an empty recall — never another scope.

> **As built, chat lane (P1, 2026-10-20, `/architect` review).**
> - **Binding.** The binding is `ConversationMeta.client = {orgId, name}`. It is
>   set only in `ensureConversationMeta`'s init, when
>   `POST /host/openwop-app/chat/sessions` is called with `clientOrgId`, and
>   there is no setter. `assertClientBindable` checks the org: a non-root org
>   of this tenant (404 otherwise), the creator holding `workspace:read` (403
>   otherwise), and no signed-in person refused. Because the meta row is
>   create-or-return, a request whose binding did not land gets 409
>   `client_binding_conflict`, never a 201. A **branch copies the parent's
>   client**; otherwise client A's transcript would continue unbound. `name` is
>   a display snapshot for the chip, never an authority.
> - **Each turn.** `composeChatContext` re-checks the binding live for the
>   person speaking (`resolveConversationMemoryClient`). A refusal is the
>   sentinel plus the fenced degradation notice, and the turn is marked
>   `degraded: client_memory`.
> - **Deep @mention runs.** A deep run started from a bound conversation is
>   stamped with `clientRunStamp(orgId)` (the ADR 0921 key, which ADR 0941 D2b
>   designates for a client run outside a campaign, named once in
>   `host/runClientOrg.ts`). It is caused by the speaker (`orgScopeSubject`), so
>   the run lane re-checks the same person.
> - **Q4 decided (sequencing): the picker ships with the P4 client page.** That
>   page is where client chats start, through `/chat?client=<orgId>`. P1 ships
>   the link, which creates the bound conversation and hands over to
>   `?conversation=`, and the read-only "Client memory: <name>" chip. A
>   `per-org` agent in an unbound chat says its client memory is unavailable.

### D3 — One resolver on every lane (closes M2)

> **CORRECTED 2026-10-20 (P0).** M2 understated the bypass. **Three** lanes
> skipped the resolver: the agent runner (`agentRunnerNode.ts`), the ad-hoc
> dispatch lane (`liveDispatchLane.ts`, used by `POST /agents/:id/dispatch` and
> agent evals) and the workflow `chat.turn` node's knowledge recall
> (`bootstrap/nodes.ts`). The runner was also inconsistent with itself: dispatch
> memory used `agent:<id>`, while knowledge recall passed no actor, so a
> `per-user` agent read a sentinel in one place and the shared scope in the
> other. All three now resolve through `resolveDispatchMemory` /
> `resolveAgentKnowledgeRetrieve`. The run lanes take the client from
> `resolveRunMemoryClient`. The ad-hoc lane has no client, so a `per-org` agent
> gets the sentinel and the model is told. The ratchet
> (`test/adr0944-memory-scope-ratchet.test.ts`) pins three things:
> `agentMemoryScope(` callers (the adapter, `rosterCascade.ts`,
> `advisoryBoardSeed.ts`), every dispatch `memoryScope` value
> (`memoryBinding.scope`), and the `resolveSubjectKnowledgeRetrieve` caller set.
> One chat-lane read stays outside the resolver until P1:
> `composeKnowledgeForSubject` for a conversation's owner subject
> (`chatContext.ts`).

`agentRunnerNode.ts` stops calling `agentMemoryScope` directly and calls
`resolveAgentMemoryScope(profile, { actor: ctx.actingUserId, orgId: stamp.orgId })`.
This also fixes the existing `per-user` bypass. A ratchet test fails if any file
other than `agentMemoryAdapter.ts` and `rosterCascade.ts` builds a memory scope
for a dispatch.

### D4 — What enters client memory

| Source | Trust | Who/what writes |
|---|---|---|
| Curated client notes ("never mention competitor X") | trusted | a person with `workspace:write` on the org, via the existing note routes with an `org` subject |
| Agent turn summaries | **untrusted** (as today, `agentRunnerNode.ts:349`) | the runner; skipped on replay |
| Approved decisions | trusted | promoted from ADR 0853 decision capture only when a 0942 gate is approved |

Agents never write a trusted fact directly. Per-org cap: 2 000 recall rows
(oldest untrusted summaries evicted first; notes never auto-evicted).

> **As built (P1, 2026-10-20).**
> - **Notes.** Notes live under
>   `/host/openwop-app/campaign-ops/clients/:orgId/memory/notes` (GET on
>   `workspace:read`, POST/DELETE on `workspace:write`, through campaign-ops'
>   `authorizeClient`, so the toggle is on and an unreadable client is a 404).
>   They go through the subject-memory note seam on `orgSubject(orgId)`
>   (`source:'user'`, trusted). `addSubjectNote` gains `authoredBy`, and a
>   person's DSAR tombstones it in `org:` scopes while the note stays (the D8
>   DSAR rule, landed early so no gap ships).
> - **Agent proposals.** These are the "never writes a trusted fact directly"
>   lane:
>   - `ctx.features['campaign-ops'].proposeClientNote` and `listClientNotes`
>     are both `bindRunToClient`-checked; that check is D7 test 2.
>   - New nodes `feature.campaign-ops.nodes.client-note-propose` (side-effect,
>     served on replay) and `client-notes-list` (read) ship in pack 1.1.0.
>   - Proposals wait in `campaign-ops:client-note-proposal`, keyed
>     `tenant::orgId::proposalId` with `orgId` on the row. The id is derived
>     from the run node and the text, so a re-execution adds nothing. At most
>     50 can be pending per client.
>   - Proposals are decided by `POST …/memory/proposals/:id/approve|reject` on
>     `workspace:write`. The decision is claimed by a CAS on the pending row,
>     and the note is written by the approver's `authoredBy`.
> - **Not yet built.** Approved 0853 decisions as a third trusted source remain
>   P2 (the context provider), and the 2 000-row cap remains P4.

### D5 — Per-client context assembly: one provider, stamped inputs (closes M5)

A `campaign-client-context` run-context provider (registered by campaign-ops)
returns ONE fenced block per run, built only from versions stamped at run start:

1. **Brand voice** — the client's brand id + `updatedAt` revision frozen at run
   start; rules via `resolveEffectiveBrandRules` (`brandService.ts:550`).
2. **Knowledge** — the client's KB collections marked `campaignContext` (an
   org-level designation, not a per-agent binding); retrieval runs through
   `kbService` with the org-bound caller, so a collection from another org is
   unreachable. Retrieval results are recorded per D6.
3. **Past performance** — a campaign-intel summary for the client (last N
   campaigns, ROAS/CPA/winning variants) read from a snapshot id stamped at run
   start.
4. **Decisions ledger** — the latest N approved 0853 decisions for the client,
   by ledger version stamped at run start (the ADR 0831 team-ledger precedent).

Budget: ≤ 3 000 tokens, sections truncated in reverse order (decisions last to
go). Each section names its source and version so a reviewer sees what the agent
saw. Brand voice is fenced under the ADR 0891 style-authority frame.

> **CORRECTED 2026-10-20 (P2, `/architect` review) — "versions stamped at run
> start" cannot hold for two of the four sources, and stamping the content on
> the run row would leak it.**
> - *The two sources.* Brand rows have no revisions (`updatedAt` is a CAS token,
>   and `brand:audit` keeps capped diffs). Imported performance records are
>   rewritten in place on re-import. So "the brand at revision R" and "the
>   performance snapshot S" cannot be re-read later.
> - *The run row.* The rendered block cannot go on `run.metadata` either: run
>   readers include workspace members with no row on the client.
> - *As built.*
>   - The pure campaign-ops run-start contributor stamps only a reference,
>     `metadata.clientContext = {orgId, snapshotId}`. It is a reserved key, so a
>     caller cannot choose a snapshot.
>   - On the run's first read, the `campaign-client-context` provider
>     materializes `campaign-ops:client-context-snapshot`
>     (`tenant::orgId::snapshotId`, `orgId` on the row) with an insert-if-absent.
>   - Every later read and every `:fork`, which copies the reference verbatim,
>     serves that row. The block is identical across a replay fork; the P2
>     test proves it after changing the brand and performance in between.
>   - The snapshot is frozen at first use, not at row creation. An agent node is
>     the only reader, so first use is the first moment it matters.
> - *Checks on every read.* The provider re-checks the run's client binding and
>   person (`resolveRunMemoryClient`), and refuses a reference whose `orgId`
>   differs from the run's client stamp. A refusal is the fenced degradation
>   notice.
> - *Sources.*
>   - **Brand:** the client's most recently updated active brand, through
>     `resolveVoice` and `resolveEffectiveBrandRules`, under the ADR 0891 frame.
>     The run tag's `brandId` replaces it once ADR 0941 carries one.
>   - **Knowledge (Q5 decided: explicit list):**
>     `/clients/:orgId/memory/sources` holds the designation, every id checked
>     with `kbService.getCollection` against the client's org (D7 test 6). The
>     snapshot freezes the ids, and the run lane searches them beside the
>     agent's binding (`host/runClientKnowledge.ts`), only while the client
>     binding holds.
>   - **Performance:** `kpiSummary` and `topBottomPerformers`.
>   - **Decisions:** accepted ledger decisions of the client's projects, five
>     per project and ten in all. Each section names its source and version.
> - *Gates and budget.* Every source gates on its own feature (ADR 0820 G11);
>   an off source says "Not included", never empty. The budget is 12,000
>   characters (about 3,000 tokens), cut in the order performance, knowledge,
>   brand, decisions. ("Reverse order" in the original text contradicted
>   "decisions last to go"; the second phrase wins.)
> - *Chat turns.* These do not get the block yet. A conversation run carries no
>   snapshot reference, so the chat lane keeps its P1 memory binding only.

### D6 — Replay: record what was recalled (closes M3)

Each dispatch that recalls client memory or client KB writes a **read receipt**
host-side: `DurableCollection('agent-memory:read-receipt')`, key
`tenant::runId::nodeId::ordinal`, value `{ orgId, scope, entryIds[], kbChunkIds[],
contentHash, at }`. No wire field is added.

- `replay` fork: recall is served from the receipt by id. A missing id (erased,
  evicted) is served absent and the model gets the "memory partially
  unavailable" label; **erasure wins over replay fidelity** — erased content is
  never resurrected. The hash mismatch is logged
  `memory_receipt_drift` so an operator can see why a replay's prompt differed.
- `branch` fork: reads live memory by design (it is a new decision), still
  under the source run's frozen org.
- The command center (0960) "why did the agent do this?" view reads the receipt.
- Receipts carry `orgId` (so `deleteOrg` sees them) and age out with their run
  (retention purger).

> **As built (P3, 2026-10-20).** Receipts are written by the agent runner, the
> lane every campaign agent node uses, for each dispatch whose memory scope is
> `org:<orgId>`.
> - *Storage.* `DurableCollection('agent-memory:read-receipt')` in
>   `host/memoryReadReceipts.ts`, keyed `tenant::runId::nodeId::1`. Ordinal 1
>   is the same per-node identity as the run lane's turn summary, so a looped
>   node keeps its first receipt; this is stated, not hidden. Each receipt holds
>   `orgId`, `scope`, the memory row ids, the KB chunk ids and an order-free
>   sha256 of the recalled `(id, text)` pairs. No content is stored.
> - *What it records.* The memory port and the knowledge retriever now return
>   ids: the vector match id, the recency row id, and the chunk's `chunkId`.
> - *Replay fork.* A replay fork (`run.forkMode === 'replay'`, source
>   `parentRunId`) whose source receipt names the same org and scope is served
>   from it:
>   - memory rows are re-read by id with `getMemoryEntry`;
>   - KB chunks are retrieved live and kept only if the receipt names them;
>   - the memory leg of knowledge recall is replaced by the receipt's rows.
>   - Anything missing makes `recallNotice` add "part of this client's shared
>     memory (erased or removed since the original run)" to the fenced
>     notice. A changed hash logs `memory_receipt_drift`.
>   - A replay writes no receipt. A `branch` fork reads live and records its own.
> - *Retention.* Receipts age out after `RECEIPT_TTL_DAYS` (90) through
>   `registerKvAgeOut`. `deleteClientReadReceipts` is ready for the P4 purge.
> - *Read route.* `GET /campaign-ops/clients/:orgId/runs/:runId/memory-receipts`
>   (`workspace:read`, this client's receipts only) is the read 0960's "why"
>   view uses.
> - *Limits.* A replay's KB filter depends on the live query ranking the same
>   chunks again. A chunk that ranks out is served absent and reported. The
>   chat lane writes no receipts: a conversation is one long-lived run with no
>   replay fork.

### D7 — Isolation guarantees and tests

Route-level (`createApp` + `app.listen` + cookie jar) and service tests:

1. Same agent, same workspace, clients A and B: note written in A is absent from
   B on the chat lane, run lane, retrieve preview and the context provider.
2. Run stamped A, tool args naming B ⇒ `wrong_client`, no read.
3. Operator with rows on A only, chat bound to B ⇒ empty + degradation label.
4. No stamp / no binding ⇒ sentinel scope, never `agent:<id>` (sabotage-witnessed:
   remove the guard and the test reds).
5. Fork of an A run after a B write and an A erasure ⇒ receipt serves A only,
   erased entry absent.
6. KB: a B collection id passed into an A run's retrieval ⇒ not found.
7. Ratchet: no scope built outside the resolver (D3).

### D8 — Erasure and retention

- **Client off-boarding:** `purgeClientMemory(tenantId, orgId)` = durable notes
  by prefix + `clearMemoryScope` + `purgeNamespaceVectors` (the `rosterCascade.ts`
  pattern) + receipts. Called by the ClientAccount archive→delete path (0921).
  Durable note rows gain `orgId` so `deleteOrg` refuses while client memory
  remains (M4) rather than orphaning it.
- **DSAR:** a person's `user:` memory is unchanged. In `org:` memory, the
  `authoredBy` field on notes is tombstoned (`ERASED_USER_REF`). Free text that
  mentions a person is not subject-indexed — the same residual every agent scope
  has; mitigated by SR-1 scrub, the untrusted-summary TTL (180 days default,
  `registerRetentionPurger`) and an operator "search client memory" tool. Stated,
  not hidden.
- **Retention hold:** purge paths assert no hold (`assertNoRetentionHold`).

> **As built (P4, 2026-10-20).**
> - **Purge.** `purgeClientMemory(tenantId, orgId)`
>   (`features/campaign-ops/clientMemory.ts`) empties the durable notes, the
>   recall working set and the vector namespace. It also removes the read
>   receipts, note proposals, context snapshots and the knowledge designation.
>   It refuses under a retention hold (`assertNoRetentionHold`). A vector
>   backend that fails is reported as `complete:false`, never folded into a
>   success.
> - **Off-boarding route.** `DELETE /campaign-ops/clients/:orgId/memory`, for
>   an agency admin only. There is no ClientAccount delete path in ADR 0921
>   today (`archived` is a status), so the purge is the explicit off-boarding
>   act.
> - **`deleteOrg` refuses (M4).** Durable `org:` note rows now carry `orgId`,
>   and every other client-memory row already does. `deleteOrg` therefore
>   refuses while any of it remains, and succeeds after the purge (P4 test).
> - **Retention.**
>   - **Q2 decided at the recommended 180 days.** Untrusted turn summaries in an
>     `org:` scope are written with a 180-day expiry (`CLIENT_SUMMARY_TTL_DAYS`).
>     Notes never expire.
>   - **The 2 000-row cap.** The cap is the existing per-scope hard cap. It now
>     evicts the oldest rows without the note tag first (`evictionProtectedTag`),
>     so a curated note is never pushed out of recall by summaries.
> - **Panel.** `ClientMemoryPanel` (lazy, on the Operations page) lists the
>   notes (add and remove), suggestions waiting for review (approve and reject,
>   marked "Unverified"), the knowledge choice (the client's own collections
>   only), and what the agents wrote (with trust chips and expiry). It links
>   "Ask the team" to `/chat?client=<orgId>`, which is the Q4 picker's entry
>   point. Agency admins also get an erase that requires typing the client's
>   name. Copy is in four locales.
> - **Not built.** The operator "search client memory" tool named in D8 does
>   not exist. The panel's lists are the review surface, and the residual
>   (free text naming a person in shared memory) stays bounded by the SR-1
>   scrub and the TTL above.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | Core seam change in `host/subject.ts`, `host/agentMemoryAdapter.ts`, `host/subjectMemory.ts`, `host/agentRunnerNode.ts`; the context provider, purge hook and client-note routes live in `features/campaign-ops/`. |
| 2 | Toggle | None new. `per-org` is a profile value; the provider registers under `campaign-ops`. |
| 3 | Workflow surface | `ctx.features.campaignOps.clientContext(orgId)` read (stamp-checked). |
| 4 | Node pack | `feature.campaign-ops.nodes.client-note-propose` (agent proposes a note → human gate → write). |
| 5 | Envelopes | None. |
| 6 | Agent pack | Team agents set `memoryScope: 'per-org'`, `memoryShape.longTerm: true`. |
| 7 | Public surface | None. |
| 8 | RBAC | Notes: write on the client org; recall: read on the client org for the acting person; purge: agency admin. |
| 9 | Replay / fork | Org frozen by stamp; receipts serve `replay`; `branch` reads live by design. |
| 10 | Frontend | "Client memory" panel in the client page: notes, sources, recent summaries with trust chips, purge. |

## Why this is our advantage

- **Primitives:** one subject-memory primitive, run stamps frozen at start,
  replay/fork, the ADR 0831 deterministic context seam, the audit chain.
- **Gap closed:** no incumbent can prove to client A that nothing it said reached
  client B's campaign, or show which memories an approved decision rested on.
  Receipts plus replay make both answerable.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| P0 | D1 + D3 (resolver on every lane, `org` subject, sentinel) | Tests 1, 4, 7 green; existing per-user/agent memory tests unchanged |
| P1 | D2 chat-lane binding + D4 note routes | Tests 2, 3 green; 4-locale strings |
| P2 | D5 context provider | Prompt snapshot test: block identical across a `replay` fork |
| P3 | D6 receipts | Test 5 green; receipt aged out with run |
| P4 | D8 purge + `orgId` on notes + panel | `deleteOrg` refuses while client memory exists; purge empties all three stores |

### Implementation record

| Phase | Commit / PR | Tests |
|---|---|---|
| P0 | branch `feat/0944-p0-org-memory-scope` (PR filled on open) | `test/adr0944-client-memory-scope.test.ts` (D7 1 run lane + knowledge path, 4 sentinel, stamp rules; sabotage-witnessed), `test/adr0944-memory-scope-ratchet.test.ts` (D7 7; sabotage-witnessed), `memory-ref-validation` (org + `:no-org` minted refs), `adr0832-org-scope-subject` (reviewed reader list) |
| P1 | branch `feat/0944-p1-client-memory-chat` (PR filled on open) | `test/adr0944-p1-client-memory-chat.test.ts` (D7 2 and 3 plus chat-lane isolation, route RBAC for binding, notes and proposals, branch inheritance, DSAR tombstone; four sabotage witnesses), `frontend/react/src/chat/__tests__/clientDeepLink.test.tsx` |
| P2 | branch `feat/0944-p2-client-context` (PR filled on open) | `test/adr0944-p2-client-context.test.ts` (block identical across a replay fork after the client changed; a new run sees the change; content never on the run row; forged reference and lost access refused; D7 test 6; budget cut order; four sabotage witnesses) |
| P3 | branch `feat/0944-p3-read-receipts` (PR filled on open) | `test/adr0944-p3-read-receipts.test.ts` (D7 test 5: replay served from the receipt after a B write, a new A note and an A erasure; branch reads live; no receipt without a client; age-out; two sabotage witnesses) |
| P4 | branch `feat/0944-p4-client-memory-panel` (PR filled on open) | `test/adr0944-p4-client-memory-purge.test.ts` (`deleteOrg` refuses then succeeds; the purge empties all three stores plus receipts and proposals; agency-admin only; retention hold; 180-day summary TTL; notes survive the cap; four sabotage witnesses), `frontend/react/src/features/campaign-ops/__tests__/clientMemoryPanel.test.tsx` |

D7 test 1 on the context provider: client A's block contains none of client B's brand or knowledge (P2 test).

## Alternatives

- **Agent×client scope (`agent:<id>@org:<orgId>`)** — rejected: David wants one
  shared client memory; per-agent silos re-teach every role the same facts.
- **Per-agency memory with an orgId filter** — rejected: one forgotten filter is
  a cross-client leak; namespaces fail closed.
- **Reuse `project:<id>` (campaign project) as the scope** — rejected as the
  primary: memory would reset every campaign. Kept as a future second layer.
- **Snapshot full content into the receipt** — rejected: it would resurrect
  erased content on replay.

## RFC verdict

**Host extension — no RFC.** `memoryScope` is host-local by design
(`types.ts:597-600`); receipts are host storage; no run-event field changes.

## Open questions

1. **(David)** Confirm one shared memory per client across all ten roles (vs. a
   per-role private layer under it). Recommended: shared only.
2. **(David)** Untrusted turn-summary TTL: 180 days?
3. Should an agency admin be able to copy a curated note to several clients
   (explicit, audited), or is that cross-client by definition? Recommended:
   explicit copy action, never shared rows.
4. Chat-lane binding when a conversation is not tied to a campaign: require a
   client picker, or run with no client memory? Recommended: picker.
5. Do client KB collections need a `campaignContext` flag, or should every
   collection in the org count? Recommended: explicit flag.
6. ~~The reused Strategist and Media Buyer personas (ADR 0943): switch them to
   `per-org`, or resolve `per-org` only when the run tag names a client and keep
   `agent` otherwise?~~ **Decided in P0:** a client binding governs every agent
   (see the D1 correction). No profile change is needed.

## Planning rows

- **ROADMAP** (Campaign Studio program, Tier 0, after 0943): `| 4 | **Client-scoped
  agent memory + context** (ADR 0944) | — (`campaign-ops`) | 0921, 0941, 0943,
  0041, 0442, 0831, 0853, 0904 | `feature.campaign-ops.nodes` | Host extension |
  🔵 Proposed |`
- **FEATURES Future features:** "**Client-scoped agent memory (ADR 0944,
  Proposed)** — `memoryScope: 'per-org'` gives every campaign agent one shared
  memory per client org, resolved from the run tag (ADR 0941 D2b) on every lane
  (fixes the run lane bypassing `memoryScope`); one deterministic per-client
  context block (brand, client KB, performance, decisions); read receipts make
  recall replayable without resurrecting erased content; client purge on
  off-boarding. No toggle; no RFC."


## Recovery correction — nested constructors and unknown scope (2026-10-21)

The initial P0 witnesses inserted stamped runs directly. Fresh subworkflow and
canvas children now inherit the client through the ADR 0943 constructor seam,
with only the campaign-ops orgId projected and the causing member retained as
orgScopeSubject. Parent execution approval authority and frozen bindings are not
delegated. Added witnesses create actual children, then exercise the agent runner
for same-client recall, cross-client isolation, the per-org no-client sentinel,
and live membership revocation, including agents with shared default memory.

Correction to D2: an absent/foreign run or a malformed PRESENT registered client
stamp is an unreadable binding, never evidence of a legitimately unscoped run.
The old undefined result could let an agent with shared defaults read/write its
shared memory. Such handles now use the nonwritable client sentinel. Only an
existing tenant-owned run with no client stamps keeps the unscoped behavior.
A malformed sibling stamp refuses even beside a valid stamp.

These recovery witnesses are authored but have not executed; their focused tests
and the complete merge gate remain required in a serialized guarded slot.


### Recovery corrections — 2026-10-25 (validation pending)

The original P1/P2 record above is retained. Recovery preserves the current
agent-binding stamp, autonomy metadata reservations, requester narrowing and
campaign-ops lifecycle hooks when composing these phases with current main.

- Client-note approval now claims an explicit `approving` state before writing.
  The existing subject-note primitive accepts a host-only operation identity and
  inserts the durable note by CAS under a deterministic ID. Lost acknowledgements
  and failed proposal finalization resume that same operation; an approval is
  reported complete only after its note is confirmed. A started approval cannot
  become a rejection, and retries preserve the original deciding person and DSAR
  tombstones. No additional queue or executor is introduced.
- New shared-org durable notes carry `orgId`, so the existing org-deletion orphan
  check sees them. Author/editor/decider erasure uses bounded CAS rather than
  overwriting a stale scan result or resurrecting a deleted row. The broader P4
  purge/panel and P3 memory/chunk receipts remain pending.
- A frozen context is data, never authority. Every read still checks the actual
  run actor and client, and now refuses if a represented source feature is
  disabled or a designated collection was deleted. Snapshot CAS contention with
  no confirmed primary row refuses instead of returning an unrecorded local
  build. Decisions check their documents/projects source features as well as the
  ledger. Client names are fenced as data, and an over-budget header is omitted
  whole rather than returning a block over the context budget.
- The client-chat deep-link effect reuses its pending request when React
  StrictMode replays effects. Each live subscriber can complete navigation;
  obsolete replies cannot replace a newer client link or query string.

Focused regression tests are authored for real lost write acknowledgements,
failed finalization, recall after recovery, source feature shutoff, actual
membership revocation, collection deletion, unconfirmed snapshot persistence,
small context budgets and StrictMode navigation. These changes have not yet run
while the separate ADR0942 canonical gate owns the local heavy-work slot.


Recovery composition note — 2026-10-25: The composed chat link now waits for session/config readiness before making its request; a regression covers disabled-to-ready navigation. This correction is source-only pending the serialized checks.


Recovery entry-budget note — 2026-10-25: the qualified autonomy build measured only 2 bytes below the 129 kB gzip entry ceiling. Client-chat recovery keeps that ceiling and moves the existing setup/settings-only BYOKWizard behind a lazy import. Its existing BYOK-state test now uses the real router context and waits for the asynchronously loaded wizard; the wizard flow suite is included in focused frontend validation. Measurement of the composed build is still pending.


### Recovery focused qualification — 2026-10-25

The validation-pending notes above describe the preparation stage. The composed
branch now includes qualified main 2f4e6c0ce and all three original branch
histories. Native backend typechecking, pack-surface parity (6 cases), and the
20-file focused suite (270 passing cases, one expected failure) pass. Frontend
lint, the canonical build including CSS/token and bundle gates, test
typechecking, and nine focused suites (67 cases) pass. Entry gzip remains
within the existing 129 kB ceiling (49 bytes headroom); no budget was raised.
The generated floor is 375 / served 332 / unresolved 0, with the same 43
deferred classifications. The measured toggleable dependency ceiling is 113.

Brand, CMS and KB remain always-on substrate; regression fixtures disable
actual toggleable sources, and deleted-collection and revoked-member cases
exercise their live authority checks. A new real-KV fault test also proved
that a proposal CAS with no confirmed winner must refuse, rather than return a
phantom pending proposal; the corrected implementation passes. This does not
complete the later phases listed above. Full canonical CI remains required
before merge, and deployment remains separately queued.


### Recovery correction — P3/P4, 2026-10-25 (validation pending)

The original P3 text above describes the recovered implementation. It did not
make a missing receipt or a changed row safe: an absent source receipt fell
through to live recall, and a changed text hash was only reported after use.
The recovery candidate records empty reads and per-item commitments to text,
trust and KB source title. Replay excludes changed or unproved items and
serves no fresh memory when source evidence is missing, expired or unreadable.
Erased content remains absent; receipts still store no recalled content.

Receipt reads recheck the primary run's current tenant/client binding rather
than trusting receipt indexes. KB source selection, first-use snapshot reads
and later frozen reads use the actual actor through the existing subject gate.
A causing member never grants a system run private project access. Source
selection responses omit both names and selected ids the caller cannot read.

The client-memory panel is keyed to its client and drops late old-client status
updates. Failed or partial mutations refresh confirmed server state while
keeping the error visible. The team chat link binds the chosen agent and client
to the existing chat; pending reset confirmation cannot mutate a client after
the user switches away. These corrections and their regression cases are
source checkpoints awaiting the serialized focused and full canonical gates.


### Recovery privacy correction — 2026-10-25

The original context assembly used an org-only project list and document read.
Two new real-storage tests reproduced private-project decision titles in a
client reader's prompt, including a private document linked from a visible
project. The source was stopped before merge or deployment.

Decision assembly now uses the existing visible-project list and document read
predicate for the actual run actor. Frozen sources retain project/document
references and recheck their current access on every read; removed membership,
deleted sources or legacy references that cannot prove authority refuse the
context. KB selection and snapshot reads likewise pass the actual actor to the
existing subject gate, including rechecks after freezing. A causing member
never grants a system run private project access. The source-selection route
omits selected collection ids its caller cannot read.

The two leak cases failed before the fix and passed after it. Native backend
types and the five-file focused security suite pass (66 cases). Full canonical
CI remains required before the recovery train merges.


### Recovery retention correction — 2026-10-25

The original P3/P4 age-out registration and summary TTL did not by themselves
protect reads: an unswept expired receipt still authorized replay, and vector
metadata could still return an expired client summary. Both failures were
reproduced with real memory/receipt storage before this correction. Receipt
lookup and listing now enforce the 90-day window at read time. Client vector
recall rechecks each candidate against its current tenant-scoped memory row
(up to the existing eight-hit limit), honoring expiry, deletion, text and trust.
Curated notes remain available after summary expiry; a missing receipt still
cannot authorize live recall. The existing age-out seam removes the receipt
collection's tenant-index markers, and a regression verifies they are gone.

Native backend typechecking, pack-surface parity (six cases), and all 18 focused
backend suites (279 cases) pass, including both reproduced retention cases.
The full canonical gate remains pending. The changed-row
regression now writes through the real indexed memory port rather than a bare
row seed, so its positive source-read assertion exercises the actual RAG path.

Recovery frontend qualification — 2026-10-25: lint, the canonical frontend
build (token/CSS/branding/bundle gates), unit-test types, and ten focused suites
(77 cases) pass. Entry gzip is 128.0 kB against the existing 129.0 kB budget
(988 bytes of headroom). The full canonical gate remains required.

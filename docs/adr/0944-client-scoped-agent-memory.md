# ADR 0944 — Client-scoped agent memory and per-client context

Status: Proposed

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
- **Both lanes** additionally require the acting person to hold `workspace:read`
  on that org (`assertRunOrgScope`, as `bindRunToClient` does at `surface.ts:43`).
  A failure is a typed degradation label shown to the model ("client memory
  unavailable") and an empty recall — never another scope.

### D3 — One resolver on every lane (closes M2)

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
6. The reused Strategist and Media Buyer personas (ADR 0943): switch them to
   `per-org`, or resolve `per-org` only when the run tag names a client and keep
   `agent` otherwise? Recommended: the latter, as a resolver rule keyed on the
   stamp, never on the agent id.

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

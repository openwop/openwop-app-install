# ADR 0822 — AI Workflow Author: the model's write lanes carry the builder's authority, and say what they changed

Status: Accepted (2026-10-05). P1–P2 implemented on `feat/fl2-16-workflow-author`. Feature loop 2026-10, row 16 (`docs/steward/FEATURE-LOOP-2026-10.md`), branch `feat/fl2-16-workflow-author`.

- **Composes:** ADR 0072 (the author), ADR 0595 / ADR 0596 (its write integrity and honesty contracts), ADR 0673 (replay classification), ADR 0770 D1 (`requireWorkflowWrite`: every workflow write needs `workspace:write`), ADR 0773 A5 / D8 (`hasWorkflowScope` for tool lanes; the `baseRevision` CAS), ADR 0794 (server-minted id origins), ADR 0789 (shared ids), ADR 0815 (ROOT-row authority in `ws:` tenants), ADR 0819 (`resolveOne` paywall).
- **Supersedes nothing.**
- **Toggle:** none. Workflow Author stays always-on (ADR 0072 § graduation). Nothing here is plan-gated, and nothing here may be: D1–D3 are restrictions, and paywalling a restriction fails open on a lapsed plan (ADR 0819).
- **Wire:** untouched. `/host/openwop-app/*` routes and chat tool results are non-normative. No RFC.

## Context — what the row-16 grade found

The 2026-09 it.25 pass graded this feature **B**, with `WFAWF-24` (replay re-execution) as its
only Blocker. ADR 0673 closed that for `mode:'replay'` forks (#3803). This pass graded the
**authority** of the write lanes. The 2026-08 and 2026-09 passes graded honesty and integrity,
and neither pass asked "who may call this?"

The feature has three ways for a model's output to become a durable workflow:

| Lane | Entry | Authority check at `origin/main ce2abbde3` |
|---|---|---|
| Chat | Workflow Architect `persist` tool (`agentTools.ts:220`) | an acting user must exist. **Nothing else** |
| In-run | `ctx.features['workflow-author'].persistDraft` (`surface.ts:62`), called by the meta-workflow's `persist` node | **none** |
| HTTP | `POST /host/openwop-app/workflow-author/draft` (`routes.ts:51`) starts the meta-workflow run | **none**: no `runs:create`, no `workspace:write` |

The builder's own REST write lanes have called `requireWorkflowWrite` since ADR 0770 D1.
`host/workflowWriteAuthority.ts` even exports the tool-shaped twin, `hasWorkflowScope`, under
a comment saying "ADR 0770 P2 (`WBWF-17`) needs exactly this check for every AI write lane".
None of the three AI lanes calls it. The same doors ADR 0595 §4 called out ("curation was
enforced on the doors a HUMAN uses and skipped on the doors a MODEL uses") had the same shape
again, this time one level up, on **who** rather than **what**.

Measured with `backend/typescript/test/adr0822-workflow-author-authority.test.ts`. The
committed source was byte-identical to `origin/main` (`git diff --stat origin/main -- backend/typescript/src packs`
was empty). Seven assertions were red and three positive controls were green:

1. **A Viewer writes workflows through chat.** In a workspace where the caller holds only
   `viewer`, the Architect's `persist` registered the definition and recorded ownership.
2. **A Viewer writes workflows through a run.** The surface's `persistDraft`, called with a
   Viewer as the run's acting user, registered the definition.
3. **A Viewer starts a billed authoring run.** `POST …/workflow-author/draft` with a Viewer's
   key returned `201` and a `runId`. Viewers lack both `runs:create` and `workspace:write`.
   The run calls the LLM on the workspace's BYOK credentials, then writes a workflow.
4. **Cross-tenant pre-squat of server-minted ids.** An editor of tenant A persisted
   `wf.sub.<chain>.<hash>`, `wf.cadence.<chain>.<hash>`, `wf.copy.*` and `wf.fork.*` ids
   (four cases). ADR 0794 made these origins server-only on the REST lane
   (`isWriteProtected` → `isServerMintedWorkflowId`, `routes/workflows.ts:221`). The author lane
   never asks. `sub` and `cadence` ids are derived from the **victim's** tenant id alone
   (`host/workflowId.ts:65-74`), so A can register the id first. When the victim later
   instantiates a sub-chain, `commitSubChainChild` co-owns A's row; a cadence registers over it
   (`cadence.ts:277`). Either way A still owns the id and can `get` → `persist` new content
   into it. The victim's parent run or cron then executes A's graph **inside the victim's
   tenant, with the victim's credentials** (`subWorkflowDispatcher.ts:263-270`).

**Prod exposure** (pending the orchestrator's read-only sizing): 1–3 need a shared `ws:`
workspace with a Viewer. 4 needs only a signed-in tenant that knows a victim's tenant id, so it
is live-class.

### Found and routed out of this ADR

**Run-start by a foreign workflow id.** This is platform-level, not author-specific, and was
proven with a scratch probe that was deleted. `POST /v1/runs` and `core.subWorkflow` resolve
`workflowId` through the untenanted catalog (`host/index.ts:501`, `resolveLaunchWorkflow`) with
no foreign-owner check. Tenant B's workflow returned **404 to A's GET** but **201 to A's POST
/v1/runs**, and A's `core.subWorkflow` child **completed** running it. A random id (64 bits)
cannot be guessed. Derivable `wf.sub`/`wf.cadence` ids can. This belongs in the runs/executor
area (run-start, `:fork`, sub-workflow dispatch, schedules, triggers), so it is routed to a
separate side fix through the orchestrator. D3 below removes the author lane's contribution to
the derivable-id half.

### What holds (verified this pass, not inherited)

- **Replay.** All four nodes are `role:"side-effect"`. `validate`/`get`/`persist` are
  fast-path served on a `mode:'replay'` fork, and `draft` replays from the invocation log.
  Under `mode:'branch'`, the copied prefix never re-executes (`routes/runs.ts:1868`, `:2066`).
  A **chat** `:fork` has no tool-result cache, so a re-executed `persist` is refused by the
  ADR 0773 D8 CAS instead: a replayed create meets `base_revision_required`, and a replayed
  overwrite meets `workflow_head_moved`.
- **Honesty.** There is still no `success` over an invalid definition and no fabricated id
  (ADR 0596). Closed-world and acyclicity are enforced at both doors.
- **Prompt injection.** `get` is `untrusted` and fenced (`toModelToolResult.ts:110-127`).
  The `draft` catalog is host-global, and node-pack install is superadmin-only and
  signature-verified, so the residual is supply chain, not cross-tenant.
- **Privilege through generation.** `credentialRefs` resolve under the RUN's tenant
  (`executor.ts:3210`). A paywalled node is refused at run time by `resolveOne` in
  `featureSurfaces.ts:76-92`, so authoring one is harmless. Both match the REST lane.
- **Paywall.** The feature has no toggle, so `resolveOne` never applies. That is correct:
  D1–D3 are restrictions.

## Competitive frame (Zapier Copilot, Make Maia, n8n AI Workflow Builder, Lindy)

All four are closed-world, keep AI output out of production until a person publishes or
activates it, and (except Lindy's admin-only routines) defer team permissions to the
product's normal role model. Our author already matches the first two. On the third, D1–D3
bring it up to parity: an AI lane must never grant more than the role that invoked it.

Two table-stakes gaps sit in this ADR's reach:

- **"What did it change, and how do I undo it?"** Zapier keeps draft checkpoints. Maia makes
  every chat turn a revertible scenario version. Our `persist` overwrites under a CAS and
  records a revision, but it tells nobody what changed and does not point at the way back.
  That is D4.
- **Who may build with AI.** Zapier Enterprise gates publishing, and Lindy gates workspace
  routines to admins. That is D1/D2.

The larger gaps are deliberately **not** in this ADR. Each has its own decision to make, and
they are recorded under Follow-ups:

- authoring branches and input mappings (`WFAWF-15`, ADR 0673 OQ-2: a review-gate question);
- connection awareness ("needs setup → Connect", Lindy/Zapier);
- execute-and-refine (n8n).


## Decision

> Revised after the `/architect` round below. The first draft had **2 Blockers** (a missed
> door, and an in-run check that would have refused the env-key `/draft` it claimed to
> keep), **1 High** and **2 Mediums**. Each is recorded in § "/architect round" rather than
> silently folded in.

### D1 — every model write lane asks `workspace:write`, through ONE host predicate

The predicate is `hasWorkflowScope({ tenantId, actingUserId, personalTenant }, 'workspace:write')`
in `host/workflowWriteAuthority.ts`, the tool-lane twin of `requireWorkflowWrite` that ADR 0773
A5 already put there (thrown as `assertModelWorkflowWrite`). The first draft named three model
write doors; there are five, and each takes its own disposition:

| Door | Where | Gate |
|---|---|---|
| Architect `persist` (chat) | `features/workflow-author/agentTools.ts` | `workspace:write`; no person ⇒ refused (already) |
| `persistDraft` (in-run: the meta-workflow's `persist` node, or any workflow using that node) | `features/workflow-author/surface.ts` | `workspace:write`; no person ⇒ refused |
| `openwop:workflows.compose-and-run` (chat) | `host/workflowComposeTool.ts` | `workspace:write` **when a person is behind the turn**; the headless lane (no person, granted per agent, zero by default: ADR 0369 §6) is unchanged |
| `openwop:workflows.propose` (chat; the Architect allowlists it) | `host/workflowComposeTool.ts` | **No role gate, deliberately** (D3 still applies). A proposal is a REQUEST: nothing executes or promotes until someone holding authority approves it (ADR 0473; the decide lane's authority is ADR 0778). It is how a Viewer asks for a change, which is Zapier Enterprise's approval-before-publish pattern. The Architect is told it may OFFER a proposal after a `persist` refusal and must say plainly that nothing changed |
| `POST …/workflow-author/draft` (HTTP; D2) | `features/workflow-author/routes.ts` | `requireWorkflowWrite` |

Every check runs **before** anything is parsed, written or dispatched. A refusal is the
route's own shape: `forbidden_scope`, `requiredScope:'workspace:write'`. The tool error's
message says what the person can do about it ("viewing a workspace does not let you change its
workflows; an Editor can, so ask a workspace admin"), so the Architect relays something
actionable.

The predicate judges the actor by **provenance**, the way the request gate does:

- **A person** (`user:<id>`, `oidc:<sub>`, `saml:…`): `assertTenantScope` over the tenant-wide
  union. In a `ws:` tenant, that is ROOT-row authority (ADR 0815).
- **`apikey:<keyId>`** (an `owk_` key's run): already resolved by `assertTenantScope` through
  the key's issuer and its declared scopes (`viaDelegation`, ADR 0795 D1). No new code.
- **`bearer:<8>`** (an operator env key: the `/draft` route stamps `req.principal.principalId`
  as the actor). **NEW branch:** while that key is still configured
  (`isConfiguredOperatorIssuer`), it holds the tenant-owner scopes (`tenantOwnerScopes`), the
  same reading `credentialAuthority` gives the request lane (ADR 0601 C4). Without this branch,
  an env-key `/draft` would pass D2 and then be refused at `persist`, after the LLM had already
  been billed (architect **B2**).
- **The implicit owner of a personal workspace** (`user:<hash>` / `anon:<sid>`):
  `personalTenant === tenantId`. **`personalTenant` is the REQUEST-stamped value, never
  re-derived** (ADR 0627 D3 review S2). Chat tools already read it off the run row. **NEW:** the
  executor also threads `run.metadata.personalTenant` into the in-run surface scope, so
  `persistDraft` judges the actor by the same stamp.

  Why this is safe:
  - The key is reserved and host-authoritative: a client cannot forge it
    (`RESERVED_RUN_METADATA_KEYS`).
  - It is re-stamped to the forking caller on `:fork` (`routes/runs.ts:1905`).
  - It grants only when it EQUALS the run's tenant and that tenant is personal-shaped.
  - No in-run surface reads it today (grepped), so the threading changes no other feature.

  This replaces the first draft's "a personal-shaped tenant is satisfied" rule. That rule
  trusted the tenant's SHAPE and was never bound to the actor (architect **M1**).
- **No acting user** (an actorless trigger run): **refused.** This matches the agent-author
  surface (ADR 0775 D7). The first draft said it "matches every feature surface", which was
  false (architect **L2**).

`/draft` additionally stamps `personalTenant` from the request onto the run, as `POST /v1/runs`
does, so a solo user's authoring run carries its owner stamp.

`get` / `validate` / the `draft` catalog are reads and stay as they are. REST reads take no
role gate either.

### D2 — `POST …/workflow-author/draft` gates on what the run will do

- `requireWorkflowWrite(req)` is the real gate. It is provenance-classified, so `owk_` keys
  and tenant-owner env keys work exactly as on the builder routes.
- `requireProtocolScope(req, 'runs:create')` is added for **parity** with `POST /v1/runs`. It
  is a no-op in the default posture: it narrows only `owk_` keys unless
  `OPENWOP_AUTHORIZATION_ENFORCEMENT` is on (`host/protocolAuthorization.ts:279`). It is
  never claimed as the thing that stops a Viewer (architect **L1**).
- Both run before the meta-workflow lookup and before a run row exists. A refused request is
  not charged against the run quota (`middleware/rateLimit.ts:599`). A Viewer who is already
  over quota sees `429` before `403`.

### D3 — model lanes are never the first writer of a server-minted id, and never write a deterministic one

- **Create.** `persistAuthoredWorkflow` and `prepareComposedDraft` (propose / compose-and-run)
  refuse `!ownsIt && isServerMintedWorkflowId(id)` with `409`,
  `reason:'server_minted_workflow_id'`. This is the ADR 0794 rule the REST lane has had. It
  runs after the shared-id check (so `wf.seed.*` keeps `shared_workflow`) and before the
  transient cap (so a refused squat never spends budget). The compose lane already refuses any
  id the catalog resolves, so on that lane the rule is simply "never a server-minted id".
- **Overwrite (architect H1).** The author lane refuses the **deterministic** origins (`sub`,
  `cadence`) **even when owned**, with `reason:'deterministic_workflow_id'`. A squat that
  already exists survives as co-ownership: `commitSubChainChild` and `cadence.ts:277` co-own a
  row another tenant already owns. An "owners may write" exemption would leave the squatter a
  model door into the victim's sub-chain child or cron. Neither origin is something a person
  asks an AI to rewrite. They are host-minted infrastructure children, edited (when at all) on
  the builder canvas.
  - The random origins (`copy`, `fork`) stay writable by their owner. "Change the workflow I
    copied from the gallery" is the Architect's most common ask, and a random 64-bit id cannot
    be pre-squatted.
- **Victim side, routed out.** Stripping a foreign co-owner in `commitSubChainChild` / cadence
  is a builder- and strategy-lane change. Since ADR 0794 (REST) and this ADR (model lanes), no
  lane can create a new squat. The residual is only squats that already exist, which is decided
  by the orchestrator's read-only prod scan (`wf.sub.*` / `wf.cadence.*` ids with more than one
  owner tenant). Recorded as R3.

### D4 — `persist` says what it changed, and only promises History when the revision is there

On an **overwrite**, the chat `persist` result adds:

- `previousRevision`: the head the CAS swapped out. By construction this equals the caller's
  `baseRevision`.
- `changes`: `{ nodesAdded, nodesRemoved, nodesChanged, edgesAdded, edgesRemoved }`.
  - The two sides are the **fresh CAS read** (`casBase.def`) and the definition actually
    stored (`defToPersist`, after the ADR 0524 preservation merge). It is never the cached
    `previous` and never the model's raw candidate (architect **M2**).
  - A node counts as changed when its canonical form differs. The canonical form is the one
    `revisionHashOf` uses (position and lifecycle stripped), so a dragged node or a preserved
    field is not reported as a change.
- `inHistory`: whether `getRevision(workflowId, previousRevision)` finds the previous
  revision. `recordRevision` is best-effort, heads written before ADR 0474 have no row, and
  pruning keeps 50.

The tool `note` points at the builder's **History** only when `inHistory` is true. Otherwise it
says the previous version could not be confirmed restorable. The author's revision is now
recorded with `createdBy: 'workflow-author'` (the History UI does not render authors yet; see
§ Grade-pass corrections, `WFAU-26`).

On a **create**, the fields are absent, never "0 changes". The node lane creates only (ADR
0773 G-10c), so `persist.output.schema.json` and the node pack are untouched.

### D5 — approving a composed-workflow proposal needs `workspace:write` (found by grade-ux, proven RED)

`/grade-ux` (`WFAU-23`) traced, and a route witness then PROVED, that the `composed-workflow`
approval kind had **no registered eligibility check**, so `assertApprovalEligibility` was a
no-op. Any member could approve-and-run a proposal, including a Viewer approving **their own**.
`POST …/approvals/:id/claim` with a Viewer's key returned `200 {status:'approved', runId}`.
That made D1's "`propose` is only a request" disposition false, and it predates this ADR
(ADR 0473 relied on a review gate that did not check who reviewed).

The owning module (`host/workflowComposeTool.ts`) now registers the check
(`registerComposedWorkflowEligibility`). It uses the two request-level exits every kind threads
(wildcard operator, own personal workspace), and otherwise the ONE workflow predicate
`hasWorkflowScope(…, 'workspace:write')`. This is the same shape as the assistant-action check.
A refusal is `403 forbidden_scope` whose message names the remedy.

**UX residual:** the review card still shows Approve to a Viewer, because `approvalCanDecide`
answers only for declared quorum ACLs. The click now gets an honest refusal. Projecting
`canDecide:false` for this kind is filed with the UX follow-ups.

## Grade-pass corrections (2026-10-05, after implementation)

`/grade-code` and `/grade-ux` were run independently against the implementation. As in rows
1–15, the code Highs were **in my own fix**:

| id | Finding | Disposition |
|---|---|---|
| `WFAC-17` (High) | The new `bearer:` branch matched an 8-char prefix against ANY configured key, so a key bound to tenant A was owner in tenant B (probe wrote a workflow). The same widening reached builder-pair | `isConfiguredOperatorIssuerFor(issuer, tenantId)`: the key must be configured for THAT tenant or `*`. Refuse-side witness added |
| `WFAC-18` (High) | D4 compared only nodes and edges, so a rename or a `variables` edit reported "nothing changed": the "model is lied to" class, in the code meant to prevent it | `unchanged` is decided by the revision hash. `changes.workflowFieldsChanged` lists top-level fields (with `metadata.*` split; the host-owned `lifecycle` and `authoring` excluded). Steps are reported as `{nodeId, label}` so the model names them as the person sees them (`WFAU-28`). Rename-only and identical-content legs added |
| `WFAC-19` (Med) | Doc comments still said `propose` is gated | Corrected |
| `WFAC-20` (Med) | Runs with no request (schedule, trigger, heartbeat) carry no `personalTenant` stamp, so an in-run `persistDraft` in a personal workspace is refused. `agentRunnerNode` does not pass the stamp to the tools it runs | **Accepted as fail-safe and recorded here.** A schedule that rewrites workflows in a personal workspace is not a flow anyone has; the refusal is typed. Filed as a follow-up if one appears |
| `WFAC-21` (Med) | `/draft` ran the run quota before the write gate, so a Viewer's 403 spent quota | The gate is now middleware ahead of `runQuotaMiddleware` |
| `WFAU-21` (High) | A refusal reached the chat card as a raw JSON blob, in English, in every locale | `chat/AgentEventCards.tsx` `toolErrorText`: for a JSON envelope, a translated code wins, else the envelope's `message`, never the blob. A plain transport message still wins (TOCU-6). `toolErr_forbidden_scope` added ×4 locales. Witnessed |
| `WFAU-25` (Med) | "History" is under the builder's Share menu | The tool note says so |
| `WFAU-26` (Med) | §D4 said History "attributes" the AI write, but `HistoryDrawer` renders no `createdBy` | **Corrected:** the revision is RECORDED with `createdBy:'workflow-author'`, and the History UI does not show it yet. Follow-up |

## Alternatives weighed

- **One central role gate in `registerFeatureAgentTool` keyed on `effect:'write'`.** Rejected:
  `effect` is "DISPLAY ONLY … never an input to gating" (ADR 0784), and write tools need
  different scopes in different features.
- **Derive the in-run actor's personal tenant from its user row** (the users and orgs
  surfaces' pattern). Rejected: ADR 0627 review S2 established that the REQUEST's value is the
  truth. An anon `session:<sid>` has no user row, and an unbound `oidc:` subject's home is
  derived from OIDC config. Threading the stamped value is one source; deriving it would be a
  second.
- **Accept actorless in-run writes.** Rejected: it would diverge from ADR 0775 D7, and a model
  writing workflows with nobody accountable is the case the D1 rule exists for.
- **Fix run-start-by-foreign-id here.** Rejected for scope. It belongs to runs, `:fork`,
  sub-workflow dispatch, schedules and triggers. Routed (R2).

## Trade-offs

- **Behaviour change.** A Viewer who used the Architect (or `propose` / `compose-and-run`) to
  create workflows in a shared workspace is now refused, which is the point. A memberless,
  non-personal tenant is refused exactly where the builder's REST save already is: the AI
  lanes follow the builder, never lead it. An unbound `oidc:` member whose membership row is
  keyed only under the legacy spelling is refused on both lanes, as it already is on REST and
  the agent-author lane (`agentAuthorService.ts:158`).
- **The Architect can no longer edit a `wf.sub.*` / `wf.cadence.*` child.** The builder can.
- **D4 cost.** One in-memory diff plus one revision point read, on overwrite only.

## /architect round (2026-10-05, first draft)

This was an independent adversarial pass. Its findings changed the decision:

| # | Sev | Finding | Disposition |
|---|---|---|---|
| B1 | Blocker | `propose` / `compose-and-run` were a missed door. A Viewer refused on `persist` gets steered to them, and they also create `wf.sub` / `wf.cadence` ids | D3 covers both. `compose-and-run` is gated when a person is behind the turn. `propose` is **deliberately not role-gated**: the reviewer's premise was that it is a write door, but it can only create a request an approver must decide. **Corrected while implementing:** gating it broke the ADR 0473 headless and auto-approval suites, which is how the disposition surfaced |
| B2 | Blocker | The env-key `/draft` run's actor is `bearer:<8>` and not actorless, so the surface check would refuse it after the LLM spend | `bearer:` operator branch in the one predicate (D1) |
| H1 | High | Existing squats survive as co-ownership, so "owners may write" keeps a model door open | D3 overwrite rule for deterministic origins; victim side is R3 |
| M1 | Med | The personal short-circuit trusted the tenant's shape, not the actor | Request-stamped `personalTenant` threaded in-run |
| M2 | Med | D4 diff base and canonicalization wrong; History presence unproven | Fresh CAS read vs stored def, canonical compare, `inHistory`, `createdBy` |
| L1–L3 | Low | `runs:create` overclaimed; R1 wording false; legacy `oidc:` spelling | Wording corrected; spelling is a REST-parity residual |

The verified "holds" (branch-mode prefix not re-executed, `get` fenced, chat `:fork` refused
by the CAS) were confirmed independently.

## Phased plan

| Phase | Scope | Witness |
|---|---|---|
| P1 | D1 (five doors and the predicate's `bearer:` branch, plus the in-run `personalTenant` threading), D2, D3 | `adr0822-workflow-author-authority.test.ts`: red on main; plus env-key `/draft`, solo `user:` and `anon:` positive legs, and propose / compose-and-run legs |
| P2 | D4 | D4 legs in the same file |
| P3 | grade-ux / grade-code Blockers | per finding |

## Residuals

- **R1 — legacy `oidc:` spelling.** A membership keyed only under it is refused on every lane.
  This is the safe direction and was already filed by ADR 0775.
- **R2 — run-start by a foreign workflow id** (platform; proven). Routed to the orchestrator
  as a side fix (see Context).
- **R3 — squats that already exist.** Victim-side co-ownership stripping is decided by the
  prod scan. No lane can create a new squat.
- **R4 — `walkthroughAuthorTool`** records tour drafts with no role gate. Its ids are random,
  so it cannot squat, but a Viewer can spend the shared transient budget. It is not a workflow
  the Architect authors, so it is routed out.

## Follow-ups (not this ADR)

- UX (grade-ux, `src/builder/**`, needs ce coordination):
  - `WFAU-22`: an Architect overwrite of the workflow open on the canvas leaves it stale, so
    the next save meets the head-moved banner. The prompt already routes in-builder edits to
    `suggest-edits`; the persist path is the residual.
  - `WFAU-24`: a view-only hint in the Create-with-AI panel (OQ-1 resolved: keep the entry,
    since a Viewer can still read and `propose`).
  - `WFAU-26`: History shows the revision author.
  - `WFAU-27`: Restore's refusal copy for a Viewer.
  - Review-card `canDecide:false` for composed-workflow proposals a caller cannot approve (D5).

- `WFAWF-15`: the meta-workflow's `RESPONSE_SCHEMA` should express edge `condition`s and node
  `inputs` (after ADR 0673 OQ-2).
- Connection awareness ("needs setup"), as in Lindy and Zapier.
- Execute-and-refine, as in n8n.
- `WFAWF-17` / `WFAWF-23` (carried over from ADR 0673 P4).

## Open questions

- OQ-1 — **RESOLVED by `/grade-ux`:** keep the entry. A Viewer can still read, ask, and
  `propose`. The builder has no proactive can-write signal, so a view-only hint (`WFAU-24`)
  is the follow-up.

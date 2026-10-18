# ADR 0775 — Agents, roster & workforces: one write authority, tenant-owned cutover state, and a permission gate that can see a roster agent

Status: Accepted — P1 implemented (feature-loop 2026-10 row 5); P2 implemented (P2a–P2c: all 44 `tmpl.*` are chains, reachability decided: hidden; P2d: the 15 `openwop-app.agents.*` had zero prod runs and are deleted); P4 implemented (`ARWF-11` stale-write guards, `ARWF-8` eval from the workforce); P3 implemented (P3a–P3d + `ARUX-18`, 2026-10-15; P3e–P3f, 2026-10-16)

Feature-loop 2026-10 row 5 (agents, roster & workforces, + agent author). Grade evidence:
`docs/steward/WORKFLOWS-ASSESSMENT.md` § "Agents, roster & workforces" (`ARWF-1..14`,
opening grade **D**, doctrine FAIL). Composes ADR 0031 (agent profile), 0032 (work-twin
agents), 0058 (chat-drivability = agent + nodes), 0102 (per-tool permissions), 0277
(agent identity), 0379 (persona-scoped ids), 0514 (agent author), 0617 (tenant-scope
predicate), 0764 D6 (catalog source-A ratchet) and 0774 D5 (tenant write authority on
legacy boards).

## Context

The agents area was never graded as a unit. It is the surface every chat-drivable
feature rides (ADR 0058: a feature is driven by an agent pack plus nodes), so a defect
here is a defect in every feature's AI lane. Every row below was re-read by hand at
`aae09f13c`:

| id | Guarantee broken | Where |
|---|---|---|
| `ARWF-2` | One tenant's decision stays in that tenant | `PATCH /workforces/:id` calls `setWorkforceStatus`, which writes a record keyed only by `workforceId` (`host/workforceService.ts:54,74-84`). Any caller, including an anonymous demo session, flips the cutover status for **every tenant**. |
| `ARWF-3` | A read-only member cannot write | Every agent-area write is scoped by `tenantOf(req)` alone: roster create/patch/delete (`routes/roster.ts:169/224/278`), user-agent create/patch/delete (`routes/userAgents.ts:83/250/301`), profile and capability writes (`routes/agentProfile.ts:292/311/336`), workforce writes (`routes/workforces.ts:180/230/284`) and ops (`routes/agentOps.ts:89/131/191/214`). A viewer in a shared workspace can rewrite an agent's system prompt and tool allowlist, set its ADR 0102 `permissions`, delete other members' agents, or clear example data. The sibling routes on the same `/agents/:id` prefix already gate `workspace:write` (`features/agent-knowledge/routes.ts:142`). |
| `ARWF-4` | An agent's "never" list reaches the gate | `resolveAgentToolPermissions` returns `undefined` unless its id starts `host:` (`host/agentProfileService.ts:184`). Both callers pass the REGISTRY id (`agentDispatch.ts:1375`, `conversationToolLoop.ts:407`), which is never `host:`. So even with `OPENWOP_AGENT_TOOL_PERMISSIONS_ENABLED=true` the gate never sees a roster agent's profile. Its shadow log cannot fire either, so the shadow period that was meant to justify turning enforcement on has been measuring nothing. |
| `ARWF-5` | A tenant's agent is its own | Voice `allowlistOf` finds the manifest agent with `listManifestAgents().find(a => a.agentId === id)` (`features/voice/realtime/toolBridge.ts:43-46`). The registry lists every tenant's user agents, and `user.<slug>` ids repeat across tenants (ADR 0379), so a voice session can be offered and can execute another tenant's same-named agent's tools. |
| `ARWF-6` / `-12` | Deleting a member leaves nothing behind, and does not delete what it does not own | The cascade deletes a `user.*` agent from storage but not from the in-process registry (`host/rosterCascade.ts:77-86`), so the instance keeps serving it. It deletes that agent even when another roster member still points at it. And it deletes the roster row BEFORE the org-chart/profile/notes/vector sweeps (`:89`): a later throw returns 500, the retry 404s on the route's pre-check, and the orphans are unreachable. |
| `ARWF-1` | Workflows are chains or stacks | 44 `tmpl.*` (`host/workflowTemplates.ts:140-205`) and 15 `openwop-app.agents.*` (`host/exampleWorkflows.ts`) literals resolve by id in catalog source A (`host/index.ts:629,637`). All ten Work-Twin agents' portfolios bind them. The ADR 0764 D6 ratchet only matches `if (workflowId === '…')`, so a by-id **function** lookup never trips it. |
| `ARWF-9` | A default-OFF feature is off | The agent-author chat tools never check their toggle; the node-pack surface (`features/agent-author/surface.ts:22,35`) creates roster agents with no acting user. |
| `ARWF-10` | Discovery says what is served | `workforces: { readOnly: true }` (`routes/discovery.ts:3163`) while two PATCH routes are served. |

**Doc rot found (recorded, not inherited).** `docs/steward/builtin-workflow-migration-audit.md`
and `CLAUDE.md` both said the in-tree workflow migration was DONE, and that "a
code-pinned workflow is now inexpressible at every layer". That is true only of
the `BackendFeature.builtinWorkflows` seam (72 migrated by ADR 0472). The 59
definitions above never went through that seam, so neither the audit nor the
ADR 0764 D6 ratchet saw them. Both documents carry a dated correction from this
ADR. The doctrine FAIL is CONTAINED by D6 (a no-growth ceiling), not cured; P2
cures it.

## Competitive frame

The competitive catalog in `docs/steward/UX_UPGRADE-agents.md` (round 2: Agentforce,
Copilot Studio, Relevance AI) is extended here with the one axis this ADR is about: **who
may change an agent**.

- **Microsoft Copilot Studio** separates Editors (edit, configure, share, publish) from
  Viewers (open, test, use, never edit), and editor rights go to individuals only
  ([share agents](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-share-bots)).
- **OpenAI GPTs / workspace agents** separate "Can chat", "Can view settings" and "Can
  edit"; listing an agent in the workspace directory "does not automatically make
  everyone an editor"
  ([sharing GPTs](https://help.openai.com/en/articles/8798878-sharing-and-publishing-gpts),
  [workspace agents](https://help.openai.com/en/articles/20001143-chatgpt-workspace-agents-for-enterprise-and-business)).
- **Lindy**'s community forum shows the cost of the opposite: users report agents that
  keep running tasks after being turned off
  ([forum](https://community.lindy.ai/x/support/ld7nsmnolnur/unable-to-stop-tasks-on-agent-need-assistance-for)).
  That is our `ARWF-7`, deferred to P3 below.
- **Agentforce** versions an agent (draft → commit → activate), so two editors cannot
  silently overwrite each other. That is `ARWF-11`, deferred to P4.
- **Claude Projects, CrewAI and Relevance AI** keep an agent's instructions and tools
  inside one workspace or crew. None lets a member of a different workspace see or use
  them. That is the floor `ARWF-2` and `ARWF-5` fall below.

The market floor is: **chatting with an agent is a read; changing it is an edit right;
and no tenant's change reaches another tenant.** We are below that floor on all three
counts. P1 brings us to it.

## Boundaries audit

- **Feature packages.** `agent-author` is a feature package (`features/agent-author/`).
  Roster, profile, workforce and dispatch are core (`host/`, `routes/`). No new package.
- **One predicate per lane, one core.** ADR 0774 D5 built the only HTTP write predicate
  in the tree that judges a person by BOTH identity spellings and reads a credential by
  provenance (`routes/kanban.ts` `callerSubjectSpellings` + `assertBoardTenantWrite`).
  `featureRoute.requireTenantScope` does neither: it keys on the raw `callerSubject`
  alone and ignores credential provenance (ADR 0774 finding A2). D1 moves ADR 0774's
  predicate into `features/featureRoute.ts`; kanban and the agent routes call the one
  copy. The req-less tool lane uses the ADR 0617 D2 core `assertTenantScope` (the
  `features/crm/agentTools.ts:154` precedent). Both bottom out in
  `resolveSubjectScopesUnion`.
  `requireTenantScope` itself is left alone: widening it changes about 70 call sites
  across unrelated features. That is filed, not smuggled in. Until it lands, one CLI
  key can get 200 on `/roster` and 403 on the sibling `/agents/:id/twin` route; that
  split is recorded as known residue.
- **Import direction.** `featureRoute.ts` already imports `resolveCallerUser` and
  `host/protocolAuthorization.ts`. `routes/` imports `features/featureRoute.ts` today
  (`routes/byok.ts`, `routes/governance.ts`). `protocolAuthorization.ts` does not
  import `featureRoute.ts`, so the move adds no cycle.
- **The single chat.** No new chat surface. `ARWF-9` hardens the existing agent-author
  tools.

## Decision

### D1 — One tenant-write authority for every agent-area write (`ARWF-3`)

Export from `features/featureRoute.ts`:

```ts
/** Does the caller hold `scope` in `tenantId`? Judged by provenance, and for a person
 *  by the UNION of both identity spellings. */
export async function callerHoldsTenantScope(req, tenantId, scope): Promise<boolean>;
/** Throwing wrapper: 403 `forbidden_scope` with `requiredScope: 'workspace:write'`. */
export async function requireTenantWrite(req, tenantId = tenantOf(req)): Promise<void>;
```

The body is ADR 0774 D5's, moved without behaviour change, and taken in this order:

1. The wildcard operator principal is allowed.
2. An `owk_` key whose declaration lacks the scope is refused.
3. The caller's own personal workspace (`isOwnPersonalWorkspace`) is allowed.
4. Otherwise the caller must hold `credentialScopesIn(principal, tenant, subject)` for
   some subject in the spelling union.

`routes/kanban.ts` `assertBoardTenantWrite` becomes a call to it that still throws its
`BoardWriteRefused` subclass, so the ADR 0049 assignee carve-out is untouched.

`requireTenantWrite(req)` is the first statement of every write handler:

- roster create/patch/delete
- user-agent create/patch/delete
- profile PUT and capability PUT/DELETE
- workforce status PATCH, migration PATCH and eval POST
- agent-ops `example-data/seed|run|clear` and `roster/:id/check`
- org-chart PUT/DELETE (`routes/orgChart.ts:178,208`, architect H3). The cascade
  maintains this chart, so it is agent-area state.

**Not gated: `POST …/agents/eval-run`.** It is a pure grader over the tasks and
results in the request body (`gradeSuite`, `routes/agents.ts:494-519`) and persists
nothing. The first draft listed it as a write; a code read showed otherwise.

**Reads stay tenant-scoped.** This covers roster, profile, workforce, migration and
activity GETs, and `connection-readiness`. **`POST …/agents/:agentId/dispatch` also
stays tenant-scoped in P1.** Dispatch is a stateless turn whose side effects pass
through tools that carry their own gates (ADR 0308). `roster/:id/check` is gated
because it MOVES a board card (a durable write) before any tool runs. "May run an
agent" covers the whole chat lane and is an open product question.

**Frontend (architect M1).** A viewer's auto-seed of an empty demo roster
(`AgentDashboardPage.tsx:175-183`) now 403s. The dashboard treats that 403 as "show
the empty state", not a page error. Hiding write affordances for viewers is P4.

### D2 — Workforce cutover status is tenant state (`ARWF-2`)

The seeded `Workforce` entity stays global and read-only: it is authored demo data
reconciled from `seed-data/workforces.json`. A tenant's cutover decision moves to a
tenant-keyed overlay, `DurableCollection<{tenantId, workforceId, status, updatedAt}>`
named `workforce-status`. It is keyed `${tenantId}:${workforceId}` and built WITH
`tenantOf`, so it has a tenant index (architect M4). This is the shape
`migrationService` already uses for the same entity family (CTI-1).

- `getWorkforce(tenantId, id)` / `listWorkforces(tenantId)` merge the overlay's
  `status` over the seed.
- `setWorkforceStatus(tenantId, id, status)` writes only the overlay.
- The seed reconcile no longer resets anyone's decision.
- Clearing the `workforces` example-data step (`exampleDataSeeders.ts:271`) also
  deletes the tenant's overlay rows. Otherwise a cleared tenant would still read
  `production` with no graduation evidence behind it.
- Tenant teardown: overlay rows carry a JSON `tenantId`, which `purgeTenantHostExt`
  matches (`hostExtPersistence.ts:135,593`).
- Nothing is migrated. The global `status` was reset on every `seedWorkforceEntities`
  call, including every auto-seed visit (`exampleDataSeed.ts:665`), so no durable
  per-tenant decision exists to lose.

### D3 — The ADR 0102 gate sees every roster agent that could be speaking (`ARWF-4`)

**Architect B2 falsified the first draft.** Passing `identity.profileId` would hand the
chat path the FIRST-WINS reverse lookup (`agentIdentity.ts:68-76`) that the
Alternatives section rejects, because a chat turn carries only the registry id
(`conversationExchange.ts:599`). Two roster members may legally share one `agentRef`
(`POST /roster` accepts any, `routes/roster.ts:186`), so member B would run under
member A's rules.

The resolver becomes `resolveAgentToolPermissionSet(tenantId, addressedId,
registryAgentId): ToolPermissions[]`, with these rules:

- **`addressedId` is a `host:` roster id** (REST dispatch, a run node addressed by
  roster id): the set is exactly that profile's permissions. This is an exact match
  with no collapse.
- **Otherwise** (a chat turn, a run node addressed by registry id): the set holds the
  permissions of EVERY roster entry in the tenant whose `agentRef.agentId ===
  registryAgentId`. The gate evaluates each entry and denies if ANY denies (tightest
  wins). When the dispatch cannot say which member is speaking, every member's
  guardrail binds.
- A pack agent with no roster entry yields `[]`, which leaves it ungated, as today.

`evaluateToolPermission` stays pure. A sibling `evaluateToolPermissionSet(tool, sets)`
returns the first deny, else the strongest allow. `toolPermissions` on the loop options
becomes `readonly ToolPermissions[]`.

**Callers.** Chat (`conversationToolLoop.ts`), run and REST (`agentDispatch.ts` via a
new optional `LiveDispatchDeps.agentAddressedId`, passed by `agentRunnerNode` and
`routes/agents.ts`), and **voice** (architect H1). `executeRealtimeToolCall` never
evaluated ADR 0102 at all, so voice now applies the same set evaluation after the
allowlist and before the firewall.

**Replay (architect M3).** The verdict is recorded as `agent.toolReturned{forbidden}`
and a replay reuses the recorded event. A `:fork` re-runs live, so a fork of a run that
predates this ADR may now be refused a tool the source run executed. That only happens
with enforcement ON. The tighter rule winning on `:fork` is the ADR 0132 precedent.

**Enforcement.** The flag default stays OFF, so production behaviour changes only in
the shadow log. The shadow log becomes meaningful for the first time: before this ADR
it could not fire for a roster agent. The production value of
`OPENWOP_AGENT_TOOL_PERMISSIONS_ENABLED` was not verified in this pass.

**Witness (GEN-AR-2).** `test/agent-tool-permissions.test.ts` injects `toolPermissions`
directly, so nothing tests the path from resolver to gate. A new test must drive the
real resolver with a real roster entry and profile on the chat lane and the run lane,
including the shared-`agentRef` case, and fail when the resolver is sabotaged back to
registry-id keying.

### D4 — Voice resolves the agent within the tenant (`ARWF-5`)

`allowlistOf` takes the tenant and uses `await getAgentRegistry().resolve(agentId,
tenantId)`. A pack agent still resolves by its bare id, and a user agent resolves only
under its `ownerTenant`, so a foreign tenant's `user.<slug>` never matches.
`resolve(…)` is async and reads through to storage, which the synchronous `get` does
not (architect L3). `listManifestAgents().find(` has no other call site.

### D5 — The roster cascade deletes what it owns, and the row after its dependents (`ARWF-6`, `ARWF-12`)

The new order of `deleteRosterMemberCascade` is:

1. Run every rosterId-keyed sweep (boards, jobs, approvals, org chart, pins, profile,
   notes, vectors, twin grants).
2. Delete the roster row.
3. RE-COUNT the tenant's remaining roster entries that reference the same `user.*`
   `agentRef.agentId`. If there are none, delete the chat agent from storage and evict
   it from this instance's registry (`getAgentRegistry().remove(agentId, tenantId)`,
   the same pair `DELETE /agents/:agentId` performs at `userAgents.ts:324`).
4. Fire `fireRosterMemberDeleted`. It receives `agentId` ONLY when step 3 deleted the
   agent (architect B3). Hooks key widgets and scheduled chats by `agentId`, so passing
   the id of a surviving shared agent would disable the survivor's widgets and chats.

Counting AFTER the row delete closes the race the first draft had: two concurrent
deletes of A and B that share X both see zero remaining references, and both delete X.
The delete is idempotent.

Retry behaviour: a throw in step 1 leaves the row in place, so the retry re-runs the
whole cascade instead of 404ing on the pre-check. There are two known residuals:

- A crash between step 2 and step 3 leaves an unreferenced user agent. It is still
  listed and deletable through `DELETE /agents/:agentId`, so it is visible, not
  stranded.
- `fireRosterMemberDeleted` swallows hook failures (`rosterLifecycle.ts:41`), so a
  failed hook is never retried.

**Other instances keep serving a deleted agent until restart.** Hydration runs only on
a registry miss (`bootstrap/agentPackResolver.ts:107-115`), and the existing
`DELETE /agents/:agentId` has the same gap (architect H2). Cross-instance eviction is
P3 scope.

### D6 — The source-A ratchet pins the resolver's RETURN set (`ARWF-1`, interim)

`test/catalog-source-a-literal-ratchet.test.ts` gains a second probe on the real
invariant (architect M2): it records the set of expressions `X` in every
`return { workflowId, definition: X }` inside the catalog `getWorkflow` resolver. The
probe was chosen over a `get<Name>(` pattern, which would miss `conformanceFixtures.get`,
a `Map.get` and aliased variables. That set is pinned, and so are the catalog sizes of
the two pinned modules (`WORKFLOW_TEMPLATES` = 44, `EXAMPLE_WORKFLOWS` = 15), both
shrink-only. A new definition source fails the test, and so does a 45th template. This
does not close `ARWF-1`. It stops it growing while P2 converts it.

### D7 — agent-author honours its toggle and the write authority (`ARWF-9`, architect B1)

**Architect B1:** after D1, a viewer refused at `POST /roster` could still create a
roster agent through the chat persist tool (`agentTools.ts:145-157` checks only that an
acting user exists) or the node lane (`surface.ts:35` checks nothing).

So these changes apply:

- `openwop:feature.agent-author.nodes.persist` and `surface.persistDraft` call
  `assertTenantScope(tenantId, actingUserId, 'workspace:write', { personalTenant })`,
  the run-lane core of the same decision, and are refused without an acting user.
- The four `openwop:feature.agent-author.nodes.{get,draft,validate,persist}` chat tools
  check `resolveFeatureToggle('agent-author', scope)` and return a typed
  `feature_disabled` refusal when it is off.
- The node surface is already toggle-gated at the registry seam
  (`featureSurfaces.ts:64`).
- The refusal code for a missing acting user is the existing `no_acting_user`.

### D8 — Discovery says what is served (`ARWF-10`)

`workforces.readOnly` becomes `false`. The host-extension block is non-normative, and
`test/replay-divergence.test.ts:137` asserts only `supported`. The stale "Read-only in
EP0" docblocks at `routes/workforces.ts:10-11` and `registerAllRoutes.ts:377` are
corrected in the same change.

## RFC verdict

**No RFC.** Every route touched is under `/v1/host/openwop-app/*`, which is
non-normative. The `workforces` discovery block is a host-extension advertisement. The
ADR 0102 gate is host policy on a host-owned profile. No run-event, capability flag or
endpoint contract changes.

## Phases

| Phase | Scope | Status |
|---|---|---|
| **P1** | D1–D8 (`ARWF-2..6`, `-9`, `-10`, `-12`, the `ARWF-1` ratchet), all architect findings | implemented |
| P2 | `ARWF-1` conversion, **batched by category**. Each batch is one reviewable PR that does all four of: (i) ship the batch as workflow-chain pack(s) registered same-id via `registerChainBackedWorkflow`, with a `postProcess` that restores the bare node ids, so a pre-existing run `:fork`s def-identically (the replay note); (ii) make it reachable through the ownership index (`hostOwned`), after the open question below is decided; (iii) delete those entries from the in-tree module; (iv) LOWER the D6 ceiling by the batch size in the same commit. Composed flows move from `core.subWorkflow` `config.workflowId` to `subChainRef`. Batches: **P2a** meeting-ops, reporting, intake-triage, scheduling (16 `tmpl.*`). **P2b** approvals, knowledge, people, finance (16; carries the `approval-chase` → `single-approver` composition). **P2c** commercial, it, comms (12; carries `post-meeting-follow-up` → `action-extraction`). *(CORRECTED 2026-10-10: that composition is meeting-ops, so P2a carried it. P2c has no composition.)* **P2d** the 15 legacy `openwop-app.agents.*`: `seed-data/exampleAgents.json` binds none of them, so first measure prod run references. With none, delete them, and archive-not-dispose them otherwise (replay law). Then delete both modules and drop the two getters from source A. `frontend/react/src/agents/roleTemplates.ts` stops hand-copying the ids. *(CORRECTED 2026-10-10: step (ii) is answered NO. The user decided the `tmpl.*` chains stay `internal` replay archives, not reachable (Open questions).)* | **implemented** (§ P2 implementation record; P2d measured 2026-10-12 and deleted) |
| P3 | `ARWF-7` / `-13`: one dispatch policy resolver. Roster `enabled:false` and the `agentPolicyResolver` autonomy/approval/required-connection rules apply on every AUTONOMOUS entry (schedules, follow-ups, heartbeat fallback). User-initiated chat stays a test pane, as in Relevance AI. The run path also gets the persona scaffold and agent knowledge. Cross-instance registry eviction (D5 H2). Viewer-aware write affordances in the SPA. | **implemented** (P3a roster `enabled:false` on every scheduler lane + approve-time; P3b the profile's explicit `never`/`hitl` rules on schedules — user decision: autonomy level, allowlist and readiness stay heartbeat-only; P3c agent knowledge on the run path — persona scaffold withdrawn as false on a run; P3d registry eviction + TTL backstop; `ARUX-18` viewer read-only panels; § P3 implementation record) |
| P4 | `ARWF-11`: an `If-Match` / version CAS on roster PATCH, user-agent PATCH and profile PUT (profile PUT becomes a merge, not a full replace), and a CAS in `recordHeartbeat` against a concurrent pause. `ARWF-8`: the workforce eval reads its agent and suite from the workforce, not `host.priya`. | **implemented** (§ P4 implementation record) |

## Alternatives weighed

- **Widen `requireTenantScope` to the spelling union (instead of D1's new export).**
  This is the right end state, but it changes about 70 call sites across unrelated
  features in a PR about agents, and "widening what an endpoint accepts needs
  refuse-side tests" would then apply to all of them. Rejected for P1 and filed.
- **Gate agent writes on `workspace:admin`.** This is stricter than every sibling
  (agent-knowledge and twin use `workspace:write`) and stricter than the market
  (Copilot Studio editors are not admins). Rejected.
- **Make the workforce entity per-tenant (copy the seed per tenant).** That is a write
  storm per anonymous visitor, which is exactly what `SHOWCASE_TENANT` was built to
  avoid. The overlay stores only the one field a tenant actually decides. Rejected.
- **Fix `ARWF-4` by making the resolver reverse-scan the registry id.** The reverse
  lookup collapses two roster members that share one agent (`agentIdentity.ts:74-75`,
  first wins), so a permission would bind to the wrong member. Callers already hold the
  exact profile id. Rejected.
- **Convert `ARWF-1` in this PR.** That is 59 definitions plus a replay-shape decision.
  The replay note deserves its own `/architect` pass. Deferred to P2 behind the D6
  ratchet.

## Architect pass (pre-code, 2026-09-28)

This was an adversarial read-only pass by a fresh reviewer, with every premise checked
at `03cd4fa3c`. It found 3 Blockers, 3 High, 4 Medium and 3 Low findings. All are
folded into the decisions above.

| # | Sev | Finding | Folded into |
|---|---|---|---|
| B1 | BLOCKER | The agent-author tool and node persist skipped the write predicate, and the predicate needed a `req` | D7: `assertTenantScope` run-lane core on both lanes |
| B2 | BLOCKER | The D3 chat path used the first-wins reverse identity lookup, which is the rejected alternative | D3: a permission SET across every member that references the agent; tightest wins |
| B3 | BLOCKER | The D5 reference count raced. Hooks disabled a surviving member's widgets and chats. Swallowed hook failures broke the retry claim | D5: recount after the row delete; `agentId` sent to hooks only when deleted; residuals stated |
| H1 | HIGH | Voice never evaluated ADR 0102 | D3 callers |
| H2 | HIGH | "Other instances converge on read-through" was false | D5 text; P3 |
| H3 | HIGH | Org-chart PUT/DELETE were missed; check-now and dispatch were gated inconsistently | D1 list + rationale |
| M1 | MED | A viewer's auto-seed 403 would break the dashboard | D1 frontend note |
| M2 | MED | The `get<Name>(` probe was too narrow | D6: pin the resolver's return set |
| M3 | MED | No replay note and no end-to-end witness | D3 Replay + Witness |
| M4 | MED | Clearing example data left the overlay behind; the overlay had no tenant index | D2 |
| L1 | LOW | "host/ does not import featureRoute" was false; the provenance gap in `requireTenantScope` was not mentioned | Boundaries audit |
| L2 | LOW | D7 had the wrong tool ids, reversed toggle arguments and an invented refusal code | D7 |
| L3 | LOW | D4 had a wrong line citation and should use the async `resolve` | D4 |

## Open questions

- [x] **P2 reachability (product call).** ADR 0190 §Phase 6 kept the `tmpl.*`
  mock-AI templates OUT of the template gallery on purpose. Making them
  ownership-index reachable puts 44 deterministic mock-AI flows in every tenant's
  `/builder` list. The doctrine requires reachability; the product may prefer
  converting the ten Work-Twin portfolios to real-AI chains and retiring the
  mocks. Decide before P2a.
  **ANSWERED 2026-10-10, the user's decision: hidden.** The `tmpl.*` chains stay
  `internal: true` (RFC 0135) as replay archives. They are not made reachable in
  `/builder` or the `/` picker, and get no `hostOwned` registration. The real-AI
  Work-Twin chains, and the demo stopgap until then, are a separate ADR. That ADR
  is not this one, so P2 step (ii) closes here with no code.

- [ ] Should *running* an agent (dispatch, chat) require more than tenant membership?
  This is a product call, and it covers the whole chat lane.
- [ ] Should `requireTenantScope` adopt the spelling union repo-wide? (Filed as a
  follow-up with its own refuse-side sweep.)

## Implementation record (P1)

| Decision | Commit | Witness (each sabotaged red) |
|---|---|---|
| D1 write authority (+ org-chart, eval, ops) | `c8acb2823` | `test/agents-write-authority.test.ts` |
| D2 tenant cutover overlay | `c8acb2823` | same file, "tenant A piloting…" |
| D3 permission set (chat / run / voice) | `c8acb2823`, `65d8a3e96`, `b814d531e` | `test/agent-tool-permissions-roster.test.ts` |
| D4 voice tenant-scoped resolve | `c8acb2823` | same file, voice cross-tenant |
| D5 cascade order + shared agent + registry eviction | `c8acb2823`, `65d8a3e96` | `test/roster-cascade-shared-agent.test.ts` |
| D6 honest source-A ratchet | `c8acb2823` | `test/catalog-source-a-literal-ratchet.test.ts` |
| D7 agent-author toggle + write authority | `c8acb2823`, `b814d531e` | `test/agent-author-write-authority.test.ts` |
| D8 discovery honesty | `c8acb2823` | discovery block + docblocks |
| Viewer presentation (grade-ux ARUX-1..5, -11, -15, -16, -19) | `5d67b1ac4`, `63387076a` | `agents/__tests__/{autoSeedRefusedShowsEmpty,agentWriteAccess,viewerFollowUps}.test.tsx` |

**Corrections found in implementation.** `POST …/agents/eval-run` persists nothing and is
not gated (D1 note). The overlay's first name `workforce:status` ALIASED the `workforce`
collection's key prefix (`hostext:workforce:`), and tenant B read tenant A's cutover in
the first witness run; it is `workforce-status`. Grade-code found `ARCD-1` inside D3: a
raw `===` on agent ids let a legacy-spelled (ADR 0763) roster member's never-list fail
open, and the identity reverse index had the same key. Both now compare `agentStorageId`.

**Residuals (filed, not claimed).** `ARCD-2`: the req-less run lane knows one spelling of
the human, so it refuses a legacy-only membership (safe direction). `ARCD-3`: a profile PUT
that passed `requireOwnedAgent` before the row delete can still land after the resweep;
the fix is a row tombstone (P4). `ARCD-4`: a roster scan per chat turn / voice call. The
UX follow-ups `ARUX-7b/-8/-9/-12/-13/-17/-18` are filed with reasons in
`docs/steward/UX-ASSESSMENT.md`.


## P2 implementation record

### P2a — meeting-ops, reporting, intake-triage, scheduling (16 `tmpl.*`), 2026-10-10

Measured at `51f5a323f` before the change: 44 `tmpl.*` + 15 `openwop-app.agents.*` =
59 in-tree definitions, D6 ceilings 44 / 15. After: **28 + 15 = 43**, ceilings
**28** / 15.

| Step | What shipped |
|---|---|
| (i) chain pack | `examples/workflow-chain-packs/work-twin-templates/pack.json` (`vendor.openwop-app.workflows.work-twin-templates@1.0.0`), 16 chains, chainId = the original `tmpl.*` id. It was GENERATED from the live in-tree definitions, not hand-copied. Every node is exactly pinned (`local.sample.demo.mock-ai@0.1.0`, `core.approvalGate@1.0.0`, `core.subWorkflow@1.0.0`). `post-meeting-follow-up` composes `action-extraction` through RFC 0133 `subChainRef` + `subChains[]`, and the host-default bind restores `config.workflowId` to the same child id. |
| (i) same-id registration | `registerWorkflowTemplateChains()` (`host/workflowTemplates.ts`), called from `registerBackendFeatures` before the CBW-1 bind sweep. Its `postProcess`, `restoreTemplateShape`, strips the expansion prefix from node ids and edge endpoints and drops `metadata` / `configurableSchema`. **Each expansion is byte-identical to the deleted in-tree definition**: `revisionHashOf` matches 16/16 golden hashes measured before deletion. So the revision row the registration records IS every historical run's `definitionRevision` pin, and such a run now resolves `resolvedFrom: 'revision'` (it used to resolve the head). |
| (ii) reachability | **Decided 2026-10-10 (the user): hidden, as replay archives. No reachability work.** Every chain is `internal: true` (RFC 0135). That keeps today's posture exactly: out of the `/builder` gallery and the `/` picker, as ADR 0190 §Phase 6 decided. It also keeps them out of the zero-config tenant seed. `seedWorkflows.ts` seeds every zero-config, non-internal chain into every tenant, and these chains take no parameters, so leaving `internal` off would have answered the product question by side effect. Answering it later is one flag per chain plus, for ownership-index visibility, `hostOwned` on the registration. |
| (iii) delete | The 16 entries are gone from `WORKFLOW_TEMPLATES`. `WORKFLOW_TEMPLATE_CHAIN_IDS` names them. `test/workflow-templates.test.ts` still pins 11 × 4 across the in-tree remainder plus the chain ids, with no id in both. |
| (iv) ratchet | D6 `WORKFLOW_TEMPLATES` ceiling 44 → **28**, same commit. |

**Witness:** `backend/typescript/test/work-twin-template-chains.test.ts`. It boots the real app and checks golden-hash identity, the pinned-revision resolve, the composition bind, `internal`, exact pins, and real-executor runs (one to completion, one to its gate under the bare node id). Three sabotages each fail the expected cases: dropping `restoreTemplateShape` (4 red), dropping the boot call (6 red), and one chain `internal:false` (1 red).

**Trade-offs and residuals (recorded, not hidden):**
- The restored definition does not carry `metadata.expandedFrom.nodePins`, so
  `runInsert`'s node-pin-mismatch stamp has nothing to compare for these demo workflows.
  Byte identity was chosen over it, because replay is the law and the stamp is
  diagnostics. The pins are still enforced at pack load (ADR 0766 D2).
- The pack loads from the image-vendored `examples/` root. It is in no
  `OPENWOP_INSTALL_PACKS` pin, so **no registry publish is needed for prod**. A host
  that sets `OPENWOP_WORKFLOW_CHAIN_EXAMPLES=0` loses these 16 ids. Every ADR 0472
  chain-backed migration (kicktodo loops, notebooks, MCP projections) already has that
  caveat. A `tmpl.*` id on such a host now 404s where it used to resolve. If that
  matters, publish the pack to packs.openwop.dev and pin it.
- On an `OPENWOP_DEPLOY_POSTURE=auth` host, `mock-ai` is not registered (LEAK-3), so
  neither the old nor the new definition can dispatch. This batch does not change that.

### P2b — approvals, knowledge, people, finance (16 `tmpl.*`), 2026-10-10

The same generator (appending to the pack) and `restoreTemplateShape`. Golden
hashes were measured at `0b45e04ec` before deletion, and 16/16 match.
`finance.approval-chase` composes `approvals.single-approver` through `subChainRef`.
The template catalog test's shape assertions (allowed node types, one primary,
approvals gated, closed composition) moved to the chain test, over the pack. The
unused `composedFlow` helper was deleted. Ceiling 28 → **12**. In-tree total 43 → **27**.
Sabotage: rebinding `approval-chase` to `dual-approver` in the pack fails the hash
and composition cases (2 red). Dropping one P2b id from the registration list fails
the list-equality and pack cases (2 red).

### P2c — commercial, it, comms (12 `tmpl.*`), 2026-10-10

Golden hashes were measured at `452795789`, and 12/12 match. With the ceiling at 0,
`WORKFLOW_TEMPLATES`, `getWorkflowTemplate` and its catalog source-A branch
(`host/index.ts`) are **deleted**, and `getWorkflowTemplate()` has left the D6 return
set. The D6 ceiling became a check that the catalog cannot return to that module.
`host/workflowTemplates.ts` now holds only `WORKFLOW_TEMPLATE_CHAIN_IDS` (44),
`restoreTemplateShape` and `registerWorkflowTemplateChains`. It no longer
contains a `WorkflowDefinition`. In-tree total 27 → **15** (all `openwop-app.agents.*`).

Consumers: none were changed. `seed-data/exampleAgents.json` (the ten twins'
portfolios + todo triggers) and `frontend/react/src/agents/roleTemplates.ts` bind
the same ids, now resolved chain-backed. `test/workflow-templates.test.ts` pins that
every id they bind is in the library. `AgentWorkflowPortfolioPanel` starts runs by
id through the workflow catalog, and `getChainBackedWorkflow` answers there.
(`features/documents` `tmpl.parameters…` hits are a local variable named `tmpl`,
not workflow ids.) The end-to-end consumer witness is
`test/agents-example-data.test.ts`: the heartbeat run of `tmpl.it.incident-triage`
completes through the pack. Sabotage: removing that chain from the pack fails it
(plus the scheduler `:trigger` case and the library/pack equality, 3 red); a new
in-tree definition source in source A fails the D6 return-set case; a seed
portfolio binding `tmpl.it.incident-nope` fails the consumer case.

### P2d — the 15 `openwop-app.agents.*`: BLOCKED on the measurement

**Measurement attempted 2026-10-10 ~12:20Z, read-only, and STOPPED: no safe route
exists without new credentials.** The release queue showed no deploy or certify
running (slot 10, a local train, was gating). What was checked:

- `GET /v1/runs?workflowId=<id>` (`routes/runs.ts`) filters across tenants only
  for a WILDCARD principal (`tenants: ['*']`). A superadmin cookie session is
  not one: `isSuperadmin` grants on an allowlist, but the run list still scopes
  to `req.tenantId`. A wildcard principal comes only from an
  `OPENWOP_API_KEYS` entry written `<key>:*` (ADR 0561), and prod runs with
  `OPENWOP_API_KEYS=""` (`middleware/auth.ts` docblock, DEPLOY.md). No HTTP read
  through the app can answer a cross-tenant count.
- No script under `scripts/` counts runs by workflow id.
- Direct SQL (the `scripts/job-search-prod-probes.sql` precedent: `gcloud sql
  connect … < file`) would answer it. That is a connection outside the app's pool,
  and it needs DB credentials this session does not hold. Not improvised.

**Access that would unblock it (operator's choice):**
1. *Preferred, one read-only DB connection:* an operator with Cloud SQL access
   runs, off-peak and not during a deploy or certify (the budget is 100
   `max_connections`, per the 2026-10-02 correction):
   `SELECT workflow_id, count(*) FROM runs WHERE workflow_id IN ('openwop-app.agents.lead-routing', …the 15 ids in host/exampleWorkflows.ts…) GROUP BY 1;`
   Match the EXACT 15 ids, not a `LIKE 'openwop-app.agents.%'` prefix:
   `seed-data/workforces.json` names other `openwop-app.agents.*` ids
   (`invoice-extract`, `triage-classify`, …) that are not among the 15.
2. *Through the app:* a temporary `<key>:*` entry in `OPENWOP_API_KEYS`
   (`scripts/update-env.sh`, which mints a revision), then 15 paginated
   `GET /v1/runs?workflowId=…&limit=200` reads, then remove the key. This is an
   env change and a cross-tenant credential, so it needs the user's approval.

> **MEASURED 2026-10-12 12:16Z — unblocked by access route 1, read-only.** The
> user approved the read-only run count. It ran through `cloud-sql-proxy` on the
> user's own gcloud login (DSN from Secret Manager `openwop-storage-dsn`), one
> connection, `default_transaction_read_only = on`, a 20 s statement timeout,
> after the hourly window and cleared with the release coordinator. Results:
>
> | Probe | Result |
> |---|---|
> | `runs` rows (floor: 25,913 runs over 130 workflow ids) | **0** for each of the 15 ids |
> | Same `LIKE 'openwop-app.agents.%'` query, grouped by id (non-vacuity) | 5 OTHER ids have runs (`invoice-post` 229, `claim-adjudicate` 16, `order-apply` 16, `triage-respond` 16, `po-route` 14): the `workforces.json` synthetic history (`seedWorkforceHistory`), none of the 15 |
> | `runs.inputs` / `runs.metadata` mentioning any id (sub-workflow parents) | 0 |
> | `workflows` table | empty (0 rows), so it proves nothing either way |
> | `user_agents`, `agent_run_activity` rows mentioning any id | 0, 0 |
> | `host_ext_kv` (196,839 rows) values mentioning the prefix | 6: five `workforce:*` rows (the 15 other workforce ids above) and **one `triggerbridge:sub` bound to `openwop-app.agents.lead-routing`** |
>
> That one subscription is an inbound stream connection's trigger in one
> `user:` tenant, `state: 'paused'` since 2026-07-06 and never fired (zero runs).
> It is not a replay reference: replay needs a run, and there is none. If it is
> ever resumed, its dispatch fails with workflow-not-found, which is the honest
> outcome for a demo workflow that no longer exists. It is left in place, not
> rewritten.
>
> So the replay law is satisfied by deletion. Implemented as below. Two items in
> the paragraph that follows turned out to be no-ops: `roleTemplates.ts` stopped
> copying these ids earlier (only its header comment still pointed at the
> module), and the `RunsIndexPage` demo list names `openwop-app.uppercase` and
> `openwop-app.approval-gate`, which are D6 ladder infrastructure ids, not any of
> the 15, so it stays. `exampleWorkflowsForRole` already returned nothing for
> every seeded roleKey (nine author `workflows[]`; Chief of Staff's role has no
> example), so the seed fallback becomes `[]` with no behaviour change, and
> `ExampleRoleKey` moves into `exampleDataSeed.ts`.

With zero references: delete the 15 and `exampleWorkflows.ts`. Otherwise migrate
them the P2a way (internal, byte-identical: archive, not dispose). Then delete
`exampleWorkflows.ts` (its `exampleWorkflowsForRole` backs `exampleDataSeed.ts`'s
legacy fallback), the frontend `roleTemplates.ts` hand-copy of those ids, and the
`RunsIndexPage` demo list. Either way, `getExampleWorkflow()` leaves the D6 return set.

| Phase | Commit | Witness |
|---|---|---|
| P2a | `0b45e04ec` | `test/work-twin-template-chains.test.ts`, `test/workflow-templates.test.ts`, `test/catalog-source-a-literal-ratchet.test.ts` |
| P2b | `452795789` | same three; ceiling 28 → 12 |
| P2c | `d29d18227` | same three + `test/agents-example-data.test.ts` (consumer run); catalog deleted, ceiling 0 |
| (ii) | — | answered by the user 2026-10-10: hidden (no code) |
| P2d | `966a04a28` (#4722) | `test/catalog-source-a-literal-ratchet.test.ts` (module must not exist; resolver absent from source A) + `test/agents-example-data.test.ts` (seed still seeds) |

## P4 implementation record (2026-10-12)

### `ARWF-11` — no agent-area edit silently overwrites another

**Mechanism.** Every write is a compare-and-swap against the row it read
(`DurableCollection.compareAndSwap` for roster + profile; a conditional
`UPDATE … WHERE <every editable column> IS NOT DISTINCT FROM <read value>` for the
SQL `user_agents` table, so no migration). A write that loses the swap re-reads and
re-applies its own change, so a concurrent write to another field is kept. On top of
that, each route returns a content version (`host/entityVersion.ts`: a hash of the
RFC 8785 canonical row) as `ETag` and as an `etag` body field (list rows have no
header), and accepts an optional `If-Match`. A version that moved is
`409 conflict`, `details.reason: 'stale_write'`, the app's existing convention for a
lost optimistic write (navigation-settings CHN-6). Omitting `If-Match` keeps the
old field-level behaviour, so no client breaks.

Decisions made while implementing:

- **Content hash, not `updatedAt`.** Two edits in one millisecond share an
  `updatedAt`, the heartbeat stamp deliberately does not move it, and
  `user_agents` has none. The roster version omits `lastHeartbeatAt`, so a
  heartbeat does not invalidate an open editor.
- **`recordHeartbeat`** re-reads and swaps, so a pause landing in its window is
  kept (the defect the ADR named).
- **Profile PUT merges.** An omitted editor field keeps its stored value; `null`
  clears, and so does `[]` for a list field (normalised to absent, so the stored
  shape matches a never-set field). Reading the SPA showed why this mattered now:
  the Guardrails panel did not resend `channels`, `adminControls` or
  `riskCompliance`, so **every Guardrails save wiped those three fields** under
  full-replace. The two profile panels now send only the fields they own, with
  explicit clears; the Voice panel sends `configParameters: null` when the voice
  is removed, because omission would now keep it.
- **The subsystem writers** (`setAgentMemoryScope`, `setAgentKnowledge`,
  `setAgentTwin`) moved from get→put to the same compare-and-swap, so they cannot
  overwrite a PUT that lands in their window either.
- **SPA.** `If-Match` is sent where an edit is built from a read copy: the details
  editor, the workflow portfolio, the assign-workflow modal and both profile
  panels. One-field toggles (enabled, avatar, autonomy) do not need it: the
  server-side swap already merges them. Appending a workflow re-reads and appends
  to the current list on a stale refusal (`appendRosterWorkflow`), so a workflow
  added elsewhere is not dropped. The instructions panel does not: its prompt
  editor never reads the stored prompt, so there is no version to send.
- **Not done:** workforce PATCH, listed under `ARWF-11` in the assessment but not
  in this ADR's P4 scope, still writes last-writer-wins.

  > **CORRECTED 2026-10-13 — workforce PATCH is now done (P4 follow-up).** Both
  > workforce edit routes take the same guard. `PATCH /workforces/:id` (cut-over
  > status) compare-and-swaps the tenant's status overlay, and its version is the
  > workforce **as that tenant sees it**, so another tenant's cut-over never
  > stales it. `PATCH /workforces/:id/migration` was a real lost update, not
  > only last-writer-wins: two stage saves racing on different `stageStatus`
  > keys each merged into the same read copy, and the second `put` dropped the
  > first. It is now a CAS loop, and its version ignores `updatedAt` (an unsaved
  > journey is minted fresh on every read). Both reads and writes return `ETag`
  > + `etag`; the overview and migration wizard send `If-Match`, explain a stale
  > refusal, and re-read. The production-graduation gate still runs first, so a
  > stale move back to `production` answers `cutover_not_eligible`, not
  > `stale_write`. Whether the
  Firebase `/api` rewrite forwards `If-Match` on PATCH/PUT is unmeasured; it strips
  `If-None-Match` on some conditional GETs (CDN hit-for-pass). The server-side
  swap holds either way. Verify after deploy.

  > **MEASURED 2026-10-13 03:35:55Z on `294a17d8a` (revision `00948-cpv`): the
  > rewrite forwards `If-Match` on PATCH.** Through `https://app.openwop.dev/api`,
  > in one throwaway anonymous session: create a user agent → `201`; PATCH with
  > no `If-Match` → `200` + ETag E1; PATCH with `If-Match: E1` → `200` + E2;
  > PATCH again with `If-Match: E1` → **`409 conflict`, `details.reason:
  > 'stale_write'`, `currentEtag: E2`**; DELETE → `204`. Only user-agent PATCH
  > was exercised. Roster PATCH and profile PUT go through the same rewrite, but
  > PUT was not measured.

### `ARWF-8` — the eval reads its agent and suite from the workforce

`runWorkforceLiveShadowEval` now takes the workforce and resolves both from it: the
suite is keyed by workforce id, and the agent dispatched is the workforce's
`role: 'supervisor'` member. A workforce with no suite (four of the five seeded),
or whose supervisor is not the agent the suite was written for, is refused with
`409` (`no_eval_suite` / `supervisor_mismatch`). Before, all five workforces were
scored by dispatching `host.priya` over the invoice suite. The eval run's fixed
`workflowId` (the suite id) is unchanged: the ADR 0823 ownership ratchet records it
as an eval record that executes no definition.

| Item | Witness (sabotage-checked: each goes red with its fix reverted) |
|---|---|
| roster CAS, heartbeat vs pause, If-Match | `test/adr0775-p4-stale-write-guards.test.ts` |
| profile merge + clears, subsystem-writer CAS | same file |
| `user_agents` conditional update | same file (SQLite); `test/adr0775-p4-user-agent-cas-postgres-live.test.ts` (Postgres: `OPENWOP_PG_TEST_DSN`, else testcontainers, else skip; run here on a PGlite socket server, and sabotage-checked per column) |
| HTTP: `ETag`, `If-Match` → 409, PUT merge/clear | `test/adr0775-p4-stale-write-http.test.ts` |
| SPA: If-Match sent, stale classified by reason, append re-reads, voice clears | `frontend/react/src/agents/__tests__/staleWriteGuards.test.tsx` |
| eval from the workforce | `test/workforce-eval.test.ts` |
| workforce status + migration CAS, If-Match, ETag (2026-10-13 follow-up) | `test/adr0775-p4-workforce-stale-write.test.ts`; SPA: `frontend/react/src/client/__tests__/workforcesIfMatch.test.ts`, `frontend/react/src/workforces/__tests__/workforceStaleWrite.test.tsx` |
| `If-Match` survives the Firebase `/api` rewrite (PATCH) | live probe, 2026-10-13, above (not a test; one prod run) |

## P3 implementation record

P3 is split, in order of risk: **P3a** the roster's off switch on every autonomous
lane, **P3b** `agentPolicyResolver` parity on those lanes, **P3c** the persona
scaffold and agent knowledge on the run path, **P3d** cross-instance registry
eviction. Viewer-aware write affordances are tracked with P3d.

### P3a — a paused agent does not run on its own (`ARWF-7`), 2026-10-15

MEASURED on `d3495f816` before the change: heartbeat (`heartbeatService.ts:562`),
"check now" (`routes/agentOps.ts:271`) and the kanban trigger
(`kanbanTriggerDelivery.ts:91-98`) honoured `enabled:false`. Nothing else did. The
schedule daemon's `fireJob` gated on the job's own `enabled`, the feature toggle,
the acting person and the budget, never the agent; scheduled chats, follow-ups,
recurring follow-ups, scheduler-route jobs and KickBot jobs all fire through it.
Approving a paused agent's proposal checked only that the member still existed
(`approvalDecision.ts:637`).

- **One verdict.** `host/autonomousDispatchPolicy.ts` `autonomousDispatchVerdict(tenantId,
  ref)` resolves a rosterId or a registry agentId (reverse lookup) and re-reads the
  row with `getRosterEntry`, not the 30 s reverse cache, so a pause takes effect
  on the next fire. A ref that is not a roster agent is allowed. P3b extends this
  same verdict with the policy resolver.
- **Schedules.** `fireJob` asks it for `jobAgentRef(job)` (rosterId, then agentId,
  then `configurable.agentId`, which is where follow-ups and scheduled chats name
  the agent) and skips the slot as the new `agent-paused` reason. Non-destructive,
  like `actor-inactive`: the job stays enabled and resumes with the agent. Run now
  is gated too, matching "check now". The SPA's schedule panels name the reason
  in en/es/fr/pt-BR.
- **Approvals.** Claiming a paused agent's run proposal is `409 conflict`,
  `details.reason: 'agent_paused'`, checked before the claim lock, so the approval
  stays pending and can be approved once the agent is resumed.
- **Not changed.** User-initiated chat and @mention (the test pane), the heartbeat
  and kanban gates (already correct), and trigger ingestion, which starts a
  workflow rather than an agent; an agent pinned inside such a workflow is P3b's
  agent-runner gate.

| Item | Witness (sabotage-checked: red with the fix reverted) |
|---|---|
| `fireJob` skips a paused agent named by rosterId, agentId or `configurable.agentId`; resumed it reaches dispatch; a job with no roster agent is ungated | `backend/typescript/test/adr0775-p3-autonomous-dispatch-paused.test.ts` (gate off: 3 red) |
| claim of a paused agent's proposal is 409 `agent_paused` and leaves it pending | same file (check off: 1 red) |
| SPA names `agent-paused` instead of "unrecognized" | `frontend/react/src/schedules/__tests__/SubjectSchedulesPanel.states.test.tsx` (map entry off: red) |

### P3b — explicit per-workflow rules on schedules (`ARWF-13`, policy half), 2026-10-15

> **DECISION (user, 2026-10-15): "explicit rules only."** The P3 row above says the
> `agentPolicyResolver` rules apply on every autonomous entry. Read literally, that
> would make every schedule of an agent at `review`/`guided`, with an allowlist, or
> missing a connection stop running and file an approval on every slot. Three
> options were put to the user; they chose the middle one. The two rules a person
> wrote down for a NAMED workflow apply on every schedule lane; the autonomy
> level, the `withinPolicyActions` allowlist and the connection-readiness hold stay
> heartbeat-only, because they govern what an agent picks up by itself and a person
> who created a schedule already authorized it.

- **One resolver.** `autonomousDispatchVerdict(tenantId, ref, actionClass)` calls
  the heartbeat's own `resolveAgentPolicy` with the job's `workflowId` as the action
  class and acts only on its `permissions.never` and `hitl` reasons, so the two lanes
  cannot disagree about what those lists mean.
- **`permissions.never`** — the slot is skipped as `policy-denied`. Nothing is
  proposed, matching the heartbeat's fail-closed deny.
- **`hitl`** — the slot files ONE pending run proposal carrying `scheduleJobId`
  (later slots find it and add nothing) and is skipped as `awaiting-approval`.
  Claiming it fires the job through `fireJob` itself (`approvedProposalId` satisfies
  only the hold), so the run carries the job's inputs, acting person and attribution
  exactly as an unheld fire would; an approved proposal never loses them by going
  through the bare `startWorkflowRun` lane. A fire that skips for another reason
  (the agent was paused since) re-opens the approval and answers `409` with the
  skip, so it is never stranded approved with no run.
- **SPA.** Both reasons are named in the schedule panels (en/es/fr/pt-BR).

| Item | Witness (sabotage-checked) |
|---|---|
| never → `policy-denied`; hitl → one pending approval across slots; claim fires the job (its `lastRunId` is the run); paused since → 409, still pending; agent at `review` with no listed rule still runs | `backend/typescript/test/adr0775-p3b-explicit-policy-on-schedules.test.ts` (never off: 1 red; hitl off: 2; dedupe off: 1; claim-fires-job off: 1) |
| SPA names both reasons | `frontend/react/src/schedules/__tests__/SubjectSchedulesPanel.states.test.tsx` |

### P3c — the agent's own knowledge on the run path (`ARWF-13`, knowledge half), 2026-10-15

MEASURED on `d3495f816` before the change: `agentRunnerNode` passed no
`knowledgeRetrieve`, so an agent answering a schedule, a follow-up or a heartbeat
fallback ran without the knowledge it cites in chat and on the ad-hoc dispatch lane.

- **The runner composes it.** `agentRunnerNode` calls
  `resolveAgentKnowledgeRetrieve(tenantId, profileId, createAgentMemoryPort(tenantId))`
  with the RESOLVED profile id (for a roster agent, the rosterId) and hands the
  result to the turn, the same resolver chat uses. It is fail-soft: a resolver
  fault leaves the turn without a knowledge block, never a failed run.
- **Deliberately NOT applied: the chat persona scaffold.** Its lines describe a chat
  surface (a person on the other side, a conversation to continue), and they would
  be false on a run. The ADR's P3 row named it; reading it showed it does not fit
  this lane, so the row's "persona scaffold" clause is withdrawn, not deferred.
- **Not enabled: memory writes from the run lane.** The port is read-only here;
  cross-run memory writes remain a follow-up.

| Item | Witness (sabotage-checked) |
|---|---|
| the runner asks with the resolved profile id and the returned knowledge reaches the model; a resolver fault still succeeds | `backend/typescript/test/adr0775-p3c-runner-agent-knowledge.test.ts` (wiring off: red) |

### P3d — cross-instance registry eviction (D5 H2), 2026-10-15

Before: deleting or editing a user agent dropped it only from the in-process
registry of the instance that served the request; every other instance kept serving
the old agent until it restarted.

- **The message.** `host/agentRegistryEviction.ts` publishes
  `{tenantId, agentId, origin: INSTANCE_ID}` on `agent-registry:evict` through the
  existing host-ext pub/sub (LISTEN/NOTIFY on Postgres). It reuses the
  `openwop_host_ext` LISTEN connection the boot subscription already holds, so it
  opens 0 new connections and Gate 5's budget does not move. A listener started at
  boot drops the named agent unless the message is its own; the next resolve
  re-reads storage.
- **Who sends it.** User-agent `DELETE` and `PATCH`, and the roster cascade when it
  removes the member that owns a user agent.
- **The backstop for a missed message.** A user-agent copy older than
  `OPENWOP_USER_AGENT_REGISTRY_TTL_MS` (default 5 min) is re-read on its next
  `resolve()`: edited → the stored record, deleted → gone. A storage FAULT during
  that refresh keeps the old copy rather than unregistering a live agent.
- **Not witnessed: two real instances.** The tests drive one process, and a message
  with a foreign `origin` is exactly what a peer sends, but no automated test runs
  LISTEN/NOTIFY across two processes.
  > **CORRECTED 2026-10-16 (P3e):** now witnessed across two Postgres CONNECTIONS
  > (two storages, one process) on real Postgres; see P3e item 3. Still not two
  > processes: the registry is process-global, so one process cannot hold two of
  > them, and the connection is the part the in-process test could not reach.

| Item | Witness (sabotage-checked) |
|---|---|
| a peer's message evicts, this instance's own and malformed ones do not; the booted listener evicts and the next resolve reads storage; DELETE, PATCH and the roster cascade broadcast; the TTL re-read and the fault-keeps-copy rule | `backend/typescript/test/adr0775-p3d-agent-registry-eviction.test.ts` |

### `ARUX-18` — the workspace's edit panels are read-only for a viewer, 2026-10-15

The Instructions, Guardrails, Voice and workflow-portfolio panels each read
`useAgentWriteAccess()` and render read-only for a viewer, with one
`agents:viewerPanelReadOnly` line (en/es/fr/pt-BR), instead of offering an editor
that learns of the backend's `403` only on save. The backend refusal was already
there and is unchanged (`roster.ts`, `userAgents.ts`, `agentProfile.ts`; witnessed by
`backend/typescript/test/agents-write-authority.test.ts`).

| Item | Witness (sabotage-checked) |
|---|---|
| each panel as a viewer has no write control; the same panel as an editor has it (the control half, so a pass is never "the control was never there") | `frontend/react/src/agents/__tests__/viewerReadOnlyPanels.test.tsx` |

| Phase | PR | Merge |
|---|---|---|
| P3a | #4836 | `e725a029e` |
| P3c | #4842 | `5625c793e` |
| P3d | #4846 | `a5eeffe89` |
| `ARUX-18` | #4851 | `6dfe4a5e5` |
| P3b | #4859 | `6a90b8da6` |

All four rode slot 96: one gate, green on the train tree `382d00b72`, hand-merged
after `main` moved by two disjoint PRs mid-gate (the tree on `main` after the merges
differs from the gated tree by exactly those PRs' 8 files).

### P3e — the agent acting on its own inside a workflow, and its memory there, 2026-10-16

The three follow-ups P3a–P3d left open.

**1. The agent-runner gate (`ARWF-7`/`-13`, the lanes that start a WORKFLOW).**
MEASURED on `6a90b8da6`: eight lanes start a run with no person in the loop, and
only the schedule daemon asked `autonomousDispatchVerdict`. Heartbeat and the kanban
column trigger check `enabled` themselves; trigger-bridge ingestion, its route,
host-event bindings, inbound connection webhooks and the kanban work-item daemon
checked nothing. Gating each of them would be five copies, and none of them knows
which agent the workflow will run. The agent-runner node does: it is where the agent
acts. So the gate is there, once.

- **When.** The run has no acting person (`ctx.actingUserId`) and the node no
  conversation. That is the agent acting on its own. A run a person started, and a
  reply to a person's channel post (which carries its conversation), stay ungated:
  the test pane, as chat is.
- **What.** The same verdict the schedule lane uses, with the run's workflow as the
  action class. `ctx.workflowId` is new on the node context for this (declared
  `run-context` in `EXECUTOR_CTX_POLICY`). A paused agent fails the node
  `agent_paused`, a workflow on its `never` list `policy_denied`, both
  `retryable: false`.
- **Not applied: `hitl`.** On a schedule it holds the slot before the run exists;
  here the run already exists, so honouring it means suspending the run for an
  approval. That is a separate decision, not taken. A `hitl` workflow started by a
  trigger runs as it did before.

  > **Superseded by P3f (below), same day.** The decision was taken: the node pauses
  > on the engine's approval interrupt. A `hitl` workflow started by a trigger no
  > longer runs without one.

**2. Cross-run memory on the run lane.** The dispatch now gets the agent's memory
port and scope (`agentMemoryScope(profileId)`, the chat lane's), so an agent that
opts in (`memoryShape.longTerm`, the chat lane's gate) reads prior memory and
records its turn on a run as it does in chat. Three things differ, through a new
`memoryWrite` option, because a run is not a chat turn:

- **Always untrusted.** A chat summary is trusted unless the turn read untrusted
  knowledge. A run's TASK may itself be a webhook or event payload nobody vetted,
  and the summary quotes the task, so a trusted run summary would launder that
  payload into the agent's trusted memory, recalled in the next chat. Recall fences
  every run summary.
- **One entry per run node.** The id is `run:<runId>:<nodeId>`, an upsert, so a
  crash-resume re-execution rewrites its entry instead of adding a second. A node
  that runs several times in one run (a loop) keeps its latest turn.
- **Nothing on a replay.** The node is deliberately unclassified (borrowed recall
  must re-resolve on `:fork`, see the comment above its dispatch), so a replay
  re-executes it; the write checks `currentEffectContext().replaying` and skips.

**3. The two-instance LISTEN/NOTIFY test P3d did not have.** A live test opens two
Postgres storages (two pools, two LISTEN connections) against one database: a
NOTIFY sent on B evicts on A, and A's own message, delivered over the wire, does
not. It runs on `OPENWOP_PG_TEST_DSN` or a testcontainer and skips otherwise.
MEASURED that PGlite cannot run it (it delivers a NOTIFY only to the sending
connection); a real Postgres 17 from the `embedded-postgres` npm package did.

| Item | Witness (sabotage-checked) |
|---|---|
| paused → `agent_paused`, resumed runs; a person's run is ungated; `never` → `policy_denied`, another workflow runs; `hitl` → see P3f | `backend/typescript/test/adr0775-p3e-runner-autonomy.test.ts` (gate off: 2 red) |
| the run's `workflowId` reaches the node through the executor: a never-listed workflow fails the RUN | same file (`workflowId` off the executor ctx: 1 red) |
| one untrusted summary per run node, upserted on re-execution, a new run adds one, none on replay, none without the opt-in | same file (untrusted off: 1; id off: 1; replay skip off: 1; port not passed: 1) |
| a NOTIFY from another instance evicts, this instance's own does not | `backend/typescript/test/adr0775-p3d-eviction-postgres-live.test.ts` on embedded Postgres 17 (origin filter off: red; eviction off: red) |

### P3f — `hitl` on a workflow a trigger started, 2026-10-16

P3e left one rule unapplied on the run lane: an agent's `hitl` list (a workflow a
person wrote down as "ask me first"). A trigger, webhook, event binding or kanban
item that started that workflow ran it with no one asked, so the rule held on a
schedule and was silently skipped on every other lane. The user delegated the
decision ("make a decision based on deep research"). Decided: **apply it, by pausing
the agent-runner node on the engine's approval interrupt.**

**Options weighed.**

| Option | Why not / why |
|---|---|
| Leave it (runs proceed) | A rule a person wrote down is ignored on four of five lanes, invisibly. The P3b decision ("explicit rules only") applies exactly these rules, so skipping one was a gap, not a policy. |
| File a `run-proposal` and fail the node (the schedule lane's shape) | Approving starts a NEW run, re-executing every node before the agent's, side effects included, and the trigger payload (`triggerData`) is not carried by a proposal's `configurable`. Right for a schedule, where the run does not exist yet; wrong once it does. |
| **Pause the node (`ctx.suspend`, kind `approval`)** — chosen | The run keeps its prefix and its trigger payload. The primitive already exists and is what `core.approvalGate` and `core.email.send` use: durable, re-entered with the resolution on the same key, resolved only through the ONE resolve path (`routes/interrupts.ts`, `approvals:respond` + run-tenant ownership), expired fail-closed by the gate timeout, and listed in the unified review inbox (ADR 0068) beside the schedule lane's proposals, so a person sees both lanes' requests in one place. |

**Not the ADR 0189 precedent.** Headless runs never suspend for *connect-to-continue*
or *send-as-you*, because only the acting person can answer those. An agent's
`hitl` is a workspace decision anyone with `approvals:respond` may make, which is
what `core.approvalGate` already asks of headless runs every day. So no
`approverRefs` are set.

**Behaviour.**

- Same gate condition as P3e (no acting person, no conversation); same verdict.
- `needs-approval` → `ctx.suspend({kind:'approval', key:'agent-hitl:<rosterId>', actions:['approve','reject'], prompt})`. The run goes `waiting-approval`.
- Resolved `approve`/`accept` → the node re-enters and the agent acts. Anything
  else (reject, or the timeout's fail-closed reject) → failure `approval_rejected`,
  `retryable: false`.
- No suspend surface on the context → failure `approval_required`, never a silent run.
- One approval per node per run execution: a loop that revisits the node in the
  same execution reuses it (the executor keeps the resolution for that node).
- A `:fork` mints a new run, so it asks again (the `core.email.send` fork posture).

| Item | Witness (sabotage-checked) |
|---|---|
| hitl pauses before the agent acts; approve/accept act; reject → `approval_rejected`; no surface → `approval_required`; another workflow, or a person's run, does not ask | `backend/typescript/test/adr0775-p3e-runner-autonomy.test.ts` (gate off: 4 red, controls green) |
| through the executor: the run goes `waiting-approval`, the interrupt is listed, a reject through `POST /runs/:runId/interrupts/agent` fails the run `approval_rejected` | same file |


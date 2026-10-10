# ADR 0832 — An org-membership floor at the feature-surface seam

Status: Accepted (implemented on `fix/org-scope-seam`; flips to implemented on merge)

Related: ADR 0830 (KB org scope; this ADR is its residue **R1** and **R8**), ADR 0818 §4
(media's run-lane org check), CMNT-4 (`assertOrgScope`, the one org-scope predicate),
ADR 0014 (the `featureSurfaces` seam and its toggle gate), ADR 0027 (always-on surfaces),
ADR 0024 §4 (`actingUserId` on the run), ADR 0627 D3 / ADR 0822 D1 (`personalTenant`, the
precedent for a reserved, host-stamped run key threaded into the surface scope), ADR 0589
§D2 (why a channel turn carries no acting user), ADR 0324 (the one tool-scope composer).

> **Order of work.** The probe ran first, against unmodified `origin/main` source
> (`97baad74b`): `test/adr0832-org-scope-seam-probes.test.ts`, **11 refusal legs RED**
> (six reads, three writes, the undeclared pseudo-org leg, the R8 leg) and **5 controls
> green** (same org, the owner, a system run, a method with no `orgId`, KB's `_team` /
> `_kickbot`). Each leg is its own test, so one red does not hide the next.

## Context

`ctx.features.<id>` is how a workflow node reaches a feature's data. A feature registers
a builder; `buildFeatureSurfaces(scope)` builds every surface for one run and wraps each
method in `gate()`, which checks the feature toggle and plan. The file states the
security model: *"A run is tenant-trusted; per-subject RBAC is the deferred authority
refinement."*

Most surfaces take `orgId` from node args and pass it to a service that keys on
tenant + org. Nothing asks whether the run's person belongs to that org. The HTTP doors
for the same data all do (`requireOrgScope`), so the same member who gets a 403 at
`/crm/orgs/B/companies` got org B's companies from `ctx.features.crm.listCompanies({ orgId: B })`,
and could write into org B the same way. ADR 0830's grep found 31 of 34 org-taking
surfaces ungated and pinned 30 of them (`UNGATED_ORG_SURFACES_PINNED`). The grep is also
blind to a surface whose parameter is not literally named `args` (`job-search` takes
`input.orgId`).

Two more facts shape the fix:

- `gate()` **skips always-on surfaces entirely** (ADR 0027: no toggle default ⇒ return the
  raw surface). `cms` and `kb` are always-on, so a toggle-path-only fix would miss them.
- **R8.** Some runs are caused by a person but carry no `actingUserId` on purpose. A
  channel post that @mentions an agent starts a system-fired turn, because the poster must
  not become the twin-recall audience or the credential owner (ADR 0589 §D2). The kanban
  "Run" button and the WorkItem daemon start runs the same way. "No actor ⇒
  tenant-trusted" then applies to a run that a specific member caused.
- **The /architect pass widened R8 (B1, B2).** Three more lanes run actorless while a
  member chose the workflow and its `orgId`: every **sub-workflow child**
  (`subWorkflowDispatcher.ts` builds the child row with no actor, so nesting a chain
  stepped around any floor), **host-event trigger fires**, and **composed-workflow
  approval launches**. Inbound webhooks are the fourth, with no durable author.

**Prod sizing (orchestrator, read-only, 2026-10-05):** latent. 23 org rows across 418
tenants; the one tenant with two or more orgs had no subject outside its orgs. No hotfix.

## Decision

### D1 — The floor lives in `gate()`, for every surface

`gate()` wraps every method of every surface, toggled and always-on. For an always-on
surface it skips only the toggle check. Order per call:

1. the toggle + plan check (toggled surfaces only, unchanged);
2. the **org floor**: if the run has an org-scope subject (D3) and `args.orgId` names an
   org (anything but `undefined`, `null` or `''`, which all mean "none"), it must be a
   string (else `validation_error`: `campaign-intel` ran `String(args.orgId ?? '')`, so
   `['B']` became `'B'`), and the
   subject must pass `assertRunOrgScope(tenantId, subject, orgId, scope)`, where `scope` is
   `workspace:read` unless the surface declared a stronger one for that method (D2);
3. the surface method, called with the same shallow copy of `args` the floor read, so an
   accessor cannot answer the floor with one org and the method with another.

A pass is memoised per (scope, org) for the bundle (the executor builds one per node), so
a node that loops over one org resolves membership once, across surfaces. Only passes are
cached; a storage error is retried, not remembered; a membership removed while a node runs
is seen from the next node on. Every refusal is logged (`surface_org_floor_refused`:
surface, method, lane `actor`/`cause`, code, tenant, run), so an operator can see which
existing automations the floor stops.

`assertRunOrgScope` is the one predicate (ADR 0830 D1). Its semantics carry over unchanged,
including the two pass lanes:

- no subject ⇒ no check (an inbound webhook, a feature-owned system job). **Correction
  (review S5):** the first draft said schedules have no person. They do: the scheduler
  route stamps `actingUserId` from the creator and the daemon carries it onto every fire
  (ADR 0816 D8), so the floor checks a scheduled run against its schedule's creator;
- the workspace-root id (`orgId === tenantId`) of a single-principal tenant: a personal
  `user:`/`anon:` tenant, and `default` **in demo mode only**. Prod runs
  `OPENWOP_DEMO_MODE=true`, so prod `default`-tenant runs keep their current behaviour.

`workspace:read` is a **membership floor**, not the write authority. Every built-in role
holds it (`VIEWER_SCOPES` included), so it answers "is this person in this org at all".
A viewer's run can still write through a surface that does not ask for
`workspace:write` itself. The seam cannot tell a read method from a write method; see
Residue S-W.

An absent org is a uniform `not_found` and a missing scope is `forbidden_scope`, the same
errors and order as the HTTP doors (existence first, so a foreign org never leaks).

### D2 — Exceptions are declared by name, per surface, never inferred

KB files managed collections under two tenant-level namespaces, `_team` and `_kickbot`
(`TENANT_SCOPED_KB_ORGS`). They have no org row and no members. The floor must pass them on
`kb` and nowhere else.

`registerFeatureSurface(id, build, orgPolicy)` takes a `FeatureSurfaceOrgPolicy`, which
`FeatureModule.surface.orgPolicy` carries:

- `tenantScopedOrgs`: `kb` declares `TENANT_SCOPED_KB_ORGS`; nobody else declares any.
- `methodScopes`: a method whose HTTP door needs more than membership. Review S3 found one
  read: `kicktodo-organizations.report` is `host:org:manage` at its door
  (`kicktodo-organizations/routes.ts`), so the surface declares
  `{ report: 'host:org:manage' }`. Every other org-taking read's door is `workspace:read`
  (inventoried in the review); surfaces that enforce more themselves (orgs invitations,
  sales-commissions statements, production prices) keep doing so after the floor. `crm.listCompanies({ orgId: '_team' })` is refused like any unknown
org, and the probe pins this. "No org row ⇒ allowed" never appears: an unlisted `_x` is a
`not_found`.

### D3 — R8: a read-only org-scope subject on the run

A new reserved run-metadata key, **`orgScopeSubject`**, records the member who caused an
actorless run. It **narrows and never grants**:

- **Consumed only by membership floors:** the D1 seam floor, the KB and media surfaces'
  own `assertRunOrgScope` calls, and the org filter in `tenantRetrieve`. The `subject` filter
  in `tenantRetrieve` (project-bound collections, KBC-1) does **not** read it, because that
  filter can widen what a run sees, and a channel reply is visible to the whole channel.
- **Never consumed** by anything keyed on `actingUserId` as an identity: credentials and
  connections, twin recall (`resolveBorrowedRecall`), the chat-tool action/read gates
  (`resolveReadOrgScope` already returns empty for an actorless turn), CMS translator
  grants, attribution. A run with `orgScopeSubject` and no `actingUserId` is still a system
  run for every purpose except "which orgs may this run touch".
- **Precedence:** `actingUserId ?? orgScopeSubject`. A `:fork` re-stamps `actingUserId` to
  the forking caller, which then wins.
- **Reserved:** added to `RESERVED_RUN_METADATA_KEYS`, so neither a client body nor a
  `startWorkflowRun` caller's metadata can set it. It is stamped only from
  `startWorkflowRun`'s explicit `orgScopeSubject` parameter, after the strip.
- **Threaded** like `personalTenant` (ADR 0822 D1): executor → `BundleScope.orgScopeSubject`;
  the conversation tool loop → `createScopedAgentToolProvider` → the tool `BundleScope`
  (so an agent's `knowledge.search` in a channel turn is filtered by the poster's orgs).

Stamped on:

| Lane | Subject |
|---|---|
| Channel post that addresses an agent (`channelAgentDispatch.ts`) | the poster (`authorUserId`, already required for a turn) |
| Kanban WorkItem **manual Run** (`routes/kanban.ts`) | the caller who pressed Run (`callerSubject(req)`) |
| Kanban WorkItem **daemon** (`kanbanWorkItemDelivery.ts`) | `KanbanWorkItem.requestedBy`, a new field stamped at materialize time from the materializing run's `runOrgScopeSubject` (from the scope, after the args spread, so a node cannot forge it). Not part of the work identity; not projected. Items filed before this ADR have none and stay system runs. |
| Sub-workflow child (`subWorkflowDispatcher.ts`, review B1) | the parent row's `actingUserId ?? orgScopeSubject`, spread after the handoff metadata. Recursive: a grandchild inherits through an actorless parent. |
| Cross-canvas invoke child (`canvasSurface.ts`) | the invoking run's `runOrgScopeSubject` |
| Host-event trigger fire (`hostEventDispatcher.ts`, review B2) | `HostEventBinding.createdBy`, the principal that armed it (`'anonymous'` is skipped). This equals the member key on the cookie lane; a bearer-created binding's `user:`/`oidc:` principal is not a member key and **fails closed** at the floor. |
| Composed-workflow approval launch (`workflowComposeTool.ts`, review B2) | the approver (`decidedByUserId`, already required and checked for `workspace:write`) |

`assertRunScopeOrg(scope, orgId, scope)` (`accessControlService.ts`) is the one call the
seam floor and the KB and media surfaces make: the actor if there is one, else the causing
member **as a cause**, which `assertRunOrgScope` answers by membership only. The
personal-tenant owner short-circuit keys on the tenant's SHAPE, not on who owns it, so for
a cause it would pass every member of a shared personal workspace for every org in it
(grade `M1`; a personal tenant with 13 subjects exists in prod). `runOrgScopeSubject` is
the plain `actingUserId ?? orgScopeSubject` value, used for `KanbanWorkItem.requestedBy`. A static test holds every file that mentions the field to a reviewed list.

### D4 — The ratchet becomes a no-growth guard on what the seam cannot see

The seam closes every `args.orgId` method, so `UNGATED_ORG_SURFACES_PINNED` empties and is
removed. ADR 0830's ratchet is rewritten to pin:

- `gate()` applies the floor on both the toggled and the always-on path (the probe
  witnesses it behaviourally on `cms` and `kb`, which are always-on);
- a **no-growth list of surfaces where an absent `orgId` means the whole tenant**
  (`optStr(args.orgId)` / `args.orgId ?? …` into a service whose filter is
  `!orgId || row.orgId === orgId`): `brand`, `campaign-brief`, `campaign-connectors`,
  `campaign-intel`, `campaign-orchestration`, `priority-matrix`. The floor cannot see a
  missing argument. Residue S-A.

## Alternatives weighed

- **Per-surface asserts (30 edits).** Rejected. This is how the class grew to 30: each
  surface had to remember, and 30 did not. It also leaves always-on and future surfaces to
  memory. Surfaces that already assert (kb, media, comments, orgs) keep their stronger
  checks; the floor runs first and is idempotent with them.
- **The seam floor (chosen).** One predicate at the one place every node reaches a
  feature. The cost is that read and write look the same at the seam, so the floor is
  membership (`workspace:read`), not write authority.
- **Refuse actorless runs on org-taking methods.** Rejected. Webhook-triggered and
  feature-owned system chains are a main automation shape for CRM, email and campaigns,
  and they have no person to check. ADR 0830 rejected the same thing for KB reads. (D3
  instead gives every actorless lane that a member DOES cause a narrowing subject.)
- **Stamp the causing person as `actingUserId` (R8).** Rejected. That grants: twin recall,
  the person's connections and credentials, and the action gates. ADR 0589 §D2 refuses it
  for channel turns for that reason.
- **A run-scope subject alone, without the seam floor.** Rejected as insufficient. It
  answers R8 only; the floor is still needed for runs that do carry an `actingUserId`, which
  are most of them.

## Matrix

| Dimension | Disposition |
|---|---|
| Feature-package boundaries | Host-only: `featureSurfaces.ts`, `accessControlService.ts`, run start and the executor. `kb/feature.ts` declares its namespaces through the `FeatureModule.surface` field. No feature→feature import. |
| Toggle / paywall | Unchanged; the toggle check still runs first, so a disabled feature still answers `host_capability_disabled`. |
| Workflows | No definition changes. **Behaviour change:** a node naming an org its run's person is not in now fails with `forbidden_scope` (or `not_found` for an org that does not exist in the tenant). This includes scheduled runs (checked against the schedule's creator), event-trigger fires (the trigger's author), approved composed workflows (the approver), channel turns (the poster), kanban runs (the clicker or requester) and nested chains (the parent's person). A present-but-unusable `orgId` is now a `validation_error` on runs with a person. |
| Node / agent packs | None changed. |
| AI exchange lanes | Chat tools unchanged (they already fail empty without an actor). `knowledge.search` in a channel turn is now filtered by the poster's orgs. |
| RBAC | Membership floor on the workflow-surface lane, matching the HTTP doors' `workspace:read` minimum. |
| Replay / fork | No new events or clock reads. A `:fork` re-executes nodes after `fromSeq` live and checks them against the forker (`actingUserId` is re-stamped to the forking caller and wins over a copied `orgScopeSubject`); recorded side-effect outputs are served, not re-called. A redrive strips `orgScopeSubject` (reserved) and carries the redriving caller as actor. |
| RFC gate | None needed. `orgScopeSubject` is host run metadata, not wire. Host-extension surfaces only. |
| Data | No migration. Existing run rows have no `orgScopeSubject` and behave as before. |

## Phases

| Phase | What | Witness |
|---|---|---|
| P0 | Probe RED on `97baad74b` | `adr0832-org-scope-seam-probes.test.ts` (11 red / 5 green) |
| P1 | D1 + D2 seam floor | the same probe green; sabotage (floor removed) ⇒ red |
| P1 | (cont.) | `kicktodo-organizations.report` scope leg; non-string `orgId` leg; accessor leg (sabotage: pass the raw args ⇒ red) |
| P2 | D3 `orgScopeSubject` | `adr0832-org-scope-subject.test.ts` (stamping, reserved strip, sub-workflow and grandchild, WorkItem `requestedBy`, the toggle resolver never sees it, the reader allowlist), `adr0832-kanban-delivery-subject.test.ts`, `channel-dispatch-integration.test.ts`, the probe's KB leg. Sabotage-red each: KB filter ignoring the field, the dispatcher not stamping, the key not reserved, `resolveOne` reading the cause |
| P3 | D4 ratchet rewrite | `adr0830-kb-ratchets.test.ts` |

Two existing fixtures named a person who was not in the org, which the floor now refuses
before the gate those tests are about: `cms-chain-execution` (the translator is now an org
member, as the HTTP editor path already required) and `kb-reindex-scheduled-drain` (the
human is now the org's owner, so the leg still reaches the structural reindex gate).

## Adversarial `/architect` pass (2026-10-05, before code)

3 Blockers, 8 Shoulds, 6 Nits. All against this ADR's first draft.

| Finding | Disposition |
|---|---|
| **B1** sub-workflow children are actorless, so a nested chain stepped around the floor | Fixed: the dispatcher stamps the parent's person (D3); canvas children too |
| **B2** a member authors the workflow and its `orgId`; triggers, webhooks, composed approvals and the WorkItem daemon fire with no subject | Fixed for triggers (author), approvals (approver), the daemon (`requestedBy`). Webhooks have no durable author: residue R8-webhook |
| **B3** R8-anon's premise was false: a widget grant needs `workspace:write` in ONE org, but the anonymous turn reads the whole tenant | The draft's "decided" disposition is withdrawn. Reopened as residue R8-anon (`KBCD-6`), not closed; the lane is off by default (`OPENWOP_ANON_ACTOR_ENABLED`) and does not reach this seam |
| S1 a non-string `orgId` skipped the floor and a coercing surface read it | Fixed: `validation_error`; args snapshotted |
| S2 every check scans the member, role and group stores | Mitigated: per-bundle memo of passes. A tenant-indexed member read is a host-wide improvement, filed |
| S3 `kicktodo-organizations.report` is owner-only at its door | Fixed: `methodScopes` (D2) |
| S4 id-addressed methods include reads and were not inventoried | Inventoried below (S-I) |
| S5 "schedules have no person" was false | Corrected in D1; behaviour change recorded in the Matrix |
| S6 the poster's orgs are wider than a channel's audience | Residue R8-audience (narrower than before, so not a regression) |
| S7 R8 could grant through `resolveOne` or the KB subject field | Separate fields; both pinned (`never a grant` tests) |
| S8 the probe accepted 404 where org B should be 403 | Fixed: exact codes per leg |
| Nits: replay wording, fork vs redrive, `orgId === tenantId` roots with no org row, swallowed errors, expected fixture reds | Replay/fork wording corrected; roots: see R-root; the two fixture reds are listed under Phases |

Verified true by the reviewer: `gate()` skipped always-on surfaces; every built-in role holds
`workspace:read`; `resolveReadOrgScope` returns empty for an actorless turn; no surface spells
the org key differently (`job-search`'s `input.orgId` is the same key).

## `/grade-code` over the implementation (2026-10-05)

**A−, 0 Blockers.** Every finding fixed except where noted.

| Finding | Disposition |
|---|---|
| M1 the personal-owner short-circuit passes ANY subject in a `user:`/`anon:` tenant, so the floor did not narrow a cause there; and the ADR's "same predicate as the HTTP doors" is false there (`requireOrgScope` passes no personal ctx) | Fixed for the cause arm (membership only; sabotage-red). The actor arm keeps ADR 0830's behaviour: residue R-personal |
| M2 refusals were silent | Fixed: logged per refusal |
| L1 the memo was per surface | Fixed: one per bundle |
| L2 `orgId: null` counted as absent, and `String(null ?? '')` reads every org | First fixed (only `undefined` absent), then **reverted by the first gate** (WF-FORM-2, below): `null`/`''` mean "no org" to every surface, so they are absent and the tenant-wide read they cause is S-A |
| L3 a handoff record could name a system child's subject | Fixed: reserved keys stripped from `childMetadata` |
| L4 `requestedBy` was echoed into the node's outputs | Fixed: stripped from the materialize result |
| L5 no witness for a system run forging `requestedBy` | Added |
| L6 orgs surface: a cause now gets `forbidden_scope` before its `no_acting_user` | Accepted (both refuse) |
| L7 a memoised pass outlives a mid-node membership removal | Stated in D1 |

## First gate (2026-10-06, `75ab2be40`) — 10 reds in 4 files, each dispositioned

The full gate was red with real failures, all end-to-end chain executions. Every one was
run solo before and after the fix (before: the gate log's reds reproduced solo, each with a
`surface_org_floor_refused` line naming the lane; after: 58/58 across the four files plus
the ADR 0832/0830 suites). None was fixed by weakening the floor.

| File (reds) | What the floor refused | Disposition |
|---|---|---|
| `crm-chain-execution` (1) | `crm.createTask`, lane `cause`, `forbidden_scope`: the event binding was authored by the literal `'test'`, a subject in no org | **Fixture.** The binding is now authored by the org owner's userId, which is what `POST …/host-events/bindings` stamps on the cookie lane (`createdBy: principalOf(req)`). A trigger whose author is in the org keeps firing; one whose author is not is refused, which is D3 working |
| `forms-intake-chain-execution` (3 of 4) | `forms.getSubmission`, lane `cause`, `forbidden_scope`: same `createdBy: 'test'` | **Fixture**, as above. The public form submitter is never the subject; the binding's author is |
| `forms-intake-chain-execution` WF-FORM-2 (1) | `forms.getSubmission`, lane `actor`, `validation_error` on `orgId: ''` (a manual run with no trigger payload) | **Floor fixed.** The first cut treated `''` (and grade-fix `L2`'s `null`) as an unusable value. To every surface they mean "no org", like an absent key, and this chain's honest answer to "no submission" is its own typed `FORMS_SUBMISSION_NOT_FOUND` branch; the floor's refusal was swallowed by the degrade path and the run went green. `''`/`null` are now absent; only a non-string is refused. An empty org that reads the whole tenant is S-A, already pinned |
| `career-apply-chain-gate` (3) | `computer-use.startTask`, lane `actor`, `not_found`: `orgId: 'org-apply'` had no org row | **Fixture.** `org-apply` is now a real org of the personal tenant owned by the run's actor. In prod the chain is launched with the applicant's real org (or the root, which the root shortcut answers) |
| `artifact-created-emission` (2) | `documents.assemble`, lane `actor`, `not_found` then `forbidden_scope`: `org-g8` had no row, and the actor is the operator env key `bearer:<8>` | **Fixture.** `org-g8` is now a real org owned by the env key's principal. **Behaviour change to record:** a run started with the operator env key now needs that principal to be in the org the node names, as the HTTP door (`requireOrgScope` → `assertOrgScope`) already requires of the same caller |

## Residue (filed, not done here)

- **R-personal.** On the ACTOR arm, `assertRunOrgScope` still grants the personal-tenant
  owner short-circuit by tenant shape, so in a shared `user:` workspace any actor passes for
  any org (pre-existing, ADR 0830). Fix: key it on the request-stamped `scope.personalTenant`
  (ADR 0822 D1), which `BundleScope` already carries, and thread it into `tenantRetrieve`.

- **S-A — absent `orgId` means the whole tenant.** `campaign-brief.listBriefs` /
  `listPersonas`, `campaign-orchestration.listCampaigns`, `brand.listBrands`,
  `campaign-connectors.kpiSummary`, `campaign-intel` (all its methods: `str()` turns an
  absent org into `''`, which the service reads as every org), `bi.runMetric`,
  `priority-matrix.submitIdea`. Pinned no-growth by D4 (the scan sees the first six).
- **S-I — id-addressed methods** (the org comes from the row, so the seam sees none).
  Reads that return org data: `brand.getBrand/resolveVoice/checkComplianceDeterministic`,
  `campaign-brief.getPersona/getBrief/validateBrief/assembleContext/listVocEvidence/listAngles/getTargetingPack/listTargetingPacks`,
  `campaign-orchestration.getCampaign`, `app-builder.deploymentStatus`,
  `agent-knowledge.retrieve`, `crm.getGmailSyncForRun`, `notebooks.*` (eight reads),
  `podcasts.getSpeakerProfile/getEpisodeProfile/getEpisode`,
  `priority-matrix.listRankedIdeas/getScheduleStatus/getIntake`, `service-desk.getTicket`,
  `strategy.getStrategy/listCheckIns`. Writes: `campaign-brief.setKernel/persistVoc/persistAngles/persistTargeting`,
  `campaign-orchestration.finalizeFromBrief/attachAssets`, `app-builder.rollbackDeployment`,
  `priority-matrix.scoreIdea/generateAgenda/proposeScenario/updateIntake/addEvidence`,
  `strategy.checkIn`, `kicktodo-creator.setLessonMedia`, `notebooks` writes,
  `podcasts.recordEpisodeResult`, `knowledge-sync.runOnce`, `whatsapp.send`. Each needs a
  row-org check through `assertRunOrgScope` in its surface; the right fix is a seam helper
  that takes the row's org, so it stays one predicate.
- **S-W — write authority.** The floor is membership. A viewer's run can write through a
  surface that does not ask `workspace:write` itself. Needs a per-method write declaration
  (the D2 `methodScopes` mechanism can carry it once each surface's writes are listed).
- **S-D — door filters beyond membership.** `documents.listDocuments/getDocument` skip the
  ADR 0610 owner filter; `crm` reads apply territory visibility only with an actor;
  `assistant`'s nested `{ kind: 'crm-contact', orgId }` is never checked.
- **R8-webhook.** Inbound webhook runs have no durable author (`InboundConfig` records none).
  Fix: stamp `configuredBy` at `setInboundConfig` and carry it as `orgScopeSubject`.
- **R8-anon (reopened, `KBCD-6`).** The anonymous widget turn's tool scope is the whole
  tenant while the grant was made with authority in one org. Fix: narrow anonymous turns to
  the widget's org (an allowed-org set on the scope, not a subject), or require tenant-level
  authority to grant read tools. Off by default. **MEASURED 2026-10-05 (orchestrator, live
  service env): `OPENWOP_ANON_ACTOR_ENABLED` is NOT set on `openwop-app-backend`** (the only
  `ANON*` variable is `OPENWOP_MANAGED_ANON_SIGNIN_REQUIRED=true`), so the lane is off in
  prod: residue, not live.
- **R8-audience.** A channel turn is bounded by the poster's orgs, which can be wider than
  the channel's audience. Narrower than before.
- **R8-bearer.** A trigger armed by a bearer principal (`user:<id>`, `oidc:<sub>`) is
  stamped with a key that is not a member subject, so its fires fail closed at the floor.
- **R-root.** In a non-demo tenant where `orgId === tenantId` has no org row (white-label,
  SAML `default`), a run with a person now gets `not_found` on every surface naming the
  root, as media already did.
- **R-scan.** `resolveEffectiveAccess` scans the member, role and group stores per call;
  the floor memoises per node, but a tenant-indexed member read is the host-wide fix.

## Open questions

- [x] Adversarial `/architect` pass before implementation (above).
- [x] `/grade-code` over the implementation (above).

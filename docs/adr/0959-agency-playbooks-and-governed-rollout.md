# ADR 0959 — Agency playbooks and governed rollout

Status: Accepted (P0–P5 implemented; owed: the ADR 0942 routing of `playbook-rollout`, the P3 eval gate, the P4 RFC 0098 kinds, and the Producer tools + chat deep link with ADR 0943 P1)

Date: 2026-10-19. Program: Campaign Studio (ADRs 0941–0962), Tier 4 "agency
scale". Source: the program brief (session 66) and David's ask: "think big, but
root it in OpenWOP … grounded in existing architecture, not hard-coded
workarounds". This is a net-new feature, not a MyndHyve port.

## Context

An agency that runs 5–30 clients (ADR 0921 D1: agency = `ws:` workspace, client
= org) wants to build a campaign method once — "local-service lead-gen launch",
"DTC product drop", "webinar funnel" — and run it for every client. Today the
only way is to instantiate a chain template per client by hand
(`POST …/workflows/from-chain`) and then hand-edit each copy. Nothing tracks
which client runs which version, nothing tells the agency what an upgrade would
change for a client, and a client's edits are lost or block the upgrade.

That is exactly the GoHighLevel "snapshot" failure mode named in the brief's
competitive scan: a snapshot is copied into each sub-account, client edits are
silently overwritten on re-push (or the push is skipped), there is no diff, no
staged rollout and no rollback. Agencies keep spreadsheets of "which client is on
which snapshot".

A **playbook** is a versioned bundle the agency publishes: one or more workflow
chains (RFC 0013 / RFC 0133), a default config layer (chain parameters, autonomy
preset from ADR 0942, agent bindings from ADR 0943), and content templates
(pages, emails, brand-safe prompt templates). A **rollout** installs or upgrades
it across many clients with change control.

## Boundaries audit (state on `origin/main` at `74d5f18bc`)

Paths are under `backend/typescript/src/` unless they start with `docs/`,
`examples/`, `schemas/` or `frontend/`.

**What exists and is reused (no second copy of any of these):**

| Concern | Existing owner | Evidence |
|---|---|---|
| Chain format, validation, expansion | chain loader | `WorkflowChain` `host/workflowChainPackLoader.ts:180-222`; `expandChain(authoredChain, opts)` `:1350` takes a chain OBJECT, not an id; `validateChainComposition` `:443`; cycle guard `:402` |
| Sub-chain nesting (workflows hold workflows) | RFC 0133 — **Accepted** 2026-07-23 (`../openwop/RFCS/0133-workflow-chain-composition.md`) | `SubChainRef` (sibling id or external `{packName,chainId,version}`) `:166-171`; `coRegisterSubChains` `:1932`; tenant-scoped, version-keyed child ids `mintChildWorkflowId` `:1910`; depth cap 8 `:1877` |
| Frozen instance + re-parameterization anchor | chain loader | `metadata.expandedFrom = {chainId, version, params, nodePins}` `:1832-1837` |
| Per-run parameter overrides | RFC 0124 deferred mode | `ExpandOptions.deferred` `:1067-1072` (params become run-overridable `variables[]`) |
| Instantiation into an owned, builder-editable workflow | from-chain route | `routes/workflows.ts:1096`; sub-chain staging `:1148-1156`; `recordRevision` + `recordOwnership` `:1203-1215` |
| Revision history, run pinning, publish = pin, rollback | ADR 0474 (implemented) | `host/workflowRevisions.ts:144` `recordRevision`, `:210` `listRevisions`; `run.metadata.definitionRevision` resolved by `host/resolveRunDefinition.ts:58`; routes `routes/workflows.ts:811` promote, `:885` revisions, `:978` rollback |
| Content-hashed config snapshots, diff, promote, rollback, approval | ADR 0387 environments (implemented) | `features/environments/environmentsService.ts:149` `snapshotLiveConfig`, `:258` drift; `host/configDomains.ts:90` `diffEntries`, `:152` `registerConfigDomain`; approval kind `'environment-promotion'` `host/approvalService.ts:57` |
| Agents, roster, prompt templates, schedules as portable items | RFC 0098 portability (graduation witness) | `features/portability/types.ts` `ExportKind` (agent, pack, prompt-template, connection-ref, schedule, roster, org-chart); dry-run plan + apply `features/portability/routes.ts` |
| Client account + client isolation | ADR 0921 (P0 implemented) | `features/campaign-ops/clientService.ts`; every op takes `orgId`, run stamp `openwop-app.campaignOps` |
| Run-start decision freezing | ADR 0099 seam | `host/runStartContext.ts:66-73` `registerRunStartContributor`; `derivedFromRun` rule `:24-45` |
| Reserved (unspoofable) run-metadata keys | run dispatch | `host/runDispatch.ts:81` `RESERVED_RUN_METADATA_KEYS` |

**Gaps this ADR must close (measured):**

| Gap | Evidence | Consequence |
|---|---|---|
| P-G1 The chain registry holds ONE version per `chainId`, host-wide | newest SemVer wins and the older is dropped, `workflowChainPackLoader.ts:663-760`; `getChain(chainId)` `:813` has no version argument | A client cannot stay on playbook 1.x once 2.x is installed; rollback to an old chain version cannot be re-expanded |
| P-G2 External, version-pinned sub-chain refs are not resolved by this host | `SubChainDeps.resolveExternal` is optional `:1899-1902`; from-chain never passes it (`routes/workflows.ts:1148-1156`); a string ref resolves through the GLOBAL registry by id, unversioned (`resolveSubChainRef`, `workflowChainPackLoader.ts:1914-1922`) | A playbook cannot pin "funnel sub-chain @ 2.3.0"; it gets whatever version is loaded |
| P-G3 Chains are host-installed artifacts, not tenant data | loader roots are host dirs `defaultWorkflowChainPackRoots` `:500`; no tenant chain store exists (grep for a chain/playbook `DurableCollection`: none) | An agency cannot author a private playbook without operator pack install |
| P-G4 Nothing distinguishes a client's intended override from drift | an instance is a frozen copy; edits are new revisions with no "override vs. accidental" semantics | Upgrades either clobber client changes (GHL) or are skipped |
| P-G5 No instance → playbook index | `expandedFrom.chainId` exists per definition, but no index by `(tenant, orgId, playbookId)` | "Which clients run which version" is a full scan |

**Duplication check.** ADR 0948 (funnel blueprints as chain packs) and ADR 0961
(autopilot chain) are *content* this ADR distributes; neither owns versioning or
rollout. ADR 0387 owns tenant config promotion between *environments*; this ADR
owns per-*client* installation of a *versioned bundle*. They share the diff and
snapshot mechanics (reused, not copied) and must not both claim "promotion".

## Decision

### D1 — A playbook is tenant data in the chain format, not a new workflow model

```ts
// features/campaign-playbooks/types.ts
interface PlaybookVersion {            // IMMUTABLE once published
  tenantId: string;                    // the agency workspace (ws:…)
  playbookId: string;                  // stable slug, unique per tenant
  version: string;                     // SemVer 2.0.0
  contentHash: string;                 // sha256 over canonical(body) — tenant-scoped key
  chains: WorkflowChain[];             // RFC 0013/0133 shape, validated by the SAME schema + validateChainComposition
  entryChainId: string;                // the chain a rollout instantiates
  defaults: PlaybookConfigLayer;       // D3 layer 0
  overridable: OverridePolicy;         // which keys a client/campaign may override (D3)
  content: PlaybookContentItem[];      // D5
  agentBindings?: Record<string /*nodeId*/, string /*default agentId (the pin)*/>; // a client override replaces the pin per ADR 0943 D2
  changelog: string; publishedBy: string; publishedAt: string;
  supersedes?: string;                 // prior version
}
```

Stored in `DurableCollection('campaign-playbooks:version')` keyed
`tenant::playbookId::version`, written with put-if-absent (a published version
can never be overwritten). Drafts live in a separate
`campaign-playbooks:draft` row. Chains are validated with the manifest schema
the loader already uses (`chainManifestSchemaTree`, `:298`) and
`validateChainComposition` + `detectSubChainCycles`. **Nothing here registers a
workflow at boot.** A playbook becomes a workflow only through D4's install, and
that install goes through `expandChain`/`coRegisterSubChains` → `registerWorkflow`
→ `recordRevision` → `recordOwnership`, the same path from-chain uses. This is
the CLAUDE.md doctrine (chains, never in-tree definitions) applied to tenant
data.

Closes P-G1 and P-G3: every version's chain documents are kept, so re-expanding
any version (pin, rollback) never needs the global registry. A playbook can
also be **sourced from** a host-installed chain pack (`sourcePack:
{name, version}`), copying its chains into a version row — the global pack stays
the reference, the playbook version pins it.

### D2 — Versioned sub-chain resolution (closes P-G2)

`coRegisterSubChains` is called with `resolveExternal` bound to a resolver that
reads, in order: (1) the same playbook version's own `chains[]`; (2) a playbook
version row named by `{packName: 'playbook:<id>', chainId, version}`; (3) the
global registry only when its loaded version equals the requested one. Anything
else is refused `sub_chain_unresolved` — never a silent "newest". This uses the
external-ref shape RFC 0133 already defines; it is host resolution, not wire.
The from-chain route gains the same resolver for host packs (a separate,
small fix logged as a follow-up row, because it changes an existing route).

### D3 — Layered config: overrides are data, never edits to the graph

Effective config for an installation is a deterministic merge of four layers:

| Layer | Owner | Example |
|---|---|---|
| 0 playbook defaults | agency, per version | `budgetDailyCapUsd: 50`, autonomy preset `guarded` |
| 1 agency-wide overrides | agency admin | house tone, default approver role |
| 2 client override | client admin or agency operator on that org | `geo: "Austin"`, `approverRole: client-marketing-lead` |
| 3 campaign override | campaign owner | `offer: "spring-20"` |

Rules:
- Only keys listed in `overridable` (JSON pointers into chain `parameters`, the
  0942 policy, 0943 bindings and content slots) may appear in layers 1–3.
  Anything else is refused `playbook_key_not_overridable`.
- Layer values are validated against the chain's `parameters` JSON Schema at
  write time AND at every upgrade (a renamed/removed key surfaces as an upgrade
  conflict, D6, never a silent drop).
- Merge is per-key last-layer-wins, no deep merge of arrays (predictable diffs).
- **Structural customization rides declared slots, not graph edits.** A playbook
  marks a node as a *slot* (`config.subChainRef` to a slot chain). A client may
  bind its own chain to a slot (layer 2). This is RFC 0133 composition, so a
  client's custom step survives every upgrade that keeps the slot.
- A client who edits the instantiated workflow in `/builder` anyway is not
  blocked (the builder stays the builder). The installation is marked
  **detached** (its head revision hash differs from the expected expansion), and
  upgrades for it become *proposals* (D6), never auto-applied.

Closes P-G4: an override is a recorded intent; a builder edit is a recorded
divergence. GHL has neither.

### D4 — Installation = one owned workflow per (client, playbook)

```ts
interface PlaybookInstallation {
  tenantId: string; orgId: string;           // client org (ADR 0921 isolation key)
  playbookId: string; pinnedVersion: string;  // what new runs use
  ring: 'canary' | 'early' | 'general' | 'held'; // D6
  workflowId: string;                         // the owned, builder-editable instance
  expectedRevision: string;                   // revisionHashOf(expected expansion)
  detached: boolean;                          // head != expectedRevision
  layers: { agency?: ConfigLayer; client?: ConfigLayer };
  history: Array<{ version: string; revision: string; at: string; by: string; rolloutId?: string }>;
}
```

`DurableCollection('campaign-playbooks:install')` keyed `tenant::orgId::playbookId`
(closes P-G5 — "which clients run which version" is a prefix read per org, and
the agency view fans out per visible client exactly like ADR 0921 D5). Install
expands the pinned version with the merged layers, co-registers sub-chains with
child ids keyed `(tenant, childChainId, version)` (so two clients on the same
version share the child; two versions never collide), records a revision, and
records ownership with `subject: 'campaign-playbooks:<orgId>:<playbookId>'`
(ADR 0913 erasure label).

Campaigns (ADR 0941 `MarketingCampaign`) reference the installation, not a
chain id; the autopilot (ADR 0961) launches through it.

### D5 — Content templates ride their owners

A `PlaybookContentItem` is `{kind, slot, payload, owner}`. The kinds that RFC
0098 already models (agent, prompt-template, schedule, roster) are applied with
the portability service's plan/apply (dry-run first, credential-material refusal
first). Everything else — CMS page/section templates (ADR 0948 funnels), email
templates (ADR 0905/0955), brand presets (`features/brand`, org-scoped) — goes
through a `registerPlaybookContentAdapter({kind, plan, apply, diff})` registry,
the ADR 0387 `registerConfigDomain` inversion: campaign-playbooks never writes
another feature's store. Content is installed into the **client org** (brand,
pages and media stay org-scoped; ADR 0921 D1). Connections are never in a
playbook: a slot names a required connection *type*, and the client binds its
own (ADR 0921 D4 pinned connections).

### D6 — Rollout: diff, rings, gates, rollback

A `Rollout` targets `{playbookId, fromVersion?, toVersion, orgIds[] | ring}`.

1. **Plan (no writes).** Per target installation: chain diff (re-expand both
   versions with that client's layers; compare definitions node-by-node with the
   same structured diff the builder's removed-node disclosure uses), config diff
   (`diffEntries`, `host/configDomains.ts:90`), content diff (adapters' `diff`),
   and conflicts: override keys that no longer validate, slot bindings whose slot
   was removed, detached installations. Every target is classified
   `clean | conflicts | detached`.
2. **Gate.** Starting a rollout is an approval (D7) unless the agency's policy
   says otherwise. The diff is what the approver sees; the approval binds the
   plan hash (approve-what-you-see, the ADR 0473/0924 pattern).
3. **Rings.** `canary` (named clients) → `early` → `general`, each ring advancing
   only after a soak period AND a health check: no new failed runs on the new
   revision, eval suite (ADR 0889 `agents.eval-regression-gate`) green when the
   playbook declares one, no rollback requested. Advancing a ring is a CAS on the
   rollout row (`state` + `ringIndex`), idempotent per (rollout, orgId).
4. **Apply per client** = install the new version (D4) with the client's layers;
   `clean` targets auto-apply, `conflicts` and `detached` get a per-client
   proposal (a change-set on ADR 0923's model when campaign-ops is on, else a
   `playbook-upgrade` approval card) the client admin resolves.
5. **Rollback** = re-install `fromVersion` (the version row is immutable, so this
   is a re-expansion, never a revision search), recorded as a new history entry;
   ADR 0474's per-workflow rollback stays available for a single instance.
6. **Pinning / hold**: an installation in ring `held` is skipped by every
   rollout until released; `pinnedVersion` never moves without a rollout or an
   explicit admin action.

### D7 — Approval kind and audit

One new approval kind `'playbook-rollout'` on `host/approvalService.ts`
(`APPROVAL_KINDS`, `:40`), plus a redactor, following `'environment-promotion'`
(`:57`, `:2230`). Not a second approval lane: ADR 0942's one gate primitive
routes it as action class `playbook.rollout` (ADR 0942 D1), so the agency's
policy decides who approves. Every publish, rollout transition and per-client apply emits a host
event (`emitHostEvent`) and lands in the audit chain (`host/auditChainService.ts`).

### D8 — Replay safety

- A run launched from an installation already pins its definition through
  `run.metadata.definitionRevision` (ADR 0474) — upgrading a playbook never
  changes a running or forked run.
- Add a host-written stamp `run.metadata['openwop-app.playbook'] = {playbookId,
  version, contentHash, orgId, layersHash}` through a run-start contributor that
  contributes nothing when `derivedFromRun` (ADR 0604 rule,
  `host/runStartContext.ts:24-45`), and add the key to
  `RESERVED_RUN_METADATA_KEYS` (`host/runDispatch.ts:81`) so a caller cannot
  spoof it. A `:fork` carries the stamp verbatim, so "which playbook version made
  this decision" is answerable forever.
- Content installs are side-effect nodes only if performed inside a run; the v1
  rollout applies them from the service (not a run), so replay never re-installs.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | New `features/campaign-playbooks/` (types, `playbookStore.ts`, `rolloutService.ts`, `contentAdapters.ts`, `routes.ts`, `surface.ts`, `feature.ts`), appended to `BACKEND_FEATURES`/`FRONTEND_FEATURES`. No core edits beyond the approval kind and the reserved-key entry (both registries). |
| 2 | Toggle | `campaign-playbooks`, default **OFF**, `bucketUnit: 'tenant'`, `dependsOn: ['campaign-ops', 'campaign-orchestration']`, `recommends: ['environments', 'evals']`; sold in the ADR 0928 `agency-ops` bundle. |
| 3 | Workflow surface | `ctx.features.campaignPlaybooks`: `getInstallation({orgId, playbookId})`, `effectiveConfig({orgId, playbookId})` (read); no write ops in v1 — rollouts are human-initiated. Every op takes `orgId` and checks the run tag's client (ADR 0941 D2b; the ADR 0921 D3 check). |
| 4 | Node pack | `feature.campaign-playbooks.nodes`: `read-installation`, `effective-config` (read-only). Ring advancement is NOT a node in v1 (OQ4). |
| 5 | Envelopes | None. |
| 6 | Agent pack | No new agent (ADR 0943 owns the roster). The **Producer** gets read-only playbook tools by allowlist: it drafts changelogs and explains a rollout diff in chat, and writes only as a draft version a person publishes. |
| 7 | Public surface | None. Client approval of a `conflicts` upgrade rides the ADR 0924 portal when on. |
| 8 | RBAC | Author/publish/rollout: agency root admin (`host:members:manage` on root) or a custom `playbooks:publish` role on the root. Client layer write: `workspace:write` on the client org via `authorizeOrgScope`. Reads by id compare `row.orgId` (uniform 404). |
| 9 | Replay / fork | D8: definitionRevision pin + reserved playbook stamp, read verbatim on `:fork`; rollout service writes are outside runs. |
| 10 | Frontend | "Playbooks" tab on the `/campaign-studio` hub (`frontend/react/src/features/campaigns/routes.tsx:26`): library, version history with changelog, rollout planner (per-client diff table, rings), installation matrix (client × version, detached badge). Diff view reuses the environments diff component. Chat entry via `navigate('/?agent=<producer>')`. |

## Why this is our advantage

- **OpenWOP primitives used:** chain packs + RFC 0133 sub-chains (the playbook
  *is* a portable chain bundle with slots), content-hash revisions and run
  pinning (ADR 0474), run-start freezing (ADR 0099), approval gates, eval suites
  as a ring health check (ADR 0889), RFC 0098 portability for agents/roster.
- **Competitor gap:** GoHighLevel snapshots overwrite or skip client changes,
  have no diff, no staged rollout, no rollback, no version pin per sub-account.
  HubSpot and Salesforce have sandboxes per org but no cross-client template
  distribution. Nobody can answer "which version of our method produced this
  client's decision" — we answer it from the run stamp and can replay it.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| **P0** | Package + toggle; `PlaybookVersion` store (immutable, put-if-absent), draft → publish; validation with the loader schema; install one client (D4) with layer 0 + 2; reserved playbook stamp | Route test: install expands, registers, records revision + ownership; republishing an existing version is refused; a client-B install is invisible to a client-A operator (uniform 404) |
| P1 | D2 versioned resolver; slots; D3 overridable policy + validation; detached detection | Witness: playbook pinning `child@1.0.0` still resolves `@1.0.0` after `@2.0.0` is installed globally |
| P2 | Rollout plan + diff (D6.1) + `'playbook-rollout'` approval (D7); manual per-client apply; rollback | Plan makes zero writes (test); rollback re-installs the exact prior revision hash |
| P3 | Rings + soak + health check (failed-run rate, eval gate), CAS ring advance, held installs | Concurrent advance produces one transition; a failing canary stops the rollout |
| P4 | Content adapters: CMS (0948), email (0955), brand preset, RFC 0098 kinds | Each adapter's plan/diff is pure; apply is idempotent per (rollout, orgId, slot) |
| P5 | Frontend tab + Producer playbook tools + node pack | `npm run build` green; 4-locale parity; chat deep link |

> **Correction 2026-10-20 (P0, `/architect`): what P0 built, and three choices the plan left open.**
> - **One instantiation path, extracted.** The from-chain route's expand → stage → disabled-pack
>   check → commit → revision → ownership sequence moved verbatim into
>   `host/chainInstantiation.ts` `instantiateOwnedChain`. The route and the install both call it,
>   so neither can grow its own copy (its 14 route test files, 177 tests, stayed green).
> - **Sub-chains are refused in P0** (`playbook_subchains_unsupported`, 422): a string ref still
>   resolves through the global registry by id (P-G2), which would install whatever child
>   version the host has. P1's D2 resolver lifts this.
> - **`overridable` is a list of entry-chain parameter names in P0.** D3's JSON pointers into
>   the 0942 policy, 0943 bindings and slots arrive with those layers in P1. Layer 1 (agency) is
>   P1 too; P0 merges layer 0 and layer 2 and validates the result against the chain's own
>   `parameters` schema (`playbook_params_invalid`).
> - **The run-stamp seam.** `RunStartContext` gained `workflowId` (from `runInsert`), and the
>   contributor reads a host-written workflow → installation index, never the definition's
>   metadata (the builder edits that). The stamp also carries `detached` (the run's pinned
>   `definitionRevision` is not the one the install wrote), which D8 did not list.
> - **Toggle row 2 changed: `dependsOn: ['campaign-ops']` only.** ADR 0439's parity rule
>   makes a dependency an import, and P0 imports nothing from campaign-orchestration, so it
>   moved to `recommends`. It returns to `dependsOn` in the phase that calls it.
> - **A stranded install claim is reclaimable** after 10 minutes (the put-if-absent
>   `installing` claim; an instantiation error releases it).

> **Correction 2026-10-20 (P1, `/architect`): how D2 and D3 were built.**
> - **D2 rides hooks on the ONE resolver.** `SubChainDeps` gained `resolveSibling`,
>   `mintChildId` and a `parent` argument on `resolveExternal` (which may now be async). With a
>   sibling resolver supplied, resolution is exact: a sibling only from the version that owns the
>   parent chain, an external `playbook:<id>` ref only from that tenant's playbook version, a
>   host-pack ref only when the loaded pack name AND chain version match. With no hooks the
>   from-chain route resolves exactly as before (its P-G2 fix stays the logged follow-up).
>   Publish refuses a version whose refs do not resolve today; install re-resolves.
> - **Playbook children are keyed `(tenant, playbook, version, chainId)`**, not `(tenant,
>   chainId, version)`. Tenant-authored chain ids can repeat across playbooks with different
>   content, and the shared-child convergence would otherwise refresh one playbook's child with
>   another's. Two clients on one version still share the child (D4). RFC 0133 §1.3 pins only
>   determinism and tenant scope, both kept.
> - **D3 as built:** `overridable = {params, slots}`. A slot is a `subChainRef` of the entry chain;
>   a layer binds it to `{playbookId, version, chainId}` (another immutable version of the same
>   tenant). Layer 1 is one row per (tenant, playbook), written against the newest version and
>   re-validated against the installed one. The ADR 0942 policy and ADR 0943 binding pointers
>   are not built (neither ADR has landed). A slot binding is not checked for parameter
>   compatibility with the default child (`J959WF-4`).
> - **Drift:** `GET …/installs` returns `none | edited | missing` per installation, and the run
>   stamp's `detached` became `drift: none | edited | unknown` (`J959WF-1`, `J959WF-2`).

> **Correction 2026-10-20 (P2, `/architect`): how D6/D7 were built.**
> - **The approval kind is built; its ADR 0942 routing is owed.** `playbook-rollout` joins the
>   ONE approvals queue (kind list, redactor, audience = `host:members:manage` on the workspace
>   root, a decision-table entry, a feature-registered handler), following `campaign-change-set`.
>   ADR 0942's single gate (#5051) is not merged, so routing the kind through its
>   `playbook.rollout` action class is recorded as owed, not faked.
> - **The diff is of the authored graphs**, keyed by sub-chain ref path + original node id.
>   Expanded node ids carry a params+version hash, so an expanded diff would report every node as
>   replaced. The config diff is `diffEntries` (ADR 0387), over the merged values and slot
>   bindings.
> - **Approve-what-you-see is enforced twice:** the decide handler re-plans and closes a review
>   whose plan no longer hashes the same (each target's head revision is in the hash), and apply
>   re-plans the one target (`target_changed`).
> - **Upgrade is in place:** `instantiateOwnedChain` gained `into: {workflowId, expectHead}` — the
>   same id, the owned name kept, a new ADR 0474 revision, the parent written with a
>   compare-and-swap against the fresh head (a live room refuses, as the builder rollback does).
> - **Rollback restores the recorded layers.** Each installation history entry now records the
>   layers it ran with; rollback re-expands the previous version with them, so the head returns
>   to the exact prior revision (witnessed).
> - **Separation of duties:** the requester cannot approve while another agency admin can.

> **Correction 2026-10-20 (P3, `/architect`): rings as built, and the eval gate NOT built.**
> - **Rings live on the installation** (`ring: canary | early | general | held`, absent =
>   `general`), set by an agency admin. A ring-mode rollout takes every installed client not held
>   and not already on the version, in ring order (empty rings dropped); naming a held client
>   in a target-mode rollout is `install_held`, and so is applying to one held after the plan.
> - **Apply is gated by the open ring** (`ring_not_open`); `apply-ring` applies the open ring's
>   `clean` clients (conflicts and detached stay manual, D6.4).
> - **Advance** needs every client of the ring applied (or rolled back), the soak elapsed since
>   the ring's last apply (OQ6 defaults canary 48 h, early 72 h, general none; per-rollout
>   overrides), and a passing health check — then a compare-and-swap on `ringIndex`
>   (witnessed: five concurrent advances, one transition).
> - **Health = failed runs of the NEW version since that client's apply**, read from the run
>   store (`listRuns`, failed, bounded) through the P0 run stamp — no second outcome index. An
>   older version's failures do not count (witnessed). A failure HALTS the rollout: no apply,
>   apply-ring or advance; rollback stays open.
> - **The ADR 0889 eval gate is not built.** No playbook version names an eval suite, and gating
>   on one means starting a paid eval run inside an advance; a gate that always passes would be
>   a false claim. Owed (`J959WF-8`), with P5's Producer tools or a P3b once a version can
>   declare a suite.

> **Correction 2026-10-20 (P4, `/architect`): content adapters as built.**
> - **The seam is core, the adapters are the owners'.** `host/playbookContentAdapters.ts`
>   (`registerPlaybookContentAdapter`), the `registerConfigDomain` inversion for per-client
>   content. CMS registers `cms.page`, email `email.template`, brand `brand.preset`, each in its own
>   feature; campaign-playbooks imports none of them.
> - **Writes respect the owners' rules.** The CMS adapter creates drafts only and refuses to update
>   a page that left draft (ADR 0836: a live page is an admin edit), reported `content_locked`; an
>   email template update writes a new version, which reopens send review (ADR 0905 D3).
> - **Idempotent per (org, playbook, slot)** through a playbook-owned mapping row (the applied hash
>   and the resource's snapshot hash) and a put-if-absent create claim; deterministic resource ids
>   where the owner allows them (CMS, email). A resource edited since the playbook wrote it is
>   `content_edited` and needs `overwrite`; in a rollout plan it makes the client `detached`.
>   A slot a newer version drops is left in place and reported, never deleted.
> - **Content applies after the workflow** at install and at each apply/rollback; a failed item is
>   reported and retried through `POST …/installs/:playbookId/content`.
> - **Not built: the RFC 0098 kinds** (agent, prompt-template, schedule, roster). The portability
>   service applies a tenant-wide bundle, not an org-scoped item per slot; doing it per client needs
>   an org-scoped portability apply first. Owed (`J959WF-9`).

> **Correction 2026-10-20 (P5, `/architect`): the tab and the node pack are built; the Producer half
> is NOT, and the "chat deep link" exit criterion is therefore not met.**
> - **Tab:** "Playbooks" on the Campaign Studio hub (`hubTab`, the campaign-ops precedent): the
>   library and versions, the installation matrix (client × version, ring, drift as labelled chips),
>   the rollout planner (per-client readiness, changes, conflicts) and rollouts (apply, apply-ring,
>   advance, rollback; an edited client's upgrade asks for confirmation). Requesting a rollout opens
>   ONE review in the shared Reviews inbox; the page never approves. Read-mostly by design: a version
>   is workflow content, authored through the API (and later the Producer). 4 locales. A new route
>   `GET …/playbooks/:id/installations` serves the matrix in one read (no per-client fan-out).
> - **Node pack** `feature.campaign-playbooks.nodes` (`read-installation`, `effective-config`) over a
>   read-only `ctx.features['campaign-playbooks']`, bound like campaign-ops' surface
>   (`bindRunToClient`, reused) plus the run's own playbook stamp (`wrong_client`).
> - **Deferred, with reason:** the Producer agent is ADR 0943 P1 (#5055, not merged). Registering
>   agent tools no agent can hold, and a deep link to an agent the host does not have, would both be
>   claims without behaviour. The read tools, the draft-only tool and `navigate('/?agent=producer')`
>   land with 0943 P1 (`J959WF-10`).

## Implementation record

| Phase | PR / commit | Tests | Notes |
|---|---|---|---|
| P0 | #5119 | `adr0959-p0-playbooks.test.ts` (10 cases through the HTTP boundary: both toggles gating every route, loader-rule validation incl. unpinned and sub-chain refusals, admin-only authoring, immutable versions (republish and lower version 409), the override policy and parameter schema, not-a-client 404, the install's registration + revision + ownership subject, client A's operator 404 on client B, the run stamp and a forged one stripped, the fork rule; seven sabotage witnesses in its header) | New `features/campaign-playbooks/` (toggle OFF). Core touches: `host/chainInstantiation.ts` (extracted), `validateChainDocuments` export, `RunStartContext.workflowId`, the reserved key. campaign-ops `authorizeClient` exported (reused, not copied). |
| P1 | #5122 | `adr0959-p1-resolution.test.ts` (6 cases through the HTTP boundary: the exit criterion — a playbook pinning `acme.child@1.0.0` installs the 1.0.0 child while the host's registry holds 2.0.0, minted per playbook version and shared by two clients; a host-pack ref at a version the host lacks or from another pack refused, at the loaded version resolved; a `playbook:` ref resolving in the same workspace and never another's; a slot binding swapping the child, an undeclared slot and a dangling binding refused; the agency layer between defaults and client; drift none → edited → missing; six sabotage witnesses). P0 test updated (sub-chains now resolve or are refused at publish; `drift`) | Stacked on #5119. Loader hooks on `SubChainDeps` (default path unchanged). |
| P2 | #5126 | `adr0959-p2-rollout.test.ts` (6 cases through the HTTP boundary: the plan's classes and authored diff with ZERO writes (a storage write probe with a non-vacuity control); the requester refused, a plan changed after review closed; apply per client — clean, conflicts with replacement values, detached only with overwrite; idempotent repeat apply; rollback to the exact prior revision with the recorded layers; a client edited after approval refused, never clobbered; five sabotage witnesses, and the one guard it cannot witness named in its header) | Stacked on #5122. Core: the `playbook-rollout` approval kind; `instantiateOwnedChain({into})`. |
| P3 | #5128 | `adr0959-p3-rings.test.ts` (5 cases through the HTTP boundary and the REAL executor — the health signal is real failed runs: held clients skipped by a ring rollout and refused by name; only the open ring applies, and an old version's failures do not stop the next ring; a soaking ring does not advance; five concurrent advances give one transition; a failing canary halts the rollout while rollback stays open; six sabotage witnesses) | Stacked on #5126. The eval gate is owed (`J959WF-8`). |
| P4 | (this PR) | `adr0959-p4-content.test.ts` (7 cases through the HTTP boundary: an unknown kind and a bad payload refused at the draft; install writing a page, a template and a brand into the CLIENT org through their owners; a repeat apply writing nothing; two concurrent applies creating one resource; a rollout plan's per-item actions with zero writes; an edited template making the client detached and overwrite replacing it; a live page never changed; five sabotage witnesses) | Stacked on #5128. Core: `host/playbookContentAdapters.ts`; owner adapters in cms, email, brand. The RFC 0098 kinds are owed (`J959WF-9`). |
| P5 | (this PR) | `adr0959-p5-surface.test.ts` (4 cases: the installation matrix with drift; the surface's effective values across layers 0→1→2; a run with no person refused; a run stamped for client A refused on client B; three sabotage witnesses); FE `npm run build` (tsc + i18n parity + token gates) | Stacked on P4. New node pack `feature.campaign-playbooks.nodes` 1.0.0. The Producer tools and chat deep link are owed (`J959WF-10`). |

## Alternatives weighed

- **Snapshot copy per client (GHL model).** Simple, but upgrades must either
  overwrite or skip. Rejected: it is the failure we are fixing.
- **Publish each playbook as a host-installed signed chain pack.** Reuses the
  registry and signing, but the registry keeps one version host-wide (P-G1),
  needs an operator to install, and is global across tenants. Kept as an
  *export* path (a playbook version can be packed and published), not storage.
- **Live-linked instances (no frozen copy; every run reads the playbook head).**
  Zero drift, but an upgrade changes every client at once, breaks the builder's
  ownership model, and fights ADR 0474 pinning. Rejected.
- **Extend ADR 0387 environments to per-org targets.** Environments snapshot the
  whole tenant config; a playbook is one bundle installed per org with layers.
  We reuse its diff/snapshot/approval mechanics instead of overloading its model.

## RFC verdict

**Host extension, no RFC.** Routes under `/v1/host/openwop-app/campaign-playbooks/*`;
the format is the existing RFC 0013/0133 chain shape; external version-pinned
sub-chain refs are already in RFC 0133 (host resolution only); the run stamp is a
host-namespaced metadata key. Two optional upstream items, neither blocking:
(a) RFC 0098 has no kinds for page/email templates — we use a host adapter
registry instead; a new `ExportKind` would need an RFC 0098 revision. (b) If
playbook *slots* should be portable across hosts, a "slot" marker on a fragment
node would be an additive RFC 0013 change; it is not recommended now, and if it
is ever wanted it rides the same RFC 0013 revision ADR 0941 D9 owns (the node
`agent` field), not a second one. v1 expresses a slot as a `config.subChainRef`
plus host metadata.

**Doc rot found:** CLAUDE.md § "Workflows — never hard-code" still says sub-chain
nesting and a run-produced variable bag are capabilities "the pack format does
not yet express". RFC 0133 (Accepted 2026-07-23) expresses both
(`subChains[]`, `producedVariables[]`, `workflowChainPackLoader.ts:189-192`).
The lead corrects CLAUDE.md (ADR 0941 D9 and its corrections list).

## Open questions

1. **(David)** Who may publish a playbook to clients: agency admins only, or a
   dedicated "playbook publisher" role? Proposed: a custom root role
   `playbooks:publish`, admins by default.
2. **(David)** Must a client approve an upgrade that only changes agency-owned
   defaults (no conflicts)? Proposed: no for `clean` targets when the client's
   ADR 0924 policy is `agency`; yes when it is `client`.
3. Should playbooks be shareable across agencies (a marketplace, ADR 0419
   bundles)? Proposed: later, via export to a signed chain pack.
4. Should ring advancement be drivable by an agent (a node + 0942 policy) in v2?
   Proposed: yes, behind `approve` by default.
5. *Resolved in program review:* `agentBindings` holds each node's default agent
   id (the pin) per version; ADR 0943 D2's client binding, keyed by the pinned
   agentId, replaces it per client and is frozen at run start. No role name
   enters a binding.
6. Soak defaults per ring (proposed 48 h canary, 72 h early).

## Planning rows

- **ROADMAP:** `| 0959 | Agency playbooks + governed rollout | campaign-playbooks (feature.campaign-playbooks.*) | versioned chain-bundle playbooks, layered per-client overrides, diff + ringed rollout + rollback + pinning | deps 0921, 0923, 0924, 0941, 0942, 0943, 0948, 0474, 0387, 0889 | Tier 4 | 🔵 Proposed |`
- **FEATURES (Future features):** `| campaign-playbooks | Agency playbooks | Publish a campaign method once as a versioned playbook and roll it out to many clients with diffs, staged rings, approval, rollback and per-client overrides that survive upgrades. | OFF | tenant | ADR 0959 |`


## Recovery corrections — 2026-10-25

Track A architecture review: this is host-local state and host-extension APIs,
with no new protocol shape or capability advertisement. The recovered original
P0–P5 history is retained. Workflows still use the existing chain loader,
registry, revisions, ownership and executor; approvals use the existing queue
and root-org eligibility; content writes remain in CMS, email and brand owner
services. No second workflow, approval, identity or credential system is added.

The original multi-write sequences were not acknowledgement-safe. A first
installation now reserves one random copy id in its durable claim before any
workflow write and retries the same version/configuration with that id. The
shared instantiation seam compares the fresh definition before reconciling a
reserved copy, refuses another tenant or an edited/archived head, and heals the
revision/ownership writes without minting another workflow. Legacy installing
claims without a reserved id require review rather than speculative takeover.
A pending installation blocks run-start attribution until its version is
confirmed.

An upgrade records an intent containing the exact expanded revision, original
head, target version/configuration, actor and operation identity before the
workflow CAS. It reconciles an identical committed head after acknowledgement
loss; a human edit still refuses. Installation finalization uses fresh rows,
preserves ring edits and redacted actors, and records one operation in history.
A final rollout acknowledgement can be retried from that confirmed history.
Rollback follows the same sequence. These are per-resource consistency checks,
not repository or deployment holds.

The approval row remains the decision authority. A retry reaches the owner’s
reconciler even after resolution, rechecks eligibility and the same plan binding,
and copies the original decision/actor/time into an awaiting rollout. It cannot
reverse a decision or regress a later rollout state. All playbook-person erasers
retry fresh rows a bounded number of times and refuse to declare success under
continued contention.

Content updates claim their mapping before writing and pass the exact read’s
owner concurrency token to CMS, email or brand. The confirmed owner return value
is the new snapshot; a later read cannot silently adopt an intervening human
edit. Brand creation uses a deterministic, insert-only owner id. An unknown
creation outcome preserves its claim and requires review, never a second preset.
An unknown update outcome requires review and explicit replacement. Partial
content results no longer produce all-success UI copy, and a ring cannot advance
with unfinished content. Superseded previews cannot enable a request for another
selection. Date rendering uses the shared locale formatter.

Focused qualification: native backend types; six pack-surface cases; 22 backend
files / 249 cases, including real-store lost acknowledgements, fresh-row erasure,
content conflicts, original tenant/approval/fork tests, from-chain and workflow-id
regressions. Frontend lint and canonical build pass (941 bytes of entry budget
headroom), test types have zero errors, and eight focused files / 46 cases pass.
Peak owned memory was 4.49 GiB backend / 4.04 GiB frontend with no swap growth or
resource stop. The regenerated manifest census adds two read nodes only; the
floor remains 377/334 served/43 undischarged/zero unresolved. Full composed app CI
is still required before merge.

The toggle remains OFF. The eval-health integration (`J959WF-8`), RFC 0098
artifact kinds (`J959WF-9`), and Producer tools/chat deep link (`J959WF-10`) remain
open as previously recorded. No production settings or public releases change.

# ADR 0819 — Feature-toggle control plane: one access resolver, operator-owned overrides, audited and versioned flips, a real kill switch

Status: Accepted (implemented on `feat/fl2-15-toggles`; flips to implemented on merge)

Related: ADR 0001 §3 (the toggle system), ADR 0014 (the `ctx.features` surface seam),
ADR 0194 (dependency graph + disable-lock), ADR 0292 (demo provisioning, `enableTenantOverride`),
ADR 0387 + ADR 0479 (environments config domains), ADR 0419 (paid feature bundles, the
"central" paywall), ADR 0583 (daemon entitlement seam), ADR 0599 §6 (owning-feature gates on
schedules and triggers). Feature loop 2026-10 row 15; workflows grade `TGWF-1..4` in
`docs/steward/WORKFLOWS-ASSESSMENT.md`. RED witnesses:
`backend/typescript/test/feature-toggles-adr0819-security.test.ts`.

> **Order of work.** Every security finding below was proved with a failing test against
> unmodified `origin/main` source (`171d725c5`) BEFORE this ADR was written. The branch stayed
> unpushed past its claim commit until the fix was gated.

## Context

The toggle service gates every feature. A security-first probe of its control plane found:

1. **The plan paywall stops at HTTP (`TGWF-1`, live wherever a plan is narrowed).** ADR 0419
   put the bundle entitlement check inside `requireFeatureEnabled`
   (`features/featureRoute.ts:39-57`) and called it "the ONE universal choke". It is the choke
   for HTTP routes only. A feature is also reached through:
   - the workflow node lane: `ctx.features.<id>`, gated per call by `featureSurfaces.gate`
     (`host/featureSurfaces.ts:76-91`) with `resolveOne` alone;
   - the chat-tool lane: `agentToolKit.resolveFeatureToggle` and the org-scope helpers
     (`host/agentToolKit.ts:60-66`), plus 22 direct `resolveOne` calls in `agentTools.ts`,
     `mcpTools.ts` and `surface.ts` files;
   - the MCP projection (`host/mcpServerRegistry.ts:312,321,471`);
   - the schedule and trigger owning-feature gates (`host/scheduleDaemon.ts:105`,
     `host/triggerIngestionService.ts:420`).

   Only crm, csm, email and knowledge-sync add `checkTenantEntitlement` themselves.
   **RED:** with the plan narrowed, `GET /strategy` returns 403 for the tenant, while
   `openwop:strategy.list-strategies` and `ctx.features['priority-matrix'].listLists` serve it.
2. **A tenant rewrites the operator's per-tenant override (`TGWF-2`).** Per-tenant overrides
   are written only by the superadmin PUT and by superadmin demo provisioning. The environments
   config domain (`features/environments/domains/featureTogglesDomain.ts`) is the exception: any
   holder of `host:members:manage` can capture it and restore it EXACT-MATCH, and every
   personal-tenant owner holds that scope. **RED, both directions:** re-applying an old snapshot
   restores an `on` the operator revoked, and it deletes an `off` the operator set (the
   exact-match clear), so the global `on` returns.
3. **No real kill switch (`S3`).** `resolveConfig` applies a tenant override before the global
   status, so a global `off` does not stop any tenant holding an `on` override. Demo
   provisioning writes those overrides for about 30 features. An operator flipping a broken
   feature off globally leaves it running for exactly the tenants it was demoed to.
4. **Flips are not audited with the person (`S4`).** `updatedBy` is `req.tenantId`, and a save or
   revert is a `log.info` line only. "Who turned billing off, and what did it look like before"
   has no durable answer. **RED:** zero `feature-toggle.*` rows in `audit_log` after a PUT and a
   DELETE.
5. **Lost update (`S5`).** The admin PUT blind-`put`s the whole row, `tenantOverrides` included.
   An editor holding a stale read wipes an override written in between, by provisioning or by a
   second admin. **RED:** 200, and the override is gone.
6. **A capability claimed and not built (`TGWF-3`).** FEATURES.md says variant bindings "select
   behavior (which agent / node / prompt a workflow dispatches)". No dispatcher reads them. CRM
   triage stamps them into `run.metadata.featureVariant` and its GET echoes them back.

Sound on probe, so unchanged here: the superadmin gate fails closed (non-superadmin 403, narrowed
API keys refused). There is no tenant-level route that writes a toggle. `assignments` returns only
the caller's own resolution, never cohorts or other tenants' overrides. Bucketing is a pure hash,
so assignment is stable across boots and replay. Variants are resolved server-side, the client
cannot choose one, and the run stamp is written by the server.

### Competitive bar (LaunchDarkly / Statsig / GrowthBook class)

This bar comes from the vendors' public documentation as I know it, not from a fresh market scan.
The class standard is:
- a **kill switch** that beats every targeting rule;
- an **audit log** with actor and before/after on every change;
- **optimistic concurrency** on flag edits (a 409 on a stale write);
- **sticky assignment** that survives ramps;
- **targeting** by segment and attribute;
- **scheduled changes** and **change approvals**;
- **exposure events** for experiment analysis.

We already meet sticky assignment (a `% 10000` cumulative band, so a ramp moves only the band
that changed) and dependency prerequisites (ADR 0194). This ADR adds the kill switch, the audit
log and optimistic concurrency. The rest is deferred below, with reasons.

## Decision

### §1 — ONE access resolver; the paywall moves from the route to the resolution (`TGWF-1`)

Add `resolveFeatureAccess(id, subject)` in `host/featureToggles/access.ts`. It returns the
toggle resolution AND, for a sellable-bundle feature (`isSellableBundleFeature`), the tenant's
entitlement verdict through the existing host seam (`checkTenantEntitlement`, registered by
billing at boot; a no-op when billing is absent). The result is
`{ ...ResolvedAssignment, enabled, blockedBy?: 'plan' }`. The check fails closed: if the
entitlement read throws, the result is `enabled:false`.

Every NON-HTTP exit calls it in place of `resolveOne`:
- `featureSurfaces.gate`, now also passing `scope.actingUserId`, which closes `TGWF-4`: a
  user-listed closed-beta member is served on the node lane as on the route;
- `agentToolKit.resolveFeatureToggle` and both org-scope helpers;
- the direct calls in every file that registers an agent tool or an MCP tool, or builds a
  feature surface;
- `mcpServerRegistry`;
- the schedule and trigger gates.

`requireFeatureEnabled` is unchanged. It keeps the person-level operator exemption
(`isListedSuperadmin(req)`) and its distinct 403 "your plan does not include this feature",
which the FE's `LockedState` renders. `resolveOne` stays the pure toggle resolver for the
FE assignments map, the admin console and the disable-lock.

**Enforcement is derived from the call, not the filename.** A ratchet test fails any source file
that BOTH registers an exit (`registerFeatureAgentTool(`, `registerMcpTool`-style registrars, or a
`surface: { id, build }` builder module) AND calls `resolveOne(`. A new tool cannot quietly
regress to the toggle-only check.

*Alternatives.*
- (a) Make `resolveOne` itself entitlement-aware. That is one site, but it changes the FE
  assignments map: a paid feature would vanish instead of rendering its upgrade lock. It would
  also turn every direct-`resolveOne` route's plan 403 into a 404 and drop the operator's
  person-level exemption on those routes. Rejected.
- (b) Have each feature add `checkTenantEntitlement`. That is the status quo, which 4 of 22
  features did. Rejected: a guard that has to be remembered per writer is the generator.

### §2 — Per-tenant overrides are OPERATOR state; environments observes them, never writes them (`TGWF-2`)

Overrides have exactly two writers, the superadmin PUT and superadmin demo provisioning, and both
are operator acts. No tenant-owned toggle state exists. The environments domain therefore moves
to a new third register, **`observe-only`**, on `ConfigDomain.restore`:
- It is still captured into snapshots and still diffed, so drift shows that the operator changed
  this workspace's features.
- `applyToLive`, `promote` and `rollback` never call its `import`. They report it as skipped
  (`{ id, ok: true, skipped: 'observe-only' }`), so an apply cannot claim to have restored it.

The FE treats `observe-only` like `apply-only` for the "kept" vocabulary. The confirm copy in all
four locales stops promising "feature toggles not in the snapshot are cleared".

*Alternatives.*
- (a) Remove the domain. That loses drift visibility of operator changes and leaves old
  snapshots' payload silently ignored. Rejected.
- (b) Provenance per override (`source: 'operator' | 'tenant'`, restore only tenant entries). No
  writer of tenant entries exists, so this is (a) with extra schema. Rejected until a
  tenant-self-serve toggle exists. Recorded under Open questions.

### §3 — A kill switch that beats every override (`S3`)

`ToggleConfig.killed?: boolean`, an admin choice stored with the row:
- `resolveConfig` returns `enabled:false` for every subject when `killed` is set, BEFORE overrides
  and cohorts are applied.
- Un-killing restores the prior state exactly, because status, variants and overrides are
  untouched.
- The disable-lock treats a kill as `off` in every scope. Killing a feature that an enabled
  feature hard-depends on is a 409, like `off`.
- The admin console shows a distinct "Killed" state and a confirmed Kill / Restore control.

A separate field rather than a fourth status: a kill is an incident lever layered over the
configured state. Overloading `status` would destroy the configuration it is meant to suspend.

### §4 — Every flip is durably audited with the acting person (`S4`)

The PUT, the DELETE (revert) and demo provisioning each append one row to the existing global
audit stream (`hostExtStorage().appendAudit`, the `governanceDecisionLog` precedent). No second
audit store. Each row carries:
- `principalId`: the acting principal (the operator's own id), not the tenant;
- `action`: `feature-toggle.saved` / `.reverted` / `.tenant-enabled`;
- `resource`: the toggle id;
- `payload`: the acting tenant, plus `before` and `after` of the admin CHOICES only (status,
  killed, variants, cohort, overrides).

`updatedBy` on the row becomes the principal id. `GET …/admin/configs/:id/history` (superadmin)
pages it. The audit write is awaited and best-effort, the governance-log posture: an audit-store
failure logs a warn and does not fail the flip. An operator mid-incident must be able to kill a
feature even when the audit store is degraded.

### §5 — Optimistic concurrency on the admin write (`S5`)

The admin projection returns `revision`, which is the stored row's `updatedAt`, or `null` when no
row is stored.
- **PUT and DELETE:** when the body (PUT) or query string (DELETE) carries `revision`, the write
  is a single `compareAndSwap` against the exact stored row. A mismatch returns
  `409 revision_conflict` with the current revision.
- **The admin panel** always sends `revision`.
- **An omitted `revision`** keeps the old last-writer-wins semantics, for scripts. This is stated
  in the route header.

The CAS is the check. A read-compare-then-put would only narrow the race, not close it.

### §6 — Bindings: say what is true (`TGWF-3`)

FEATURES.md will say that bindings are stamped into `run.metadata.featureVariant` for
attribution and replay. Dispatch consumption is a per-feature opt-in, and none is wired today.
Wiring a dispatcher (CRM triage agent selection) is deferred. It needs its own replay design, and
a claim corrected today is worth more than a dispatcher half-built in a security PR.

> **UPDATED 2026-10-06 (ADR 0837 D7).** The deferred CRM dispatcher is now built, with
> its own replay design. The `crm.triage` binding maps through a closed candidate set
> to the run input `variant` of the `crm-ops.triage` chain, and replay and `:fork`
> re-seed it from `run.inputs`. CRM triage is the one wired consumer; every other
> feature's bindings remain recorded intent.

### Hygiene in the same PR
- A PUT for an id with no declared default returns 404. Today it writes an orphan row that boot
  pruning later deletes.

## Architect pass (adversarial, decision text, before code) — 2026-10-05

The `/architect` pass over §1–§5 found five Blockers in the decision as first written. Each
is corrected inline below. The original text is kept, so the reasoning trail survives.

- **A1 (Blocker, §1): the exit enumeration was incomplete.** It named surfaces, the tool kit,
  MCP, schedules and triggers. A full sweep finds 79 non-route `resolveOne` callers, and
  several of them are AUTHENTICATED non-HTTP lanes the list missed:
  - the collab WebSocket (`host/collab/collabServer.ts:214,241,435`) serves the sellable
    `editors`/`canvases` bundles (slides, cad, drawings, app-builder);
  - chat-recall knowledge services (`strategyKnowledgeService`, `docsKnowledgeService`,
    `productionKnowledgeService`, `priorityMatrixKnowledgeService`);
  - twin `borrowedRecall`;
  - `claude-code/tasks`.

  A per-exit migration plus a filename/registrar ratchet would have shipped with these holes,
  which is the generator in its own fix.
- **A2 (Blocker, §1): the rejection of alternative (a) gave the wrong reasons.** The real cost of
  an entitlement-aware `resolveOne` is ADR 0419's **public-caller exemption**. Public lanes call
  `resolveOne` with a resource-derived `{ tenantId }`:
  - forms submit, CRM booking and sign;
  - discovery, recommendations, podcasts public, funnels, consent, UCP;
  - the analytics collect beacon, entities API keys, the service-desk widget;
  - the forms submission sinks.

  The 404-vs-403 and operator-exemption costs are real but solvable.
- **A3 (Blocker, §2): `observe-only` breaks the environments drift invariant.** Drift is
  `currentSnapshot !== liveConfigHash` (`environmentsService.ts:263`). An observed domain that
  apply cannot write leaves an environment drifted right after a successful apply, and nothing
  the tenant can do clears it. Excluding it from the hash instead re-keys every snapshot.
- **A4 (Blocker, §3): the kill switch lies through demo provisioning.** `enableTenantOverride`
  decides "already on" with `resolveConfig(...).enabled`. A killed toggle resolves off, so
  provisioning writes an `on` override and reports `enabled` for a feature that still resolves
  off. The new `killed` field must also survive the SIX node-rebuilding allowlists (the
  validator, `saveConfig`'s `next`, `mergeStoredOverDefault`, the FE save body, and the two
  spread-based writers). An autosave that drops it un-kills the feature.
- **A5 (Blocker, §4): audit payload PII in an unerasable store.** `audit_log` has no tenant
  column, no eraser and no retention purger (`governanceDecisionLog.ts` header). Raw
  `before`/`after` would copy `betaCohort` USER ids (SAML subjects can be emails) and the
  override keys into it permanently.

Highs:
- **A6 (§5).** `updatedAt` as the revision is a clock value, so two writers on skewed instances
  can share it. Use a content hash of the stored row instead.
  `DurableCollection` has no conditional delete, so DELETE-with-revision is check-then-delete. The
  race narrows but does not close, and the ADR must say that rather than claim a CAS.
- **A7 (RED tests).** Three probes could pass for the wrong reason:
  - S2's final assertion holds if `/apply` itself 404s or 403s; it must assert 200.
  - S1's tool and node probes accept ANY refusal; they need a positive control in which an
    entitled caller is served.
  - S4 must assert that the audit payload carries no raw cohort id.

### Corrections applied

- **§1 (A1+A2) is inverted.** `resolveOne` BECOMES the access resolver: the toggle plus the
  sellable-bundle entitlement, fail-closed, cheap when no plan is narrowed. A new pure
  `resolveToggle` is the explicit OPT-OUT for the lanes that must not paywall:
  - `requireFeatureEnabled`, which keeps its own 403 and the person-level operator exemption;
  - the FE assignments map and the admin console/disable-lock;
  - ADR 0419's public lanes (enumerated in the ratchet);
  - crm/csm route helpers that run their own entitlement check.

  The ratchet is a **shrink-only allowlist of the files that call `resolveToggle(`**. It fails
  when a new file opts out, so an opt-out is a reviewed diff, and new code is paywalled by
  default. `ToggleSubject` gains `planExempt`, which `toggleSubjectOf(req)` sets from
  `isListedSuperadmin(req)`. Seeders and daemons with no `req` are paywalled; that matches the
  ADR 0583 daemon intent.
- **§2 (A3): REMOVE the feature-toggles domain.** This is alternative (a), adopted. Toggle
  overrides are operator state, not workspace config, and their history belongs to §4's audit
  log, not to environment drift. Consequences:
  - old snapshots keep a `feature-toggles` payload that apply ignores and the diff no longer
    reports (the diff is filtered to registered domains);
  - existing environments show drift ONCE, because their pinned hash covered the removed
    domain;
  - environments is default OFF, and the prod row count is the sizing question for the lead.

  The `exact-match` register stays in the type for a future state domain.
- **§3 (A4).** `enableTenantOverride` returns `'killed'` without writing when the toggle is killed,
  and provisioning reports it. `killed` is threaded through every allowlist above and pinned by a
  round-trip test.
- **§4 (A5).** The audit payload records only these fields:
  - `status`, `killed`, the variant keys and weights;
  - `betaCohortSize`, `tenantOverrideCount`;
  - the changed override tenant ids as tenant-salted digests, never raw.

  The operator's own `principalId` is kept. Accountability is the point, and operators are host
  staff, not data subjects of the tenant.
- **§5 (A6).** `revision` = a SHA-256 over the canonical stored row (first 16 hex), or `null`.
  PUT is a CAS against that row. DELETE checks then deletes, and the race is stated.

## Evaluation matrix (core surface, extension mode, no new toggle)

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Core host surface (`host/featureToggles/`), not a package. `access.ts` is host-level and imports only host modules (`featureBundles`, `entitlementSeam`); billing still registers into the seam, so no core→feature edge. |
| 2 | Toggle + admin UI | No new toggle. `FeatureTogglePanel` gains Kill/Restore, sends `revision`, shows a 409 conflict notice, and lists recent history. |
| 3 | Workflow surface | `ctx.features.*` now enforces the plan as well as the toggle (§1). No new surface. |
| 4 | Node pack | None. |
| 5 | AI chat / envelopes | No new envelope. Tools inherit §1 and refuse typed (`feature_disabled`). |
| 6 | Agent pack | None. Toggle administration is an operator surface, not a chat surface. |
| 7 | Public surface | None. `assignments` stays authenticated and caller-scoped. |
| 8 | RBAC | Superadmin-only writes (unchanged). Environments loses its write path to operator state (§2). |
| 9 | Replay | The kill switch and entitlement affect NEW resolutions only. Stamped variants are read verbatim. A replay re-executing a feature node of a now-unentitled tenant fails typed (`host_capability_disabled`), which is the same posture as a toggle turned off. |
| 10 | Frontend | `featureToggles/FeatureTogglePanel.tsx` (+ `i18n` ×4), `features/environments` (register type + copy ×4). `client/**` is not touched. |

**RFC verdict: host-extension only.** Every route is under `/v1/host/openwop-app/feature-toggles/*`.
Nothing touches the run-event wire or `/.well-known/openwop`.

## Phased plan (one PR)

| Phase | Content | Witness |
|---|---|---|
| P1 | §1 access resolver + exit migration + call-derived ratchet | S1 RED→green (tool lane + node lane); ratchet sabotage |
| P2 | §2 observe-only register + FE copy | S2 RED→green (both directions); environments suites updated to the new law |
| P3 | §4 audit + history route; §5 revision CAS | S4, S5 RED→green |
| P4 | §3 kill switch (service + disable-lock + panel) | kill beats an override; kill of a depended-on feature 409s; un-kill restores |
| P5 | §6 FEATURES.md correction + the toggle section updated for §1–§5 | doc review |

## Deferred (with reasons)
- **Exposure events / experiment readout.** This needs an event sink and an analysis surface.
  The CMS page-experiments z-test exists (ADR 0236/0294) and is the place to generalise it. That
  is a separate feature, not a security fix.
- **Attribute/segment targeting.** It needs a subject-attribute model the toggle subject does not
  carry (tenant + user only). CDP segments (ADR 0262) are the candidate source.
- **Scheduled flips and change approvals.** The approvals kernel can gate a flip
  (`approvalService`). It is valuable for a multi-operator host and premature for a
  single-operator one.
- **Per-person operator exemption on non-HTTP lanes.** A listed operator acting inside a
  CUSTOMER's workspace through chat is held to that workspace's plan (§1). The routes exempt
  them by person. Chat tools carry no `req`. The tenant-level exemption for the operator's own
  workspaces still applies.
- **A dispatcher for variant bindings** (§6).

## Open questions
- [ ] Should `observe-only` drift be visually distinct ("changed by the operator") in the
      environments UI? Today it reads as ordinary drift with the domain label.
- [ ] Should a kill also stop in-flight runs, or only new resolutions? Only new resolutions,
      matching `off`. A run already past a gate is not torn down.
- [ ] Should the history route be readable by a tenant for its own overrides? Not now; the
      operator surface stays operator-only.

## Implementation record (2026-10-05)

**Prod sizing (read-only, from the orchestrator).**
- `OPENWOP_BILLING_PLAN_FEATURES` and `OPENWOP_BILLING_BUNDLE_PRICES` are both set. The `free` plan
  lists 33 features, and there are zero entitlement rows, so every tenant is on `free`.
- Every priced-not-free toggle is `beta` (the open-beta sweep).
- **S1 was therefore LIVE for every tenant.** RED on `origin/main` @ `1f6d635fe`:
  `test/feature-toggles-adr0819-prod-plan.test.ts` (`openwop:campaign-brief.get-brief` returned a full
  brief to a free-plan tenant).
- S2 was latent: the `env:*` stores hold 0 rows, so removing the domain moves no environment's
  drift.

**User-visible consequence on deploy.** For free-plan tenants, these features' chat tools, MCP
projections, `ctx.features` nodes, collab rooms, schedules, triggers and chat recall start refusing,
matching what their HTTP UI already does: analytics, campaign-brief, campaign-channels,
campaign-connectors, campaign-intel, campaign-orchestration, campaigns, creative-briefs,
custom-domains, funnels, webinars, advisory-board, insights-suite. crm, csm and email already
refused on their tools. **Not `twin`** (corrected after the monetization gating audit): bundles.json
lists `twin`, while the toggle id is `twin-recall`, so `isSellableBundleFeature('twin-recall')` is
false and twin recall is not paywalled on ANY lane. This is tracked in the monetization PR
(openwop-app-97), which fixes `bundles.json`. The operator tenant is entitled to crm and marketing,
and is unaffected.

**Review.** After the `/architect` pass, a separate adversarial review agent read the implemented
diff and found 3 High issues, all fixed in the same pass:
- the public share-link gate and public docs were still paywalled;
- the S2 probes were vacuous after the fix (they used sellable ids);
- pre-0819 snapshots drifted permanently.

On an unnarrowed host, `resolveOne ≡ resolveToggle` for every toggle and subject
(`test/feature-toggles-adr0819-unnarrowed.test.ts`).

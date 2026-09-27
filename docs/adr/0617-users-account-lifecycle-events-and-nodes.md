# ADR 0617 — Account lifecycle host events + `feature.users.nodes`: a SCIM leaver can start the offboarding chain

Status: implemented (2026-09-02, feature loop 2026-09 iteration 1 — Users & Authentication; closes `UAUWF-1`, `UAUWF-3`, `UAUWF-4` from `WORKFLOWS-ASSESSMENT.md` § "Users & Authentication (ordinal 1) — 2026-09-01" and `USERS-10`/`-11`/`-12`/`-13`/`-14`/`-15`/`-16` in `CODEBASE-ASSESSMENT.md`; see § Implementation record)

Extends ADR 0002 (users, always-on), composes ADR 0208 §1 (the ONE host-event
seam + bindings), ADR 0613 (RFC 0159 leaver contract), ADR 0149 row 12
("Offboarding & Access Revocation — `core.trigger.event` (termination)"), ADR
0186 (`people-hr.*` provider-agnostic rewiring), ADR 0024 §4 (`actingUserId`
on runs), ADR 0572/0555 (side-effect floor + steward manifest). Sibling: ADR
0621 (session epoch) — the security leg of the same leaver sequence.

## Context

The doctrine says orchestration is a chain or a stack, never in-tree code — and
the users feature honours it by owning **no** orchestration at all
(`features/users/feature.ts:3` "no packs"). That was correct while the feature
was pure request-response. ADR 0613 changed the shape: a SCIM deactivation is
now the FIRST step of a sequence the product already ships as a chain —
`examples/workflow-chain-packs/people-hr/pack.json` `people-hr.offboarding`
(deprovision → accessTickets → finalPay → handoff → attest → notify), and its
joiner twin `people-hr.onboarding`. Measured on `c8bd25b1e`:

- **The event that should start the chain does not exist.** The host-event
  catalog has 45 types from 13 features
  (`git grep -hoE "'host\.[a-z-]+\.[a-z.-]+'" backend/typescript/src | sort -u`)
  and zero `host.users.*`. `features/users/` and the four `host/auth/*` modules
  contain no `emitHostEvent` call. `people-hr.offboarding` has no trigger node
  and can only be started by hand from the gallery.
- **The chain cannot act on THIS host's account.** Its `deprovision` node is a
  `core.openwop.http.openapi-call` against `core.openwop.connections.microsoft365`
  `disableUser` (`people-hr/pack.json` node `deprovision`). There is no node
  that disables the workspace account itself, because the feature ships no
  node pack.
- **The frontend catalog of bindable events is advisory and ungated.**
  `frontend/react/src/settings/hostEventCatalog.ts:27` `KNOWN_HOST_EVENT_TYPES`
  feeds a `<datalist>` on `EventBindingsPage.tsx:35,215`; the backend accepts any
  `^host\.` string (`routes/hostEvents.ts:65`). Its own docblock (`:1-26`) says
  ~15 emitters are missing and that the parity gate is "recorded as follow-on
  work in ADR 0584, not built". Nothing under `backend/typescript/test/` or the
  frontend tests references the list. A new event type is therefore ONE array
  edit away from the UI and zero tests away from being forgotten.
- **The leaver write is two durable writes with no local compensation.**
  `scimProvisioningService.deactivateUser` (`:97-107`) does
  `setUserStatus(disabled)` THEN `denyLinkedSubject(tenant, externalId)`; a
  throw between them leaves the SAML lane open until the IdP retries. Both keys
  are deterministic so the retry is idempotent — but that fact lives in nobody's
  head and no test.

## Decision

> **REVIEW CORRECTIONS (2026-09-01, `/architect` pre-implementation pass).** The
> first draft named "two create paths" and would have double-emitted
> (`upsertFromPrincipal:175` DELEGATES to `createUser`), missed two creators
> (the canonical fold `resolveCanonicalUserForTenant:312` and
> `host/demoPeopleSeed.ts:76`), re-emitted on every SCIM retry of an
> already-disabled row (the very retry D5 relies on), and had the deactivate
> node emit the event the offboarding chain is bound to — a self-trigger that
> would re-run the chain's UNGATED entry nodes (M365 `disableUser`, Workday
> `terminate-worker`). All four are corrected below; the review's
> enumeration-by-call-graph is the record.

**D1 — `features/users/emit.ts`: four ids-only lifecycle events, each from
exactly ONE site, each on a TRANSITION only.** Copy the `features/forms/emit.ts`
shape (sync `void` verbs wrapping `void emitHostEvent(...)`, never throwing on
the caller's path):

| Event | The ONE emit site | Guard | Payload (ids only) |
|---|---|---|---|
| `host.users.user.provisioned` | `usersService.createUser` (`:112`), after the idempotent `existing` return at `:123` — the single funnel for all FIVE creators: admin POST (`routes.ts:148`), SCIM `provisionUser` (`scimProvisioningService.ts:63`), `upsertFromPrincipal` (`:175` — SSO first login AND lazy `resolveCallerUser` on shared tenants), the canonical fold `resolveCanonicalUserForTenant` (`:312`, personal-tenant first access) and `host/demoPeopleSeed.ts:76` | new row only; the demo seed passes `{ silent: true }` (N seeded coworkers must not fan out N `provisioned` events to webhooks + bindings) | `{ userId, tenantId, source }` |
| `host.users.user.deactivated` | `usersService.setUserStatus(id, 'disabled', { reason })` (`:212`) — the ONLY status writer (`updateUser` `:190-192` and the PATCH route `routes.ts:187-191` cannot touch `status`); covers admin Disable AND both SCIM lanes | **only when `existing.status !== status`** — a SCIM/IdP retry on an already-disabled row (the D5 compensation) MUST NOT start a second offboarding run | `{ userId, tenantId, source, reason: 'admin' \| 'scim' \| 'workflow' }` — `reason` is a NEW explicit argument on `setUserStatus` (three callers updated), never inferred from `user.source` (an admin can disable a SCIM-sourced row) |
| `host.users.user.reactivated` | same site, `status === 'active'` | same transition guard | `{ userId, tenantId, source, reason }` |
| `host.users.user.erased` | the erase route (`routes.ts:278`) **after `deleteUser` succeeds** — not after `eraseSubject` returns, and never on the `failed > 0` throw (`:271-277`): a "failed" `erased` event is a false claim | success only | `{ userId, tenantId, outcome }` |

`source` is the User's auth source (`password`/`oidc`/`saml`/`scim`), not a
PII field. **Never** `email`, `userName`, `externalId` or `NameID` — the
dispatcher's `stripPiiPayload` (`hostEventDispatcher.ts:153-171`) only strips
`email`/`phone`-shaped keys; `userName`/`externalId` would pass it, so the rule
is the emitter's, enforced by a test that pins the payload keys. `deleteUser`'s
other caller, `demoPeopleSeed.ts:198` (demo teardown), emits nothing — stated.

**D1a — Self-trigger guard (review BLOCKER-2).** When the emit originates from
the workflow surface (D2), the event carries `origin: { runId, workflowId }`, and
`emitHostEvent`'s binding loop (`hostEventDispatcher.ts:196`) skips any binding
whose `workflowId` equals the emitting run's `workflowId` — one `if`, a core
edit recorded here. Without it a human-started offboarding run's
`deprovision-host` step would emit `deactivated`, the tenant's binding would
start a SECOND offboarding run, and that run's ungated entry nodes would fire
again. Witness: a human-started `people-hr.offboarding` run completes with
exactly ONE run for that workflow.

**D2 — `feature.users.nodes` v1.0.0, two side-effect nodes, one shared
predicate.** `packs/feature.users.nodes/{pack.json,index.mjs,schemas/}`
declaring `feature.users.nodes.deactivate` and `feature.users.nodes.reactivate`
(`role: "side-effect"`, `capabilities: ["side-effectful"]`, config/input/output
schemas with ADR 0525 `$id`s — do NOT repeat `NP-CMS-2`'s no-schema shape).
Bodies do zero auth: they call `ctx.features.users.{deactivate,reactivate}` on a
NEW `features/users/surface.ts` (`buildUsersSurface`, registered via
`feature.ts` `surface: { id: 'users', build }` + `requiredPacks`). The surface
resolves `scope.tenantId` + `scope.actingUserId` (ADR 0024 §4; **absent on
SYSTEM runs ⇒ typed 403, fail-closed** — and an event-triggered run IS a
system run: the dispatcher stamps no `actingUserId`, see the resolved open
question below) and checks the SAME scope the route checks,
`host:members:manage` (`users/routes.ts:205`). To make it literally the same
predicate, extract the body of `featureRoute.requireTenantScope`
(`featureRoute.ts:258-272`) into

```ts
// host/accessControlService.ts
export async function assertTenantScope(
  tenantId: string,
  subject: string | undefined,
  scope: Scope,
  ctx: { personalTenant?: string; wildcardOperator?: boolean } = {},
): Promise<void>
```

and have BOTH lanes call it — the CLAUDE.md "route + tool share one predicate"
rule, and the `assertOrgScope` precedent (`accessControlService.ts:465-478`)
one level up. The route passes `{ personalTenant: personalTenantOf(req),
wildcardOperator: req.principal?.tenants?.includes('*') }`; the run lane
derives `personalTenant` from `getUser(actingUserId).tenantId` **iff it is
`user:`-prefixed** (a `user:` tenant is single-human by construction,
`usersGuards.ts:66-95`), and a `*` operator's run or a system run fails closed
(403 with the named exit). **The extraction MUST NOT enshrine a latent hole the
review found (SHOULD-1):** SAML sessions are minted with
`personalTenant: s.tenantId` — the single host-global `OPENWOP_SAML_TENANT`
(`routes/authSamlSso.ts:126`) — so for every SAML user whose active tenant is
that tenant `isOwnPersonalWorkspace` is TRUE and `requireTenantScope`
short-circuits before consulting membership: **any SAML member can PATCH,
disable or delete any user today.** `test/users-members-manage-gate.test.ts:6-12`
deliberately uses `sharedWorkspace: true`, so it is unpinned. The shared
predicate applies the `user:` prefix guard to the personal-owner short-circuit
on BOTH lanes, pinned by a SAML-tenant variant of that gate test. Filed as
`USERS-19` (Blocker) in the code tracker.

> **Implementation note (2026-09-02, review SHOULD-4).** The run-lane half IS
> wired: `features/users/surface.ts:89` calls
> `assertTenantScope(tenantId, actingUserId, 'host:members:manage', { personalTenant })`
> with `personalTenant` passed only for a `user:`-shaped home tenant, and the
> route half rides `requireTenantScope` → the same function
> (`host/accessControlService.ts` `assertTenantScope`, `isPersonalTenantId`
> gate in `host/requestSubject.ts`). **Deployment consequence, stated:** a
> SAML user is no longer the implicit owner of `OPENWOP_SAML_TENANT` — authority
> there is membership-derived (`resolveSubjectScopesUnion` = member roles ∪ ADR
> 0006 host-group roles, both keyed on a member row; captured IdP groups are
> NOT auto-mapped). A SAML-only deployment with no member rows answers
> `403 forbidden_scope` on admin routes until the first admin is seated via the
> wildcard operator key (`OPENWOP_API_KEYS=<key>:*`) or a host group — see
> README § "Who administers the SAML tenant". ADR 0621 § Implementation record
> carries the same note, plus the `requireMfa` half (review SHOULD-3). Pre-existing cost, accepted and
stated: `resolveSubjectScopesUnion` does three full `list()`s per call
(`accessControlService.ts:1322-1326`); the node lane pays it per execution.
The surface ALSO requires the acting user to be `active` via the ADR 0621
authority (review SHOULD-10): a run suspended at `attest` before its actor was
disabled must not execute the node on resume. Outputs are ids-only
(`{ userId, status }`). Replay: the node is served its recorded outcome on
`:fork`, never re-executed — pinned by a replay test in the
`comments-node-replay.test.ts` shape.

> **REVIEW CORRECTION (2026-09-02, adversarial review of the shipped D3 —
> BLOCKER-1).** The binding recipe below ("bind `host.users.user.deactivated`
> → the tenant's from-chain instance") was WRONG for this chain and would have
> run the downstream for the wrong employee. Facts measured on `d325c30f3`:
> `people-hr.offboarding` declares `required: ['employeeName']`, and
> `finalPay.config.workerName = {{params.employeeName}}` (Workday
> `terminate-worker`, an `EFFECT_TYPEIDS` member) is RFC 0013 Path-A FROZEN at
> instantiation; from-chain mints `workflowId = chainId:expansionId` where the
> expansion id folds the params in (`workflowChainPackLoader.ts`
> `deterministicExpansionId`), so the product shape is ONE instance PER
> departing employee. The dispatcher forwards an event's payload as
> `triggerData` only — no run inputs. A binding on Alice's instance would start
> a run for every later leaver whose UNGATED `finalPay` fires with Alice's
> frozen name. And D1a's guard was keyed on the instance id alone: with
> instances A (Alice) and B (Bob) and a binding on A, a human-started run of B
> emits `origin.workflowId = B ≠ A`, so A's binding fires and A's ungated entry
> nodes run again — the scenario D1a was written for.
>
> Corrected in two parts, neither of which invents a lookup node or dispatcher
> input-forwarding: **(a)** the D1a guard now ALSO compares chain LINEAGE —
> `HostEventOrigin.chainId` is stamped from the executing definition's
> `metadata.expandedFrom.chainId` (executor → `BundleScope.chainId` → the
> users surface, computed once per run body; no extra read on the emit path),
> and the binding loop resolves the BOUND workflow's definition through the
> catalog it already holds (`deps.hostSuite.workflowCatalog.getWorkflow`) ONLY
> when the emit carries a chain origin, skipping when the stamps match
> (`host_event_chain_lineage_skipped`). The instance-id compare is kept. The
> definition stamp, not the id's spelling, is compared, so a builder copy of an
> instance (authored id, stamp retained) is covered. Witness:
> `users-lifecycle-host-events.test.ts` — two REAL expansions of
> `people-hr.offboarding` (Alice, Bob), binding on Alice's + on a copy + on an
> unrelated workflow; Bob's run emits → only the unrelated workflow starts;
> the same event without an origin starts all three. Sabotage (disable the
> compare) → red. **(b)** the recipe is now honest: the HUMAN-started lane (one
> instance per employee, run from the gallery, `deprovision-host` behind
> `attest`) is the shipped lane; the EVENT lane is NOT safe to bind to this
> chain as shipped and stays unbound until **`UAUWF-7`** (a deferred instance
> whose employee identity comes from the event: a `feature.users.nodes.get`
> read node + dispatcher `triggerData.payload → inputs` forwarding on the RFC
> 0013 deferred lane — effort M, filed in `WORKFLOWS-ASSESSMENT.md`). The
> `core.trigger.event` root and the `deprovision-host` step stay (correct for
> the future lane, harmless on the manual lane per the witness); the ungated
> entry nodes stay as-is (ADR 0200's "revoke fast, then attest" shape is
> correct for a per-employee instance) and the README names them as the reason
> the event lane must not be bound. `UAUWF-1` is re-marked PARTIAL. The text
> below is left as written.

**D3 — Wire the chain, do not fork it.** `people-hr.offboarding` gains a
documented binding recipe (README + `docs/`): bind `host.users.user.deactivated`
→ the tenant's from-chain instance; the chain's trigger is the standard
`core.trigger.event` whose `payload` port carries `{ userId, ... }`
(`hostEventDispatcher.ts:211-215` → `ctx.triggerData` → `core.openwop.triggers/index.mjs:55`).
A new gated step `deprovision-host` (`feature.users.nodes.deactivate`) is added
BEHIND the existing `attest` approval gate — NOT before it — because the
IdP-driven deactivation already ended host access (ADR 0621) and the chain's
job is the downstream. **Edge shape and the ratchets that actually watch it (review Q5 / SHOULD-3):**
`workflow-chain-adr0149-clusters.test.ts:110` only asserts that a gate NODE
exists — it is not a convention that forces a new node behind a gate, and the
chain's own `deprovision` / `finalPay` / `accessTickets` are UNGATED entry
nodes today (stated, not changed here). The witness that governs the new node
is `workflow-chain-effect-reject-witness.test.ts`: add
`feature.users.nodes.deactivate` / `reactivate` to `EFFECT_TYPEIDS` (`:117`)
so the witness is not blind to them; wire ONE inbound edge
`{ from: 'attest', to: 'deprovision-host', condition: { type: 'truthy', left: 'approved' } }`;
and LEAVE `attest.decision → notify.message` unconditional — `notify` is in
`NOTIFY_OF_OUTCOME` (`:74,:306`) and the anti-rot assertion at `:428` requires
it to keep that edge. The node reads `userId` from the trigger's `payload`
port via a whole-object input binding (`payload.userId`), and `core.trigger.event`
outputs `payload: null` on a manual run (`core.openwop.triggers/index.mjs:55-58`),
so the manual lane supplies `userId` as a chain parameter and the node takes
`inputs.userId ?? params.userId`. Pack version bump `people-hr` (registry
republish owed — the `chain-pack-fix-needs-registry-republish` lesson).

**D4 — The catalog gets its gate.** Build the ADR 0584 follow-on now, because
this ADR adds the first event types whose ABSENCE from the datalist would make
the recipe in D3 undiscoverable: a backend test
(`test/host-event-catalog-parity.test.ts`) that extracts every `'host.…'`
string literal AND every `host.<x>.` template prefix under
`backend/typescript/src` (≥8 of the 27 emit sites build `type` from a template
or constant — `crm/emit.ts:30`, `territories/emit.ts:35`,
`sales-commissions/emit.ts:26`, `webinarProcessor.ts:130`, `adsAdapter.ts:410`,
`commerce/telemetry.ts:44`, `campaignService.ts:60`, `goalEvents.ts` — a
literal-only grep would silently exclude them, review SHOULD-4) and asserts the
expanded set ⊆ `KNOWN_HOST_EVENT_TYPES` (frontend file read from disk — the
`agent-prompt-tool-ids.test.ts` cross-tree shape), with the computed-site count
baselined shrink-only. Baseline the ~15 known
misses in a shrink-only fixture so the gate is red-on-growth from day one
without forcing a 15-feature sweep into this PR (the ratchet pattern; the
sweep is filed as follow-on). Per the `ratchets-police-spelling-not-invariant`
lesson: the test also asserts the emitter set is NON-EMPTY and that this ADR's
four types are members, so a broken grep cannot pass vacuously.

**D5 — Deny-first + fault-injection (`UAUWF-3`).** Reorder
`deactivateUser`/`setScimActive(false)` to write `denyLinkedSubject` FIRST
(the fail-closed lane) and `setUserStatus` second; document in the function
that the IdP retry is the compensation and both keys are deterministic. Test:
`denyLinkedSubject` throws ⇒ route non-2xx, no deny row, status still `active`
(the retry re-runs both); `setUserStatus` throws after the deny ⇒ non-2xx,
deny row present (SAML closed), status `active` (SCIM retry closes it).

## Boundaries audit

- Route collision: none — no new HTTP routes; the node lane is the pack +
  surface. `/v1/host/openwop-app/host-events/bindings` (ADR 0208) is reused.
- Concept duplication: the event seam is `hostEventDispatcher` (ONE); the RBAC
  predicate becomes `assertTenantScope` (ONE, shared by route + surface); the
  lifecycle owner is `setUserStatus` (ONE — the reason D1 needs a single emit
  site). No new store.
- Helper reuse: `features/forms/emit.ts` shape; `comments/surface.ts:95-108`
  `requireOrg` closure shape (tenant-level here); `core.trigger.event` +
  `forms-intake/pack.json:20` for the port-qualified trigger edge.
- Capability honesty: nothing advertised at `/.well-known/openwop` changes;
  RFC 0050/0159 conformance scenarios are untouched (they hit the validate /
  provision seams).
- Toggle: none (users is always-on; the node pack is `requiredPacks`-pinned
  like comments). No variants.
- Replay/fork: event-triggered runs are ordinary runs; the side-effect role is
  the fork guard.

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | extension of `features/users/` — `emit.ts` + `surface.ts` added; no core edits except the `assertTenantScope` extraction in `host/accessControlService.ts` (core, feature-free) |
| 2 | Toggle + admin UI | none — always-on |
| 3 | Workflow surface | NEW `ctx.features.users.{deactivate,reactivate}` behind `assertTenantScope(host:members:manage)`, fail-closed without an acting user |
| 4 | Node pack | `feature.users.nodes` v1.0.0 (2 side-effect nodes, schemas with `$id`s, steward-manifest digest, side-effect floor regenerated) |
| 5 | AI-chat envelopes | none — no new envelope kind (an agent tool for "deactivate user" is deliberately NOT added: a chat-driven lockout needs a human gate, and the chain's `attest` gate is that gate) |
| 6 | Agent pack | none |
| 7 | Public surface | none |
| 8 | RBAC + isolation | one predicate, route + node; tenant from the run scope, never from node args |
| 9 | Replay / fork | side-effect nodes served recorded outcomes on `:fork`; no variant stamp |
| 10 | Frontend | `hostEventCatalog.ts` gains the four types; no new page |

## RFC verdict

**Host-extension — no RFC.** `host.*` event types are the host's own namespace
(RFC 0086 §E naming); bindings are the ADR 0208 host-ext registry; the node
pack rides the already-Accepted RFC 0013 pack format.

## Alternatives weighed

1. **Trigger the chain directly from `deactivateUser`** (call `startWorkflowRun`
   in the SCIM seam). Rejected: that is in-tree orchestration — the exact
   generator the doctrine retires — and it hard-pins WHICH chain a tenant runs.
   Bindings keep the choice tenant-owned and builder-editable.
2. **Emit from the SCIM seam only.** Rejected: admin Disable would not fire the
   event; `setUserStatus` is the one choke all three lanes share.
3. **Put the deactivate node BEFORE `attest`** to "act fast". Rejected: ADR
   0621 already ends access at the identity write; the chain runs downstream
   effects and the gate is the human check on THOSE. Also violates ADR 0200's
   gated-write convention.
4. **A generic `feature.users.nodes.set-status`** with a status arg. Rejected:
   two verbs make the builder's gallery and the side-effect audit legible, and a
   free-text status is a closed-world leak.
5. **Skip D4 (the catalog gate) as out of scope.** Rejected: an undiscoverable
   event makes D3's recipe fiction — the `rendering ≠ working` lesson.

## Phased plan

| Phase | Work | Witness |
|---|---|---|
| P1 | `emit.ts` + four transition-guarded emits (ONE site each: `createUser` w/ `silent` for demo seed; `setUserStatus(id, status, { reason })`; erase route after `deleteUser`); D1a self-trigger guard in the dispatcher; catalog entries; **D4 parity gate (literals + template prefixes) with shrink-only baseline** | test: bind a workflow to `host.users.user.deactivated`; SCIM-deactivate via the conformance seam AND via `/scim/v2` PATCH; admin Disable — each starts exactly one run with the ids-only payload; payload-key pin (no `email`/`userName`/`externalId`); parity test red when a type is removed from the catalog (sabotage) |
| P2 | `assertTenantScope(tenantId, subject, scope, { personalTenant?, wildcardOperator? })` extraction with the `user:` prefix guard on BOTH lanes + the SAML-tenant gate test (`USERS-19`); `surface.ts` (acting user must be `active`); `feature.users.nodes` pack + schemas + `requiredPacks`; floor/served-set/steward-manifest regenerated; `EFFECT_TYPEIDS` += the two nodes | manifest↔impl parity, pin parity, schema-`$id`, replay test; node 403 without acting user; node 403 for a member lacking `host:members:manage`; node success emits `deactivated` exactly once (no double emit via the surface) |
| P3 | `people-hr` chain: `deprovision-host` behind `attest` via ONE `{truthy approved}` edge, `attest→notify` left unconditional, `core.trigger.event` entry, `inputs.userId ?? params.userId`; pack version bump; binding recipe doc; registry republish | chain-config conformance + effect-reject witness green; build ×2 byte-identical; manual run (no trigger) still completes; **one-run witness for the self-trigger guard** |
| P4 | D5 deny-first + fault-injection tests | the two fault tests above |
| P5 | closeout: `WORKFLOWS-ASSESSMENT.md` `UAUWF-1/-3/-4`, `NODE-PACK-AUDIT.md` row, `FEATURES.md` Packs column `feature.users.nodes`, this ADR → implemented |

## Open questions

- [x] **RESOLVED at authoring (measured `hostEventDispatcher.ts:209-216`):** an
  event-triggered run is started with `metadata: { triggerData, hostEvent }`
  and NO `actingUserId` — a SYSTEM run. So `feature.users.nodes.deactivate`
  fails closed (403) on an event-started offboarding run, by design. That is
  the right outcome: on the SCIM-leaver lane the host account is ALREADY
  disabled at the identity write (and its sessions ended by ADR 0621) — the
  chain's job there is the downstream. The host-deactivate step is for the
  HUMAN-started lane (an HR admin runs `people-hr.offboarding` from the
  gallery for a non-SCIM account). The recipe documents both lanes; the
  predicate is NOT widened, and a `core.approvalGate` approver does NOT become
  the acting user (that would be a new ADR on run-subject promotion).
- [x] `host.users.user.erased` carries the erased `userId` — **RESOLVED
  COMPLIANT (review Q4):** `userId` is declared non-PII
  (`declarePiiFields('users.user', ['email','displayName'])`,
  `usersService.ts:28-30`), it is the `subjectKey` `eraseSubject` is keyed on
  (`subjectErasure.ts:168-173`), the users eraser itself KEEPS it as the opaque
  skeleton (`:224-232`, the ADR 0464 REVIEWED_EXEMPT "keep opaque subject"
  precedent, `0464:145`), and the route already writes it post-erasure onto
  the audit chain (`routes.ts:283-289`). **ADR 0464 ruling recorded here:** the
  event creates two durable holders the erasure tripwire cannot see because
  neither is a `src/host` `DurableCollection` — `webhook_deliveries.payload`
  (`routes/webhooks.ts:343`, pruned by `OPENWOP_WEBHOOK_DELIVERY_RETENTION_DAYS`,
  `retentionSweepDaemon.ts:210-212`) and `run.metadata.triggerData.payload` on
  bound runs (`runartifact` exemption). Both hold only the opaque key.
- [x] The D4 baseline of pre-existing catalog misses: MEASURED at 9 literal
  types + 9 uncovered computed prefixes (`test/fixtures/host-event-catalog-baseline.json`),
  shrink-only; the sweep is the follow-on `UAUWF-6` (also carries the
  un-prefixed `crm.segment.entered` finding), not folded into this iteration.

## Implementation record (2026-09-02)

| Phase | Shipped in | Witness |
|---|---|---|
| P1 — D1 events (ONE site each, transition-guarded, ids-only) | `features/users/emit.ts` (new); `usersService.createUser(input, { silent? })` emits `provisioned` on a NEW row only (`host/demoPeopleSeed.ts` passes `silent: true`; `upsertFromPrincipal`, `provisionUser`, `resolveCanonicalUserForTenant`, the admin POST all delegate — grep-confirmed, zero second emit sites); `setUserStatus(userId, status, { reason, origin? })` — the `reason` argument added, the three callers updated (`routes.ts` disable/enable → `'admin'`, `scimProvisioningService.deactivateUser`/`setScimActive` → `'scim'`), `changed` decided INSIDE the CAS mutate on the disable lane; `erased` from `routes.ts` after `deleteUser` only | `test/users-lifecycle-host-events.test.ts` (11 — literal key-set pins per event, no emit on idempotent/silent/no-transition, SCIM retry silent, PII-key sweep); `test/users-lifecycle-event-lanes.test.ts` (3 — over the real app: conformance seam, `/scim/v2` PATCH, admin Disable each start exactly ONE bound run with `{userId,tenantId,source,reason}`; repeats start none; erase starts one `erased` run after `deleteUser`) |
| P1 — D1a self-trigger guard | `host/hostEventDispatcher.ts`: `HostEvent.origin?: { runId?, workflowId?, chainId? }` (stripped from the webhook envelope — not a wire field); the binding loop skips `binding.workflowId === origin.workflowId` and logs `host_event_self_trigger_skipped`; **review correction:** it ALSO skips a binding whose workflow was expanded from `origin.chainId` (`host_event_chain_lineage_skipped`) — see § Review corrections | same test file — an origin-equal emit starts NO run while a second bound workflow still starts; `setUserStatus` threads `origin` through; a sibling from-chain instance is skipped too |
| P1 — D4 catalog gate | `test/host-event-catalog-parity.test.ts` + shrink-only fixture `test/fixtures/host-event-catalog-baseline.json` (9 literal misses + 9 uncovered computed prefixes + computed-site count 10, all MEASURED on this commit); `frontend/react/src/settings/hostEventCatalog.ts` gains the four types and its docblock now says the gate is BUILT | 5 tests: anti-vacuity floors, the four types emitted AND catalogued, literal ⊆ catalog ∪ baseline (+ stale-baseline red), computed-prefix coverage + pinned count, and the reverse claim (every non-computed catalog row is emitted somewhere). Sabotage: removing `host.users.user.reactivated` from the catalog → 2 red; adding a catalogued type to the baseline → stale red |
| P2 — D2 surface + pack (**pack 1.0.0 → 1.0.1 on 2026-09-02, review SHOULD-2**) | `features/users/surface.ts` (`buildUsersSurface`: acting user required → ADR 0621 `resolveSessionSubject` must be `active` → `assertTenantScope(scope.tenantId, actingUserId, 'host:members:manage', { personalTenant })` with `personalTenant` only for a `user:`-shaped home tenant → in-tenant target → `self_lockout`); `feature.ts` `surface` + `requiredPacks`; `host/inMemorySurfaces.ts` `BundleScope.workflowId` + `executor.ts` passes `run.workflowId`; `packs/feature.users.nodes/` (2 nodes, `role: side-effect` + `side-effectful`, 6 schemas with ADR 0525 `$id`s, README); `executor/sideEffects.ts` explicit pattern (two-leg); floor/served-set/steward-manifest regenerated; `EFFECT_TYPEIDS` += both | `test/users-surface-authz.test.ts` (12 — system-run 403 named exit, editor 403, disabled/erased actor 403, self 409, IDOR 404/400, manager success = ONE event `reason: workflow` + origin skips the executing workflow while another bound workflow starts, repeat silent, personal-owner lane, pack-body precedence + typed refusal); `test/users-node-replay.test.ts` (6 — both legs, floor + served, `isSideEffectingNode`, schema `$id`s, closed ids-only output schema, pin parity); manifest↔impl, required-packs pin, pack-pin parity all green. Sabotage: removing the no-acting-user refusal → red |
| P3 — D3 chain (**recipe CORRECTED 2026-09-02 — the event lane is NOT bindable as shipped, `UAUWF-7`; see the D3 correction block**) | `examples/workflow-chain-packs/people-hr/pack.json` 1.2.5 → **1.3.0**, `people-hr.offboarding` 1.0.1 → **1.1.0**: `trigger` (`core.trigger.event` on `host.users.user.deactivated`) is the SOLE root feeding the three entry nodes on a named `trigger` port; `deprovision-host` (`feature.users.nodes.deactivate`, `config.userId: {{params.userId}}`) with EXACTLY ONE inbound edge `attest → {truthy approved}`, inserted BEFORE `notify` so `notify` stays the primary terminal; `attest.decision → notify.message` left unconditional; optional `userId` parameter; README with the two-lane binding recipe | `test/workflow-chain-people-hr-offboarding-host.test.ts` (7 — structure, param liveness, primary terminal, Path A freeze, `buildChainBackedDefinition` ×2 byte-identical, manual run reaches the pre-rewire terminal state); `workflow-chain-effect-reject-witness` / `adr0149-clusters` / `chain-config-conformance` / `people-hr-execution` / `chain-embed-deferred-parity` all green. **Registry republish of `core.openwop.workflows.people-hr@1.3.0` is owed.** |
| P4 — D5 deny-first | `scimProvisioningService.deactivateUser` / `setScimActive(false)` write `denyLinkedSubject` FIRST; docblocks state the IdP retry is the compensation and both keys are deterministic | `test/auth-scim-fault-injection.test.ts` (3 — deny throws ⇒ non-2xx, no deny row, status active, retry lands both; status throws after the deny ⇒ non-2xx, deny row present, order observed; same on the seam lane). Sabotage: reverting the order → 3 red |
| P5 — closeout + hygiene rows | `USERS-13`: `subjectLinkRealmAlignment()` (`host/auth/subjectLinkService.ts`), discovery withholds `subjectLinking` when a production SP's tenant ≠ the SCIM realm, `index.ts` logs `subject_link_realms_misaligned` at boot, README + `.env.example` say MUST; `USERS-14`: `requireBearerForLinkRealmWrite` — externalId-addressed seam ops 403 `scim_bearer_required` when a production SAML SP exists and no bearer is configured; `USERS-15`: `userId`/subject digest in the SCIM/SAML seam logs; `USERS-16`: `appendAudit` ids-only rows for `/scim/v2` PATCH/DELETE + the seam (`actor: 'scim'`) and admin create (`users.lifecycle.create`) + PATCH (`users.lifecycle.patch`, changed field NAMES only); stale `user:<uuid>` comments fixed in `authScim.ts` + `scimProvisioningService.ts`; `FEATURES.md` Packs column; `NODE-PACK-AUDIT.md` row | `test/auth-subject-link-alignment.test.ts` (4), `test/auth-saml-disabled-user.test.ts` (+2: production ACS refuses a denied linked subject; a misaligned-realm deny is invisible), `test/auth-scim-seam-externalid-guard.test.ts` (5), `test/auth-log-hygiene.test.ts` (4), `test/users-audit-rows.test.ts` (2) |

### Review corrections to the record (2026-09-02, adversarial review of `d325c30f3`)

| Finding | What changed | Witness |
|---|---|---|
| BLOCKER-1 (a) — D1a keyed on the instance id only | `HostEventOrigin.chainId` + `BundleScope.chainId` (executor stamps it once per run body from `definition.metadata.expandedFrom.chainId`; `runOneNode` threads it); dispatcher `boundWorkflowSharesChain` resolves the bound definition via the catalog only when the origin carries a chain, logs `host_event_chain_lineage_skipped`; `chainIdOfDefinition` exported for the executor | `users-lifecycle-host-events.test.ts` (+1: two real from-chain instances, sibling + copy skipped, unrelated starts; sabotage red); `users-surface-authz.test.ts` (+1: the surface stamps `origin.chainId` from the scope) |
| BLOCKER-1 (b) — the recipe would run another employee's offboarding | `people-hr/README.md` rewritten: human-started lane shipped, event lane NOT safe to bind (`UAUWF-7`), ungated entry nodes named as the reason; `WORKFLOWS-ASSESSMENT.md` `UAUWF-1` → PARTIAL, `UAUWF-7` filed; the D3 correction block above. `people-hr/pack.json` untouched (no version bump owed — README only) | — |
| SHOULD-1 — replay pinned by classification only | `users-node-replay.test.ts` gained a BEHAVIOURAL leg over `createApp`: a live run of the real pack node disables the target (one event, epoch 1); re-enable; `:fork` mode `replay` completes with the RECORDED `{status:'disabled'}` outputs, target stays `active`, epoch stays 1, zero new events. (`comments-node-replay` stops short of this by its own docblock, so it could not be cited instead.) Note: a stale steward digest surfaced as `pack_untrusted` on the live run — the manifest IS the trust attestation | that test (+1) |
| SHOULD-2 — `triggerData.payload.userId` above `config.userId` on the MANUAL lane (executor mirrors `run.inputs` into `triggerData`; an undeclared input retargeted the frozen param) | `feature.users.nodes` **1.0.1**: the payload is honoured only when `triggerData.eventName` starts with `host.users.user.`; input-schema descriptions say so; `$id`s → `/1.0.1/`; `requiredPacks` pin; steward digest; README | `users-surface-authz.test.ts` (+1: manual `inputs.payload` → config wins; foreign event name → config wins; users event → payload wins) |
| SHOULD-3 — the `active` lane was get→put | `usersService.swapUserRow` — the ONE read-CAS-retry loop (`bumpSessionEpoch` now rides it); the re-enable lane decides `changed` inside the mutate on the landed row, writes nothing when already active, never bumps the epoch | `users-lifecycle-host-events.test.ts` (+2: two concurrent re-enables emit exactly ONE `reactivated` — red before the fix (2 events); a re-enable racing an epoch bump lands `active`/epoch 2 — this second pin passes under the old code too on memory storage's put-then-CAS ordering, so it is a regression pin, not a discriminating witness) |
| NIT-1 — SCIM create lanes appended no audit row | `provisionUserWithOutcome` (`{ user, created }`; `provisionUser` is its wrapper); `authScim.ts` `auditScimCreate` on the seam `create-user` op AND `POST /scim/v2/Users`, ids-only, `actor: 'scim'`, NEW rows only (a mover re-provision appends nothing) | `users-audit-rows.test.ts` (+1 seam lane, and the `/scim/v2` case now asserts `create` first and no second create on the mover POST) |
| NIT-2 — the seam docblock did not warn about realm pre-seeding | `authScim.ts` header: never set `OPENWOP_TEST_SCIM_URL` on a host that will later get a production SP — deny rows pre-seeded under the SCIM realm become live SSO denials once the realms are aligned | — |

### Deviations from the decision text, stated

- **D3 — how `deprovision-host` learns `userId` on the event lane.** The decision said "via a whole-object input binding (`payload.userId`)" on the node's `payload` port. That would be a SECOND, unconditional inbound edge from `trigger` onto an effect node, which `workflow-chain-effect-reject-witness.test.ts` `structuralUngated()` flags as a gate escape (and which D3 itself forbids: "ONE inbound edge"). The node therefore reads the run-scoped, replay-persisted `ctx.triggerData.payload.userId` — the same datum `core.trigger.event` forwards on its `payload` port — with precedence `inputs.userId` → `triggerData.payload.userId` → `config.userId` (the frozen `{{params.userId}}`). Pinned in `users-surface-authz.test.ts` § "the pack body".
- **D3 — "a manual run still completes".** No run of `people-hr.offboarding` has ever completed in this host: the manual lane fails at the unwired M365 `deprovision` connector (`CONFIG_INVALID`) before `attest` (the MODE note in `workflow-chain-people-hr-execution.test.ts`). The witness asserts the manual run reaches the SAME terminal state as before the rewire (trigger + the two connector nodes complete, `deprovision` fails, `attest`/`deprovision-host` never run), not a completion the chain has never had.
- **D3 — trigger wiring.** The trigger is wired to the three parallel entry nodes on a named `trigger` port so it is the SOLE root, the shape every other event chain in the corpus uses (`crm-ops`, `forms-intake`, `meeting-ops`, …), rather than left as an isolated node. The `handoff` fan-in is untouched.
- **D2 — `workflowId` on the run scope.** `BundleScope` gained `workflowId?` (set from `run.workflowId` at the one `buildHostSurfaceBundle` call in the executor) so the surface can stamp `origin.workflowId` directly; comparing on `runId` via a run-store read at dispatch time was rejected as a second read on a fire-and-forget path with no consumer that needed it.
- **D5 / `USERS-14` — bearer requirement scope.** The tracker's "require the bearer for externalId-addressed ops" would fail the RFC 0159 conformance scenario, which drives the seam WITHOUT a bearer (`@openwop/openwop-conformance` `auth-subject-link.test.ts:72-96`). The guard is therefore scoped to the case that is actually exploitable: a host with a **production** SAML SP (`samlConfigured()`), where the deny realm feeds a real ACS. A pure-conformance host keeps the open posture; the residual is stated in the route docblock and pinned by the guard test.
- **`USERS-15` — `nameId`.** Logged as a 16-hex `subjectDigest` (sha256 prefix) rather than as an "opaque externalId": a persistent NameID SHOULD be opaque but is an email at many IdPs, so re-labelling the same value would not have removed the PII.
- **Pre-existing, observed, not fixed (out of scope):** the conformance seam `/v1/host/openwop-app/auth/scim/provision` is behind the global auth middleware (not a public prefix), which rejects a foreign bearer unless a healthy session cookie rides along — so with `OPENWOP_SCIM_BEARER` configured the seam is unreachable for a bearer-only caller; the lane tests present both. And `features/cdp/segmentEntryDaemon.ts` emits `'crm.segment.entered'` without the `host.` prefix, so no binding can ever match it (`routes/hostEvents.ts` requires `^host\.`) — outside the D4 scan by construction; filed for the `UAUWF-6` sweep.

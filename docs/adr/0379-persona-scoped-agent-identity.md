# ADR 0379 — Persona-scoped, tenant-independent identity for seeded agents (the fold-idempotency root cure)

Status: Accepted — implemented (P1 gate #1953; P2 substrate #1954 + new-mint #1956; P4 fold test + grandfathered-compat disposition; **P3 deferred-with-reason** — see the Phase 3/4 record)

Related: [ADR 0001 §fold-idempotency], `docs/steward/DATA-ASSESSMENT.md` (Orphan/Duplicate Generators — GEN-2a/2b/2c), #1896 (the dedup-on-fold patch), #1907 (GEN-1b fold key-rewrite). RFC 0086 (roster AgentRef), RFC 0002 (AgentRef), RFC 0072 (manifest inventory).

## Context

The anon→user adopt fold (`reassignTenant`) rewrites the `tenant_id` **column** and the JSON `tenantId`/`orgId` **values** of a row, and — since #1907 (GEN-1b) — the tenant-embedded **KV row key**. What it deliberately does NOT and CANNOT rewrite is an application id **string** that encodes the tenant and is referenced from elsewhere. Two seeded per-persona surfaces do exactly that:

- **`user_agents.agent_id = user.<tenantId>.<personaSlug>`** (`exampleDataSeed.ts:349,498`, `advisoryBoardSeed.ts:70`) — an immutable primary key that embeds the tenant. The fold's `UPDATE tenant_id` moves the row but the id string keeps `anon:<sid>`, so N adopted anon sessions fold in as **N distinct rows** → the "Chief of Staff ×N" duplication on `/agent-allowlists` (**GEN-2a**).
- **roster `rosterId = host:<random>`** (`rosterService.ts`) — a random id minted per creation. Distinct random ids fold in as duplicates (**GEN-2b**), and rosterId-keyed dependents (board / schedule / agentProfile / agent-depth) fold in as **orphans** when the pre-fold dedup drops the duplicate roster row they point at (**GEN-2c**).

**What is already done.** #1896 PATCHED the *symptom*: `dedupePersonasBeforeAdopt` deletes any anon row whose persona the target tenant already has, *before* the fold, and prod was cleaned. #1907 (GEN-1b) makes the fold rewrite tenant-embedded KV keys generally. But the **root** — a tenant-embedded / random id that duplicates *by construction* on every fold — remains. The dedup patch is a hand-maintained band-aid: it must be kept in lockstep with every new per-persona entity, and GEN-2c shows a class (rosterId-keyed dependents) already slips past it.

**The invariant we want** (the fold-idempotency rule from ADR 0001): *a folded / rekeyed tenant adds nothing the target already has.* That is achievable **structurally** — not by a dedup list — with a deterministic, parent-independent id: a **persona-scoped, non-tenant-embedded** id, so two tenants' same-persona rows share a primary key, collide on the fold's insert-if-absent, and dedup for free.

## Decision

Seeded per-persona agents get a **persona-scoped deterministic id that does not embed the tenant** — `user.<personaSlug>` (aligning with the existing pack-agent convention `<packId>.<agent>`, whose ids are already tenant-independent). The tenant is carried **only** by the row's `tenant_id` column / content `tenantId`, never by the id string. The roster `rosterId` likewise becomes deterministic per persona within a tenant's roster slice (`host:<personaSlug>`) rather than random.

On fold, two tenants' `user.iris` rows now collide on the PK, the fold's ON-CONFLICT / insert-if-absent keeps one, and the invariant holds by construction — no dedup pass required.

## The replay/fork constraint (the crux — why this is phased, not a big-bang rename)

The `rosterId` is a **dispatchable RFC 0086 AgentRef, stamped on runs** as an attribution block (`runStarter.ts`; read by `agentActivity.ts`). Replay and `:fork` read that stamp **verbatim** — it must never be retroactively rewritten (the ADR 0001 correction: durable stamps are read, not re-resolved). Therefore:

- **Old runs keep their old-scheme stamped ref.** Historical attribution must stay resolvable, or degrade gracefully to "unknown agent" — never error.
- **The new scheme applies to newly-minted ids only.** A data migration maps existing *rows* forward but does **not** touch stamped *run* attribution.
- **The `agentActivity` per-attribution index (keyed by rosterId) must tolerate both schemes** for the lifetime of any pre-migration run's retention window.

This is why the change is a sequenced program, not a rename: the id VALUE convention changes, but the RFC 0086 AgentRef *shape* is unchanged and old values remain valid dispatch/attribution refs.

## The isolation-critical safety point (the gate)

A persona-scoped id like `user.iris` is now **shared across tenants**. Every read/write of a `user_agent` / roster row MUST be tenant-scoped (filter by `tenant_id` / content `tenantId`). A lookup by `agent_id` **alone** — which is safe today only because `user.<tenant>.<slug>` is implicitly tenant-unique — would, after this change, return **another tenant's row**: a cross-tenant read (tenant-isolation is a gate, ADR-wide).

Today's write paths key on `user.<tenant>.<slug>`, which bakes the tenant into the lookup. Moving to `user.<slug>` **requires an explicit tenant filter at every read site**. Enumerating and proving every such site is tenant-scoped is the migration's highest risk and its gating pre-work (Phase 1). This ADR does not authorize any id change before that audit passes.

## Alternatives weighed

| Option | Pro | Con |
|---|---|---|
| **A. Keep tenant-embedded id + dedup-on-fold** (#1896, shipped) | No id migration, zero replay/fork risk | A hand-maintained band-aid kept in lockstep with every new per-persona entity; GEN-2c already slips past it; "delete before fold," not "collide by construction" |
| **B. Persona-scoped deterministic id** (this ADR) | The invariant holds *structurally*; retires GEN-2a/b/c at the root; no per-entity dedup list | An id-scheme migration touching hydration + every ref; replay/fork of stamped rosterIds; the cross-tenant-read isolation gate |
| **C. A stable-external-id → per-tenant-internal-id mapping layer** | Decouples the dispatch id from storage | A *second* id system — the "no parallel architecture" smell; more moving parts than B for the same guarantee |

**Chosen: B, phased.** It is the only option that makes the fold-idempotency invariant structural rather than maintained-by-hand, and #1896 already de-risks the urgency so the migration can be careful and gated rather than rushed.

## Phased implementation plan

- **Phase 0 — this ADR.** Record the decision and name the cross-tenant-read audit as the gating pre-work.
- **Phase 1 — isolation audit + guard (the gate).** Enumerate every read of a `user_agent` / roster row; prove each is tenant-scoped; add a test-enforced invariant that no agent lookup is by-id-alone. MUST pass before any id change. (S–M.)
- **Phase 2 — new-mint + compatibility read.** New seeds mint persona-scoped ids; roster minting becomes deterministic. Existing rows keep their ids; a compatibility resolver reads both `user.<tenant>.<slug>` and `user.<slug>`. No migration yet. (M.)
- **Phase 3 — migrate existing rows.** A data migration rekeys `user.<tenant>.<slug>` → `user.<slug>` per tenant with a GEN-1b-style ON-CONFLICT dedup, WITHOUT touching stamped run attribution; the `agentActivity` index tolerates both schemes. Preceded by the repair-before-constrain discipline (dedup dirty rows first). (M–L, needs a backfill.)
- **Phase 4 — retire the band-aid.** Once the invariant holds structurally, `dedupePersonasBeforeAdopt` (#1896) becomes a no-op and is removed; add the fold-idempotency test that asserts a double-fold of the same persona adds nothing.

## Phase 1 record (implemented 2026-07-17 — the isolation audit + structural guard)

Two exhaustive scout inventories (user_agents reads; roster + rosterId-keyed
dependents) + an architect verification pass that caught what the scouts
missed: the registry has ~9 `resolve()` callers, not 3, and TWO drifted
`visibleTo` copies existed.

**Live gaps found AND fixED (pre-existing, request-reachable):**
- `scheduled-agent-chats/routes.ts` `assertAgentResolves` had NO tenant gate —
  any tenant could bind another tenant's `user.*` agent to a scheduled chat.
- `channels/channelService.ts` channel-create batch + `addChannelAgent` — same
  class: cross-tenant agent bound into a channel and dispatched there.

**Structural changes:**
- `host/agentVisibility.ts` — the ONE visibility rule (`agentVisibleToTenant`)
  + the fail-closed `resolveAgentForTenant` (cross-tenant ≡ absent, no
  existence oracle). Both prior `visibleTo` copies delegate; the binding
  surfaces, `bootstrap/nodes.ts` (was inline CTI-1), and
  `executor/handoffGate.ts` (now takes the run's tenant) use it.
- Storage: `getUserAgent(tenantId, agentId)` / `deleteUserAgent(tenantId,
  agentId)` / `updateUserAgent(expectedTenantId, record)` — the tenant is in
  the SQL predicate on BOTH adapters; a silent tenant move is impossible (the
  one legitimate move, the boot `_anon→default` rewrite, names '_anon'
  explicitly). `getUserAgentAnyTenant` is the ONE escape hatch (the registry
  miss-hook, which has no tenant in scope) — tripwire-pinned to that caller;
  retired when Phase 2 re-keys the registry.
- Roster: `getRosterEntry/updateRosterEntry/recordHeartbeat/deleteRosterEntry`
  are `(tenantId, rosterId)` fail-closed (mirroring `getAgentProfile`); the
  ~30 caller-side `entry.tenantId !== tenant` post-checks are retired — the
  seam enforces the invariant. The 5 context-gated raw reads (kanban trigger
  attribution, org-chart view, roster cascade, agent-knowledge profile init,
  agent-tool persona) now thread their tenant.
- Route behavior: cross-tenant PATCH/DELETE of a user agent now answers a
  uniform **404** (previously 403 `forbidden_tenant` — an existence oracle).
- Tests: `test/adr0379-isolation-gate.test.ts` — structural predicate probes
  (both stores), the visibility-rule unit, route-boundary 404 probes, and
  three source-scan tripwires (roster store single-owner; the any-tenant
  escape hatch single-caller; binding surfaces must import the shared rule).

**Registry-keying ruling (architect):** the process-global registry keyed by
`agentId` alone stays for Phase 1 (ids are still globally unique). Re-keying
the `user.*` namespace by `(tenant, agentId)` is the **Phase 2 entry gate** —
it must land before any new-mint of persona-scoped ids.

## Phase 2 record — PR-A (the substrate; implemented 2026-07-17)

**Correction note (don't rewrite the plan above):** the phased plan understated
Phase 2's prerequisites. Persona-scoped ids require, BEFORE any new-mint:
(1) the `user_agents` PK becoming **composite (tenant_id, agent_id)** — pg
mig 34 / sqlite mig 36 (table rebuild) — which is also precisely the
structural fold-collision mechanism §Decision relies on; (2) the roster
`DurableCollection` key becoming **tenant-qualified**
(`<tenant>:<rosterId>`, app-migration v5 rekeys in place; a Phase-1 payoff:
the scheme is invisible outside `rosterService` because all access rides the
four accessors — and `listRoster` becomes a bounded prefix scan); (3) the
in-process agent registry keying **user agents by (ownerTenant, agentId)**
(`resolve/get/has(agentId, tenant?)`, `remove(agentId, tenant)`; tenant-less
lookups see pack agents only; the miss-hook + `hydrateUserAgentIntoRegistry`
thread the tenant, narrowing the any-tenant escape hatch to tenant-less
resolves only); (4) `AgentLabelResolver` threading the tenant (aligning with
its user-display sibling). a2a `agentExists` stays deliberately tenant-less —
a2a agent cards come from packs; `user.*` agents were never a2a-addressable
and now structurally cannot be. PR-A ships all of this with ZERO id-value
changes (old scheme still minted), so the substrate soaks independently
before PR-B changes what ids look like.

## Phase 2 record — PR-B (new-mint + compat; implemented 2026-07-17)

- **New mints:** POST /agents + both seeds mint `user.<slug>` (tenant only in
  the row/PK); advisor ids `user.advisor-<slug>`; roster ids deterministic
  `host:<slug>` with a per-tenant duplicate-persona 409 (mirroring the
  user-agent create). The rosterCascade chat-agent guard becomes
  `startsWith('user.')` (the architect-caught shape-parse fix — the tenant
  check lives in the P1 delete predicate).
- **Compat is inherent, not a resolver:** ids are opaque VALUES; old-scheme
  rows keep their ids and resolve under their tenant's registry/storage keys
  until Phase 3 migrates them (test-pinned via the legacy-shape fixtures that
  still pass).
- **The dependent-key class materialized** (the blast-radius check (e) made
  concrete by a failing seed test): stores KEYED by rosterId-derived values
  collide once rosterIds repeat across tenants. Fixed: seeded scheduler
  `jobId` now `<tenant>:<rosterId>:<slug>`; the **agent-profile collection is
  tenant-qualified** like the roster (keyer + app-migration v7, shape-agnostic
  expected-key rekey). Verified already-safe: twin grants (`grantKey` embeds
  the tenant), kanban boards (`subjectBoardId(tenantId, …)`), personal
  schedule ids. **Bonus authz fix:** `registerJob` now refuses an explicit
  jobId owned by another tenant (`jobid_conflict` → 409, unspecific message) —
  a pre-existing cross-tenant job-overwrite the audit surfaced.
- App-migration v6 = the promised v5 re-sweep for rolling-deploy stragglers.

## Phase 3/4 record (architect-ruled 2026-07-17)

**Phase 3 (migrate existing rows) — DEFERRED-WITH-REASON.** An exhaustive
reference inventory found **19 durable stores** persisting old-scheme id
references — several with the id EMBEDDED IN THE KEY (subject-memory scopes +
their vector namespaces, twin-grant keys, allowlist-override keys, seeded
scheduler jobIds) — plus `agent_run_activity`, which is verbatim-append-only
by the replay constraint. The #1907 fold machinery cannot be ridden (its
matcher is colon-bounded tenant segments; user-agent ids are dot-delimited),
so a full P3 means new sibling rewrite machinery across all 19 stores, where
one missed store breaks dispatch/memory/permissions for existing tenants. The
benefit is ONLY the transitional case (folds touching grandfathered rows) —
which `dedupePersonasBeforeAdopt` already covers, because it matches by
PERSONA, not id. Deferred; revisit trigger: the persona dedup missing a class
again. (The old GEN-2c class — rosterId-keyed dependents orphaned by the
dedup — is now structurally covered even for old rows: Phase 2's
tenant-qualified dependent keys are colon-bounded, so the fold's
`rekeyTenantSegment` moves them with collision-dedup.)

**Phase 4 — reshaped, implemented.** The band-aid is NOT removed: post-P2 it
is REQUIRED (two same-persona new-scheme rows share an agent_id, and the
fold's blanket `UPDATE tenant_id` would hit the composite-PK conflict without
the pre-fold dedup — a stronger reason than the cosmetic one it was born
with). It is re-documented as the grandfathered-compat + pre-fold-collision
layer, retired only on P3 or old-tenant attrition. The structural invariant
ships as `test/adr0379-fold-idempotency.test.ts`: a same-persona fold adds
nothing, a DOUBLE fold adds nothing, and the dedup→fold ORDER is pinned
(skipping the dedup must never silently duplicate).

## Open questions / decisions checklist

- [x] Does `agentProfile` activation key on `agent_id`? **Answered (Phase 1
  audit): no —** it keys on tenant-guarded `profileId`
  (`getAgentProfile(tenantId, profileId)`, fail-closed) and
  `findAgentProfileForAgentId` only resolves `host:*` ids through the same
  guard. Profile bindings survive an agent_id rekey untouched.
- [ ] Pack-published agents already carry tenant-independent ids (`<packId>.<agent>`). Confirm the seeded-agent scheme is just extending that convention (align, don't invent).
- [x] Do widgets / public credentials embed the `rosterId` in a URL?
  **Answered (Phase 1 audit): no —** public embeds use opaque `wgt_<48hex>`
  tokens (`chat-widget/widgetService.ts`); the rosterId lives only in the
  widget ROW's `agentId` content, so Phase 3 must rewrite that binding but no
  public link breaks.
- [ ] Confirm no normative wire impact: the RFC 0086 AgentRef shape is unchanged; only the id VALUE convention changes and old stamped values stay valid. (If any conformance fixture pins an id *value*, that is a fixture update, not a wire change.)

## Consequences

- Retires GEN-2a/2b/2c at the root; the fold-idempotency invariant becomes structural and test-enforced rather than a hand-kept dedup list.
- Requires a careful, isolation-gated migration; the Phase-1 cross-tenant-read audit is make-or-break and blocks the rest.
- No new wire (host-internal id-VALUE convention; the AgentRef shape and old stamped values are unchanged). No RFC required; this is host work under an already-accepted RFC 0086.
- Until Phases 1–4 land, #1896 + #1907 remain the operative mitigations and the symptom stays contained.

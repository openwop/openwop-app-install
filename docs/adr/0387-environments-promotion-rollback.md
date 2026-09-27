# ADR 0387 — Environments: per-tenant config promotion + rollback + history

**Status:** implemented (Phases 1–5, 2026-07-17, branch `feat/adr0387-environments`)

**Date:** 2026-07-17

**Implementation record + correction notes (2026-07-17):**

| Phase | Landed as |
|---|---|
| 1 — model + seam | `features/environments/` KV stores (`env:environment`/`env:snapshot` keyed `${tenantId}:${hash}` tenant-scoped/`env:promotion`); canonical-JSON SHA-256 hash; `host/configDomains.ts` `registerConfigDomain` inversion seam (mirrors `forms/submissionSinks.ts`); the `feature-toggles` domain. Toggle OFF. |
| 2 — publish-pointers + promote/rollback | `publish-pointers` domain (FUNNELS — see correction); `movePointer` (CAS on the Environment row) + `promote` (order+1) + `rollback` (prior hash) + append-only ledger + `diffSummary`; drift detection ON DEMAND (`?drift=1`, never per-render). |
| 3 — RBAC | admin-only fail-closed writes (`host:members:manage`, deny-on-throw); reads = `workspace:read`. HITL approval CARD deferred (the `movePointer` `approvalId` seam is in place — a zero-rework additive follow-up). |
| 4 — read surface | (folded into routes: `GET …/environments`, `…/snapshots`, `…/promotions`, `…/preview`). Read node pack DEFERRED (the promote-node parity helper). |
| 5 — admin SPA | `/environments` (Admin tier): env cards + protection + drift + snapshot list + apply-to-live + promotion wizard + history ledger; 4-locale i18n. |

- **Correction — a new CAS helper was added to the toggle OWNER, not `saveConfig`.**
  `saveConfig` whole-row-replaces the shared (cross-tenant) `ToggleConfig`, so
  concurrent tenant restores would clobber. `host/featureToggles/service.ts` grew
  `setTenantOverrideStatus` + `listTenantOverrides` (CAS-loop, `status:null`
  deletes the key — "no override" ≠ "override off"). `environments` composes the
  owner's new public seam; it never touches the toggle store. (/architect ruling 1.)
- **Correction — restore is EXACT-MATCH.** Import applies every override in the
  snapshot AND clears live overrides the snapshot omits, so `import(export(state))`
  hashes back to the snapshot (pinned by a round-trip test). Additive restore would
  make the drift detector immediately report drift against a just-restored state.
- **Correction — promotion is a POINTER move (git-branch semantics); a separate
  `applyToLive` materializes a snapshot as the live config** (the only path that
  calls domain `import`). Given one tenant == one live config and "the live panel
  stays authoritative" (open question 2), promote/rollback advance blessed-config
  pointers + the ledger; apply-to-live is the gated restore.
- **Scope — `publish-pointers` covers FUNNELS in v1.** CMS page/locale publish
  pointers join the SAME domain in v2 once the cms owner exposes a tenant
  page-scope enumerator and the ADR 0066 content-approval interaction is designed
  — the seam grows without touching `environments` (the ADR's stated extensibility).
- **Deferred (recorded):** the HITL approval card for protected promotion (seam
  ready via `movePointer.approvalId`); the read node pack + promote node (v1.1,
  per the ADR's own phasing).
- **Scaling note (code-review):** drift is computed only on `?drift=1` and the
  admin SPA requests it once per page LOAD (never per render). The
  `publish-pointers` export runs one `funnels.list()` full-collection scan per
  drift computation — acceptable for a rarely-loaded, admin-only surface. If
  environments ever moves off the admin tier, add a per-tenant funnel index to
  drop the scan.
- **Grade pass (2026-07-17, same-day):** `applyToLive` is per-domain isolated —
  every domain attempted, outcomes reported, a partial apply surfaces as a 409
  naming the failed domains (imports are exact-match idempotent → retryable),
  never a silent half-restore; the promotion ledger is capped at 200 rows/tenant
  (oldest pruned); the SPA confirms (danger-styled) before apply-to-live.
  **Residual (recorded, low):** snapshot rows GC only at tenant teardown (an
  unreferenced-hash GC is future work); `reorderTerms`-class last-writer-wins
  admin writes.

**Feature package:** `environments` (NEW) · **Toggle:** `environments` (OFF, bucket `tenant`) · **Category:** Admin

**Lane:** net-new feature-package + admin surface — host-extension only, **no OpenWOP wire RFC** (see § RFC gate).

**Depends on / composes:** ADR 0001 (feature-package architecture), ADR 0006 (RBAC — promotion-to-prod authority), ADR 0015 (workspace-as-tenant — the scope a snapshot belongs to), ADR 0052 (app-release versioning + the `APP_MIGRATIONS` runner — the **adjacent** app-code axis this ADR deliberately does NOT fork), the feature-toggle store (`host/featureToggles/service.ts`), the connection store + BYOK secret refs (`features/connections/connectionsService.ts`, `byok/secretResolver.ts`), the funnels/CMS publish state (`features/funnels/funnelsService.ts`, `features/cms/routes.ts`), and the existing HITL approval seam (interrupt cards).

**MyndHyve baseline:** P1.2 in `docs/steward/MYNDHYVE-GAP-ANALYSIS.md` ("**MISSING**, L; ADR 0052 bundle-release versioning is adjacent, not equivalent"). Reference intent (capability only): environment cards (status, deployed version), Configuration / Promotions / History tabs, a promotion wizard, a rollback dialog, per-env secrets.

---

## Context

MyndHyve ships a first-class **Environments** subsystem: named `dev` / `staging` / `prod` targets, each carrying its own configuration, with a promotion flow that copies a verified configuration up the chain, a rollback dialog that restores a prior state, and a history/audit tab. openwop-app has **no equivalent product surface**. It DOES have the closest adjacent seam — ADR 0052's app-release versioning + boot-time `APP_MIGRATIONS` runner — but that versions the **application code + schema** that a self-hoster deploys (the WordPress `db_version` model). It is code-lane. Environments is **tenant-config-lane**: it versions the *configuration a tenant has authored inside a running deployment* (which feature toggles are on, which funnel is published, which connection is bound). These are two orthogonal axes and conflating them is the trap the gap analysis flags ("adjacent, not equivalent").

**The central scoping question — what IS an "environment" in openwop-app terms?** The honest v1 answer: **an environment is a named, ordered, protection-tiered snapshot-set of a tenant's own CONFIG** — not a separate Cloud Run service, database, or infrastructure deployment. A "promotion" copies a content-hashed config snapshot from one environment to the next (dev → staging → prod); a "rollback" is a promotion of a prior snapshot back onto an environment; "history" is the append-only ledger of those promotions. This is deliberately a **config-versioning** product, not an **infrastructure-provisioning** product. Infra-level environments (separate services/DBs per env) are named as an explicit non-goal below (§ Alternatives), because in this app one tenant == one workspace inside one shared deployment (ADR 0015) — there is no per-env infrastructure to provision, and pretending otherwise would be a dishonest surface.

## Boundaries / existing-seam audit (MANDATORY)

The config an environment snapshots is **already stored**, owned by feature packages, scattered across several stores. Environments must **read/write those stores through their owners' seams**, never reach into their KV rows directly (ADR 0001; the ADR 0330 submission-sink inversion is the precedent — the integrator registers a contributor, the owner never reverses the dependency).

| Config domain | Owner + store (file:line) | Shape / notes |
|---|---|---|
| **Feature-toggle state** | `host/featureToggles/service.ts:26` — `DurableCollection<ToggleConfig>('feature-toggle')` over `host_ext_kv`; per-tenant state lives in `ToggleConfig.tenantOverrides` (`host/featureToggles/types.ts:66`), mutated via `saveConfig` (`service.ts:30`). **Gotcha (FEATURES.md):** a stored override row SHADOWS the compiled `toggleDefault` — store-first resolution. A snapshot must capture the *effective* per-tenant override set, and restore by writing overrides, not by assuming the compiled default. | Cleanest domain: self-contained KV, per-tenant, no cross-refs. **v1 in-scope.** |
| **Funnel / CMS publish pointers** | `features/funnels/funnelsService.ts:33` (`FUNNEL_STATUSES = draft\|published\|archived`, `publishedAt` :83, publish at :268); `features/cms/routes.ts:496` (`setLocalePublishState(...'published'...)`, per-locale). | Publish *pointers* (which version/slug is live), not the page bodies. **v1 in-scope** (pointers only — see D3). |
| **Connection bindings** | `features/connections/connectionsService.ts` — NON-secret metadata (provider, kind, scopes, status) in its own store; **secret material NEVER in that store** — it lives behind the BYOK envelope keyed `connection:<connectionId>` via `setSecret`/`resolveSecret` (`byok/secretResolver.ts:224,291`). | A snapshot may carry the **binding metadata + a secret REF** (`connection:<id>`), **never a secret value**. **v1: refs-only, secret values deferred** (D3). |
| **Workflow-template pins** | `features/workflow-author/` (authored workflow drafts/templates). | Candidate config domain, but templates are not yet content-hash-versioned in a way a snapshot can pin cleanly. **v1-deferred** (register the domain contributor in v2 once the store exposes a stable version handle). |
| **App version + schema counter** | `host/appMigrations.ts:35` (`app_migration_version` in `__app_meta`), `__schema_version` — **ADR 0052, the code/schema axis.** | **Out of scope by design.** Environments versions tenant CONFIG; ADR 0052 versions the deployed CODE. An environment card MAY *display* the deployed app version (read from `/readiness`, ADR 0052 D4) as context, but never promotes it. This is the precise boundary the gap analysis names. |

**Tenancy:** each snapshot, environment, and promotion is scoped to a single tenant/workspace (ADR 0015). There is no cross-tenant environment. `bucketUnit: 'tenant'` (a shared B2B admin surface).

**Persistence for the new subsystem:** environments/snapshots/promotions are the feature's own `DurableCollection`s over `host_ext_kv` (the ADR 0383 KV-blob precedent — **no SQL migration**). Content-hash + ledger rows are additive blobs.

## Decision

Ship a new **`environments`** feature-package that models a tenant's config as **named, content-hashed snapshots** with **promote** (copy a verified snapshot to the next environment), **rollback** (promote a prior snapshot), and an **append-only history ledger**. Config domains are contributed through an **inversion seam** so environments never imports a config owner's internals.

### D1 — Data model (all KV blobs over `host_ext_kv`, tenant-scoped)

- **`Environment`** — `{ id, tenantId, name, order, protection }`. `name` ∈ typically `dev`/`staging`/`prod` but free (a tenant may add `qa`). `order` establishes the promotion chain (promote only targets `order+1`, D4). `protection` ∈ `'open' | 'protected' | 'locked'` — `prod` defaults to `protected` (RBAC-gated promotions, D6). Environments are **pointers to a current snapshot hash**, not stores themselves: `Environment.currentSnapshot: <hash> | null`.
- **`ConfigSnapshot`** — `{ hash, tenantId, domains: Record<DomainId, DomainPayload>, createdAt, createdBy, sourceEnv }`. A **typed bundle** of the in-scope config domains (D2), plus a **content hash** (canonical-JSON SHA-256 over the domain payloads). Two identical configs hash identically ⇒ a re-promote is idempotent (D7). Snapshots are **immutable + content-addressed** (the store dedupes on `hash`).
- **`Promotion`** — `{ id, tenantId, fromEnv, toEnv, snapshotHash, actor, diffSummary, approval?, createdAt }`. `fromEnv` is `null` for a rollback (the snapshot comes from history, not a sibling env) — `rollback = a Promotion whose snapshot is a prior hash of the target env`. `diffSummary` is a per-domain added/changed/removed count computed at promote time. `approval?` references an interrupt-card approval id when the target is `protected` (D6). The Promotion ledger is **append-only** — it IS the History tab.

### D2 — Config-domain inversion seam (`registerConfigDomain`)

A host registry `registerConfigDomain({ id, label, export, import, diff })` inverts the dependency: each config **owner** registers a contributor; `environments` calls `export()` to build a snapshot and `import(payload)` to restore one, and never imports the owner. `export`/`import`/`diff` all run **through the owner's existing public seam** (e.g. toggles' `getEffectiveConfig`/`saveConfig`), so tenant-isolation and validation stay with the owner. This mirrors ADR 0330's submission-sink inversion. **v1 registers two domains:**

1. **`feature-toggles`** — export the tenant's effective override set (`listEffectiveConfigs` filtered to `tenantOverrides[tenantId]`), import via `saveConfig`. Honors the store-shadows-default gotcha (restores overrides explicitly).
2. **`publish-pointers`** — export funnel publish status/slug + CMS per-locale publish state; import by re-applying publish/unpublish through the funnels/CMS services (pointers only, not bodies — D3).

`connections` (binding metadata + secret **refs**, never values) and `workflow-templates` register later (v2) as additional contributors — the seam grows without touching `environments`.

### D3 — What a snapshot carries vs. does NOT

- **Carries (v1):** feature-toggle overrides; funnel/CMS publish pointers.
- **Carries as REF only:** connection bindings reference `connection:<id>`; the **secret value is never copied into a snapshot** (BYOK envelopes stay put — `byok/secretResolver.ts`). Promoting a config that binds a connection promotes the *binding*, and the target env resolves the same secret ref at runtime. **Per-env distinct secret VALUES are explicitly deferred** (v2 open question — would need per-env secret scoping in `secretResolver`).
- **Does NOT carry:** page/document bodies, run history, CRM/commerce business data (that is *data*, not config), or the deployed app version/schema (ADR 0052's axis). A snapshot is small and config-only.

### D4 — Promotion chain + D5 — Drift detection

**Promotion** copies a source env's `currentSnapshot` to `toEnv = fromEnv.order + 1` (dev→staging→prod). The wizard shows the `diffSummary` before commit; on commit the target env's pointer moves to the snapshot hash and a `Promotion` ledger row is appended. Skipping the chain (dev→prod) is allowed only from a `protected`-override with admin authority (D6), else the wizard offers the next legal hop.

**Drift detection (D5):** an environment's live config can change *outside* a promotion (an admin flips a toggle directly). On environment read, `environments` recomputes the live config hash via each domain's `export()` and compares it to the env's `currentSnapshot.hash`; a mismatch surfaces a **"drifted — N domains changed since last promotion"** banner with a *"snapshot current state"* action (captures the live config as a new snapshot) — this is honest state, not silent overwrite.

### D6 — RBAC + approval

Promotion authority is **fail-closed** (ADR 0006): promoting to a `protected`/`locked` environment (prod by default) requires an **admin** scope; the route + any node share **one access predicate** (the ADR 0315 route↔tool-parity rule). A `protected` environment MAY additionally require an **approval gate** — reuse the existing HITL interrupt-card seam: the promotion is staged, an approval card is raised, and the pointer moves only on approve. No new approval machinery. `locked` blocks promotion entirely (change-freeze).

### D7 — Replay / idempotency

Promotions are **idempotent by snapshot hash**: promoting hash `H` to an env already at `H` is a no-op (ledger notes it, pointer unchanged). Content-addressing means a rollback to a prior state produces the *same* hash it had before — history stays consistent and a promote is safely retryable (matches the ADR 0052 forward-only + idempotent discipline).

## Feature Evaluation Matrix (ADR 0001)

| # | Axis | Ruling |
|---|---|---|
| 1 | **Feature-package** | NEW `features/environments/` (ADR 0001). Own `DurableCollection`s (KV blobs, no SQL migration — ADR 0383 precedent). Registers the `registerConfigDomain` host registry + its own routes + admin surface. |
| 2 | **Toggle** | `environments`, **default OFF** (ADR 0001 §6 — brand-new), `bucketUnit: 'tenant'` (shared B2B admin surface, ADR 0015), `category: 'Admin'`, `salt: 'environments'`. While OFF: registry unarmed, no admin nav entry, zero behavior change. |
| 3 | **`ctx.features.environments` surface** | Read-only workflow surface (ADR 0014 Face 2): list environments + current snapshot hashes + drift state. The **promote action is NOT on the read surface** — it is a gated route/tool (RBAC, D6). |
| 4 | **Node pack** | `feature.environments.nodes` v1.0.0 — a **read** node (`environments.list` / `get-diff`) is honest and useful for "did staging drift from prod" workflow checks. A **promotion-trigger node** is the honest-v1 question: **YES, but gated** — a `promote` node is allowed only as a `protected`-env-respecting action that routes through the SAME access predicate + approval gate as the route (never a back-door around D6). If that parity can't be guaranteed in v1, ship read-only nodes and defer the promote node to v2. Recommendation: **ship read nodes v1; promote node v1.1 once the shared-predicate helper is factored.** |
| 5 | **Envelopes** | **None (v1).** Environments is an admin CRUD + ledger surface, not an in-run model-authored intent. No new RFC 0021 envelope kind (which would require an OpenWOP RFC). Justified: promotion is a human/RBAC action, not something an agent proposes mid-run through the durable-intent channel. |
| 6 | **Agent pack** | **None (v1).** No persona owns environments. (If a future "release manager" assistant is wanted, it rides the ONE chat via an agent+node pack per the CLAUDE.md reuse rule — not a new chat.) |
| 7 | **Public surface** | **None.** Environments is tenant-internal admin config; nothing is exposed to anon/public routes. |
| 8 | **RBAC** | Promotion to a `protected`/`locked` env = **admin-only, fail-closed** (ADR 0006); route + node share one predicate. Optional **approval gate** via the existing HITL interrupt-card seam. Read/list = any workspace member. |
| 9 | **Replay / fork safety** | Promotions **idempotent by content hash** (D7); snapshots immutable + content-addressed; rollback reproduces the prior hash. No run-fork interaction (config, not run state). |
| 10 | **Frontend** | New `/environments` admin page: **environment cards** (name, protection, current snapshot hash, deployed app version from `/readiness`, drift badge) + **Configuration** view (per-domain snapshot contents) + **Promotions** wizard (source→target, diff preview, approve) + **History** ledger + **Rollback** dialog (pick a prior snapshot). Plain `ui/` components + full 4-locale i18n (the `check-i18n` gate is FATAL). No new chat panel. |

## Phased plan

- **Phase 1 — model + seam.** `features/environments/`: `Environment`/`ConfigSnapshot`/`Promotion` KV collections; content-hash codec; `registerConfigDomain` host registry; the `feature-toggles` domain contributor. Toggle OFF. Tests: snapshot determinism, hash idempotency, tenant isolation.
- **Phase 2 — publish-pointers domain + promote/rollback.** Second domain contributor; promote (order+1) + rollback (prior hash) + append-only ledger + diffSummary. Drift detection (D5). Tests: promote/rollback round-trip, drift surfacing, ledger append-only.
- **Phase 3 — RBAC + approval gate.** Protection tiers; admin-only promotion to `protected`; optional HITL approval-card wiring; shared route↔node predicate helper. Tests: fail-closed authority, approval-gated pointer move.
- **Phase 4 — read node pack + `ctx.features.environments` surface.** `feature.environments.nodes` v1.0.0 (list/get-diff); Face-2 surface. (Promote node → v1.1.)
- **Phase 5 — admin SPA.** Cards + Configuration/Promotions/History tabs + promotion wizard + rollback dialog; 4-locale i18n; nav entry (Admin group). `ROADMAP`/`FEATURES` synced.

## Alternatives weighed

- **Infra-level environments (separate Cloud Run services / DBs per env)** — **REJECTED (v1, likely permanently).** In this app one tenant == one workspace inside one shared deployment (ADR 0015); there is no per-env infrastructure to provision, and self-hosters own their own deploy topology (ADR 0052). Modeling infra environments would be a dishonest surface promising isolation the platform doesn't provide. Named explicitly as a non-goal.
- **Reuse ADR 0052 release bundles directly as "environments."** — REJECTED. That is the code/schema axis (what version of the *app* is deployed), not the tenant-config axis (what *this tenant* configured). Conflating them is exactly the "adjacent, not equivalent" trap the gap analysis flags. Environments *displays* the ADR 0052 version but never promotes it.
- **Git-based config export (dump config to a repo, promote via PR).** — REJECTED for v1: heavy operator burden, no in-app history/rollback UX, and no tenant isolation story. The content-hashed snapshot ledger gives the same immutability + audit trail natively. (A config *export* affordance is a fine future add-on.)
- **Snapshot everything including data + secret values.** — REJECTED: snapshots must stay small + config-only; copying secret values across envs breaks the BYOK envelope model (D3). Refs-only.
- **environments reaches into each config store directly.** — REJECTED (ADR 0001 boundary): the `registerConfigDomain` inversion keeps tenant-isolation + validation with each owner (ADR 0330 precedent).

## Open questions + assumptions

- **Which config domains in v2?** Candidates: connection bindings (refs — near-ready), workflow-template pins (needs a stable version handle from `workflow-author`), CMS/document *bodies* (larger — probably stays out; that's content, not config). Assumption: the seam ships with 2 domains and grows without core changes.
- **Does the prod environment PIN toggle state vs. the live feature-toggle admin panel?** Tension: an admin can flip a toggle directly (the existing panel) *and* promote a snapshot. v1 answer: **the live panel remains authoritative; environments observes drift and offers re-snapshot** (D5) — it does NOT lock the panel. A future "env-pinned config freeze" (a `locked` env that rejects direct toggle writes) is an open question, not v1.
- **Per-env distinct secret VALUES** — deferred (would need per-env scoping in `secretResolver`; v1 promotes refs, same value resolves in every env).
- **Multi-env preview URLs** (a staging env served at a distinct URL) — a stretch that leans toward the rejected infra-level model; deferred and flagged as likely out-of-scope.
- **Assumption:** one promotion chain per tenant (linear `order`). Branching/parallel envs (two staging lanes) is not modeled v1.

## RFC gate

**NO new OpenWOP RFC.** Environments is a **host-extension**: it versions and promotes *this tenant's host-side configuration* (feature toggles, publish pointers, connection bindings — all host-ext KV surfaces). It adds **no run-event field, no capability flag, no event type, no endpoint contract on the `/v1` protocol surface, and no envelope kind**. New routes live under the non-normative host-extension namespace (`/v1/host/openwop-app/environments/*`). Nothing reaches the wire; nothing is advertised in `/.well-known/openwop`. Verified against the CLAUDE.md §"A spec change needs an RFC" test: no protocol surface is touched. Host work only.

## References

- `docs/steward/MYNDHYVE-GAP-ANALYSIS.md` P1.2 / platform-core "Environments" rows.
- ADR 0052 (app-release versioning + `APP_MIGRATIONS` — the adjacent code/schema axis).
- ADR 0006 (RBAC), ADR 0015 (workspace-as-tenant), ADR 0001 (feature-package architecture), ADR 0330 (submission-sink inversion — the `registerConfigDomain` precedent), ADR 0383 (KV-blob depth, no SQL migration).
- `host/featureToggles/service.ts`, `features/funnels/funnelsService.ts`, `features/cms/routes.ts`, `features/connections/connectionsService.ts`, `byok/secretResolver.ts`, `host/hostExtPersistence.ts`.


## Correction note — ADR 0479 (2026-07-24): the workflow-pins deferral resolves

The v1 boundary row deferred workflow-template pins "until the store exposes
a stable version handle." ADR 0474 shipped that handle (content-hash
revisions + `ownership.publishedRevision`), and ADR 0479 registers the
reserved D2 v2 contributor (`workflow-pins`). One correction to this ADR's
domain contract as originally stated: import is NOT one EXACT-MATCH register.
The built domains split into two registers — STATE domains (feature-toggles)
restore exact-match; PRODUCTION-POINTER domains (publish-pointers, and now
workflow-pins) restore APPLY-ONLY, with environment drift detection as the
honesty surface for omitted live pointers. Clearing a production pointer on
restore is a behavior change (a cleared workflow pin flips launches back to
head), which exact-match purity does not justify. `configDomains.ts` carries
the corrected contract comment.

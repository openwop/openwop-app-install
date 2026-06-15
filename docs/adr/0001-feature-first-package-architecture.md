# ADR 0001 — Feature-First, Package-Extension Architecture for openwop-app

- **Status:** Accepted — implemented (all six §6 phases landed on `feat/feature-first-toggles`)
- **Date:** 2026-06-08
- **Scope:** `openwop-app` (backend `backend/typescript/`, frontend `frontend/react/`)
- **Decision type:** Architectural direction + implementation.
- **Two calls owned by `/architect`:** pack-distribution mechanism (§2.4) and variant-evaluation authority (§3.4).

### Implementation status (§6 migration path)

| Phase | What landed | Key tests |
|---|---|---|
| 1 — Toggle registry + authority | `host/featureToggles/*` (bucketing, registry, service, validate), `/v1/host/openwop-app/feature-toggles/*` routes (superadmin admin + caller assignments), FE `FeatureAccessProvider`/`useFeatureAccess` + admin screen | `feature-toggles.test.ts` (22), `feature-toggles-routes.test.ts` (5) |
| 2 — Feature-manifest seam | `BackendFeature` + `BACKEND_FEATURES`/`registerBackendFeatures`; FE `featureTypes.ts` + `FRONTEND_FEATURES`; Widgets migrated | `register-all-routes.test.ts` |
| 3 — Pack pipeline unblock | config-driven `OPENWOP_LOCAL_PACK_PREFIXES` incl. `feature.` | `local-pack-prefixes.test.ts` (4) |
| 4 — CRM end-to-end | `feature.crm.nodes` pack, contacts + toggle-gated routes, variant stamp into `run.metadata`, FE page + gated nav | `crm-feature.test.ts` (6) |
| 5 — Replay/fork safety | stamp survives `:fork` verbatim after toggle-off; packs decoupled | `feature-replay-fork.test.ts` (2) |
| 6 — CSM + docs | CSM as a pure addition (plain on/off, no packs) | `csm-feature.test.ts` (2) |

Two decisions were corrected against reality during implementation, both documented inline:
the variant stamp lives in **`run.metadata`** (not RFC 0056 annotations — they don't
survive `:fork`; §3.4/§7.6), and the stamp is kept off the normative `RunSnapshot` wire,
surfaced via a host-ext provenance read.

---

## 0. Why this exists

We are about to build a series of product features (CRM, CSM, and more) on top of
openwop-app. Two goals drive a structural change:

1. **Feature-first directory structure** — each feature is a self-contained vertical
   (routes, UI, domain logic, data access, packs, tests), not smeared across
   layer-first folders.
2. **Features as independently-distributed packages** that extend a base app and can
   be toggled on/off/BETA — plus a new capability: **multivariant traffic-splitting**
   (ON = 100%, A50/B50, N variants summing to 100%).

This ADR records the current state, the target architecture, and the two decisions
routed through `/architect`, with a migration path that does not break openwop's
replay/BYOK/wire-shape guarantees.

---

## 1. Current-state assessment (with file references)

### 1.1 openwop-app structure
- **Not** an npm-workspaces monorepo — two independent packages:
  `backend/typescript/package.json` (`@openwop/app-server`, Express 4) and
  `frontend/react/package.json` (`@openwop/app-web`, Vite + React 18 + react-router 7).
- **Layer-first** throughout. Backend: `src/routes/` (43 modules), `src/host/` (85+),
  `src/executor/`, `src/bootstrap/`, `src/storage/`. Frontend: `src/chrome/`,
  loose domain dirs (`agents/`, `chat/`, `runs/`), `src/ui/`, `src/client/`.

### 1.2 Two manifest seams already exist (build on these)
- **Backend routes:** `src/routes/registerAllRoutes.ts` — a single ordered
  `ROUTE_MODULES` list (~lines 85-210); `registerAllRoutes(deps)` loops and mounts
  (lines 213-217), called once from `src/index.ts:379`. A CI guard
  (`test/register-all-routes.test.ts:14`) fails if any `src/routes/*.ts` `register*`
  export is missing from the list. Some entries are boot-time side effects (e.g.
  `userAgents:hydrate` at line 129).
- **Frontend routes + nav:** `src/chrome/features.tsx` — declarative `FEATURES:
  FeatureRoute[]` (from line 99) is the single source of truth; `App.tsx:76-91` renders
  routes from it and **nav auto-derives** (`WORKSPACE_NAV`, `ADMIN_NAV_GROUPS`, `NAV`,
  lines 212-247). Adding a page = one `FEATURES` entry.

### 1.3 Existing feature-flagging
- **No central registry.** Backend gating is scattered `process.env` reads —
  `OPENWOP_EXAMPLE_WIDGETS_ENABLED` (`routes/widgets.ts:57`),
  `OPENWOP_PACKS_TEST_NAMESPACE_ENABLED`, `OPENWOP_DEPLOY_POSTURE`,
  `OPENWOP_SURFACE_*`, etc. Frontend gating is build-time `VITE_*` only (no runtime
  toggles). `AppConfig` (`src/index.ts:76-127`) maps only ~6 env vars.

### 1.4 Existing modularity / extension template
- **`HostAdapterSuite`** (`src/host/index.ts:109-130`) — 15 pluggable slots passed to
  every route via `RouteDeps`. This is the existing dependency-injection seam to mirror
  for a feature-extension contract.
- **`host_ext_kv`** durable KV (`src/host/hostExtPersistence.ts`) backs sample host-ext
  services (Kanban, Roster, Org-chart) — a ready store for toggle/assignment state.
- Lookup registries exist (`AgentRegistry`, `WorkflowsRegistry`, `PromptStore`) but none
  are plugin loaders; they're boot-populated from fixed sources.

### 1.5 DB / migrations
- Forward-only, append-only numbered `MIGRATIONS` in `src/storage/sqlite/schema.ts`
  (`LATEST_SCHEMA_VERSION = 23`) with a parallel `src/storage/postgres/schema.ts`.
  Adding a table = bump version + add a migration fn in **both** backends. No ORM.

### 1.6 myndhyve feature-toggle system (the reference to match + extend)
- **Admin screen:** `myndhyve/src/components/settings/admin/FeatureTogglePanel.tsx`
  (Settings → Administration → Feature Toggles, `superAdminOnly`). Category-grouped
  cards, each a 3-button `ToggleButtonGroup` (Off / Beta / On).
- **States:** `enabled | disabled | beta | coming-soon`
  (`src/core/config/featureToggleTypes.ts:18`). 38-feature registry incl. `crm`,
  `commerce`, `email-marketing`.
- **Storage:** Firestore `site_settings/features` doc
  (`{ toggles: Record<id,status>, updatedAt, updatedBy }`); real-time `onSnapshot`.
- **Evaluation: frontend-only** via `useFeatureAccess()` Zustand hook
  (`src/core/config/useFeatureAccess.ts`); `isEnabled = enabled || beta`. **No backend
  gating, no HTTP API** — client writes straight to Firestore (superadmin via rules).
- **A/B already exists — but in a separate dev-only system:**
  `src/core/config/featureFlags.ts` has percentage rollout + **sticky bucketing**
  `(hashString(userId) + hashString(flagName)) % 100 < percentage` (lines 64-89). This
  is the seed we generalize to weighted multivariant.

### 1.7 Pack pipeline (must be reused — no new loader)
- **Disk:** vendored `openwop-app/packs/` synced one-way FROM `openwop-registry/packs/`
  via `scripts/sync-packs.sh`. Runtime dir `~/.openwop-packs` (`OPENWOP_PACK_DIR`,
  single root).
- **Node loader (lazy):** `src/packs/tarballLoader.ts` — imports `export const nodes`,
  registers fns, requires node `result.status === 'success'`. Resolved on first
  typeId reference via `src/bootstrap/nodePackResolver.ts:25-48`.
- **Agent loader (eager):** `src/packs/agentLoader.ts` — reads `manifest.agents[]` at
  boot; namespace must match pack name (RFC 0003 §B); bad agents skipped, not fatal.
- **Registry install:** `src/packs/registryInstaller.ts` — fetch
  `{registry}/v1/packs/{name}/-/{version}.{json,tgz,sig}`; **SRI** integrity check +
  **Ed25519** signature over `pack.json`; allowlisted extraction (`pack.json`,
  `index.mjs`, `schemas/ schemas/keys/ prompts/`); drops `.openwop-installed.json`
  trust marker; **re-verified on every load**. Driven by `OPENWOP_INSTALL_PACKS=
  name@version,...`; `DEFAULT_REGISTRY=https://packs.openwop.dev`.
- **Dev local mount:** `src/bootstrap/mountLocalPacks.ts` symlinks packs matching a
  **hardcoded** `LOCAL_PACK_PREFIXES = ['core.openwop.','vendor.myndhyve.']` (line 42).
- **Pluggable seams:** `setNodePackResolver(fn)`, `setAgentPackResolver(fn)`.
- **Three blockers to external contribution:** hardcoded `LOCAL_PACK_PREFIXES`,
  single `PACK_DIR` root, no explicit plugin hook.

---

## 2. Proposed feature-first + package-extension architecture

### 2.1 Target layout (per feature)
A feature is one package directory carrying its full vertical:

```
features/<feature>/                 # e.g. features/crm/
├── manifest.ts                     # FeatureManifest (the extension contract, §2.2)
├── backend/
│   ├── routes.ts                   # export registerCrmRoutes(deps)
│   ├── service.ts                  # domain logic
│   ├── migrations.ts               # feature-scoped, namespaced tables
│   └── packs.ts                    # declares required packs (name@version)
├── frontend/
│   ├── features.tsx                # FeatureRoute[] fragment (routes + nav)
│   └── pages/…                     # React pages, lazy()
└── packs/                          # the feature's own agent/node packs (source)
```

The base app composes features rather than hardcoding them: `registerAllRoutes` and
`features.tsx` consume **fragments contributed by enabled feature manifests** instead of
a hand-maintained master list.

### 2.2 The extension contract
A `FeatureManifest` is the single object a feature exports and the base registers:

```
interface FeatureManifest {
  id: string;                       // 'crm' — matches toggle key + pack namespace
  backend: {
    registerRoutes(deps: RouteDeps): void;     // mirrors today's register* fns
    migrations: NumberedMigrations;            // namespaced, merged into schema runner
    requiredPacks: PackRef[];                  // { name, version } — RFC 0076 style
  };
  frontend: { routes: FeatureRoute[]; };       // appended to FEATURES (§1.2)
  toggle: { defaultStatus; category; … };      // registered into the toggle registry
}
```

- **Route registration:** the base builds `ROUTE_MODULES` by concatenating
  `feature.backend.registerRoutes` for every *installable* feature; the existing CI
  guard generalizes to "every feature manifest is wired." Activation is gated by toggle
  state at registration time (mount a 404/feature-disabled stub when off), **not** by
  removing the module (keeps the route table stable for replay/audit).
- **Frontend:** `FEATURES` becomes `BASE_FEATURES.concat(...enabledFeatures.routes)`;
  nav still auto-derives — zero changes to the derivation in `features.tsx:212-247`.
- **Migrations:** feature migrations are namespaced (`crm_*` tables) and merged into the
  single forward-only runner so sqlite+postgres parity (§1.5) is preserved. Features
  never own a private schema-version counter.

### 2.3 Packs ride the existing pipeline (no new loader)
A feature's packs are **published as signed registry tarballs** (the same shape as
`core.openwop.*`), namespaced `feature.<id>.*` (e.g. `feature.crm.nodes`,
`feature.crm.agents`). They flow through the unchanged loaders in `tarballLoader.ts` /
`agentLoader.ts` / `registryInstaller.ts`. Two minimal unblocks (config, not new code
paths):
- `LOCAL_PACK_PREFIXES` becomes config-driven
  (`OPENWOP_LOCAL_PACK_PREFIXES=core.openwop.,vendor.myndhyve.,feature.`) so dev mount
  accepts feature packs.
- Single `PACK_DIR` is retained — registry installs already converge there; no
  multi-root needed.

### 2.4 DECISION — pack distribution mechanism (`/architect`)

**Decision: Primary = signed registry tarballs, version-pinned (option B). Dev-mode
secondary = local symlink-mount via a config-driven prefix allowlist (option A). No new
loader.**

Rationale (severity-ordered):
1. **[CRITICAL — replay] Pack presence is decoupled from toggle state.** A historical
   run that executed a `feature.crm.*` node must still fork/replay after CRM is toggled
   off (`replay.md`). Therefore installable features' packs stay present + version-pinned
   regardless of on/off; the toggle gates *activation*, never pack load/unload.
2. **[CRITICAL — trust] Keep the Ed25519 + SRI + trust-marker chain.** A raw filesystem
   drop into `PACK_DIR` bypasses `tarballLoader.ts`'s per-load verification (RFC 0003 §B,
   RFC 0076). The registry path preserves it natively; raw copy does not.
3. **[HIGH — Cloud Run determinism] `~/.openwop-packs` is per-instance ephemeral.** Only
   version-pinned, content-addressed (SRI) registry pulls at boot yield byte-identical
   packs across instances → identical node/agent resolution → deterministic runs.
   Baking packs into the app image is also consistent but recouples distribution to app
   builds, defeating "distributed separately."
4. **[HIGH — dependency declaration] Feature packs declare deps as pinned `name@version`**
   (RFC 0076 `runtime.requires`); the boot install list is composed from the installable
   feature set and resolved transitively. No floating versions.

Operationally: the boot `OPENWOP_INSTALL_PACKS` set = union of `requiredPacks` across all
**installable** features (independent of on/off).

> **Resolved (maintainer, 2026-06-08): publish `feature.*` packs to the public
> `packs.openwop.dev`** — the default registry is unchanged, no new infra.
> **Caveat to track:** public publication means CRM/CSM pack manifests, node/agent
> surfaces, and signatures are publicly fetchable. If any feature is later deemed
> proprietary, it must move to a private registry (the installer already accepts
> `OPENWOP_REGISTRY_URL` + a trusted-keys dir) before its packs ship.

---

## 3. Feature toggles extended for multivariant testing

### 3.1 Data model
A toggle is the myndhyve state model **plus** an optional variant set:

```
interface ToggleConfig {
  id: string;
  status: 'on' | 'off' | 'beta';            // matches the admin UI; 'on' == 100%
  scope: 'global' | 'tenant';                // resolution scope (see §3.4 decision)
  tenantOverrides?: Record<string, Pick<ToggleConfig,'status'|'variants'>>;
  bucketUnit: 'user' | 'tenant';             // randomization unit (see §3.3 decision)
  salt: string;                              // per-toggle salt; isolates experiments
  variants?: Variant[];                      // present only for multivariant toggles
}
interface Variant {
  key: string;
  weight: number;                            // integers summing to exactly 100
  binding?: VariantBinding;                  // admin-administered, dynamic (see §3.5)
}
```

- `status:'on'` with no `variants` = single variant at 100% (the simple case).
- `status:'on'` with `variants:[{A,50},{B,50}]` = traffic split.
- `status:'beta'` composes with variants: BETA scopes *who is eligible* (internal/opt-in
  cohort), variants split *within* the eligible population.
- `status:'off'` short-circuits — no variant assigned.

> **Resolved (maintainer, 2026-06-08): scope = per-tenant-overridable global.** Each
> toggle carries a global default plus optional `tenantOverrides`. Resolution: tenant
> override (if present) → global default.

Stored in the backend (new `feature_toggles` table, sqlite+postgres parity, §1.5) or
`host_ext_kv`; **not** in a normative schema.

### 3.2 Admin screen (frontend, modeled on myndhyve)
Replicate `FeatureTogglePanel.tsx`: category-grouped cards, the Off/Beta/On
`ToggleButtonGroup`, superadmin-gated. **Add** a per-toggle variant editor: rows of
`{ key, weight }` with an input control, live sum indicator, and **client + server
validation that weights sum to exactly 100** before save. Unlike myndhyve's direct
client→Firestore writes, this screen calls an **authenticated backend admin route**
(§3.4 rationale #4).

### 3.3 Sticky bucketing
Generalize myndhyve's dev-only `featureFlags.ts` hashing to weighted variants, server-side:

```
unitId = (toggle.bucketUnit === 'tenant') ? tenantId : (userId ?? 'anon:' + sessionId)
bucket = hash(unitId + ':' + toggleId + ':' + toggle.salt) % 10000   // 0..9999
// walk cumulative weights (×100) → first variant whose cumulative bound exceeds bucket
```

> **Resolved (maintainer, 2026-06-08): randomization unit is per-toggle (`user` |
> `tenant`), default `user` with a stable anonymous fallback** (`anon:<sid>` for the
> app's cookie tenants). Industry practice = randomize at the unit that must stay
> consistent and that you measure:
> - **user** — individual/UX experiments; max statistical power, finest granularity (the
>   consumer default).
> - **tenant** — shared, multi-user product surfaces where teammates must see the *same*
>   experience and metrics are account-level (the B2B default). **CRM/CSM are
>   shared-data features → set them to `tenant`.**
>
> Two correctness requirements: a **per-toggle `salt`** (decorrelates experiments, kills
> carryover bias) and **`% 10000` fine buckets** (accurate 50/50, small allocations, and
> 1%→5%→50% ramps). Hashing is deterministic, so assignment is sticky without
> persistence; the run stamp (§3.4) freezes behavior-affecting variants per run.

### 3.4 DECISION — where variant assignment is evaluated (`/architect`)

**Decision: Backend is the sole authority; frontend is a read-only mirror for
presentation.**

Rationale (severity-ordered):
1. **[CRITICAL — replay/audit] Variant is a run input; stamp it at creation.** When a
   variant changes run behavior (different agent/node/prompt), the resolved variant is
   captured into the run at creation time as host-extension metadata and **read back
   verbatim on replay/fork — never recomputed** (`replay.md`). A recompute would drift if
   weights change and break `:fork`.
2. **[CRITICAL — authority/tamper] Server behavior cannot trust a client-asserted
   variant.** Toggles gate backend routes (`ROUTE_MODULES`) and pack/agent activation —
   server-side decisions. The backend computes assignment from the authenticated
   principal/tenant (via `HostAdapterSuite`); a frontend-authoritative variant (myndhyve's
   model) is acceptable only for pure UI.
3. **[HIGH — wire-shape / non-normative] Keep the entire toggle+variant system out of the
   protocol surface.** No `variant` field in `run-event.schema.json`; nothing in
   `/.well-known/openwop` (`COMPATIBILITY.md` §2.2, `capabilities.md`). Stamp the resolved
   variant + binding (§3.5) into **`run.metadata.featureVariant`** — host-internal,
   redaction-safe (no secrets, SECURITY SR-1), and **deliberately absent from the
   normative `RunSnapshot` wire** (a host-ext read surface,
   `GET /v1/host/openwop-app/crm/runs/{runId}`, exposes it).

   > **Implementation correction (was: RFC 0056 annotations).** The annotation surface
   > does NOT survive `POST /v1/runs/{runId}:fork` — annotations live in a side table the
   > fork doesn't copy — so they cannot be the home for a replay-safe stamp. `run.metadata`
   > IS copied (fork spreads `...sourceRun`), so the stamp is read verbatim on fork/replay.
   > `run.metadata` is therefore the correct home; this supersedes §7.6's earlier default.
   > Verified by `backend/typescript/test/feature-replay-fork.test.ts`.
4. **[MEDIUM — admin write path] Mutate config through an authenticated, superadmin-gated
   backend route**, not client→DB, since the backend is the authority.

**Propagation model:** backend evaluates → resolved-assignments map returned to the
frontend (session/bootstrap payload) → frontend renders the chosen UI only. For runs,
the backend stamps the resolved variant into the run at creation. Frontend never
recomputes bucketing for behavior-affecting decisions.

### 3.5 Variant → behavior binding (dynamic, admin-administered)

> **Resolved (maintainer, 2026-06-08): variant→behavior binding is set through the
> feature-toggle admin UI and administered dynamically on the backend** — not hardcoded
> in a manifest and not branched imperatively in feature code.

This is the most powerful option but it collides with replay-safety unless layered
precisely. The model that reconciles dynamic admin control with deterministic replay:

1. **Manifest declares the menu, not the choice.** `FeatureManifest` declares each
   feature's **bindable slots** and the **candidate set** for each (which
   agents/nodes/prompts are eligible), so the admin UI can only wire valid bindings and
   the candidates ship as version-pinned packs (§2.4).

   ```
   interface VariantBinding {
     slot: string;                      // e.g. 'crm.triageAgent'
     ref:  { kind: 'agent'|'node'|'prompt'; name: string; version: string };
   }
   ```

2. **Admin UI wires variant→binding dynamically;** the choice is persisted in the
   backend `feature_toggles` config and is changeable without redeploy. The UI validates
   each binding against the manifest's candidate set and that weights sum to 100.

3. **[CRITICAL — replay] A run stamps the *resolved binding snapshot* at creation.**
   Because the binding can be re-administered at any time, the run must capture the
   variant **and** its effective `VariantBinding` (pinned ref) into the run at creation
   (host-ext metadata, §3.4), and replay/fork reads that snapshot — never the current
   admin config. Without this, re-binding a variant retroactively changes how historical
   runs replay, breaking `:fork`. (This is the dynamic-binding corollary of the §3.4
   stamp rule.)

Net: configuration is data (auditable, inspectable, hot-changeable), candidates are
signed/version-pinned packs (trustworthy), and runs are frozen at creation (replay-safe).

### 3.6 BETA semantics

> **Resolved (maintainer, 2026-06-08): BETA is an explicit opt-in / internal-org
> eligibility cohort**, not a low-weight variant.

> **Correction (maintainer, 2026-06-09): BETA defaults to OPEN.** Flipping a toggle to
> BETA with **no `betaCohort`** now resolves **enabled for everyone**, rendered with a
> **"Beta" badge** in the nav (Sidebar · admin rail · ⌘K) — matching the myndhyve
> reference where beta = visible-with-badge. A **non-empty `betaCohort` still narrows it
> to a CLOSED beta** (the cohort predicate below). Rationale: the prior fail-closed
> default made "set to Beta" appear to do nothing (no cohort editor exists), so an admin
> couldn't preview a beta feature. The cohort predicate is unchanged; only the empty-cohort
> default flipped from off → on. Impl: `resolveConfig` in
> `backend/typescript/src/host/featureToggles/service.ts`; the FE reads `status==='beta'
> && enabled` for the badge (`useFeatureBadge`).

BETA answers *"who is allowed to see this feature at all,"* which is orthogonal to a
variant's *"how eligible traffic is split."* Modeling it as an **eligibility predicate**
(e.g. an opt-in flag on the user/tenant, or membership in an internal org) keeps the two
axes independent and composable:

- `status:'beta'` → only members of the BETA cohort are eligible; everyone else resolves
  as off.
- Within the eligible cohort, the toggle's `variants[]` still apply — so a feature can be
  BETA *and* A/B-tested among beta users simultaneously.

Folding BETA into a variant weight (the rejected alternative) would conflate eligibility
with allocation and make "ramp the experiment" and "widen the beta" the same lever, which
they are not. The cohort predicate is evaluated server-side alongside bucketing (§3.3).

---

## 4. Worked example — CRM (and CSM)

1. **Author** `features/crm/` per §2.1. `manifest.ts` declares `id:'crm'`,
   `requiredPacks:[{name:'feature.crm.nodes',version:'1.0.0'},{name:'feature.crm.agents',
   version:'1.0.0'}]`, frontend `FeatureRoute[]` (e.g. `/crm` workspace page + nav entry),
   and `toggle:{ defaultStatus:'off', category:'Business Tools' }`.
2. **Publish** `feature.crm.*` packs as signed tarballs to the registry (§2.4).
3. **Install/enable:** the app's installable-feature set includes CRM → its packs join the
   boot `OPENWOP_INSTALL_PACKS` union, verified + version-pinned. Superadmin sets the CRM
   toggle `on` (or `beta`, or `on` + variants `A:60/B:40`) in the admin screen (§3.2).
4. **Activation:** with the toggle on, the base mounts `registerCrmRoutes`, appends CRM's
   `FeatureRoute[]` to `FEATURES` (nav auto-derives), and CRM agents/nodes are
   activatable. Off → routes serve a feature-disabled stub, nav entry hidden, packs remain
   present (replay-safe).
5. **Variant in action:** a CRM run reads the user's stamped variant; e.g. variant B routes
   to `feature.crm.agents/triage-v2`. The variant is recorded in the run and survives
   `:fork`.
6. **CSM** repeats the pattern (`features/csm/`, `feature.csm.*` packs) with zero edits to
   CRM or the base beyond registering the new manifest.

---

## 5. Trade-offs & alternatives considered

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Pack distribution | Signed registry tarballs (B) | Raw FS drop into PACK_DIR (A2) | A2 bypasses Ed25519/SRI trust + is racy across Cloud Run instances |
| | | Bake into Docker image (A1) | Recouples feature distribution to app image builds |
| Toggle↔pack lifecycle | Decouple (packs always present) | Unload packs on toggle-off | Unloading breaks replay/fork of historical runs |
| Variant authority | Backend authoritative | Frontend-only (myndhyve model) | Can't gate server routes/packs or guarantee replay from the client |
| | | Dual independent eval | Two bucketing sites drift; replay non-determinism |
| Variant in wire | Host-ext metadata | New `run-event` field | Would be a v1.x wire-shape change (COMPATIBILITY §2.2) |
| Admin writes | Backend admin API | Client→DB (myndhyve model) | Backend is the authority; needs server-side weight validation + audit |
| Feature wiring | Composed manifests | Keep hand-listed ROUTE_MODULES | Doesn't scale to separately-distributed features |

---

## 6. Migration path (sequenced, low-risk)

1. **Toggle registry + backend authority (no behavior change).** Add `feature_toggles`
   table (sqlite+postgres), the evaluation service (sticky bucketing), and a
   superadmin-gated admin API + screen. Seed all *existing* surfaces as `on`. Ship the
   `useFeatureAccess`-style frontend hook reading the backend assignments map.
2. **Feature-manifest seam (behavior-preserving refactor).** Introduce `FeatureManifest`;
   convert `ROUTE_MODULES` and `FEATURES` to compose from manifests. Wrap *one* existing
   surface (e.g. Widgets, already env-gated) as the first manifest to prove the contract.
3. **Pipeline unblock.** Make `LOCAL_PACK_PREFIXES` config-driven; add `feature.` to the
   dev allowlist. No loader changes.
4. **First real feature (CRM) end-to-end** per §4 — establishes the `features/<id>/`
   convention, the `feature.crm.*` registry packs, and the variant stamp-into-run path.
5. **Replay/fork conformance check.** Add an app-level test: a run using a feature node +
   variant must `:fork` and replay deterministically after the toggle is flipped off.
6. **CSM and onward** as pure additions.

Each step is independently shippable and leaves the app green.

---

## 7. Decision checklist

### Resolved (maintainer, 2026-06-08)
- [x] **1. Feature-pack registry** → **public `packs.openwop.dev`** (no new infra). Caveat
      tracked in §2.4: public exposure of CRM/CSM pack surfaces + signatures.
- [x] **2. Toggle scope** → **per-tenant-overridable global** (§3.1).
- [x] **3. Bucketing unit** → **per-toggle (`user` | `tenant`), default `user` w/ anon
      fallback; CRM/CSM = `tenant`** (§3.3), with per-toggle salt + `% 10000` buckets.
- [x] **4. Variant→behavior binding** → **dynamic, admin-administered on the backend**;
      manifest declares the candidate menu, runs stamp the resolved binding (§3.5).

- [x] **5. BETA semantics** → **explicit opt-in / internal-org cohort** (an eligibility
      predicate), not a low-weight variant — BETA's "who can see it" stays orthogonal to
      variants' "how traffic splits" (§3.6).
- [x] **6. Variant-stamp surface** → **`run.metadata.featureVariant`** (CORRECTED during
      implementation from the RFC 0056 annotation default). Annotations live in a side
      table that `:fork` does NOT copy, so they can't carry a replay-safe stamp;
      `run.metadata` IS copied by fork and is read verbatim on replay (§3.4). Exposed via a
      host-ext provenance read, kept off the normative `RunSnapshot` wire.

---

## Assumptions

- openwop-app remains a non-workspaces two-package repo; no monorepo tooling is introduced
  by this ADR.
- The protocol wire-shape (`run-event.schema.json`, `/.well-known/openwop`) is **untouched**;
  everything here is non-normative host-extension.
- The pack pipeline is reused as-is except for making `LOCAL_PACK_PREFIXES` configurable.

# ADR 0022 — Marketplace (browse + install feature packs over the signed registry)

**Status:** implemented
**Date:** 2026-06-10
**Depends on:** ADR 0001 (feature-package + the pack model), ADR 0006 (RBAC)
**Toggle:** `marketplace` · **Surface:** authed `/v1/host/openwop-app/marketplace/*`
(host-extension, NON-NORMATIVE — the registry wire is already defined; no new RFC)
**MyndHyve §:** Marketplace · **Baseline:** `functions/src/marketplace` (14
functions: listings, reviews, install) + `src/core/marketplace`

---

## Context (boundaries audit first)

The one feature in the batch that **leverages an asset unique to this app**: the
signed pack registry (`packs.openwop.dev`, Ed25519 + SHA-256 SRI). Marketplace is a
browse-and-install surface over the pack pipeline that already exists.

**Pre-existing-surface audit (the load-bearing finding):**
- **Install already has a single owner — `registryInstaller`.**
  `installPackFromRegistry` / `ensureRegistryPacksInstalled`
  (`src/packs/registryInstaller.ts`) fetch the manifest/tarball/sig, verify
  **SHA-256 SRI** integrity, and verify the **Ed25519** signature over the raw
  `pack.json` bytes. Marketplace MUST **compose this service** — re-implementing
  signing/verification would be a security-critical duplication (the worst kind of
  drift).
- **A specialized install route already exists — `agentPackRegistry`.**
  `routes/agentPackRegistry.ts` exposes `GET/POST /v1/host/openwop-app/registry/
  agent-packs[/install]`, **agent-pack-only**, backing the Agents-tab "Install from
  registry" flow. Marketplace is the **generic** surface; it must NOT duplicate that
  route. Decision: **coexist now, fold later** — `agentPackRegistry` is a thin slice
  over `registryInstaller`; Marketplace is the broad slice over the same service.
  A follow-on can re-express `agentPackRegistry` as a filtered Marketplace view.
- **A read-only catalog already exists — `nodeCatalog`.** `routes/nodeCatalog.ts`
  (`GET /v1/host/openwop-app/node-catalog`) scans `~/.openwop-packs/*/pack.json`.
  Marketplace's **browse** reuses that manifest-scan pattern (+ `featurePackRefs()`
  + install markers) rather than a new discovery mechanism.

What is **genuinely new**: the **listing projection** (a view over registry manifests
+ install status), the generic install route (delegating to `registryInstaller`), and
the **reviews/ratings** store (the only new persistence).

## Decision

A `marketplace` feature-package (toggle `marketplace`, default OFF, `bucketUnit:
tenant`) that **browses** packs (a projection over registry manifests +
`featurePackRefs()` + `.openwop-installed.json` markers), **installs** a pack by
delegating to `registryInstaller` (signed-only), and owns a **reviews/ratings**
store. It composes the pack pipeline; it re-implements none of it.

### The model

```
Listing { packName, version, title, description, author, category,        // PROJECTION — not stored
          integrity, publicKeyRef, installed: boolean, requiredBy?: string[] }
Review  { reviewId, tenantId, orgId, packName, rating(1..5), body?,        // the only NEW store
          authorId, createdAt }
```

`Listing` is computed (manifest scan + install markers); `DurableCollection<Review>
('marketplace:review')` is the new persistence, keyed by `(tenantId, orgId, reviewId)`.

### Phase 1 — listings browse (read-only, composes the pipeline)

`GET /v1/host/openwop-app/marketplace/listings` (`workspace:read`) — projects available
packs (registry manifest scan, the `nodeCatalog` pattern) annotated with install
status (`.openwop-installed.json`) and which features require them (`featurePackRefs()`).
Read-only; no new store.

### Phase 2 — install (delegates to registryInstaller, admin-gated)

`POST /v1/host/openwop-app/marketplace/install` `{ packName, version }` — **delegates to
`installPackFromRegistry`** (Ed25519 + SRI verified; signed-only). Gated on an
**admin/`host:*` scope** (install is process-global, a privileged operation), not a
plain org member; fail-closed. Returns the verified install result.

### Phase 3 — reviews / ratings (the new store)

`GET/POST /v1/host/openwop-app/marketplace/listings/:packName/reviews`
(`authorizeOrgScope`: read=`workspace:read`, write=`workspace:write`) — one review
per (org, pack) author; aggregate rating computed on read. Tenant+org IDOR-guarded.

### Phase 4 — frontend

`MarketplacePage` (nav-gated on `marketplace`): browse listings (with install
status + rating) → install (admin only) → review. `marketplaceClient.ts`.
`npm run build` gate.

## Core-app extension surface (node packs, agent packs, API)

Per **ADR 0014** (feature workflow surfaces), a feature is not only its REST + UI
faces — it must also **extend the core app's automation surface**. The surface below
is a committed phase (after the REST + UI phases), gated by the **same `marketplace`
toggle** (all faces flip together), with signed `feature.marketplace.*` packs
published to `packs.openwop.dev` (decoupled from toggle state for replay). Note that
Marketplace's core-app extension is substantially **the pack pipeline itself** — its
browse/install routes **extend the existing registry surface** (`registryInstaller`,
`/registry/agent-packs`, `node-catalog`) rather than adding a parallel one.

- **Node pack `feature.marketplace.nodes`** — `feature.marketplace.nodes.search`
  (find an installable pack by capability from a workflow, read-only). **Install is
  deliberately NOT a workflow node** — it mutates process-global state and is
  admin/`host:*`-scoped, so it stays a privileged REST action.
- **Agent pack `feature.marketplace.agents`** — `feature.marketplace.agents.recommender`
  (suggests packs for a described need; read-only — never auto-installs).
- **`ctx.marketplace` workflow surface** — typed `listings` / `search` (read-only;
  install excluded by design), advertised at `/.well-known/openwop`.
- **Envelope types** — none.
- **API endpoints** — the browse + install + reviews routes above, which **compose**
  the existing signed registry pipeline and are reachable over MCP/A2A via the
  well-known advertisement.

## Architectural constraints honored

- **Single source of truth for install = `registryInstaller` (the headline
  boundary):** Marketplace composes it; it never re-implements Ed25519/SRI
  verification. No second install path, no signing drift.
- **Don't duplicate `agentPackRegistry`:** coexist as the generic surface over the
  same service; fold the agent-pack route in as a follow-on, not a rewrite-now.
- **Signed-only installs:** only registry-signed packs install (the trust model);
  unsigned/local packs are dev-mount only, never a marketplace install.
- **Privileged install, fail-closed:** install is admin/`host:*`-scoped (it mutates
  process-global pack state); browse + review are ordinary org RBAC.
- **Reviews are the only new store;** listings are a projection (no duplicated pack
  metadata).
- **No new wire → no RFC:** the registry wire (manifest/tarball/sig endpoints,
  capability) already exists; this is a host-extension surface over it.

## Alternatives considered

1. **Re-implement pack fetch/verify in the feature.** Rejected — `registryInstaller`
   is the single owner; duplicating signature/SRI verification is a security-critical
   drift risk.
2. **Extend `agentPackRegistry` in place to all pack types.** Rejected as the v1
   move — it is agent-tab-scoped and minimal; Marketplace is the broader surface, and
   overloading the agent route conflates two consumers. Fold it in later.
3. **Unsigned / local-only marketplace.** Rejected — signed-only is the trust model;
   a marketplace that installs unverified packs breaks the registry's security story.
4. **Per-tenant pack enablement instead of process-global install.** Deferred —
   install is process-global today; a per-tenant "available packs" gate is a
   follow-on (open question), distinct from the install primitive.

## Open questions

- [ ] **Install authority** — superadmin-only vs per-tenant org-admin; and **pack
  enablement per tenant** vs the current process-global install.
- [ ] **Folding `agentPackRegistry`** into Marketplace (alt. 2) as a filtered view.
- [ ] **Third-party publisher onboarding** + publisher key management (who may sign).
- [ ] **Review moderation / aggregation depth** (MyndHyve's is not fully built).
- [ ] **Workflow/feature listings beyond node/agent packs** — browsing installable
  *features*, not just packs.

## Implementation (Status → implemented)

Landed as the `marketplace` feature-package, wired purely additively (appended to
`BACKEND_FEATURES` + `FRONTEND_FEATURES`; zero core edits), toggle OFF by default,
`bucketUnit: tenant`.

| Phase | What shipped | Where |
|-------|--------------|-------|
| 1 — listings browse | `GET /v1/host/openwop-app/marketplace/listings` (toggle + authed). A computed PROJECTION over the pack-dir scan + `.openwop-installed.json` markers + `featurePackRefs()` `requiredBy` — re-implements none of the pipeline. | `features/marketplace/listingService.ts`, `routes.ts` |
| 2 — install | `POST .../install` — **delegates to `installPackFromRegistry`** (Ed25519 + SHA-256 SRI, signed-only). Gated `requireSuperadmin` (process-global mutation = `host:*`, fail-closed); toggle-gated first. | `features/marketplace/routes.ts` |
| 3 — reviews/ratings | `GET/POST/DELETE .../orgs/:orgId/listings/:packName/reviews` (`workspace:read`/`write` via `authorizeOrgScope`). The ONLY new store: `DurableCollection<Review>('marketplace:review')`, one-per-(org,pack,author) upsert, aggregate computed on read, tenant+org IDOR-guarded, author/admin-only delete. | `features/marketplace/reviewService.ts`, `routes.ts` |
| 4 — frontend | `/marketplace` page (nav-gated on `marketplace`): search → install (superadmin; a 403 surfaced as a clear message) → org-scoped reviews with star ratings. `marketplaceClient.ts`. | `frontend/react/src/features/marketplace/*` |
| ADR 0014 surface | read-only `ctx.features.marketplace` (`listings`/`search`; install excluded by design), advertised at `/.well-known/openwop` via `registerFeatureSurface`. Pinned packs `feature.marketplace.nodes@1.0.0` (search node) + `feature.marketplace.agents@1.0.0` (recommender — read-only, never installs). | `features/marketplace/surface.ts`, `packs/feature.marketplace.*` |

Tests: `backend/typescript/test/marketplace-route.test.ts` (18 — toggle gating,
install RBAC + delegation via a mocked installer, review CRUD/upsert/aggregate,
cross-tenant + cross-org IDOR, author/admin delete-guard, surface + node smoke,
well-known advertisement). Frontend `npm run build` green (token/CSS gates pass).

**Open-question decision recorded:** install authority resolved to **superadmin-only**
(`requireSuperadmin`) for v1 — install is process-global, so a per-org admin scope
would mis-model the authority; per-tenant pack enablement remains deferred (alt. 4).

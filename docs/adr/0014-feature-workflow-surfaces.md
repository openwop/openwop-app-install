# ADR 0014 — Feature ↔ Workflow integration (the FeatureModule architecture)

**Status:** implemented (Phases 0–4 — `FeatureModule` surface/agent/capability faces across CRM/CMS/KB/Media)
**Date:** 2026-06-09
**Depends on:** ADR 0001 (feature-package architecture), and composes every
shipped feature (0002–0013). **Closes:** the ADR-0011 open question "back
`host.knowledge` with the real store" (Phase 0).
**Surface:** host-extension, non-normative (`/v1/host/openwop-app/*` REST +
`host.openwop-app.*` workflow surfaces) — no wire/RFC change.

---

## Context (boundaries audit first)

The ported features (CRM, CMS, KB, Media, …) are **REST + UI product surfaces**:
`xService` → `routes` (authed `/v1/host/openwop-app/<feature>/*`) → toggle → frontend.
A workflow node **cannot reach them** — there is no typed `ctx.<feature>`
surface, the one feature node pack (`feature.crm.nodes`) is a stateless
transformer that never touches the CRM store, no feature binds an agent, and
`featurePackRefs()` (the declared-pack union) is **dead code** (never installed).
MyndHyve, by contrast, integrates every feature with the engine. This ADR adds
the integration half **as a structural property of the feature contract**, so it
applies to all 12 features and every future one without re-deciding per feature.

A two-sided audit (host infra + openwop spec corpus) established:
- **Conformant.** A typed `ctx.<feature>` surface is a sanctioned host extension
  (`spec/v1/host-extensions.md`); no new RFC is required while it stays
  non-normative (`host.openwop-app.*`), advertised, capability-gated, replay-safe, and
  BYOK-clean. Promotion to normative `host.<feature>` is a future RFC, not a blocker.
- **The seams mostly exist.** `buildHostSurfaceBundle` is the node ABI;
  `setNotificationBackend` is the precedent for a feature backing a host seam;
  `registerSurfaceAdapter`/`hostSurfaceRegistry`/`nodePackResolver`/
  `agentPackResolver` exist. **Three are missing:** pack auto-install
  (`featurePackRefs` unused), a surface-registration seam, an agent-binding seam.

## Decision — "FeatureModule": one service, three faces, composed once

A feature is its **service** (the single source of truth — tenant/org-scoped,
transport-free) exposed through **three thin adapter faces** that never duplicate
logic, wired by **one composer**:

1. **REST face** (have): `routes.ts` → `authorizeOrgScope` → service.
2. **Workflow-surface face** (NEW): `surface.ts` → run-scope → service; a typed
   `ctx.<feature>` the executor binds into `NodeContext`.
3. **Pack face** (NEW): `feature.<id>.nodes` / `feature.<id>.agents` whose
   nodes/tools call `ctx.<feature>`.

### The five invariants

1. **Service is the contract; faces are adapters.** No domain logic in
   `routes.ts`/`surface.ts` beyond glue. REST and surface share the same guards.
2. **One descriptor, wired once.** Extend `BackendFeature → FeatureModule`
   (`surface?`, `agents?`, `capability?` — additive); `registerBackendFeatures`
   wires routes + toggle + **pack-install + surface + agent + capability** in one
   pass — closing the three gaps.
3. **Replay-safety is owned by the seam.** A `ctx.crm.getContact()` call in a run
   is a recorded side-effect (`replay.md`/`idempotency.md` Layer-2). The
   surface-registration seam routes every surface call through the host's
   observable-result/invocation cache (as `ctx.http`/`ctx.db` already do) — reads
   replay from cache, writes are idempotency-keyed. A feature cannot bypass it.
4. **Capability honesty.** Each surface is advertised at the discovery root
   (`/.well-known/openwop`, RFC 0073), gated by node `peerDependencies`, and
   **toggle-aware** (a tenant with the feature OFF refuses workflows requiring it).
   Namespace `host.openwop-app.<feature>` (non-normative); RFC-promotion path documented.
5. **Security inherited, not reinvented.** Surface calls enforce the SAME tenant
   isolation (CTI-1), org-RBAC scope, BYOK redaction (SR-1 before any value
   reaches a node), and egress policy as the REST face — a node is lower-trust
   than an authed client.

### The contract (additive to ADR 0001)

```ts
interface FeatureModule extends BackendFeature {     // existing fields unchanged
  surface?: {                                          // Face 2 (NEW)
    name: `host.openwop-app.${string}`;                     // ctx binding + capability id
    capability: CapabilityAdvertisement;               // {supported, methods[], tier?}
    build(scope: RunScope): Record<string, SurfaceFn>; // wrapped for replay + SR-1 + scope
    sideEffects?: Record<string, 'read' | 'write'>;
  };
  agents?: AgentBinding[];                              // Face 3 (NEW) — pack agents[]
}
// RunScope = { tenantId, orgId?, subject?, runId, nodeId } — the authority model:
// surface methods enforce the run principal's effective access for the org,
// exactly as authorizeOrgScope does on the REST face.
```

## Phased build order

- **Phase 0 — Close the dead seams (IMPLEMENTED).** Consume `featurePackRefs()`
  at boot so declared packs always install (in-tree ones skipped). Generalize the
  `setNotificationBackend` precedent into `setKnowledgeBackend` and back the demo
  `host.knowledge` surface with the **real tenant KB store** (`kbService.tenantRetrieve`,
  toggle-aware, demo-corpus fallback) — **closing the ADR-0011 open question**.
  This proves the surface-injection pattern at minimal risk.
- **Phase 1 — `FeatureModule` contract + replay-safe `FeatureSurfaceRegistry` (IMPLEMENTED).**
  Extend the contract (additive); build the registry with the recorded-invocation
  wrapper + SR-1 redaction + run-scope authority; refactor **KB** end-to-end as
  the reference `ctx.kb` surface + root-document capability advertisement.
- **Phase 2 — Node packs over surfaces (KB IMPLEMENTED).** `feature.kb.nodes` (retrieve / augment)
  calling `ctx.kb`, capability-gated; upgrade `feature.crm.nodes` from stateless
  transformers to real `ctx.crm` reads/writes. Establishes the convention + gating.
- **Phase 3 — Agent binding (KB IMPLEMENTED).** `feature.<id>.agents` via pack manifest `agents[]`
  (RFC 0003), tool-allowlisted to surface methods (RFC 0002 §A14); reference KB +
  CRM agents; wire the agent-binding seam in the composer.
- **Phase 4 — Roll across + harden (IMPLEMENTED — CRM surface + discovery advertisement; remaining features on demand).** Extend surfaces to CMS/Media/Publishing/
  Sharing where workflow-useful; per-feature toggle-aware capability gating in
  discovery; conformance-style tests (capability refusal, replay/fork over a
  surface call, CTI-1, SR-1); amend ADR 0001; document the RFC-promotion path.

## Architectural constraints honored

- **Compose, don't fork:** the service stays the single source of truth; faces
  are adapters. CMS/KB/CRM logic is not duplicated into nodes.
- **Replay/fork-safe (C-1):** the seam owns invocation-caching; no feature can
  introduce replay divergence.
- **Capability honesty (C-3):** advertised + gated + toggle-aware.
- **Security parity (C-2/C-4):** CTI-1 + org-RBAC + SR-1 identical to REST.
- **Additive, non-normative:** host extensions only; no wire-shape/RFC change.

## Alternatives considered

1. **Bake workflow access into each feature ad hoc** (each feature wires its own
   nodes/agents/HTTP-bridge). Rejected — scatters replay/secret/capability
   security across features; the registry centralizes it once.
2. **A self-HTTP bridge** (nodes call the authed REST endpoints). Rejected as the
   primary path — it re-auths per call, isn't replay-cached, and couples the node
   to the transport; a typed surface over the shared service is cleaner.
3. **Promote `host.crm`/`host.cms` to normative `host.*` now.** Deferred — these
   are sample features; normative promotion needs an RFC + cross-host conformance.
   Stay `host.openwop-app.*` until external adoption demands it.

## Open questions

- [ ] **Run authority model (C-4):** finalize `RunScope` org + RBAC resolution
  (Phase 1) — a run with no bound org may call only tenant-global methods.
- [ ] **Per-feature capability gating in discovery (C-3):** fold enabled features'
  surfaces into the root document + register-time refusal (Phase 4).
- [ ] **RFC promotion:** when a surface warrants cross-host adoption, file an RFC
  formalizing `host.<feature>` method contracts + conformance.

# 0195 — Fail-closed production posture (durable surfaces + demo-machinery quarantine)

Status: Accepted

## Context

A clean-slate `/grade-code` audit (2026-07-02, see `docs/steward/CODEBASE-ASSESSMENT.md`)
confirmed the app is production-hardened — the demo/sample/mock machinery is
overwhelmingly gated and self-documenting — but found a **focused set of ~12
places where demo/stub behavior was not *uniformly* fail-closed in a real
enterprise deploy**. The two blockers were architectural, not bugs:

1. **Storage durability was opt-in, not enforced.** The control plane (runs,
   chat, BYOK, kanban) is durable by default (sqlite/Postgres), but the
   pack-facing `ctx.*` host surfaces (`kv/table/cache/blob/queue/sql/vector/
   search/nosql/fs/queueBus/observability`) default to the ephemeral in-memory
   tier (`surfaceBackends.ts` → `MEMORY_BACKEND`). The only boot guard failed
   *only* when a backend was selected-but-unwired — never on the
   "nothing-selected → silently ephemeral in production" path. An enterprise
   operator who forgot to set `OPENWOP_SURFACE_BACKEND` got an app whose pack
   data resets on every restart/scale event, with no error.

2. **Several demo/stub seams keyed on `NODE_ENV` or nothing at all**, so a
   production fork that mis-set `NODE_ENV` (or a non-`auth` posture) could reach
   a mock AI provider, a fabricated-output `mock-ai` node, conformance
   secret-echo nodes, or a canned-bytes image route.

The app already had the *right* pattern for this — the BYOK-KMS guard
(`index.ts`) **refuses to boot** in the enterprise posture
(`OPENWOP_DEPLOY_POSTURE=auth`) without KMS. The decision here generalizes that
single, honest signal into a reusable production-hardening threshold.

## Decision

Adopt **`OPENWOP_DEPLOY_POSTURE=auth` as the canonical "this is a real,
multi-tenant, signed-in install" signal**, exposed as
`enterprisePosture()` in `host/deployPosture.ts`, and fail **closed** against it
for every demo/stub/ephemeral seam. The public demo (`cookie-per-visitor`),
shared-bearer deploys, local dev, and the entire test suite run in a non-`auth`
posture and are **unaffected** — so hardening never breaks the demo or the
gates.

Concretely:

- **Durable surfaces required in the `auth` posture.**
  `assertDurableSurfacesInEnterprise()` refuses to boot when any host surface
  resolves to the in-memory tier under `auth`, mirroring the KMS guard. Escape
  hatch: `OPENWOP_ALLOW_INMEMORY_SURFACES=true` for an operator who *knowingly*
  wants ephemeral surfaces. (LEAK-2 / DUR-1/DUR-2.)

  > **CORRECTED 2026-09-05 — ADR 0636.** As written, this guard was unsatisfiable
  > by configuration. It demanded that every surface leave `memory`, while the
  > sibling wiring guard refuses any surface whose selected backend has no
  > adapter — and MEASURED against the boot registrars, `observability` has no
  > adapter at all and `blob` has none under the `durable` id. So the hatch
  > named here became mandatory boilerplate on every auth deploy (six failed
  > Cloud Run revisions on the first real one), and `=true` could no longer
  > distinguish "two surfaces have no implementation" from "all thirteen are
  > ephemeral". The guard also had no test. ADR 0636 makes it assert only the
  > surfaces that HAVE a registered durable adapter, makes the hatch name the
  > surfaces it acknowledges (`OPENWOP_ALLOW_INMEMORY_SURFACES=blob`; `true`
  > remains the all-ephemeral form), and pins both guards with sabotage tests.
- **Mock/stub seams fail closed in the enterprise posture:** the `mock` AI
  provider is rejected by `assertProviderSupported` (LEAK-4); the
  `local.sample.demo.mock-ai` node is not registered (LEAK-3); conformance nodes
  are opt-in-only even if `NODE_ENV` is mis-set (LEAK-8).
- **Demo behavior stays quarantined by its existing flags, now honestly
  enforced:** the `OPENWOP_DEMO_SEED_ENABLED=false` kill-switch is honored by
  *every* seeder (LEAK-7); the `demoMode()`→owner access bypass is alarmed
  (LEAK-9); the `ctx.knowledge` demo corpus is served only in demo mode
  (LEAK-10); the stub `media/generate-image` and email-marketing send are
  honest about not being configured (LEAK-5 / LEAK-1).

This is a **host-posture decision, not a wire change** — no run-event field,
capability flag, or endpoint contract changes. See the RFC verdict below.

## Alternatives weighed

- **Gate on `NODE_ENV==='production'`.** Rejected as the *primary* signal: the
  public demo runs `NODE_ENV=production` too (shipped Dockerfile), so it would
  wrongly harden the demo, and it is easy to mis-set. `auth` posture is the
  honest "real tenants" signal and already gates KMS. (`NODE_ENV` is retained
  only as the secondary conformance-node default.)
- **Enforce durability whenever `demoMode()` is off.** Rejected: local dev and
  anon/`cookie-per-visitor` deploys legitimately run ephemeral surfaces; this
  would break every dev boot and test.
- **Delete the demo/mock machinery outright.** Rejected: the public showcase,
  conformance suite, and out-of-box demo depend on it. The honest fix is
  *quarantine*, not removal.

## Phased plan / disposition

Implemented in one pass (branch `fix/purge-demo-leaks-to-aplus`):

| Item | Change | File |
|---|---|---|
| `enterprisePosture()` | new helper | `host/deployPosture.ts` |
| LEAK-2 | `assertDurableSurfacesInEnterprise()` + boot call | `host/surfaceBackends.ts`, `host/inMemorySurfaces.ts` |
| LEAK-3 | gate `mock-ai` node registration | `bootstrap/nodes.ts` |
| LEAK-4 | reject `provider:'mock'` in `auth` | `aiProviders/aiProvidersHost.ts` |
| LEAK-5 | test-seam-gate `media/generate-image` | `routes/mediaAssets.ts` |
| LEAK-7 | honor `OPENWOP_DEMO_SEED_ENABLED` in all seeders | `host/exampleDataSeeders.ts` |
| LEAK-8 | conformance nodes fail-closed in `auth` | `bootstrap/conformanceMockAgent.ts` |
| LEAK-9 | alarm demo→owner bypass | `host/accessControlService.ts` |
| LEAK-10 | demo-gate `ctx.knowledge` fallback | `host/knowledgeSurface.ts` |
| LEAK-1 | email send is honest (501) without a transport + injection seam | `features/email/emailService.ts` |
| DUR-4 | network recorder default OFF in the bundle | `frontend/react/.env.production` |
| LEAK-6 | hide "Planned" integration stubs outside demo | `frontend/react/src/agents/AgentIntegrationsPanel.tsx` |

## RFC gate (wire vs host-extension)

**Host-extension / posture only — NO new RFC required.** Every change is a
boot-time gate or a host-extension route under `/v1/host/openwop-app/*`. No
normative wire surface is touched. LEAK-1's *full* real-email-marketing send
(verified sender identity, connector-brokered SendGrid) composes the
already-Proposed **ADR 0193** and is out of scope here; this ADR only makes the
current stub honest and adds the provider injection seam 0193 drops into.

## Open questions

- **`host.memory` (RFC 0004 agent memory) has no durable backend** (it is not a
  `SurfaceKey`). It is excluded from the durability guard for now; a durable
  adapter is tracked as DUR-2 follow-up.
  > **Correction (Phase 1, 2026-07-03): RESOLVED — but not via a bundle
  > `SurfaceKey` adapter alone.** Architecture review caught that `host.memory`
  > is a module-level, synchronous API with six direct consumers (executor
  > run-summary, `subjectMemory`/ADR 0041, `rosterCascade`, `routes/memory`,
  > `projectsService`, compaction seam) — registering a bundle surface nobody
  > calls would have durable-ized a dead path while every real consumer kept
  > hitting the ephemeral map. The landed design keeps `inMemorySurfaces.ts` as
  > the ONE owner of memory semantics: the module API became async over a
  > dumb-rows `MemoryScopeStore` seam (`getRows`/`mutateRows`/`clearScope`),
  > resolved per call through the SAME backend seam (`OPENWOP_SURFACE_MEMORY` /
  > `OPENWOP_SURFACE_BACKEND`), with `host/durable/durableMemory.ts` as the
  > CAS-atomic Storage-backed impl. `'memory'` joined `SurfaceKey` for
  > selection/guard/advertisement uniformity; the run-summary write gained a
  > deterministic `runsummary:<runId>` id (upsert — crash-retries never accrete
  > duplicates); the advertisement note flips honestly when durable.
- **Should `OPENWOP_DEMO_SEED_ENABLED` default flip to `false`?** Kept `true`
  (reference-app first-use) but now *honestly* honored everywhere; a hardened
  deploy sets it `false`. Revisit if the white-label bundle wants opt-in seeding.
  > **Correction (Phase 1, 2026-07-03): RESOLVED — posture-dependent default
  > (DUR-3).** Default stays `true` outside the enterprise posture (reference
  > first-use preserved) and flips to **opt-in under
  > `OPENWOP_DEPLOY_POSTURE=auth`**; an explicit `true`/`false` always wins.
  > SEEDING.md / WHITE-LABEL.md / `.env.example` updated in lockstep.

## Phase 1 follow-ups (DUR-1/2/3/5) — implemented 2026-07-03

The remaining durability items landed as one pass, reviewed by `/architect`
first (which corrected DUR-2's mechanism, moved the DUR-1/5 guards to `main()`,
and widened DUR-1 to an allowlist):

| Item | Change | File |
|---|---|---|
| DUR-1 | `auth` posture requires a durable DSN (`postgres://`) — refuses `sqlite://` AND `memory://`; escape hatch `OPENWOP_ALLOW_EPHEMERAL_STORAGE=true` | `host/deployPosture.ts` (`enterprisePostureStartupError`), wired in `index.ts main()` |
| DUR-5 | `auth` posture requires `NODE_ENV=production` — abort (was: WARN); escape hatch `OPENWOP_ALLOW_INSECURE_AUTH_POSTURE=true` | same guard |
| DUR-3 | seed capability opt-in under `auth` (default unchanged elsewhere) | `host/exampleDataSeed.ts` |
| DUR-2 | durable RFC 0004 memory (see correction note above) | `host/durable/durableMemory.ts`, `host/inMemorySurfaces.ts`, 6 consumers |

**Guard placement rule (Testability):** deployment-posture guards live in
`main()` only — `createApp()` is booted in-process by the whole test suite
(NODE_ENV=test, `memory://`) and by embedded consumers, and must never pay
server-deployment guards. The posture-requirement contract is centralized in
`deployPosture.ts` so it reads in one file.

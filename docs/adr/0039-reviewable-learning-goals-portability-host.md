# ADR 0039 — Reviewable-learning / standing-goals / portability reference-host endpoints (RFCs 0096/0097/0098)

Status: **implemented (Phases 1–3)**

## Context

RFCs **0096** (reviewable-learning proposal lifecycle), **0097** (standing goals +
judge-based continuation), and **0098** (agent-platform portability export/import)
reached `Active` on the spec floor (`openwop` PR #698, merge `2342156e`; conformance
suite bumped to `1.24.0`). As the OpenWOP **reference host**, openwop-app implements
the three host-sample surfaces these RFCs define their behavioral conformance against,
per `spec/v1/host-sample-test-seams.md §11`:

```
/v1/host/openwop-app/proposals[...]      (RFC 0096)
/v1/host/openwop-app/goals[...]          (RFC 0097)
GET /v1/host/openwop-app/export · POST /v1/host/openwop-app/import[?dryRun=]   (RFC 0098)
```

These are **non-normative host-extension routes** under `/v1/host/openwop-app/*` (per
`host-extensions.md` §"Canonical prefixes") — they ride the already-Accepted RFCs and
need **no new RFC**. The reference host is the designated graduation witness for the
`portability.import` non-vacuous leg (RFC 0098 Active→Accepted), since the only other
implementing host (myndhyve) honest-omits `import` until its conflict-plan path ships.

## Decision

Three self-contained **feature-packages** (ADR 0001), one per RFC, appended to
`BACKEND_FEATURES` with zero core edits beyond the registry line + the capability
advertisement in `discovery.ts`. Each: `feature.ts` + `routes.ts` + `service.ts` +
`types.ts`, persisted via the tenant-partitioned `DurableCollection`. Capabilities are
advertised **env-gated** (`OPENWOP_{PROPOSALS,GOALS,PORTABILITY}_ENABLED`) so
advertise/enforce parity (`capabilities.md`) stays operator-controlled and the host
never over-claims. Each feature advertises **only the sub-levels it honors**.

### Wire-shape & SECURITY invariants upheld
- **`proposal-inert-until-applied`** — a proposal is an inert record; only `apply`
  transitions state→`applied` and installs anything.
- **`proposal-no-resynthesis`** — `apply` installs the byte image already stored on
  `proposal.artifact` **verbatim**; the installed ref is a deterministic hash of those
  bytes. The service imports nothing that could regenerate the artifact (no LLM, prompt,
  or agent call). Asserted by `test/proposals.test.ts`.
- **`goal-completion-judge-only`** — a client-supplied `state: satisfied` on `PATCH
  /goals/{id}` is refused; completion is the judge's verdict.
- **`export-bundle-no-credential-material`** — `import` rejects (422) a bundle whose item
  payload carries a literal credential value **before** applying; export is refs-only.

### Activation & scope
- `proposals/{id}/apply` is **fail-closed on `packs:publish`** (installing the
  materialized artifact is a pack-publish-class mutation). An unseeded caller resolves to
  zero scopes via `resolveSubjectScopesUnion` (fail-closed) → 403 — no env toggle needed
  to make the `proposal-reviewable-learning` 403 leg non-vacuous. Activation routes
  through the advertised `agents.proposals.activation`: `direct-rbac` installs inline;
  `approval-gate` mints an RFC 0051 approval before install (`OPENWOP_PROPOSALS_ACTIVATION`).
- Lists lazily seed one canonical demo row per tenant so the conformance behavioral legs
  (which soft-skip on an empty list) are non-vacuous for whatever tenant the driver
  authenticates as.

### Alternatives weighed
- *Normative `/v1/{proposals,goals,export,import}` paths now* — rejected: the RFCs are
  `Active`, not `Accepted`; the floor surfaces are `/v1/host/openwop-app/*`, promotable at
  graduation (RFC 0086 precedent). Advertising normative paths pre-Accepted would be a
  dishonest wire claim.
- *Bind `apply` to a new `host:proposals:apply` scope* — rejected: editing the core
  `PROTOCOL_SCOPES` catalog is a cross-cutting core change with parallel-session collision
  risk; reusing the existing `packs:publish` scope is honest (apply installs an artifact)
  and self-contained.

## Phased implementation

| Phase | Scope | Status | Commit/PR |
| ----- | ----- | ------ | --------- |
| 1 | proposals (RFC 0096) — routes, byte-image apply, fail-closed scope, capability, tests | **implemented** | `feat/p2-app-proposals-goals-portability` (this PR) |
| 2 | goals (RFC 0097) — create/bounds-422/state-guard/pause-resume-abandon, verifier judge, capability | **implemented** | `feat/p2-app-goals` (stacked) |
| 3 | export/import (RFC 0098) — refs-only export, dryRun plan, import-apply with credential-422 + dependsOn-cycle-422; **`portability.import` graduation witness** | **implemented** | `feat/p2-app-portability` (stacked) |

## Open questions / decisions

- [x] `apply` scope binding → `packs:publish` (fail-closed via `resolveSubjectScopesUnion`).
- [x] Non-vacuity for conformance → lazy per-tenant demo seed on list.
- [ ] Default activation mode in production deploy — `direct-rbac` vs `approval-gate`.
- [ ] Full `1.24.0` conformance run wiring — bump `@openwop/openwop-conformance` to
      `^1.24.0` + run `test:conformance` once the suite publishes to npm (openwop-1 pings
      the published version on the coordination bus).

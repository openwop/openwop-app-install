# ADR 0548 — OpenWOP app A-grade readiness program

Status: Accepted — program in execution; children 0549–0556 all `Accepted`, and 0549 + 0550 are now `implemented` on their own phase lists. Exit criteria as of 2026-08-17: **P0 met, P1 met, P2 met for durability but not multi-instance (0551 P3 open), P3 MET (0552 P2 + 0553 P2 both shipped and advertised — the "parked on spec prose" reason expired 2026-08-16), P4 partial (0554 P0–P2b + wire flip and 0556 P0/P1/P3§A§B shipped; 0555 stops at P1), P5 not started.** Residue register reconciled 2026-08-17 (`docs/steward/AGRADE-WIRE-BLOCKED-RESIDUE.md`); program roll-up is now DERIVED from the children — `scripts/adr-rollup.mjs --check`, gated in `scripts/ci.sh` (2026-08-18). **The exit-criteria sentence above is a snapshot dated 2026-08-17 and was already wrong by the next morning** — "0555 stops at P1" (P2 shipped `1f422e383`), "0556 P2/P4 open" (P2 shipped `2fb186f02`), "0554 P3/P4 open" (P3 shipped `76a684281`). Read § "Implementation record — program roll-up" for the derived view; this line is prose and cannot be gated. **Target: the program's bar is A+, per `docs/OPENWOP-A-PLUS-ROADMAP.md` — A was the original bar and is no longer the exit.**

Date: 2026-08-11

Source: [`docs/steward/OPENWOP-PROTOCOL-APP-INDUSTRY-ASSESSMENT.md`](../steward/OPENWOP-PROTOCOL-APP-INDUSTRY-ASSESSMENT.md)

Depends on: ADRs 0549–0556 and protocol RFCs 0148–0156. The RFCs are Draft at
the time of this proposal; no dependent wire behavior or capability may ship or
be advertised until its RFC is Accepted.

> **CORRECTION 2026-08-18 (H78) — the sentence above states the gate as a RUNG
> NAME, and that test is wrong in both directions.** It has since been corrected
> twice in `CLAUDE.md`, and this ADR is the document those corrections were
> reacting to, so leaving it uncorrected here leaves the original error as the
> citable one.
>
> **Why "until its RFC is Accepted" is wrong.** `RFCS/README.md:24` — a maintainer
> flips `Active` on merge, "then to `Accepted` **once the implementation lands**".
> Implementation PRODUCES `Accepted`. Requiring `Accepted` *before* shipping makes
> the terminal state unreachable for every RFC this program depends on, not just
> the adoption-gated ones. Falsified twice in three days in the corpus: RFC 0142
> (`83db004c`) and RFC 0145 (`984ced5f`) both flipped `Active → Accepted` **after**
> the host work that witnessed them.
>
> **Why the obvious repair — "until its RFC is Active" — is ALSO wrong.** A status
> name is the wrong instrument. `:31` locks wire shapes at `Active` *"unless the
> RFC explicitly says otherwise"*, and an RFC may gate advertisement on more than
> shape. **RFC 0121 is the live counterexample: it is `Active` and says no host may
> advertise or implement `subscription` until a legal/ToS review clears.** Naming
> `Active` would have licensed exactly the advertisement that RFC forbids.
>
> **The test this program actually holds itself to**, three parts, all required:
> the RFC's **wire shape is LOCKED**; the RFC **does not itself gate
> advertisement**; and this host **actually honours the behaviour**. Advertising a
> capability that fails any one of those is a dishonest wire claim, and
> `OPENWOP_REQUIRE_BEHAVIOR=true` fails it. Read the RFC, not the rung.
>
> This is the same defect class as invariant 5 below — an accepted document is not
> evidence — applied to the corpus's own status ladder.

## Context

The reference app has broad protocol coverage, strong replay/fork behavior,
tenant guards, a central route registry, and durable run leases. It still cannot
support an A-grade claim. The audit found one critical tenant-isolation defect,
several production durability and assurance seams, legacy A2A/MCP composition,
no generic compensation runtime, incomplete metrics, and claims that are not
bound to deployment-profile evidence.

This ADR is the program contract. It does not create a ninth implementation
subsystem. Each child ADR extends an existing owner.

## Decision

Adopt the following closure program and do not publish a blanket “A-grade” or
“best in class” claim until every exit criterion is met.

| Gap IDs | Child ADR | Existing owner | Protocol gate |
|---|---|---|---|
| OWP-A-001–003 | 0549 — durable tenant-scoped idempotency | `Storage`, `routes/runs.ts` | Current v1 rule now; RFC 0150 for recipe v2 |
| OWP-A-004–006, 015, 017 | 0550 — conformance, CI, provenance and claims | CI, conformance harness, ADR 0518 | RFC 0148, 0155, 0156 |
| OWP-A-007, 008, 014 | 0551 — durable workspace and queued dispatch | `Storage`, workspace store, run lease/sweeper | RFC 0150 for fenced multi-region claim |
| OWP-A-009 | 0552 — A2A 1.0 adapter | `a2aServer`, `a2aTaskStore`, agents route | RFC 0152 |
| OWP-A-010, 011 | 0553 — MCP 2026-07-28 secure adapter | MCP client/router/route | RFC 0153 |
| OWP-A-012 | 0554 — compensation and recovery | executor, effect context, DLQ, approvals | RFC 0151 + 0150 |
| OWP-A-013 | 0555 — untrusted pack isolation | pack trust + sandbox adapters | RFC 0035 must be Accepted |
| OWP-A-016 | 0556 — production telemetry and workload identity | OTel, auth context, operations | Metrics now; RFC 0154 for identity wire |

### Program invariants

1. **Safety before breadth.** OWP-A-001 is a release blocker. Optional surface
   growth does not outrank tenant isolation, deterministic replay, or durable
   ownership.
2. **One owner per concept.** Storage state goes through `Storage`; dispatch
   goes through the run-dispatch seam; recovery extends the existing DLQ and
   Operations surfaces; protocol adapters extend their existing routes.
3. **Honest discovery.** A capability is absent unless the active deployment
   profile passes its behavioral evidence. Test-seam success cannot license a
   production claim.
4. **No wire-by-ADR.** Host-only correctness phases may proceed; wire-dependent
   phases wait for the named RFC to reach Accepted.
5. **Measured graduation.** A child ADR moves to implemented only with a
   phase-to-commit/test record. This umbrella closes only after external
   deployment evidence and the protocol governance gates exist.

## Boundaries audit

| Concern | Existing seam to extend | Forbidden parallel surface |
|---|---|---|
| Run request deduplication | `storage/storage.ts:248-271`, `routes/runs.ts:333-470` | route-local `Map` or second cache |
| Run dispatch/recovery | `host/runDispatch.ts`, `host/runDispatchSweeper.ts` | feature-owned executor or daemon |
| Workspace files | `host/workspaceStore.ts`, `Storage` adapters | a second database/client |
| Protocol adapters | existing A2A and MCP routers | version-specific duplicate public routes |
| Side effects/recovery | `host/runEffectContext.ts`, executor, ADR 0532 | feature-local saga engines |
| Operator control | ADR 0395 Operations | separate admin console |
| Telemetry | `observability/tracer.ts`, structured logger | vendor-specific instrumentation tree |

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | None. This is core-host hardening; child ADRs preserve current owners. |
| 2 | Toggle | No product toggle. Deployment adapters may be config-selected, but correctness cannot be disabled. |
| 3 | Workflow surface | Existing workflow engine only. |
| 4 | Node pack | No new pack from this umbrella. Compensation may add core metadata only after RFC 0151. |
| 5 | Envelopes | Existing event/envelope owners; no new envelope invented here. |
| 6 | Agent pack | None. |
| 7 | Public surface | Only RFC-accepted additive behavior; host diagnostics remain under `/v1/host/openwop-app/*`. |
| 8 | RBAC | Existing tenant guard, protocol scopes, and Operations superadmin controls. |
| 9 | Replay/fork | Every phase must preserve recorded definition, identity, effect, and variant facts. |
| 10 | Frontend | Only Operations projections; no new top-level product destination. |

## Program phases and exit criteria

| Phase | Scope | Exit criterion |
|---|---|---|
| P0 | ADR 0549 security repair | Cross-tenant key reuse cannot observe or affect another tenant; migration and adversarial tests green. |
| P1 | Assurance baseline | Typecheck + non-vacuous conformance are blocking; claims name exact profile, version, commit and environment. |
| P2 | Production durability | Workspace survives restart; accepted dispatch is durably queued; multi-instance tests pass. |
| P3 | Interop currency | A2A 1.0 and MCP 2026-07-28 profiles pass current-peer tests while legacy profiles remain explicit. |
| P4 | Failure semantics/isolation | Compensation, isolated untrusted packs, metrics and workload identity meet child-ADR gates. |
| P5 | Qualification | Managed deployment chaos, multi-region, security and conformance evidence is published and independently reproducible. |

## Implementation record — program roll-up

Children own their own phase tables; this is the program's view of what merged,
so the exit criteria above can be read against the tree instead of against
memory.

> **CORRECTION 2026-08-18 — this section is now DERIVED, because the hand-kept
> version could not go red.** It was reconciled by hand at H44 (`a847daa50`,
> 2026-08-17 12:22) and was stale within hours: by the next morning it trailed
> SIX program merges — #3315 (0553 H47), #3317 (0555 **P2**), #3318 (0556
> **P2**), #3319 (0550 H48), #3322 (0554 **P3**), #3325 (0553 **P3**) — and this
> ADR's own `Status:` line asserted three things that were false by then:
> "0555 stops at P1", "0556 P2/P4 open", "0554 P3/P4 open".
>
> Nothing could fail. The only test citing this ADR pins the wire NEGATIVE SPACE
> (`agrade-wire-blocked-residue.test.ts`), not the roll-up, so a child could ship
> three phases and every gate stayed green — the umbrella asserting an
> out-of-date fact about its own programme, which is the failure mode invariant 5
> names one level down ("accepted ≠ evidence").
>
> `scripts/adr-rollup.mjs` now generates the block below by QUOTING each child's
> `Status:` line, and `--check` fails when a child moves and the umbrella has not
> been re-read. It deliberately does not parse phase tables or infer which phases
> are done: an inference that is wrong is worse than the staleness it replaces.
> The historical merge table that used to sit here is preserved below it, dated,
> as a record of what H44 verified with `git show <sha> --stat` — not as a live
> status board.

<!-- BEGIN GENERATED: program-rollup (scripts/adr-rollup.mjs) -->

<!-- Do not edit by hand: `node scripts/adr-rollup.mjs` regenerates it and
     `--check` fails when it drifts. Each cell QUOTES the child ADR's own
     `Status:` line (clipped); it is not an interpretation of one. -->

| ADR | Scope | Its own `Status:` line, quoted |
|---|---|---|
| [0549](0549-tenant-scoped-durable-run-idempotency-ledger.md) | Tenant-scoped durable run-idempotency ledger | implemented — P0–P2 2026-08-12 (`bfec8b9e4`), P3 2026-08-16 (`e6f22d739`, #3273; quarantine residue retired in `3653cd90d`, #3283). Merge provenance reconciled 2026-08-17 (H44) — see § "Merged-tree provenance" |
| [0550](0550-conformance-provenance-ci-and-claims-attestation.md) | Conformance, provenance, CI and claims attestation | Accepted — P0–P1 implemented 2026-08-11 (`bfec8b9e4`), P1 quarantine burned down 2026-08-13 (`5b70f0876`), P2 implemented 2026-08-13 (`022357c71`, `738346db7`); P3 verifier + signer + Operations projection implemented 2026-08-13 (`022357c71… |
| [0551](0551-durable-workspace-queued-dispatch-and-multi-region-qualification.md) | Durable workspace, queued dispatch and multi-region qualification | Accepted — P0 implemented 2026-08-12 (`9bd1377e2`, plus the ledger half in `bfec8b9e4`); P1 implemented 2026-08-16 (`28740fb4d`, #3275); P2 implemented 2026-08-16 (`699a9b17b`, #3284); P3 (multi-instance chaos matrix) and P4 (cross-region q… |
| [0552](0552-a2a-1-adapter-and-versioned-interop.md) | A2A 1.0 adapter and versioned interoperability | Accepted — P0 implemented 2026-08-12 (`483862a95`); P1 §B (downgrade |
| [0553](0553-mcp-2026-secure-versioned-adapter.md) | MCP 2026-07-28 secure, versioned adapter | Accepted — P0 implemented 2026-08-12 (`0f126b7e0`); P1 version seam implemented 2026-08-13; P1 §A (exact-version discovery) implemented 2026-08-15 (`6e7b9ed55`, #3253); **P2 implemented 2026-08-16** (the `mcp-2026-07-28` codec both directio… |
| [0554](0554-compensation-saga-and-operator-recovery-runtime.md) | Compensation saga and operator recovery runtime | Accepted — P0–P2 + the wire advert implemented; P3/P4 open. P0 2026-08-12 (`595cb40e9`); P1 ledger half 2026-08-14 (`4c413d4c0`, #3214); **P2 reverse-completion unwind + retries + approval gate + DLQ parking 2026-08-16** (`800b6f0da`, #3274… |
| [0555](0555-untrusted-pack-trust-tier-and-isolated-execution.md) | Untrusted-pack trust tier and isolated execution | Accepted — P0 implemented 2026-08-12 (`be62a115e`, #3179; preceded by CORRECTION 1, `b920beddf`, #3172); P1 implemented 2026-08-16 (`f16489a16`, #3288); P2 (first production isolation adapter) implemented 2026-08-17 — see the P2 implementat… |
| [0556](0556-production-metrics-workload-identity-and-assurance-operations.md) | Production metrics, workload identity and assurance operations | Accepted — P0 (metric catalog, SDK/export/shutdown, cardinality lint) implemented 2026-08-14 (`b62d0080f`, #3202); P1 (seam instrumentation + SLOs) implemented 2026-08-16 (`0433125fa`, #3277); **P3 §A/§B (workload identity + delegated actor… |

<!-- END GENERATED: program-rollup -->

### Historical — merges verified at H44 (2026-08-17), not maintained since

| Child | Phases merged since 2026-08-13 | Merge commits |
|---|---|---|
| 0549 | P3 (RFC 0150 §B/§C effect identity + digest v2) | `e6f22d739` (#3273) |
| 0550 | P2 correction; pin 1.106 → 1.130 → ^1.135; **P4 public exact-profile claims** | `f9ad587f1` (#3276), `3653cd90d` (#3283), `756a9938d` (#3298), `54229aa61` (#3309) |
| 0551 | P1 durable dispatch outbox; P2 readiness advert + metrics + redrive | `28740fb4d` (#3275), `699a9b17b` (#3284) |
| 0552 | P2 A2A 1.0 codec; P2 CORRECTION + H19/H24/H25/H26 | `24b9e6c9b` (#3280), `5a902f30c` (#3286) |
| 0553 | P2 the 2026-07-28 codec; H43 anon refusal; H21 operator MCP server | `df03c3476` (#3279), `5bd850706` (#3303), `fb6cbbcba` (#3311) |
| 0554 | P2 unwind; **P2b RFC 0157 chain carry**; wire flip + §21 recovery + UQ4 | `800b6f0da` (#3274), `1b2dd6fbb` (#3292), `d209d8009` (#3294) |
| 0555 | P1 isolated-worker contract + fake adapter | `f16489a16` (#3288) |
| 0556 | P1 seam instrumentation + SLOs; P3 §A/§B workload identity; H28 §B chain bounds | `0433125fa` (#3277), `8fbed15d4` (#3278), `3653cd90d` (#3283) |

### Program-level work that belongs to no single child

These are invariant-4 and gate-integrity items — they carry H-numbers rather
than phase numbers, and each is here because it changed what the program's
evidence MEANS, not what a feature does.

| Item | PR | Merge commit | What it changed |
|---|---|---|---|
| Residue-register reconciliation; three guards re-pointed | [#3272](https://github.com/openwop/openwop-app/pull/3272) | `35a12948a` | Three negative assertions watched paths **no RFC uses** — green for the wrong reason for five days |
| H39/H40 — pin `^1.135.0` + a process-group watchdog for the conformance runner | [#3298](https://github.com/openwop/openwop-app/pull/3298) | `756a9938d` | A runner that could outlive its parent made red/green depend on the machine |
| H27/H27-b/S22 — every HTTP error body converged on the canonical FLAT envelope | [#3300](https://github.com/openwop/openwop-app/pull/3300) | `9b342b3be` | Wire-shape convergence across ~18 seams; `flat-error-envelope-ratchet.test.ts` is the no-growth guard |
| H42 — a stale RFC 0146 suite stamp can no longer ship | [#3303](https://github.com/openwop/openwop-app/pull/3303) | `5bd850706` | Prod advertised `suiteVersion: "1.66.0"` against a 1.135 pin; "omitting" now means REMOVING, not "leave whatever is there" |
| H41 — every ephemeral test server binds `127.0.0.1` | [#3305](https://github.com/openwop/openwop-app/pull/3305) | `3318d7062` | A wildcard `listen(0)` can hand a test a port a resident loopback daemon holds, which reads as an assertion failure |

**Two of those are the same defect class as the one invariant 4 exists to stop,
and both were found OUTSIDE the merge gate.** H42 and H43 (ADR 0553) were each
caught on the production wire while every local gate was green — H42 because the
deploy checkout carried a previous derivation into the next upload, H43 because
the conformance lane cannot reproduce the cookie posture prod runs in. The
program-level lesson is narrower than "test more": **a green lane is evidence
about the lane's posture, and the deployment posture is a different fact.**

**H41 also produced a second-order finding worth keeping** (recorded in #3309):
`e9b2739d0` (#3304) merged AFTER H41's guard landed and added two wildcard binds,
so every PR gated afterwards was red for a reason its author did not cause.
Attribution was measured — reproduced in a clean detached `origin/main` worktree
with none of the branch's changes present — not assumed.

### Exit criteria, honestly re-read at this reconciliation

- **P0 met** (0549 P0–P2, plus P3's effect identity).
- **P1 met** (0550 P0–P4; claims now derive from the RFC 0148 §A ledger of a real
  strict run, and a profile with any non-`executed-pass` floor row is reported
  NOT claimed with its reason).
- **P2 met for durability, NOT for multi-instance** — 0551 P1+P2 shipped; P3's
  chaos matrix has not run.
- **P3 met** (0552 P2 + 0553 P2, both advertised and behaviourally witnessed).
- **P4 partial** — 0554 P0–P2b + the wire flip and 0556 P0/P1/P3 §A§B shipped;
  0555 stops at P1 (contract + fake adapter, no real isolation adapter), 0554
  P3/P4 and 0556 P2/P4 are open.
- **P5 not started.** It needs an independent environment that does not share the
  steward's cloud account — still an open decision below, and no evidence has
  been published.

## Alternatives weighed

- **One giant implementation ADR:** rejected; it would obscure ownership and
  make independent acceptance impossible.
- **One ADR per audit sentence:** rejected; related defects share one invariant
  and one data migration, so that split would create artificial boundaries.
- **Declare the reference app non-production indefinitely:** honest but does not
  address the user goal. The program instead makes production claims earned and
  profile-specific.

## Open decisions

- Which durable queue adapter is the first managed reference target (Cloud
  Tasks, Pub/Sub, or a database-backed outbox)? ADR 0551 defines the interface
  and evidence before selecting the default.
- Which independent environment will reproduce P5 evidence? It must not share
  the steward's cloud account or credentials.


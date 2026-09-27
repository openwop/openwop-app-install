# OpenWOP A+ Protocol and Reference-App Roadmap

- Status: Proposed cross-repository program plan
- Audience: OpenWOP protocol agents, openwop-app agents, maintainers, reviewers,
  security assessors, and independent implementers
- Last updated: 2026-08-17
- Protocol baseline: `openwop/openwop`
  `54f29548af7c1b388553b982a6819ecd7d7ae4d9`
- App audit baseline: `openwop/openwop-app`
  `10f8ba3cdf83e95edf5aba36792377921754f95c`
- Document-authoring baseline: `openwop/openwop-app`
  `c0f44262863757015f20d2321b43500b762283ec`

## Purpose

This document is the single coordination plan for raising both the OpenWOP
protocol and its reference application to A+ quality across protocol design,
machine contracts, durability, security, conformance, interoperability,
operations, governance, and independent assurance.

It consolidates the remaining work identified by the 2026-08-17 protocol and
application audit. It is a planning and evidence contract, not itself proof
that any gap is closed.

The target is not achieved by accepting every RFC and ADR. It is achieved only
when the specified behavior is implemented, tested through the correct
boundary, independently witnessed where required, and accurately reflected in
public claims.

## How agents must use this document

1. Fetch `origin/main` in the repository being changed before relying on an
   artifact number, status, implementation note, dependency version, or test
   result.
2. Work from an isolated worktree based on current `origin/main`; do not change
   branches in a shared checkout.
3. Audit existing surfaces before creating a new one. Extend the current owner
   for runs, events, identity, storage, queues, packs, schedules, credentials,
   capabilities, or conformance rather than creating a parallel subsystem.
4. A wire-shape, capability, error-semantic, event, profile, or normative
   behavior change starts in `openwop` as an RFC. The app ADR may implement an
   accepted RFC but cannot privately redefine it.
5. Host-local product and operator routes remain under
   `/v1/host/openwop-app/*`. They must not be presented as portable OpenWOP
   behavior.
6. Amend an existing RFC or ADR when its accepted scope already owns the gap.
   Create one of the new artifacts proposed below only when the gap introduces
   a genuinely new decision or contract.
7. Allocate proposed RFC and ADR numbers immediately before authoring. The
   candidate numbers in this document assume RFC 0157 and ADR 0579 are still
   the latest artifacts.
8. Do not mark a phase complete based on source inspection alone when its exit
   criterion requires a live host, crash test, current upstream peer, external
   auditor, independent maintainer, or Tier-3 implementation.
9. All tests and audits must run with bounded workers and bounded memory. Do
   not run the full protocol gate, backend tests, frontend build, and
   conformance suite concurrently on a developer workstation.
10. Every completion claim must identify its evidence level:
    `schema`, `server-free`, `test-seam`, `local-live`, `deployed-live`,
    `official-peer`, `independent-host`, or `external-audit`.

## Current assessment

| Target | Technical grade | Assurance grade | Composite |
|---|---:|---:|---:|
| OpenWOP protocol | B | C- | C+ |
| openwop-app | B+ | C- | B- |
| App-to-protocol conformance | — | — | B- |

The strongest areas are replay/fork safety, typed artifacts, capability-aware
design, authentication architecture, SDK breadth, and the newly implemented
idempotency, MCP, A2A, workspace, dispatch, compensation, and telemetry
foundations.

The main A+ blockers are:

- disabled or unenforced hosted CI and an unprotected app `main` branch;
- incomplete independent governance, adoption, and external security evidence;
- incomplete multi-instance and multi-region fault qualification;
- incomplete compensation triggers and portable operator recovery;
- project-maintained interop peers instead of official upstream peers;
- incomplete signed conformance and release attestations;
- residual normative-document, discovery-example, and schema-discipline drift;
- production dependency vulnerabilities and incomplete untrusted-code/network
  isolation;
- resource-unbounded test execution that has previously exhausted workstation
  memory and swap.

## A+ definition of done

Both repositories reach A+ only when all of the following are true:

- There are no open Critical or High correctness or security findings.
- No host advertises behavior it does not execute.
- Every public compatibility claim names exact profiles and an evidence level.
- Required behavior has non-vacuous, requirement-level conformance evidence.
- OpenAPI, AsyncAPI, schemas, SDKs, examples, capability discovery, and prose
  agree mechanically.
- Run admission, dispatch, retries, replay, fork, compensation, and external
  effects remain correct across crash and duplicate-delivery boundaries.
- Multi-instance claims have chaos evidence; multi-region claims additionally
  have partition and effect-fencing evidence.
- Current MCP and A2A profiles pass against pinned upstream implementations.
- Release and certification artifacts are signed and bound to exact source,
  image, suite, schema, discovery, and profile digests.
- The external security audit is complete with no open Critical or High
  findings.
- At least two independent maintainers participate in governance.
- At least one Tier-3 host publishes valid core-standard evidence plus a
  current interop profile.
- Hosted CI is required, branch protection is active, and a failing required
  check demonstrably blocks merge.
- Full qualification runs within documented resource budgets and cannot create
  unbounded worker fan-out.

# Part I — OpenWOP protocol RFC program

## Existing RFCs to complete

### RFC 0147 — Protocol Integrity and Standards-Readiness Program

Artifact: `openwop/RFCS/0147-protocol-integrity-and-standards-readiness-program.md`

Role: umbrella program and authoritative cross-workstream ledger.

Required work:

- Track every child RFC and every external gate in one generated status view.
- Require all acceptance items to be classified as complete, carried, or
  externally gated.
- Keep the protocol gap and risk registers synchronized with actual evidence.
- Close every Critical gap.
- Require an independent reassessment with no dimension below B and an overall
  score of at least A- before the program can claim completion.
- Raise the final target to A+ using this document's definition of done.

Exit evidence:

- All child artifacts below are complete.
- External audit, independent maintainers, and Tier-3 evidence exist.
- A new independent assessment grades every dimension A or A+.

### RFC 0148 — Non-Vacuous Conformance and Certification Evidence

Artifact: `openwop/RFCS/0148-non-vacuous-conformance-certification.md`

Required work:

- Move requirement identity from scenario-file granularity to behavioral-leg
  or assertion granularity for all profile-floor requirements.
- Require one execution witness for every required behavior.
- Populate and verify `witnessSha256` instead of leaving it informational or
  unused.
- Bind each witness to host revision, suite revision, discovery digest,
  machine-contract digest, and runtime configuration class.
- Reject missing, zero-assertion, unclassified, stale, duplicated, or
  mismatched witnesses.
- Invalidate evidence automatically after relevant host, schema, profile, or
  suite changes.
- Publish deterministic reproduction commands.
- Compose with proposed RFC 0160 for signatures and provenance.
- Reissue all official certification bundles after the final evidence format
  lands.

Required tests:

- Early return after advertisement cannot pass.
- Missing seam under strict mode cannot pass.
- One unrelated assertion cannot certify a behavioral file.
- Tampered witness digest, suite digest, discovery digest, or totals fail.
- Evidence redaction removes secrets from both keys and values.
- The verifier itself is tested with sabotage fixtures.

### RFC 0149 — Machine-Contract and Version Reconciliation

Artifact: `openwop/RFCS/0149-machine-contract-and-version-reconciliation.md`

Required work:

- Correct the remaining gRPC capability example that uses a top-level
  `capabilities` wrapper.
- Remove stale language saying accepted work is still “in flight.”
- Validate all normative JSON and YAML examples, including examples inside
  tables, nested fences, and partial fragments.
- Run canonical-family typo detection across all spec documents and applicable
  RFCs.
- Require OpenAPI, AsyncAPI, schemas, SDK operation manifests, and prose
  examples to produce one operation inventory.
- Fail when an accepted RFC's normative document is Draft without an explicit
  lifecycle annotation.
- Sabotage-test every extractor so a zero-match parser cannot report success.

Exit evidence:

- Zero known example contradictions.
- Zero unresolved operation-path differences.
- All normative lifecycle mismatches classified and resolved.

### RFC 0150 — Effect Identity, Replay, and Split-Brain Safety

Artifact: `openwop/RFCS/0150-effect-identity-replay-and-split-brain-safety.md`

Required work:

- Add Python and Go consumers for semantic-request-digest and effect-identity
  vectors.
- Complete pending-lease expiry, recovery, and stale-owner semantics.
- Prove provider retries retain one logical effect identity.
- Prove business-level identity prevents duplication when the same operation
  is reachable inside and outside a run.
- Add delayed-delivery, duplicate-delivery, lease-reclaim, stale-worker,
  partition, and failover cases.
- Add a live host that implements fenced external effects.
- Compose with proposed RFC 0159 for provider and regional qualification.

Exit evidence:

- TypeScript, Python, and Go produce byte-identical vector results.
- A deployed host rejects stale effect owners during a forced partition.
- No reconciliation algorithm grants effect authority merely by selecting a
  surviving record.

### RFC 0151 — Compensation and Partial-Failure Profile

Artifact: `openwop/RFCS/0151-compensation-and-partial-failure-profile.md`

Required work:

- Promote `spec/v1/compensation.md` from Draft only after its normative surface
  and lifecycle are complete.
- Complete crash-resume, retry, pause, manual, waiver, approval, substitute,
  termination, and dead-letter behavior.
- Define retention minimums and stable reason codes.
- Define fork behavior for partially compensated runs.
- Provide portable compensation-plan and attempt projections.
- Require reverse-completion ordering and stable compensation identity.
- Keep irreversible effects visible in run rollups.
- Prove replay and fork never re-fire completed inverse effects.
- Compose with proposed RFC 0158 for trigger negotiation and recovery APIs.

Exit evidence:

- Crash at every state transition resumes without duplicate compensation.
- Partial and irreversible outcomes remain visible and operator-actionable.
- Every advertised trigger executes non-vacuously.

### RFC 0152 — A2A 1.0 Versioned Composition

Artifact: `openwop/RFCS/0152-a2a-1-0-versioned-composition.md`

Required work:

- Run the profile against an official or pinned upstream A2A 1.0 peer.
- Test Agent Card/runtime consistency.
- Test task creation, status, artifacts, errors, cancellation, authentication,
  tenant isolation, and authority preservation.
- Add streaming and push-notification qualification.
- Specify and test restart-safe subscription and task correlation.
- Publish the legacy 0.3 adopter inventory.
- Enforce the deprecation date in claims and release tooling.
- Include official-peer evidence in certification bundles.

### RFC 0153 — MCP 2026-07-28 Versioned Composition

Artifact: `openwop/RFCS/0153-mcp-2026-07-28-versioned-composition.md`

Required work:

- Run against an official current MCP SDK or reference peer.
- Prove stateless discovery and per-request metadata behavior.
- Prove header/body version and method consistency.
- Prove MRTR request identity, retry, timeout, cancellation, and replay.
- Prove cache tenant scoping and invalidation after authorization changes.
- Prove extensions cannot expand authority.
- Specify durable callbacks or subscriptions wherever a host advertises them.
- Publish a complete 2025-06-18 migration runbook and adopter inventory.
- Enforce the legacy-profile retirement date.

### RFC 0154 — Workload Identity, Delegation, Telemetry, and Provenance

Artifact: `openwop/RFCS/0154-workload-identity-delegation-telemetry-and-provenance.md`

Required work:

- Register and witness every remaining security invariant.
- Define proof-format negotiation.
- Complete issuer, audience, tenant, expiry, chain-bound, cycle, and
  scope-amplification tests.
- Standardize sender constraint through mTLS, DPoP, or an explicitly profiled
  equivalent.
- Add SPIFFE/SVID guidance without making SPIFFE mandatory.
- Add provenance for packs and corpus releases, not just npm packages.
- Bind audit and telemetry facts to verified workload identity.
- Prove raw credentials and subject identifiers cannot enter evidence.
- Obtain external review.

### RFC 0155 — Core Profile and Extension Discipline

Artifact: `openwop/RFCS/0155-core-profile-and-extension-discipline.md`

Required work:

- Approve the extension budget and Stable maturity rules.
- Require Tier-3 evidence before an extension becomes Stable.
- Generate claim and badge vocabulary from the profile registry.
- Require every public compatibility claim to name exact profiles.
- Add SDK profile-derivation helpers.
- Enforce extension dependencies and canonical-family shadow prevention.
- Compose with RFC 0161 for the protocol-v2 closed namespace.

### RFC 0156 — Governance, Independent Assurance, and Claims Policy

Artifact: `openwop/RFCS/0156-governance-independent-assurance-and-claims.md`

Required work:

- Appoint at least two maintainers independent of the founding organization.
- Activate the working-group governance model.
- Remove single-steward tie-break dependence.
- Retire bootstrap waivers.
- Retrospectively review the high-risk waived RFC cohort.
- Commission and complete the external security audit.
- Remediate and retest all Critical and High audit findings.
- Resolve or time-bound the current Medium internal findings.
- Obtain at least one Tier-3 host.
- Require cross-organization review for security-sensitive normative changes.
- Publish recurring governance, security, and standards-version reviews.
- Keep A/A+ claims blocked until the evidence is machine-verifiable.

### RFC 0157 — Chain Fragments Carry Compensation

Artifact: `openwop/RFCS/0157-chain-fragments-carry-compensation.md`

Required work:

- Update every reference host to use the canonical compensation-carrying
  expansion core.
- Resolve the current SQLite/reference-host expansion drift.
- Exercise the live host expansion path without blocked or seam-only evidence.
- Prove nested chains preserve node compensation, chain policy,
  irreversible-effect markers, and deterministic expansion.
- Add cross-language expansion vectors.

## New RFCs to author

The identifiers below are provisional. Allocate the next free number after
fetching `origin/main`.

### Proposed RFC 0158 — Compensation Trigger Negotiation and Portable Recovery API

Why a new RFC is required: the current capability can represent generic
compensation support but cannot express that a host implements only a subset of
the defined triggers. The app currently accepts four trigger names while its
production executor initiates only the node-failure path.

Normative decisions:

- Add `compensation.supportedTriggers` with a closed vocabulary:
  `node-failure`, `run-cancel`, `cap-breach`, and `operator-request`.
- Prohibit advertising a trigger without executable behavioral evidence.
- Define canonical read projections for plans, obligations, attempts, and
  run-level rollups.
- Define portable recovery operations: retry, substitute, waive, and
  terminate.
- Define approval, separation-of-duties, principal binding, and audit rules.
- Define optimistic concurrency and `planVersion` behavior.
- Define stable reason codes, retention, redaction, replay, and fork behavior.

Conformance:

- Test each advertised trigger independently.
- Test unauthorized, stale-version, cross-tenant, duplicate, and replayed
  recovery requests.
- Test that an unadvertised trigger is refused rather than silently ignored.

Compatibility: additive.

### Proposed RFC 0159 — Fenced-Effect and Provider Idempotency Qualification

Why a new RFC is required: multi-region safety needs a certifiable effect-level
profile, not merely record-reconciliation prose.

Normative decisions:

- Define a `fenced-effects` capability profile.
- Define monotonic fencing tokens and stale-worker rejection.
- Separate record reconciliation from effect authority.
- Classify adapters as provider-enforced, host-ledger-enforced,
  compensatable, at-least-once-risk, or irreversible.
- Require evidence for every effect adapter a host exposes.
- Define retention and recovery rules for effect ownership records.
- Define single-instance, multi-instance, and multi-region qualification
  levels.

Conformance:

- Partition, delayed-delivery, duplicate-delivery, clock-skew, lease-expiry,
  and stale-owner scenarios.
- Adversarial provider that ignores idempotency.
- Provider timeout after committing the external effect.
- Region recovery without reauthorizing the losing worker.

Compatibility: additive profile, with safety-fix classification where an
existing claim implies unfenced safety.

### Proposed RFC 0160 — Signed Conformance Evidence and Release Attestations

Normative decisions:

- Define a signed evidence envelope compatible with SLSA/in-toto provenance.
- Bind host image, source, SDK, schema, suite, discovery, profile manifest, and
  configuration-class digests.
- Record builder and workflow identity, issuance time, expiry, nonce,
  supersession, and revocation.
- Provide an offline verifier.
- Define evidence redaction rules.
- Distinguish schema-valid, behaviorally passing, deployed-live,
  official-peer, independent-host, and external-audit evidence.
- Prohibit A/A+ claims based on unsigned or expired evidence.

Compatibility: additive.

### Proposed RFC 0161 — Closed Capability Namespaces and Protocol-v2 Discovery

Why a new major-version RFC is required: v1 intentionally permits unknown root
properties. Closing the schema in place would break forward-compatible v1
documents.

Normative decisions:

- Close canonical capability objects in protocol v2.
- Define explicit extension namespaces such as `x-host-*`, `vendor.*`, and
  `private.*`.
- Define registration, collision, opacity, and canonical-shadow rules.
- Require SDKs to preserve registered unknown extensions without treating them
  as canonical support.
- Define v1/v2 negotiation and migration.
- Make misspelled canonical families invalid in v2.

Compatibility: breaking; protocol-v2 target.

### Proposed RFC 0162 — Durable Execution and Disaster-Recovery Qualification

Normative decisions:

- Define accepted-work durability and atomic run admission.
- Define queue/outbox ownership, duplicate delivery, leases, redrive, poison
  items, and crash recovery.
- Define RPO/RTO declaration, backup/restore verification, region evacuation,
  version skew, and in-flight-run migration.
- Define recovery audit events.
- Add capability profiles for durable single-instance, durable multi-instance,
  and multi-region-qualified hosts.

Conformance:

- Kill after acceptance but before dispatch.
- Kill during execution and during checkpoint commit.
- Duplicate queue delivery.
- Poison item and exhausted redrive.
- Storage restore and region evacuation.

Compatibility: additive.

### Proposed RFC 0163 — Official-Peer Interoperability Evidence

Normative decisions:

- Define what qualifies as an upstream or independent peer.
- Define pinning, upgrade, and evidence-freshness policy.
- Define minimum MCP and A2A operation matrices.
- Require positive and adversarial identity, authorization, and tenant tests.
- Define how official-peer results enter certification bundles.
- Prohibit project-maintained fakes from being represented as independent
  interoperability evidence.
- Require a recurring standards-version review.

Compatibility: process and conformance addition.

### Proposed RFC 0164 — Normative Lifecycle and Publication Coherence

Normative decisions:

- Accepted RFC requirements must appear in normative specifications or carry
  an explicit implementation-status annotation.
- Draft specifications cannot silently carry released mandatory behavior.
- Stale “open,” “in flight,” and unresolved-question sections fail CI when
  contradicted by current status.
- Acceptance items must be machine-classified as complete, carried, or
  externally gated.
- Every external gate must name the required evidence.
- Generated protocol status becomes the authoritative publication index.

Compatibility: editorial and process.

# Part II — openwop-app ADR program

## Existing ADRs to complete

### ADR 0548 — OpenWOP App A-Grade Readiness Program

Artifact: `docs/adr/0548-openwop-app-a-grade-readiness-program.md`

Required work:

- Accept and update it as the umbrella app program.
- Raise its target from A to A+ using this document's definition.
- Convert its completion table into a generated or parity-checked ledger.
- Link all existing and proposed ADRs in this program.
- Prevent “ADR accepted” from being counted as implementation evidence.

### ADR 0549 — Tenant-Scoped Durable Run Idempotency Ledger

Artifact: `docs/adr/0549-tenant-scoped-durable-run-idempotency-ledger.md`

Required work:

- Complete RFC 0150 semantic-digest and effect-identity adoption.
- Consume cross-language vectors.
- Qualify lease expiry and stale-owner behavior.
- Add business-level effect identity tests.
- Resolve the crash window between run insertion and idempotency completion
  through proposed ADR 0582.
- Publish matching SQLite and PostgreSQL evidence.

### ADR 0550 — Conformance, Provenance, CI and Claims Attestation

Artifact: `docs/adr/0550-conformance-provenance-ci-and-claims-attestation.md`

Required work:

- Add a correction recording that hosted CI is disabled and recent merges have
  had no required status checks.
- Re-enable GitHub CI.
- Run `npm ci` before backend typecheck on clean runners.
- Require backend typecheck, backend build/tests, frontend canonical build,
  conformance, audits, contract parity, and provenance.
- Remove the assumption that local `scripts/ci.sh` protects hosted merges.
- Pin or automatically update the conformance suite within a defined freshness
  window.
- Generate release-candidate profile evidence.
- Add signed deployment attestations under RFC 0160.
- Compare deployed discovery with the attested build.
- Enforce exact public profile claims.

### ADR 0551 — Durable Workspace, Queued Dispatch and Multi-Region Qualification

Artifact: `docs/adr/0551-durable-workspace-queued-dispatch-and-multi-region-qualification.md`

Required work:

- Correct the implementation record to reflect the durable workspace and
  atomic dispatch outbox already shipped.
- Run two-instance workspace-CAS and queue-delivery tests.
- Add kill-after-acceptance and duplicate-delivery chaos tests.
- Define backlog age, lease, redrive, and poison-item SLOs.
- Fail production readiness when only process-local persistence is configured.
- Implement RFC 0159 effect fencing.
- Execute region-partition, stale-owner, and failover qualification.
- Advertise multi-region only after black-box evidence passes.

### ADR 0552 — A2A 1.0 Adapter and Versioned Interoperability

Artifact: `docs/adr/0552-a2a-1-adapter-and-versioned-interop.md`

Required work:

- Add official A2A SDK or peer tests to CI.
- Implement restart-safe streaming and push if those features are advertised.
- Persist task and subscription correlation.
- Verify peer authority cannot expand across the adapter.
- Test Agent Card/runtime parity against deployed discovery.
- Gather legacy-profile usage evidence and execute retirement.

### ADR 0553 — MCP 2026 Secure Versioned Adapter

Artifact: `docs/adr/0553-mcp-2026-secure-versioned-adapter.md`

Required work:

- Add official MCP SDK or reference-peer tests to CI.
- Persist MRTR requests that must survive instance restart.
- Add durable subscriptions where advertised.
- Harden cache invalidation after authorization changes.
- Complete extension routing and authority tests.
- Prove replay and fork cannot reissue callbacks.
- Remove the legacy profile after the protocol deadline.

### ADR 0554 — Compensation Saga and Operator Recovery Runtime

Artifact: `docs/adr/0554-compensation-saga-and-operator-recovery-runtime.md`

Required work:

- Implement all accepted triggers, not only terminal node failure.
- Until completion, advertise only the trigger actually implemented.
- Add run-cancel, cap-breach, and operator-request initiation.
- Complete reverse unwind and nested-chain ordering.
- Add retry, approval, waiver, substitution, termination, and DLQ flows.
- Expose the canonical RFC 0158 recovery surface.
- Add an operator UI with RBAC and separation of duties.
- Crash-test every compensation-ledger transition.
- Prove replay and fork do not re-fire compensation.
- Add adversarial fixtures for payment, notification, webhook, email, blob,
  and broker effects.

### ADR 0555 — Untrusted-Pack Trust Tier and Isolated Execution

Artifact: `docs/adr/0555-untrusted-pack-trust-tier-and-isolated-execution.md`

Required work:

- Enforce filesystem, environment, network, process, CPU, memory, and wall-time
  isolation.
- Replace `network-denied: not-enforced` with an enforceable policy.
- Implement the host-call broker.
- Authenticate worker calls and bind them to dispatch identity.
- Preserve interrupts and canonical error codes across the boundary.
- Carry replay effect restrictions into the worker.
- Deny unknown broker operations.
- Add cross-pack, process escape, worker-reuse, and confused-deputy tests.
- Advertise sandbox capability only after live isolation evidence.

### ADR 0556 — Production Metrics, Workload Identity and Assurance Operations

Artifact: `docs/adr/0556-production-metrics-workload-identity-and-assurance-operations.md`

Required work:

- Instrument execution, dispatch, compensation, interop, authentication,
  storage, and recovery seams.
- Define measurable SLIs and SLOs.
- Add alert thresholds and operator runbooks.
- Build an RBAC-protected operations projection.
- Implement sender-constrained workload identity.
- Add delegation-chain and confused-deputy tests.
- Add mTLS/SPIFFE or DPoP adapters where configured.
- Bind deployment attestations to telemetry and runtime discovery.
- Include SLO evidence in release qualification.

## New ADRs to author

The identifiers below are provisional. Allocate the next free number after
fetching `origin/main`.

### Proposed ADR 0580 — Protected Delivery Control Plane and Bounded CI

Why a new ADR is required: ADR 0550 covers conformance and attestation, but the
current hosted delivery control plane is disabled, the backend workflow orders
typecheck before dependency installation, recent pull requests have no status
checks, `main` is unprotected, and local test fan-out has exhausted workstation
memory and swap.

Decisions:

- Protect `main` and require hosted checks.
- Re-enable the `CI` workflow.
- Run `npm ci` before dependency-dependent commands.
- Require backend typecheck/build/tests, frontend canonical build,
  conformance, production dependency audit, contract parity, and provenance.
- Set explicit worker, heap, timeout, process-count, and artifact limits.
- Use bounded Vitest workers and isolate heavy suites into serial or separately
  provisioned jobs.
- Detect and refuse duplicate concurrent full-suite executions in one
  workspace.
- Attribute worker heap crashes to the responsible test file.
- Upload diagnostic artifacts without secrets.
- Require agents to inspect live processes before relaunching an interrupted
  test run.

Acceptance criteria:

- A deliberately failing check blocks a test pull request.
- The branch-protection API confirms enforcement.
- A clean Node 22 runner succeeds from an empty dependency directory.
- Peak memory and process count remain within documented budgets.
- No CI command can create unbounded worker fan-out.

### Proposed ADR 0581 — Dependency and Untrusted Document-Ingestion Security

Why a new ADR is required: the audit found High-severity production dependency
chains in backend document parsing and frontend rendering.

Decisions:

- Upgrade or replace vulnerable `officeparser`, `pdfjs-dist`, `pptxgenjs`,
  `image-size`, React Router, Mermaid, and DOMPurify chains.
- Move untrusted document extraction into a constrained worker.
- Apply byte, page, object-count, decompression, recursion, CPU, memory, and
  timeout limits.
- Disable embedded script execution.
- Sanitize Mermaid source before rendering even when the renderer is inside a
  sandboxed iframe.
- Gate production dependency audits with expiring, owner-attributed exceptions.
- Generate and attest an SBOM for releases.

Acceptance criteria:

- No unwaived Critical or High production advisory.
- Malicious PPTX, PDF, image, and Mermaid fixtures cannot execute code or
  exhaust resources.
- Every exception records owner, rationale, affected path, mitigation, and
  expiry.

### Proposed ADR 0582 — Atomic Run Admission and Idempotent Creation

Why a new ADR is required: the current durable claim is tenant- and
endpoint-scoped, but a process can still fail after creating a run and before
committing the idempotent response.

Decision:

- Commit the idempotency record, run record, and dispatch-outbox item in one
  storage transaction; or introduce an equally strong stable admission
  identity that recovers the original run without creating another.
- Never use a process-local map for reconciliation.
- Ensure lease reclaim returns the already admitted run.
- Preserve wire-visible random run IDs unless a protocol RFC explicitly
  changes them.

Acceptance criteria:

- Crash at every statement boundary produces at most one logical run.
- Every retry returns the same admitted run.
- SQLite and PostgreSQL behave identically.
- No stale claimant can enqueue execution.

### Proposed ADR 0583 — Continuous Protocol Freshness and Contract Vendoring

Decisions:

- Automate conformance-package and schema freshness checks.
- Record the exact upstream protocol commit used by the app.
- Fail when vendored schemas, fixtures, packs, SDK, and conformance suite do
  not agree.
- Open automated upgrade pull requests.
- Require protocol-delta and compatibility classification before merge.
- Publish tested protocol and profile versions in build metadata.

Acceptance criteria:

- The current suite-version lag is visible and governed by a defined freshness
  window.
- A stale schema, fixture, or expansion mirror fails CI.
- Upgrade pull requests include focused conformance evidence.

### Proposed ADR 0584 — Independent Runtime Qualification Environment

Decisions:

- Create a production-shaped qualification environment separate from unit-test
  seams.
- Use real PostgreSQL, multiple app instances, queue workers, object storage,
  an identity issuer, and a telemetry collector.
- Run crash, restart, duplicate-delivery, network-partition, stale-worker, and
  region-failover tests.
- Capture signed evidence for RFCs 0159, 0160, and 0162.
- Prohibit test-only routes and seams from counting as deployed-wire evidence.

Acceptance criteria:

- Every advertised production profile has a live black-box witness.
- Qualification reproduces from a clean revision.
- Evidence is tied to the deployed image digest and exact discovery document.

### Proposed ADR 0585 — External Security Audit and Remediation Program

Decisions:

- Scope the audit across authentication, tenant isolation, pack execution,
  document ingestion, MCP, A2A, compensation, replay, storage, deployment, and
  supply chain.
- Freeze affected claims during unresolved Critical or High findings.
- Track remediation and independent retest evidence.
- Publish a redacted report and machine-readable findings state.
- Schedule annual follow-up and post-critical-change reviews.

Acceptance criteria:

- Independent audit completed.
- Zero open Critical or High findings.
- Medium findings are remediated or carry approved time bounds.
- Regression tests cover every remediated issue.

# Part III — Gap-to-artifact ownership matrix

| Gap | Protocol owner | App owner | Required evidence |
|---|---|---|---|
| Vacuous or weak certification evidence | RFC 0148, RFC 0160 | ADR 0550, ADR 0580 | signed requirement-level bundle |
| Contract/example drift | RFC 0149, RFC 0164 | ADR 0583 | machine parity gate |
| Idempotent admission crash window | RFC 0150 | ADR 0549, ADR 0582 | crash-at-boundary SQLite/Postgres tests |
| Retry-stable effect identity | RFC 0150 | ADR 0549 | cross-language vectors and live effect tests |
| Multi-instance durability | RFC 0162 | ADR 0551, ADR 0584 | two-instance chaos evidence |
| Multi-region effect safety | RFC 0159, RFC 0162 | ADR 0551, ADR 0584 | partition and stale-owner witness |
| Compensation trigger over-claim | RFC 0158 | ADR 0554 | one non-vacuous test per advertised trigger |
| Operator recovery portability | RFC 0151, RFC 0158 | ADR 0554 | authenticated black-box recovery tests |
| Chain compensation drift | RFC 0157 | ADR 0554, ADR 0583 | live expansion and mirror parity |
| Current A2A interoperability | RFC 0152, RFC 0163 | ADR 0552 | official-peer CI evidence |
| Current MCP interoperability | RFC 0153, RFC 0163 | ADR 0553 | official-peer CI evidence |
| Workload identity and delegation | RFC 0154 | ADR 0556 | live sender-constrained identity tests |
| Pack provenance | RFC 0154, RFC 0160 | ADR 0550, ADR 0555 | signed pack and release attestations |
| Untrusted pack isolation | Existing sandbox RFCs and invariants | ADR 0555 | process/network/filesystem escape suite |
| Vulnerable production dependencies | Security policy and RFC 0156 claims gate | ADR 0581 | green production audit plus malicious fixtures |
| Capability typo/ghost risk | RFC 0155, RFC 0161 | ADR 0583 | v1 lint and v2 closed-schema tests |
| SLO and operations maturity | RFC 0162 | ADR 0556 | telemetry, alerts, runbooks, recovery exercise |
| Disabled CI and unprotected merges | RFC 0156 claims policy | ADR 0550, ADR 0580 | protected-branch sabotage PR |
| Test memory exhaustion | No wire change | ADR 0580 | bounded peak-memory qualification |
| External security assurance | RFC 0156 | ADR 0585 | completed independent audit |
| Independent governance | RFC 0156 | No app ADR can substitute | two independent maintainers |
| Independent implementation | RFC 0155, RFC 0156, RFC 0163 | ADR 0584 supplies Tier-1 evidence only | Tier-3 host bundle |

# Part IV — Delivery sequence and hard gates

## Phase 0 — Restore trustworthy delivery

Artifacts:

- ADR 0580
- ADR 0550
- RFC 0148
- RFC 0160

Hard gate:

- Hosted CI is enabled and required.
- A failing check blocks merge.
- Test execution stays within resource limits.
- Certification cannot report a vacuous pass.

## Phase 1 — Close immediate security and correctness exposure

Artifacts:

- ADR 0581
- ADR 0582
- ADR 0549
- RFC 0150

Hard gate:

- No unwaived Critical/High production dependency advisory.
- Run admission is atomic across crash boundaries.
- Retry and effect identities pass cross-language vectors.

## Phase 2 — Complete compensation and durable execution

Artifacts:

- RFC 0151
- RFC 0157
- RFC 0158
- RFC 0159
- RFC 0162
- ADR 0551
- ADR 0554

Hard gate:

- Every advertised compensation trigger executes.
- Multi-instance crash recovery is green.
- Multi-region remains unadvertised until fenced-effect partition evidence is
  green.

## Phase 3 — Complete current interoperability

Artifacts:

- RFC 0152
- RFC 0153
- RFC 0163
- ADR 0552
- ADR 0553

Hard gate:

- Current A2A and MCP profiles pass against official upstream peers.
- Legacy profiles are inventoried and time-bounded.
- Restart-sensitive interop state is durable wherever advertised.

## Phase 4 — Complete isolation, identity, and operations

Artifacts:

- RFC 0154
- ADR 0555
- ADR 0556

Hard gate:

- Untrusted pack execution is isolated across process, filesystem, environment,
  network, CPU, memory, and time.
- Workload identity is sender constrained.
- Critical SLOs, alerts, and recovery runbooks are exercised.

## Phase 5 — Remove specification and lifecycle ambiguity

Artifacts:

- RFC 0149
- RFC 0155
- RFC 0161
- RFC 0164
- ADR 0583

Hard gate:

- Zero known normative example or lifecycle contradictions.
- Every capability family is canonical, registered, or explicitly namespaced.
- App vendored contracts match the exact protocol release it claims.

## Phase 6 — Produce independent assurance

Artifacts and external work:

- RFC 0156
- ADR 0584
- ADR 0585
- independent maintainers
- Tier-3 implementation
- external security audit
- signed certification and release evidence

Hard gate:

- No open Critical/High audit finding.
- Two independent maintainers participate in governance.
- At least one Tier-3 host passes core-standard and one current interop profile.
- A new independent assessment assigns A or A+ to every category.

# Part V — Artifact completion template

Every RFC and ADR in this program should include the following sections or an
equivalent machine-readable record.

## Decision record

- Single owner and affected architectural seams.
- Invariants being protected.
- Wire impact and compatibility classification.
- Alternatives considered.
- Security and tenant-isolation impact.
- Replay, fork, idempotency, durability, and failure-mode impact.
- Migration and rollback strategy.

## Implementation record

- Phase-to-commit mapping.
- Exact files and packages changed.
- Schema, OpenAPI, AsyncAPI, SDK, discovery, and documentation effects.
- Reference-host adoption.
- Deferred items with an owner and reason.

## Verification record

- Commands and runtime versions.
- Worker and memory limits.
- Positive, negative, concurrency, crash, and sabotage tests.
- Storage adapters exercised.
- Evidence level achieved.
- Artifact and revision digests.
- Known limits and external gates.

## Claim record

- Profiles actually advertised.
- Profiles explicitly not advertised.
- Evidence supporting each profile.
- Evidence expiry and supersession.
- Public statements updated or prohibited.

# Part VI — Work that documents cannot complete

The following are essential A+ work items but cannot be satisfied by writing or
accepting another RFC or ADR:

- Re-enable GitHub Actions and configure branch protection.
- Upgrade vulnerable dependencies and verify real exploit paths.
- Implement and operate the compensation triggers.
- Build the untrusted-pack host-call broker and network sandbox.
- Run multi-instance and multi-region chaos tests.
- Integrate official MCP and A2A peers.
- Publish signed release and certification attestations.
- Commission and complete the external security audit.
- Recruit and appoint independent maintainers.
- Recruit an independent Tier-3 host.
- Re-run the complete assessment after all evidence is current.

## Final release and claims gate

No OpenWOP or openwop-app surface may claim A+, “best in class,” “industry
standard,” “production-grade multi-region,” “secure sandbox,” “current MCP,”
“current A2A,” or “independently validated” unless the assurance manifest can
derive that exact claim from unexpired evidence.

The final A+ decision must be reproducible from a clean checkout and must bind
the following facts together:

1. source revision;
2. built artifact or image digest;
3. protocol and SDK versions;
4. schema and profile-manifest digests;
5. discovery-document digest;
6. conformance-suite version;
7. required-profile execution witnesses;
8. official-peer results;
9. multi-instance and multi-region qualification results;
10. dependency and security-audit state;
11. governance and Tier-3 evidence; and
12. the exact public claims those facts permit.

That evidence—not the number of accepted RFCs or ADRs—is the final measure of
completion.

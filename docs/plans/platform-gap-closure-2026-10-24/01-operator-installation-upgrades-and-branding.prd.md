# Section 01: Operator installation, upgrades and complete branding

Status: Proposed — planning complete for review; no implementation, qualification or approval implied.

| Field | Value |
|---|---|
| Kind | Host product/engineering requirements; /prd five-pass method |
| Date | 2026-10-24 |
| Audit IDs | OPS-01, OPS-02, OPS-04, BRAND-01 |
| Proposed accountable role | Release engineering / operator experience; staffing unconfirmed |
| Dependencies | None; safe to start independently |
| Effort | L; relative scope only, not elapsed schedule |
| Decision records | Existing ADRs in References; umbrella ADR 0970 |
| Companions | [01-operator-installation-upgrades-and-branding.gaps.md](01-operator-installation-upgrades-and-branding.gaps.md) · [01-operator-installation-upgrades-and-branding.risks.md](01-operator-installation-upgrades-and-branding.risks.md) |
| Program | [Master plan](README.md) · [Coverage](coverage.json) |

## Summary

Make every shipped installation and upgrade recipe executable, mechanically consistent and complete across runtime branding, initial HTML, auth and native shells. Qualify all advertised deployment packs in dependency order, retaining an explicit support matrix until each passes.

## Motivation

The audit directly observed retired Stripe setup writes in `README.md:519,540`, `releases.json:107,118` contradicting required-stop guidance, and a partial Compose build-arg surface. Runtime Appearance already exists (`frontend/react/src/brand/AppearancePanel.tsx`); the current adopter guide is **frontend/react/WHITE-LABEL.md**, not a repository-root file. Six deploy packs are documented, but this pass has no fresh-install qualification for them. ADR 0052 already owns version and migration mechanics; `scripts/preflight-deploy.sh` already owns deploy freshness. These are extensions and corrections, not a second installer or migrator.

## Proposal

Requirements use **shall** for this host plan; uppercase RFC 2119 obligations exist only in the upstream Draft RFC. No requirement is a statement that code already implements it.

- **S01-R1 (OPS-01)** — Inventory current operator commands against the real route/major negotiator; replace retired write examples and add a disposable setup witness for BYOK, plan config and signed Stripe test webhook. Derive expected methods/paths from mounted route behavior, not a second handwritten catalog.

- **S01-R2 (OPS-02)** — Add explicit release compatibility data separating stop-old-binary, required intermediate version, backup prerequisite and incompatible schema/app migration. Correct the 0.2.0 contradiction with an audit note; do not change immutable released bytes. Validate all supported source→target paths and prevent an old binary running against incompatible schema.

- **S01-R3 (BRAND-01)** — Document and validate runtime Appearance versus build-time HTML/auth/email/native settings. Generate/validate allowed Compose build variables; unsupported variables fail with a useful message. Preserve the single BrandProvider/systemBrand authority and check first paint before public identity fetch, login, title/favicon, email and native-shell identity.

- **S01-R4 (OPS-04)** — Qualify Compose, Fly, Render, AWS, Azure and GCP from an extracted versioned bundle on empty infrastructure, including sign-in, durable state, media, configured test provider, TLS and streaming. Keep every tier in the matrix; sequencing one first does not close the rest.

- **S01-R5 (OPS-02)** — Exercise fresh install, adjacent upgrade, skipped-version upgrade, interrupted migration, parallel start and safe retry on SQLite where supported and real Postgres. Recovery is a coherent backup restore, not down-migration; section 06 qualifies the actual restore.

- **S01-R6 (OPS-01)** — Reconcile factual current-state drift in FEATURES/ROADMAP with implemented ADR evidence, including 0549 and 0551, without rewriting historical rationale or declaring unfinished qualification complete.

### Five architect passes

| Pass | Finding / decision |
|---|---|
| Specification | Separate evaluation defaults, production requirements and version compatibility. Every supported recipe has a verified source→target path and explicit failure/recovery behavior. |
| Schema | Extend release metadata additively and validate old entries; derive operator config from existing env/branding keys. Keep runtime brand overrides and secrets in existing stores. |
| Security | No plaintext key echoes, shell history examples containing real secrets, embedded upstream env files or client-only auth claims. Native host pinning complements backend auth. |
| Conformance | Execute the extracted artifact; assert signed-in role behavior, public HTML branding, SSE and persistence after restart. Check recipe status against exact artifact and tier. |
| Compatibility | Retired v1 writes are corrected to the current negotiated/unversioned host route. New release metadata must not make an older installer silently skip maintenance. |

### Proposed data and interface impact

Extend existing `releases.json`/version machinery with reviewed compatibility metadata (exact fields finalized with ADR 0052 owner); no new schema counter. Build a host-local deployment qualification record keyed by artifact digest, tier and config digest; store redacted outcomes in the existing release evidence lane. No new public wire capability or secret-bearing config export.

## Compatibility

Host-only. No upstream RFC is required for editorial setup fixes, install scripts, branding settings or release metadata. Preserve current v2 protocol and host-extension routing; adding a public readiness contract would require a separate wire review. Release metadata correction gets an explicit dated note; old artifact digests remain unchanged.

## Conformance

The observable and the actor able to cause the condition are separate. A mock, code search or manifest cannot substitute for the stated executable witness.

| Scenario | Observable / acceptance | Who can cause it | Proof scope |
|---|---|---|---|
| S01-T1 | Disposable operator can follow Stripe/BYOK examples without a 410; stored ref resolves and signed test webhook is acknowledged | Fixture operator on isolated app | HTTP boundary; fake credentials/test mode only |
| S01-T2 | Planner requires old binary stop for the known 0.1→0.2 incompatibility and every crossing path | Release-engineering fixture | Metadata + real supported DB migrations |
| S01-T3 | Correct brand before/after identity fetch and in dark/mobile/email/native surfaces | Browser + shell build fixture | DOM/screenshot/asset checks; native builds where toolchain exists |
| S01-T4 | Each of six extracted-bundle tier records shows install/auth/restart/SSE outcome | Provisioned test operator | Real infrastructure; unavailable account is blocked, not passed |

## Alternatives considered

- Do nothing: retains reproducible setup/metadata defects; rejected.
- Add a separate installer/migrator/branding store: duplicates ADR 0052 and Appearance; rejected.
- Use existing owners and a generated tier/config matrix: chosen; higher qualification effort but one operating contract.

## Unresolved questions

1. Which historical release paths are contractually supported? Resolution: Enumerate published artifacts and migration reachability; approve explicit matrix. Owner: Release owner. Blocks: upgrade planner implementation.
2. Which six test accounts/regions and native signing toolchains are available? Resolution: Provision isolated fixtures and budget; mark unavailable tier blocked. Owner: Infrastructure owner. Blocks: per-tier qualification.
3. What settings are runtime-safe versus rebuild/maintenance only? Resolution: Trace each current consumer and approve field matrix. Owner: Brand/auth owners. Blocks: config handoff.

## Implementation notes (non-normative)

| Order | Concrete work / existing owner | Deliverable / verification |
|---|---|---|
| 1 | README/WHITE-LABEL/deploy pack inventory and real route fixtures | Current-command manifest + failing examples reproduced |
| 2 | Existing release tooling, releases.json and migration-integrity checks | Validated path planner + dated correction; migration witnesses |
| 3 | Appearance/Compose/native config handoff | Supported setting matrix + first-paint/theme checks |
| 4 | Existing stripped-bundle smoke and six deploy packs | Per-tier install/upgrade evidence; section 06 restore dependency |

Sequence schema/atomic persistence before consumers; deploy compatible backend before frontend. For incompatible data changes use an explicit drain/maintenance boundary and a coherent restore, never a blind old-binary rollback. Reuse local CI/merge train; no global shipping freeze or cross-session lock.

## Acceptance criteria

- [ ] All four original IDs have passing source-specific evidence; documentation alone closes only documentary defects.
- [ ] Six deployment tiers each have passed or explicit blocked records; no tier inherits another tier’s success.
- [ ] Canonical frontend build and backend affected tests pass when those implementations change; relevant deploy-gate harness/migration checks pass.
- [ ] Attach exact SHA/artifact/config, executed/failed/skipped/blocked dispositions, operator/reviewer and timestamp to each closure record; regrade only the demonstrated scope.
- [ ] Update original IDs OPS-01, OPS-02, OPS-04, BRAND-01 with implementation and evidence links; do not check off because this PRD exists.

## References

- [ADR 0052](../../adr/0052-versioned-app-releases-and-migrations.md)
- [Adopter branding guide](../../../frontend/react/WHITE-LABEL.md)
- [Deploy packs](../../../deploy/README.md)
- [Audit](../../research/platform-gap-analysis-2026-10-24.md)

## GO / NO-GO

**GO for proposed host-plan review. CONDITIONAL for implementation:** resolve the blocking companion questions, accept any new architectural decision, and satisfy any upstream RFC gate first. This is not an Accepted protocol RFC or a production release decision.

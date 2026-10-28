# Section 02: Secure deployment profiles and independent assurance

Status: Proposed — planning complete for review; no implementation, qualification or approval implied.

| Field | Value |
|---|---|
| Kind | Host product/engineering requirements; /prd five-pass method |
| Date | 2026-10-24 |
| Audit IDs | SEC-01, SEC-02 |
| Proposed accountable role | Security / identity engineering; staffing unconfirmed |
| Dependencies | 01 |
| Effort | L; relative scope only, not elapsed schedule |
| Decision records | Existing ADRs in References; umbrella ADR 0970 |
| Companions | [02-secure-profiles-and-independent-assurance.gaps.md](02-secure-profiles-and-independent-assurance.gaps.md) · [02-secure-profiles-and-independent-assurance.risks.md](02-secure-profiles-and-independent-assurance.risks.md) |
| Program | [Master plan](README.md) · [Coverage](coverage.json) |

## Summary

Define enforceable, versioned secure host profiles and prove each authority boundary across every invocation lane. Obtain scoped independent assurance and resolve findings without equating self-attestation or passing unit tests with certification.

## Motivation

`host/protocolAuthorization.ts:53` enables protocol membership enforcement only for an exact true flag; `host/deployPosture.ts` checks production mode and durable storage but does not itself enforce that flag. Tenant run ownership still holds (`host/runAccess.ts:106`). KMS, MFA and egress controls exist; ADR 0969 already makes superadmin writes require MFA. ADR 0555 contains implemented isolation work and remaining network/broker evidence questions, so neither assume no sandbox nor assume every adapter contains hostile code. An independent audit, dependency audit and production configuration were not verified in the assessment.

### Current dependency alert evidence added at final verification

GitHub REST API reported **28 open default-branch alerts: 4 high, 18 medium and 6 low** on 2026-10-24. This independently confirms outstanding advisory/manifest matches; runtime reachability and deployed exposure remain unverified. The [complete reported inventory](dependency-alerts.json) is tracked under SEC-02, not 28 newly proven exploits.

| High alert | Package / manifest | Provider scope | Reported first patched version | Required focused qualification |
| --- | --- | --- | --- | --- |
| [223](https://github.com/openwop/openwop-app/security/dependabot/223) | zod / clients/copilot-provider/package-lock.json | runtime |4.6.6 | Copilot-provider parsing/schema and real request/error behavior |
| [222](https://github.com/openwop/openwop-app/security/dependabot/222) | @azure/msal-node / backend/typescript/package-lock.json | runtime |7.1.0 | Microsoft OAuth/token/cache/refresh/revocation and compatibility; do not blind major-upgrade |
| [206](https://github.com/openwop/openwop-app/security/dependabot/206) | vite / frontend/react/package-lock.json | development |7.3.7 | Canonical frontend build, dev-server exposure and browser lane |
| [197](https://github.com/openwop/openwop-app/security/dependabot/197) | vite / backend/typescript/package-lock.json | development |8.2.4 | Backend test tooling/dev-server exposure and affected suite |

Versions above are advisory-provided patch floors, not guaranteed compatible dependency choices or executed upgrades. Recheck the advisory, current lock resolution and exploit preconditions at implementation; fix all 28 matches or record a justified scoped disposition with re-evaluation, never dismiss by severity/count alone. Prioritize the two runtime highs and any reachable exposed tooling before new feature work. Medium/low alerts include nodemailer, fast-uri and @vitest/mocker across backend/frontend/desktop; all stay in the inventory.

## Proposal

Requirements use **shall** for this host plan; uppercase RFC 2119 obligations exist only in the upstream Draft RFC. No requirement is a statement that code already implements it.

- **S02-R1 (SEC-01)** — Extend existing startup/preflight owners with a reviewed strict production profile: authenticated identity, expected membership authorization, durable control/surface stores, persistent BYOK protection, Secure cookies/TLS, superadmin MFA and withdrawn test/dev entry points. Retain an explicitly named evaluation profile; existing operators get a documented migration, not silent lockout.

- **S02-R2 (SEC-01)** — Generate a route/tool/node/schedule/trigger/MCP/stream permission matrix from existing registries. Exercise owner/admin/editor/viewer, revoked member, API key, delegated identity, anonymous, same-tenant other workspace and foreign tenant; assert authority at the server entry and service boundaries, including plan/toggle denials.

- **S02-R3 (SEC-02)** — Inventory executable pack trust tiers and actual isolation adapters. Falsify filesystem/network/resource/credential boundaries from inside the deployed worker; fix any enforcement gap before the corresponding untrusted-execution claim. Signatures prove provenance, not containment.

- **S02-R4 (SEC-02)** — Triage every row in dependency-alerts.json, prioritize the four reported highs, then produce complete dependency/SBOM/license/provenance and vulnerability evidence for backend, frontend, deploy images and shipped desktop/iOS shells. Triage reachable findings with exploitability and remediation/retest records; review secret canaries across errors, telemetry, streams, exports and backups.

- **S02-R5 (SEC-02)** — Prepare and commission independent assessment of auth, tenancy, BYOK, egress, pack execution, AI/tool injection and money paths. Close critical/high exploitable findings and retest; distinguish audited control scope from certification and publish approved redacted summary.

### Five architect passes

| Pass | Finding / decision |
|---|---|
| Specification | Map minimum production controls to existing deployPosture/auth/RBAC/MFA owners; do not equate auth with tenant or role authorization. |
| Schema | Add profile configuration only after consumer inventory; keep secret values out of manifests. No second role/scope/credential schema. |
| Security | Apply auth-profile, secret-leakage, node-pack, prompt-injection and provider-policy threat models; test confused deputy, revocation, hostile egress and untrusted worker escape. |
| Conformance | Use HTTP/createApp + real cookie/token fixtures and real isolated-worker adversarial probes; repeat independent findings against fixed artifact. |
| Compatibility | Default changes are explicit operator-profile migration; no protocol permission/error semantic is redefined. New protocol obligations require upstream review. |

### Proposed data and interface impact

Profile is operator configuration and validated startup policy, not a new tenant-owned auth model. Extend existing security audit/Operations projections; use opaque subjects/ref fingerprints, never raw credentials. Assessment records link artifacts by digest; confidential findings live in the existing private security process, not public issue text.

## Compatibility

Host profile change; no new wire field required. Preserve canonical v2 errors and current isolation semantics. Requiring stronger operator configuration is a deploy-profile transition with diagnostics and break-glass/recovery review, not a stealth globally default-on protocol authorization change.

## Conformance

The observable and the actor able to cause the condition are separate. A mock, code search or manifest cannot substitute for the stated executable witness.

| Scenario | Observable / acceptance | Who can cause it | Proof scope |
|---|---|---|---|
| S02-T1 | Strict profile rejects each missing required control, evaluation remains clearly labeled | Operator config fixture | Startup/integration, no real secrets |
| S02-T2 | Complete role × tenant × entry-lane denials and authorized operations are observed | Isolated signed-in tenants + API keys | HTTP/tool/executor boundary; unit auth mocks insufficient |
| S02-T3 | Hostile worker cannot access forbidden files/network or exceed declared resources | Controlled malicious test pack | Actual production worker image and adapter |
| S02-T4 | Independent findings have affected artifact, fix and successful retest | Independent assessor | External evidence; procurement/access pending |

## Alternatives considered

- Do nothing: configuration ambiguity and assurance gaps remain.
- Create new auth/security feature toggle: rejected; core safety cannot vary by product entitlement.
- Extend existing profile and audit seams: chosen, with compatibility review and independent qualification.

## Unresolved questions

1. Which controls are mandatory in each supported production tier? Resolution: Approve minimum-control matrix and migration policy. Owner: Security + infrastructure owners. Blocks: strict-profile rollout.
2. Which assessor, budget, confidential scope and retest capacity are approved? Resolution: Commission scoped engagement; do not fabricate certification. Owner: David Tufts / security sponsor. Blocks: SEC-02 independent closure.
3. Which isolation adapter claims are actually enabled in each released image? Resolution: Read advert/config and perform containment probes. Owner: Runtime security owner. Blocks: untrusted pack claim.

## Implementation notes (non-normative)

| Order | Concrete work / existing owner | Deliverable / verification |
|---|---|---|
| 1 | Existing deployPosture/protocolAuthorization/securityAudit | Versioned profile + migration and no-lockout tests |
| 2 | Route/feature/tool/worker registries | Complete permission matrix + negative HTTP witnesses |
| 3 | Pack loaders/isolation and release dependencies | Adversarial containment + dependency/provenance remediation |
| 4 | Independent assessor + security process | Report, fixes, retest and scoped public statement |

Sequence schema/atomic persistence before consumers; deploy compatible backend before frontend. For incompatible data changes use an explicit drain/maintenance boundary and a coherent restore, never a blind old-binary rollback. Reuse local CI/merge train; no global shipping freeze or cross-session lock.

## Acceptance criteria

- [ ] Strict profile and full authority matrix pass in supported deployment tiers.
- [ ] No open critical/high exploitable finding is silently waived; any residual acceptance is named, time-bounded and reflected in supported claims.
- [ ] Independent report/retest is obtained; an internal checklist does not close SEC-02.
- [ ] Attach exact SHA/artifact/config, executed/failed/skipped/blocked dispositions, operator/reviewer and timestamp to each closure record; regrade only the demonstrated scope.
- [ ] Update original IDs SEC-01, SEC-02 with implementation and evidence links; do not check off because this PRD exists.

## References

- [Architecture contract](../../../ARCHITECTURE.md)
- [MFA decision](../../adr/0969-superadmin-requires-mfa.md)
- [Isolation decision](../../adr/0555-untrusted-pack-trust-tier-and-isolated-execution.md)
- [Engineering evidence](../../research/platform-audit-2026-10-24/engineering.md)

## GO / NO-GO

**GO for proposed host-plan review. CONDITIONAL for implementation:** resolve the blocking companion questions, accept any new architectural decision, and satisfy any upstream RFC gate first. This is not an Accepted protocol RFC or a production release decision.

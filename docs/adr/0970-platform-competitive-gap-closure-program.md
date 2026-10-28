# ADR 0970 — Platform competitive gap-closure program

Status: Accepted — Wave A merged (A1–A5, 2026-10-25); Waves B–E not started. The user directed implementation of this plan on 2026-10-24, starting with Wave A's concrete defects. That acceptance covers the umbrella plan and the Wave A fixes only: each later section's data, profile and adapter choices still need their own accepted decision before coding (checklist below), RFC 0250 is governed in `openwop` and is not accepted by this ADR, and no gap is closed or grade raised except by its recorded witness.

Date: 2026-10-24. Companion: [complete section plan](../plans/platform-gap-closure-2026-10-24/README.md), [dated audit](../research/platform-gap-analysis-2026-10-24.md). Source snapshot: 87719df6f; audit commit: f4f016704.

## Context and factual corrections

The audit identifies 28 remediation/evidence gaps across 31 categories, with 8 live checklists. It mechanically inventories 128 backend and 101 frontend feature directories but does not prove their full behavior. Existing ADR 0548–0556 readiness work already supplies many primitives and has open operational qualifications; it is not all Proposed merely because old FEATURES/ROADMAP tables say so. This decision coordinates the additional competitive/operator program and maps unfinished work into existing owners instead of replacing the earlier readiness program.

Examples of current reuse: runtime Appearance; run/outbox/idempotency; durable workspace gating; OTel/Operations; tenant-aware persistence/erasure; workflow environment pins; sharedRateLimit and planRunLimit; signed installer/packTrust; one Stripe client/webhook rail; AppDoc/chassis/export lineage; existing chat/evals/chain-stack executor. Relevant source and current ADR phases are cited in each of 12 PRDs. New known defects include setup examples, upgrade metadata and Brand first-load failure; other findings are confirmed limits, configuration risks or unverified claims, not interchangeable defect classes.

## Decision

Adopt the complete proposed 12-section plan with 69 requirements and explicit conformance/compatibility/security design. Preserve all 28 original IDs, all 8 live-check IDs, all 31 categories and all 229 feature-directory rows. Plan completion means requirements/traceability exist; product completion means actual remediation plus the required evidence. No letter grade is raised by this ADR.

The plan is **an extension of current feature and core seams**. It adds no competing identity, chat, workflow, billing, registry or database owner. Durable run admission and persistent host-event replay belong in current run/Storage/event owners. Review and accept their detailed data/atomicity decisions before coding; this proposed umbrella does not silently accept every open design choice.

### Boundaries audit / architecture-contract mapping

| Program section | Existing owner / architecture seam | New decision or required extension |
| --- | --- | --- |
|01 operator/release/branding | ADR 0052 version/migrations, deploy packs, Appearance/BrandProvider | Correct recipes/compatibility metadata; complete config/qualification matrix |
|02 secure profile/assurance | deployPosture, protocolAuthorization, identity/KMS/egress/securityAudit; ADR 0969/0555 | Explicit production profile and independent assessment; no second auth system |
|03 admission | rateLimit, sharedRateLimit ADR 0934, planRunLimit ADR 0821, Storage/run/outbox | Atomic durable admission and all-lane/state policy, retaining cheap traffic shedding |
|04 events | host event dispatcher/stream, Storage/pubsub, RFC 0236/0247 | Persistent refs/replay; optional strict contract needs accepted RFC 0250 |
|05 data lifecycle | DurableCollection/Storage, tenantOpLock and actual seed/CRM callers, erasers/lifecycle | Per-invariant transaction/fencing and complete ownership census |
|06 qualification/recovery | CI/release/attestation, Operations/metrics; ADR 0550/0551/0556 | Exact-artifact fault/load/restore/independent/elapsed evidence |
|07 experience | Shared ui/announcer/nav/preferences/tokens/i18n | Finite failure/retry, authenticated AT/mobile/theme/native-language and task witnesses |
|08 app builder | ADR 0342–0349, AppDoc/preview/generators/lineage/publish/sync | Functional parity and secure backend/deploy; amend scoped deployment decision first |
|09 AI/integrations | Single chat/evals/LLM boundaries, Connections/provider packs/broker | All supported operation/model outcomes and ongoing qualification |
|10 marketplace/commerce/DX | Registry/installer/packTrust/marketplace, billing/Connect/obligation ledger | Complete publisher/update/revocation/money/reseller journeys |
|11 all domain families/debt | Current feature registries/services/ADRs/manual tests/steward ledgers |229-row deep-qualification and full candidate classification; new gaps refined, not omitted |
|12 support/economics/adoption | Existing operator docs/usage/billing and actual commercial/support owners | Staffed commitments and independently attributable measured outcomes |

No new route namespace is claimed here. Implementation inventories existing ordered ROUTE_MODULES before adding/altering a route; public host routes use current negotiated/unversioned spelling, not historical `/v1` examples. Any new host-local state has one owner, tenant index/authority, erasure/retention rule, atomicity/fencing strategy and migration/recovery policy.

### Feature evaluation matrix

| Dimension | Program policy |
| --- | --- |
| Feature-package | Existing owning packages; net-new discovered domain feature requires its own refined Proposed ADR, never a generic platform mega-feature |
| Toggle/admin UI | Stable existing toggles; core auth/tenant/money safety never A/B-gated; qualify OFF/BETA in disposable fixture; new product capability defaults off where appropriate |
| Workflow surface | Extend current ctx.features owner only when real product operations change; host evidence/scripts are not workflow capabilities |
| Node packs | Existing typed surface + signed pack/loader; operation coverage and old-run pins maintained; no pretend node for a documentary policy |
| AI chat/envelopes | Existing single chat/EmbeddedChatPanel, generated schema grounding and validated output; no parallel assistant |
| Agent packs | Reuse existing agents; add only a real role/tool permission need, not one agent per audit section |
| Public surface | Existing auth/scopes, tenant derived from resource, safe errors/abuse limits; no new unauthenticated test backdoor |
| RBAC/isolation | Full protocol/feature/tool/node/schedule/key/tenant/role matrix; backend authority and fail-closed sensitive mutations |
| Replay/fork | Recorded choices and effect IDs retained; no recomputed historical provider/variant/approval bindings; durable reservations/events do not become a second run log |
| Frontend | Shared primitives/tokens/i18n and existing registries/nav; designed failure/recovery, theme/mobile and AT verification |

## Protocol verdict

Eleven sections are primarily host-only and do not justify protocol RFCs merely by using /prd. Existing accepted contracts cover their wire-facing use. Section04's storage/large-event repair also needs no new contract. **Explicit interoperable strict replay/resync does:** [RFC 0250 Draft](https://github.com/openwop/openwop/blob/97def7cf585e2c4f8b428b689a55bd3d5b8412cc/RFCS/0250-opt-in-host-event-replay-and-resync.md), written against current v2/core/facet/error owners in an isolated spec worktree, with gap/risk registers under RFCS/registers. It remains Draft; no advertisement/public error until accepted under governance and the app's RFC gate. New wire discoveries elsewhere require their own accepted RFC; this ADR does not pre-authorize them.

## Alternatives considered

1. Replace the platform with independent new services: duplicates ownership and compounds auth/replay/money risk; rejected.
2. Limit the work to the first commercial bundle or known defects: useful execution order, insufficient to close the user's all-gap scope; rejected as program scope.
3. Raise grades from documentation/internal test counts: rejected; does not prove outside behavior or independent/elapsed outcomes.
4. Extend current owners and close all gaps in evidence-gated waves: chosen. Trade-off is explicit long-running human/infrastructure dependencies and honest U grades until measured.

## Phased plan / verification

| Phase | Scope | Gate |
| --- | --- | --- |
| A | Current setup/upgrade/Brand defects; branding handoff; accepted design decisions | Reproduced behavior, focused corrections, affected canonical checks |
| B | Secure profiles, shared admission, event internal repair, data fencing | Real DB/multi-process negative/fault witnesses and compatible migration |
| C | Supported install→upgrade→restore, crash/effect/load/failover | Exact artifact/config and measured results; start elapsed SLI observation |
| D | UX/locales, functional generated apps, qualified AI/providers, publisher/money and all domain families | Every specific requirement implemented and demonstrated; maintain 229-row coverage |
| E | Independent audit/retest, support, customer/publisher adoption and economics | Real external/elapsed evidence; staffed approved claims and regrade |

These are dependency waves, not repository shipping locks. Safe independent changes proceed while outside evidence is pending. Canonical frontend build, relevant meaningful backend tests, migration integrity and local CI/merge train apply to future code; no application gates are claimed for this documentation-only planning task.

## Open questions / decisions checklist

- [ ] Confirm accountable staffing, workload/tier and supported migration matrix.
- [ ] Accept per-section non-trivial data/profile/adapter choices after their proposed alternatives/prototypes.
- [ ] Resolve all 38 companion questions through named evidence/decisions; do not invent user approval.
- [ ] Complete RFC 0250 review and acceptance before its opt-in public implementation/advertisement.
- [ ] Obtain vendor-key/budget/infrastructure/independent audit/native-review/customer inputs before dependent execution.
- [ ] Reconcile roadmap/catalog current-state drift with implemented child ADR evidence without altering history.
- [ ] Close all original IDs only with implementation plus actual witness packets; program scope remains all inventoried families.

## Implementation record

| Phase | Commit / evidence | Status |
| --- | --- | --- |
| Planning |12 PRDs,69 requirements,48 proposed witnesses,38 planning questions,25 risks, coverage/feature maps | Proposed; no implementation/operational qualification |
| A1 — operator docs name live routes (S01-R1, OPS-01) | #5184, merged f8b5ac251; witness `backend/typescript/test/operator-doc-routes.test.ts` | Merged; OPS-01 stays Open |
| A3 — Brand first read ends in an announced, recoverable state (S07-R1, UX-01) | #5186, merged 8d8084242; witness `frontend/react/src/features/brand/__tests__/brandFirstRead.test.tsx` | Merged; UX-01 stays Open |
| A2 — upgrade planner and rolling-safety metadata (S01-R2, OPS-02) | #5185, merged 6114d882d; witness `backend/typescript/test/upgrade-plan.test.ts` (metadata half of S01-T2) | Merged; boot guard open (ADR 0052 §D2a); OPS-02 stays Open |
| A4 — brand build variables are one checked set (S01-R3, BRAND-01) | #5191, merged e5e38109d; witness `frontend/react/src/brand/__tests__/brandEnvHandoff.test.ts` (config half of S01-T3) | Merged; first paint, email and native identity open; BRAND-01 stays Open |
| A5 — dependency advisories (S02-R4, SEC-02) | #5192, merged a29b98710; `npm audit` before/after, 27 of 28 rows cleared; no plan witness covers this half | Merged; msal-node #222 excepted to 2026-11-07, unfixed; SEC-02 stays Open |
| Wave A side finding — ISO 4217 money exponents | #5211 merged f2f4a81cf, #5213 merged abe1f17d4; witness `backend/typescript/test/currency-iso-table-parity.test.ts`; read-only prod count: 0 affected rows | Merged; outside the plan's requirements |
| B1 — secure production profile decision (S02-G1, S02-R1) | [ADR 0981](0981-secure-production-profile.md), Accepted 2026-10-26 (user); implemented #5262, #5265, #5272 (live 9ff1b1e94) | B1 done; S02-T1 complete for the D2 matrix; SEC-01 stays Open (S02-R2 matrix next) |
| B2 — durable run admission across instances (S03-G1–G3, SCALE-01) | [ADR 0987](0987-durable-run-admission.md), Accepted 2026-10-27 (user) | Decision accepted; implementation next (Q4: Homebrew Postgres for the real-DB witness); SCALE-01 stays Open |
| B3 — host-event internal repair remainder (S04-R1–R3, S04-T1/T2) | [ADR 0988](0988-host-event-internal-repair-remainder.md), Accepted 2026-10-27 (user) | Decision accepted; implementation next. Most of B3 is already delivered by ADR 0973; ADR 0988 lists what remains; EVENT-01 stays Open |
| Phases B–E product implementation / external evidence | None | Open |

## References

- [Master plan](../plans/platform-gap-closure-2026-10-24/README.md), [coverage](../plans/platform-gap-closure-2026-10-24/coverage.json).
- [Original assessment](../research/platform-gap-analysis-2026-10-24.md), [architecture contract](../../ARCHITECTURE.md).
- Existing ADR 0001/0052/0342–0349/0385/0419/0548–0556/0821/0826/0934/0969, linked at their actual paths in section PRDs.

# Section 09: AI outcome quality and maintained integration coverage

Status: Proposed — planning complete for review; no implementation, qualification or approval implied.

| Field | Value |
|---|---|
| Kind | Host product/engineering requirements; /prd five-pass method |
| Date | 2026-10-24 |
| Audit IDs | AI-01, INT-01 |
| Proposed accountable role | AI platform / integrations engineering; staffing unconfirmed |
| Dependencies | 02, 03, 06 |
| Effort | XL; relative scope only, not elapsed schedule |
| Decision records | Existing ADRs in References; umbrella ADR 0970 |
| Companions | [09-ai-outcomes-and-qualified-integrations.gaps.md](09-ai-outcomes-and-qualified-integrations.gaps.md) · [09-ai-outcomes-and-qualified-integrations.risks.md](09-ai-outcomes-and-qualified-integrations.risks.md) |
| Program | [Master plan](README.md) · [Coverage](coverage.json) |

## Summary

Prove every advertised AI workflow/agent and connector operation on supported provider/model versions. Turn integration and model catalog breadth into maintained, dated operational coverage and measured business outcome quality.

## Motivation

Source has shared chat/tools/envelopes, eval suites, provider catalog and Connections packs. `features/marketplace/certService.ts` checks manifests; it does not prove live provider operations. Current audit did not spend vendor keys or run every chain/agent. Existing live qualification workflow requires explicit named vendor/key authorization and records vendor refusals separately from app failures. ADR 0889 already owns trajectories/trials; the new upstream RFC 0249 is Active after the upstream refresh and is not yet Accepted; it cannot be treated as qualified host implementation proposal/readback support.

## Proposal

Requirements use **shall** for this host plan; uppercase RFC 2119 obligations exist only in the upstream Draft RFC. No requirement is a statement that code already implements it.

- **S09-R1 (AI-01)** — Enumerate all LLM calls: chat agent tools, workflow nodes, authoring pipelines, structured outputs, multimodal/voice, realtime, subruns and headless utilities. Map each to generated schema/catalog grounding, read-before-write context, output validation/repair, approval/effect gate, replay provenance and eval owner; no unowned blind authoring lane.

- **S09-R2 (AI-01)** — Define representative positive, ambiguous, adversarial, multilingual, refusal and failure fixtures per task. Use existing eval suites/trajectory/trial owners to measure task correctness, evidence attribution, schema validity, approval adherence, injection/exfiltration resistance, latency and total cost. Pin prompt/model/pack/data versions; judge calibration and human labeled holdout prevent self-grading inflation.

- **S09-R3 (AI-01)** — Run all advertised chains and manually authored chat-agent fixtures against every supported provider/model capability combination. Record pass/vendor-refused/app-failed/blocked, repeated-trial uncertainty and accepted cost ceilings; stop/retry on documented vendor rate limits. Never infer one provider pass covers another, nor change routing/model mid-run.

- **S09-R4 (INT-01)** — Generate provider × version × auth × operation/trigger catalog from existing Connections/pack registries, preserving shipped/enabled/qualified/unsupported distinctions. Verify each declared auth scope, consent/tenant context, pagination, write idempotency, partial failure, 429/backoff, token refresh/revocation and webhook signatures through the broker.

- **S09-R5 (INT-01)** — Assign maintained integration ownership, official documentation/API contract/version and requalification trigger for provider/model/schema/dependency changes. Fix obsolete/broken operations and test real outcomes before marking qualified; no unsupported method stays advertised as working. Keep full advertised inventory in scope, prioritizing critical/sold paths first.

- **S09-R6 (AI-01)** — Require reliable fixture-gated promotion for supported AI output/application workflows; production evaluation/feedback respects privacy and redacts raw sensitive prompts. Record drift/quality regression and route repair through existing eval/Operations surfaces, not a new chat or LLM subsystem.

### Five architect passes

| Pass | Finding / decision |
|---|---|
| Specification | Define quality for actual business tasks, separating infrastructure liveness, model refusal and application correctness. |
| Schema | Ground outputs from current SSoT schemas/catalogs; extend existing eval/qualification records rather than prompt-stuffed copies. |
| Security | Injection/exfiltration, untrusted tool output, purpose consent, approval hash, BYOK scope and external-effect/replay are fixture requirements. |
| Conformance | Real provider operation receipts and held-out human outcomes supplement deterministic negative fixtures; repeated trials report uncertainty. |
| Compatibility | Pin and preserve model/provider/pack decisions for historical runs; provider deprecation triggers qualification before changing advertised defaults. |

### Proposed data and interface impact

Qualification record references provider/model/connector/operation versions, fixture digest, prompt/schema/pack revisions, consent basis, resource caps, trial count, disposition and measured outcomes. Reuse existing eval and live-qualification ledgers; keys are BYOK refs, never stored in fixtures. Any new protocol eval shape maps to an accepted RFC first; host reports can evolve independently.

## Compatibility

Host qualification uses current accepted model/eval/connection contracts. A new cross-host trajectory field, proposal/readback operation or model capability requires accepted upstream RFC; RFC 0249/0248 statuses must be checked at implementation. No live spend is authorized by this planning document; obtain the named vendor/key/budget instruction before executing paid qualification.

## Conformance

The observable and the actor able to cause the condition are separate. A mock, code search or manifest cannot substitute for the stated executable witness.

| Scenario | Observable / acceptance | Who can cause it | Proof scope |
|---|---|---|---|
| S09-T1 | Each LLM boundary has schema grounding, real context read and bounded repair/fail-closed apply witness | Controlled model/tool fixture | All inventoried lanes; no count-only audit |
| S09-T2 | Repeated supported-provider tasks meet predeclared quality/security/cost thresholds | Explicitly authorized live key + calibrated human judge | Real model trials with uncertainty and vendor refusal class |
| S09-T3 | Every qualified connector operation actually succeeds and handles auth/error/revocation cases | Provider test accounts + broker fixture | Real vendor receipts; stub covers deterministic failure only |
| S09-T4 | Breaking provider change re-arms qualification and blocks unsupported claims | Catalog/version change fixture | Registry, eval promotion and UI status together |

## Alternatives considered

- Manifest lint as certification: rejected; no external behavior measured.
- Add independent agent/chat/connector layers: rejected; duplicate grounding, secrets and governance owners.
- Extend existing qualification/evals/broker: chosen, with live budget and human review gates.

## Unresolved questions

1. Which vendor/model/API tiers and test accounts are supported and budgeted? Resolution: Versioned support matrix and explicit live vendor/key/budget authorization. Owner: AI/integration + product owners. Blocks: live tests.
2. What calibrated correctness/security/latency/cost floors apply per task? Resolution: Human label rubric, baseline, held-out set and threshold approval. Owner: Domain/evaluation owners. Blocks: quality pass decision.
3. Who maintains each external operation and receives deprecation/rate-limit incidents? Resolution: Assign accountable maintainer and requalification policy. Owner: Integrations owner. Blocks: maintained catalog closure.

## Implementation notes (non-normative)

| Order | Concrete work / existing owner | Deliverable / verification |
|---|---|---|
| 1 | Model/pack/tool/provider/eval inventories | Complete boundary and operation matrix |
| 2 | Existing eval suites/fixtures and closed-world outputs | Deterministic/adversarial/repair and human calibration fixtures |
| 3 | Existing authorized live qualification + provider sandboxes | Dated operation/model trials and failures repaired |
| 4 | Catalog/promotion/Operations owners | Regression triggers, supported status and production drift policy |

Sequence schema/atomic persistence before consumers; deploy compatible backend before frontend. For incompatible data changes use an explicit drain/maintenance boundary and a coherent restore, never a blind old-binary rollback. Reuse local CI/merge train; no global shipping freeze or cross-session lock.

## Acceptance criteria

- [ ] Every advertised operation and AI lane is qualified or explicitly blocked with owner; no claimed supported path is left silently untested.
- [ ] Outcome floors and injection/approval/effect safety pass with calibrated human evidence.
- [ ] Live vendor/model-specific results, maintenance owner and requalification triggers exist; manifest/schema-only checks do not close original IDs.
- [ ] Attach exact SHA/artifact/config, executed/failed/skipped/blocked dispositions, operator/reviewer and timestamp to each closure record; regrade only the demonstrated scope.
- [ ] Update original IDs AI-01, INT-01 with implementation and evidence links; do not check off because this PRD exists.

## References

- [Eval program](../../adr/0889-agent-eval-suites-trajectories-trials.md)
- [Connector registry](../../../backend/typescript/src/features/connections/providerRegistry.ts)
- [Manifest certification helper](../../../backend/typescript/src/features/marketplace/certService.ts)
- [Architecture AI exchange rules](../../../ARCHITECTURE.md)
- [Competitive AI/integration benchmarks](../../research/deep-research-platform-2026-10-24.md)

## GO / NO-GO

**GO for proposed host-plan review. CONDITIONAL for implementation:** resolve the blocking companion questions, accept any new architectural decision, and satisfy any upstream RFC gate first. This is not an Accepted protocol RFC or a production release decision.

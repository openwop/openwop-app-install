# ADR 0262 — Customer Data Platform (CDP) — composition program, not a monolith

**Status:** implemented (Phases 0–3) — the CDP feature-package shipped (`features/cdp/*`, Graduation #2064); Phase 4 enterprise/scale is RFC-gated (RFC 0127/0128 Draft) and regional residency is deferred as a deployment concern (not a wire RFC). *(Status-corrected 2026-07-21 — program header lagged the shipped phases.)*
**Date:** 2026-07-05
**Depends on:** ADR 0001 (feature-first packages), ADR 0008 (CRM), ADR 0020 (consent), ADR 0024 (Connections), ADR 0028 (connector-action governance), ADR 0034 (external-event trigger ingestion), ADR 0077 (data classification / PII / retention), ADR 0099 (run-start-context replay seam), ADR 0198 (approvals), ADR 0211 (CRM segments live-resolution doctrine), ADR 0226 (analytics identity-link — the "no identity graph" non-goal this program re-opens), the workflow executor + trigger bridge, RFC 0095 (connection packs), RFC 0099 (TriggerEvent)
**Companion analysis:** [`docs/research/cdp-gap-analysis.md`](../research/cdp-gap-analysis.md) (74-sub-capability audit) · [`docs/research/deep-research-cdp.md`](../research/deep-research-cdp.md) (market PRD)

## Why this exists

A new **Customer Data Platform** capability was requested against the market PRD in
`deep-research-cdp.md`. A five-track, code-grounded audit (`cdp-gap-analysis.md`) established
the load-bearing fact: **openwop-app is already ~65% of a CDP, and the 65% is the hard part** —
a durable workflow executor, a verified webhook/email/form/cron trigger-and-ingestion bridge
(`host/triggerBridgeService.ts`, `triggerIngestionService.ts`), idempotency/DLQ/retry, live
Meta/Google/TikTok/LinkedIn ad dispatch (`host/adsAdapter.ts`), consent + suppression at every
egress (`consentService.ts`, `crm/suppressionService.ts`), PII classification + retention sweep +
DSR erasure (`host/dataClassification.ts`, `retentionSweepDaemon.ts`, `subjectErasure.ts`),
RBAC + capability-firewall, SAML SSO + SCIM, and one grounded AI chat with closed-world authoring.

The thin part is the CDP *product surface*: a unified customer profile with an identifier graph,
behavioral/calculated traits, destination-agnostic sync with field-mapping + CDC, self-advancing
journey timers, purpose-based consent, and propensity scoring.

The wrong build is a monolithic "CDP feature" that stands up parallel copies of orchestration,
identity, egress, or consent. That directly violates `ARCHITECTURE.md` ("New features must not
create parallel systems for concepts the app already owns") and the repo's "no parallel
architecture" law. **This ADR records the decision that the CDP is a composition *program* — a
sequence of feature-package ADRs (CDP-A…H) that extend existing owners — and fixes the boundary
rulings that keep it from drifting into a second stack.** It carries no code itself; each sub-ADR
does.

## Decision

Deliver the CDP as **eight sequenced sub-ADRs**, each a normal feature-package (or extension of
one) per the ADR 0001 lifecycle, riding the executor/trigger-bridge/consent/approval/chat seams
**verbatim**. A thin `cdp` umbrella feature-package owns only the cross-source identifier index +
the admin console; it is explicitly **not** an identity, egress, consent, or orchestration
authority.

### Boundary rulings (from the ADR 0262 architecture review — binding on all sub-ADRs)

These are the review's CRITICAL/HIGH findings, promoted to program invariants:

1. **CRM owns the customer identity graph.** The customer record is the CRM `Contact`
   (`crm/contactsService.ts`; commerce/forms/gmail already converge on `contactId`). CDP identity
   resolution is a **CRM extension**, exposed under CRM ownership. The word "identity" as a *second*
   top-level owner is forbidden — it collides semantically with the canonical-subject layer
   (ADR 0003, `ARCHITECTURE.md` "Users and canonical subjects are owned by the identity/session
   layer"). The `cdp` package owns only the identifier **index** + console, never a second contact
   store. (Supersedes ADR 0226's explicit "no identity graph" non-goal — recorded there as a
   correction note, not a rewrite.)

2. **Run-affecting time and decisions are replay-verbatim.** Any self-advancing timer (journey
   waits, CDP-E) freezes its deadline into the interrupt record at `ctx.suspend`
   (`resumeAt = createdAt + duration`), mirroring `executor/approvalGateTimeout.ts`
   (`approvalGateDeadlineMs` derives from the frozen `createdAt`, never wall-clock-at-wake). Fork
   semantics are stated explicitly (inherit the original deadline, as approval gates do). Any
   branch-affecting decision stamped on a run uses the `runStartContext` → `run.metadata` seam
   (ADR 0099), read verbatim on `:fork`.

3. **One egress owner.** `campaign-connectors` already owns activation egress (audience upload +
   metric sync). The destination-sync hub (CDP-D) must not become a second egress owner: it either
   generalizes the abstraction and refactors ad-upload to consume it, or scopes strictly to
   non-ad destinations with a documented boundary. Decided at CDP-D authoring.

4. **Live segment resolution stays the source of truth.** ADR 0211's doctrine ("no membership is
   ever materialized") holds. Any snapshot (CDP-C) is a clearly-labeled **derived cache**, never a
   second authoritative membership store.

5. **One consent evaluator, one approval owner.** `Purpose` is owned by `consentService` with the
   single `isAllowed` / `isPermittedForPurpose` chokepoint (CDP-F). Steward merge/unmerge/override
   and any AI-authored artifact gate ride the existing `approvalService` (ADR 0198), never a new
   queue. Probabilistic match (CDP-B) only *proposes*; auto-merge stays deterministic.

6. **Chat-drivability = agent pack + node pack, not a new chat.** Every CDP authoring surface
   (segment / journey / insights / match-steward) ships an agent pack + node pack driven through
   `EmbeddedChatPanel` scoped by agent id (ADR 0058), grounded closed-world against the real
   vocabulary (the `workflow-author` pattern). No second chat.

### Sub-ADR index

| ADR | Sub-program | Owner extended / created | Wire |
|---|---|---|---|
| **0263** (CDP-A) | Customer identity resolution — identifier graph, external ids, real-time profile lookup | extends `crm`; thin `cdp` index/console | host-ext |
| **0264** (CDP-B) | Probabilistic match + steward console + reversible merge/unmerge audit | extends `crm` merge; rides `approvalService` | host-ext |
| **0265** (CDP-C) | Behavioral segments + calculated traits + audience insights + propensity | extends `crm` segments + `analytics`; reuses `priority-matrix/scoring` | host-ext |
| **0266** (CDP-D) | Destination-sync hub + field-mapping + CDC cursor + reverse-ETL write | new `destination-sync` (single egress owner ruling) | host-ext (+ADR for warehouse write) |
| **0267** (CDP-E) | Journey runtime — self-advancing timers + segment-entered trigger + experiments + journey canvas | extends `executor` + `campaign-journeys` + builder canvas | host-ext |
| **0268** (CDP-F) | Purpose-based consent graph + field masking + label-based record ACL + policy decision log | extends `consent` + `dataClassification` + `accessControl` | host-ext + **1 RFC** (purpose propagation) |
| **0269** (CDP-G) | Event schema registry + collection SDKs + ingest PII tagging + source-health | extends `analytics` + trigger ingestion + `artifactTypes` | host-ext |
| **0270** (CDP-H) | Developer platform — scoped API keys + connector certification (optional) | extends `marketplace` + `oauthClientStore` + auth | host-ext |

### RFC gate (the only wire-touching items — need `../openwop` RFCs at Accepted before/with host work)

- **Streaming / CDC ingest sources** — extend RFC 0099 `TriggerEvent.source` (`stream`/`change`). Gates CDP-D streaming + CDP-G streaming ingress. **→ Authored: RFC 0127 (Streaming & CDC trigger sources), Draft, open questions resolved.**
- **Purpose-propagation contract** — new RFC (a downstream sync/A2A consumer must honor "permitted downstream use"). Gates the cross-host half of CDP-F. **→ Authored: RFC 0128 (Purpose-propagation — permitted-use labels), Draft.**
- ~~**Regional residency advertisement** — new RFC (residency capability flag).~~ **DEFERRED — will NOT be authored as a wire RFC (`/architect` Track-B ruling).** The spec corpus already assigns data residency to the operator/deployment layer (`spec/v1/compliance.md` §"Deployment-specific posture" — *"data-residency arrangements… are the operator's responsibility"*), and a host's residency claim is **unfalsifiable over the wire** (a conformance run cannot verify where a host physically stores data), so a `capabilities.dataResidency` MUST would be an unenforceable — dishonest — advert. Region is modeled on the wire only where it is behaviorally observable (the existing `idempotency.crossRegion` annex). The local data pin stays host-ext/deployment.
- Warehouse reverse-ETL *write* (CDP-D) needs an ADR + connector-governance review to loosen ADR 0076's read-only BigQuery invariant, but **not** an OpenWOP RFC (a node calling a vendor API, like the ads packs).

Any CDP capability kept host-internal under `/v1/host/openwop-app/*` needs no RFC; only *advertising*
one as a portable cross-host capability crosses the wire.

## Phased delivery (phase boundaries at real gates only)

- **Phase 0 — Foundations (host-ext, no RFC, highest leverage):** CDP-E self-advancing timer sweep · CDP-A identifier index + profile lookup · CDP-C behavioral segment filters + calculated traits.
- **Phase 1 — Activation loop:** CDP-D destination-sync + CDC cursor + observability · CDP-E segment-entered trigger + frequency governor.
- **Phase 2 — Trust:** CDP-F purpose graph (host side) + field masking + label ACL + decision log · CDP-B steward console + reversible merge/unmerge.
- **Phase 3 — Intelligence:** CDP-C propensity + audience insights · CDP-E journey experiments · copilot agent/node packs · CDP-C multi-touch attribution.
- **Phase 4 — Enterprise & scale (RFC-gated — the RFC comment window is the phase boundary):** warehouse reverse-ETL write (host-ext + governance, no RFC) · streaming/CDC ingest sources (RFC 0127, Draft) · purpose-propagation on the wire (RFC 0128, Draft) · residency **deferred** (deployment concern, not wire — see the RFC-gate note above) · CDP-G collection SDKs · CDP-H dev-platform keys/cert.

## Open questions / decisions checklist

- [ ] **CDP-A:** identity graph carried on `Contact` (additive `identifiers[]`) vs a dedicated
  CRM-adjacent store — decided by identifier-index scan cost at target contact volumes (the review's
  falsifiability watch). Default: additive on `Contact` + a by-identifier index collection.
- [ ] **CDP-D:** generalize-and-refactor vs scoped-split for the single egress owner — decided by how
  much ad-egress has hardened at authoring time.
- [ ] **CDP-E:** fork-before-timer semantics — inherit original deadline (recommended, matches
  approval gates) vs re-arm from new `createdAt`.
- [ ] **CDP-F:** does purpose-propagation ship host-only first (tag + local enforce) with the wire
  contract as a fast-follow RFC, or block on the RFC? Default: host-side first.
- [ ] Toggle strategy: each sub-ADR ships OFF/`tenant` bucket; the `cdp` umbrella console is
  superadmin-gated. No always-on graduation until a sub-program is proven.

## Graduation decision (added 2026-07-18 — the "CDP-graduation call")

The "no always-on graduation until a sub-program is proven" line above was
under-specified: *proven how, and which sub-program first?* This note fixes the
answer, informed by a market scan (2026 CDP consolidation + beta→GA best
practice + the CDP compliance bar — sources in the PR that added this note).

**It is NOT a binary flip of the `cdp` toggle.** Graduation is **per-sub-program,
against measurable exit criteria**, behind one hard cross-cutting gate:

- **Gate 0 — Compliance & Identity (HARD; blocks EVERY CDP graduation).** For the
  data a sub-program touches: purpose/consent (CDP-F, ADR 0268) enforced
  end-to-end, identity joins respect consent (CDP-A/B, ADR 0263/0264),
  DSAR/erasure (ADR 0380/0381) + audit trail verified against a real record. The
  market is unambiguous that a CDP graduates only with consent-linked identity +
  DSAR + audit; this is non-negotiable.
- **Per-sub-program exit criteria** (the data-driven beta→GA bar): real
  design-partner usage, error-budget/SLO met, e2e green, feature requests
  *incremental not foundational*, an operator runbook.

**Graduation ORDER — segments first, journeys second:**

1. **CDP-C segments via the ADR 0265 NL segment-author copilot — graduates
   FIRST.** It is market table-stakes, a *tiny* build (one `segment-author`
   persona + one `persist-segment` node; the `segment-vocabulary`/`validate-
   segment` grounding pair already ships), it is **read-side** (downstream of
   Gate 0, lower bar), and it plays to openwop's structural edge — agent-driven
   segmentation through the ONE chat (`EmbeddedChatPanel`, no new panel). Because
   the build is so small, **building the copilot IS the GA vehicle for CDP-C**;
   the "build it" and "graduate it" decisions collapse. Constraint carried from
   the plan review: `persist-segment` MUST gate on a prior `validate-segment`
   pass + a human confirm (the workflow-author `draft→validate→persist`
   precedent + the "durable state only through closed-world validation and/or a
   human gate" invariant) — never a blind write.
2. **CDP-E journeys via the ADR 0267 journey-canvas FE — graduates SECOND, higher
   bar.** Journeys *act* on data (outbound messages across channels), which is
   where consent/frequency/purpose enforcement bites hardest. So journeys
   graduate only AFTER segments, with the frequency-governor + purpose
   enforcement proven on live data. Concrete trigger: CDP-C graduated + those
   controls verified. Until then ADR 0267's canvas FE stays parked (the runtime
   already ships; the palette on the existing `BuilderCanvas` is FE-only).

**Strategic guardrail.** Build/position CDP as **composable + agent-driven**
(reverse-ETL/warehouse-native, ADR 0266, riding the entities kernel + the one
chat) — the growing lane. **Do NOT** pursue the packaged all-in-one CDP suite
archetype: the 2026 Gartner MQ shed several packaged leaders while warehouse-
native/composable entrants rose. openwop is already in the winning lane; keep it
there.

## Consequences

The CDP makes the existing system more capable without a second stack: journeys gain durable time,
CRM gains a customer graph, consent gains purpose, activation gains a destination catalog — each in
its existing owner. The cost is program coordination (eight ADRs) and one deliberately re-opened
prior decision (ADR 0226). The benefit is that every CDP capability is replay-safe, tenant-isolated,
consent-gated, and chat-drivable **for free**, because it rides seams that already are.

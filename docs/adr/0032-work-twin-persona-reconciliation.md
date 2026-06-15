# ADR 0032 — Work-twin persona reconciliation: seed only the ten canonical twins

**Status:** implemented
**Date:** 2026-06-13
**Depends on:** ADR 0023 (assistant / Chief-of-Staff = roster agent "Iris"), ADR
0016 (CSM), ADR 0008 (CRM), ADR 0011 (KB/RAG), ADR 0010 (notifications), ADR
0004/0006 (orgs/RBAC — `accessControl`), ADR 0025 (roster/seed symmetry), ADR
0031 (`agentProfile` shape this seed populates).
**Sibling:** ADR 0033 (which twins reach which providers).
**Surface:** demo seed data + the existing seed/clear/heal path. **NON-NORMATIVE.**

## Why this exists

The demo currently seeds **six** personas (`host/seed-data/exampleAgents.json`):
Sally (sales-ops), Marcus (support-triage), Priya (finance-ops), Devon
(engineering-ops), Nora (marketing-ops), and **Iris** (chief-of-staff). The new
initiative defines **ten** canonical enterprise work-twins. Several overlap the
existing personas, and one of the ten — Chief of Staff — is **already a live
feature**: Iris is the `assistant` agent (ADR 0023), with a structured memory
graph, perception loops, and a health panel (ADR 0029).

The architecture review flagged the CRITICAL risk of (a) seeding a second
Chief-of-Staff beside Iris, and (b) shipping ~16 near-duplicate agents per tenant.
A decision is needed on which personas the demo ships and how each binds to an
existing feature owner — before any Phase-2 seeding.

## Decision (per maintainer, 2026-06-13)

**The demo seeds ONLY the ten canonical work-twins.**

1. **Remove the five legacy demo personas** (Sally, Marcus, Priya, Devon, Nora)
   from `exampleAgents.json`. They were illustrative scaffolding; the ten twins
   supersede them.
2. **Iris stays and IS the Chief-of-Staff twin.** Do **not** reseed, duplicate,
   or rebuild it. It remains the live `assistant` feature (ADR 0023). Phase 2
   only backfills its `agentProfile` and refines its prompt/templates — no new
   agent, no parallel memory-graph/loops. (Resolves CRITICAL finding #1.)

### The ten canonical twins + owner bindings

Each twin reads/writes through its **existing feature owner**, never a parallel
store (ARCHITECTURE.md "prefer the existing owner for every concept"):

| Twin | roleKey | Default autonomy (specLevel) | Binds to existing owner(s) |
|---|---|---|---|
| Executive Operations | `executive-ops` | recommend | calendar/email via Connections; reuses `assistant` surface (see §Exec-vs-Iris) |
| Chief of Staff (= Iris) | `chief-of-staff` | recommend | **existing `assistant` feature (ADR 0023)** — reused, not reseeded |
| Recruiting Coordinator | `recruiting-coordinator` | execute-with-approval | kanban boards, Connections (ATS); `kb` for templates |
| People Operations | `people-ops` | execute-with-approval | `accessControl`/orgs for roles; `kb` for policy; notifications |
| Finance Close | `finance-close` | draft-only | Connections (ERP); `kb`; approvals/notifications |
| Contract & Procurement | `contract-procurement` | draft-only | `kb` (playbooks/clauses); Connections (CLM/DocuSign); approvals |
| Sales Execution | `sales-execution` | recommend | **`crm` feature (ADR 0008)** |
| Customer Success | `customer-success` | recommend | **`csm` feature (ADR 0016)** + `crm` |
| IT Service Desk | `it-service-desk` | execute-with-approval | Connections (ITSM/ServiceNow); `kb`; approvals |
| Internal Communications | `internal-comms` | draft-only | `cms`/`publishing` + `kb` |

(`specLevel` maps to a roster `level` per ADR 0031's mapping table.)

### Executive-Operations-vs-Iris boundary (resolves the duplication risk)

Executive Operations overlaps Iris's "operating rhythm" remit. It must **not**
fork Iris's memory-graph or loops. Decision: **Executive Operations is a second
roster instance bound to the same `assistant` feature surface**, distinguished by
`roleKey: 'executive-ops'`, an exec-scoped system prompt, and an exec template
set — it reuses `assistantService` (one owner of the memory graph), it does not
copy it. If, during Phase 2, a clean second-instance binding proves to require
non-trivial `assistant`-feature changes, Executive Operations is **deferred** (the
twin set ships with nine + Iris) rather than forked. Either outcome keeps a single
owner of executive operating-rhythm logic.

### Migration / idempotency (existing tenants already seeded with the five)

The seed is gated per-tenant by `demo:seed-claimed:{tenantId}` and must never
resurrect user-deleted agents (ADR 0025). Decision:

- **Fresh tenants:** seed exactly the ten twins; never the legacy five.
- **Existing tenants** that already claimed the seed marker: bump a seed-content
  version. On `heal`/explicit re-seed, the canonical demo personas are reconciled
  to the ten via the existing `clear`→`seed` seeder steps (`exampleDataSeeders.ts`):
  the **canonical legacy five are cleared** (they are demo-owned entities, not
  user-created) and the ten seeded. User-created agents and user-edited/renamed
  personas are left untouched. Silent auto-seed on an empty roster seeds the ten.
- No legacy persona is auto-recreated once removed.

This keeps the idempotency + no-resurrection contract intact while changing the
canonical set.

## Alternatives weighed

1. **Keep all 16 (6 legacy + 10 new)** — rejected: duplicative day-1 experience
   (two finance agents, two sales agents), noisy, weakens the demo.
2. **Rename-in-place** (retheme Sally→Sales Execution, etc.) — rejected as the
   default: roleKey/owner bindings and prompts differ enough that a clean
   ten-twin seed is simpler and avoids half-migrated personas; (the seeder may
   still reuse a freed slot internally, but the contract is "seed the ten").
3. **Defer the decision to implementation** — rejected: the persona set gates all
   of Phase 2; it must be decided first.

## Implementation plan

| Phase | Work | Gate |
|---|---|---|
| 2.0 | shared workflow-template pack (pinned) | T1.* |
| 2.1–2.8 | seed the eight non-Iris/non-Exec twins (prompt + `agentProfile` + workflow portfolio + schedules + board + owner binding) | 2.0 |
| 2.9 | Executive Operations — second `assistant` instance or deferred per §boundary | 2.0 |
| 2.10 | backfill Iris `agentProfile` + prompt/template refinements (no new agent) | 2.0 |
| 2.11 | remove legacy five + migration/heal handling; seed-idempotency tests | — |

## Implementation (landed 2026-06-13)

| Phase | PR | Key file |
|---|---|---|
| 2.1–2.8 — seed the eight non-Iris/non-Exec twins; 2.10 backfill Iris `agentProfile`; 2.11 retire the legacy five | [#232](https://github.com/openwop/openwop-app/pull/232) | `backend/typescript/src/host/seed-data/exampleAgents.json` |
| 2.9 — Executive Operations (tenth twin) as a second `assistant` instance + assistant-capability activation | [#233](https://github.com/openwop/openwop-app/pull/233) | `backend/typescript/src/host/seed-data/exampleAgents.json` |

## Open questions / decisions checklist

- [ ] Confirm Executive Operations: second-instance vs deferred (decide at 2.9
      based on `assistant`-feature coupling cost).
- [ ] Seed-content version bump mechanism — reuse `systemSite` SEED_VERSION
      pattern or a roster-specific marker?
- [ ] Per-twin default `configParameters` content — owned by each Phase-2 task,
      sourced from the matching `new_agents.md` spec sheet.
- [ ] Which twins are net-new builds vs. reuse a freed legacy slot (cosmetic;
      contract is "ship the ten").

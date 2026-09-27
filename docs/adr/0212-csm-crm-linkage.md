# ADR 0212 — CSM↔CRM linkage: company reference, computed health factors, renewal plays

Status: implemented (crmRef + healthFactors + feature.csm.nodes v1.4.0 + csm-ops chains + CSM page linkage — CRM gap analysis §5 D3)
Date: 2026-07-03
Depends on: ADR 0016 (CSM), ADR 0008 (amended), ADR 0208 (verbs/chains), ADR 0172 (cross-feature reference precedent).

## Context

Gap analysis E7: `csm` is a stub — tenant-scoped Accounts with a manually-typed 0–100
`healthScore`, zero linkage to the customer graph, no factors, no renewals. Survey
facts: csm has NO org concept (Accounts are tenant-only) while CRM companies are
org-scoped, so a bare `companyId` reference would be ambiguous; csm already exposes an
idempotent `setHealth` workflow surface (`features/csm/surface.ts`).

## Decision

1. **Reference, not merge (the ADR 0172 rule):** `Account` gains
   `crmRef?: { orgId: string; companyId: string }` — both-or-neither, validated against
   CRM (company must exist in that org for the caller's tenant) on create/update; 404 on
   a dangling ref, fail-closed. CRM never learns about csm (dependency stays csm → crm).
2. **Computed health with provenance:** `Account` gains
   `healthFactors?: { factor: string; weight: number; value: number }[]` +
   `healthComputedAt?`. The csm surface `setHealth` accepts the optional factors block
   (idempotent update, same guard). Manual sets remain allowed (factors cleared —
   a hand-typed score is not a computed one).
3. **The computation is a chain, not a service job:** new
   `examples/workflow-chain-packs/csm-ops/pack.json` with
   `csm-ops.health-from-crm` — CRM read nodes (deals/tasks/activities for the linked
   company) → `feature.csm.nodes` health-write node (extended to pass factors) — so the
   scoring recipe is visible, editable workflow configuration, not buried code. Weights
   ride chain params. Operators bind it to a schedule or run on demand.
4. **Renewals are deals, not a new entity:** a `Renewal` pipeline is just a pipeline;
   `csm-ops.renewal-risk` chain = `feature.crm.nodes.list-deals` →
   `core.chat.approvalGate` → `feature.crm.nodes.create-task` (the deal-hygiene shape) —
   a human confirms the at-risk follow-ups; the run feed is the audit.
5. Frontend: the CSM page shows the linked company (link to `/crm/companies/:id?org=`),
   the factor breakdown when present, and a "computed <relative time>" stamp; the CRM
   company detail page does NOT grow a csm panel (dependency direction).

## Alternatives rejected

- Putting health computation in a sweep daemon — health recipes are per-tenant policy,
  not host cadence; chains keep them inspectable/editable (the ADR 0209 routing rule).
- A csm `orgId` migration — csm stays tenant-scoped; only the REFERENCE carries the org.

## Open questions

- [ ] Usage/support-burden signals as factors — when those features expose read verbs.

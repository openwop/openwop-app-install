# ADR 0416 — Trust center + tenant audit export

Status: implemented (P1–P3, 2026-07-18)

## Implementation record

| Phase | What landed |
|---|---|
| P1 | `trust` page in the marketing/legal seeder (`host/marketingLegalPages.ts` `TRUST_PAGE`, DRAFT, capability-true claims + operator placeholders, links the existing security/subprocessors/legal pages — the /architect duplication check re-scoped it from a new module to the existing owner); seed-count test 24→25; structure test (`test/adr0416-trust-center.test.ts`). |
| P2 | `GET …/governance/audit/export` — tenant-admin (`requireTenantScope host:members:manage`) export of the caller tenant's ADR 0301 chain: JSONL (proof first line: head + fresh `verifyChain`) or CSV (proof in `x-audit-*` headers, RFC-4180 cells); `format=csv|jsonl` added to the existing superadmin flat-log route (no proof there — it is not the chain, stated in-code). Authz/isolation/format tests incl. the anon-visitor posture (own empty chain only — the shared gate's documented semantics, not a fork). |
| P3 | "Export your tenant audit chain" actions on `settings/AuditLogPage` — rendered OUTSIDE the superadmin gate (tenant-admin authority), busy/error states, blob download via `governanceClient.downloadAuditChainExport`; i18n ×4. |

OQ-1 resolved: static operator-maintained subprocessors content (the seeded page). OQ-2 open: publishing the demo host's trust page is an operator action.

**Residual risk (code-review 2026-07-18, recorded not capped):** the chain export
is intentionally UNBOUNDED — truncating a tamper-evident export would break its
provability, so no `limit` is offered. `listChain` walks the chain with per-seq
point reads (N gets for N entries); for a very long chain that is one slow admin
request, not a hot-path hazard. If chains grow past ~10⁴ entries, add a
range-batched read + streamed response (same proof semantics) — the trigger is
observed export latency, tracked here.

Decision source: **docs/steward/GAP-SWEEP-2026-07.md §3 row 13 + §4 item 7** (mid-2026 market
baseline: a self-serve trust page + audit export is becoming expected of platforms
selling to enterprise — Vanta/Drata-class GRC explicitly ruled a BUY, not a build)
and the 2026-07-18 `/architect` pre-existing-surface audit, which found **both
halves largely exist**: this ADR is an assembly, not a system.

## Context

Enterprise buyers ask two questions before a pilot: "what is your security
posture?" (today answered ad hoc) and "can we export our audit trail?" (today
answerable only by a superadmin over REST). The app already has the substance:

- **Posture**: `host/deployPosture.ts` (`enterprisePosture()`), MFA/vault/
  break-glass (ADR 0389), SAML/SCIM SSO (RFC 0050), the ADR 0301 tamper-evident
  audit chain, per-tenant budgets/governance (ADR 0397).
- **Audit read**: `GET /v1/host/openwop-app/governance/audit`
  (`routes/governance.ts:417`) — superadmin-gated, tenant-isolation-scoped,
  filterable; backed by `host/auditChainService.ts` (`appendAudit`, `verifyChain`,
  `getAuditHead`, `listChain`) + `storage.listAudit`.
- **Public pages**: the CMS system-site seeder family (`host/marketingLegalPages.ts`
  16-page legal suite, `host/systemSiteDocs.ts`, `host/featuresPage.ts`) — real
  `cmsService` pages with deterministic ids and the never-clobber rule.

What does NOT exist: a public trust page, and a downloadable export format with
an integrity proof.

## Decision

Assemble both from their existing owners — no new page system, no new audit
store, no new route family:

1. **Trust page = a CMS system-site page.** Extend the `marketingLegalPages.ts`
   seeder pattern with a `trust` slug (deterministic `page:host-site-trust`,
   seeded DRAFT like the legal suite — the operator reviews + publishes).
   Content sections: security posture (sourced from what `enterprisePosture()`
   + the shipped feature set actually honor — never aspirational claims),
   subprocessors, data-residency/retention pointers, responsible-disclosure
   contact. A white-label operator edits it like any CMS page (human edit
   freezes the seed — the existing rule).
2. **Audit export = a formatter on the existing read.** Add `format=csv|jsonl`
   + a `proof` block to the EXISTING `governance/audit` route (same gate, same
   tenant scoping): the export bundles the filtered rows + `getAuditHead` +
   a `verifyChain` attestation over the exported range, so an auditor can
   verify integrity offline. **Additionally** expose a tenant-admin-scoped
   variant under `/v1/host/openwop-app/governance/audit/export` gated on the
   `host:members:manage` scope (a tenant admin exports THEIR OWN chain; the
   superadmin route keeps its wider view) — the one new route, and it shares
   the service-layer access predicate with the existing one.

Non-goals (recorded): SOC2/ISO evidence automation, questionnaire automation,
continuous-control monitoring — the Vanta/Drata BUY verdict stands. No uptime
badge in v1 (no SLO measurement surface exists to honestly back it).

## Alternatives weighed

- **A dedicated `trust` feature package with its own routes/pages** — rejected:
  duplicates the CMS public-content owner (ARCHITECTURE.md seam L145) for one
  page; the legal-suite precedent is exactly this shape.
- **A new export pipeline / audit warehouse** — rejected: the ADR 0301 chain +
  `listAudit` already own audit truth; an export is a serialization concern.
- **Skip the tenant-admin export (superadmin-only)** — rejected: "can WE export
  OUR trail" is the buyer question; superadmin-only fails it. The tenant scope
  is already enforced service-side; reusing that predicate keeps one owner.

## Phased implementation plan

- **P1 — trust page seed**: `trust` slug in the system-site seeder + content
  authored from the real posture; FEATURES row; seeds DRAFT.
- **P2 — export formatter**: `format=` + proof block on the existing route; the
  tenant-admin `/export` variant sharing the access predicate; route tests
  (authz matrix: anon/member/admin/superadmin × own/foreign tenant).
- **P3 — FE surface**: an "Export audit log" action on the existing governance/
  operator surface (no new page); download + proof-verification hint copy.

## Open questions

- OQ-1: subprocessor list — static CMS content (operator-maintained) vs derived
  from the connections/provider registry? v1: static content (honest, simple).
- OQ-2: should the trust page ship PUBLISHED for the demo host (app.openwop.dev)
  once counsel-style review passes? (The legal-suite precedent says operator
  publishes.)

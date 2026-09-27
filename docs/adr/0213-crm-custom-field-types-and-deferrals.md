# ADR 0213 — CRM custom-field type expansion + the recorded Phase-D deferrals

Status: implemented (D6 field types + contact custom fields; D4/D5 recorded as explicit deferrals — CRM gap analysis §5)
Date: 2026-07-03
Depends on: ADR 0008 (amended — this closes its "custom-field type expansion" open question).

## Decision — D6 (build)

1. **Field types:** `FieldDef.type` gains `'date' | 'enum' | 'reference'` beyond
   `string|number|boolean`:
   - `date` — value must be strict `YYYY-MM-DD` (the `closeDate` validation reused).
   - `enum` — `FieldDef.options: string[]` (required for enum, 1..24 bounded options);
     value must be one of them.
   - `reference` — `FieldDef.refEntityType: 'company' | 'deal' | 'contact'`; value must
     be an EXISTING id of that type in the caller's scope (org for company/deal, tenant
     for contact; tombstoned refs rejected) — validated at write, tolerated dangling at
     read (deletes don't cascade; the UI renders a dangling ref as plain text).
2. **Contacts get custom fields:** `FieldDef.entityType` gains `'contact'`
   (tenant-scoped defs — no orgId for contact defs; the defs routes accept it), and
   `Contact.customFields` lands with the same validation path on create/PATCH/import.
   Segments (ADR 0211) can then filter on typed contact fields.
3. All validation stays in the ONE `validateCustomFields` path so routes, import, and
   workflow verbs enforce identically.

## Decision — D4 deferred (recorded, closing ADR 0008's open question)

**The contact→org migration is explicitly NOT being done.** Rationale on the record:
the two-layer model (tenant rolodex + org-scoped revenue objects) is now load-bearing
product structure — Forms lands tenant contacts, Email resolves tenant audiences,
E-Commerce links tenant `contactId`s, and conversion (ADR 0209) gives contacts their
org on-ramp by materializing org companies/deals. An org-scoped contact migration
would touch every one of those consumers plus merge/segments/export/triage for a
payoff (org-partitioned contact RBAC) no consumer is pulling. A reference host demos
the graph adequately without it. If a real multi-org-tenant isolation requirement
lands, this becomes its own migration ADR with the pinned-contract test updated —
start from the gap analysis §5 D4 sketch.

## Decision — D5 deferred (recorded)

**Cross-entity CRM search is NOT being built now.** `?q=` filters exist on
companies/deals, lists are capped (client-filterable), and duplicate review covers the
dedup case. When a consumer pulls, the build path is the ADR 0112
conversation-search precedent on the RFC 0018 `db.search` substrate (write-time index,
lazy rebuild) — no new infra.

Gmail inbox sync (D1 step 2) is likewise deferred with its sketch in ADR 0211.
FEATURES.md's CRM row references this ADR for the non-goals.

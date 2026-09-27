# ADR 0209 — CRM record lifecycle ops: duplicate review, merge, lead conversion + routing

Status: implemented (duplicates + merge + convert + route-new-lead chain — CRM gap analysis §5 C3/C4)
Date: 2026-07-03
Depends on: ADR 0008 (amended), ADR 0208 (host events + write verbs), ADR 0004 (orgs), ADR 0006 (RBAC).

## Context

Gap analysis E1/E2: import dedupe only *skips*; there is no merge, no duplicate review,
no reversibility, no lead→customer conversion, and no routing. The research doc's E1
acceptance criterion ("merge with preserved history and a reversible audit trail") and
E2 criterion ("convert with mapped fields, original history visible") both fail today.

## Decision

### 1. Duplicate review (host-ext, read-only)

- `GET /v1/host/openwop-app/crm/duplicates?entityType=contact` (tenant surface) — groups
  contacts by case-folded `email` (email-less contacts are never grouped).
- `GET /v1/host/openwop-app/crm/orgs/:orgId/duplicates?entityType=company` — groups by
  case-folded `domain`, then exact case-folded `name` for domain-less companies.
- Read scopes as their sibling lists. Bounded by the existing per-org/tenant caps.

### 2. Merge (explicit, reversible-by-provenance)

- `POST /crm/contacts/:id/merge { sourceContactId }` (tenant) and
  `POST /crm/orgs/:orgId/companies/:companyId/merge { sourceCompanyId }` (org,
  `workspace:write`).
- Semantics: field-precedence merge (survivor's fields win; source fills blanks —
  including `customFields` for companies), **relink** referencing rows to the survivor
  (deals/tasks/activities by `contactId` / `companyId`), then **tombstone** the source:
  the row is kept with `{ mergedInto: <survivorId>, mergedAt }` and excluded from lists
  and duplicate groups; by-id GET returns it (provenance stays resolvable, external refs
  don't dangle). Tombstones are not counted against entity caps.
- Relink order fails closed: references are relinked BEFORE the tombstone write, so a
  mid-way crash leaves both records live and re-mergeable (idempotent re-run relinks the
  remainder), never orphaned references to a tombstone.
- Emits `host.crm.contact.merged` / `host.crm.company.merged` + audit `crm.<entity>.merged`
  (ADR 0208). Merging a tombstone or self is a 409.

### 3. Lead conversion

- `POST /crm/contacts/:id/convert { orgId, companyName?, pipelineId?, dealTitle? }`
  (org write scope, resolved via the same `authorizeOrgScope` gate):
  1. get-or-create an org `Company` — matched by case-folded domain (from the contact's
     email domain when public-domain-free) or provided/contact `company` name;
  2. create a `Deal` in the target pipeline's first stage linking `companyId` +
     `contactId` (title defaults to "<company> — <contact>");
  3. advance the contact's stage `lead → qualified` (only forward, never regress).
  Idempotent-by-outcome: re-converting reuses the matched company and returns the
  existing open deal for this contact+company instead of duplicating it.
- Also exposed as the `convert-contact` verb on `ctx.features.crm` + a v1.2.0 node, so
  chains can convert (deterministic deal id from `runId:nodeId` per ADR 0162).
- Emits `host.crm.contact.converted` (+ the deal/company created events) + audit.

### 4. Routing — chains, not a rules engine

Routing policy is **workflow configuration**: the `crm-ops.route-new-lead` chain
(ADR 0208) bound to `host.crm.contact.created`. The chain triages, assigns an owner via
the `update-contact-owner` verb (owner from chain params), creates a follow-up task, and
notifies. Exceptions live in the run feed. No routing rules engine, no SLA store — the
run log IS the routing audit (research doc E2 acceptance: assignment + notification are
observable per-lead as a run).

## Alternatives rejected

- **Hard-delete on merge** — loses provenance and dangles external ids; tombstone keeps
  the research doc's "reversible audit trail" satisfiable (provenance + relink journal in
  the audit ledger).
- **Fuzzy duplicate detection** — out of scope for a reference host; exact keys only
  (the import dedupe precedent), UI frames it as "exact matches".
- **A routing-rule store** — the failure mode ADR 0200/#insights taught: parallel
  config surfaces drift. Chains + params are the policy surface.

## Open questions

- [ ] Undo-merge (re-materialize the tombstone + re-split references) — deferred until a
  consumer asks; the tombstone preserves enough to build it.
- [ ] Round-robin/capacity-aware assignment — needs member enumeration + counters;
  deferred (ADR 0208 OQ).

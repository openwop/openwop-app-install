# ADR 0264 — CDP-B: Probabilistic match candidates, steward console & reversible merge/unmerge

**Status:** implemented (match candidates + merge-event audit + reversible unmerge + steward approval — all phases)
**Date:** 2026-07-05
**Depends on:** ADR 0262 (CDP program + rulings), ADR 0263 (CDP-A identifier graph), ADR 0008/0209 (CRM merge + tombstone), ADR 0198 (approvals — the gate this rides), ADR 0006 (RBAC), ADR 0031 (agentProfile — the steward persona)
**Part of:** CDP program (ADR 0262). CDP-B, Phase 2.

## Why this exists

CDP-A resolves customers deterministically by identifier. Real-world customer data also needs
**probabilistic reconciliation** (typo'd emails, name+address near-matches, phone variants) and a
**governed steward workflow** to review and, when wrong, **reverse** a merge. Today
`crm/crmMergeService.ts` is deterministic-only (its header explicitly rejects fuzzy matching, ADR
0209), merge is **one-way/lossy** (source fills survivor blanks, refs relinked, source tombstoned —
no snapshot), there is **no `unmerge`**, and merge is a plain RBAC'd route with no review queue.

## Decision

Add a **candidate generator** + **steward console** + **reversible merge**, extending CRM merge and
riding the existing approval seam (ADR 0262 ruling #5). **Auto-merge stays deterministic; fuzzy only
proposes.**

### 1. Match-candidate generator (proposes, never merges)

A host-internal `matchCandidates(tenantId)` producing scored candidate pairs over normalized
identifiers (email/phone normalization, name+company/domain similarity, shared device edge from the
CDP-A index). Output is a scored pair list that **feeds the existing `findDuplicateContacts` review
surface** — it never calls `mergeContacts`. Scoring/explanations are driven through a
`feature.crm.agents` **match-steward persona** (ADR 0058 chat-drivability) + a
`feature.crm.nodes` `match-candidates` node — no bespoke scoring UI.

### 2. Reversible merge (snapshot + merge-event)

Make merge lossless-reversible: at merge time capture a `crm:merge-event`
`{ survivorId, sourceId, fieldDiffs, relinkedRefIds, mergedAt, actor }` **before** mutation, then
add `unmergeContacts(mergeEventId)` that replays it — restoring the source contact, its identifiers
(re-indexed via CDP-A), and re-pointing the relinked refs. Guarded by the existing merge CAS +
post-write re-check; a failed unmerge fails closed (never leaves a half-split graph).

### 3. Steward console + role

Route merge / unmerge / match-override through the **existing `approvalService` (ADR 0198)** as a
`kind:'contact-merge'` variant surfaced in the ApprovalsInbox — **not** a new queue. A `steward`
capability (RBAC scope on the CRM feature) gates decisions; the steward agent can triage the
candidate queue and *propose*, a human *disposes*. Full audit via the ADR 0262 `governance.decision.*`
namespace.

## Scope / non-goals

- No ML training — the generator is deterministic similarity scoring (explainable, replay-stable),
  not a learned model. A learned matcher is a later, honestly-separate track.
- Deterministic exact-key merge (`crmMergeService`) is unchanged and remains the only auto-merge.

## Phased plan

1. `crm:merge-event` capture + `unmergeContacts` (CAS + re-check + CDP-A reindex).
2. `matchCandidates` + `match-candidates` node + match-steward agent pack.
3. `contact-merge` approval variant + steward RBAC scope + inbox card + FE candidate/steward views.
4. Verify: route-level tests (unmerge round-trip; concurrent merge/unmerge; auto-merge stays deterministic).

## Open questions

- [ ] Candidate score threshold surfaced as a tenant config vs fixed default. Default: fixed, tunable later.
- [ ] Retain merge-events under which retention window — inherit CRM (ADR 0077). Default: inherit.

## Consequences

Customer data gets a governed, reversible reconciliation loop without an auto-merge risk and without
a second approval or steward system. The cost is the merge path maintaining a snapshot; the benefit
is that a bad merge is a one-call undo with a full audit trail — the enterprise trust property the
market PRD calls out as under-served.

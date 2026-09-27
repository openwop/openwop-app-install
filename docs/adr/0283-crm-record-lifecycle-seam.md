# ADR 0283 — CRM record-lifecycle seam (`host/crmRecordLifecycle.ts`)

Status: implemented

## Context

CRM entity deletion does not fan out. `deleteDeal` / `deleteCompany` / `deleteContact`
remove only their own row; every other feature holding that record's id keeps a dangling
soft reference. The concrete driver is **TERR-DATA-1** (`docs/DATA-ASSESSMENT-territories.md`,
Blocker): `crm:territory-assignment.recordId` dangles after a deal/company delete until the
next `materializeAssignments`. The app-wide framing is **RI-2 / CRM-1** in
`docs/steward/DATA-ASSESSMENT.md` and **DG-INT-2** in `docs/research/data-gaps.md` — CRM is the app's
widest orphan producer (contactId survives across email engagement, journey enrollments,
forms, commerce orders, analytics links, tasks, activities).

Why the existing mechanisms can't carry this:

- **`crmMutated` host events** (`features/crm/emit.ts`) are webhook / host-event **egress**
  only — there is no in-process subscription seam, and coupling intra-process cleanup to the
  durable event-delivery pipeline would give cleanup at-least-once *external* semantics for
  an *internal* concern.
- **Direct import** (territories ← crm delete paths) inverts the dependency: crm is lower
  than every consumer; importing consumers from crm is a cycle (the exact reasoning that
  produced `commerce/productLifecycleSeam.ts`, #1337).
- **The eraser/purger registries** are subject-/age-keyed, not record-keyed — wrong shape.

## Decision

A host-owned, in-process, keyed-registry seam — the CRM sibling of
`commerce/productLifecycleSeam.ts` and the write-side companion of
`host/crmRecordVisibility.ts`:

- `host/crmRecordLifecycle.ts`: `onCrmRecordDeleted(key, handler)` +
  `fireCrmRecordDeleted({tenantId, orgId?, entity: 'contact'|'company'|'deal', recordId})`.
- **Keyed registration** (a Map): repeated boots overwrite the same slot — idempotent by
  construction, matching the product seam, deliberately NOT the array-`includes` shape of
  `subjectErasure.ts` (which can stack duplicate closures across test `createApp` cycles).
- **Fired AFTER the row delete succeeds** (fail-closed partial-failure ordering: the parent
  is already unreachable; a failed handler leaves re-prunable orphans, never a resurrected
  record).
- **Sync-await, best-effort, never throws**; returns the ran-count for observability.
  Handlers must be idempotent and bounded (indexed/point reads only).
- **Replay-safe by construction**: CRM deletes happen on REST paths outside runs; nothing
  is stamped on or read from `run.metadata`.
- Host-extension only — no wire surface, no RFC (per CLAUDE.md; the seam and its consumers
  are invisible to the OpenWOP protocol).

First consumer (ships with the seam so the ADR is witnessed, not speculative):
**territories** registers a pruner (`features/territories/lifecycle.ts` →
`pruneAssignmentsForRecord`) that drops assignment rows across all models for a deleted
deal/company — one tenant-indexed scan + point deletes. Registered unconditionally at boot
(like the visibility resolver): it only deletes the feature's own soft-reference rows, so it
is safe with the toggle off. Contacts are not assignment targets → contact events no-op.

## Alternatives weighed

1. **Ride `crmMutated` through a new in-process event bus** — rejected: builds a second
   pub/sub beside the host-event dispatcher for one consumer class; the keyed-registry
   pattern is already proven twice (product seam, visibility resolver).
2. **Periodic orphan-sweep daemon instead of event-time pruning** — rejected as the primary
   mechanism (orphans visible between sweeps; a sweep still needs per-feature knowledge =
   the same registry), though a backfill sweep remains the right one-time repair for
   pre-existing orphans (see below).
3. **Synchronous direct calls from CRM routes to each consumer** — rejected: N cross-feature
   imports in crm, the boundary violation this seam exists to avoid.

## Consequences / follow-ups

- Pre-existing orphans are NOT retroactively cleaned by an event-time seam. Repair:
  `PROBE-1`/`PROBE-2` in `docs/steward/DATA-ASSESSMENT.md` size the backlog; a one-time
  `materializeAssignments` per active model (already re-prunes) covers territories.
- Candidate next consumers (each its own small change, registering into this seam):
  csm `crmRef` invalidation on company delete; forms/email/journey contactId scrubbing or
  tolerate-on-read documentation (CRM-1 path-to-A+ in `docs/steward/DATA-ASSESSMENT.md`).
- The per-delete cost is one handler pass; each handler must stay bounded — a consumer that
  needs a cross-tenant scan is a design smell to reject at review.

## Phase → artifact

| Phase | Artifact |
|---|---|
| Seam + CRM call sites + territories pruner + e2e tests | this PR (`host/crmRecordLifecycle.ts`, `crm/entities/{deals,companies}.ts`, `crm/contactsService.ts`, `territories/{lifecycle.ts,entities/assignment.ts}`, `test/crm-record-lifecycle.test.ts`) |
| Contact-graph consumers | follow-up per CRM-1 |

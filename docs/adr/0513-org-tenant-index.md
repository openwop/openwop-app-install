# ADR 0513 — Tenant-key the `access-orgs` collection to retire a cross-tenant scan

Status: Superseded by its own correction note (see § CORRECTION) — the decision below was wrong; the fix shipped is one constructor argument


## CORRECTION (2026-08-02) — the decision above was wrong, and the alternatives section is where it went wrong

**Everything below this note is preserved as written. The re-key never happened and
must not.**

`DurableCollection` already takes a **`tenantOf`** argument that maintains a tenant
secondary index in a separate `hostextidx:` keyspace:

- `listForTenantIndexed(tenantId)` — bounded read of one tenant's slice
- `ensureTenantIndex()` — backfills legacy rows once, behind a sentinel
- stale markers self-heal; **concurrent backfills are harmless because marker
  writes are idempotent** — which is exactly the `APP_MIGRATIONS` concurrency
  clause I was designing around

And its docstring already states the property this ADR spent four phases trying to
buy: *"this does NOT re-key the primary rows … so there is no data migration on the
primary store and no data-loss risk."*

It is not obscure. It is in production use by `analytics`, `cms`, `commerce`, CRM
`companies` and `deals`.

**The real fix is one constructor argument and one method swap.** Phases 1b–4 —
migration, dual-read, parity verification, held-back delete — are all unnecessary.

### How the ADR got it wrong

The `/architect` contract leads with *"audit what already exists before claiming
anything is missing OR new."* I audited two things — that `listByPrefix` exists, and
that 207 collections put the tenant in their key — and designed around them. **I never
searched for a tenant-index seam by name.** Both facts I gathered were true and both
pointed at re-keying, so the framing confirmed itself.

The tell was in the ADR's own "Alternatives rejected" section: I rejected a *"secondary
index collection"* on the grounds that it would create "a second source of truth for
membership that can drift". That is a fair critique of a hand-rolled index — and the
platform's built-in one answers it directly (self-healing markers, sentinel-guarded
backfill, primary rows untouched). **I rejected the right shape because I only imagined
the worst version of it.**

### The sharpest version of the miss

`tenantOf` was not merely "somewhere in the platform". **The `members` collection twelve
lines below `orgs`, in the same file I was editing, has used it since 2026-07-19** —
two weeks — under ADR 0434 / IDN-7, for the same reason (`isWorkspaceMember` needed a
bounded scan instead of a cross-tenant `list()` on every authenticated request). Its
comment states my own conclusion verbatim: *"The primary rows are NOT re-keyed, so there
is no migration and no data-loss risk."*

I read this file closely while authoring the ADR — enumerated every `orgs.*` call site,
traced `getWorkspace`, `updateOrg`, `deleteOrg` and the erasure loop. **I never looked at
the collection declared beneath the one I was designing a migration for.** I searched
*within* my framing (does a prefix scan exist? do collections tenant-key?) instead of
checking the framing (has this exact problem been solved here already?).

The generalisable form: **a thorough audit inside a wrong frame reads exactly like a
thorough audit.** Depth of investigation is not evidence the question is right.

### What survives

**Phase 1a stands on its own merits** — it routed four bypassing reads (`getWorkspace`,
`updateOrg`, `deleteOrg`, the erasure loop) through the accessors and retired a
cross-tenant scan on the ERASURE path, where a missed row leaves a subject's identifier
behind after they asked for it gone. It was *justified* partly as "the precondition for
Phase 2's dual-read"; that justification is void, the change is not.

The two open questions were still worth asking, and one of them is what surfaced the
bypasses.

## Context

`listOrgs(tenantId)` (`host/accessControlService.ts:366`) is:

```ts
return (await orgs.list()).filter((o) => o.tenantId === tenantId)…
```

`DurableCollection.list()` is a **full cross-tenant scan** — CLAUDE.md names it
explicitly as the thing to avoid on a hot path. Every tenant's org lookup reads
every org row of every tenant and discards almost all of them.

This is tracked as `GC-0308-1` and has sat open because the obvious fix is not
the small one it looks like.

**Reachability makes it worth doing.** `listOrgs` is referenced from 54 backend
files, and on the frontend it is on the load path of most org-scoped pages —
including the canvas surfaces that ADR 0310's chassis serves. It is not a cold
admin call.

## The constraint that makes this an ADR

`DurableCollection` already offers `listByPrefix(idPrefix)`, and it is genuinely
index-backed: `host_ext_kv_k_pattern ON host_ext_kv (k text_pattern_ops)` turns
a prefix `LIKE` into a range scan (~5ms) — added after the incident where the
same query was a full sequential scan. **207 collection declarations already put
the tenant in the key.** So the pattern, the index, and the precedent all exist.

`access-orgs` does not use it:

```ts
const orgs = new DurableCollection<Organization>('access-orgs', (o) => o.orgId);
```

The id function **is** the storage key. Changing it to `${tenantId}:${orgId}`
does not "add an index" — it **moves every row**. Existing orgs stay at the old
keys and become invisible to the new reads. In a tenancy system, rows that
silently stop resolving are not a performance regression, they are an outage
that looks like an empty state — the exact failure family this codebase has
spent weeks removing.

## Decision

Re-key `access-orgs` to `${tenantId}:${orgId}` and read via `listByPrefix`,
**behind a forward-only migration that moves existing rows**, sequenced so that
no window exists where a read can miss a row.

Rejected alternatives:

- **Secondary index collection** (`tenant → orgId[]`). No migration, but creates
  a second source of truth for membership that can drift from the rows it
  indexes, and every write becomes two writes without a transaction spanning
  them. Two systems for one concept is the outcome this repo's boundary rule
  exists to prevent.
- **In-memory cache keyed by tenant.** Cheapest, and wrong: the invalidation
  surface is every org mutation across 54 call sites, and a stale org list is a
  membership answer — the class of thing that must not be quietly wrong.
- **Leave it.** Defensible today at demo scale, and the honest reason it has
  survived. It stops being defensible as tenant count grows, and the cost of the
  migration only rises with the row count.

## Implementation plan

| Phase | Work | Gate |
|---|---|---|
| 1 | Add `LATEST_SCHEMA_VERSION` + `APP_MIGRATIONS` entry that copies each `access-orgs` row to its tenant-prefixed key, leaving the original in place | `check-migration-integrity` green; migration is re-runnable (MIG-LOCK-1) |
| 2 | Switch `listOrgs` to `listByPrefix(`${tenantId}:`)`; keep `getOrg(orgId)` resolving BOTH key shapes | route tests for org listing; a test asserting an org written under the OLD key is still readable |
| 3 | Backfill verification: a test that counts rows under both shapes and asserts parity | fails loudly rather than silently under-reporting |
| 4 | Delete the old-key rows and the dual-read fallback | only once phase 3 has been green across a deploy |

Phases 1–3 are safe to ship together. **Phase 4 must not ship in the same
release** — it is the only irreversible step, and its precondition is evidence
from a real deploy, not a green test.

## Consequences

- `listOrgs` becomes a range scan instead of a full-collection read.
- `getOrg(orgId)` carries a dual-read until phase 4; that is deliberate, and the
  cost of removing it early is unresolvable rows.
- A migration entry is added, so the next release is **≥ minor** for
  `/cut-app-release`.

## Open questions

1. Are there org reads that bypass `listOrgs`/`getOrg` and hit `orgs.get()`
   directly with a bare `orgId`? Phase 2 must enumerate them; a missed one is a
   row that stops resolving.
2. Does any export/backup path serialize the storage key itself rather than the
   `orgId` field? If so the key change is observable outside the process.

## Not decided here

Whether the same treatment is owed to other `list()`-then-filter collections.
This ADR deliberately scopes to `access-orgs`, which has the evidence behind it;
generalising without measuring each one would be the "fix the shape" reflex
applied without the shape being verified.

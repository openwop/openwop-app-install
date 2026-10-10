# ADR 0866 — Access summary: a deploy-safe connections index, and endpoint counts

Status: implemented

Closes the two open questions ADR 0864 left: Connections are still counted by a
full cross-tenant scan, and Endpoints show no count.

## Context

**Connections.** `connections:connection` has no tenant index, so every read for
one tenant (`listConnections`, and the egress selection that runs on each
connector call: `selectAuthorizedConnection`, `resolveProvider(s)ForCapability`)
scans every tenant's rows. `DurableCollection` already supports a tenant index,
with a one-shot backfill on first indexed read guarded by a sentinel.

That backfill is not safe for a store that gains the index in a deploy. The
superseded revision keeps serving for up to an hour after the traffic shift
(WHD-28 measured about 55 minutes), and its code writes rows with no index
marker. Once the new revision's backfill has set the sentinel, it never runs
again, so a connection created on the old revision in that window is invisible
to every indexed read, permanently. For the panel that is a missing row; for
egress selection it is a connector that cannot find its credential.

**Endpoints.** ADR 0864 D5 skipped the count because authority is per org and
the store is env-gated. But the Endpoints panel already lists the tenant's orgs
(`GET /orgs`) in its picker and reads each with `GET /compat-endpoints?orgId=`.
The union of what the panel can show is well defined.

## Decision

**D1 — Adoption, not a one-shot backfill.** A collection that gains `tenantOf`
can register for adoption (`registerTenantIndexAdoption`). An hourly pass
(`DurableCollection.reconcileTenantIndex`), run from the retention tick under a
per-collection lease:

- writes a marker for every row that lacks one;
- records `since` the first time it runs (set-if-absent; a later `since` only
  delays verification, so it is always safe);
- marks the index **verified** when a pass *listed the rows* at least `window`
  after `since` (`OPENWOP_INDEX_ADOPTION_WINDOW_MIN`, default 180). Any
  pre-index writer has stopped serving by then, and its rows were in that list.
- **un-verifies** when a later pass still finds an unmarked row (a rollback to
  pre-index code, or a tagged old revision that stayed routable), restarting
  the window from that pass. The `tenant_index_unindexed_writer` warning is the
  evidence.

Reads use the index only while it is verified, and keep the full scan otherwise.
So nothing a pre-index revision writes is ever invisible during a deploy. After a
rollback the exposure is at most one tick (an hour), and it ends with the reads
falling back to the scan.

**D2 — Which connection reads move.** The read and select paths move:
`listConnections`, `selectAuthorizedConnection`, `resolveProviderForCapability`
and `resolveProvidersForCapability`, through one `tenantRows(tenantId)` helper.

These stay on the full scan:
- teardown (`listTenantConnectionIds`) and DSAR erasure
  (`eraseSubjectConnections`), where a miss is a permanent orphan;
- the identity lookup on connect (`findByIdentity`), where a miss mints a
  duplicate row;
- the refresh daemon's host-wide due-list.

**D3 — Endpoints are counted across the orgs the caller can read.**
`countReadableCompatEndpoints(req, orgIds)` lives beside the routes. It applies
the env gate (404 → the summary omits the section) and then, per org, GET's own
`requireOrgScope(…, 'workspace:read')`. An org it refuses (403) is skipped, as
the panel's GET would refuse it. The org list is `listCallerOrgs`, the same list
the panel's picker shows. Above 50 orgs it returns `null` and the summary omits
the count rather than under-report it. No summary card: the four ADR 0864 cards
are unchanged.

## Alternatives weighed

- **Re-run the one-shot backfill on every boot.** It still misses a row the old
  revision writes after the new one's last boot.
- **Two deploys (expand/contract): write markers in N, read the index in N+1.**
  Correct only if no pre-N instance survives two deploys. It also depends on an
  operator remembering the order, and does nothing for a rollback.
- **An instance registry, with reads waiting until no pre-index writer is
  alive.** A pre-index revision runs code that cannot announce itself, so the
  registry cannot see the writers that matter.
- **Self-healing reads (index, plus a scan when a count looks off).** No cheap
  signal says "off": the case is precisely a row the index does not know about.

## Implementation record

| Phase | Where | Witness |
|---|---|---|
| D1 | `host/hostExtPersistence.ts` (`tenantIndexVerified`, `reconcileTenantIndex`), `host/tenantIndexAdoption.ts`, the retention tick | `hostext-tenant-index-adoption.test.ts` (5). Sabotage: verifying on the first pass reds the deploy-overlap leg; dropping the reset reds the rollback leg. |
| D2 | `features/connections/connectionsService.ts` (`tenantOf`, `tenantRows`) | `access-hub-summary-route.test.ts`: the same counts before and after verification, and a pass after a late pre-index write resets |
| D3 | `routes/compatEndpoints.ts` (`countReadableCompatEndpoints`), `features/access-hub/summary.ts`, SPA `accessSummary.ts` | route test: omitted with the gate off; equal to the sum of GET over every org in `/orgs`; another tenant counts 0. `accessSummaryView.test.ts` |

The lease is one kv row per collection holding the last hour slot, taken by
compare-and-swap. It is not the fire-once mutex, so it adds nothing to prune and
stays off the ADR 0549 mutex allowlist. The pass never deletes, so it is not a
destructive lane for the ADR 0657 census.

## Open questions

- [ ] Other collections that read with `list()` + a tenant filter can adopt the
  same way. Each needs its own D2 split: reads move, teardown and uniqueness
  checks stay.
- [ ] A hold on tagged old revisions: D1 detects such a writer after the fact
  (and un-verifies). It does not prevent one.

> **Integration correction 2026-10-09:** the hourly slot is not a lock for a pass that exceeds an hour. Verification now compares-and-swaps its exact starting metadata, so a delayed pass cannot overwrite a concurrent reset. Malformed timestamps are unverified and repaired conservatively. Regression witnesses cover both cases. Rollback visibility still has the documented one-tick exposure; erasure and uniqueness retain full scans.

> **Correction 2026-10-09 (first production run, rev 00924):** the pass that verified the index logged nothing, because a pass logged only when it repaired or skipped a row. The logs could not tell adoption apart from a stopped tick. Now every pass logs `tenant_index_reconciled`, and the pass that flips verification also logs `tenant_index_verified` once (`verifiedNow`, witnessed in `hostext-tenant-index-adoption.test.ts`). Reported by a peer session reading the 20:38Z–22:38Z ticks.

# ADR 0681 — A test named for eight routes that covers two, and a doctrine FAIL that is stale

Status: **implemented** (status corrected 2026-09-17 — see § Status correction)
Date: 2026-09-14
Feature loop 2026-09, iteration 31 (Knowledge sync, `FEATURES.md` ordinal 31)
Gap ids: `KSWF-10` (refined + upgraded), `KSWF-21` (new), `KSWF-12` re-verified; `KSWF-17` corroborated

## D1 (Blocker, `KSWF-10` refined) — `404s every route while the toggle is OFF` covers 2 of 8

`test/knowledge-sync.test.ts:143` is titled **"404s every route while the toggle is OFF"** and
its body is:
```ts
expect((await c.get(`${KS}?orgId=${orgId}`)).status).toBe(404);
expect((await c.post(KS, { orgId })).status).toBe(404);
```
**MEASURED — the feature registers EIGHT routes** (`features/knowledge-sync/routes.ts`):

| # | route | covered by the toggle test? |
|---|---|---|
| 1 | `POST   /knowledge-sync` (create) | ✅ |
| 2 | `GET    /knowledge-sync` (list) | ✅ |
| 3 | `GET    /knowledge-sync/browse` | ✅ *(by the NEXT test, not this one)* |
| 4 | `GET    /knowledge-sync/:id` | ❌ |
| 5 | `DELETE /knowledge-sync/:id` | ❌ **destructive** |
| 6 | `POST   /knowledge-sync/:id/:action` | ❌ **mutating** |
| 7 | `PATCH  /knowledge-sync/:id` | ❌ **mutating** |
| 8 | `POST   /knowledge-sync/:id/sync` | ❌ **triggers a real sync pass + spend** |

> **CORRECTED before implementation — I nearly shipped an overstated count.** The table above is
> accurate for the test that NAMES the population (it walks 2 of 8). But measuring toggle-OFF
> requests across the WHOLE file, `/browse` is covered by the very next test — so feature-wide
> coverage is **3 of 8**, and the real gap is **5 routes, not 6**. The check that caught it:
> enumerate every request made inside an `enableToggle(false)` window across the file, not just
> inside the test whose name makes the claim.

So **five** routes — four of them mutating or destructive (`DELETE`, `POST /:id/:action`,
`PATCH`, `POST /:id/sync`) plus `GET /:id` — have **no toggle-gate coverage**, behind a test
whose name asserts the whole population. This is the vacuous-breadth family this loop
keeps finding: *the name states a population the body does not walk*, so the gap is invisible to
anyone reading the test list rather than the test.

**`KSWF-10` as filed is partly STALE and partly UNDERSTATED, in opposite directions.** It says
the manual route *"has **no test at all** — not the toggle gate, not the org scope"*. The
feature's routes **are** covered by two files (`knowledge-sync.test.ts`,
`knowledge-sync-connection-owner.test.ts`) — so "no test at all" is false for the feature. But
**no test POSTs `/:id/sync` anywhere**, so it is exactly true for that route; and the row never
noticed that five *other* routes share the gap. The real finding is bigger than the row and
smaller than its wording.

**Decision:** drive the toggle-OFF assertion from the route table itself rather than a hand-
written pair, so a route added later is covered by construction and the test's name becomes
true. Add the org-scope leg for the manual sync route specifically.

**Witness:** the toggle test walks all nine route entries (eight registrations — the
`pause`/`resume` loop is one `app.post` for two routes); a count leg asserts the table matches
the registrations in `routes.ts`, so adding a route without covering it fails rather than
silently shrinking the proportion the name claims.

> **THE MOST IMPORTANT RESULT OF THIS ITERATION — my own witness was VACUOUS, and the sabotage
> caught it.** The first version asserted only `status === 404`. Removing
> `requireFeatureEnabled` from `POST /:id/sync` entirely left **all 16 tests GREEN**, because
> `ks-1` does not exist and the handler 404s on *"Sync source not found."* regardless of the
> toggle. **The assertion could not distinguish "404 because the toggle is off" from "404
> because the resource is missing"** — so it would have shipped as coverage that proves nothing,
> on the exact routes the ADR exists to protect.
>
> Both paths throw `not_found` with 404, so neither the status nor the error code separates
> them. What does is the toggle-off message, which names the feature
> (`features/featureRoute.ts:41` — *"<label> is not enabled for this tenant."*). The leg now
> asserts that, and the sabotage fails with the diagnostic it should:
> `expected 'Sync source not found.' to match /is not enabled for this tenant/i`.
>
> **Generalisable:** when the gate you are testing and the failure you provoke share a status
> code, the status code is not evidence. This is the same shape as the corpus-wide
> "empty-plus-exit-0" tell — an assertion that cannot fail for the reason it names.

**Also measured while proving this: the gate itself is NOT broken.** All nine routes already
404 correctly with the toggle off. The defect closed here is coverage, not behaviour, and the
ADR says so rather than implying a live hole.

## D2 (`KSWF-21`, NEW — documentation honesty) — the doctrine FAIL is stale, and the row contradicts itself

The summary row (`WORKFLOWS-ASSESSMENT.md:60`) reads **"D → C … — still doctrine FAIL"** and, in
the *same row*, **"`KSWF-1` CLOSED 2026-08-31"**. The section header (`:10200`) also still says
**doctrine FAIL**. Both cannot be true.

**VERIFIED INDEPENDENTLY at this commit — doctrine PASSES:**
- a real `kind:"workflow-chain"` pack exists: `core.openwop.workflows.knowledge-sync` v1.0.0,
  chain `knowledge-sync.run`, one node `feature.knowledge-sync.nodes.run`;
- **zero pin sites** in the feature — `registerWorkflow(`, `builtinWorkflows`,
  `registerHostWorkflow(` all return nothing under `features/knowledge-sync/`;
- registration is the sanctioned runtime lane, paired in one function
  (`knowledgeSyncService.ts:371-375`): `expandChain(found.chain, {params:{sourceId}})` →
  `registerWorkflowDurable(def)` → `recordOwnership(tenantId, workflowId, …)`.

**And it is better than the reference I graded five iterations ago.** It uses the **awaited**
`registerWorkflowDurable`, not the fire-and-forget `registerWorkflow` — which is precisely the
second half of `SPWF-9` that ADR 0676 filed as still-open against the strategy cadence lane.
Knowledge sync already does the thing strategy does not.

**Why this matters enough to be its own row:** a stale "doctrine FAIL" is not cosmetic. The
grading rubric makes chains-or-stacks a **gate** — *"a hard-coded workflow that compiles +
resolves by id caps the affected area at D"* — so every future pass reads this feature as capped,
and the closeout's own `D → C` regrade is inconsistent with the FAIL it simultaneously asserts.
The [[past-tense-claims-outlive-code]] family, on the artifact that decides a grade.

**Decision:** correct both sites, record the verification that supports the new state, and
re-grade on the evidence rather than inheriting either number.

## Re-verified, not fixed

- **`KSWF-12` — no reverse cascade from KB.** Confirmed: `features/kb/kbService.ts` mentions
  knowledge-sync in **comments only** (`:69`, `:1869`, `:2079`, `:2319`) — there is no call into
  the sync feature. Deleting a KB collection leaves `SyncSource` rows pointing at a vanished
  collection. Real, and a cross-feature cascade decision (which owner runs it) larger than this
  iteration — the ADR 0676 `SPWF-10` ruling applies: file with the mechanism, do not scope a
  cross-feature seam inside a single-feature pass.
- **`KSWF-17` corroborated independently.** The row says two adjacent sections carry ordinals
  that disagree with `FEATURES.md`. I hit exactly this in iteration 29 without having read the
  row: the Podcasts section is titled *"feature 31/71"* while the loop tracker's ordinal for
  Podcasts is 29. Two observers reaching it separately is the argument for fixing the ordinals
  rather than carrying the row.
- **Sibling-lane classification check: CLEAN** — `feature.knowledge-sync.nodes.run` already
  declares `capabilities: ["side-effectful"]`. Third clean result in five iterations; recorded as
  a negative so the next pass does not re-spend it.

## RFC verdict

**Host + test work, no RFC.** D1 is test coverage; D2 is documentation. No wire facet, no pack
version change, no manifest edit — so no re-attestation and no registry republish.

## Open question

D1's route-table-driven assertion needs the route list to be enumerable. If `routes.ts` does not
export one, the witness reads the registrations out of the source text — which is weaker than a
runtime enumeration and should say so rather than pretend otherwise.

## Status correction (2026-09-17)

Read `Status: Proposed` while implemented and merged. Evidence: `#3820`
*"test(knowledge-sync): gate coverage on every route + correct a stale doctrine FAIL
(ADR 0681)"*, and D1 is carried in the tree at `test/knowledge-sync.test.ts:144`
(with the ADR's own Open Question recorded at `:199`).

**Found by the new ratchet, not by the sweep that prompted it.** A human pass checked
five records and stopped; `adr-status-not-stale.test.ts` read every ADR and found a
sixth on its first run. That is the argument for the ratchet over the sweep: the sweep
fixes the instances you thought to look at.


# ADR 0440 — Builder round-trip fidelity, a write guard for referenced definitions, and one node-catalog source of truth

Status: **implemented** (P1–P3, 2026-07-19; record below)

**Requirements source:** an architecture review of the builder node-catalog gap found while implementing ADR 0435, plus a live falsifiability probe against a running host that overturned the review's first diagnosis (recorded below — the reasoning trail is the point).
**Depends on:** ADR 0369 (workflow lifecycle: runs replay/fork by RE-RESOLVING the definition, no per-run snapshot), ADR 0163 (per-tenant workflow ownership), ADR 0435 (which made walkthroughs builder-openable and thereby made P1 reachable).
**Surface:** SPA (builder serialize/deserialize + catalog registry) + one host-extension route guard. **NO new RFC** — nothing here changes the wire; P1 makes the host *more* faithful to the existing `workflow-definition.schema.json`, which is the opposite of a wire risk.

## Why this exists

Two user-visible bugs, one root cause, and one live regression.

**The reported symptom.** A workflow containing a host-registered (`source: 'local'`) node type cannot be opened in the builder at all — `deserialize` throws `errCantLoadNodeTypes`. Verified live: both `workflow-author-examples` showcase workflows fail to open on `local.sample.demo.mock-ai`, directly contradicting that seeder's stated purpose ("so a visitor has something runnable to open in the builder"). At the time of writing **37** registered node types are affected, including `core.subWorkflow`, `core.dispatch`, `core.interrupt`, `core.fail`, all seven `core.openwop.connectors.*`, and seven `app-builder.mcp-node.*`.

**The cause.** Two catalogs model one concept and neither is authoritative: the server's `buildNodeCatalog()` (743 rows, knows every registered type) and the frontend's hand-maintained `NODE_CATALOG` (10 typeIds). `catalogRegistry.loadDynamicCatalog()` ingests only rows with `source: 'pack'`, so host-registered types resolve **only** from the static list — and anything absent from it is un-openable. Nothing reconciles the two and no test asserts parity, so every new host-registered node type silently joins the broken set. ADR 0435 patched two entries by hand; that treated the symptom.

**The regression this surfaced.** Making walkthroughs openable exposed that a builder *open* is not read-only. Saving is a **1.5s debounced autosave** on any store edit (`builderStore.ts:51`) — no explicit Save. A probe on a seeded walkthrough, triggered by renaming the workflow and touching nothing else, produced:

| | before | after |
| --- | --- | --- |
| `nodes[].nodeId` | `t1 t2 t3 t4 t5` | `ui_walkthrough_step_0 … _4` |
| `metadata.walkthrough` | `true` | **`undefined`** |
| `nodes[].outputRole` | `primary` | **dropped** |

`metadata.walkthrough` is exactly what `features/walkthroughs/surface.ts` gates `isWalkthrough()` on, so after a single builder touch `ctx.features.walkthroughs.listWalkthroughs` stops returning that walkthrough and an onboarding workflow asking "has the tenant completed the intro walkthrough?" silently mis-reads. **The `/walkthroughs` page still lists it** (it filters on the `workflowId` prefix, not the flag) — so the damage is invisible where a user would look.

### Correction to the review's first diagnosis (kept deliberately)

The review initially blamed the builder for dropping eleven wire-modelled node properties (`agent`, `credentialsRef`, `outputSensitivity`, `envelopeContract`, …) and rated that CRITICAL. **That was wrong.** A live probe planted a node carrying those fields; the *stored* definition already lacked them. `validateWorkflowDefinition` (`host/workflowDefinitionValidation.ts`) returns a **five-field whitelist** — `nodeId`, `typeId`, `config`, `inputs`, `outputRole` — so the loss happens at the host's own POST route, before the builder is involved. The builder's four-field `BackendNode` mirrors a loss that already happened.

The residue is real but narrow and currently latent: chain expansion, builtins, and seeders call `registerWorkflow` **directly**, bypassing that validator, so those definitions *can* carry richer fields, and a builder autosave would launder them through POST and strip them. The executor does honor `nodeRef.agent` (`executor/executor.ts:530`). A sweep of the shipped packs found **no** node currently carrying `agent` / `credentialsRef` / `outputSensitivity` / `settings`, so no live data is affected today. Widening the validator's whitelist is therefore **explicitly out of scope here** — it is a separate decision with its own blast radius, tracked in Open questions.

That whitelist has already caused one production bug: the CHAINX-5 safety-fix comment in the validator records that dropping `inputs` silently discarded the RFC 0013 `{{params.*}}`-in-`inputs` substitution. The shape that caused it is unchanged.

## Boundaries audit (verified against live code)

- **One owner for "what node types exist": the backend.** `buildNodeCatalog()` already enumerates the in-process `NodeRegistry` plus pack manifests and de-duplicates preferring `pack`. Per `ARCHITECTURE.md` the backend is the authority; a hand-maintained frontend list that *gates existence* is the parallel-system smell. The static list keeps a legitimate but demoted job: **presentation metadata** (label, badge, accent, curated config fields) keyed by typeId.
- **No new route, no new store.** P2 adds a guard inside the existing `POST /v1/host/openwop-app/workflows` handler; P1/P3 are frontend-only.
- **No second lifecycle model.** The referenced-definition invariant already exists and is already enforced on DELETE (`routes/workflows.ts`, `workflow_referenced` 409). P2 applies the *same* invariant to the write path — it does not invent one.
- **Precedence drift to settle.** `catalogRegistry.ts` documents "`catalogEntry(kind)` returns dynamic before static when both exist"; the implementation is the inverse (`STATIC_BY_KIND.get(kind) ?? dynamicByKind.get(kind)`). The two ADR 0435 walkthrough entries therefore permanently shadow the server's rows. Doc and code must agree.

## Decision

Three phases. **P1 gates P3** — widening what the builder will open, before fixing what it writes, would trade a loud safe failure for a silent unsafe one.

### P1 — Round-trip fidelity (blocking)

The builder must not destroy what it did not author.

1. **Preserve metadata — the builder currently has nowhere to put it.** `SavedWorkflow` (`schema/workflow.ts`) declares `name`, `nodes`, `edges`, `lifecycle` and **no `metadata` field**; `serialize.ts` never emits one. So `deserialize` discards the definition's metadata at import, and `backendStore.ts:180`'s `...(def).metadata` spread is spreading an object that is always absent — which is why the outgoing metadata contains only `name` + `lifecycle` and `walkthrough: true` disappears. The fix is a model change, not a merge fix: add `metadata` to `SavedWorkflow`, capture it in `deserialize`, emit it from `serialize`, and let `name`/`lifecycle` continue to override their own keys. `walkthrough`, `tour`, `showcase`, and `authoring` then survive. (ADR 0369 already established that `lifecycle` MUST round-trip; this generalizes the same rule to the rest of the object.) Note there are **two** POST call sites in `backendStore.ts` (:180 and :295) — both must carry it.
2. **Preserve `nodeId`.** `schema/serialize.ts` regenerates every id as `${safeKind}_${i}`. Carry the original id on `BuilderNode` and emit it; generate only for nodes the user actually added. Edge remapping already goes through `builderIdToBackend`, so preserving ids simplifies rather than complicates it.
3. **Read `outputRole` back.** `schema/deserialize.ts` builds the `BuilderNode` without it, so a field the serializer *can* emit is lost on import. Round-trip it.
4. **Test:** a property test asserting `deserialize(serialize(def)) ≡ def` over a fixture set that includes a seeded walkthrough (metadata flag + `t*` ids), a showcase workflow, and a node carrying `outputRole` + `inputs`.

### P2 — Guard the write path

`POST /v1/host/openwop-app/workflows` replaces a definition wholesale via `registerWorkflow(def)`. DELETE already refuses when runs reference the id, with the reason stated in its own comment: runs re-resolve by id and have no per-run snapshot. Apply the same invariant to overwrites that would **change the node-id set** of a referenced definition: refuse with `workflow_referenced` and point the author at archive-and-fork. A benign overwrite (same node ids) stays allowed, so ordinary editing is unaffected. Independent of P1/P3 and worth landing on its own.

> **Correction (implementation, 2026-07-19) — P2 ships as DISCLOSURE, not refusal.**
>
> The paragraph above rests on an analogy to the DELETE guard. A test written to
> falsify it (`backend/typescript/test/fork-after-node-removed.test.ts`) showed the
> analogy does not hold, so the refusal was **not** implemented.
>
> What the evidence showed: deleting a definition loses it for **every** run with no
> recourse — which is why DELETE's 409 is right, and why it names archive as the way
> out. An *edit* that drops a node is bounded and already fails closed: the executor
> looks the node up per-node (`executor.ts`), and a side-effecting node with no
> recorded outcome yields the typed `replay_source_missing` failure rather than
> re-firing. The test confirms the edit is accepted, the definition resolves in its
> new shape, and the historical run stays readable.
>
> Against that, refusing would have made **deleting a node from any workflow that has
> ever run impossible** — an ordinary authoring action — and the refusal would arrive
> ~1.5 s after a keystroke from an autosave the user never triggered, with no gesture
> to attach it to and no fork affordance in the builder to escape to. A refusal the
> user cannot satisfy is not a safety property; it is an outage.
>
> **Shipped instead:** the write stays allowed, and the route reports
> `removedReferencedNodeIds` when (and only when) a save drops nodes a run had
> recorded. The builder surfaces a non-blocking `<Notice variant="info">`
> (`RemovedReferencedNodesNotice`) naming them. The indexed run probe is gated on the
> node-id set actually shrinking, so the common autosave — rename, move, add — pays
> no extra database work. P1 had already removed the destructive case (wholesale
> renumbering on every save), which is what shrank P2 from a guard to a disclosure.

### P3 — One catalog source of truth

1. `loadDynamicCatalog()` ingests **every** server row, not just `source: 'pack'`. A `local` row carries `typeId`, `version`, `requiresHostSurfaces`, and `missingHostSurfaces` but no schemas, so it yields a node that opens and connects with an empty config-field set — degraded but honest, and strictly better than un-openable. Config round-trips verbatim on both sides (`deserialize` spreads `{...n.config}`, `serialize` emits it whole), so an absent `configSchema` costs Inspector fields, not data.
2. Demote `NODE_CATALOG` to a **presentation overlay**: richer static metadata wins for label/badge/accent/configFields; existence comes from the server. Fix `catalogEntry`/`catalogEntryByTypeId` precedence to match the documented contract, and drop the two ADR 0435 hand-entries once the general path covers them.

> **Correction (implementation, 2026-07-19) — two amendments to P3.**
>
> **(a) Resolution and visibility are separate concerns.** The plan above ingests
> every row into one map, which would also put conformance harness fixtures, the
> ADR 0376 replay-only `ui.tour.*` aliases, and seven `app-builder.mcp-node.*`
> internals into the **palette** — ~17 non-authorable entries, all categorised
> `flow` and labelled with raw typeIds. `catalogEntry`/`catalogEntryByTypeId` now
> resolve everything (unconditional — that is the bug being fixed), while
> `mergedCatalog()` filters `PALETTE_EXCLUDED`. So the exclusions map gates the
> palette, not merely the test, which is what keeps it honest. Measured live:
> FLOW went 48 → 71, not 48 → 85.
>
> **(b) The two ADR 0435 walkthrough entries STAY.** Dropping them was tried and
> reverted: walkthrough nodes then rendered as bare "Step"/"Checkpoint" with no
> config fields, because the backend carries no metadata for `local` rows by
> design. They were a *workaround* while they supplied existence; they are
> legitimate *overlay metadata* now that they do not. Their comment records the
> changed role.
>
> Also found while implementing: replacing the `continue`-on-static-entry with a
> merge fixed a latent gap — that skip discarded the server's
> `missingHostSurfaces` for **every** static node, so the builder could not warn
> that this host lacks a surface a node requires. `core.delay` is declared both
> statically and by a pack, and was losing its pack metadata to it.
3. **Parity test with acknowledged exclusions.** Assert every registered node type resolves in the builder, with an explicit `typeId → why not builder-facing` map for the legitimate exceptions (`conformance.*` harness fixtures; `ui.tour.*`, the ADR 0376 legacy aliases retained for replay). Modelled on `host/seedCoverage.ts` `ACKNOWLEDGED_UNSEEDED` — an exclusion is a recorded decision, not an oversight. That pattern has already caught a real regression.

## Alternatives weighed

- **Ingest `local` rows alone (the originally proposed fix).** Rejected as sequenced: it fixes the reported symptom while widening the set of workflows a user can open and silently damage. Today those workflows fail closed, which is why no data has been lost.
- **Keep the static list, add only a parity test.** Rejected: codifies the duplication and converts every new node type into a failing test plus a manual chore.
- **Open unmodelled-field workflows read-only.** Rejected as a permanent answer (a lasting UX wart), but it is the correct **containment** if P1 slips — see below.
- **Widen the validator whitelist to all 18 `WorkflowNode` properties.** Deliberately deferred. It is not a prerequisite for any phase here, it changes what the host persists for every author path, and it deserves its own ADR.

## Consequences

- A builder autosave stops silently unmarking walkthroughs and stops orphaning historical run events from their node ids.
- 37 node types become editable; ~13 of them (the `conformance.*` / `ui.tour.*` exclusions) stay deliberately hidden.
- Local-sourced nodes render with no Inspector config fields until their modules declare schemas. Honest and incremental; a follow-up can have `NodeRegistry` expose optional schemas so `buildNodeCatalog` emits them.
- P2 makes one previously-silent operation fail loudly. That is the point, but it is a behavior change for any tool that overwrites a referenced definition with regenerated ids — including the builder itself before P1 lands, which is why P1 ships first.

## Risks

- **P1.2 changes ids that some code may assume are regenerated.** Mitigated by the round-trip property test and by `serialize`'s existing id-map indirection.
- **P3.1 could surface unusable palette entries.** Mitigated by keeping `missingHostSurfaces` gating and by the exclusions map.
- **Containment if P1 slips:** remove the "Review" button from the walkthroughs page (ADR 0435), restoring fail-closed behavior for the seeded samples.

### P4 — Close the cross-tenant overwrite (the write half of M7)

The grade-pass on P2 closed a cross-tenant *read* channel it had opened, and its
comment named a *pre-existing* sibling hole as "separately tracked": the POST
route calls `registerWorkflow(def)` with no ownership check, and the registry is
global by id (`wfreg:${workflowId}`, no tenant component). So any tenant could
**overwrite** another tenant's definition by POSTing under its id — injecting its
own prompts, node config, and connection refs into every future run and `:fork`,
and minting a second ownership row so both tenants "own" the id.

A read-only prod probe found **zero** cross-tenant ownership collisions, so this
is a fix-forward (no cleanup): the hole exists but has not been exercised.

**READ** stays the M7 predicate: `isForeignOwned` refuses (404) an id owned by
another tenant, exempting the wildcard operator and the public-read namespaces
(`wf.seed.*` / `tmpl.*` / `openwop-app.*`). GET was refactored to call it as a
shared helper.

> **Correction (grade-pass, 2026-07-19) — the WRITE guard cannot reuse the READ
> predicate.** The first cut of P4 also gated POST on `isForeignOwned`, i.e. it
> refused only ids *owned by another tenant*. A data-integrity audit proved that
> left a **worse** hole than the one being closed. The host registers system
> definitions at boot — `openwop-app.channel.turn` (inbound omnichannel
> processing for every tenant), `assistant.loop.*`, `feature.agent-knowledge.*` —
> via `registerWorkflow` with **no ownership row**. They are therefore *unowned*,
> and an unowned id was treated as free-to-write. A test confirmed a tenant could
> POST under `openwop-app.channel.turn` and get **201**, poisoning that workflow
> host-wide. The `openwop-app.*` public-namespace WRITE exemption made it worse.
>
> The correct WRITE signal is not "owned by another tenant" but **"already
> REGISTERED and not owned by me"** (`isWriteProtected`). A genuinely free id is
> not in the registry, so create stays open; a foreign-tenant def AND a host
> system def are both registered-and-unowned-by-caller, so both are refused. This
> is a registry POINT LOOKUP — stronger than the read predicate and cheaper (the
> write path no longer scans the ownership table at all). The public-namespace
> WRITE exemption is **dropped**: no legitimate tenant route-writes those
> namespaces (seeders call `recordOwnership` directly; from-chain mints random
> ids), and a tenant that owns a seeded copy still self-overwrites via `getOwned`.

Ordinary use stays open: **first-write** (id not yet registered) and
**self-overwrite** (the caller owns it — the builder's autosave) both pass, and
the **seed / anon→user fold** paths never touch this route. **Residual**
(documented, low severity, no storage-layer CAS to close it): two tenants racing
the first write of the same never-registered id both pass; user-authored ids are
random so a natural collision is negligible, and deterministic seeded ids never
route.

## Implementation record

| Phase | Scope | Status |
| --- | --- | --- |
| P1 | metadata + nodeId + outputRole round-trip, property test | Implemented |
| P2 | referenced-definition **disclosure** on POST (re-scoped from refusal — see correction) | Implemented |
| P3 | all-row ingestion + `mergeWithStatic`, static list demoted to overlay, precedence fix, palette/resolution split, parity test | Implemented |
| P4 | cross-tenant overwrite guard on POST (`isForeignOwned`, shared with GET/DELETE); route-level tenant test | Implemented |

## Open questions

1. Should the `validateWorkflowDefinition` whitelist widen to the full `WorkflowNode` schema? Separate ADR. Forcing function: the first pack or chain that ships a node carrying `agent` or `credentialsRef` — today none do.
2. Should `NodeRegistry` modules declare optional config/input/output schemas so `buildNodeCatalog` emits them for `local` rows, giving host nodes real Inspector fields? Additive to P3.
3. ~~Should P2's guard refuse, or auto-fork to a new `workflowId`?~~ **Resolved: neither.** A falsifying test showed the harm is bounded and already fail-closed, so P2 ships as disclosure — see the correction note under P2. Auto-fork was rejected separately: minting a definition implicitly behind a debounced autosave would silently change the identity of the thing the author is editing.

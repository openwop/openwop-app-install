# ADR 0763 — Agent ids and agent-pack names move to a spec namespace

Status: Accepted

Date: 2026-09-27

Relates to: ADR 0001 (feature-first packages, `feature.<id>.*` pack namespace), ADR 0379 (persona-scoped agent identity; the deferred rekey), ADR 0104 (tool-allowlist overrides), RFC 0003 (agent packs), openwop-app#4161 (the suite 2.42.6 re-pin this unblocks), openwop#1663.

## Context

Suite 2.42.3's unfailable-leg audit made `agentPackExport` / `agentPackInstall` validate every exported and installed agent manifest against `schemas/agent-manifest.schema.json`. Its v1 `agentId` pattern is

```
^(core|vendor|community|private|local)\.[a-z][a-z0-9_-]*(\.[a-z][a-zA-Z0-9_-]*)+$
```

and **64 of this host's 104 pack agents fail it**: 63 are `feature.<feature>.agents.<name>` (48 packs) and one is `career-agent` (`feature.career-agent.agents`). The legs used to assert nothing, so the gap was invisible until 2.42.3; it is now the last blocker on the 2.42.6 re-pin (#4161). The v2 agent-manifest schema (`ids.schema.json#/$defs/agentId`) accepts every current id — this is a **v1** normative rule, and the v1 wire is served and gated.

The same scope table (`spec/v1/node-packs.md` §Naming) governs pack **names**: `core.*` / `vendor.<org>.*` / `community.<author>.*` / `private.<host>.*` / `local.*`. `feature.*` is in none of them (recorded, won't-fix, as PMC-6 in `docs/steward/PACK-MANIFEST-CANONICAL-GAP.md`).

Facts that constrain the design (inventory, file:line in the PR):

1. **An agent id carries its pack name.** `agentLoader.ts:225-230` refuses an agent whose id is not `<packName>` or `<packName>.<suffix>` (RFC 0003 §B). Renaming the agents therefore renames their packs. This is also why `career-agent` has **never loaded**, while `job-search/agent/provision.ts:36,61-65` writes it into roster rows — a latent bug this ADR fixes.
2. **Old ids are durable in ~19 stores**, several with the id embedded in a KEY: agent profiles (`<tenant>:<profileId>`), agent memory scopes and vector namespaces (`agent:<profileId>`), ADR 0104 allowlist overrides (`<tenant>:<agentId>`), roster `agentRef.agentId`, schedules, chat widget config, messaging routing rules, conversation participants (`agent:<id>`), chat message content, `agent_run_activity`, run metadata, the `runagent:<runId>` AgentRef stamp, and `agent.*` run events. ADR 0379 deferred its own rekey for exactly this reason.
3. **Replay/fork re-resolves the old id.** The agent-runner node is deliberately re-executed on `:fork` and re-reads `agentId` from the run's inputs (`agentRunnerNode.ts:57-70`); an unknown id fails the node `agent_not_found`. Run events (`agent.decided`, `agent.toolCalled`, …) carry the id verbatim and are immutable.
4. **No agent alias layer exists.** Resolution is a bare-id map lookup (`agentRegistry.ts:133-174`). The precedents are artifact-type `ID_ALIASES` (a permanent read-only alias, justified by replay), node dual registration (walkthroughs) and app-migration copy-don't-delete renames (`appMigrations.ts` v2).

## Decision

### D1 — Target namespace: `vendor.openwop-app.*`

Feature agent packs are published to the public registry (ADR 0001 §2.4), which MUST refuse `private.*` and `local.*` — so the only conformant scope is `vendor.<org>.*`. `<org>` is **`openwop-app`**, the prefix this host already uses for its vendor node (`vendor.openwop-app.chat-responder`).

| before | after |
|---|---|
| pack `feature.crm.agents` | pack `vendor.openwop-app.crm.agents` |
| agent `feature.crm.agents.sales-ops` | agent `vendor.openwop-app.crm.agents.sales-ops` |
| pack `feature.career-agent.agents`, agent `career-agent` | pack `vendor.openwop-app.career-agent.agents`, agent `vendor.openwop-app.career-agent.agents.default` |

The mapping is mechanical: `feature.<rest>` → `vendor.openwop-app.<rest>`, applied to the 49 AGENT packs only. `career-agent` is the one exception and is mapped explicitly. Node, chain, form and canvas packs keep their `feature.*` names in this ADR (see D6).

### D2 — A permanent, one-way agent-id alias (the replay guarantee)

ONE module, `executor/agentIdAliases.ts`, owns the mapping. It is a RULE, not a hand table: `feature.<rest>` (an agent id under a `feature.*.agents` pack) → `vendor.openwop-app.<rest>`, plus the one explicit exception `career-agent` → `vendor.openwop-app.career-agent.agents.default`. It exports `canonicalAgentId(id)` and `agentIdForms(id)` (every spelling of one agent, for read-through and erasure).

**Canonical-if-registered (review #1).** Resolution uses the canonical id only when an agent is registered under it, otherwise the literal id. Before the rename lands no canonical id is registered, so the alias is **inert** — P1 changes nothing observable. After the rename, a legacy id resolves to the renamed agent.

**One choke point (review #3).** The canonicalization happens inside `agentRegistry`'s `lookup()` — shared by `has`/`get`/`resolve` — and at the entry of `resolveAgentForTenant`, whose `'*'` branch otherwise matches `reg.list()` on the raw id. The pack-scan resolver is handed the canonical id first and the literal id second. Nothing else compares agent ids for dispatch. `GET /v1/agents/:agentId` rides the same resolver, so a legacy id returns the canonical manifest (review #8). It is **never removed**: a run recorded in 2026 with `feature.crm.agents.sales-ops` must fork in 2030 (artifact-type `ID_ALIASES` precedent). Resolution is one-way (legacy → canonical); the wire, listings and exports only ever show the canonical id.

What the alias does **not** do: it does not rewrite anything already recorded. Run events, run metadata, `runagent:<runId>` stamps, `agent_run_activity` rows and chat message content keep the id they were written with (ADR 0379 D-replay: stamped attribution is never rewritten). Readers that group by agent (analytics, activity feeds) canonicalize through the same table at read time.

### D3 — Identity canonicalizes; keyed state is READ THROUGH, then backfilled

`resolveAgentIdentity` canonicalizes (canonical-if-registered) before an id becomes a key, so a legacy deep link or roster row lands on the canonical profile, memory scope, allowlist override and DM.

**Read-through, not ordering (review #2).** A copy migration alone strands state: if the canonical key is created by a chat before the copy runs, "copy when absent" skips it. So every id-keyed read goes through `agentIdForms()` — read the canonical key; on a miss read the legacy key; writes go to the canonical key. Correctness therefore never depends on whether the backfill has run. The backfill (P3) is a **merge**, not a copy-if-absent: legacy fields fill gaps in the canonical row, never overwrite it; legacy rows are never deleted. Vector memory namespaces are QUERIED under both forms until backfilled rather than copied embedding by embedding.

**Stores in scope:** agent profiles, agent memory scopes + vector namespaces, ADR 0104 allowlist overrides, and — review #4 — the conversation `dmKey` and participant `subjectRef` (`dmKeyOf` builds the key from `agent:<id>`, and `findByDmKey` matches exactly, so an un-canonicalized DM would open a fresh, empty conversation). `findByDmKey` tries every form. **Pack-name-keyed stores (review #7):** `marketplace:pack-disable`, pack tombstones and revocations are carried to the new pack name, so a tenant's disabled pack stays disabled.

Configuration FIELDS that drive future behaviour (roster `agentRef.agentId`, schedule `agentId` / `configurable.agentId`, chat-widget `agentId`, messaging routing `agent_id`) are rewritten in place — configuration, not recorded history.

> **CORRECTED 2026-09-27 during P1 — normalize the KEY, not the data.** The
> read-through + merge-backfill above was replaced before it shipped. Every
> agent-id-KEYED store now derives its key from ONE storage spelling,
> `agentStorageId(id)` — the pre-rename form whenever an agent has one — so a
> legacy and a canonical id address the SAME row: agent profiles
> (`profileKey`), ADR 0104 allowlist overrides (`keyOf`), agent memory scopes
> (`agentMemoryScope`) and DM keys (`dmKeyOf`). There is nothing to read
> through, nothing to backfill and no second copy, so review #2 (deploy-order
> split), #4 (DM fork) and #5 (erasure gap) are closed BY CONSTRUCTION rather
> than by ordering. Storage keys are not wire; the wire shows canonical ids
> only. Existing keys stay byte-identical (`agentStorageId(legacy) === legacy`).
> P3 therefore shrinks to the configuration FIELDS below plus the pack-name
> stores — and project/advisory-board seat refs (`agent:<agentRef.agentId>`,
> compared as strings in `features/projects/*`, `advisory-board/service.ts`),
> which the inventory's store list missed.

**Erasure (review #5).** Every subject eraser that touches an agent-keyed store erases under `agentIdForms()`, so a DSAR request cannot miss the legacy copy the read-through and merge leave behind.

**Frontend.** The same rule ships to the SPA (`chat/agentIdAliases.ts`, generated-equivalent, pinned by a parity test); a stored chat session's lineup and active agent are canonicalized on load.

### D4 — Code, tests, packs and trust move in one change

The 49 pack directories, their `name`, every `agents[].agentId`, the `requiredPacks` in `features/*/feature.ts`, the 22 backend and 17 frontend hard-coded references (deep links, EmbeddedChatPanel `agentId`, kicktodo `CONVENABLE_SPECIALISTS`, fallback attribution ids), the chain packs that pin an agent id, and the tests move together. `OPENWOP_LOCAL_PACK_PREFIXES` gains `vendor.openwop-app.`; `packs/.steward-manifest.json` is regenerated (a stale digest refuses the agents, `agentLoader.ts:170-197`). The two pack-data defects the same legs found ride along: four descriptions over 500 characters and two off-enum `modelClass` values (`extraction`, `builder`).

### D5 — Distribution: the image mount, not the registry

*Revised after review (#6): the first draft assumed registry installs.* Production does **not** registry-install `feature.*` packs — they are mounted from the image through `DEFAULT_LOCAL_PACK_PREFIXES` (`bootstrap/mountLocalPacks.ts:52`), which prod does not override, and `registryInstaller` never installs them. So distribution is: add `vendor.openwop-app.` to that default list, regenerate `packs/.steward-manifest.json`, redeploy. Publishing the renamed packs to `packs.openwop.dev` is optional distribution (ADR 0001 §2.4's intent) and not a gate.

### D6 — Out of scope: non-agent `feature.*` pack names

The 72 node/chain/form/canvas `feature.*` packs also sit outside §Naming (PMC-6). Their typeIds are conformant (all 371 node typeIds pass both majors), no conformance leg asserts pack names today, and renaming node packs means rewriting typeIds recorded in every stored workflow definition. That is a separate, larger decision; this ADR does not make it and keeps PMC-6's reopen triggers.

## Alternatives weighed

- **Project only on the two pack routes (keep internal ids).** Rejected: one agent would carry two ids — the internal one in rosters, deep links, run events and exports-by-other-routes, the projected one on `/v1/packs*` — and a client that installs from the export and dispatches by that id reaches an agent the host does not know. The drift class this invites is exactly what ADR 0379 spent a program undoing.
- **Rekey every store and rewrite history.** Rejected: rewrites recorded attribution (replay/fork unsafe) and repeats the 19-store rekey ADR 0379 deferred.
- **Quarantine the two scenarios.** Rejected: the quarantine is a shrink-only debt ledger, never a green-making tool (`conformance/run.ts` ADR 0550 P1).
- **`local.*` / `private.*`.** Rejected: the packs are publicly published (ADR 0001), which those scopes forbid.

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| P0 | This ADR | `/architect` review |
| P1 | INERT groundwork: `agentIdAliases` (canonical-if-registered) at the registry choke point + `resolveAgentForTenant`; identity canonicalization; read-through for profiles / memory / overrides / dmKey; erasure under every form; the SPA rule + parity test | tests prove zero change before the rename AND correct resolution once a canonical agent is registered (including a legacy-id fork) |
| P2+P3 (one deploy) | The rename (D4) + the default local-prefix list + steward manifest + pack-data fixes + `career-agent`; the merge backfill incl. pack-name stores | full `npm run ci`; the two agent legs green on 2.42.6/7; migration idempotency on both adapters |
| P4 | Optional registry publish (D5) | none (not a gate) |
| P5 | Land #4161 on suite 2.42.7 (with openwop#1663) and publish evidence | `npm run ci` green, certified bundles |

## Behaviour changes to call out

- `career-agent` has never loaded (it breaks the loader's prefix rule). After P2 its roster rows start dispatching — a fix, and a visible one.
- A forked run can show both spellings of one agent: the copied prefix keeps the legacy id, events after the fork carry the canonical one. Readers that group by agent id (activity feed, `agent_run_activity`, analytics) canonicalize at read.

## Implementation record

| Phase | Landed | Notes |
|---|---|---|
| P1 | #4179 (`ea264a234`) | Alias at the registry choke point + `'*'` branch; identity canonicalization; `agentStorageId` keys for profiles, overrides, memory scopes, `dmKeyOf`. The multi-segment feature name (`feature.commerce.buyer.agents`) was missed by the first rule and caught by the P2 dry-run. |
| P2 + P3 | this PR | 49 packs + agent ids renamed (scripted); mount allowlist; steward manifest; pack-data fixes (4 descriptions, `extraction`/`builder`/`balanced` modelClass); `career-agent` now loads; pack-name stores (`packStorageName`); SPA mirror; FEATURES.md. **P3 needed no data migration** (correction below). |

> **CORRECTED during P2 — no config-field migration.** D3 planned to rewrite
> roster `agentRef.agentId`, schedule ids, widget and routing ids in place. It
> is unnecessary: stored legacy ids resolve through the P1 alias forever, the
> provisioners match their members by `roleKey` / persona (never by agent id),
> and the one id comparison found (the voice roster's home-agent exclusion) now
> compares canonical forms. Rewriting rows would have added risk and bought
> nothing.

## Review record

`/architect` (2026-09-27) found five blockers and three highs against the first draft; all are folded in above: inert alias (#1), read-through instead of ordering (#2), one resolution choke point (#3), DM split (#4), erasure of copies (#5), image-mounted distribution (#6), pack-name stores (#7), legacy ids on `GET /v1/agents/:id` (#8).

## Open questions

- [x] `<org>` = `openwop-app` — the node `vendor.openwop-app.chat-responder` already claims it.
- [x] `/v1/packs/export` `provenance[]` lists each agent's legacy ids (`legacyAgentIds`), so an importer can follow old references.
- [ ] Analytics readers that group by agent id: canonicalize at read (D2) — confirm the list during P1.

# ADR 0200 — Data-Ops Templates (the aggregator canon + one-way connector movement)

**Status:** implemented
**Date:** 2026-07-03
**Depends on:** ADR 0190 (the evidence-based template-catalog program + its conventions), ADR 0198 (approvals-depth — the gate this pack's write rides), RFC 0095 (connection packs), RFC 0013 (workflow-chain packs)

## Why this exists

Two prior deep-research passes (top-100 automations; Microsoft/enterprise canon) surfaced zero verified claims from **Make.com** and **Workato**. A focused third pass on exactly those two found the one shape-family the ~47-template catalog did not cover: the **data-ops / iPaaS canon** — Make's router/iterator/aggregator scenario primitives and Workato's ETL/recipe read→write. Every other shape (email→AI→notify, lead-capture→sheet, department AI agents) corroborated what we already ship.

A fourth pass (105 agents, unanimous, multi-vendor + patent corroborated) settled the honesty question for connector writes: **ship single-direction read→write, never "sync."**

## Decision

Ship `core.openwop.workflows.data-ops` (keywords `["Data Ops"]`) — 3 chains over shipped, executable nodes only:

1. **`data-ops.rollup`** — array → `aggregate-numeric` (sum a field) + `aggregate-text` (format each record via a line template) → `chatCompletion` (narrate) → notify. The "collapse many records into one" aggregator shape (Make's cart-line-items). Data-shaping, zero-connection, ungated.
2. **`data-ops.to-table`** — array → `aggregate-table` (named columns) → `chatCompletion` (anomaly scan) → notify. Data-shaping, zero-connection, ungated.
3. **`data-ops.records-to-system`** — the ONE-WAY read→write: `openapi-call` READ → `chatCompletion` reshape → `approvalGate` → `openapi-call` UPSERT. Gated, `side-effectful`.

### §Scope correction — what the flow nodes actually do (the load-bearing finding)

The naïve design was "iterator → per-item LLM → aggregate" + router fan-out + batch loop, mirroring Make. **Direct inspection of `packs/core.openwop.flow/index.mjs` proved those don't compose in a linear chain**, so shipping them would have been a false affordance:

- **`core.flow.iterator`** ANNOTATES an array (`items: [{item,index,total}]`) in one node output — it does **NOT** fan out to per-item node execution. A downstream node receives the whole array, not one item.
- **`core.flow.router` / `switch`** classify by predicate and emit matched branch labels, but branch topology needs **edge `condition`** — and `expandChain`'s `mappedEdges` (`workflowChainPackLoader.ts`) **drops the `condition` field**. So conditional routing silently doesn't gate in an expanded chain. (Left as a deferred, separate concern — fixing it has `it-support.incident-triage` blast radius.)
- **`core.flow.split-in-batches`** returns only the FIRST batch + `remaining`; without a loop-back edge (which chains don't express) it processes one batch and drops the rest.

The **aggregate-{numeric,text,table}** reducers, by contrast, are pure array→output transforms that work in one invocation — verified by executing the real node functions in the pack test. So the honest data-ops canon on this host is **the aggregators + one-way movement**, not the fan-out/loop primitives. The pack test asserts the node contracts directly so this can't silently drift.

### The one-way write guardrails (research verdict, folded into #3)

1. **Upsert-by-external-key** — `upsertOperationId` + `keyField` are params; copy mandates an upsert op (Salesforce/HubSpot upsert), because a blind `create` duplicates on retry/partial-failure. Never a hardcoded create (test-pinned).
2. **Gate before write** — an LLM reshape can emit a schema-valid but wrong value; the reshape prompt carries an "output `unknown` for any field you can't determine" escape, and the upsert sits downstream of `approvalGate` (test-pinned: the write's only inbound edge is the gate).
3. **One-way, never "sync"** — the copy frames one-way movement, disavows sync explicitly, and names the write-scope re-auth requirement. A test bans promissory `sync`/`bidirectional`/`two-way` (the disavowal "not a sync" is allowed).

### Convention hardening + a latent bug it caught

The ADR 0190 repo-wide gate-convention treated only `email-send`/`slack-message`/`sms-send` as gated external sends. This ADR extends it: a **`core.openwop.http.openapi-call` whose `operationId` is a write verb** (`/^(create|update|upsert|delete|remove|disable|…)/i`) is an external write that must be gated — the OpenAPI-verb convention `people-hr` already follows. Running the extended test **surfaced a real latent bug**: `people-hr.onboarding` provisioned a real M365 user account (`createUser`) with **no approval gate**, contradicting its own pack description ("every account/HRIS mutation… is gated"). Fixed in this PR: a pre-provisioning `approvalGate` (`plan → approve → {provision, hris, tickets}`), and the pack bumped `1.1.0 → 1.2.0` for republication. (`offboarding`'s downstream `attest` gate is correct-by-design — revoke access fast on termination, then attest — so it was left unchanged.)

## Consequences

- Catalog: 47 → 50 chains; the aggregator + one-way-movement gap is closed honestly.
- The write-verb heuristic now protects every future chain from shipping an ungated connector write.
- Deferred (separate concerns, not this pack): edge-`condition` propagation in `expandChain` (would unlock router/switch in chains) + a loop primitive for split-in-batches. Both have existing-chain blast radius and want their own ADR.
- No OpenWOP wire change: all `core.flow`/`http`/`ai`/`chat` nodes; `openapi-call` rides RFC-0095 connection packs. No RFC.

## Alternatives weighed

- *Ship router/iterator-fanout/split as Make-style scenarios:* rejected — the nodes don't compose that way in a linear chain (§Scope correction); it would be a false affordance.
- *Data-shaping only, drop the connector write:* rejected — the read→write is the genuine Workato-canon gap and is honestly shippable with the three guardrails (people-hr precedent).
- *Bidirectional sync templates:* rejected — over-promises reconciliation the platform does not do (the research's central warning).

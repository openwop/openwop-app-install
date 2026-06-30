# ADR 0152 — Workflow-chain pack loader + the path to publishing workflows at packs.openwop.dev

**Status:** implemented — 2026-06-27/28 (landed via #960 the RFC 0013 chain-pack path, #967 editable templates, #974 the four follow-ons incl. runtime install + chat `@workflow`). Implementation: `host/workflowChainPackLoader.ts` (load + deterministic `expandChain`) + the install route + tests (`workflow-chain-pack-loader`, `workflow-chain-pack-install-route`, `workflow-chain-lighthouse`, `workflow-from-chain-route`). Architect-reviewed 2026-06-27; R1–R8 folded in. _(Number reconciled 0150→0152 during the parallel-session collision sweep; the heading/refs were stale at 0150.)_
**Date:** 2026-06-27
**Depends on:** ADR 0149 (the real-work catalog + connection packs), RFC 0013 (`Accepted`)

> **Architect-review decisions (R1–R8, applied below):**
> **R1** — the publishable/host-specific split is a *mechanical* gate: every node typeId
> present in the registry `/v1/index.json` ⇒ publishable; any unpublished typeId (esp.
> host-private `feature.*`) ⇒ app-seeded. (A connector workflow over `core.openwop.http` +
> a connection pack IS portable — the connection is a separate per-host artifact.)
> **R2 (the replay landmine)** — expansion is done **once and frozen**: deterministic
> `expansionId`, the expanded `WorkflowDefinition` persisted byte-stable and served verbatim;
> **never re-expanded at resolve/`:fork` time** (else node-id rewrite diverges → ADR 0031 break).
> **R3** — a chain is a **builder tile**; to make it runnable, expand → **persist via the
> existing builder registry / seed path** (`workflowsRegistry`), NOT a new pinned catalog
> source or route (the ADR 0149 §Correction lesson).
> **R4** — the `workflowChainPackLoader` is a peer to the connection/prompt/artifact-type
> loaders, but **reuses the existing Ed25519/SRI verify + tarball-extraction helpers** (no
> second crypto path).
> **R5** — v1 **vendors** chain packs under `packs/` (deterministic/offline, via a sync
> script like node packs); runtime `RegistryClient` fetch is a later enhancement.
> **R6** — **no RFC 0013 amendment now**; keep `ambient`/`requires` host-side; amend only if a
> second host needs portable cadence/preconditions.
> **R7** — **verify Ed25519 signature + namespace allow-list before expansion; fail-closed.**
> **R8** — the expanded def **passes the existing `workflowDefinitionValidation`** and every
> expanded typeId must resolve (`chain_unresolvable_typeid`); no special trust for pack graphs.

> **Goal.** Get the real-work workflows to the state ADR 0149 deferred: **published as
> signed packs at packs.openwop.dev**, consumed back by openwop-app through the
> *existing* workflow catalog — no parallel surface (the ADR 0149 §Correction lesson).

---

## Context — what already exists (audited across the corpus)

| Layer | State | Evidence |
|---|---|---|
| **RFC 0013 workflow-chain packs** | ✅ **`Accepted`** (2026-05-18). Defines the `kind:"workflow-chain"` manifest, Ed25519 signing, registry publication, and **author-time expansion** semantics. | `../openwop/RFCS/0013-workflow-chain-packs.md` |
| **Registry pipeline** (`packs.openwop.dev`) | ✅ Validates + signs + serves `workflow-chain` (schema + CI gate exist); publish is a **PR to `openwop-registry`** → CI → merge. **0 workflow-chain packs published today** (62 `node` packs only). | `../openwop-registry/scripts/{build-pack-tarball,publish-pack}.mjs`, `registry/v1/index.json` |
| **Published node palette** | ✅ `core.openwop.*` (ai, rag, hitl, http, mcp, integration, flow, triggers, db, data…) **+ `vendor.myndhyve.*`** (ads-publish-google/meta/tiktok, market-intel-*, campaign-sequence, landing-page, launch-studio, brand, knowledge-tools, web-research…). | registry index (62 packs) |
| **SDK consume** | ✅ read-only `RegistryClient` (fetch + verify). | `../openwop-sdks/.../registry-helpers.ts` |
| **App: export** | ⚠️ Frontend already exports a built workflow → chain-pack manifest. | `frontend/react/src/builder/schema/chainPackManifest.ts` |
| **App: load/expand** | ❌ **No chain-pack loader, no expansion handler.** The core gap. | — |

## The decisive constraint — RFC 0013 portability invariant

A workflow-chain pack is an **author-time DAG fragment** (a drag-tile) that expands into
concrete typeIds spliced into a parent workflow; **the chain reference is not preserved at
runtime** (RFC 0013 §"What hosts dispatch"). The hard rule: every node in a chain fragment
**MUST reference an already-published node-pack typeId or a `core.*` framework typeId** — so
the expanded workflow resolves on *any* conformant host.

**This re-shapes ADR 0149's 20 workflows into two classes:**

1. **Portable (→ packs.openwop.dev).** Workflows whose every node is a published typeId —
   `core.openwop.{rag,ai,hitl,http,mcp,integration,triggers}` and the `vendor.myndhyve.*`
   marketing/ads/market-intel/launch corpus. **These are exactly the MyndHyve-style
   workflows the original request pointed at** — their node packs are *already published*.
   Examples: market-intel digest, ad-optimization, campaign launch, RFP draft (over
   `core.openwop.rag`, not host-private KB).
2. **Host-specific (NOT registry packs).** Workflows bound to **host-private `feature.*`
   nodes** (CRM/analytics reads) or to a specific tenant's connections. These cannot be
   portable chain packs (another host can't resolve `feature.crm.nodes.*`). Their home is
   the **app's own workflow storage** (seeded / builder registry), per ADR 0149 — they do
   NOT go to packs.openwop.dev.

> **Correction to ADR 0149's framing.** ADR 0149 spoke of shipping "the 20" as one library.
> RFC 0013's portability rule means the *publishable* set is the portable subset, authored
> over published nodes — not the `feature.*`-bound graphs. The `feature.*` binding was a
> host-convenience choice; the portable re-authoring (e.g. `core.openwop.rag` instead of
> `feature.kb.nodes.rag`) is what makes them registry-grade.

## Decision

1. **Publish the portable workflows as RFC 0013 `workflow-chain` packs** to packs.openwop.dev
   via the existing `openwop-registry` PR flow (build-tarball → Ed25519 sign → CI validate →
   index → merge). No new registry infra; no new RFC (RFC 0013 is Accepted). Namespace:
   `vendor.openwop.workflows.*` (or `core.openwop.workflows.*`), gated on a registered
   signing key (see Open questions).
2. **Build a host-side workflow-chain pack loader + expansion** in openwop-app, peer to
   `connectionPackLoader`/`promptPackLoader`/`artifactTypePackLoader`. It (a) loads
   `kind:"workflow-chain"` packs (vendored and/or fetched via the SDK `RegistryClient`),
   (b) verifies the Ed25519 signature, (c) implements the RFC 0013 expansion steps
   (resolve → verify → validate params → substitute `{{params.*}}` → rewrite node ids →
   splice → propagate capabilities), producing a concrete `WorkflowDefinition`.
3. **Make a published chain runnable through the EXISTING save/seed path (R3).** A chain is a
   *fragment* / builder tile (RFC 0013's native use). To run one end-to-end, **expand it once
   into a concrete `WorkflowDefinition` and persist it through the existing builder registry**
   (`workflowsRegistry` — the established "save a workflow" path; a seed step does this for the
   curated set, the established "seeded workflows" mechanism). The expansion is **frozen**
   (deterministic `expansionId`; R2) so the persisted definition dispatches + `:fork`-replays
   byte-stable. **No new pinned catalog source, no new route** — the lesson from ADR 0149.
4. **Host-specific workflows stay in the app** (seeded via the established seeder/registry
   path) — not published. ADR 0149 holds their catalog.

## Path (thin-slice first — de-risk before scale)

| Step | Scope | Gate |
|---|---|---|
| **1 — this ADR** | Settle the portability split + the expand-and-run model + the loader seam. | `/architect` GO. |
| **2 — one portable pack** | Author ONE workflow as a `workflow-chain` pack over published nodes (candidate: **market-intel digest** over `vendor.myndhyve.market-intel-*` + `core.openwop.ai`, OR **RFP draft** over `core.openwop.rag` + `core.openwop.hitl`). Schema-valid against `workflow-chain-pack-manifest.schema.json`. | Manifest validates; signs locally. |
| **3 — signing key + namespace** | Register the publisher key + namespace allow-list in `openwop-registry` `.well-known/openwop-registry.json`. | Key accepted (maintainer step). |
| **4 — publish** | PR the manifest to `openwop-registry` → CI signs/indexes → packs.openwop.dev. | Pack live + in `/v1/index.json` with `kind:"workflow-chain"`. |
| **5 — host loader + expansion** | Implement the loader for that one pack; expand → register as a catalog source → run it. | Round-trip: published pack → fetch → verify → expand → run + `:fork` replay. |
| **6 — scale** | Author + publish the remaining portable workflows; seed the host-specific ones in-app. | — |

## RFC gate verdict

**No new/amended RFC for the common case.** Authoring chain packs + a host loader rides the
**already-Accepted RFC 0013** (manifest, signing, expansion are all normative there) and
RFC 0095 (the connection packs already landed). The host loader is non-normative host work.
**The one trigger for an RFC 0013 amendment:** if a workflow needs manifest metadata RFC 0013
doesn't model (e.g. an `ambient`/schedule hint or a `requires` precondition block), that delta
is authored in `../openwop` (RFC 0013 amendment) — never invented host-side. Decide per-need.

## Open questions / decisions checklist

- [ ] **Signing key + namespace:** which namespace (`vendor.openwop.workflows.*` vs
  `core.openwop.workflows.*`) and who holds the Ed25519 publisher key? (Maintainer/secret —
  the one external dependency; blocks step 4, not steps 1–2/5.)
- [ ] **Fetch vs vendor:** does the app fetch chain packs from packs.openwop.dev at boot via
  `RegistryClient`, or vendor them under `packs/` like node packs today? (Lean: vendor for
  determinism + offline; fetch is a later enhancement.)
- [ ] **Expand-and-register granularity:** one standalone workflow per published chain
  (1-tile workflow) vs. chains only as builder tiles. (Lean: both — register top-level
  runnable + expose as a builder tile, since RFC 0013's native use is the tile.)
- [ ] **`ambient`/`requires` metadata:** keep host-side (app decides preconditions) or push
  into the RFC 0013 manifest (portable). Decides whether an RFC 0013 amendment is needed.
- [ ] **Which workflows are portable:** audit each of the 20 for an all-published-typeId
  re-authoring; the rest stay host-seeded.

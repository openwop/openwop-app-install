# Marketplace + bundles (F4) — chat-first port review

**Scope:** `backend/typescript/src/features/marketplace/*` + `frontend/react/src/features/marketplace/*`
(ADR 0022 marketplace, ADR 0194 pack lifecycle, ADR 0366 bundle shop / white-label composer,
ADR 0385 P4 paid-lane pricing, ADR 0419 paid feature bundles). Read-only audit.

## Headline

**Already rides the engine.** This is the rare feature whose one genuinely
chat-shaped capability — "recommend a pack for a described need" — is *already*
expressed the sanctioned way: a persona (`feature.marketplace.agents.recommender`)
with a real ACTION tool (`feature.marketplace.nodes.search`) over the read-only
`ctx.features.marketplace` surface, driven through the ONE chat, with a
deliberate, documented refusal to auto-install. Everything else is legitimately
page/operator/money-shaped and rides a single owner (registry installer, pack
tombstones, pack-visibility resolver, billing/commerce checkout). **No THEATER,
no PARALLEL, no bespoke "talk to AI" surface, no second chat.** The port work is
near-zero; the findings are honesty/lifecycle notes to file, not demolitions.

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Recommend packs for a described need | chat: recommender agent → `search` node → `ctx.features.marketplace` (`packs/feature.marketplace.agents/pack.json:13`, `packs/feature.marketplace.nodes/index.mjs:24`, `surface.ts:42`) | **RIDES** | Leave alone; confirm the agent is surfaced/deep-linkable in the agents roster (honesty note below) |
| Browse / search / filter listings | read-only projection page (`routes.ts:109`, `MarketplacePage.tsx:282`, `listingService`) | **PAGE-LEGIT** | Keep; catalog is page-shaped. Honesty loop closes (`installed` from real pack-dir scan) |
| Install a pack | superadmin REST → `installPackFromRegistry` single owner (`routes.ts:266`, `:287`) | **RIDES** | Keep. Deliberately NOT a node/agent tool — process-global, `host:*`-scoped; a button→POST to a privileged host action is correct |
| Remove (tombstone) / purge / restore | superadmin REST → `packTombstones` owner (`routes.ts:186`, `:248`) | **RIDES** | Keep; rides the single tombstone owner with replay-safe two-tier removal |
| Per-workspace pack enablement (availability curation) | REST → `packEnablementService` which registers the host `packVisibility` resolver (`routes.ts:158`, `packVisibility.ts:22`) | **RIDES** | Keep; instantiates the visibility-resolver seam, IDOR-clean (tenant from request only, `routes.ts:170`) |
| Reviews + ratings (list / upsert / delete) | org-scoped RBAC page + inline compose form + star widget (`routes.ts:310`, `MarketplacePage.tsx:327`, `reviewService.ts`) | **PAGE-LEGIT** | Keep as a page. Lightweight UGC rating — forcing chat would be worse. Aggregate computed on read (no denorm drift). Lifecycle note below |
| Bundle store — buy a premium bundle | store card → `buyBundle` → billing checkout; webhook fulfilment (`BundleShopPage.tsx:151`, `marketplaceClient.ts:224`) | **RIDES** | Keep; rides the single billing/money owner. Honest: never marks "owned" optimistically (`BundleShopPage.tsx:75`) |
| Native-paid listing purchase | listing → `purchaseListing` → commerce-connect checkout; webhook fulfilment (`MarketplacePage.tsx:130`, `marketplaceClient.ts:36`) | **RIDES** | Keep; rides commerce/money owner; pricing is an additive per-viewer annotation, never a browse gate (`listingPricingHook.ts:33`) |
| White-label composer — compose + export manifest | read-only page; exports `distributions/<name>.json`, no host mutation (`BundleShopPage.tsx:103`, `:138`) | **PAGE-LEGIT** | Keep; manifest becomes real only via repo PR + gated `gen-distribution` build. Deliberate no-write-twin (`bundleCatalog.ts:29`) |
| Feature-bundle catalog read + connection-pack certify lint | read-only projections (`routes.ts:124`, `:134`, `bundleCatalog.ts:78`, `certService`) | **PAGE-LEGIT** | Keep; host-global projections, no tenant data |

**VERDICTS: R=6 A=0 P=0 T=0 PL=4**

## Blockers (from scouting) — with honest alternatives

None that block a port — because there is essentially nothing to port. The
scouting *confirmed* rather than falsified the chat-first claim:

- **Ignition test passes vacuously.** The feature declares **no
  `WorkflowDefinition`** (grep for `feature.marketplace.nodes` in workflow
  defs/seeds is empty) — so there is no orphaned workflow to ignite. Nodes are
  palette building blocks; a node needs no igniter the way a declared workflow
  does. Not theater.
- **Agency test passes.** The recommender's allowlist is exactly one tool
  (`openwop:feature.marketplace.nodes.search`, `pack.json:21`), and that tool is
  an ACTION node that reads the live catalog via the toggle-gated surface. A
  read-only persona is normally a "toothless authoring agent" smell — but here
  the agent's *job is recommendation, not authoring*, and it correctly has **no
  install tool** because install is a privileged process-global host action that
  no agent may reach (`surface.ts` §"INSTALL is deliberately NOT on the
  surface"). This is the right shape, not a defect.
- **Authority-parity holds.** Browse requires `toggle + resolveCallerUser`
  (`routes.ts:110-113`); the surface applies the same toggle gate per call
  (`surface.ts:38`); install/remove require `requireSuperadmin`; reviews share
  `authorizeOrgScope` for both read and write. Route and surface gate the same
  way.

## Demolition list (with regression pins to add)

**Nothing to demolish.** No bespoke "talk to AI" panel exists; no second chat;
no form hiding an LLM call behind a button; no bespoke approve/submit
duplicating the HITL machinery (install/remove are privileged host actions with
no shared-approval primitive to ride, so their confirm dialogs are legitimate).

The only defensive pin worth adding (cheap regression guard, not a demolition):

- A test asserting the marketplace **agent allowlist never gains an install/
  mutate tool** (`pack.json:21` stays `[search]` only) and the surface never
  gains an `install`/`enable` method — so a future edit can't quietly turn the
  read-only recommender into an auto-installer. This encodes the ADR 0022 /
  agent-pack invariant that install stays outside every agent's reach.

## New-code inventory

Effectively empty. If the one honesty item below is actioned it is a *seam
registration*, not a feature:

- (optional) Register `marketplace:review` with the DSAR subject-key eraser /
  retention sweep — one call, no new surface. See lifecycle note.

## Phased plan

There is no multi-phase port. The recommended work is a single small hygiene
pass, gated on the normal app gate (`npm run ci`):

1. **Phase 1 (hygiene only):** (a) add the allowlist-immutability regression
   pin above; (b) register `marketplace:review` for erasure/retention (below);
   (c) verify in a running app that the recommender agent is actually surfaced
   in the agents roster and deep-linkable (`/?agent=feature.marketplace.agents.recommender`)
   so the chat-first path is live, not latent. Close with `/code-review` +
   `/ux-review`.

## Deferred honestly

- **Reviews store PII lifecycle (pre-existing, not a port artifact).**
  `marketplace:review` rows carry `authorId` (a user id) and free-text `body`
  (`reviewService.ts:20-30`), persisted via `DurableCollection('marketplace:review')`.
  A grep across `backend/typescript/src/host` found **no** subject-key eraser or
  retention registration for `marketplace:review` (ADR 0464 host-store erasure
  class). This is a data-integrity/DSAR gap that belongs to `/grade-data`, not
  the chat-first port — flagged here as a filed cross-layer TODO, not fixed
  locally.
- **`feature.marketplace.nodes.listings` node has no consumer.** The node pack
  declares two nodes (`pack.json:19-27`) but the agent allowlists only `search`,
  and no workflow references `listings`. It is coverage-only (a palette node an
  author *could* compose) — legitimate as a building block, but worth a note as
  a borderline dead node if pack freshness is audited (`/grade-node-packs`).
- **Recommender discoverability is pack-load-dependent.** The agent reaches the
  ONE chat only because `feature.marketplace.agents` is pinned via
  `requiredPacks` (`feature.ts:40-43`); there is no explicit default
  `agentProfile` seeding it into a roster. The chat-first capability is real but
  its *visibility* to an end user depends on the agents roster surfacing
  pack-provided agents — verify in the target deployment before claiming the
  chat path is user-reachable.

---

SLUG: f4-marketplace-bundles
VERDICTS: R=6 A=0 P=0 T=0 PL=4
HEADLINE: Marketplace already rides the engine — its one chat-shaped capability (pack recommendation) is a correct read-only agent+node over the toggle-gated surface, and every other capability is a legitimate page/operator/money surface riding a single owner; no THEATER, no PARALLEL, no bespoke chat.
</content>
</invoke>

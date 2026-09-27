# ADR 0410 — Commerce product catalog onto the content kernel (`commerce.product` as a system type)

**Status:** Accepted — Phases 1–2 implemented, Phase 3 finalized (2026-07-18)
**Date:** 2026-07-18

> **Deploy-sequenced follow-ons** (KERNEL-6 straggler re-sweep + LEGACY-CLEANUP
> for `commerce:product`): paste-ready migrations + arming checklist in
> [`docs/DEPLOY-KERNEL-SEQUENCING.md`](../DEPLOY-KERNEL-SEQUENCING.md) — land the
> release AFTER this program deploys.

> **Demand-gated follow-ons — DEFERRED (architect-ruled 2026-07-18, no code).**
> Two Phase-3 dividends were weighed for build-now and deferred as YAGNI (no
> consumer), each with a falsifiable trigger:
> - **CONVERGENCE-PRIMITIVE** (the `EntityTypeRecord.publicFields` allowlist that
>   would let `commerce.product` go `publicRead` safely and resolve productGrid
>   via `public-entities`). Deferred **whole** — including the "safe" allowlist
>   sub-part: **no system type is `publicRead` today**, and `toPublicEntity`
>   serving `values` wholesale is the *intended* ADR 0407 behavior for user
>   types, so an allowlist guards a configuration that cannot occur without a
>   deliberate future change (which would build the allowlist fail-closed *as
>   part of itself*). The existing guard already fails closed (`gatePublicType`
>   refuses `neverPublic`; the leak-guard test pins `commerce.product`
>   `publicRead`-unset). **Trigger:** a concrete decision to serve a system type
>   through the generic `public-entities` read → then add `publicFields`
>   (empty ⇒ nothing served), set the storefront-safe set, flip `publicRead`,
>   convert the leak-guard test to a positive-allowlist assertion.
> - **PRODUCT-L10N** (localized product fields via the ADR 0406 overlay).
>   Deferred — commerce.product is façade-only and `/public-store` does not
>   locale-negotiate, so localized fields would surface *nowhere* today (dead
>   data). Rides an accepted primitive → clean fast-follow. **Trigger:** a
>   multi-locale storefront request, or `/public-store` gaining locale
>   negotiation.

**Phase-3 note (2026-07-18, dividends — WITHDRAW-for-safety + defer; no code).**
The Phase-3 convergence (flip `publicRead` so the ADR 0407 `entityList`/
productGrid section resolves products through the kernel's generic anonymous
`public-entities` read) is **WITHDRAWN on a security ground**, confirmed at the
architect gate. `toPublicEntity` (`entitiesService.ts:885`) serves the kernel
row's `values` **verbatim** — no field allowlist — and `commerce.product`'s
`values` carry `cost` (merchant **margin**) and `inventory`. The purpose-built
storefront read (`/public-store/:orgId/products`, `commerce/routes.ts`)
deliberately projects those AWAY ("never expose internal/inventory operational
fields"). So flipping `publicRead` would **leak margin + stock to anonymous
callers** through the generic read. The only safe convergence would first
require a per-system-type public field-projection primitive on `toPublicEntity`
— which is exactly the storefront's richer resolver rebuilt inside the generic
path (the boundary smell D4 already warned against). Neither is worth building
in v1. **Resolution:** `commerce.product` stays **façade-only** (`publicRead`
unset — the Phase-1 posture is the final posture); `/public-store` remains the
single anonymous product surface; the D4 convergence is recorded as **deferred,
gated on a public field-projection primitive** (the falsifier — build that for
an independent reason and the convergence becomes safe). The other Phase-3
dividends resolve like ADR 0409 Phase 5: **generic product query** stays
façade-only (same `cost`-confidentiality + the Phase-4 system-type refusal);
**unified retention** already delivered (product rows ride the kernel store the
retention sweep covers — no separate lane); **product-field localization**
(ADR 0406) is free on the kernel but demand-gated → defer (and would ship *with*
the same field-projection requirement if a public read is ever wanted); **legacy
`commerce:product` cleanup** deferred one release (the read-dark rollback
window). Phase 3 is therefore a **recorded finalization, not code** — the honest
end-state of the one-content-kernel program: **pages + company + deal + product
on the kernel**, **contact coexistent** (ADR 0409 Phase 4), and the **commerce
money-path + CRM identity machinery deliberately façade-owned**. The kernel is
the content substrate; the façades keep the domain truth (money, identity,
RBAC).

**Phase-2 note (2026-07-18, migration + honesty gate):** the migration
(APP_MIGRATION 12) was wired + honesty-gated in Phase 1 (all 43 commerce suites
unmodified, incl. order-fulfilment inventory-CAS over the kernel; the
schema-migration-integrity + app-version-migrations gates accept mig 12). Phase
2 adds the one integration Phase 1's per-store gate didn't compose end-to-end —
the **money-path × migration crossover** (`commerce-product-migration-crossover
.test.ts`): a LEGACY `commerce:product` row survives the id-preserving migration
AND an order still reserves/decrements its inventory correctly over the kernel
(the stock ledger stays authoritative; `casSystemEntity` on the kernel row).

**Phase-1 note (2026-07-18):** `commerce.product` system type; full `Product` →
`ext.product` (SoT); queryable scalars (org_id/type/name/price/currency/cost/
inventory/active) → `values`; the commerce service is the façade storing via a
tenant-aware kernel adapter, id-preserving (productId=entityId), reusing the
ADR 0409 kernel primitives (`casSystemEntity` for the inventory-CAS,
`putSystemEntity`, the opaque top-level `orgId`). **v1 sets NEITHER `neverPublic`
NOR `publicRead`** → `commerce.product` is façade-only (the Phase-4 security fix
closes the authed-generic API; unset `publicRead` 404s the anonymous read); the
`/public-store` storefront read stays the commerce route. **Money-truth held by
construction:** the ONLY inventory mutators are `updateProduct` (admin) +
`casAdjustProductInventory` (the ledger decrement, → `casSystemEntity`); generic
kernel writes to system types are blocked, so nothing else can touch inventory —
the `commerce:stock-movement` ledger stays authoritative and unmigrated (like
CRM's stage-history). The money path (orders/carts/coupons/refunds/payouts/
quotes/price-lists/UCP) is UNTOUCHED. APP_MIGRATION 12 (`commerce:product`→
kernel, id-preserving, idempotent, legacy read-dark). Honesty gate held: **all
43 commerce suites (231 tests) pass UNMODIFIED**; the inventory-CAS behavior is
covered by the existing (passing) order-fulfilment suites over the kernel.
**Program:** the second "onto the kernel" follow-on ADR 0408 deferred (see **ADR
0409** — CRM core records). Same cms.page façade template; a **sharper scope** and
a genuine convergence dividend CRM cannot have.
**Depends on / composes:** ADR 0408 (content kernel — system types + `ext` +
`putSystemEntity`), ADR 0386 (entities engine), ADR 0407 (entityList sections +
the productGrid reference-not-copy precedent), commerce (product model +
storefront), ADR 0274 (product cost/margin), ADR 0007 (Media tokens), ADR 0257
(product custom fields — built-ins pinned), ADR 0162 (idempotent ids).
**Surface:** internal storage re-platform of the **product catalog only**. The
commerce API (`/v1/host/openwop-app/commerce/orgs/:orgId/*`), the public
storefront read, `ctx.features.commerce`, packs, and agent tools are
**unchanged**. Host-extension, **no new RFC**.

---

## Recommendation up front

**Migrate the product CATALOG (and ONLY the catalog) onto the kernel — this one
is more clearly worth it than the CRM migration.** A product is genuinely
content-like: a queryable typed record with media, categories/tags, custom
fields, and — decisively — a **legitimate anonymous public read** (the
storefront). That makes `commerce.product` **`publicRead`-eligible** (unlike the
never-public `crm.*` types), which unlocks a real dividend: the ADR 0407
`entityList`/productGrid CMS section could resolve products through the SAME
kernel path as entities — one content-delivery substrate for products, entities,
and pages.

**The hard boundary that makes this safe:** only the catalog migrates. Orders,
carts, coupons, refunds, stock movements, payouts, quotes, price-lists, saved
payment methods, and the UCP purchase stores are **TRANSACTIONAL with money-truth
CAS invariants** (Stripe, `pending→paid`, the CLAUDE.md money-truth rule) — they
are **NOT content and MUST NOT migrate** (a hard non-goal). This ADR touches one
store (`commerce:product`); it does not go near the money path.

## Context

The `Product` record (`commerce:product`, ORG-scoped) is a typed catalog entry:
`type`/`name`/`description`/`price`/`currency`/`cost`, `imageAssetTokens[]` +
`downloadAssetTokens[]` (Media refs, ADR 0007), `inventory`/`lowStockThreshold`,
`variants`/`components`/`subscription`, `categories`/`tags`/`attributes`, and
custom fields (ADR 0257, built-in kinds pinned — no `media`, no extension kinds).
It has an authenticated CRUD surface (`authorizeOrgScope`) AND a **public
storefront read** (`/public-store/:orgId/products`) — the exact "referenced
content resolved live" shape the ADR 0407 productGrid section already consumes.

Everything else in commerce is transactional and out of scope.

## Boundaries audit

| Concern | Owner after this ADR |
|---|---|
| Catalog storage / generic query / retention substrate | `features/entities` kernel — gains the `commerce.product` system type |
| Pricing / variants / components / subscription / cost / margin vocabulary | **`features/commerce` façade — UNCHANGED.** Fixed fields → `values`; structured → `ext` |
| Inventory level | **Façade-maintained PROJECTION** (D3): the kernel row carries the current level, but the AUTHORITATIVE mutation stays the `commerce:stock-movement` ledger + façade — generic kernel writes are blocked, so nothing bypasses the ledger |
| Media refs (`imageAssetTokens`/`downloadAssetTokens`) | `ext.media` (id arrays; the Media feature stays the token owner) |
| Custom fields (ADR 0257, built-ins pinned) | `ext.customFields`, validated by the commerce façade's `isBuiltinFieldType`-pinned seam (kernel stores `ext` blind) |
| Org-scoped write RBAC + the public storefront read | **`features/commerce` façade — UNCHANGED.** The façade owns authed writes; the storefront read stays the commerce public route (D4) |
| Orders / carts / coupons / refunds / stock ledger / payouts / quotes / price-lists / UCP | **`features/commerce` — UNCHANGED, NOT migrated** (money-truth) |
| The commerce API + storefront + `ctx.features.commerce` + packs | **`features/commerce` façade — UNCHANGED** (honesty gate) |

**Non-goals:** the money path (orders/carts/refunds/stock ledger/payouts) never
touches the kernel; the kernel never computes price/inventory truth; the commerce
wire is unchanged.

## Decision

### D1 — `commerce.product` system type; commerce service becomes the façade

`commerce.product` is minted as a **system type** (ADR 0408 D1 machinery). The
commerce service keeps every exported signature and stores catalog rows via
`putSystemEntity`/`get`/`list`/`delete`, **id-preserving** (`productId` =
`entityId`) so **order line-items, cart refs, stock movements, and price-list
entries keep referencing the same product ids** — the money path is untouched
because the ids don't move.

### D2 — Fields: `values` for queryable scalars, `ext` for structure

- **Queryable scalars** → `values`: `org_id` (the cms.page precedent; ORG-scoping
  rides a values field, façade-RBAC-gated), `type`, `name`, `price`, `currency`,
  `cost`, `inventory` (projection — D3), `categories`/`tags` (string arrays for
  filtering).
- **Structured** → `ext`: `variants`, `components`, `subscription`, `attributes`,
  `ext.media` (image/download token arrays), `ext.customFields` (seam-validated).
- The fixed schema is code-owned (system type); custom fields ride `ext` exactly
  as in ADR 0409 D3.

### D3 — Inventory as a façade-maintained projection (the one subtle point)

`inventory` is catalog-visible (the storefront shows "in stock") but the
**authoritative** mutation is the `commerce:stock-movement` ledger applied on
order fulfilment (money-adjacent CAS). Resolution: the kernel row's `inventory`
value is a **projection the commerce façade maintains** (exactly how cms.page's
`workflow_status` is façade-derived) — the façade writes it via `putSystemEntity`
when the ledger moves. Because `putSystemEntity` **blocks generic kernel writes**
to system types (ADR 0408 D1), nothing can decrement inventory except the façade
through the ledger — the money-truth invariant is preserved by construction. (If
projection drift is ever a concern, the alternative is to drop `inventory` from
`values` entirely and keep it façade-only; recorded as an open question.)

### D4 — Public read: `publicRead`-eligible; storefront stays the commerce route (v1)

Unlike `crm.*`, `commerce.product` MAY be `publicRead` (products are public by
the storefront's nature). **v1 keeps the existing `/public-store` read as-is** —
it has richer needs than the generic entity read (price formatting, variant
selection, media-token resolution, margin-safe field stripping), so forcing it
onto `public-entities` in this ADR would be a regression. The **dividend**
(Phase 3): the ADR 0407 productGrid/`entityList` section could resolve products
through the kernel's public read once the catalog is a kernel type — one content
resolver for products, entities, and pages. Recorded as a Phase-3 convergence,
not forced in v1.

> **Correction (Phase 3, 2026-07-18) — the convergence is WITHDRAWN, not just
> deferred, on a security ground.** The "margin-safe field stripping" clause
> above is load-bearing in a way the original text underweighted: the generic
> `toPublicEntity` (`entitiesService.ts:885`) has **no** field stripping — it
> serves `values` verbatim, and `values` carries `cost` (margin) + `inventory`.
> So `publicRead` on `commerce.product` is **not merely a lower-fidelity read,
> it is a merchant-confidential data leak.** The convergence is therefore gated
> on a NEW primitive (a per-system-type public field-projection/allowlist on
> `toPublicEntity`) that does not exist and is out of scope here. Until it does,
> `commerce.product` keeps `publicRead` **unset** and `/public-store` stays the
> only anonymous product surface. See the Phase-3 note at the top of this ADR.

### D5 — Replay / idempotency unchanged

Product writes from runs keep deterministic ids (ADR 0162); `putSystemEntity`
put-semantics converge on re-run/`:fork`. Order/cart idempotency is untouched
(those stores don't move).

## Phased plan

- **Phase 1 — `commerce.product` system type + façade over the kernel.** Mint the
  type (publicRead-eligible; `ext` for media/variants/subscription/customFields);
  commerce service stores via the kernel, id-preserving; `inventory` projection
  wired through the façade's ledger path (D3). Reuses the ADR 0409 Phase-1 kernel
  prep (`ext.customFields` validation hook) — so **land ADR 0409 Phase 1 first**
  (shared prerequisite) or duplicate the tiny hook.
- **Phase 2 — Migration + honesty gate.** APP_MIGRATION for `commerce:product`
  (idempotent, concurrency-safe, legacy read-dark one release). **Gate: ALL
  commerce product tests + the storefront read tests + the productGrid section
  tests pass UNMODIFIED.** The money-path suites are untouched by construction.
- **Phase 3 — Dividends. FINALIZED as a recorded withdrawal-for-safety + defer
  (no code) — see the Phase-3 note at the top.** The productGrid/`entityList`
  convergence is WITHDRAWN (flipping `publicRead` leaks `cost`/margin +
  `inventory` through the stripping-free generic `toPublicEntity`; the safe path
  needs a public field-projection primitive that is out of scope). Generic
  product query stays façade-only (same confidentiality + the Phase-4 system-type
  refusal). Unified retention already delivered via the kernel adapter. Product-
  field localization (ADR 0406) is free on the kernel but demand-gated → defer.
  Legacy `commerce:product` cleanup deferred one release (read-dark window).

## Alternatives weighed

1. **Coexistence (status quo).** Defensible, but weaker than for CRM: a product
   is genuinely content-like with a public read, so the substrate + productGrid
   convergence benefit is more concrete here. Still a valid stop point.
2. **Migrate all of commerce.** **Rejected — hard non-goal.** Orders/carts/
   refunds/stock/payouts are money-truth transactional; the kernel is a content
   store, not a ledger. Mixing them would put the money path behind a generic
   content substrate — exactly the wrong boundary.
3. **Fold products into the ADR 0407 `entityList` path immediately (drop the
   storefront route).** Rejected for v1 — the storefront read has richer,
   commerce-specific needs; converge later (Phase 3), don't regress now.
4. **Keep inventory fully in the ledger, omit it from the kernel row.** A live
   alternative to D3 (recorded) — cleaner money-truth story at the cost of the
   catalog row not carrying a stock snapshot; decided at Phase 1.

## Open questions & assumptions

- **Worth it?** More clearly yes than CRM (public-read + productGrid convergence),
  but still value-gated on wanting one content substrate. Phase 1 is the
  no-regret prerequisite.
- **Inventory projection vs ledger-only** (D3) — decided at Phase 1; the
  generic-write block makes either safe.
- **Storefront → public-entities convergence timing** — Phase 3, only if the
  richer storefront needs are first met by the generic read (or the productGrid
  section keeps its own richer resolver). No regression allowed.
- **Digital download caps** (`downloadAssetTokens` = the ADR 0007 use-cap) stay
  the Media feature's concern — the kernel stores the token refs, never the cap
  logic.
- **Shared Phase 1 with ADR 0409** — the `neverPublic` flag is CRM-only, but the
  `ext.customFields` validation hook is shared; sequence 0409 Phase 1 first.

## RFC verdict — host-extension, no wire RFC

A storage re-platform of one catalog store behind an unchanged commerce API +
storefront + `ctx.features.commerce`. No wire shape, capability, or money-path
change. No new RFC.

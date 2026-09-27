# ADR 0257 — Shared custom-field seam + typed product custom fields

Status: implemented (ecommerce-deferral follow-on, Group C)

Relates to: ADR 0240 (DEF-4 — the untyped product attribute bag), ADR 0213 (CRM
field types), ADR 0177 (commerce), ADR 0001 (feature-package boundaries). No OpenWOP
wire change; no migration.

## Context

ADR 0240 (DEF-4) gave products an UNTYPED `attributes` bag ({label,value} pairs) and
recorded a follow-on: typed product custom fields, ideally by reusing the CRM FieldDef
machinery. Extending CRM's `CustomEntity` to `'product'` would couple CRM to a commerce
concept (a boundary violation); a full extraction of CRM's tested FieldDef module is a
larger cross-cutting refactor.

## Decision — a shared, entity-agnostic seam; commerce consumes it; CRM adoption deferred

### `host/customFields/` — the shared seam

A host-layer module (so multiple features consume it without importing each other,
ADR 0001) owning the **reusable, entity-agnostic** parts of a typed custom-field system:
`FieldType`, `cleanEnumOptions`, `buildFieldSpec` (field-def shape validation), and
`validateFieldValues` (the per-value validation loop). It owns **no storage and no
scoping** — each consuming feature keeps its own collection + scope rules + reference
resolvers, which are **injected** (`resolveReference`), never imported (a host module must
not depend up into a feature). Semantics are lifted verbatim from CRM's field-def logic.

### Commerce consumes it — typed product fields

- `features/commerce/productFields.ts`: a `ProductFieldDef` (org-scoped, own
  `commerce:product-fielddef` collection), CRUD, and `validateProductCustomFields` using the
  seam.
- `Product.customFields?: Record<string,string|number|boolean>` — the **typed** layer,
  validated on create (requireAll) / update (partial). The DEF-4 `attributes` bag **stays**
  (untyped freeform pairs) — both are additive, no migration.
- `reference`-type product fields are **out of v1** (no cross-entity product refs) — the
  seam rejects them at define time (empty allowed-ref list).
- Routes: `/product-fields` GET/POST/DELETE; product create/update accept `customFields`;
  the public storefront projection exposes them.
- FE: a per-store field-def manager + a typed value editor (string/number/date/boolean/enum)
  on the product form; the storefront lists typed values alongside attributes.

### CRM adoption of the seam is a DOCUMENTED FOLLOW-ON

CRM's `entities/fieldDefs.ts` is **deliberately NOT refactored in this PR**. Rewiring core,
heavily-tested CRM (the tenant-vs-org scoping, the contact/company/deal reference resolvers)
carries real regression risk to a central feature for no user-facing gain here. The only
cost is a temporary duplicate validator (CRM's inline copy vs the shared seam) — reconciled
in the behavior-preserving follow-on. This is the honest risk trade: deliver the feature +
establish the seam without risking CRM in a rushed refactor.

> **SHIPPED (follow-on — CRM adoption).** `entities/fieldDefs.ts` now delegates its field-def
> SHAPE validation to `buildFieldSpec` and its per-value loop to `validateFieldValues`, deleting
> the duplicate inline validator + `cleanEnumOptions`. CRM keeps everything storage/scope-aware
> (the `crm:fielddef` collection, tenant-vs-org scoping + `CONTACT_FIELD_DEF_ORG`, the
> `MAX.customKeys` cap, the dup-key 409, `entityType`, the 3-key `CustomFieldRefResolvers`, and
> the CRMGAP-6 `opts.defs` hoist); the seam's single `resolveReference` is fed by a thin shim over
> the 3-key resolver. `FieldDef[]` is structurally a `FieldSpec[]`, so defs pass through with no
> projection. **Two of the three anticipated reconciliations were no-ops:** CRM's string cap
> (`MAX.short`) already equalled the seam's `MAX_STRING_VALUE` (120) and both already used the
> same host `cleanString` (secret-scrub), so **no `maxLen` param was added**. The **one real
> behavior delta** is the date check: the seam rejects day-overflow "rollover" dates
> (`2023-02-30`) that CRM's `Date.parse` check silently accepted — a deliberate **write-time-only**
> correctness hardening (stored rows are never re-validated). Two bounded, documented residuals:
> (1) `deals.closeDate` still uses `shared.isStrictDate` (the laxer check) — this refactor
> intentionally does NOT touch `shared.ts` to keep `deals` out of the blast radius; (2) field-def
> creation now validates the full shape before the dup-key/cap 409s (matching the commerce
> `productFields` precedent) — single-fault responses are byte-identical; only a simultaneously
> malformed-AND-duplicate request flips which 4xx surfaces first. Full CRM suite green + new
> rollover-date-rejected / leap-day-accepted / string-still-bounded tests
> (`crm-org-route.test.ts`).

## Alternatives weighed

- *Extend CRM `CustomEntity` to `'product'`* — rejected (couples CRM to a commerce concept;
  the ADR 0240 boundary decision).
- *Full extraction + refactor CRM in this PR* — rejected for blast radius on core CRM; the
  seam is extracted, CRM adoption is a follow-on.
- *Keep only the DEF-4 attribute bag* — rejected; typed fields (enum/number/date/required)
  are the recorded follow-on's value.

## Wire honesty (no RFC)

Host-side only: a new host module (pure logic), a new commerce collection, additive-optional
`Product.customFields`, new host-ext routes. No run-event/capability/endpoint change; no
migration (existing products read back with no `customFields`).

## Implementation

| Piece | Files |
|---|---|
| Shared seam (types + cleanEnumOptions + buildFieldSpec + validateFieldValues) | `host/customFields/index.ts` (new) |
| Product field defs + typed customFields validation | `features/commerce/productFields.ts` (new) |
| `Product.customFields` wired into create/update; `__resetCommerce` clears defs | `features/commerce/commerceService.ts` |
| `/product-fields` CRUD + customFields on create/update + storefront projection | `features/commerce/routes.ts` |
| FE: field-def manager + typed value editor + storefront display + client + i18n | `frontend/react/src/features/commerce/{CommercePage,StorefrontPage,commerceClient}.tsx`, `i18n/*` |
| Tests (seam unit + product field-def CRUD + typed round-trip + validation) | `test/commerce-followon-c.test.ts` (5) |

## Open questions / follow-ons

- ~~**CRM adopts the shared seam** (replace its inline validator) — behavior-preserving,
  deferred to protect core CRM. The main outstanding item.~~ **SHIPPED** — see the "CRM adoption
  of the seam is a DOCUMENTED FOLLOW-ON" completion note above (delegates shape + value-loop to
  the seam; the only behavior delta is the stricter rollover-date rejection; `deals.closeDate`
  deliberately untouched).
- **`reference` product fields** (e.g. a product referencing another product) — out of v1;
  the seam supports it via an injected resolver when needed.
- ~~**Editing typed values on an existing product** in the admin — the create form sets them,
  but there is **no product-edit form**, so typed values can't be changed after creation and a
  new required field can't be backfilled onto older products (the PATCH route already supports
  it; only the UI is missing). A per-product edit UI is the main FE refinement.~~
  **SHIPPED (FE follow-on):** `ProductForm` is now parameterized with an optional `product?` —
  each product row has an **Edit** action that opens an edit-in-place form seeded from the row
  (incl. typed `customFields`). Edit is WYSIWYG: it sends every editable field (null/`[]`/`{}`
  to CLEAR) so a cleared value persists through the PATCH's replace-on-present semantics; `type`
  is locked (the PATCH route ignores it). Guarded by the first commerce FE tests
  (`__tests__/ProductForm.test.tsx` — seed + the replace-on-clear regression + the type lock).
- **Review fixes applied:** the seam uses host `cleanString` (secret-shape scrub) for string
  values since they're publicly served; the storefront resolves customFields to LABELLED pairs
  (shoppers see "Material", not `material`); the admin required-marker uses `Field`'s `required`
  prop; the required chip is neutral (not `chip--warning`). The date check is intentionally
  stricter than CRM's (rejects rollover dates) — noted so the CRM-adoption follow-on reconciles it.

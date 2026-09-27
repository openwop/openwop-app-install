# ADR 0240 — Commerce depth: product attributes, Deal-on-paid, AP2 signing, and the productGrid picker

Status: implemented (Phase 3 of the ecommerce-deferral plan)

Relates to: ADR 0177 (commerce package), ADR 0188 (UCP buyer / AP2), ADR 0008 (CRM),
ADR 0162 (deterministic-id idempotency), ADR 0213 (CRM custom-field FieldDefs). No
OpenWOP wire change (UCP/AP2 are external client protocols); no schema migration.

## Context

Four recorded deferrals, "depth" shaped:

- **DEF-2 — AP2 mandates not VC-signed.** `buildPaymentMandate` always attached
  `ap2_vc_signing_not_configured` — every payment mandate was structurally complete but
  carried no cryptographic proof.
- **DEF-4 — no product custom fields.** Products had no way to carry merchant-defined
  detail (Material, Origin, …). The plan noted "extract the CRM FieldDef seam."
- **DEF-8 — no CRM Deal on a sale.** `markAsPaid` linked a Contact + an Activity but
  never opened a Deal for the revenue.
- **DEF-9 — raw productGrid editor.** The CMS productGrid section took a free-text org id
  + a newline-separated product-id textarea.

## Decision

### DEF-2 — real Ed25519 AP2 signing (implement); MCP transport (defer at a real gate)

`ap2Mandates.ts` gains `signPaymentMandate` / `verifyPaymentMandate` / `canonicalMandatePayload`.
When `OPENWOP_AP2_SIGNING_KEY` (a PKCS8 Ed25519 PEM) is configured, a placed mandate carries
a real `proof` and the unsigned warning is cleared; unconfigured ⇒ the honest unsigned warning
stands; a bad key ⇒ an `ap2_vc_signing_failed` warning (signing NEVER throws — it must not
break a placement). `ucpBuyerService` signs at placement.

**Honesty on the proof:** `proof.type` is `OpenwopAp2Ed25519Json` — a raw EdDSA signature
over `JSON.stringify(mandate-minus-warnings/proof)`, deliberately **NOT** labelled as the
W3C `Ed25519Signature2020` Data-Integrity suite (which mandates URDNA2015/JCS canonicalization
we don't perform). It proves **integrity** (the mandate wasn't altered after signing); it does
**not** prove **authenticity** unless the relying party pins the public key out-of-band — the
embedded `publicKeyJwk` is a convenience, not a trust anchor. A conformant VC-Data-Integrity
proof is a follow-on (alongside MCP transport, gated on a real conformance target).

**MCP transport is deferred**, documented: the REST buyer transport is the working floor,
and MCP-transport merchant discovery has **no real MCP merchant to conform against** — a
genuine gate, not scope-cutting.

**No RFC:** UCP and AP2 are *external* client protocols (the buyer calls external merchants),
not the OpenWOP wire.

### DEF-4 — bounded product attributes, NOT a CRM FieldDef extraction

`Product` gains optional `attributes: {label, value}[]` — a bounded key/value bag (≤ 20 pairs,
trimmed, length-capped, blank/dupe-label dropped), edited in the admin product form and shown
on the storefront. **Rejected:** extending CRM's `CustomEntity` to `'product'` (that makes
CRM aware of a commerce concept — a boundary violation) or extracting FieldDef to a shared
seam (a risky cross-feature refactor for marginal typing value). Additive-optional (no
migration; absent ⇒ byte-identical). Typed FieldDef-parity is a noted deferred richer option.

### DEF-8 — opt-in Deal-on-paid

A new governance flag `commerce.dealOnPaid`. When set AND the paid order links a `contactId`,
`markAsPaid` opens a **won** Deal (title `Order <id>`, amount = order total), **idempotent by
`deal:commerce-order-<orderId>`** (ADR 0162) so a webhook re-delivery links the SAME deal.
Best-effort (a Deal failure NEVER blocks payment); the gate is read **fail-open** here (unlike
the spend gate — a policy hiccup skips this convenience linkage, it doesn't hold money). Uses
the `commerce→crm` import edge already established by the order-paid Activity, with the shared
`makeLinkValidators`.

### DEF-9 — productGrid store + product picker

The CMS productGrid editor gains a `ProductGridEditor`: a store (org) dropdown (the operator's
orgs) + a product multiselect fed by the chosen store's **public** products — via the same
direct-fetch path `SectionRenderer` uses (`/public-store/:orgId/products`), so the CMS feature
takes **no cross-feature client import**. Degrades to designed empty/loading/error states so a
transient fetch failure never blocks authoring.

## Wire honesty (no RFC needed)

All host-side: additive-optional `Product.attributes`, an additive `Ap2Proof` on the buyer's
own mandate objects (not the OpenWOP wire), a governance flag, and an FE editor. No run-event,
capability, or endpoint-contract change; no migration.

## Implementation

| Piece | Files |
|---|---|
| AP2 sign/verify (Ed25519) + canonical payload; sign at placement | `features/commerce/ucpBuyer/ap2Mandates.ts`, `ucpBuyerService.ts` |
| `Product.attributes` + `cleanAttributes`; create/update + public-store projection | `features/commerce/commerceService.ts`, `routes.ts` |
| `commerce.dealOnPaid` flag; won-Deal-on-paid (idempotent) | `host/governanceService.ts`, `features/commerce/commerceService.ts` |
| FE: attribute editor (admin) + storefront display; productGrid store/product picker | `frontend/react/src/features/commerce/{CommercePage,StorefrontPage,commerceClient}.tsx`, `features/cms/SectionsEditor.tsx`, i18n |
| Tests | `test/commerce-phase3-deferrals.test.ts` (7) |

## Open questions / follow-ons

- **MCP transport** for the UCP buyer — deferred until a real MCP merchant exists to conform
  against; the REST floor stands.
- **Typed product custom fields** (a FieldDef-parity registry) — the attribute bag is the
  right-sized floor; a typed/enum/validated version is a future refinement.
- ~~**Deal-on-paid pipeline/stage** uses the org's default pipeline (auto-provisioned); a
  configurable target pipeline/stage is a future refinement.~~
  **CORRECTION (follow-on, 2026-07-04):** shipped. `commerce.dealOnPaid` gains optional
  `dealOnPaidPipelineId`/`dealOnPaidStageId` (additive, keeps the boolean — no type-break);
  `markAsPaid` passes them to `createDeal`, whose `resolveStage` validates the ids belong to
  the org (a bad id ⇒ the best-effort linkage skips, never blocks payment). Absent ⇒ the org
  default (shipped behavior). Tests: `commerce-followon-a.test.ts`.
  Note: the governance policy is tenant-wide but a configured pipeline/stage belongs to ONE
  org, so in a multi-org tenant only that org's paid orders link a Deal on the configured
  pipeline; other orgs fall through to their own default (fail-safe, logged). A per-org deal
  target is a future refinement if multi-org tenants adopt this.

# ADR 1098 — Unlisted (quote-only) commerce products

Status: Accepted (2026-11-11). Implemented in the PR that records it.

Extends the commerce catalog (ADR 0410's `commerce.product`), quotes (C3) and the
public storefront (ADR 0875 D7). This is host-extension work under `/host/openwop-app/*`
only, so it needs no wire RFC.

## Context

A seller can only sell a product publicly or not at all. A product that is
`active` shows on the public storefront and can be bought by anyone. A product
that is not `active` cannot go on a quote either: `acceptQuote` reprices every
line and refuses an inactive product with `409 quote_stale`.

Some products are sold only after a conversation: a design retainer, a custom
build, a negotiated service. The seller wants to quote them and let the customer
accept the quote, but not list them for anyone to buy. Exclusive assortments (ADR 0228 D3) don't
help, because they restrict which buyers see a product, and anonymous buyers are
not restricted.

The first adopter to need this is a white-label deployment for residential design
firms, whose retainer checkout runs through a quote.

## Decision

### D1. One optional field

`Product.unlisted?: boolean`. Absent means listed, so existing rows need no
migration. The field is closed-world:
- `true` or `false` are accepted;
- any other value is a `400 validation_error` with `details.field: 'unlisted'`;
- `false` removes the key, so an unlisted product that is relisted reads exactly
  like one that never was.

Admin CRUD:
- `POST /host/openwop-app/commerce/orgs/:orgId/products` takes `unlisted: true`.
- `PATCH …/products/:productId` takes `unlisted: true | false`.
- The member product list and detail return the field. The commerce admin form
  shows it as "Unlisted (quote only)", and the product list shows a "quote only"
  chip.

`unlisted` is independent of `active`. An archived product is hidden everywhere
and can't be quoted. An unlisted product is hidden from public lanes but can be
quoted.

### D2. One predicate for public lanes

`isPubliclyListed(p) = p.active !== false && p.unlisted !== true`
(`features/commerce/commerceService.ts`). Every public or outward-facing product
lane filters through it:

| Lane | File | Effect |
|---|---|---|
| Public store list | `commerce/routes.ts` | Hidden |
| Public product detail | `commerce/routes.ts` | `404`, the same as missing |
| Public checkout, one-click upsell | `createOrderCore` (`activeOnly`) | `400`, the same message as a missing product |
| UCP agent commerce: catalog, item, cart checkout | `commerce/ucp/routes.ts` | Hidden; item `404`; checkout `400` |
| Ad catalog feed (Google, Meta) | `campaign-connectors/catalogFeed.ts` | Never in the feed |
| Discovery search and collections | `discovery/discoveryService.ts` | Out of the base set; fusion can't widen it |
| Recommendations | `recommendations/recommendationsService.ts` | Never recommended |

A public caller never learns that an unlisted product exists. Every refusal is
the answer a missing product gets.

### D3. Outward references refuse

A funnel offer, a campaign's product link and an ad variant's product all point
customers at a product. They refuse an unlisted product with
`400 validation_error`, `details.reason: 'product_unlisted'`, through one helper,
`refuseUnlistedProduct`. This is a deliberate choice: a quote-only product can't
be advertised. Reversing it for one lane means removing that lane's call and
reclassifying it in the census below.

### D4. Quotes and operator lanes keep it

These still see an unlisted product, and show the flag:
- quotes, including the public share-link accept and its Stripe checkout;
- the member product list and detail;
- the commerce chat tools and workflow surface (their projections are deny-lists);
- subscriptions (a `workspace:write` route);
- product media and the operator data export.

`acceptQuote` keeps its `active` check, so archiving a quoted product still makes
the quote stale.

### D5. A census keeps new lanes honest

`test/adr1098-unlisted-products.test.ts` lists every source file that calls
`listProducts`, `getProduct` or `getProductInTenant`, and requires each to be
classified:
- `public` files must use `isPubliclyListed`;
- `outward` files must call `refuseUnlistedProduct`;
- `operator` files must state why they keep unlisted products.

A new product reader fails the test until someone chooses its rule. A file that
stops reading products must leave the table.

## Alternatives considered

- **Assortment-only products.** Assortments restrict buyers, not products, and
  anonymous storefront buyers are never restricted. It would need a second
  visibility system.
- **Let quotes accept inactive products.** That merges "archived" with
  "quote-only". An archived product would come back to life through an old quote.
- **A `visibility: 'public' | 'unlisted' | 'archived'` enum replacing `active`.**
  It's cleaner on paper, but `active` is read across a dozen product lanes, plus the
  kernel's `active` scalar. Replacing it is a migration with nothing gained
  over D1.

## Not changed

- No schema change and no app migration; the field rides the product row.
- The kernel `commerce.product` scalars are unchanged. The type is façade-only
  (`publicRead` is off), so no public entity read can surface the product. If
  ADR 0410's Phase 3 ever turns on `publicRead`, it must filter through
  `isPubliclyListed`.
- The discovery embedding index still embeds unlisted products. It is internal,
  and `searchProducts` bounds semantic fusion to its listed base set.

## Implementation record

| Part | Where |
|---|---|
| Field, predicate, refusal helper, create/PATCH validation, checkout gate | `features/commerce/commerceService.ts` |
| Admin CRUD and public store | `features/commerce/routes.ts` |
| UCP, catalog feed, discovery, recommendations | the files in D2 |
| Funnel offer, campaign product links, ad variant sets | `funnels/funnelsService.ts`, `campaign-orchestration/routes.ts`, `campaign-orchestration/variants/variantSetService.ts` |
| Admin form, list chip, 4 locales | `frontend/react/src/features/commerce/` |
| Behaviour and census tests | `test/adr1098-unlisted-products.test.ts` |

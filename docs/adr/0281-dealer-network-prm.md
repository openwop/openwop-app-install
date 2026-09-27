# ADR 0281 — Dealer Network, Retail Outlets & Partner Relationship Management

**Status:** implemented
**Date:** 2026-07-06
**Depends on:** ADR 0001 (feature-package), ADR 0006 (RBAC), ADR 0008 (CRM company),
ADR 0272 (Territories — dealer↔territory), ADR 0013 (Sharing — partner portal precedent),
ADR 0012 (Publishing), ADR 0014 (surface), ADR 0015 (tenant).
**Toggle:** `dealers` (new, default OFF, `bucketUnit: tenant`)
**Surfaces:** authed `/v1/host/openwop-app/dealers/orgs/:orgId/*` + a public partner portal
(`/v1/host/openwop-app/partner/:token`, host-ext, non-normative).
**RFC gate:** **Host-extension — NO new wire RFC.**

## 1. Context
Concepts 7 & 8 of the deep-dive (the CDK/Reynolds automotive-DMS + Salesforce PRM shape):
**dealer-network** records + **retail-outlet** (store-location) records + a **partner
portal** (onboarding, deal registration, MDF, channel analytics). None exist today — the
nearest primitives are the CRM `Company` and the Sharing per-record ACL.

## 2. Boundaries audit
- No `dealer`/`outlet`/`PRM` code anywhere. `/v1/host/openwop-app/dealers` + `/partner` are **free prefixes**.
- **A dealer REFERENCES a CRM `companyId`** (the org's existing company record) — no fork of `Company`, the ADR 0177/0172 "reference-not-fork" precedent (`commerce` links a CRM `contactId`; `production` references a `companyId`).
- **Dealer↔territory** rides ADR 0272: a dealer/outlet is assignable to a territory (a `territoryId` reference), so the territory map + attainment cover the dealer network for free.
- **Partner portal** = the Sharing/Publishing pattern (ADR 0013 `(resourceType, resourceId)` token + resolver; ADR 0012 published-only public surface) — tenant derived from the resource, capability-token auth, uniform 404. **No new public-auth model.**

## 3. Decision
New `src/features/dealers/` package:
```
Dealer  { dealerId, tenantId, orgId, companyId /*CRM ref*/, name, tier, status:'active'|'suspended',
          territoryId? /*ADR 0272*/, createdAt, updatedAt }
Outlet  { outletId, tenantId, orgId, dealerId, name, address, lat?, lng?, status }  // a physical store
DealRegistration { regId, tenantId, orgId, dealerId, dealTitle, companyName, status:'pending'|'approved'|'rejected', at }
```
PRM: a partner (dealer) gets a **capability-token portal** (Sharing pattern) to register
deals + view their outlets/status. MDF/co-sell are deferred (see §7).

## 4. Evaluation matrix
| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | `src/features/dealers/`; appended to `BACKEND_FEATURES`; imports CRM company (peer), territories (peer, optional), Sharing (peer). |
| 2 | Toggle + admin | `dealers`, OFF, `tenant`, category Business Tools. Dealer/outlet CRUD in the feature admin. |
| 3 | Workflow surface | `ctx.features.dealers` — reads (list dealers/outlets/registrations); governed writes (approve-registration) scope-checked (ADR 0272 A5 pattern). |
| 4 | Node pack | `feature.dealers.nodes` — list-dealers, list-outlets, list-registrations (read); approve-registration (governed). |
| 5 | Envelopes | `dealers.list` read envelope for chat. |
| 6 | Agent pack | `feature.dealers.agents` — advisory **Channel Manager** (reads network/registrations; proposes approvals; human disposes). |
| 7 | Public surface | Partner portal under `/v1/host/openwop-app/partner/:token` — added to `PUBLIC_PATH_PREFIXES`; tenant from the token's resource; capability-token only; uniform 404; rate-limit + payload caps (ADR 0013 discipline). |
| 8 | RBAC | Internal dealer/outlet admin = `workspace:write`; registration approval = `host:dealers:manage`. Partner portal = token-scoped (no session). Fail-closed + IDOR-guarded on tenant+org. |
| 9 | Replay | Dealer/outlet writes are non-run side-effects (replay-trivial); a governed approve stamps the approver. |
| 10 | Frontend | `/dealers` — dealer directory + outlet list; **outlet map view composes ADR 0282** (falls back to a list when maps is off). |

## 5. RFC gate — host-extension, NO RFC
Dealer/outlet/registration are host-ext resources; the partner portal reuses the Sharing
capability-token public surface (non-normative). No wire event, no new scope vocabulary
beyond one `host:` management scope.

## 6. Phased plan
P1 dealer + outlet model (CRM `companyId` link, optional `territoryId`). P2 deal
registration + the capability-token partner portal (Sharing pattern). P3 `ctx.features.dealers`
surface + node/agent packs. P4 frontend dealer directory + outlet list. P5 outlet **map**
(composes ADR 0282; list fallback when off). Reviews per phase.

## 7. Alternatives weighed
- **Model a dealer as a CRM `Company` subtype** — rejected: a dealer carries channel-specific
  state (tier, registrations, portal) + a territory link; overloading `Company` forks its
  semantics. Reference it instead.
- **A bespoke partner-auth system** — rejected: the Sharing capability-token + resolver already
  models "an external party with scoped access to one resource." Reuse it.

## 8. Open questions
- MDF (market-development funds) + co-sell workflow — deferred (a larger channel-finance surface).
- Outlet geo precision (rooftop geocoding) — the geocoding seam is ADR 0282's; v1 stores address + optional lat/lng.

## 9. Recorded non-ships
MDF/co-sell; multi-tier distributor hierarchies; the automotive-DMS operational suites
(F&I, fixed-ops, inventory — those are a vertical DMS, out of scope for a horizontal host).

## 10. Implementation (P1–P5)
| Phase | What shipped | Notes |
|---|---|---|
| P1 | Dealer (CRM `companyId` ref, validated visible; optional `territoryId`) + Outlet model; full CRUD; dealer delete cascades outlets (children-first); `host:dealers:manage` scope; type-predicate validators; geo bounds | `entities/dealer.ts`; `dealers-crud.test.ts` |
| P2 | DealRegistration + PartnerToken; capability-token partner portal on `PUBLIC_PATH_PREFIXES` (partner-safe projection, uniform 404, rotation); internal approve/reject (anti-double 409) | `entities/registration.ts`, `middleware/auth.ts`; `dealers-partner-portal.test.ts` |
| P3 | `ctx.features.dealers` surface (A5 governed approveRegistration); node pack (3 read + 1 governed) + advisory Channel Manager agent (read-only) | `surface.ts`, `packs/feature.dealers.{nodes,agents}`; `dealers-surface.test.ts` |
| P4 | Frontend `/dealers` — directory (create referencing a CRM company) + per-dealer outlets + portal-link + registration approve/reject; all `ui/` design-system | `frontend/react/src/features/dealers/*`; FEATURES.md row |
| P5 | Outlet **map** view — composes ADR 0282 (Sales Maps). Until maps ships, the outlet **LIST** is the designed fallback (ADR §10 "falls back to a list when maps is off"), with a copy hint that a map appears when the maps feature is enabled | list fallback in `DealersPage.tsx` |
| P6 | **Outlet detail page** (`/dealers/outlets/:outletId?org=…`) — the sales-map pin deep-link target (ADR 0282 P5 deferral resolved): outlet status/address/coordinates + owning-dealer link into the `?dealer=` master/detail. ADR 0336 deep-link contract (derived target, fail-closed on missing org, 404 = not-found, gate-before-fetch). Backend route pre-existed (`GET …/outlets/:outletId`); frontend-only | `OutletDetailPage.tsx`, `OutletDetailPage.test.tsx` |

**Correction vs plan (§7 Sharing reuse):** the plan said "reuse the Sharing capability-token + resolver." In implementation the sharing service's resolver is bound to **CMS content types** (`resolveSharedRefs` → pages/cards), so forking it to know about dealers would couple two features. We instead reused the Sharing **pattern** (opaque capability token + resolve-tenant-from-token + `PUBLIC_PATH_PREFIXES` + uniform-404 discipline), minting a **dealers-owned** token. Same security shape, no cross-feature fork.

**P5 note:** the map is a genuine cross-feature compose with B3 (ADR 0282), which is a later build. The list fallback is not a stub — it is the ADR-specified off-state, fully functional; the map lights up when `sales-maps` is enabled and its outlet-pin projection is wired.

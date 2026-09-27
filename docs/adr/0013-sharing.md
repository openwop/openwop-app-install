# ADR 0013 — Sharing (public share links)

**Status:** implemented (Phases 1–3 shipped — `src/features/sharing/` incl. public `/v1/host/openwop-app/shared/:token`)
**Date:** 2026-06-09
**Depends on:** ADR 0001 (feature-package architecture), ADR 0004 (Orgs),
ADR 0006 (RBAC), ADR 0009 (CMS — a shareable resource), ADR 0011 (KB — a shareable resource)
**Toggle:** ~~`sharing`~~ — **none; always-on since ADR 0434** (correction below)
· **Surfaces:** authed `/v1/host/openwop-app/sharing/*`
+ **public (unauthed)** `/v1/host/openwop-app/shared/:token` (host-extension, non-normative)

> **CORRECTION 2026-08-18 (SHARE-1 / SHARE-11).** This header declared
> `**Toggle:** sharing` long after ADR 0434 removed that toggle, and
> `features/sharing/feature.ts`, `FEATURES.md` and `middleware/auth.ts` each
> asserted that "each resolver still applies its OWN feature's toggle" in its
> place. That was true for five of twelve resource types. Seven —
> `cms_page`, `kb_collection`, `document`, `conversation`, `prompt`,
> `commerce_quote`, `commerce_order` — applied no toggle at all, so a tenant
> that disabled the owning feature kept serving that content on the public
> internet with no kill-switch anywhere.
>
> The gate now lives in ONE place (`owningFeatureEnabled`, driven by a
> `toggleId` on each resolver, resolved against the **link's** tenant on every
> public entry point and at mint). Its honest reach: **eight** types are
> toggle-gated (`documents`, `commerce` ×2 join `creative-briefs`,
> `app-builder`, `slides`, `crm` ×2). **Four cannot be** — `cms`, `kb` and
> `prompts` graduated to always-on and the conversation store is core chat, so
> none declares a toggle to consult; each records `toggleId: null` with its
> reason in source. For those four, revocation, expiry and deleting the
> resource are the only controls, and that is now said out loud instead of
> being covered by a claim.

> **FOLLOW-UP CORRECTION 2026-08-18 (R2 adversarial review of the same change).**
> Four things the fix above got wrong or overstated, recorded here because each
> was a claim, not just a bug.
>
> 1. **The gate reintroduced the lie it closed, on the owner's side.** Making
>    eight types darkenable made a NEW state reachable — a link whose resolver
>    now 404s while nothing about it looks dead. `listLinks` computed the gate
>    boolean and then discarded it, so the management row rendered a green
>    "Live" chip (titled with the raw `resourceId`, since the card lookup is
>    skipped) for exactly those links. The boolean is now on the wire
>    (`featureDisabled`), with its own `LinkStatus` member, chip and row copy,
>    and it counts as NOT live. The public viewer's copy no longer names
>    revocation as the sole cause of a dead link either — it cannot say which
>    gate closed (that would make the resolve a token-validity oracle), so it
>    stops asserting one.
> 2. **The SHARE-2 erasure blast radius named the ONE category it does not
>    touch.** Both the source comment and the PR body said erasure "breaks live
>    booking-reschedule and e-sign tokens minted by the erased member". It does
>    not: `eraseSubjectSharing` matches `createdBy === subjectKey`, and every
>    capability token is minted by a SYSTEM actor (`system:crm-booking`,
>    `system:crm-sign`, `system:commerce`). The only mint site that attributes a
>    link to a human is the authed management route. So the real radius is every
>    CONTENT link that person minted by hand — CMS page, KB collection,
>    document, prompt, deck, app design, shared conversation — while the org's
>    booking, e-signature and order-status tokens are UNAFFECTED. On a GDPR path
>    in a change whose thesis is honest stated consequences, publishing the
>    inverse of the actual behaviour is the worst kind of error, so it is
>    corrected in source, in the PR body, and here.
> 3. **SHARE-5 put two destructive decisions on a non-authoritative index.**
>    `purgeLinksForResource` (a delete cascade) and `hasActiveLinkForResource`
>    (a retention SURVIVE-condition) were moved onto `listForTenantIndexed`,
>    whose contract is explicitly "delayed, not lost" — the same reason
>    `purgeTenantRows` refuses it. A miss in the first leaves a permanent
>    orphan; a miss in the second DELETES a canvas that still has a live public
>    link. Both are back on the complete scan (the second keeps the indexed
>    slice as a fast path and falls back, so it is never worse than the
>    pre-SHARE-5 baseline). `eraseSubjectSharing` was reverted for the same
>    reason. Only `listLinks` — a read whose miss is a row absent from a list —
>    still rides the index.
> 4. **`creative_brief` was counted in "11 of 12" on a route-level cascade.**
>    `deleteBrief` itself did not purge, so the demo-clear seeder and the bulk
>    delete orphaned every link they killed — the identical non-route-deleter
>    defect WF-SHARE-3 fixed for canvases and documents. The cascade now sits on
>    the delete owner, which is what the count claimed.

---

## Context (boundaries audit first)

Next candidate from the MyndHyve catalog (not in the explicit cuts). MyndHyve's
**Sharing** is "public, tokenized share links + social-card generation"
(`sharingApi`). It is the natural pair to ADR 0012 Publishing: where Publishing
serves an org's **published** pages at a stable org-addressed URL, Sharing mints
an **unguessable capability link to a SPECIFIC resource** — including ones the
public surface deliberately won't serve (a **draft** page sent to a stakeholder
for review, a knowledge collection shared read-only).

The substrate exists (most proven out by ADR 0012):

- **Unguessable capability tokens** — `randomBytes(32).toString('base64url')` is
  the host's token recipe (media-asset serve tokens, RFC 0055); the token IS the
  credential, so the link is intrinsically un-enumerable.
- **The public-route pattern** — add a prefix to `PUBLIC_PATH_PREFIXES`
  (auth.ts), resolve tenant server-side, gate on a toggle (ADR 0012's blueprint).
- **Shareable resources compose cleanly** — `cmsService.getPage(tenantId, orgId,
  pageId)` and `kbService.getCollection`/`listDocuments(tenantId, orgId, …)` are
  already org-scoped `(tenantId, orgId, resourceId)` reads.

What's **missing** (all new): the share-link store, the mint/list/revoke surface,
the public token resolver, and a **resolver registry** so resource types are
pluggable rather than special-cased.

## Decision

A `sharing` feature-package (toggle `sharing`, default OFF, `bucketUnit:
tenant`) that mints **share links** — an unguessable token bound to a resource
reference — and resolves them on a public, unauthenticated surface. It does NOT
copy resource data: a link points at a `(resourceType, resourceId)`, and a
**resolver** for that type loads a read-only projection at resolve time (so a
revoked/edited/deleted resource is reflected immediately).

### The generic mechanism — a resolver registry (not a per-type special case)

```
ShareResolver {
  validate(tenantId, orgId, resourceId): Promise<void>   // mint-time: in-org? (404 else)
  load(tenantId, orgId, resourceId): Promise<unknown|null> // public read-only projection
  card(tenantId, orgId, resourceId): Promise<Card|null>    // OG/social-card metadata
}
const RESOLVERS: Record<ResourceType, ShareResolver> = { cms_page, kb_collection }
```

A static map keyed by `resourceType` (the right altitude flagged in the ADR 0012
review — a reusable public-resource mechanism, not bespoke routing per type).
v1 ships two resolvers (`cms_page` composes `cmsService`; `kb_collection`
composes `kbService`); a third type is one map entry, no routing change.

### The model

```
ShareLink { token, tenantId, orgId, resourceType, resourceId, label?,
            createdBy, createdAt, expiresAt?, revoked }
```

`token` is the unguessable id (and the public credential). `expiresAt` optional
(mint with `expiresInDays`); `revoked` is a soft-revoke so the public resolve can
distinguish (both still 404 publicly — uniform, no info leak).

### Phase 1 — share-link store + resolver registry + authed CRUD (backend)

`DurableCollection<ShareLink>('sharing:link')` keyed by token. Routes under
`/v1/host/openwop-app/sharing/orgs/:orgId/links`, `authorizeOrgScope`-gated:
- `POST` (`workspace:write`) `{resourceType, resourceId, label?, expiresInDays?}`
  → reject an unknown `resourceType`; `resolver.validate` asserts the resource is
  in this org (cross-org/tenant `resourceId` fails closed); mint + store.
- `GET` (`workspace:read`) — the org's links (token + metadata + the resource's
  current card title).
- `DELETE …/:token` (`workspace:write`) — revoke; tenant+org IDOR-guarded.

### Phase 2 — public resolve + OG card (backend, unauthed)

Add `'/v1/host/openwop-app/shared'` to `PUBLIC_PATH_PREFIXES` (verified NOT to shadow
the authed `…/sharing/*` — `sharing` ≠ `shared`). Routes (no auth; tenant from the
link; gated on the link-tenant's `sharing` toggle; uniform 404 on
missing/expired/revoked/feature-off/resource-gone — no enumeration signal):
- `GET /v1/host/openwop-app/shared/:token` → `{resourceType, label, resource}` via the
  type's `load`.
- `GET /v1/host/openwop-app/shared/:token/card` → `{title, description, imageUrl?}` via
  `card` (social preview).

### Phase 3 — frontend

`SharingPage` (FrontendFeature, nav-gated on `sharing`): an org picker → a
resource picker (CMS pages / KB collections) → mint a link (optional label +
expiry), the org's active links with **copyable public URLs** + revoke.
`sharingClient.ts`. The `npm run build` gate must pass.

## Architectural constraints honored

- **Compose, don't copy:** a link stores a reference; resolvers READ
  `cmsService`/`kbService` at resolve time — no duplicated resource data, edits/
  deletes reflected live. CMS (0009) + KB (0011) untouched.
- **Capability-token security (RFC 0055 pattern):** the token is the credential
  (un-enumerable); the public surface derives tenant from the link (never the
  request), gates on the toggle, and 404s uniformly.
- **Pluggable, not special-cased (altitude):** a resolver registry; new resource
  types are a map entry. One justified core edit — the `PUBLIC_PATH_PREFIXES`
  allowlist (the ADR 0012 pattern).
- **RBAC (ADR 0006):** mint/revoke = `workspace:write`, list = `workspace:read`;
  cross-org/tenant resource ids + links fail closed.
- **No wire surface → no RFC:** entirely under `/v1/host/openwop-app/*`.

## Alternatives considered

1. **Bake share-link logic into each feature (cms/kb own their own links).**
   Rejected — scatters the token/expiry/revoke + public-resolve security across
   features; the registry centralizes it once and each feature just exposes a
   read projection.
2. **Copy a snapshot of the resource into the link** (immutable share). Rejected
   for v1 — live resolve is simpler and reflects edits/revocation; an immutable
   "snapshot share" is a follow-on (it needs a versioned copy + GC).
3. **QR codes now** (MyndHyve's `QRCodeService`). Deferred — a correct QR encoder
   is non-trivial and openwop is zero-runtime-dep; hand-rolling one would be a
   fragile bandaid. The share URL is copyable; QR is a follow-on (a vetted dep or
   a host-side image service).
4. **Public search over a shared KB collection.** Deferred — v1 shares a
   read-only **overview** (name + document titles); exposing query on a public
   link is a larger surface (rate-limiting, cost) better gated behind its own ADR.

## Open questions

- [ ] **QR + richer social cards** (server-rendered OG image) — needs an image
  surface (alt. 3).
- [ ] **Snapshot/immutable shares** (alt. 2) — a versioned copy + retention.
- [ ] **Per-link access controls** (password, view caps, audit of views) — v1 is
  unguessable-link-only.
- [ ] **More resource types** (profiles once org-scoping is reconciled; a shared
  KB search per alt. 4).

# ADR 1122 — Asset serve URLs are identifiers; the serve route authorizes each read

Status: Accepted (2026-11-14, issue #5929 item 3; reviewed by the release coordinator, P0 approved to build)

No wire change. RFC 0055 §C rule 1 requires a host to scope asset URLs to the run's
tenant and keep them unguessable. Today the token alone does both; this ADR adds an
authorization check at the serve route, which tightens that rule rather than changing
it. The conformance legs (`media-url-inline-cap.test.ts`) fetch the URL with the
harness's own credentials, which the session arm below admits. The serve route is a
host-extension path (`/host/openwop-app/assets/:token`).

## Context
`GET /host/openwop-app/assets/:token` (`routes/mediaAssets.ts:105`) serves bytes to anyone
holding the token. It checks that the token resolves and has not expired, and nothing
else: no session and no tenant compare. `resolveMediaAsset` (`host/inMemorySurfaces.ts:2064`)
says request-bound callers MUST compare the entry's tenant; this one does not.

Durable tokens carry a ~100-year expiry (`features/media/mediaStorage.ts:23`, `put` and
PROF-1 `promoteToDurable`). That time-to-live (TTL) is a storage backstop (ADR 0579 owns the lifecycle),
but because the token is also the credential, a URL handed out once works for as long as
the bytes exist. Removing a member, or unpublishing a page, revokes nothing.

Where serve URLs go (inventory, 2026-11-14):
- **Authenticated responses:** the media library (`viewAsset().serveUrl`), profiles
  (raw tokens in `TEAM_VIEW_FIELDS`), films `assetUrls`, slides, CAD, commerce, documents,
  app-builder zips, chat uploads.
- **Run events and artifacts:** AI image and video node outputs (`aiProvidersHost.ts`),
  artifact markdown (`runArtifactStore.ts`).
- **Public:** CMS pages, the blog, RSS, Markdown, prerender (cached `public`), og:image,
  share cards, the podcast feed.
- **Email:** the CRM e-sign certificate (`signService.ts:551`).
- **Cookie-less readers not in the code inventory** (added on review): email and
  newsletter images, opened days later; OG and social crawler images; podcast
  enclosure fetches by podcast apps; and custom-domain or white-label published sites,
  where `__session` is not a first-party cookie. All of these reach a public surface, so
  they ride the public-grant arm (D2.2): a sent campaign holds a grant, as a published
  page does. None of them can rely on a minutes-long signature.

Many surfaces STORE the full URL rather than the token: drawings, slides,
document-editor images, podcast show images, run artifact markdown and run events. Run
events replay, and some rows sit under an integrity hash; `host/assetServePath.ts`
records the rule that stored rows are never rewritten. About 50 tests pin the
`/assets/<token>` shape.

## Decision
**D1. The URL stays as it is.** `/host/openwop-app/assets/<token>` is an identifier.
Nothing stored is rewritten, nothing replayed changes, and no minted URL changes shape.

**D2. The serve route authorizes every read** and passes when any one arm holds:
1. **Session arm.** The request carries a session or bearer principal, and that person is
   present in the asset's tenant. "Present" means the asset's tenant is the caller's
   personal tenant, the caller is a member of that workspace (`isWorkspaceMember`), or
   the caller is an operator (superadmin, wildcard bearer, an env key bound to that
   tenant). It is keyed on the person, not on the active tenant, so an image from your
   personal workspace still renders while a shared workspace is active. When the asset is
   a media-library row with an `orgId`, the ADR 0818 org floor applies as well
   (`assertOrgScope … workspace:read`). Same-origin `<img>` requests carry the
   `__session` cookie through the Firebase `/host/**` rewrite, so authenticated surfaces
   need no client change.
2. **Public-grant arm.** A public surface currently references the token. Features
   register a provider, in the same shape as ADR 0579's
   `registerExternalByteRefProvider`: `registerPublicAssetGrantProvider((tenantId) =>
   tokens[])`. The first providers are CMS published pages (`imageToken`,
   `ogImageToken`), public profiles, the podcast feed, and e-sign envelopes that have not
   been voided. Unpublishing or voiding drops the grant, so the bare URL stops working.
   The lookup is a **point lookup keyed by token**: each provider maintains a grant
   index (`assetgrant:<token>` → the granting surfaces), written when it publishes and
   deleted when it unpublishes. The serve path never scans pages or a catalog, and the
   ADR 1110 whole-catalog ratchet would catch a scan if one were added.
3. **Signed arm.** `?exp=<unix>&sig=<hmac>` (and `kid`) for consumers that carry no
   cookie: export files, headless film and slide renderers, and provider fetches (an
   image sent to a video model). It reuses `presentRemote.ts`'s HMAC (hash-based message authentication code) recipe with
   `interruptToken.ts`'s key-id rotation, minted only by server code that has already
   authorized the read, and it lasts minutes. `assetServeUrl(token, { signedFor:
   seconds })` is the one minting call, so signing lives in `assetServePath.ts` beside
   the path it signs.

**D3. Refusal is a uniform 404**, the same as an unknown token: the same status, the
same body (`{error:'not_found', message:'asset not found or expired'}`) and the same
timing class. A refused read resolves the token as a miss does, so it cannot tell a
caller that the token exists. A route test pins the body and status for both.

**D4. Cache headers are part of the decision.** A shared cache that keeps the bytes
would serve them after a revocation, so:
- Session-arm responses are `private, max-age=300` with `Vary: Cookie`. The `private`
  directive already holds today; `Vary` is new.
- Only public-grant responses may be shared-cacheable: `public, max-age=60`, so an
  unpublish takes effect within a minute at the edge.
- A signed response is `private`, cached no longer than its `exp`.
- Every 404 is `no-store`.

**Revocation bound.** A session read is `private, max-age=300`, so a removed member's own
browser may keep showing an asset it already fetched for up to five minutes. No shared
cache holds it, and no new fetch succeeds. The bound for a public grant is the 60-second
shared TTL. Both are accepted.

A route test pins the header for each arm.

**D5. Staged by one switch,** `OPENWOP_ASSET_ACCESS=off|report|enforce`:
- `off`: today's behaviour.
- `report`: computes the decision, serves anyway, and logs each would-be refusal as
  `asset_access_would_deny {consumer, arm, tenant}`. The consumer is read from `Referer`
  and `Sec-Fetch-Dest`, never the token. These logs are how an un-inventoried consumer
  is found before it breaks.
- `enforce`: refuses.

Default `off` in code. Prod moves to `report`, and to `enforce` once the would-deny
count is zero for seven days, by the user's env write.

**D6. The 100-year TTL stays.** It is a storage lifecycle backstop. Once the token
stops being the credential, its length no longer extends access.

## Alternatives
| Option | What it costs now | What it leaves or forecloses | Reversible |
|---|---|---|---|
| **A. Short-lived signed URLs everywhere** (the issue's suggestion) | Re-mint at every reader, plus an on-the-way-out rewrite of every stored URL: drawings, slides, documents, artifacts, run events | Breaks rows under an integrity hash, and the replay determinism RFC 0055 rule 5 relies on. Prerendered public pages cached for an hour carry expired URLs. About 50 shape tests change. Every holder still has bearer access for the TTL | Poorly: URLs minted in the new shape get stored too |
| **B. Authorize at the serve route (chosen)** | One choke point, a provider seam, a signer for cookie-less consumers | The signed arm is needed only where no session exists. Public surfaces must register grants (four today) | Yes: the switch goes back to `off` |
| **C. Shorten the durable TTL and re-mint on read** | Re-mint machinery | Breaks every stored URL at expiry, and a holder keeps access until it does. Revocation still does not reach a held link | No: expired bytes are gone |

**Dominant force:** stored and replayed content holds the URL, so the URL cannot carry
the authority. Authority has to be decided when the bytes are read. B is the only option
that revokes immediately without rewriting history.

**What would change this:** a consumer that must embed an asset in content read by
cookie-less third parties forever (for example, email newsletters to the public). That
would need its own durable public-grant provider, which D2 already allows.

## Phases
| Phase | Work | Gate |
|---|---|---|
| P0 | `host/assetAccess.ts` `decideAssetRead` (operator, session and public-grant arms), the `asset:grant` point-lookup store, `report` and `enforce`, the uniform 404 and the D4 headers. Route test `adr1122-asset-serve-access.test.ts`. The org floor in D2.1 is NOT in P0: finding the media row from a token needs a token→asset index, or the read would scan the tenant's library | ci + train; prod env `report` (user) |
| P1a | A `media:asset` index keyed by `storageRef`, so the D2.1 org floor is a point lookup | Ships before `enforce` |
| P1 | Public-grant providers: CMS published pages, public profiles, the podcast feed, e-sign envelopes | Ships before `enforce` |
| P2 | Signed arm: `assetServeUrl(…, { signedFor })` plus key rotation, adopted by exports, film and slide renderers, and provider media fetches. Each adoption is found by a P0 would-deny log line or by the inventory above | Ships before `enforce` |
| P3 | `enforce` in prod after seven days with zero would-deny, and the read p95 and DB connection use measured under `report` | The user's own go for the env write, given in the session that applies it. A release coordinator cannot relay it |

> **CORRECTED 2026-11-14 (P1 design, approved by the release coordinator): the P1 rows
> above are renumbered, and the provider design replaces "grant on publish".** A code
> inventory found that CMS content changes while a page stays published, with no
> transition: a live edit, a shared-section edit, the SEO image, a locale release, an
> experiment's snapshots. It also found public readers this ADR had missed: the commerce
> storefront (and discovery, recommendations, UCP and the ad feed), share links,
> document share renders. Profiles have no public view, and podcast audio has its own
> route, so neither needs a grant. The phases are now:
>
> | Phase | Work |
> |---|---|
> | P1a | The provider seam and the reconcile (`host/assetGrants.ts`), the CMS page and SEO providers and their hooks, and the hub-picture walker fix |
> | P1b | Commerce storefront, share links (and document renders) and e-sign certificates |
> | P1c | The D2.1 org floor, over the existing `media:token-idx` (was "P1a"); implemented, see the record below |
>
> **Design (option B).**
> - Each public surface registers `registerPublicAssetRefProvider`, which answers which
>   tokens one grantor makes public now.
> - `resyncPublicAssetGrantor` diffs that answer against the grantor's recorded set
>   (`asset:grantor`) and grants or revokes the difference.
> - Write paths call it after commit (`schedulePublicAssetResync`, on `setImmediate`;
>   it never fails or slows the write).
> - A reconcile on its own two-minute tick, under a per-slot lease, pages the recorded
>   grantor rows on a cursor, so a stale grant is revoked within a cycle. Its slice is
>   sized from a key count so a cycle is about an hour.
> - It also takes one bounded backfill step per surface on a second cursor, paging
>   entity-type rows by key, at most three tenants a step.
> - It never lists every tenant at once.
> - A provider that throws or times out (10 s) keeps that grantor's grants.
>
> **Rejected:** option A (hooks only), which drifts and can't hook an expiry; and option C
> (ask providers at read time), which is a scan per image.
>
> **Revocation bound, per surface (condition 4):**
>
> | Change | Hooked? | Revocation |
> |---|---|---|
> | CMS publish, unpublish, archive, delete, restore, live edit, locale flip, schedule | yes (`recordCmsAction`, `updatePage`, `deletePage`) | immediate + 60 s shared cache |
> | A shared section edited under a published page | yes (`updateSharedSection`, each published page using it) | immediate + 60 s |
> | Experiment start, stop, promote | yes (`recordExperimentAction`) | immediate + 60 s |
> | SEO image (`putSeo`) and any page lifecycle event for its SEO grantor | yes (`putSeo`, `onCmsPageLifecycle`) | immediate + 60 s |
> | Raw writes (`realignStoredOverlays`, `eraseCmsSubject`, migrations) | no | ≤ 1 h + 60 s (reconcile) |
> | Share-link expiry, owner public lapse (P1b) | no | ≤ 1 h + 60 s (reconcile) |

> **DEPLOYMENT RULE (2026-11-14, P1a review).** P0 (#5934, on main and deployed with the
> switch `off`) keys grant rows by token alone. A tenant that put another tenant's token
> on its own published page could write that row first and block the owner's grant for
> good. **`OPENWOP_ASSET_ACCESS` must not be set to `report` or `enforce` on any
> deployment until P1a, which keys rows `<tenantId>|<token>`, is merged and deployed.**
> The guard: on the first reconcile tick with the switch on, `purgeLegacyGrantRows`
> looks for token-only rows. If it finds any, it logs `asset_access_legacy_grant_rows` at
> error level and deletes them. They are inert under the P1a lookup, so their presence
> only proves the rule was broken.

## Implementation record (P1a)
- **`host/assetGrants.ts`:**
  - the provider registry;
  - `resyncPublicAssetGrantor`. Its ordering is crash-safe: it records the union of old
    and new tokens, grants and revokes, then records the new set. A crash part-way still
    revokes on the next pass;
  - `schedulePublicAssetResync`;
  - `reconcilePublicAssetGrantsOnce` and `startAssetGrantReconciler`, started beside the
    retention daemon. Everything is a no-op while `OPENWOP_ASSET_ACCESS` is `off`.
- **CMS** (`features/cms/assetGrantProvider.ts`): the grantor `cms-page:<pageId>` makes
  public everything `publicAssetTokensForPage` returns: the shared refs resolved, then
  deliverable sections (including running experiment snapshots), then the walker.
  `collectMediaTokens` now reads `hub.center.imageToken`, which also fixes the media
  "used by" graph, where deleting a hub picture broke the page without a warning.
- **Publishing** (`features/publishing/assetGrantProvider.ts`): the grantor
  `seo-page:<orgId>|<pageId>` makes public the SEO image while the page is published.
- **Recorded residual:** a withheld locale's overlays are on the row, so their pictures
  are granted too. That over-grants (pictures of an unreleased translation); it never
  under-grants.
- **Tests:** `adr1122-p1a-asset-grants.test.ts` covers draft, published and unpublished
  through the serve route; backfill and revoke through the reconcile for changes made
  while off; a throwing provider keeping its grants; and the hub walker. It is
  sabotage-witnessed: removing the `recordCmsAction` hook, or revoking on provider
  failure, fails a case. `asset:grantor` is exempted in `subject-erasure-coverage`.
- **Still to measure before `enforce` (condition 1):** one reconcile tick's DB time on a
  large tenant under `report`. The tick logs `asset_grant_reconcile` with `ms`.

## Implementation record (P0)
- **Auth reaches the route only when the switch is on.** `/host/openwop-app/assets` is on
  the auth middleware's public-path list, so no session reached the serve route. With
  `OPENWOP_ASSET_ACCESS` at `report` or `enforce`, an asset GET or HEAD becomes an ADR
  0748 credential-optional read (`middleware/auth.ts` `isAccessCheckedAssetRead`). No
  credential, or a cookie that fails verification, passes through anonymous. With `off`,
  the path is a public prefix exactly as before.
- **A refused session reads as no session.** A cookie for an erased or disabled account,
  a revoked session, or a workspace whose MFA requirement the session does not meet is
  cleared or refused as on every route, but the asset read then continues anonymous with
  the identity stripped (`passAnonymous`). It never 401s an `<img>`, so a published
  page's images keep loading for a visitor with a stale cookie. A presented bearer that
  fails is still a 401 (ADR 0434: a refused credential never degrades to anonymous).
  Browsers do not send one on `<img>`.
- **Cost to measure in `report` before `enforce`.** With the switch on, each asset read
  from a signed-in browser pays the session liveness read and one
  `resolveTenantLevelScopes`. A page with many images multiplies that. P3's gate
  includes the read p95 and Cloud SQL connection use measured under `report`.
- Tests: `adr1122-asset-serve-access.test.ts` has ten cases: off, member, removed member,
  stranger and no session (each against the unknown-token body and headers),
  personal-owner isolation, grant and revoke, a foreign-tenant grant, an erased-account
  cookie, stale and invalid cookies, and report equal to off byte for byte. They are
  sabotage-witnessed: removing the decision or the refusal fall-through reddens six.
  `asset:grant` is exempted in `subject-erasure-coverage.test.ts` (no subject data;
  tenant-indexed for teardown).

## Implementation record (P1b)
- **Commerce** (`features/commerce/assetGrantProvider.ts`):
  - The grantor `commerce-product:<productId>` grants `imageAssetTokens` while
    `isPubliclyListed` (ADR 1098). One provider covers the storefront, discovery,
    recommendations, UCP and the ad feed.
  - It returns nothing when `checkOwnerPublicAccess('commerce', tenant)` refuses (the
    toggle is off, or the owner is lapsed past grace): the same check the storefront
    route applies. Download tokens are never granted.
  - Hooks: `createProduct`, `updateProduct` and `deleteProduct`.
  - Backfill: tenants that hold `commerce.product`, via
    `entities.systemTypeTenantsPage`, then each tenant's name-index family on its own
    cursor (`listIndexPage` gains `allOrgs`; an undefined org alone means the no-org
    segment).
- **Share links** (`features/sharing/assetGrantProvider.ts`):
  - The grantor `share-link:<tokenHash>` grants every asset token the link's anonymous
    projection exposes (`RESOLVERS[type].load`, which `resolveShared` serves), as a bare
    43-character token or inside a served URL (`assetTokensInValue`).
  - Nothing is granted once the link is revoked, expired, view-capped, of another
    tenant, or its owning feature is off.
  - A share exposes a page in any status, so this is not the published-only CMS
    helper.
  - Hooks: create, revoke and purge. Expiry and an edit to the shared resource are
    unhooked (≤ 1 h + 60 s).
- **E-sign** (`features/crm/assetGrantProvider.ts`):
  - The grantor `esign:<signRequestId>` grants the asset URLs in the rendered target
    (`assetTokensInText`). That is the signer's anonymous view before completion, and
    a completed request stays viewable. It also grants the certificate once completed.
  - Nothing is granted when voided or declined. Sign requests do not expire.
  - Hooks: `createSignRequest`, `putSignRequest`, and `casSignRequest` on a swap.
- **Tests:** `adr1122-p1b-asset-grants.test.ts` has five cases:
  - listed, unlisted, relisted, deleted;
  - commerce off grants nothing;
  - a share of a draft page, then revoke;
  - the signer before completion, then void;
  - the value walker.

  Sabotage-witnessed: removing the commerce, share-revoke or e-sign hook fails its
  case. 65 commerce, sharing and e-sign files: 463/463.

## Implementation record (P1c)
- **Seam:** `registerAssetOrgResolver` (`host/assetAccess.ts`), implemented by the media
  feature over its existing `media:token-idx`. That index is ADR 0945's SHA-256-keyed
  token→asset index, so no new index was needed.
  - `orgOf` is index-only (`orgOfServeTokenIndexed`). It is deliberately NOT the
    tenant-slice heal in `getAssetByServeTokenForTenant`, which would scan the library
    for every token that isn't a library asset.
  - Rows that predate the index are filled by `backfillServeTokenIndexStep`, driven by
    the asset-grant reconcile on its own cursor.
- **The floor:** a session read of an org-owned library asset also needs
  `workspace:read` in that org. These pass without it:
  - a personal tenant;
  - a non-library or root-owned asset;
  - a workspace admin (`host:members:manage` on a membership-rooted root, the #5930
    exit).

  Public and signed arms are unaffected.
- **A failed org lookup is retried once, then FAILS CLOSED** (the uniform 404,
  `asset_org_floor_lookup_failed`). This was the release coordinator's call: falling back
  to the tenant floor would reopen the cross-client read on every store blip. Published
  pages keep loading through the public arm.
- **Tests:** `adr1122-p1c-org-floor.test.ts`, 5 cases:
  - A-member reads A, not B;
  - an admin reads both;
  - root-owned and non-library tokens stay at the tenant floor;
  - a public grant still admits;
  - a failing lookup returns 404 for a session read while a public grant is served;
  - the backfill fills a pre-index row.

  Sabotage-witnessed: a floor that always passes, or a lookup that falls back to the
  tenant floor, fails a case. 20 media files: 141/141.
- **Cost to measure under `report` (P3):** up to two point reads per admitted session
  read of a library asset, plus one access resolve when the asset is org-owned.

## Implementation record (P2)
- **`host/assetSigning.ts`:** `signedAssetUrl(token, seconds)` produces
  `<serve url>?asig=v1.<kid>.<exp>.<sig>`.
  - `sig` is an HMAC-SHA256 over `asset-read:v1:<kid>:<token>:<exp>`, keyed by
    `readSessionSecret`.
  - `exp` is at most 15 minutes ahead, with 30 seconds of skew grace on verify and a
    timing-safe compare.
  - A signature claiming more than 15 minutes ahead is refused.
- **Rotation (`interruptToken` precedent):** `kid` is derived from the key, so rotating
  the session secret rotates it. During a rotation an operator sets
  `OPENWOP_ASSET_SIGNING_PREVIOUS_SECRET` to the old secret, and in-flight signed URLs
  keep verifying for their remaining lifetime. An unknown `kid` refuses.
- **The serve route:** a valid signature for exactly this token admits as arm `signed`,
  with no store read and no session. A bad signature is ignored, so the other arms still
  decide and a refusal stays the uniform 404. A signed read is
  `private, max-age=min(300, remaining)`.
- **The 15-minute cap excludes email ON PURPOSE.** Email and newsletter pictures are
  opened days later; they ride the public-grant arm (D2.2), never a signature. Do not
  raise the cap to serve them.
- **Adoption:** per call site, as each consumer appears in `report` would-deny logs:
  exports, headless film and slide renderers, model-provider media fetches. None is
  adopted in this phase; the arm and its minting function ship first.
- **Tests:** `adr1122-p2-signed-arm.test.ts`, four cases:
  - a fresh signature serves, private and bounded;
  - a tampered, foreign or expired signature gets the uniform 404 with `no-store`;
  - the cap;
  - a URL signed under the previous key verifies during a rotation and not without it.

  Sabotage-witnessed: removing the arm, or ignoring the previous key, fails a case.

## Open questions
- [ ] Do co-tenant profile views (`TEAM_VIEW_FIELDS` exposes raw tokens) need more than
      the session arm? A teammate is present in the tenant, so they pass.
- [ ] Should e-sign certificates move off `/assets` to a signer-authenticated route,
      instead of holding a public grant until void?
- [ ] Is there a measured per-token cost for the public-grant lookup on a page with many
      images? This needs a P0 benchmark.

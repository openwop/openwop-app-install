# ADR 0641 — A `site` tier for product surfaces at clean URLs, and auth posture as a per-ROUTE property

Status: implemented (phases 1–5; one residue, §Implementation record)

## Context

KickTodo needs its six participant surfaces (Today, Plan, Discover, Progress,
Circles, Leaderboard) at clean root URLs — `kicktodo.com/today` — free of console
chrome, with a CMS-managed menu, CMS components embeddable in the page, and the
existing toggle gate intact. **Discover must additionally serve an ANONYMOUS
visitor**: the acquisition funnel is find-a-challenge → sign up. KickTodo is the
first adopter; the capability is generic.

`FeatureTier` (`frontend/react/src/chrome/featureTypes.ts:15`) is
`'workspace' | 'admin' | 'public'`, and its own docblock rules out reusing
`public`: a bare `<PublicShell>` rendered ABOVE `<AppGate>` with no auth and **no
nav** (ADR 0027) — "a `public` route carries no `nav` (it is not a menu item)".
`App.tsx:232`'s `showPublic` branch skips session + SSE bootstrap by design.
Today/Plan/Progress are authenticated personal surfaces, so `public` cannot carry
them and `publicRoutes` (ADR 0630) cannot either.

**Six findings from the design pass, each of which changed the shape.**

1. **Chrome cannot express this.** `chromeFor()`'s result is consumed in exactly
   one place — computing `mainClass` at `App.tsx:280-292`, a CSS class on
   `<main>`, which is already inside `AppGate` and inside `div.app-shell`. Shell
   selection happens at `:296`, strictly earlier. A `FeatureChrome` variant is
   structurally incapable of selecting a shell. The tier is the seam.

2. **Auth is a property of the ROUTE, not the tier.** The first cut framed `site`
   as "authenticated + bare chrome". Anonymous Discover falsifies that.
   `AppGate.tsx:98-100` is a hard wall — `SignInGate` renders children only
   `if (user)`, else a sign-in panel — and the mode is `brand.appGate.mode`,
   **per-deployment, not per-route**, so it cannot be configured around without
   unwalling the whole console. Enumerating tier members per combination yields
   six tiers. Tier keeps shell + nav; posture comes off the tier.

3. **`showPublic` conflates two independent decisions** — which shell to render,
   and whether to bootstrap session + SSE (`App.tsx:243,:255` both guard on it).
   For every existing public route the two coincide, because anonymous marketing
   pages want neither. `site` breaks the coincidence in both directions.

4. **Auth-awareness is already free.** `auth/useAuth.ts` is a subscription over
   `firebase.ts` `onAuthChanged`, NOT a context consumer, and is documented safe
   to call unconfigured. It works inside the PublicShell branch. Precedent:
   `App.tsx:206`, the storefront — "anonymous OR signed-in visitors shop the same
   page".

5. **The CDN collision surface is DERIVED and grows on its own.**
   `firebase.json` routes root paths to Cloud Run ABOVE Express and React, so a
   `site` route named `/content` or `/agents` never reaches the SPA. This is
   invisible to any Express- or Router-level check. Critically, the list is not
   hand-maintained: `check-hosting-wire-rewrites.cjs:105-127` derives it from
   `schemas/v2/path-manifest.json`. **A corpus sync can shadow a route that was
   clear when it was authored, with no change to this repo.** KickTodo's six
   names are clear today; that is not a property anyone can rely on.

6. **The catalog read is tenant-scoped — established by CODE, not by measurement.**
   `routes.ts:107` is `res.json({ challenges: await listPublished(tenantOf(req)) })`,
   with `tenantOf` from `host/requestSubject.js`: the scoping is structural. An
   anonymous caller resolves to their own `anon:` tenant, so a public Discover
   backed by the console read returns an empty list. Public Discover is a BACKEND
   change, not a frontend one.

   **Provenance, stated because it was nearly laundered.** This was first reported
   to this session as "verified against production" — an anonymous GET returning
   an empty array. The `kicktodo-1` session then retracted that: the catalog is
   currently empty for *every* tenant, so an empty array is equally consistent with
   "tenant-scoped" and with "no challenges exist anywhere". The observation
   distinguishes nothing.

   **UPDATE — the debt is paid; this premise is now MEASURED, not read.** The
   `kicktodo-1` session ran the differential test and reported it: two anonymous
   sessions against the same deploy in the same minute, on the same URL, with no
   auth on either, differing only in whether the tenant had been seeded.

   | anonymous session | catalog |
   |---|---|
   | seeded | **3** — Deep Work 30d/30 activities, Morning Movement 14d/14, Sleep Reset 21d/21, all `published` |
   | fresh | **0** |

   Two tenants differing in exactly one variable, answering differently on the
   same request, is the discriminating evidence the first observation could not
   supply. `listPublished(tenantOf(req))` is tenant-scoped; an anonymous visitor
   sees their own empty tenant. Rows were cleared afterwards. This is safe to cite
   as measurement now, and it settles that public Discover is a BACKEND change —
   the `site` tier alone would ship an empty page to every anonymous visitor.

## Decision

**1. `FeatureTier` gains a fourth member: `'site'`** — product chrome, bare shell,
WITH nav, session-bearing, notification-connected, toggle-gated. Toggle gating
comes free: `featureRoutes()` stamps `ownerFeatureId` (ADR 0419) and
`EntitlementGuard` already enforces it.

**2. Auth posture is a separate per-route field**, `auth: 'required' | 'optional'`,
meaningful only for `site`. `public` remains auth-none by definition.

| posture | routes | renders for |
|---|---|---|
| `required` | `/today` `/plan` `/progress` `/circles` `/leaderboard` † | signed-in only |
| `optional` | `/discover` (in-app; the public funnel is a CMS page — see 7b) | both; richer signed-in |
| none | `public` tier | anonymous; no nav |

† **Leaderboard is `required` pending an escalation, not a settled default.** A
public leaderboard contradicts `kicktodo-circles`' stated principle — "Share
exactly what you choose, with exactly who you choose" — whose scopes are
per-member opt-ins over exactly this data. Neither engineering session will decide
that; it is with David. `required` is the conservative holding position, and the
posture field makes it a one-line change either way. If it goes public, the
adopter-side read is opt-in per participant, never retroactive.

> **ANSWERED 2026-09-11 by David. Leaderboard is NOT public — and the answer is
> narrower than either option this table offered.** Verbatim: *"others, like the
> leaderboard are not only behind a login, but also only visible to those who are
> participating in the challenge."*
>
> So the holding position was right about the posture and incomplete about the
> rule. `auth: 'required'` stands, and a **second, independent** constraint joins
> it: visibility is scoped to the enrolled participants of that challenge. The
> Circles tension this note raised does not need adjudicating — it dissolves.
> Participant-scoped is what Circles' principle already asks for.
>
> **This is NOT a third posture value, and the distinction is load-bearing.** The
> posture field answers *"does this route need a session"* — a routing question,
> settled before any data is read. Participant scoping answers *"which rows may
> this session see"* — an authorization question the owning service answers. Fold
> the second into the first and `auth` becomes a second owner of a fact the
> service already owns, which is the exact failure decision 10 was withdrawn for.
> The posture field stays binary; see decision 13.

**13. Participant scoping is a SERVICE-side predicate, and for KickTodo's
leaderboard it is net-new work on a shipped surface.** MEASURED 2026-09-11:
today's leaderboard is **tenant-scoped and opt-in**, not challenge-scoped.
`kicktodo-engagement/routes.ts:69` calls `leaderboard(tenantOf(req),
subjectOf(req))` — two arguments, no `challengeId` — and
`engagementService.ts:246` states the model: *"leaderboard membership, ranking,
and badges vanish together. Tenant-scoped (the key embeds the tenant…)"*, over an
`optIns` collection. A participant of challenge A and a participant of challenge B
appear on one board.

David's rule requires a third argument and a membership check. The primitive
already exists and is already the right shape —
`kicktodo-core/enrollmentService.ts:405` `listEnrollmentsFor(tenantId,
ownerSubject)`, described at `kicktodo-accountability/agentTools.ts:44` as
*"Self-scoped by construction (only the acting user's own enrollments); fails
EMPTY without an acting user."* Fails-empty-without-a-principal is precisely the
posture a participant-scoped surface needs, and it is consumption rather than
authorship.

What is NOT settled here, and should not be settled by an engineering session: the
**relationship between enrollment and the existing opt-in**. Enrolment is
participation; the opt-in is consent to be *ranked*. Whether a participant-scoped
board still honours the opt-in — i.e. whether enrolling implies consent to appear
before your peers — is a product question with a privacy answer, and this ADR
takes the conservative reading until told otherwise: **enrolment gates who may
LOOK, the opt-in still gates who APPEARS.** That keeps both existing consents
intact and adds no implied one.

**3. `site` + `required` wraps `AppGate`; `site` + `optional` MUST NOT.** The
session-bootstrap guard stops keying on `showPublic` and keys on whether the route
is session-bearing, which splits finding 3's conflation. Console-only chrome
(`Sidebar`, `AutoSeedExampleData`, `VendorSetupPrompt`, `InMemoryHostBanner`) MUST
NOT render on a `site` route — a participant at `/today` must not receive a
vendor-setup prompt.

**4. The public catalog read joins ADR 0012's existing family** —
`/v1/host/openwop-app/public/:orgId/challenges`, org in the URL, tenant resolved
server-side, published-only, toggle-gated, no credential. One more member of a
reviewed family, not a new anonymous surface, and it inherits published-only —
which the funnel needs regardless.

**5. ONE registered content-section resolver serves BOTH embedding and crawling.**
`host/contentDataSources.ts:56` `registerContentSectionResolver` exists for exactly
this: "the crawler prerenderer consumes it — features never import each other, a
resolver lets the prerenderer emit that". It is wired, not aspirational —
`prerenderService.ts:26,260` imports `resolveContentSection` and calls it per
section. A `challengeCatalog` section rendered by the already-exported
`RenderSections` (`SectionRenderer.tsx:1042`, mode-parameterised) IS the embedding
mechanism; the same section with a registered resolver IS the prerender path. The
chain closes with no kernel migration and no new primitive:

```
cms.page carrying a `challengeCatalog` section
  → the owning feature registers a resolver for that type at boot
  → prerenderService resolves it SERVER-SIDE   → crawlable, anonymous
  → SectionRenderer renders it CLIENT-SIDE     → interactive for humans
  → CMS never imports the feature              → no cross-feature edge
```

**What the resolver does NOT do, because the first draft of this ADR got it
wrong.** It enriches what a **CMS page** can contain. It does not make a React
feature route prerenderable — the two prerender doors
(`publishing/routes.ts:168-181`) remain CMS-only. That distinction decides §"two
surfaces" below.

**`entityList` is a shape analogy here, NOT a usable recipe.** Challenges are a
bespoke `DurableCollection` (`challengeService.ts:9,21`), not a kernel entity type,
so `entityList` cannot project them — it queries the kernel by `typeName` — and
`publicRead` does not apply, because that flag lives on an entity TYPE
(`updateEntityType`, ADR 0408 Phase D). Forcing challenges into the kernel would
also inherit that ADR's "published pages' SCALARS only — blocks never leave the
kernel", which would surface titles and drop `activities[]` — the day-by-day
curriculum, i.e. most of what makes a challenge page worth indexing. It would look
like it worked and ship a catalog of stubs.

The section's target org rides its own `data`, NOT `ContentResolveContext`:
`contentDataSources.ts:39-45` documents `pageTenantId` as informational and
best-effort.

**6. `ui-plugin` is NOT the embedding vehicle.** RFC 0117 `ui-plugin/1`
(`uiPluginRpc.ts:2-23`) is a postMessage RPC for third-party code in a closed
iframe, with a host-MUST-NOT-persist rule; its CSP header exists to CONTAIN
untrusted code. Routing first-party CMS content through it would place trusted
content behind an untrusted-code contract and take on RFC 0117 wire obligations
for a purely local composition need. It is also the only option on the table that
would require an RFC at all.

**7. The collision rule is a BUILD GATE, not a comment.** Extend
`frontend/react/scripts/check-hosting-wire-rewrites.cjs` to refuse a `site` route
whose path equals or sits under any Cloud Run rewrite source. That script already
holds both halves of the comparison and already runs in three places — the
`npm run build` chain, the hosting `predeploy` hook, and `preflight-deploy.sh` —
including the hand-deploy path that burned a white-label adopter. It MUST fail
closed on an underivable route list, mirroring its existing manifest floor.

**7b. Discover is TWO surfaces sharing a resolver, not one route.** A public
acquisition page (a `cms.page` carrying the `challengeCatalog` section —
prerendered, anonymous, converting to sign-up) and the in-app `site`-tier
`/discover` a participant uses to browse and enrol. They share the resolver, not
the route.

This reverses an earlier conclusion in this same ADR's drafting, and the reason is
decision 5's correction: one route would require the prerenderer to grow a **third
door** for React feature routes, sited on the acquisition path, where being wrong
means being invisible to search. Two surfaces need no prerender change at all.

A consequence worth stating because it de-risks the tier: **`auth: 'optional'` is
no longer load-bearing for acquisition.** It stays useful for the in-app page, but
if it slipped a phase the funnel still works.

**8. The funnel section is EXEMPT from chrome-only degradation.**
`contentDataSources.ts:64-77` catches every resolver error and returns null, and
the prerenderer then "renders the section's chrome only — the honest degradation".
For marketing that is right. For an acquisition page it publishes an indexed
document with intact chrome and **zero challenges**. The severity is that *every
check we have passes*: the route 200s, the prerender emits a well-formed document,
the section chrome is intact, the hosting-rewrite gate is satisfied, deploy
verification is satisfied. The only signal is a business metric nobody is watching
yet.

Stated as an invariant rather than a preference, so it generalises past this one
section: **a section type MAY declare itself ESSENTIAL, and an essential section
that resolves empty MUST fail the prerender for that page rather than degrade to
chrome.** An absent page is a 404 someone notices; a hollow indexed one is a slow
leak with no detector. Same principle the deploy path already applies by shipping
a provenance field ABSENT rather than stale — this codebase prefers a loud gap to
a quiet lie, and this is that rule applied to content.

**9. Cache posture: cache the shell, never the authenticated data.** The
platform-origin prerender door is already UA-branched with `Vary: User-Agent`
(`publishing/routes.ts:179-181`), which splits bot from human. For
anonymous-human vs member-human the shell is identical and enrollment state is a
client-side fetch, so the cacheable artifact carries no member data. The invariant
to guard is therefore narrow and testable: **no `auth: optional` route may
server-render member state into the cached document.**

**10. `cms.menu` is a new entity.** CMS models only `cms.page`
(`cmsService.ts:213`). ADR 0486's deferred half was per-page nav metadata, and an
additive field on `cms.page` would be cheaper — but it cannot express this menu,
because all six destinations are feature routes, not pages, and the menu must also
carry which entries are visible signed-out (an anonymous visitor's menu is a strict
subset). Two properties a page-metadata field cannot hold.

The entity EXTENDS the nav model rather than forking it. ADR 0486 declares
`usePublicNav()` the one nav source — but that function is module-private
(`PublicShell.tsx:81`) and hard-codes marketing destinations, so it is the one
source *for the PublicShell*, not a general model. The actual single source for
authenticated toggle-gated nav is the `FEATURES` manifest plus `FeatureNav`
(`featureTypes.ts:21-53`). A `site` route carries `nav` and therefore draws from
the same manifest the workspace rail reads, inheriting `featureId` gating and
`hiddenWhenFeature` for free. ADR 0486's rule that the sitemap MUST NOT be
promoted into the primary visible menu is inherited unchanged.

> **CORRECTED 2026-09-09 — decision 10 is WITHDRAWN. There is no `cms.menu`
> entity.** Both properties this decision claimed only a new entity could hold
> turn out to be held elsewhere, and the peer session (`kicktodo-1`) found the
> fact that collapses them: **the public surface has no stable tenant.** An
> anonymous caller is minted `tenantId = "anon:<sid>"` — a fresh throwaway per
> browser session (`middleware/auth.ts:1-10`, the cookie payload docblock). So on
> any `auth: optional` route there is nothing stable to curate BY, override on, or
> bucket on. A per-tenant menu store would key on a value that changes per visit.
>
> With that in hand the two properties resolve without a new store:
>
> - *"the menu must carry which entries are visible signed-out."* Decision 2
>   already carries it. A route's `auth` posture IS its signed-out visibility;
>   storing it a second time on a menu row creates two owners for one fact.
> - *"all six destinations are feature routes, not pages."* True, and that is an
>   argument for the FEATURES manifest, not for a new entity. Menu membership for
>   the authenticated half is DERIVED from toggle resolution, whose per-tenant knob
>   already exists (`host/featureToggles/service.ts:449`, the `tenantOverrides`
>   read in `resolveConfig`). A second per-tenant menu record would be a second
>   owner of "is this destination live for this tenant", and the two would drift.
>
> The public half stays where ADR 0486 put it: curated links compiled into the
> distribution plus host-global published CMS pages (`PublicShell.tsx:81-91`
> `usePublicNav`, and `usePublishedPages` at `:60-73` reading `SYSTEM_SITE_ORG`).
> Adding a public `site` destination is adding a curated entry — a distribution
> concern, not a tenant one. **Net effect: phase 5 loses an entity and becomes
> wiring.** The paragraph below about extending rather than forking the nav model
> still stands; only its conclusion — that the extension needs a new entity — was
> wrong.

**11. The funnel page publishes into the reserved system-site org, under
super-admin authority. No new authorization concept.** `systemSite.ts:29-31`
already reserves `SYSTEM_SITE_TENANT = 'host:site'` / `SYSTEM_SITE_ORG =
'host-site'`, and the `host:` prefix is one no auth path mints (real principals
get `user:` / `anon:` / `ws:`), so the org is unreachable by every real caller.
That file's own header states the intent: a global page edited by the host-level
role, NOT by tenant membership — a real `cmsService` page in a real
`accessControl` org, nothing shadowed, the only new thing being the AUTHORITY.
`PublicShell`'s published-pages probe already reads exactly this org.

A tenant admin must NOT be able to publish into the public funnel, and the reason
is the same collapsing fact: the public nav has no tenant to scope by, so a
tenant-published page would appear on every visitor's menu. Super admin publishes
through the standard CMS routes (`requireCmsScope`).

**12. A `site` route with `auth: 'optional'` MUST be binary — no variants, no
percentage rollout, no tenant override — and this is a REGISTRATION-TIME
VALIDATION, not a convention.** Two consequences of `anon:<sid>`, both verified in
`host/featureToggles/service.ts`:

1. `tenantOverrides[subject.tenantId]` (`:449`) can never match a public visitor,
   because the key is a per-session random. An operator switching a public route
   "on for this tenant" silently does nothing — the worst shape of failure this
   codebase keeps rediscovering: a control that reports success and has no effect.
2. `unitIdFor` (`:431`) buckets the `'tenant'` unit on `subject.tenantId`, and the
   `'user'` unit falls back to `tenantId` when there is no principal
   (`:433-435` — the fallback is documented as per-visitor, which is exactly the
   problem here). Either way a public route buckets on a per-session random: the
   same visitor is reassigned on their next visit, and a prerendered or
   CDN-cached public document has no coherent assignment at all.

The alternative — define a stable public bucket unit — is rejected. There is
nothing honest to hash: IP is not the visitor, and a durable client-side id is a
tracking decision this ADR has no mandate to make. So the constraint is the
answer, and it is enforced at registration so that a feature declaring variants on
a public route **fails when it is declared rather than shipping a coin flip**.
Default off, fail-closed.

## Implementation record

| Phase | Commit | What shipped | Gate |
|---|---|---|---|
| 1a — types + guards | `ed80d6c6d` | `site` tier, `auth` posture, `siteRouteContract`, exhaustive `tierShell` | tsc; 13/13; 4 sabotages |
| 1b — the branch | `7dc8d096e` | `SiteShell`, the third App.tsx branch, `showPublic` split, the `site` nav rail | `npm run build`; 11/11; 4 sabotages |
| 2 — collision gate | `eff91f3e4` | `check-hosting-wire-rewrites.cjs` refuses a colliding `site` route | build; 2 sabotages (incl. broken-scanner) |
| 3 — public read | `ad867ccea` | `GET /public/:orgId/challenges` on the ADR 0012 family | tsc; 10/10; 5 sabotages |
| 4 — the section | `633b04e98` | `challengeCatalog` + the ESSENTIAL-section invariant | tsc; 9/9; 4 sabotages |
| 5 — the menu | `796ebdd27` | contract enforced at manifest composition | build; 15/15 |

**Corrections this ADR earned by being implemented.**

1. It cited `check-hosting-wire-rewrites.**mjs**` four times. The file is
   `.cjs`. A citation is a claim; this one would have sent phase 2 looking for a
   file that does not exist.
2. Decision 4 says the public read is "toggle-gated", and the family it joins
   deliberately is NOT — `publishingService.ts:138-141` records why ("Publishing
   is always-on... the CMS editorial `published` status is the sole public
   gate"). Both are right, for different reasons, and the resolution is worth
   stating: **"toggle-gated" means something different on the two sides of this
   feature.** On the public READ the subject is the tenant `getOrg(orgId)`
   resolved server-side — stable across visits, identical for every visitor,
   coherent for a CDN cache. On the public ROUTE it would be the caller's
   `anon:<sid>`. Decision 12 bans the second; decision 4 requires the first.
   Conflating them would licence mirroring the gate onto the route, where it is
   a coin flip.
3. Two latent bugs existed the moment `FeatureTier` gained a member, neither
   catchable by `tsc`: `MenuSettingsPage` held a binary ternary over the tier in
   two places, and its tier `<select>` was guarded only by the narrowness of its
   option list while the handler cast `e.target.value as FeatureTier`.
4. The public projection (decision 5's "keep the curriculum") omitted each
   activity's `evidencePolicy` and the challenge's `depthLevel` as "enrolment
   mechanics, not catalog copy". Measured on kicktodo.com at `302a534`
   (2026-09-16), once ADR 0684 phase 4 rendered the signed-out preview from that
   list: a stranger read "just check in" for a challenge whose signed-in page
   said "note", under a sentence promising the preview was exactly what they
   would commit to. What a participant will be asked to show IS the commitment
   (ADR 0436 §5.4), sits inside the immutable published body, and is not
   personal — so both fields are now carried. `stableActivityId` and
   `alternatives` remain off the wire; those are mechanics. The page treats an
   activity with no policy (a list from an older backend) as "shown after
   sign-in", never as the weakest policy.

**RESIDUE — decision 12 is half-enforced, and this is the one thing an
implementer must not read as done.**

The path rule runs at manifest composition. The TOGGLE rules — no variants, no
partial rollout, no tenant overrides on an `auth: 'optional'` route — need the
toggle config, which lives in the backend registry and is not part of the
frontend manifest. `assertSiteRouteContract` checks them when a caller supplies
`toggle`; no frontend caller can. Today that half is enforced by the contract's
own tests and by this document, **not by a gate**.

The seam for closing it is the route's `ownerFeatureId` → the toggle it names,
checked where the toggle data lives. That is the same "put the check where the
data is" move phases 2 and 3 both made, and it is the only piece of decision 12
that can currently ship a control that reports success and has no effect — which
is the exact failure decision 12 exists to prevent.

## Alternatives weighed

- **`FeatureChrome` variant + an auth flag.** Rejected on finding 1: chrome is a
  CSS class on `<main>` inside the shell that has already been chosen. Not a
  matter of taste — structurally incapable.
- **Reuse `public` / `publicRoutes` (ADR 0630).** Rejected: no nav by contract, and
  the branch skips session bootstrap, so `/today` cannot live there.
- **Enumerate a tier member per posture combination.** Rejected: six members for a
  2×3, and every existing tier consumer is a filter, so the combinations do not
  even collapse cleanly.
- **ONE route for Discover, wearing both postures.** Briefly adopted mid-drafting,
  on the belief that `registerContentSectionResolver` made a feature route
  prerenderable. It does not — it enriches CMS pages, and the two prerender doors
  stay CMS-only. One route would need a third door, built on the acquisition path.
  **Rejected**; see decision 7b.
- **Kernelise challenges and project them with `entityList`.** Rejected on two
  counts: challenges are a bespoke `DurableCollection`, and ADR 0408's
  scalars-only rule would drop `activities[]`, shipping a catalog of stubs that
  looks correct.
- **`ui-plugin` for embedding.** Rejected on decision 6.
- **Do nothing.** The surfaces stay behind console chrome at `/app/...`-shaped
  URLs and Discover cannot acquire anyone. Rejected — that is the product ask.

## Consequences

- Adding a member is additive for every existing `FeatureTier` consumer: they are
  all FILTERS (`App.tsx:364,:395`; `features.tsx:439`;
  `MenuSettingsPage.tsx:78`), not exhaustive switches. Nothing breaks by omission.
- **But `MenuSettingsPage.tsx:201` is a non-exhaustive mapper typed on the full
  union** — `tier === 'workspace' ? mainMenu : adminMenu`. Adding `'site'`
  compiles and silently labels site routes "Admin menu". It MUST become
  exhaustive (`satisfies Record<FeatureTier, …>` or a `never` check) so the FIFTH
  member is a compile error rather than a wrong label.
- **Tier is currently operator-assignable through stored menu overrides**
  (`MenuSettingsPage.tsx:92,:125` — `effTier` reads the override, and the write
  path applies it). Read paths are safe (`:78` skips unknown tiers); the write path
  is not. `site` MUST NOT be operator-assignable: tier is product posture, not a
  menu preference.
- App.tsx gains a third render branch resolved pre-render, like `featurePublic`
  at `:231`. This is a structural edit, not a filter addition.
- A white-label adopter with a custom `firebase.json` gets the collision gate for
  free, which is the point: the failure it prevents is silent.

## Test plan

Tier routing, shell selection, auth posture and namespace collisions are
observable ONLY through the routing boundary — a component-level plan is
insufficient. Required:

1. Route-level tests for each posture: `site`/`required` anonymous → sign-in wall;
   `site`/`optional` anonymous → renders; `site`/`optional` signed-in → renders
   with member state; `site` never renders console chrome.
2. A test that a `site` route colliding with a Cloud Run rewrite source fails the
   build gate. **Sabotage it first** — add a deliberately colliding route, confirm
   red, remove. An unbroken new guard is indistinguishable from one that cannot
   fire (see `docs/steward/` — this repo has shipped five such gates).
3. A test that the funnel section REFUSES rather than degrading to empty chrome.
4. A test that no `auth: optional` route server-renders member state.
5. Backend: anonymous GET on the public catalog returns published rows for the
   named org, and drafts never resolve.
6. A test that registering a `site` route with `auth: 'optional'` and either
   variants or a percentage rollout FAILS at registration (decision 12).
   **Sabotage it first**: this guard's whole purpose is to catch a declaration
   that would otherwise be green and meaningless, so a green guard here is
   indistinguishable from an absent one.

## RFC gate (wire vs host-extension)

**No RFC needed.** Nothing here touches the OpenWOP wire. `FeatureTier`,
`FeatureChrome` and the CMS entities are host-internal; per `CONTRIBUTING.md`'s
scope rule, UI conventions and internal data structures are explicitly out of RFC
scope. The one public read joins `/v1/host/openwop-app/public/:orgId/*`, which is
a host-extension namespace and non-normative by construction (ADR 0012).

The single choice that WOULD have required an RFC is adopting `ui-plugin/1` as the
embedding vehicle, which decision 6 rejects on independent grounds.

## Correction notes filed against prior ADRs

- **ADR 0614** (the wire MUST be reachable at the origin root) and **ADR 0631**
  (the major-2 path space is rooted at the discovery host) both established the
  root path space as a ONE-WAY claim. Neither considered the reverse direction:
  the SPA must remain reachable at roots the wire has not claimed. Decision 7 is
  that missing half. Correction notes are filed at both, per the "correct, don't
  rewrite history" rule.
- **ADR 0486** §Decision is unchanged. Its deferred nav-taxonomy half is answered
  here by `cms.menu` rather than by the per-page metadata it anticipated, with the
  reason stated in decision 10.

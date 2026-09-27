# ADR 0653 — Entity pattern routes and `entityDetail` slug-binding

Status: **Accepted — PARTIALLY implemented** (verified 2026-09-17, #3753)
Date: 2026-09-11
Supersedes: none
Correction notes filed against: ADR 0407 (the deferral's cause is now addressable)

## Context

ADR 0407 shipped the entity→content bridge: `entityList`/`entityDetail` sections
that carry a *validated query reference* (tenant + type + bounded presentation
config, never copied data), resolved at view time through the ONE anonymous
entity-read gate (`features/entities/publicRead.ts`, D3) — `published +
publicRead + live rows only`, scalar-projected. The same gate serves the public
route and the crawler prerenderer, which is what makes no-cloaking true by
construction rather than by discipline.

One piece was left out, **deliberately and with a stated cause**:

> **`entityDetail` slug-binding (`bindSlugField`) is DEFERRED with cause:** the
> public page surface has no pattern routes to bind against — a page is one slug,
> so a bound detail section would be dead config today. It returns when pattern
> routes exist (candidate: the ADR 0408 Phase C/D page work), not before.

That cause has been quoted since as "entities have no public page routes" — the
comment on `ResolvedContentItem.href` in `host/contentDataSources.ts`. The comment
is accurate but incomplete, and reading it without the ADR has twice led to this
being described as merely unfinished. It is not: it is **blocked on a named
precondition**, and this ADR exists because the precondition is now reachable.

### The precondition is still unmet, and the reason is sharper than 0407 could state

Pattern routes appear to exist. `middleware/customDomain.ts` maps five shapes:

```
/                    → home page prerender
/pricing             → the `pricing` page prerender
/blog                → the blog-INDEX prerender
/blog/:slug          → the page prerender (blog posts ARE CMS pages)
/p/:slug             → the page prerender
/pod/:show[/:episode]→ the podcast show/episode prerender
```

Every one is a **hardcoded regex in a single function**, and the load-bearing
detail is the parenthetical on `/blog/:slug`: *blog posts ARE CMS pages*. The slug
resolves because there is a real page carrying it. Podcasts get their own bespoke
prerender endpoints. **An entity is not a page and has no bespoke endpoint**, so
after five pattern routes there is still nothing for a bound entity slug to
resolve to. What is missing is not a sixth regex — it is the absence of any
*generic* binding from an entity type to a route prefix.

### The consumer side is dead too, which doubles the work

`ResolvedContentItem.href` is declared and **never read**. `prerenderService.ts`
builds `{'@type':'ListItem', position, name: it.title}` for each resolved item —
no `url`. The only reader of a `.href` anywhere in publishing is `sectionHtml.ts`
for a `columns` card's own authored href, which is unrelated. So even if entities
became addressable tomorrow, nothing would emit the link: no anchor in the
prerendered section HTML, no `url` in the JSON-LD `ItemList`. **Neither half is
useful without the other**, and any plan that ships only addressability produces
pages no crawler is told about — the exact SEO gap ADR 0407 D3 existed to close.

## Decision

**1. A registered site-route prefix table replaces the regex chain.** A feature
binds `(<prefix>, detail RESOLVER)` — **amended 2026-09-11, see "Correction — Phase D
is unbuildable as written" below; this originally read `(<prefix>, entity type)`**; `documentRewrite` consults the table instead of a
growing `if`/`exec` ladder. The five existing shapes become table entries, so
current behaviour is expressed, not changed.

**2. A binding grants ADDRESSABILITY ONLY. `readPublicEntity` remains the sole
visibility authority.** A bound prefix must never imply that rows under it are
readable. Binding answers "what URL shape reaches this type"; `publicRead` answers
"may an anonymous caller see this row". Collapsing them would make the route table
a second owner of the `publicRead` decision — the failure ADR 0641 decision 10 was
withdrawn for, and the same shape that surfaced in `kicktodo-engagement` where
`optedIn` was inferred from a thrown error instead of read from the consent row.
Two questions, two owners, no fallback between them.

**3. For ENTITY-backed bindings, the slug is the entity's existing `name` machine
key.** (Narrowed 2026-09-11: a non-entity resolver declares its own slug field. See
the correction below — `kicktodo.challenge` has no `name`, which is part of why D
as written cannot be built.) `entitiesService`
already documents `name` as *"machine key (slug, unique per tenant+project),
immutable after create"*. It is unique, stable, and already the thing an operator
types. Minting a second slug field would create a second owner of identity and a
migration; reusing `name` costs a documented coupling instead. The coupling is
stated here so a future change to `name`'s mutability knows it breaks URLs.

**4. One resolver serves page, list and crawler.** The detail page reads through
the same `readPublicEntity` the `entityDetail` resolver and the public route call.
No-cloaking stays structural: a crawler cannot see a draft or non-public row
because there is no second code path for it to see one through.

**5. `href` becomes live, in the same change that makes it resolvable.**
`entityList`/`entityDetail` resolvers populate it from the binding; the JSON-LD
`ListItem` gains `url`; `sectionHtml` wraps item titles in anchors subject to the
existing `isInternal`/`isSafeHref` checks. A resolver MUST omit `href` when the
**prefix** has no binding (amended 2026-09-11 — this read "the type") — an unbound type degrades to today's unlinked item rather
than emitting a URL that 404s.

**6. Prefix uniqueness is enforced at bind time, fail-closed, and reserved site
prefixes cannot be claimed.** Two types claiming `/team` is a boot error, not a
race. The five existing shapes (`blog`, `p`, `pod`, `pricing`, and `/`) are
reserved. This is a boot guard in the same spirit as the RFC 0181 reserved-segment
guard, not a runtime check.

**7. A 404 stays uniform across every failure.** Unbound prefix, unknown type,
draft type, `publicRead` absent, `neverPublic`, cross-tenant probe, and unknown
slug all return the same 404 the public entity route already returns. A
distinguishable error would leak which prefixes are bound and which types exist.

**8. The rewrite target is expressed against the vendor namespace, not a literal
`/v1`.** ADR 0652 / RFC 0181 makes `/host/openwop-app/…` this host's declared
proprietary namespace, rewriting onto a `/v1/host/openwop-app/…` twin that
"retires atomically with `/v1`". The prefix table MUST build its target through
whatever helper 0652 establishes rather than hardcoding `/v1/host/openwop-app/…`
as `customDomain.ts` does today — otherwise this change quietly pins the host to
`/v1` past its retirement. **Sequencing note:** this ADR should land after 0652 or
adopt its helper in the same PR.

## Alternatives weighed

1. **Add a sixth hardcoded regex for one entity type** — rejected. It solves the
   proving consumer and leaves the general problem, and the ladder is already the
   thing making this hard to reason about. The deferral was specifically about the
   absence of a *general* mechanism.
2. **Give entities their own `slug` field** — rejected per decision 3: a second
   owner of identity plus a migration, buying nothing `name` does not already
   provide.
3. **Make entities into CMS pages so `/p/:slug` just works** — rejected, and this
   is the third time (ADR 0009 §Alt-2, ADR 0386 Alt-2, ADR 0407). It would make
   every public entity a page version row and re-merge the kernels 0386 separated.
4. **Emit `href` now and defer addressability** — rejected. It is the one ordering
   that produces a live wrong answer: links to URLs that 404.
5. **Ship addressability and defer `href`** — rejected per the Context: crawlable
   pages nothing links to. This is the status quo with extra routes.

## Phases

- **Phase A (this ADR).** The decision record + the correction note on 0407.
- **Phase B — the prefix table.** Replace the regex chain; five existing shapes as
  entries; boot guard for uniqueness and reserved prefixes; golden-pin every
  existing path BEFORE the refactor. **This is the highest-risk phase in the plan**
  — `customDomain.ts` serves live custom-domain traffic and B is a refactor of
  working code, not new code beside it.
- **Phase C — bind and emit.** `bindSlugField` on `entityDetail`; resolvers
  populate `href`; `ListItem.url`; `sectionHtml` anchors; the detail route through
  the shared gate.
- **Phase D — the proving consumer. SUPERSEDED AS WRITTEN — see the correction
  below.** Originally: a KickTodo `kicktodo.challenge` system *entity type* with
  operator-opted `publicRead`. That is unbuildable; challenges are not entities and
  must not become them. The phase's PURPOSE is unchanged and still binding — ADR
  0407 shipped `demo-entities` as its proving consumer for the same reason, *a
  binding with no consumer is unfalsifiable* — but the consumer is now a registered
  challenge detail resolver reading through `publicChallengeCatalog`, not an entity
  type. The open question D now carries is **what the challenge slug is.** The
  anonymous projection `PublicChallenge` carries `challengeId` (a `randomUUID`),
  `version`, `title`, `summary`, `outcome`, `durationDays`, `servedLocale` and
  `activities` — and no slug. A UUID in `/discover/<uuid>` is not the crawlable
  page D exists to produce, and `title` is prose an author may edit, so deriving
  from it yields unstable URLs. Minting a stable slug is real design work, not a
  detail, and it must be unique per (tenant, challenge) rather than per version:
  a public URL should denote the challenge, resolving to its latest published
  version, not pin a version that a later edit strands.

## Test plan

- **Behaviour-preservation pins, written before Phase B touches anything:** each of
  the five existing shapes rewrites to exactly the endpoint it does today,
  including the `seg()` rejection cases.
- **Addressability ≠ readability (decision 2):** a bound prefix over a type with
  `publicRead` absent → 404. Over a `neverPublic` type → 404. Setting a binding
  does not change any read result.
- **Uniform 404 (decision 7):** unbound prefix, unknown slug, draft type,
  cross-tenant probe — byte-identical responses.
- **Boot guard (decision 6):** duplicate prefix fails boot; a reserved prefix
  (`blog`, `p`, `pod`, `pricing`) fails boot.
- **No-cloaking (decision 4):** the detail page and the crawler path return the
  same row set for the same input; a draft row is invisible to both.
- **Degradation (decision 5):** an unbound type's resolved items carry no `href`,
  and the prerendered `ListItem` carries no `url` — not an empty string.
- **Namespace (decision 8):** the rewrite target is derived, not literal — a test
  that fails if `/v1/host/openwop-app` appears as a hardcoded prefix in the table.

## RFC gate

**None.** `sectionType` is an unenumerated string in
`schemas/localized-content-section.schema.json` (*"the host/section-type defines
the body field shape; the protocol does not"*), so a bound detail section adds no
normative field. The routes live in this host's vendor namespace, which ADR 0652 /
RFC 0181 establishes as explicitly proprietary and non-protocol. Nothing here
touches a run event, capability advert, endpoint contract under `/v1` proper, or a
normative MUST.

## Correction notes filed against prior ADRs

- **ADR 0407** — the `entityDetail` slug-binding deferral named ADR 0408 Phase C/D
  as the candidate unblocker. That was reasonable but has not turned out to be the
  unblocker: 0408 re-platformed pages onto the content kernel without introducing
  generic pattern routes, and the pattern routes that exist remain hardcoded and
  page-shaped. The precondition is a *route-prefix binding mechanism*, which no
  prior ADR owns. 0407's deferral was correct and stays correct; only its guess at
  which work would lift it is amended.

## Correction — Phase D is unbuildable as written (2026-09-11)

Filed by the author. Found by auditing the existing surface before starting D,
which is the step that should have preceded writing it.

**Challenges are not entities, and making them entities is forbidden by an
invariant the code states about itself.** `backend/typescript/src/features/kicktodo-core/challengeService.ts:3`:

> `kicktodo-core` is the ONE owner of executable challenge structure.

```ts
const challenges = new DurableCollection<ChallengeDefinition>(
  'kicktodo-challenges',
  (c) => `${c.tenantId}::${c.id}::v${c.version}`,
);
```

Three independent mismatches, any one fatal:

1. **Duplication.** A `kicktodo.challenge` entity type is a second representation
   of a challenge beside the collection `publicCatalogService` already reads. Two
   owners of one concept, which drift — the failure the architecture contract
   leads with, and a violation of the single-owner line quoted above.
2. **No slug exists to bind.** Decision 3 rested on the entity `name` machine key.
   `ChallengeDefinition` carries `id`, `version`, `title`, `summary` — no `name`,
   no slug of any kind.
3. **Challenges are versioned; entities are not.** The key carries `v${version}`
   and published versions never mutate. The entity model cannot express which
   version a URL denotes.

**Worse than an oversight: an ACCEPTED decision already said this, and I did not
cite it.** ADR 0641 decision 5 had independently rejected routing challenges
through `entityList`, and `publicCatalogService.ts` records the reasoning at the
point of use:

> ADR 0641 decision 5 rejected routing challenges through `entityList` precisely
> because ADR 0408 Phase D projects published pages' SCALARS only — which would
> surface titles and drop the day-by-day curriculum, i.e. most of what makes a
> challenge page worth indexing.

So the entity path was not merely a poor fit for challenges; it was **already
considered and refused, for a reason that applies with full force to a detail
page** — a `/discover/<slug>` page that dropped `activities` would be the thinnest
possible version of the page D exists to produce. ADR 0653 proposed it anyway
because I did not check 0641's decision list before writing Phase D. The
`publicChallengeCatalog` projection that decision produced — which deliberately
carries `activities` against the shape a kernel projection would give — is the
correct substrate, and it already exists.

**What this changes.** Decision 1's binding target generalises from an entity type
to a registered detail resolver; an entity-backed resolver becomes the common case
rather than the only one. Decision 2 is **generalised, not weakened** — its
principle was always *the binding grants addressability only; something else owns
visibility*. For an entity resolver that authority is `readPublicEntity`; for the
challenge resolver it is `publicChallengeCatalog` (published-only, toggle-gated on
the server-resolved tenant, scalar-projected — the gate ADR 0641 phase 3 shipped).
What stays forbidden is exactly what decision 2 forbade: **the route table must
never become a second owner of the anonymous-visibility decision.** Two questions,
two owners, no fallback between them.

Decisions 4, 6 and 7 are unaffected. Decision 5 gains one word (prefix, not type).

**Why the timing mattered.** Phase B builds the table. Keying it by entity type
and generalising later is not a config change — it is re-opening the registry's
shape after five production route entries hang off it, on the file that serves
live custom-domain traffic. Raised to the session holding B before B settled.

## Open questions

1. **Does Phase B belong with the site-tier work?** `feat/adr-0641-p1-site-tier`
   is open and ADR 0641 introduces public feature routes. If the site tier needs
   its own route table, these are one mechanism, not two, and B should land there.
   Flagged for whoever owns 0641 Phase 1 — this is the main reason B is not
   claimed here.
2. **Per-project prefixes.** `name` is unique per tenant+project; a prefix table
   keyed only by type would collide across projects. Deferred until a real
   multi-project public site exists, and noted so the schema does not foreclose it.

## Status correction (2026-09-17)

This record read `Status: Proposed` while its decision was already merged in **#3753**. It was on the steward staleness baseline (`backend/typescript/test/steward/adr-status-not-stale.test.ts`) as *flagged but unverified*; the status above was established by reading the code, not the commit message.

**Evidence.** Landed: decision 8 (vendor prefix derived through `vendorTwin`, `middleware/customDomain.ts:20,39-40,63`) and the EMITTER half of decision 5 (`features/publishing/prerenderService.ts:308-333`).

**NOT implemented, despite commit `2434844e0` being titled "phases B+C".** There is no site-route prefix table — `middleware/customDomain.ts:68-82` is still the hardcoded regex ladder; no bind-time uniqueness/reserved-prefix boot guard (decision 6); `bindSlugField` (decisions 3/4) exists only in ADR prose, in this file and 0407; nothing POPULATES `href`, so the new `ListItem.url` branch is dead at runtime; no `sectionHtml` anchors; Phase D not started. **Everything this ADR is named for — pattern routes and slug binding — remains unbuilt.**

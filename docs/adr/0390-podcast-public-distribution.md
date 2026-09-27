# ADR 0390 — Public podcast distribution (public episode pages + an iTunes RSS feed)

Status: **implemented** (Phases 1–4 — see §Implementation record)

Date: 2026-07-17

Lane: feature extension of `podcasts` (ADR 0086) — adds a public distribution surface. Host-extension routes only; **no wire RFC** (verified below).

Toggle: extends the existing **`podcasts`** toggle (stable id, OFF, `bucketUnit: tenant`) — no new toggle. The public surface is gated by the same toggle resolved for the resource's tenant PLUS an editorial `published` flag (the ADR 0012/0027 precedent).

Surface: adds public (unauthed) routes under the **already-allowlisted** `/v1/host/openwop-app/public/:orgId/podcasts/*` namespace + a Range-capable public audio route; adds authed publish/unpublish mutations under `/v1/host/openwop-app/podcasts/*`.

Depends on / composes:
- **ADR 0086 (Multi-speaker podcasts)** — this ADR **closes 0086's deferred open questions OQ-1 (public share link / "a podcast feed?") and OQ-5 (public sharing rides ADR 0013)**. The generation studio, `PodcastEpisode` tracking record, `audioMediaRef` (the mixed Media asset), and the `ctx.podcasts` surface are the substrate.
- **ADR 0012 (Publishing & SEO) / ADR 0027 (always-on public surface)** — the public-by-`published`-status model, the `/v1/host/openwop-app/public/:orgId/*` namespace (already in `PUBLIC_PATH_PREFIXES`), the hand-rolled + XML-escaped RSS generator precedent (`publishingService.feedRss`), org→tenant resolution via `getOrg`.
- **ADR 0007 (Media Library)** — the episode audio bytes live as a Media asset (`audioMediaRef`); the public audio route resolves those bytes.
- **ADR 0013 (Sharing)** — weighed and **rejected** as the distribution mechanism (a subscribable feed is not an unguessable capability token; see Alternatives 3).
- **ADR 0384 (SEO crawler prerender + JSON-LD)** — the human-facing public **episode page** is an SPA route; its crawler/social `<head>` (OG/Twitter/JSON-LD `PodcastEpisode`) rides 0384's bot-detecting prerender path. The RSS feed and the audio enclosure are server-rendered (XML/bytes) and do **not** depend on 0384. (ADR 0384 is being authored in this same pass; this is a soft dependency for SEO polish, not a blocker for the feed itself.)
- ADR 0006 (RBAC) · ADR 0001 (feature-package architecture).

RFC verdict: **host work only.** Everything lands under non-normative host-extension routes (`/v1/host/openwop-app/*`). No new run-event field, capability flag, event type, endpoint contract, or normative `MUST` touches the OpenWOP wire. No RFC required. (See §RFC verdict.)

---

## Context — the deferral this closes

ADR 0086 shipped a NotebookLM-style podcast **studio**: a workspace generates a multi-speaker episode (outline → transcript → per-turn TTS → mixed MP3 stored as a Media asset). But it stops at generation. Its evaluation matrix "Public surface" row reads *"Episodes COULD be publicly shareable → rides Sharing (ADR 0013)… Deferred (the seam exists; OQ-1)"*, and OQ-5 asks *"Should a finished episode get a public share link (a podcast feed?)? Deferred; the Sharing seam exists."*

`docs/steward/MYNDHYVE-GAP-ANALYSIS.md` P1.5 names this the concrete gap: *"openwop generates episodes but can't publish a subscribable podcast… Build public episode pages + iTunes-namespaced RSS over the Sharing resolver."* The MyndHyve reference intent is a **public podcast index + episode pages + `/podcast/feed.xml` with the iTunes namespace so the feed is submittable to Apple Podcasts / Spotify.** This ADR closes 0086 OQ-1 + OQ-5.

The audit below overturns one part of the gap-analysis framing (it should ride Publishing's `published`-status model, **not** Sharing's capability tokens — a subscribable feed cannot be an unguessable single-resource link) and confirms the rest composes cleanly.

---

## Boundaries audit (file:line — MANDATORY per the scope rule)

**Namespace check** — `grep -rniE "podcastShow|showId|feed\.xml|itunes|enclosure|podcast.*public" backend/typescript/src`: no route / feature-id / entity collisions. `PodcastShow`, `showId`, and the `/public/:orgId/podcasts/*` sub-namespace are all clean.

| Concern | Single owner already in repo | How this ADR uses it |
|---|---|---|
| **Episode + its audio** | `podcastsService.ts` — `PodcastEpisode { id, tenantId, orgId, notebookId, episodeProfileId, audioMediaRef, … }` (`backend/typescript/src/features/podcasts/podcastsService.ts:1`); no `published` flag, no `showId`, **no "show" channel entity exists** | Add a `PodcastShow` channel entity + `showId` + `published` to the episode (additive KV-blob change, no SQL migration — the 0383 pattern). |
| **Audio bytes** | Media asset behind `audioMediaRef`; resolved by `resolveMediaAsset(token)` / `storeMediaAsset` (`features/podcasts/surface.ts:22`, `routes/mediaAssets.ts`) | The public audio route resolves the episode's `audioMediaRef` bytes and serves them with Range support. |
| **Existing audio serve route** | `GET /v1/host/openwop-app/assets/:token` (`routes/mediaAssets.ts:110`) — token-authed (public via `PUBLIC_PATH_PREFIXES`), sets `Content-Type` + **`Cache-Control: private, max-age=300`**, and `res.send(Buffer…)` — **NO byte-range**: no `Accept-Ranges`, no `Content-Range`, no 206 handling | **Left unchanged.** Podcast clients (Apple Podcasts, Overcast, Spotify) issue HTTP Range requests and want a `public`-cacheable, stable URL — the token route is `private`-cached and token-keyed. A **dedicated Range-capable public audio route** is introduced (below); Range support MAY later be hoisted into a shared helper the media route also uses. |
| **Public route pattern + allowlist** | `PUBLIC_PATH_PREFIXES` in `middleware/auth.ts:86` — **`'/v1/host/openwop-app/public'` is already present** (added by ADR 0012, `auth.ts:~150`); the `/public/:orgId/*` handlers resolve tenant from the org in the URL via `getOrg` (never the request) | Podcast public routes register under `/v1/host/openwop-app/public/:orgId/podcasts/*` — **covered by the existing prefix; NO new `PUBLIC_PATH_PREFIXES` entry, no core auth edit** (a genuine "seam ready" win the gap-analysis promised). |
| **RSS feed precedent** | `publishingService.feedRss(orgId, baseUrl)` (`features/publishing/publishingService.ts:230`) — hand-rolled RSS 2.0, `escapeXml` per field, `atom:link rel="self"`, a URL cap on emitted items (`publishingService.ts:33`) | A **second, podcast-specific** feed generator in `podcasts/` (justified below — different channel shape: `xmlns:itunes`, `<enclosure>`, per-show not per-org-pages). Reuses the `escapeXml` + URL-cap **patterns**, not the page-feed function. |
| **Org→tenant for a public visitor** | `getOrg(orgId)` → `tenantId` (accessControlService), the `getPublishedBySlug` published-only precedent | Each public podcast route resolves org→tenant, gates on the org-tenant's `podcasts` toggle + the resource `published` flag, and 404s uniformly. |
| **Publish/unpublish authz** | Existing `requireOrgScope(req, orgId, 'workspace:write')` helper (`features/podcasts/routes.ts:61`) | Publish/unpublish are `workspace:write` mutations on the show/episode; uniform 404 on wrong-org, per the existing IDOR guard. |

**Net:** the distribution surface is ~90% assembly — a thin `PodcastShow` channel entity + two boolean `published` flags + one iTunes RSS generator + one Range-capable audio route + a handful of public read routes, all under an already-allowlisted public namespace. The only genuinely new mechanics are the iTunes RSS shape and HTTP Range serving.

---

## Decision

Extend the `podcasts` feature with a **show-level public distribution surface**: a workspace groups generated episodes into a **PodcastShow** (a subscribable channel with iTunes metadata), marks the show and individual episodes **published**, and the app serves a public show index, per-show public episode pages, and a per-show **iTunes-namespaced RSS `feed.xml`** with audio `<enclosure>`s — submittable to Apple Podcasts / Spotify — plus a Range-capable public audio route the podcast clients stream from. The public gate is the **editorial `published` flag** (ADR 0012/0027 precedent), never an unguessable token.

### The show model — a channel entity is introduced here

No "show" (podcast channel) entity exists today (episodes bind to a `notebookId` + `episodeProfileId`; `EpisodeProfile` is reusable *format config*, not a channel). A subscribable feed **is** a channel — one feed = one show, with its own title, author, artwork, and category — so this ADR introduces a thin `PodcastShow`, org-scoped, KV-blob (no SQL migration):

```
PodcastShow                          // a subscribable channel (introduced here)
  { id, tenantId, orgId, slug,       // slug: URL + feed identity, unique per org
    title, author, description,      // iTunes <channel> required text
    languageCode,                    // BCP-47 → <language>
    imageMediaRef,                   // channel artwork (Media asset) → <itunes:image>
    category, subcategory?,          // Apple category taxonomy → <itunes:category>
    explicit,                        // boolean → <itunes:explicit> yes|no
    ownerName, ownerEmail,           // <itunes:owner> (Apple requires an owner email)
    type,                            // "episodic" | "serial" → <itunes:type>
    published,                       // editorial public gate (the whole channel)
    createdBy, createdAt, updatedAt }

PodcastEpisode  (ADR 0086 — EXTENDED, additive)
  + showId,                          // → the PodcastShow this episode belongs to
  + published,                       // per-episode public gate
  + publishedAt?,                    // → item <pubDate> (RFC-822)
  + descriptionOverride?,            // optional episode summary (else derive from title/outline)
  + explicitOverride?                // optional per-episode explicit flag
```

- An episode is publicly visible **iff** its show is `published` AND the episode is `published` AND the org-tenant's `podcasts` toggle is on. Any miss → uniform 404 (no existence leak).
- `audioMediaRef` (already produced by the ADR 0086 mix node) is the enclosure source; `sizeBytes` + `contentType` come from the Media asset (`<enclosure length type>`), duration from the episode's clip metadata (best-effort → `<itunes:duration>`).
- `slug` is the stable public identity; renaming a title never breaks a subscribed feed URL.

**Publish granularity: show-level channel + per-episode gate.** A show is a channel; an episode is an item. Both carry `published` so a workspace can stage a show privately, publish it, and still hold back a specific draft episode. This is the ADR 0027 grain ("unpublish at the per-page grain") applied to channel + item.

### Public surface — under the existing `/public/:orgId/*` namespace

All unauthed, tenant resolved from `:orgId` via `getOrg` (never the request), gated on the org-tenant's `podcasts` toggle + `published`, uniform 404 otherwise:

- `GET /v1/host/openwop-app/public/:orgId/podcasts` — the org's **published show index** (JSON for the SPA: each show's slug/title/artwork/episode count).
- `GET /v1/host/openwop-app/public/:orgId/podcasts/:showSlug` — one published show + its published episodes (JSON the SPA renders as the show page).
- `GET /v1/host/openwop-app/public/:orgId/podcasts/:showSlug/:episodeSlug` — one published episode (JSON the SPA renders as the episode page — title, description, audio URL, transcript link).
- `GET /v1/host/openwop-app/public/:orgId/podcasts/:showSlug/feed.xml` — the **iTunes RSS 2.0 feed** for the show (`Content-Type: application/rss+xml`; the submittable URL).
- `GET /v1/host/openwop-app/public/:orgId/podcasts/episodes/:episodeId/audio` — the **audio enclosure**: Range-capable, public-cacheable, no auth, tenant derived from the episode resource.

No new `PUBLIC_PATH_PREFIXES` entry (the `/v1/host/openwop-app/public` prefix already covers all of the above).

### iTunes RSS — a second, podcast-specific generator (not composing `feedRss`)

`publishingService.feedRss` emits an RSS 2.0 feed of **CMS pages** (a `<link>`-per-item page feed). A podcast feed is a different channel: it needs `xmlns:itunes`, channel-level iTunes tags, and — the load-bearing difference — an `<enclosure>` (audio URL + byte length + MIME type) per item. Bending the page-feed to carry audio enclosures would be the wrong altitude. So `podcasts/` ships its **own** generator, reusing the proven `escapeXml` + URL-cap **patterns** (hand-rolled, zero-dep, XML-escaped, item cap):

```
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>…</title> <link>…show page…</link> <language>…</language>
    <description>…</description>
    <itunes:author>…</itunes:author>
    <itunes:image href="…channel artwork…"/>
    <itunes:category text="…"><itunes:category text="…subcat…"/></itunes:category>
    <itunes:explicit>yes|no</itunes:explicit>
    <itunes:type>episodic|serial</itunes:type>
    <itunes:owner><itunes:name>…</itunes:name><itunes:email>…</itunes:email></itunes:owner>
    <atom:link href="…feed.xml self…" rel="self" type="application/rss+xml"/>
    <item>
      <title>…</title>
      <guid isPermaLink="false">…stable episode id…</guid>
      <pubDate>…RFC-822…</pubDate>
      <enclosure url="…/audio" length="{sizeBytes}" type="{audio/mpeg}"/>
      <itunes:duration>…</itunes:duration>
      <itunes:explicit>yes|no</itunes:explicit>
      <description>…</description>
    </item>
  </channel>
</rss>
```

`<guid isPermaLink="false">` is the immutable episode id (so re-publishing or moving the audio URL never duplicates an item in a subscriber's client — the Apple/Spotify dedup key). The enclosure `url` points at the Range-capable audio route; `length` is the Media asset's `sizeBytes` (Apple requires a non-zero length).

### Audio delivery — a Range-capable public route

Podcast clients stream via HTTP Range (seek, resume, chunked prefetch) and cache aggressively. The existing token asset route is `private`-cached and does full-buffer `res.send` with no Range. The new route (`GET …/public/:orgId/podcasts/episodes/:episodeId/audio`):

- resolves the episode → `audioMediaRef` → Media bytes (tenant checked against the resolved org-tenant — bytes never cross tenants);
- honors `Range: bytes=…` → `206 Partial Content` with `Content-Range` + `Accept-Ranges: bytes`; a full GET → `200` with `Accept-Ranges: bytes`;
- sets `Content-Type` from the asset (`audio/mpeg` etc.), `Content-Length`, and `Cache-Control: public, max-age=3600` (public + long — the content is public by definition once published);
- is gated on show+episode `published` + the toggle; 404 uniformly otherwise;
- is rate-limited by the existing per-IP read budget (`middleware/rateLimit.ts`) — abuse caps below.

Range parsing is a small, well-bounded piece of code (single-range, `bytes=start-end`, clamp to size, 416 on unsatisfiable). It is written once here and MAY later be hoisted into a shared helper the `/assets/:token` route also adopts (called out as follow-on, not done here to keep the media route's `private` semantics untouched).

### Uniform 404 + cache headers

Every public route returns an identical 404 for: feature off (org-tenant `podcasts` OFF), show not `published`, episode not `published`, unknown slug/id, or a wrong-org resource — no existence signal. JSON read routes cache `public, max-age=300`; the feed caches `public, max-age=600`; audio caches `public, max-age=3600`. Tenant is **always** derived from the `:orgId` resource, never from the request.

### RBAC & isolation

Publish/unpublish (show + episode) and show CRUD are `workspace:write` in the resource's org; reading show/episode config in the authed studio is `workspace:read`; uniform 404 on insufficient scope or wrong-org (the existing `podcasts/routes.ts` IDOR pattern). The public surface has **no** member scope — the content is public by definition once `published`, but only when its org-tenant has `podcasts` on. Deleting a show cascades: its episodes' `showId` is cleared and the episodes fall out of the public surface (their Media/Documents cascade per ADR 0086's delete rules).

---

## Full Feature Evaluation Matrix (10 rows)

| Row | Disposition |
|---|---|
| **1. Feature-package architecture** | Extends `src/features/podcasts/` — a `PodcastShow` entity + `published`/`showId` on the episode (additive, KV-blob, no SQL migration), a public-routes module, and the iTunes RSS generator. No new package; composes Media + `getOrg` + the existing studio. |
| **2. Toggle + admin UI** | **Extends the existing `podcasts` toggle (stable id, OFF, `tenant`)** — no new toggle. The public surface is gated by the same toggle resolved for the resource's org-tenant + the editorial `published` flag (ADR 0012/0027 precedent — a per-tenant master toggle would be redundant with `published`). |
| **3. `ctx.<feature>` surface** | The `ctx.podcasts` surface stays **read + `recordEpisodeResult`** (ADR 0086). The public read routes compose `podcastsService` + Media **directly** (a synchronous public route, not a run) — they never need the run-scoped surface. **Publish/unpublish is a route mutation, not a `ctx` op** (it is a `workspace:write` REST action, off the run path). Honest verdict: **no `ctx` surface change.** |
| **4. Node pack** | **None.** Publishing is an editorial REST action, not a generation step; there is no `podcasts.publish` node (that would put a durable public-state mutation on the untrusted run path). The existing generate pipeline is unchanged. Honest small-win note: a future "generate + auto-publish to a show" convenience could be a node, deferred (open question). |
| **5. Agent pack** | **None new.** The optional Podcast Producer agent (ADR 0086 Phase 4) is unchanged — it plans/generates, it does not publish. Publishing is a deliberate human `workspace:write` gate, off the chat-injection surface (the ADR 0086 principle: generation stays the RBAC-gated Studio action). |
| **6. RFC 0021 envelope** | **None.** No in-run structured intent; publishing is out-of-band REST. No new envelope kind (that would need an OpenWOP RFC — not warranted). |
| **7. Public surface** (the heart) | Public unauthed routes under the **already-allowlisted** `/v1/host/openwop-app/public/:orgId/podcasts/*` (show index, show page, episode page, `feed.xml`, and the Range-capable `/episodes/:id/audio`). **No new `PUBLIC_PATH_PREFIXES` entry, no core auth edit.** Tenant from the `:orgId` resource; gated on toggle + `published`; uniform 404. **Abuse caps:** the per-IP read budget (`middleware/rateLimit.ts`) covers the JSON + feed routes; audio streaming is `public`-cacheable (CDN-offloadable) and rate-limited; a per-org emitted-item cap on the feed (the `publishingService` URL-cap pattern) bounds feed size. |
| **8. RBAC** | Publish/unpublish + show CRUD = `workspace:write` in the resource's org; authed studio reads = `workspace:read`; uniform 404 on wrong scope/org (the existing `podcasts/routes.ts` guard). Public surface = no member scope (public-by-`published`). |
| **9. Replay / fork** | **N/A.** Publishing mutates a durable editorial flag via REST; it is not a run, carries no variant stamp, and nothing on the replay/fork path changes. The generation run (ADR 0086) is untouched. |
| **10. Frontend** | In the Studio (the ADR 0086 Project "Podcast" tab): a **show** manager (create/edit channel metadata + artwork picker from Media), a **publish/unpublish** control per show and per episode, the **public feed URL** (copyable) with a "**submit to Apple Podcasts / Spotify**" guidance affordance, and a lightweight **feed validity** helper (warns on the Apple-required fields: owner email, channel artwork, category, non-zero enclosure length). Public **show index + show page + episode page** are SPA routes (their crawler `<head>` rides ADR 0384 prerender). `ui/` cohesion (`.surface-card`/`.chip`/`<StateCard>`), Lucide icons, 4-locale i18n. `npm run build` gate. |

---

## Phased plan

**Phase 1 — Show model + publish flags + authed CRUD (backend).** Add `PodcastShow` (`DurableCollection<PodcastShow>('podcasts:show')`) + `showId`/`published`/`publishedAt`/overrides on `PodcastEpisode` (additive; the read path already tolerates missing optional keys — the 0383 no-migration pattern). Routes under `/v1/host/openwop-app/podcasts/*`: show CRUD (`workspace:write`/`:read`, org-scoped, uniform-404 IDOR), `POST …/shows/:id/publish` + `…/unpublish`, `POST …/episodes/:id/publish` + `…/unpublish`. Slug uniqueness per org. Tests: org-scope/IDOR, cross-org rejection, publish-state transitions.

**Phase 2 — Public read surface + iTunes RSS + Range audio (backend).** Register the five public routes under `/public/:orgId/podcasts/*` (no allowlist edit). The iTunes RSS generator (`podcasts/podcastFeed.ts`, hand-rolled + `escapeXml` + item cap). The Range-capable audio route (single-range parse, 206/416, `Accept-Ranges`, `public` cache). All gated on toggle + `published`, uniform 404, tenant-from-resource. Tests: unpublished → 404, feed XML shape + iTunes tags + enclosure length, Range 206/416, tenant-isolation on the audio bytes, XML-escaping.

**Phase 3 — Prerender / SEO integration (frontend + ADR 0384).** Public SPA routes for the show index / show page / episode page (`ui/`-cohesive, i18n). Wire the episode/show pages into ADR 0384's bot-detecting prerender so crawlers/social get inline `<head>` (OG/Twitter) + JSON-LD (`PodcastSeries` / `PodcastEpisode`). The feed + audio are already server-rendered — no prerender needed. (This phase is gated on ADR 0384 landing; Phases 1–2 do not block on it — the feed is submittable without it.)

**Phase 4 — Directory-submission polish (frontend).** The publish controls, copyable feed URL, "submit to Apple/Spotify" guidance + the required-field validity helper in the Studio; the audio artwork/duration best-effort surfacing; a per-show public listing on the org's public site index (composes the ADR 0012 site if present). Tests: FE smoke + the feed-validity helper.

---

## Alternatives weighed

1. **Host the feed on a third-party podcast host (Buzzsprout / Transistor / Apple Podcasts Connect direct).** Rejected — the whole point (per the gap analysis) is that **openwop is its own publishing platform**; exporting audio to a third-party host abandons the "MyndHyve markets itself" surface, fragments the content, and adds an external dependency + credential. The app already owns the audio bytes (Media) and a public surface (Publishing) — it should serve its own feed. (An *export/OPML* affordance to submit the openwop-hosted feed to a directory is the intended flow, not offloading hosting.)

2. **A CMS page per episode (bind each episode to a `cms_page`) instead of native public pages.** Rejected — an episode is not a CMS page; forcing one duplicates the episode into page content (drifts on re-generation), couples `podcasts` to `cms`, and still needs a bespoke RSS-with-enclosure the CMS page-feed can't emit. Native public podcast routes composing `podcastsService` keep the episode the single source of truth (edits/unpublish reflect live) — the ADR 0012 "compose, don't copy" rule.

3. **Sharing-token-only distribution (mint an ADR 0013 capability token per episode/show).** Rejected as the **distribution** mechanism — a subscribable podcast feed is a **stable, enumerable-by-design, submittable** URL (you paste it into Apple Podcasts Connect); Sharing's model is the exact opposite: an **unguessable** single-resource capability token that **404s uniformly** and points at one resource, not a channel. Sharing is right for "send this draft to a stakeholder," wrong for "publish a public podcast." The correct precedent is Publishing/ADR 0027 — editorial `published` status as the public gate on a stable org-addressed surface. (Sharing MAY still add a `podcast_episode` resolver for the private "preview this unpublished episode" case as an independent follow-on — a *different* use than distribution.)

4. **Reuse `publishingService.feedRss` for the podcast feed.** Rejected — it emits a CMS **page** feed (a `<link>`-per-page channel) with no `xmlns:itunes` and no `<enclosure>`. A podcast feed's defining element is the audio enclosure + iTunes channel tags; bending the page-feed to carry those is the wrong altitude. A second, small, podcast-specific generator that **reuses the `escapeXml` + URL-cap patterns** is cleaner and keeps the two feeds independently correct.

5. **Add Range support to the shared `/assets/:token` route and serve the enclosure from there.** Deferred (not rejected in principle) — that route is `Cache-Control: private` and token-keyed; a podcast enclosure wants `public` cache + a stable, resource-addressed URL. Introducing a dedicated public audio route keeps the media route's private-embed semantics intact; the Range-parsing code is written to be hoistable into a shared helper the media route can later adopt.

---

## Open questions & assumptions

1. **OQ-1 — Publish granularity (assumed: show channel + per-episode gate).** This ADR assumes both a `PodcastShow.published` (channel) and per-episode `published`. An alternative "publish an episode = it's live, no channel" model is simpler but can't produce a submittable *channel* feed (Apple subscribes to a channel, not an episode). Assumption stands; revisit only if a single-episode public link (a Sharing follow-on, Alt 3) is wanted separately.
2. **OQ-2 — Download / play analytics (deferred).** Podcast directories count downloads via feed/enclosure fetches; a real analytics integration (unique-IP dedup, Apple's byte-range-aware counting rules) is a larger surface. v1 defers; a later phase MAY compose ADR 0018 analytics on the audio route (a `podcast.download` event), gated behind its own decision.
3. **OQ-3 — Artwork requirements (assumed: warn, don't block).** Apple requires channel artwork ≥ 1400×1400 px RGB JPEG/PNG. The app cannot easily validate image dimensions without decoding; v1 assumes the **feed-validity helper warns** on a missing `imageMediaRef` and surfaces the Apple size guidance, but does not hard-block publish (a demo host). Hard validation (decode + dimension check) is a follow-on.
4. **OQ-4 — Duration + byte length fidelity.** `<enclosure length>` uses the Media asset `sizeBytes` (exact); `<itunes:duration>` is best-effort from clip metadata (the ADR 0086 mix may degrade to a playlist with per-clip durations summed). Assumed acceptable; a precise duration needs decoding the mixed MP3 (an ffmpeg-class deferral, same lineage as ADR 0086 OQ-1's true mux).
5. **OQ-5 — Auto-publish node (deferred).** A "generate + publish to show X" convenience node (matrix row 4) would let a scheduled weekly-digest run publish automatically. Deferred — it puts a durable public-state mutation on the run path; wanted only after the human-gated flow proves out.

## Implementation record

| Phase | What landed | Artifacts |
|---|---|---|
| **1 — Show model + publish flags + authed CRUD** | `PodcastShow` channel entity (`DurableCollection('podcasts:show')`) + additive `showId`/`slug`/`published`/`publishedAt`/`descriptionOverride`/`explicitOverride` on `PodcastEpisode` (no SQL migration); show CRUD + publish/unpublish + episode publish/unpublish routes under `/v1/host/openwop-app/podcasts/*`, `workspace:write`-gated with the uniform-404 IDOR guard; per-org slug uniqueness; show-delete cascades episodes back to draft. | `features/podcasts/podcastsService.ts`, `features/podcasts/routes.ts` |
| **2 — Public read surface + iTunes RSS + Range audio** | The five public routes under the already-allowlisted `/v1/host/openwop-app/public/:orgId/podcasts/*` (show index, show page, episode page, `feed.xml`, Range-capable `/episodes/:id/audio`), org→tenant via `getOrg`, gated on the org-tenant `podcasts` toggle + `published`, uniform 404; the iTunes RSS generator (hand-rolled, `escapeXml` + item cap, `xmlns:itunes` + `<enclosure>` + `<guid isPermaLink=false>`); single-range `bytes=` parser → 200/206/416 + HEAD, `public` cache, tenant-checked bytes. The GET audio path serves through a byte-budgeted decode-once LRU + concurrency semaphore (PODCAST-1). | `features/podcasts/publicRoutes.ts`, `features/podcasts/podcastFeed.ts`, `features/podcasts/audioCache.ts` |
| **3 — Crawler prerender + JSON-LD** | `GET/HEAD …/podcasts/:showSlug/prerender[/:episodeSlug]` — semantic HTML + inline `<head>` + `PodcastSeries`/`PodcastEpisode` JSON-LD over the public projections (honest fields only), reusing publishing's `escapeHtml`/`buildHtmlDocument`; same cache/`Vary`/kill-switch posture as the ADR 0384 route; `customDomain.ts` maps `/pod/:show[/:episode]` on a bound host here. | `features/podcasts/podcastPrerender.ts`, `features/podcasts/publicRoutes.ts`, `middleware/customDomain.ts` |
| **4 — Studio publish controls + public pages** | Shows & distribution panel (create show, publish/unpublish, feed-validity warnings, copyable feed URL + Apple/Spotify submit guidance), per-episode publish-to-show control; public SPA show-index/show/episode pages under the bare `PublicShell` at `/pod/:orgId[/:showSlug[/:episodeSlug]]`; 4-locale i18n. | `features/podcasts/{ShowsManager,PublicPodcastPage,podcastRoute,podcastsClient}.tsx?`, `App.tsx` (additive public-dispatch edit), `features/podcasts/i18n/*` |

Tests: `test/adr0390-podcast-distribution.test.ts` (11 cases — unpublished/unknown uniform 404, published feed.xml with iTunes namespace + enclosure + guid, audio 200/206/416/HEAD, foreign-tenant audio 404, publish-RBAC). Backend `tsc --noEmit` + existing podcasts tests green; frontend `npm run build` green.

**Phase 3 (prerender / JSON-LD) — implemented (follow-on, 2026-07-17).** The public show/episode pages now have a crawler prerender. Podcast pages are NOT CMS pages (they carry no `Page`/`Section`), so they cannot ride publishing's `prerenderPage`; a dedicated `features/podcasts/podcastPrerender.ts` composes the SAME public projections the JSON reads use (`getPublishedShowBySlug` / `listPublishedEpisodes` / `getPublishedEpisode`) into semantic HTML + inline `<head>` + JSON-LD (`PodcastSeries` for a show page, `PodcastEpisode` for an episode page — schema.org, honest fields only), reusing publishing's `escapeHtml` + `buildHtmlDocument` head/meta builder (the ADR 0012 cross-feature-composition precedent). Served at `GET/HEAD …/public/:orgId/podcasts/:showSlug/prerender[/:episodeSlug]` with the same cache/`Vary`/kill-switch posture as the ADR 0384 prerender route; unpublished/unknown → uniform 404 (honest-off). `middleware/customDomain.ts` maps `/pod/:show[/:episode]` on a bound host to these routes, so a customer hostname serves the semantic podcast document to bots AND humans. The **feed** was already submittable without this. Original deviation context: Phase 3 was "gated on ADR 0384 landing; Phases 1–2 do not block on it."

**Interim vs endgame — the audio route's memory (PODCAST-1, 2026-07-17).** The public Range audio route decodes the whole episode (up to the 256 MB mux cap) into memory; the interim bound is a byte-budgeted, decode-once LRU keyed by the media token (`features/podcasts/audioCache.ts`, `OPENWOP_PODCAST_AUDIO_CACHE_BYTES` default 128 MB + a per-entry cap) plus a small decode-concurrency semaphore, so a Range/prefetch burst can never stack N × 256 MB transient buffers. Moving episode audio to **object storage** and serving the enclosure as a **signed-URL redirect** (so the app process never buffers the bytes) remains the recorded endgame — an ADR-level media-architecture change, out of scope for this cache.

**Deviation — publish/unpublish is route-only (matrix row 3, honored).** The ADR noted publish MAY be a `ctx` op; it is implemented as a `workspace:write` REST mutation only (no `ctx`/node/envelope), exactly as the matrix ruled. Recorded here for completeness.

**Note — unauthed publish returns 404, not 403.** The ADR's tests asked for "401/403 unauthed" on publish flips; the repo's established no-existence-leak IDOR convention (`podcasts/routes.ts`) returns a uniform **404** for a caller without even read access to an existing entity, and **403** only for create (no entity yet) or a reader lacking write. The test asserts the real model (create → 403, flip on an existing resource unauthed → 404).

## RFC verdict

**Host work only — no wire RFC.** Every surface is a non-normative host extension under `/v1/host/openwop-app/*` (`/podcasts/*` authed mutations + `/public/:orgId/podcasts/*` public reads), reusing an **already-allowlisted** `PUBLIC_PATH_PREFIXES` entry. The RSS feed and audio route are hand-rolled host output over host-owned data (Media bytes, `podcastsService` config). Nothing adds or changes a run-event field, capability flag, event type, endpoint contract, auth/scale profile, or a normative `MUST` on the OpenWOP wire — the ADR 0012/0013 precedent (both closed with "No wire surface → no RFC"). No new RFC in `../openwop` is required; this ADR is the complete governance for the change.

**Commits:** 6fc8161a2 (P1/P2/P4 implementation) · d03ee2eeb (remediation: HEAD metadata-only audio, serve observability, episode-slug re-uniquify on show move).

---

## Correction note — public page upgrade (2026-07-24, `docs/steward/UX_UPGRADE-podcasts.md`)

A benchmark of the visitor-facing pages against podcast web homes (Transistor /
Buzzsprout / Simplecast, and the Apple/Spotify web players) graded them
**Interaction C / discoverability C**. Ranked gaps in `docs/steward/UX_UPGRADE-podcasts.md`.
Everything shipped is frontend-only: three of the four gaps were **data already
in the public payload that the UI dropped on the floor**.

1. **`<head>` management (P-G1).** A show or episode page had the app's default
   title, no description and no feed autodiscovery — so a shared link previewed
   as the generic app and a podcast app pointed at the page could not find the
   feed. Now uses a new `applyPublicHead` helper, plus `applyFeedAlternate` for
   the RSS link.

   Worth stating plainly because the same session shipped the opposite posture
   for share links: **a podcast page is meant to be FOUND; a capability-token
   page must NOT be.** Both now go through explicit, named helpers in one module
   (`applyPublicHead` vs `applyUnlistedHead`), so the distinction is legible
   rather than accidental, and both undo on unmount.

2. **`publishedAt` (P-G2)** is rendered as a machine-readable `<time>` on both
   the episode list and the episode page. An undated episode list reads as a
   dormant show.

3. **`explicit` (P-G4)** is now LABELLED on the page. This is a directory
   obligation, not decoration: our `feed.xml` already carried the flag (ADR 0390
   / the Apple taxonomy work), but a listener reading the page saw nothing.

4. **Older/newer episode navigation (P-G3).** The episode page was a dead end.
   The sibling list comes from the show read, fetched **in parallel and
   `.catch(() => [])`** — a failing side read costs the pager and nothing else.
   That is asserted by test, because the tempting version (awaiting it as a hard
   dependency) would take the whole episode page down whenever the show read
   hiccups.

Deferred with reasons: the show page mounts one `<audio>` per episode (P-G5 —
`preload="none"` means no network cost until played, so this is DOM weight at
scale, not a defect; revisit with pagination), and per-episode duration (P-G6 —
the data genuinely is not in the model, and estimating it would be worse than
omitting it; it needs the ingest to record it).

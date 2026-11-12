# ADR 1057 — Public docs: crawlable `/docs`, an honest KB lockstep, and citations that link

**Status:** Accepted. P1 is implemented in PR-A (branch `fl2-88/public-docs-seo-kb`) and P2 in PR-B (branch `fl2-88/public-docs-crawlable`). It becomes `implemented` when both merge (see § Implementation record).
**Date:** 2026-11-04
**Extends:** ADR 0392 (product documentation surface). Toggle `docs` is unchanged (default OFF, `bucketUnit: tenant`).
**Composes:** ADR 0384 (crawler prerender + platform-origin document doors), ADR 0824 (root `robots.txt` / `sitemap.xml` / `llms.txt` doors), ADR 0011 / 0351 (KB retrieval + sources), ADR 0204 (shared sections), the CMS page-lifecycle seam (`host/cmsPageLifecycle.ts`).
**Decision source:** feature loop row 88, grade `docs/steward/workflows-assessment/2026-11-04-public-docs-row88.md` (`DOCSWF-1..11`), measured against `app.openwop.dev` on 2026-11-04.
**RFC verdict:** host-extension only. No new RFC. Every route is a platform-origin document door or lives under `/v1/host/openwop-app/*`. The KB source field is in-process and stays off the wire.

## Context

ADR 0392 promised two things this host does not do.

**1. "SEO-prerenderable" `/docs` (ADR 0392 § Public serving; FEATURES.md "SEO-able").** MEASURED 2026-11-04, Googlebot user agent:

| URL | Status | Body |
|---|---|---|
| `/docs` | 200 | the generic 7,503-byte SPA shell, `<title>OpenWOP — agent platform</title>`, no canonical |
| `/docs/welcome` | 200 | the same shell |
| `/docs/does-not-exist-xyz` | 200 | the same shell (a soft 404) |
| `/p/welcome` | 200 | the real prerender, `<title>Welcome</title>`, **`<link rel="canonical" href="https://app.openwop.dev/docs/welcome">`** |
| `/sitemap.xml` | 200 | 0 `/docs` URLs (`llms.txt` lists 16) |

So the only crawlable copy of a doc names, as its canonical, a URL that serves crawlers nothing. The cause is structural:
- Firebase Hosting rewrites only `/` and `/p/**` to the backend document doors (`firebase.json`; `features/publishing/routes.ts:327,331`).
- `/docs/**` falls through to the static SPA.
- `robots.txt` disallows `/api/`, which is where the SPA fetches every docs read. A JS-rendering crawler cannot recover the content either.
- `listPublishedWithSeo` drops `collection:'docs'` (`publishingService.ts:331`), and it is the single choke point for sitemap, RSS and nav. Docs therefore never reach the sitemap.

**2. "The ONE chat answers over RAG with citations to public `/docs` URLs" (ADR 0392 §(b)).**
- **Citations (`DOCSWF-5`).** The KB upsert carries `{title, text, contentTrust}` only (`docsKnowledgeService.ts:86-90`). `KnowledgeDocument` has no citation URL: its `url` *input* means "fetch this page" (`kbService.ts:2996`). Nothing maps a docs chunk to `/docs/<slug>` (repo grep: 0 hits). The model is handed a title and cannot link.
- **Lockstep (`DOCSWF-3`, `DOCSWF-4`).** The lifecycle subscriber can strand a non-public doc in the KB, where `openwop:knowledge.search` still retrieves it. That tool is tenant-wide and does not consult the `docs` toggle. There are three ways this happens:
  - `syncDocsPage` upserts whatever `getPage` returns on a `published` event, without checking that the page is still published or still a docs page (`:84-90`). The seam fires fire-and-forget (`cmsService.ts:1764,1991,2466`), so a publish and a quick unpublish run concurrently. The unpublish handler deletes the doc, and then the slower publish handler, which is still embedding, writes it back.
  - An in-place edit that moves a published page out of the docs collection fires `published` with no `collection`. The handler returns at `:73` and the KB doc stays.
  - Removal is gated on the toggle (`:74`), so toggle OFF followed by an unpublish leaves the doc citable.
- **Quality.** The KB text has no heading lines, so the heading-aware chunker (`kbService.ts:874`) gives every docs chunk an empty `headingPath` (`DOCSWF-7`). The ingest reads `getPage`, which does not resolve ADR 0204 shared sections, while readers see `getPublishedBySlug`'s resolved content (`cmsService.ts:3123`; `DOCSWF-8`).

### Boundaries audit

- **Document doors:** publishing owns them. `documentHandler` (`publishing/routes.ts:282-325`) is a closure inside `registerPublishingRoutes`. The pieces it uses are exported or exportable: `prerenderPageCached`, `isBotUserAgent`, `setPrerenderSecurityHeaders`, `buildHtmlDocument`, `escapeHtml`, and `spaShellHtml` (module-private today). `/docs` has no other registrant: grep finds no backend `app.get('/docs…')`. Express takes the first registrant, so the new paths must not collide with `registerSharedRootShell` (`routes.ts:587`). Verify that during implementation.
- **Docs serve gate:** `docsService.resolveDocsTenant` (toggle + ADR 0820 public-lapse) is the ONE gate for the public docs lane. The door reuses it and adds no second one.
- **Sitemap:** `sitemapXml` (`publishingService.ts:389`) already builds the right URL for a docs page (`publicPageUrl` → `/docs/<slug>` for the site org, `:756`). Only the filter has to change.
- **KB source:** `kbService` owns documents and retrieval. `sources[]` and the chunk projection are built in one place (`kbService.ts:2569-2592`). No feature already owns a citation-URL concept. `knowledgeSourceFetch.ts` has a `sourceUrl`, but on the fetch result, not the stored document.
- **Chat:** no chat change. The ONE chat keeps calling `openwop:knowledge.search`. Its payload gains a `url` on a source, and nothing else moves.

## Decision

> **Corrected before code (2026-11-04, independent `/architect` pass, one Blocker + five Highs).** The first draft of D1 would have answered every crawler with 401, because `/docs` is not an auth-public path. It also claimed "no core route edits", and that was false. D2 named an ambiguous toggle read, D3 relied on a false premise, and D4 kept a field "internal" in a way this codebase does not. Each decision below is the corrected text; the original claims are kept in § Corrections so the trail survives.

### D1 — Crawlable `/docs` doors (closes `DOCSWF-1`)

- **One public-lane predicate, moved to core.** `docsService.resolveDocsTenant` (the `docs` toggle via `resolveToggle`, the ADR 0819 §1 public-lane opt-out, plus the ADR 0820 owner-lapse check) moves to `host/publicDocsLane.ts` as `publicDocsTenant(orgId)`. The docs routes, the new doors and the sitemap (D2) all call it. Publishing never imports `features/docs`.
- **The door.** Publishing's `documentHandler` (`publishing/routes.ts:282-325`) is factored into an exported `platformDocumentDoor(slugOf, { admit? })`. `/` and `/p/:slug` call it with no `admit` and behave exactly as before. The docs feature registers two doors:
  - **`GET /docs/:slug`**, bot user agent:
    - `publicDocsTenant(siteOrg)` open AND `getPublishedBySlug` resolves to a `collection === 'docs'` page → the existing page prerender. Its canonical is the `/docs/<slug>` URL (`publicPageUrl`).
    - The slug arrived through a rename redirect → **301** to `/docs/<new>`.
    - Otherwise → **404**: an unknown slug, a non-docs slug (`/docs/about` must not serve a marketing page), or docs off or lapsed.
    - Humans always get the SPA shell, as `/p/:slug` does.
  - **`GET /docs`**, bot user agent: a semantic index document. It has an `<h1>`, one link per published doc grouped as the SPA groups them, and a self canonical. It answers 404 when the lane is closed (`publicDocsTenant` null). Humans get the shell.
  - Bot responses send `Cache-Control: no-store` and `Vary: User-Agent, Accept-Language, Accept-Encoding`. The reason is the one `routes.ts:296-304` records: the Firebase CDN strips `Vary`.
- **`/p/<docs slug>` stops being a second home for a doc** (M3). In the bot branch of `/p/:slug`, a docs-collection page gets a **301** to `/docs/<slug>` when the lane is open and a 404 when it is closed. Before this, `/p/welcome` stayed crawlable even with docs off, with a canonical pointing at a URL that 404s.
- **Core edits, named honestly:**
  - `'/docs'` is added to `PUBLIC_PATH_PREFIXES` (`middleware/auth.ts:214`). `registerFeaturePublicPaths` cannot declare a root path (`:651-662`). This is exactly how `/llms.txt` 401'd every agent until ADR 0824 (`:371-376`).
  - `'/docs'` is added to `HOST_OWN_UNVERSIONED_MOUNTS` (`middleware/protocolVersion.ts:163`). It is pinned by `unversioned-mount-guard-complete.test.ts`.
- **Hosting.** Add `/docs` and `/docs/**` rewrites to Cloud Run, before the SPA catch-all. `check-hosting-wire-rewrites.cjs` gains an order-only assertion over the document-door sources (`/`, `/p/**`, `/docs`, `/docs/**`). They do NOT go into `cloudRunSources`, whose site-route collision check would flag the SPA's own `/docs` route.
- **The regression this accepts** (M2). Humans on `/docs/**` now get the shell from the backend (`OPENWOP_SPA_SHELL_URL`) rather than from Hosting's static `/app-shell.html`. That means:
  - `/docs` joins `/` and `/p/**` in the post-frontend-deploy stale-shell window (CLAUDE.md § deploy).
  - A deployment with no shell configured answers `/docs` with `no_shell_404`, which is the same precondition `/` already has (DEPLOY.md gates on it).
  - A nested `/docs/a/b` gets a human-shell fallback route, not the backend's JSON 404.
  DEPLOY.md records all three.
- **Deploy order:** backend first, then hosting. A rewrite that lands before the door 404s `/docs` for everyone.

### D2 — Docs in the sitemap (closes `DOCSWF-2`)

`sitemapXml` includes published, non-`noindex` docs pages **only for the configured site org** (`orgId === OPENWOP_PUBLIC_SITE_ORG_ID`, the one org with a `/docs` door), and only when `publicDocsTenant(orgId)` is open. Gating on the door's own predicate means the sitemap can never list a URL the door 404s.
- The per-org `/public/:orgId/sitemap.xml` for any other org is unchanged, since `publicPageUrl` would give it a JSON vendor path (`publishingService.ts:757`).
- The docs-inclusive read goes through `publishedListCache` under its own key, so a sitemap request costs no extra uncached scan.
- RSS, the marketing nav and the blog keep calling `listPublishedWithSeo` unchanged, so they stay docs-free.
- `capPublic` bounds the combined list.

### D3 — An honest lockstep (closes `DOCSWF-3`, `DOCSWF-4`)

`syncDocsPage` stops trusting the event and **reconciles to the page's current state on every docs event**, `unpublished` / `archived` / `deleted` included (M4: a stale `unpublished` handler running after a newer republish must not evict a live doc):

1. Re-read the page through the published-delivery path (`resolveSharedRefs`).
2. If it is `published`, in the `docs` collection, and the docs toggle is open → upsert.
3. If it is NOT a published docs page → delete the doc, **without consulting the toggle**. Removing a derived document is always safe. Do not create the collection just to delete from it.
   > **Corrected after code (2026-11-04, independent grade-code, finding 2).** The first cut also deleted a page that was still published while the toggle was OFF. Turning docs back on then silently dropped live pages from the chat until someone republished them or ran the backfill. A still-published page with the toggle OFF is now left exactly as it is. Witness: the toggle-off edit case in `adr1057-docs-kb-lockstep.test.ts`, sabotage-red.
4. **Serialize per page.** Handlers for one `tenant:org:page` run one at a time on an in-process promise chain. The chain survives a handler that throws, so one failure does not wedge the page (see memory "async guard flag wedges on hang"). This removes the publish/unpublish interleave on one instance.
5. **Re-check after the write.** Once an upsert lands, re-read the page, and delete if it stopped qualifying while the upsert ran. This catches the other instance's interleave down to a one-read window. It does not close that window, and nothing here claims a CAS the KB lacks. The backfill stays the reconciler of last resort.

### D4 — Citations that link, and better chunks (closes `DOCSWF-5`, `DOCSWF-7`, `DOCSWF-8`)

- **`sourceUrl` on the KB document row**, in-process only, kept internal the way this codebase keeps internal fields:
  - Added to `InternalDocumentFields` and `PRIVILEGED_DOCUMENT_FIELDS` (`kbService.ts:270-284`), so `assertNoPrivilegedFields` refuses it from any body.
  - Written at the document literal, never passed through `publicInput`.
  - When only the URL changes (a slug rename), the row is **patched in place**, not re-ingested. A URL is not content: it costs no re-embed, no revision bump and no `fireKnowledgeDocumentChanged`.
  - Absent from chunk and vector metadata. `tenantRetrieve` resolves it at projection time, **only for sources in a `docs`-managed collection** and with the reads run in parallel. (Corrected after code, grade-code finding 1: the first cut read every source's full row, one at a time, on every retrieval.)
  - It is fixed when the page is indexed. A changed `OPENWOP_PUBLIC_BASE_URL` or site org leaves stale URLs until the page is next published or the backfill runs (grade-code finding 8).
  - It surfaces as an optional `url` on `KnowledgeSource` (`host/knowledgeSurface.ts:77`). That is an additive host field on the `host.knowledge` `sources` shape, which `spec/v1/host-capabilities.md` defines as an object, so it is not a wire change. Nothing advertises it, and the demo corpus emits none.
- **Set only for the site org** (H4). For any other org, `publicPageUrl` yields a JSON endpoint, which is not a page a reader can open. Those docs keep no `sourceUrl` until a bound domain has a `/docs` door (§ Open questions).
  - The value is absolute when `OPENWOP_PUBLIC_BASE_URL` is configured (`configuredPublicBaseUrl`, `featureRoute.ts:186-196`) and relative (`/docs/<slug>`) otherwise. A request-derived origin is never stored.
  - The docs MCP results keep their hard-coded `/docs/<slug>` in this ADR (see § Open questions). Fixing them changes the tool's model-facing description and, with it, the `mcp-tool-projections` chain pack. That is a pack bump and a registry republish (`NBWF-7`), which is not worth folding in here.
- **Headings.** `flattenSections` emits each section's `heading` as a `## ` line first, and excludes `heading` from the key-sorted walk so it is not duplicated. A leading `#` in author prose already parses as a heading (`kbService.ts:887`), and that is unchanged.
- **One builder.** The lifecycle sync, `backfillDocsKb` and `docs_get` share one builder (text, headings, `sourceUrl`, shared refs), so the backfill cannot revert an improvement.
- **Known limits, stated:**
  - Editing a **shared section** fires no page lifecycle (`updateSharedSection`, `cmsService.ts:2824`), so pages using it go stale in the KB until their next publish or a backfill (M5).
  - Existing docs pick up headings and `sourceUrl` on their next publish, or through the existing `POST …/docs/orgs/:orgId/backfill`. For `host:site`, that backfill is a **deploy step**, not a boot write.

**Model-facing text.** The `knowledge.search` description does not change. The payload gains an optional `url` per source, derived from a slug. It is run-independent, so ADR 1002 replay digests are unaffected. The KB row in `LLM-EXCHANGE-AUDIT.md` is updated in the same PR.

### Deferred — the operator's product docs in every workspace's chat (`DOCSWF-6`, a user decision)

The reference corpus lives in the system-site tenant `host:site`. Retrieval is scoped to the caller's tenant, so no workspace's chat can read the app's own product docs, and neither can an external agent through `docs_search`. Options are in § Open questions. This is not part of this ADR's phases.

### D5 — One canonical spelling per doc, for people and crawlers (grade-ux N1, after code)

`/docs/` maps to `/docs`, and a docs slug in another case or with a trailing slash maps to `/docs/<lowercase>`. The crawler door answers with a 301, and the SPA replaces the address the same way (`<Navigate replace>`). Each side's rule is unit-pinned: the backend in `features/docs/routes.ts` `canonicalDocsPath`, the frontend in `features/docs/docsRoute.ts` `canonicalDocsPath`. Before this, the SPA rendered `/docs/Welcome` while crawlers got a 404, and `/docs/welcome/` behaved the other way round. Any other remainder (`/docs/a/b`) is a crawler 404 and the SPA's docs not-found. The `App.tsx` wiring of the SPA redirect has no unit test; the human-verify list covers it.

### D6 — `/p` docs admission on a read failure (grade-code PB-2/PB-3, after code; accepted by the row-88 lead)

If the page read fails, `/p/:slug` renders as before. At that point nothing marks the slug as a doc, and `docs` is OFF by default, so answering 404 there would take down every `/p` page of every docs-off site on a transient read error. The prerender re-reads the same store and answers for the page itself. Once the page is known to be a doc, a failed docs-lane read is a 404 (fail closed). Both logs are throttled.

### Corrections (from the architect pass, before code)

- The original D1 said "no core route or nav edits". **False:** `/docs` needs `PUBLIC_PATH_PREFIXES` and `HOST_OWN_UNVERSIONED_MOUNTS`. Without the first, the door 401s every crawler.
- The original D3 handled "an in-place edit that moves a published page out of the docs collection". **That cannot happen:** `collection` is set only at create (`cmsService.ts:1616`), and `updatePage` (`:1666-1770`) has no branch that changes it. The `DOCSWF-3` second half is withdrawn in the grade file. Any future path that mutates `collection` must fire `unpublished` itself.
- The original D4 said "the ingest routes do not read it" and that a URL change was a content change. Corrected to the privileged-field lists plus an in-place patch, and restricted to the site org.
- The original D2's "the core toggle resolver" was ambiguous between the paywall (`resolveOne`) and the public lane (`resolveToggle` + lapse). Corrected to the door's own predicate, for the site org only.

## Alternatives weighed

- **Put docs on `/p/<slug>` with that canonical.** Rejected: it breaks every published `/docs/<slug>` link and the SPA tier ADR 0392 shipped.
- **Unblock `/api/host/openwop-app/public/` in `robots.txt` and rely on JS rendering.** Rejected as the primary fix. Only Google renders, most AI crawlers do not, and the document doors already exist for exactly this.
- **Embed the URL in the KB text** (`Source: /docs/x`). Rejected: it pollutes the embedding and the snippet, and the model would have to parse it out of prose.
- **A KB "citation resolver" registry that features plug into.** Rejected for now: one consumer does not earn a seam, and a stored field is simpler and replay-stable.
- **A distributed CAS for the lockstep.** Rejected: the KB has no version precondition on a document. Serialize + re-check + backfill is honest about what it guarantees.

## Feature evaluation matrix (deltas against ADR 0392 only)

| # | Dimension | Verdict |
|---|---|---|
| 1 | Feature-package | docs owns both doors and the reconciler. Publishing exports `platformDocumentDoor` and gains the sitemap inclusion. KB gains one privileged optional field. **Core edits:** `host/publicDocsLane.ts` (moved predicate), `PUBLIC_PATH_PREFIXES` += `/docs`, `HOST_OWN_UNVERSIONED_MOUNTS` += `/docs`. No nav edits. |
| 2 | Toggle | `docs`, unchanged. Removal from the KB is now ungated. Serving and indexing stay gated. |
| 3–6 | Workflow / nodes / envelopes / agents | No change. `docs.mcp.*` is untouched. |
| 7 | Public surface | Two new unauthenticated document doors. Tenant from the configured site org, never from the request. Published-only. Bots get a uniform 404. Rate limit = the existing per-IP read budget. |
| 8 | RBAC | No new authenticated route. The backfill keeps `host:members:manage`. |
| 9 | Replay | None of this enters a run. The new `url` in a KB source is deterministic per page. |
| 10 | Frontend | No SPA change in P1–P2. The SPA keeps rendering `/docs/**` from the backend-served shell. |

## Phases

| Phase | Scope | PR |
|---|---|---|
| P1 | D3 + D4 (reconciler, `sourceUrl`, headings, shared refs). Backend only: `features/docs`, `features/kb`, `host/knowledgeSurface.ts` | A |
| P2 | D1 + D2 (`host/publicDocsLane.ts`, docs doors + index prerender, `/p` docs admission, sitemap, auth/mount lists, `firebase.json` + its checker, DEPLOY.md) | B |

## Open questions

- [x] **`DOCSWF-6` — DECIDED 2026-11-04 (user decision via the row-88 lead): option (a), as its own follow-up ADR + PR, not built here.** The shape:
  - a pack-allowlisted read tool `openwop:docs.search` over the configured public site's PUBLISHED docs;
  - it shares `docs/surface.ts`'s search implementation with the `docs_search` MCP tool (one implementation, not two);
  - it is gated on `host/publicDocsLane.ts` for the site tenant;
  - a Docs-guide agent pack, deep-linked from `/docs` (`/?agent=…`, the ADR 0058 pattern);
  - never in the ADR 0315 default-on baseline.
  Rejected: (b), widening every tenant's KB retrieval to include the site's docs, because it silently changes every tenant's model input. Also rejected: (c), docs answerable only inside the authoring tenant, because it leaves the operator's product docs unanswerable in every workspace.
- [ ] A bound custom domain's `/docs` (`middleware/customDomain.ts` maps `/` and `/p/:slug` only). Out of scope here, filed for the custom-domains row.
- [ ] `DOCSWF-12` The `docs_search` / `docs_get` MCP results hard-code `/docs/<slug>` (`surface.ts:474`). That is wrong for a non-site org, whose docs have no `/docs` door. The fix makes `url` optional under the D4 rule and rewords the tool description, which needs a `mcp-tool-projections` pack bump plus a republish. Filed, not built here.
- [ ] Shared-section edits fan out no KB re-sync (M5). Fix with a `listPagesUsingSharedSection` fan-out in a follow-up, or keep relying on the backfill.

## Implementation record

| Phase | Commit | Witness |
|---|---|---|
| P1 (D3 + D4) | `1a150fa73`; grade fixes `c2208a597` and the PA-1 test fix (PR-A) | `test/adr1057-docs-kb-lockstep.test.ts`: 7 cases red on `origin/main` `f2ad700ab` (2 controls green). Each fix was sabotage-witnessed red: the status check in the reconcile, the toggle gate on removal, the privileged-field entry, the `sources[].url` projection, the shared-ref resolve, and the in-place URL patch. The per-page serialization and the post-write re-read have no deterministic witness. |
| P2 (D1 + D2) | `e04589d00`, `91907fc12`; grade fixes `b65764625`, `c334b7602` (PR-B) | `test/adr1057-docs-crawlable.test.ts`: 9 cases red on `origin/main` `6f88c9047` (the base PR-B was cut from), 1 control green (the non-site org's sitemap). Each fix was sabotage-witnessed red: the `PUBLIC_PATH_PREFIXES` entry, the sitemap inclusion, the `/p` docs admission, and the door's docs-collection check. `check-hosting-wire-rewrites.cjs` was red with `/docs/**` removed. |

## Deploy notes

- **PR-B changes the public surface:** `firebase.json` gains `/docs` + `/docs/**` rewrites, and `PUBLIC_PATH_PREFIXES` gains `/docs`. **Order: backend first, then hosting.** After both, check the content type, not the status code (DEPLOY.md § the platform-origin flip, ADR 1057 block): Googlebot `/docs/welcome` → `200 text/html` with `<title>Welcome`; `/docs/<unknown>` → `404`; `sitemap.xml` lists `/docs/` URLs.
- **PR-A needs one operator step, and it is a PROD WRITE that needs the user's OK:** `POST /v1/host/openwop-app/docs/orgs/host-site/backfill`. MEASURED 2026-11-04 (read-only SQL): the 16 `host:site` KB docs date from 2026-07-18, with 0 carrying a `sourceUrl`. They pick up headings and the absolute `https://app.openwop.dev/docs/<slug>` URL only on their next publish or this backfill. It is deliberately not a boot write.


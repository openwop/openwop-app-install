# ADR 0392 — Product documentation surface (public CMS docs + chat-RAG ingest + MCP docs tool)

**Status:** implemented (Phases 1–4; see § Implementation record)
**Date:** 2026-07-17
**Decision source:** `docs/steward/MYNDHYVE-DECISIONS.md` §2 (adversarially verified — 47/50
claims confirmed against live primary sources on 2026-07-17) + `docs/steward/MYNDHYVE-GAP-ANALYSIS.md`
rows (the docs suite `PARTIAL`, "the one true structural gap").
**Depends on:** ADR 0009 (CMS — authoring), ADR 0012 (Publishing & SEO — public
serve + SEO artifacts), ADR 0027 (public front-page tier + site-org), ADR 0011 (KB/RAG —
retrieval) + ADR 0351 (rerank/citations), ADR 0087 (notebooks-as-MCP-tools — the
per-principal MCP gate) riding RFC 0020 (host MCP server), ADR 0100 (stable-id upsert).
**Completes the triad with:** ADR 0490 (tutorials — *do*; renumbered from 0303), ADR 0374/0376/0378
(walkthroughs — *guided*), the capabilities page (*what the host advertises*). This
ADR adds the missing *reference* lane, not a fourth learn surface.
**Toggle:** `docs` · **Surface:** host-extension `/v1/host/openwop-app/{cms,publishing,kb,mcp}/*`
(all non-normative) + a public `/docs` SPA route tier. **No new RFC.**

---

## Context (boundaries audit first)

`docs/steward/MYNDHYVE-GAP-ANALYSIS.md` names in-app reference documentation as *the one true
structural gap*: MyndHyve shipped `/docs` (~55 sections / ~606 subsections of
reference prose); openwop covers learn-by-doing (tutorials, ADR 0490),
guided (walkthroughs, ADR 0374/0378), and what-the-host-advertises (capabilities),
but has **no "look up how X works" reference surface**. `docs/steward/MYNDHYVE-DECISIONS.md` §2
resolves the product shape from verified research: **do NOT build an in-app docs
browser** — no studied best-in-class vendor ships one. Instead compose four
capabilities the app already owns.

The load-bearing finding: **nothing here is new infrastructure.** Every lane already
exists and is owned by an existing feature. This ADR is a thin composition + a
publish→KB subscriber, not a new store.

- **CMS (ADR 0009) owns authoring.** `cmsService.getPublishedBySlug(tenantId, orgId,
  slug)` reads a published page; `listPages` enumerates; the draft → in_review →
  published RBAC state machine already gates content (`src/features/cms/`). Docs are
  CMS pages — no new editor, no new versioning (page versions already exist).
- **Publishing (ADR 0012 / 0027) owns public serving + SEO artifacts.**
  `GET /v1/host/openwop-app/public/:orgId/pages/:slug` serves published-only pages to
  anonymous visitors (sections + merged SEO + redirect-follow + content-safety); it
  already emits `sitemap.xml`, `robots.txt`, `feed.rss` (`src/features/publishing/`).
  The public SPA route tier + site-org designation (whose published content anonymous
  `/` renders) is ADR 0027. `llms.txt` is a sibling artifact of that same emitter.
- **KB/RAG (ADR 0011 + 0351) owns retrieval.** `kbService`
  (`src/features/kb/kbService.ts`) has `createCollection` with a `managed` discriminator
  (`kbService.ts:534` — the `production` feature already uses `managed:'production'`),
  stable-id `upsertDocument` (`kbService.ts:750`, ADR 0100 — deterministic delete +
  re-ingest, no orphan/dupes), `deleteDocument` (`kbService.ts:714`), grounded `[n]`
  citations, and a change seam (`fireKnowledgeDocumentChanged` + `emitHostEvent(
  'host.kb.document.updated')`, `kbService.ts:785`). The one AI chat already answers
  from KB collections — the Stripe-Dashboard-assistant pattern, honoring the single-chat
  rule (CLAUDE.md §"AI chat — reuse, never recreate").
- **The MCP server (RFC 0020, ADR 0087) owns external-agent access.** `routes/mcp.ts`
  mounts `POST /v1/host/openwop-app/mcp`; `mcpServerRegistry.ts` scans `expose-tool`
  workflows and gates every tool per-principal via `listToolsForPrincipal` /
  `isToolAllowed` (`mcpRequiresAuth` / `mcpFeatureToggle`). `notebooks/mcpToolsWorkflows.ts`
  is the exact exemplar: expose-tool builtin workflows + a backing feature node,
  workflowId-prefixed (`NOTEBOOK_MCP_WORKFLOW_PREFIX = 'notebooks.mcp.'`) for the gate.
  A `docs.search` / `docs.get` tool is the Mintlify pattern built on this seam — zero
  new MCP infra.
- **Knowledge-sync (ADR 0107, `src/features/knowledge-sync/`) is the closest sibling —
  and the contrast that defines this feature.** Knowledge-sync is a *scheduled cadence
  poll* of an external drive folder. Docs-sync is an *in-process publish/unpublish
  event* subscriber over the tenant's own CMS. It reuses the same `upsertDocument`
  stable-id / `deleteDocument` prune discipline, but is event-triggered, not
  daemon-polled — so it needs no scheduler, no Connection, no external egress.

So the only genuinely new code is: (a) a `collection:'docs'` discriminator on CMS pages
so docs are separable from marketing/site pages; (b) a publish→KB subscriber; (c) two
MCP tool workflows + backing nodes; (d) a `/docs` public SPA tier; (e) an `llms.txt`
emitter in publishing. A thin `docs` feature-package owns (b)+(c)+(d) and composes the
rest.

## Decision

Ship a **`docs` feature-package** (toggle `docs`, default OFF, `bucketUnit: tenant`,
category **Content**) that composes CMS + Publishing + KB + MCP into a reference-docs
surface, per `docs/steward/MYNDHYVE-DECISIONS.md` §2:

### (a) Docs authored as CMS pages in a `docs` collection

Add an optional `collection?: 'docs'` discriminator to the CMS page model (a KV-blob
field — **no SQL migration**, mirroring ADR 0383's blob-field pattern). A page with
`collection:'docs'` is authored, versioned, and gated by the **existing** CMS editorial
state machine (draft `[workspace:write]` → in_review → published `[host:members:manage]`)
— no new authoring UI beyond a collection filter + an ordered **nav tree**. The nav tree
is a per-site ordered index (a `docsNav` ordering field on the site-org's docs pages,
resolved published-only); modeling it as a page-order field vs a dedicated index page is
a Phase-1 decision. Docs slugs live under a `docs/` prefix (`docs/getting-started`) so
they are addressable by the existing slug router and excluded from the marketing
sitemap/nav by their collection. Versioning rides **existing page versions** verbatim;
multi-version product docs (a `v2/` line) are deferred (open question).

### (b) Published docs ingested into a managed `docs` KB collection → the one chat

A publish/unpublish subscriber (the docs feature registers on the CMS publish seam)
keeps a per-tenant `managed:'docs'` KB collection (on the **site-org**) in lockstep:

- **On publish** → `kbService.upsertDocument(tenantId, siteOrgId, docsCollectionId,
  documentId = cmsPageId, actor, { title, text, contentTrust:'trusted' })`. The stable
  id **is the CMS page id** (ADR 0100) — republish is a deterministic re-index, never a
  duplicate; the content-hash guard makes no-op republishes free.
- **On unpublish / delete** → `kbService.deleteDocument(...)` — delete-on-unpublish, so
  the chat never cites a doc that is no longer public.
- **Citation shape:** retrieval returns grounded `[n]` citations (ADR 0351); the docs
  feature resolves each cited chunk's `documentId` back to the **public docs URL**
  (`/docs/<slug>`), so the chat links to the live page — the Stripe pattern, not an
  internal token. The chat surface is unchanged; it retrieves from the docs collection
  like any other KB collection (drivability = the existing chief-of-staff / feature-agent
  read path, no new chat panel — CLAUDE.md single-chat rule).

Content is `contentTrust:'trusted'` because it passed the editorial human gate (unlike
knowledge-sync's untrusted-fenced external drive content).

### (c) An MCP `docs.search` / `docs.get` tool for external agents/IDEs

Built exactly as ADR 0087's notebooks tools — expose-tool builtin workflows backed by
two new `feature.docs.nodes.*` read nodes, workflowId-prefixed `docs.mcp.` and gated by
the ADR 0087 projection (`mcpRequiresAuth: true` + `mcpFeatureToggle: 'docs'`):

- **`docs.search`** — semantic search over the `managed:'docs'` collection → ranked hits
  (title, snippet, public `/docs/<slug>` URL, score).
- **`docs.get`** — fetch one published doc by slug/id → title + full text + URL.

Both are read-only, replay-safe, tenant-scoped by the caller's principal. **Tool
schemas are generated from a single SSoT const** (the same const feeds the MCP manifest
`inputSchema` and the backing node's input validation), with a **parity test**
(`docs-mcp-tool-ids.test.ts`, modeled on `agent-prompt-tool-ids.test.ts` /
`promptCatalogParity.test.ts`) pinning the two so they cannot drift.

### (d) `llms.txt` emitted as a publishing build/serve artifact

Publishing emits `GET /v1/host/openwop-app/public/:orgId/llms.txt` (and the SPA maps it
to `/llms.txt` for the site-org) alongside `sitemap.xml`. Content rule: plain text —
`# <site title>`, a one-line `> summary`, then a `## Docs` section listing each
**published** docs page as `- [<title>](<absolute /docs URL>): <one-line SEO
description>`. Published-only; regenerated on the same publish event as the KB sync.
**This is a checkbox with zero expectations** — `docs/steward/MYNDHYVE-DECISIONS.md` §2 verified no
major LLM provider consumes `llms.txt` (Ahrefs Mar 2026; Google's Mueller: crawlers
"don't even check for it"; ~97% of published files get zero AI requests). It ships
because it is minutes of work, not because it is a channel.

### Public serving

The `/docs` SPA route tier renders published docs (list + nav tree + a single doc page)
through the **existing** public shell (ADR 0027's anonymous tier) and the existing
`GET …/public/:orgId/pages/:slug` route — SEO-prerenderable, shareable, no app shell,
no auth. There is **no in-app authenticated docs browser** — that is the explicitly
rejected shape (`docs/steward/MYNDHYVE-DECISIONS.md` §2; Alternative 1 below).

## Feature Evaluation Matrix

| # | Dimension | Verdict for `docs` |
|---|---|---|
| 1 | **Feature-package (ADR 0001)** | New thin `src/features/docs/` (backend) + `frontend/react/src/features/docs/` (the `/docs` public tier). Owns the publish→KB subscriber, the MCP tool workflows/nodes, and the public route; **composes** cms/publishing/kb/mcp — imports them, never shadows. No parallel store (KB is the retrieval store; CMS is the content store). |
| 2 | **Toggle + admin UI** | Toggle `docs`, **default OFF**, `bucketUnit: tenant`, category **Content** (next to `kb`, `knowledge-sync`, `cms`). No bespoke admin page — docs authoring is the CMS editor's docs-collection filter; on the standard feature-toggle admin surface. cms/publishing/kb toggles are unchanged (cms/publishing always-on per ADR 0027; kb keeps its toggle). |
| 3 | **Workflow / node pack** | New `feature.docs.nodes` with two read nodes (`docs.search`, `docs.get`) backing the MCP tools. No LLM-calling node (retrieval is deterministic kb search). Pinned in the three usual places (pack manifest / feature registration / test). |
| 4 | **Agent pack / chat drivability** | **No new agent, no new chat panel** (CLAUDE.md single-chat rule). "How does X work" is answered by the existing chat retrieving from the `managed:'docs'` KB collection — the ADR 0058 "chat-drivability = agent + nodes" pattern with the existing chief-of-staff/feature read path. |
| 5 | **AI↔app exchange (envelopes/tools)** | **Two model-facing surfaces** → both are **tool/live-SSoT-mediated (Class B)**: (i) KB docs retrieval feeding the chat; (ii) the MCP `docs.search`/`docs.get` tools. No new RFC 0021 envelope kind (retrieval + tool asks, not in-run intent). Schema text is generated from the SSoT const (parity-test-pinned). **Obligation:** both land with a `docs/steward/LLM-EXCHANGE-AUDIT.md` tracker row + tripwire (the "a new model-facing surface lands with its tracker row" rule). |
| 6 | **RBAC** | **Authoring:** inherited CMS editorial gate (`workspace:write` draft → `host:members:manage` publish) — no new authority. **Public docs:** published-only (Publishing's sole gate, ADR 0012/0027). **Docs KB collection:** `managed:'docs'` on the site-org, **readable by the chat for every authenticated tenant user** — safe because the content is already public; no per-user ACL beyond tenant membership. **MCP tools:** ADR 0087 gate — auth required + `docs` toggle on for the caller's tenant. |
| 7 | **Replay / fork safety** | Retrieval + docs.get are read-only and replay-safe (non-recorded service reads, deterministic local embedder floor). The publish→KB subscriber is idempotent (stable-id upsert / content-hash guard), so replay/re-fire never duplicates. |
| 8 | **Data model / migration** | `collection?:'docs'` + `docsNav` order are **KV-blob fields on the CMS page** — no SQL migration (ADR 0383 blob precedent). The docs KB collection is created lazily on first publish (managed collection, ADR 0011). No new table. |
| 9 | **Wire / RFC gate** | **Host-extension only — no new RFC.** MCP rides **already-Accepted RFC 0020** + the ADR 0087 gate (host work, not a wire change). CMS/publishing/kb routes are `/v1/host/openwop-app/*` (non-normative). `llms.txt` is a public non-normative artifact. Advertising nothing new on the wire. |
| 10 | **ctx-surface honesty + tests** | No new `ctx.features.*` — the nodes call `kbService`/`cmsService` reads directly. Tests: docs-collection filter + published-only serve; publish→upsert / unpublish→delete idempotency (incl. republish no-op + orphan-free); MCP tool gate (anon denied, toggle-off denied, tenant-scoped); the `docs-mcp-tool-ids` parity test; `llms.txt` published-only content shape; a chat-cites-public-URL retrieval test. Plus the two LLM-EXCHANGE-AUDIT tripwires. |

## Phased implementation plan

- **Phase 1 — CMS docs collection + public `/docs` tier.** `collection:'docs'` + `docsNav`
  on CMS pages; docs-collection filter in the CMS editor; the `/docs` public SPA tier
  (list + nav tree + doc page) over the existing `public/:orgId/pages/:slug` route.
  Decide nav-tree modeling (page-order field vs index page). *No AI yet.*
- **Phase 2 — Publish → KB sync.** The `docs` feature subscribes to CMS publish/unpublish;
  `upsertDocument`(page id) / `deleteDocument`; managed `docs` collection on the site-org;
  citation→public-URL resolution so the existing chat answers "how does X work" and links
  the live doc. **Add the LLM-EXCHANGE-AUDIT tracker row + tripwire for chat-over-docs.**
- **Phase 3 — MCP `docs.search` / `docs.get`.** `feature.docs.nodes` read nodes + expose-tool
  builtin workflows (`docs.mcp.` prefix, ADR 0087 gate); SSoT const + `docs-mcp-tool-ids`
  parity test. **Add the second LLM-EXCHANGE-AUDIT tracker row + tripwire for the MCP tools.**
- **Phase 4 — `llms.txt` artifact.** Emit from the publishing pipeline on the docs publish
  event; published-only content rule; SPA `/llms.txt` map. Checkbox — no follow-up expected.

Each phase cites `(ADR 0392 §<n> / Phase <n>)` in its commit.

## Alternatives weighed

1. **An in-app authenticated docs browser (a `/docs` reference reader inside the app
   shell).** *Rejected* — this is the explicitly refuted shape. `docs/steward/MYNDHYVE-DECISIONS.md`
   §2 found **no studied best-in-class vendor ships one**; an adversarial search for a
   Stripe in-app docs browser surfaced only a dev tool. It also fragments the single-chat
   rule (a second "ask about the product" surface) and duplicates the KB/chat retrieval
   that already answers "how does X work." The reference lane is public docs + chat-RAG +
   MCP, not an in-shell reader.
2. **Docs as repo markdown served statically (Docusaurus/MkDocs-style build).** *Rejected*
   — not tenant-authorable, not white-label-able (a white-label operator can't edit it),
   not SEO-integrated with the tenant's site-org, can't feed a per-tenant KB collection,
   and duplicates the CMS+publishing pipeline the app already ships. Loses every
   composition benefit.
3. **A third-party docs platform (Mintlify / GitBook / ReadMe).** *Rejected* — moves the
   content source-of-truth off-platform, which breaks the single-chat RAG grounding (the
   chat can't retrieve docs that live in a vendor's silo), adds a vendor + a second auth
   surface, and pays for exactly the two things (an MCP docs endpoint + an AI docs
   assistant) that the app gets for free from its own KB + MCP server. Mintlify is the
   *pattern to copy*, not the vendor to adopt.

## Open questions

1. **Docs content authoring itself is OUT OF SCOPE.** This ADR builds the *surface*; the
   ~55-section reference corpus is a separate content effort. Needs a content-plan
   pointer (which sections to seed first; who authors) — track as a product task, not
   host code.
2. **MCP-docs usage measurement.** `docs/steward/MYNDHYVE-DECISIONS.md` residual OQ #3: Mintlify ships
   an MCP docs endpoint but there is no verified usage data. Instrument `docs.*` tool
   calls, or accept it as a cheap option with no measured channel — decide before
   claiming it as a channel in FEATURES.
3. **Anonymous public docs MCP.** Docs content is public over HTTP; should `docs.search`
   be reachable *without* auth (Mintlify's docs MCP is public)? v1 keeps `mcpRequiresAuth`
   to ride the ADR 0087 gate honestly; a public-read variant is a future call.
4. **Docs versioning (multi-version product docs, `v2/`).** Deferred; the likely shape is
   a slug-prefix line (`docs/v2/*`) as a distinct nav tree, not a new versioning engine.
5. **`llms-full.txt` variant.** Whether to also emit a full-text concatenation — checkbox
   on a checkbox; skip unless asked.

## Implementation record

| Phase | Landed | Notes |
|---|---|---|
| 1 — CMS docs collection + public /docs tier | branch `feat/adr-0392-docs-surface` | additive `collection?:'docs'` + `docsNav?` blob fields on the CMS `Page` (no migration); `PageListFilter.collection` (`docs`/`site`) threaded through `listPages`/routes/create/patch; docs EXCLUDED from `listPublishedWithSeo` (the single sitemap+RSS choke point) + marketing nav, still served by `getPublishedBySlug`; new thin `features/docs/` package (public `/public/:orgId/docs` nav-tree route, toggle `docs` OFF); FE `/docs` + `/docs/:slug` tier in the bare PublicShell reusing `FrontPage` as the doc renderer (no second section renderer); 4-locale i18n; route tests (nav order, sitemap exclusion, slug serve, toggle-off 404, collection filter). Nav modeled as the `docsNav` page-order field (architect rec). |
| 2 — publish → KB sync (chat answers over docs) | branch `feat/adr-0392-docs-surface` | new `host/cmsPageLifecycle.ts` seam (`onCmsPageLifecycle`, mirrors `knowledgeLifecycle.ts`) fired from `recordCmsAction` for publish/unpublish/archive; docs feature registers `syncDocsPage` → managed `docs` KB collection keyed on the **authoring org** (`mgd-docs-<orgId>`, architect correction: not a hardcoded site-org — `tenantRetrieve` reaches it tenant-wide); stable-id = page id + content-hash guard (republish is a no-op); delete-on-unpublish; `contentTrust:'trusted'`; deterministic `flattenSections`; the existing `openwop:knowledge.search`/tenant-wide retrieval reaches it (no new binding); LLM-EXCHANGE-AUDIT row added (Class B retrieval-grounded). **Deferred:** citation→public-`/docs/<slug>`-URL linking in the chat (retrieval cites by title today; a chat-render refinement). |
| 3 — MCP docs.search / docs.get | branch `feat/adr-0392-docs-surface` | `ctx.features.docs` surface (architect correction: nodes read the scope-bound surface, NOT kbService — tenant-wide search over managed `docs` collections + per-hit pageId→slug resolve); SSoT const `docsMcpSchemas.ts` feeds both the expose-tool workflow inputSchema and the pack nodes; `docs.mcp.*` expose-tool workflows (ADR 0087 gate `mcpRequiresAuth`+`mcpFeatureToggle:'docs'`, read-only); `feature.docs.nodes` pack (search/get) + requiredPacks; parity + surface tests; second LLM-EXCHANGE row. |
| 4 — llms.txt | branch `feat/adr-0392-docs-surface` | docs-owned `GET /public/:orgId/llms.txt` (architect correction: in the DOCS feature, not publishing, which stays docs-ignorant); lists published docs with absolute `/docs/<slug>` URLs; a checkbox (no LLM provider consumes it, per the ADR). |

## RFC verdict

**Host-extension work — no new OpenWOP RFC required.** The MCP docs tools ride
**already-Accepted RFC 0020** (host MCP server composition) plus the ADR 0087
per-principal gate — advertising an existing capability, not changing the wire. CMS,
Publishing, KB, and the docs routes are all `/v1/host/openwop-app/*` (non-normative
host extensions). `llms.txt` is a public, non-normative build artifact. Nothing here
touches a run-event field, capability flag, event type, endpoint contract, or a
normative `MUST`, so no `../openwop/RFCS/` change is in scope.

---

## Correction note — reader-experience upgrade (2026-07-24, `docs/steward/UX_UPGRADE-docs.md`)

A competitive UX benchmark of this feature against Docusaurus, Mintlify and
GitBook graded the two public docs screens **Interaction D+ / IA C+** while the
rest of the surface (designed states, dark mode, token discipline, the a11y
floor) already met or beat the matrix. Catalog, matrix and ranked gaps D-G1–D-G8
are in **`docs/steward/UX_UPGRADE-docs.md`** at the repo root. The decisions of 0392 stand;
this is their reader-experience completion, recorded here because two of the
changes touch this ADR's surface:

1. **`listPublishedDocs` projects `updatedAt`** — the freshness signal a
   reference doc lives on (Docusaurus ships `showLastUpdateTime`). Additive on
   the non-normative host-extension public read; the same page's `updatedAt` is
   already served on the public page read and in sitemap.xml, so no new data is
   exposed. Test-pinned **behaviourally**: the stamp must MOVE when the doc is
   edited, because a "last updated" that doesn't move is a lie.
2. **The public shell gained a conditional Docs entry point.** `/docs` was
   routed unconditionally but reachable only by typing the URL — no header or
   footer link existed. `PublicShell` now probes the public docs nav ONCE per
   page load (shared across every public surface it wraps) and shows a Docs
   link only when the deployment actually has published docs, so a
   docs-toggle-off or white-label install never gets a link into nothing.

Also shipped, inside the feature: a grouped sidebar (it was flat while the index
was grouped — the same data teaching two different information architectures),
a sidebar filter with `/` and ⌘K, an article breadcrumb, and previous/next
pagination derived from the same ordered nav the sidebar renders.

**The ADR 0392 no-scroll-spy ruling is NOT overturned.** Docusaurus ships an
auto-TOC with scroll spy and ours deliberately does not (plain anchors, capped
at h3). That remains a live gap (D-G7), recorded rather than silently reversed —
it deserves its own decision, not a drive-by change inside a UX pass.

> **Correction (2026-08-13, round-3 pass — the "own decision" this note asked
> for):** D-G7 is closed by a **CSS-only** scroll spy —
> `scroll-target-group: auto` on the TOC list plus a `:target-current` style —
> and the ruling's SUBSTANCE stands. What the original decision avoided was JS
> scroll machinery (IntersectionObserver bookkeeping, scroll listeners, state);
> none is introduced. A browser without support keeps exactly the prior
> plain-anchor behavior — the enhancement is invisible until the platform
> provides it natively. Evidence basis: the round-2 refresh (2026-08-07, cited
> in UX_UPGRADE-docs.md) — spy is table stakes across the verified leaders, and
> the CSS-only implementation exists. Verified present in the BUILT css (the
> first check greped 2 of 4 chunks and reported it dropped — a wrong
> measurement, corrected by sweeping dist/).

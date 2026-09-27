# ADR 0408 — One content kernel: the entities engine as the single content store, pages as a system entity type

**Status:** implemented — Phases A–D (2026-07-17/18)
**Date:** 2026-07-17

| Phase | Landed as |
|---|---|
| A — Delivery bridge (ADR 0407 P1–P3) | #1998 (public read + entry status), #1999 (entityList/entityDetail sections + editor + publicRead/draft UI), #2001 (term filters + demo-entities seeder) |
| B — Parity seams (ADR 0406 P1–P5 + D2 registry) | #2003 (settings→`host/contentLocales`), #2006 (overlays + resolved delivery + field-kind registry), #2011 (explicit-locale workflow lane + editor translations) |
| C — The re-platform | #2016 (cms.page system type, `ext` channel, façade over kernel rows, APP_MIGRATION 9; honesty gate held — 21 pre-existing suites unmodified) |
| D — Dividends | Phase-D PR: system-type `publicRead` carve-out (the ONE mutable flag), `termIds` on system rows (blog-taxonomy foundation), entityList filter pair (`kind=post`), demo blog entityList-of-posts |

**Phase-D deferrals (recorded):** page↔page **relationships** (no concrete
consumer yet; the kernel's relationship model is ready when one appears) and
the **blog-archive taxonomy UI** (terms are attachable to pages via the
system-row API today; the archive routes still ride tags per ADR 0391 — moving
them to terms is a follow-on with its own UX pass). CRM/commerce-onto-kernel
stay separate ADRs as originally scoped — now **drafted as ADR 0409 (CRM core
records) + ADR 0410 (commerce product catalog), both Proposed**, applying this
Phase-C façade template to the two fixed-domain features (value-gated; each
abandonable after its kernel-prep phase).

**Phase-C implementation corrections (2026-07-18):**
- **The kernel row gained an `ext` extension channel** (structured values of
  registered extension-kind fields + system-type domain metadata) instead of
  widening the scalar `values` map — query/localization/public projection stay
  untouched; sections live at `ext.blocks` (registry-validated by the SAME
  `validateSections` sanitizer), the rest of the Page at `ext.page` (façade-
  owned, stored blind). Lossless round-trip is test-pinned.
- **Kernel value keys are seam-normalized snake_case** (`org_id`,
  `workflow_status`, `author_user_id`) — the ADR 0257 key grammar lowercases;
  this IS the queryable vocabulary for pages.
- **The `blocks` kind registers at cmsService MODULE scope** (not feature
  init): the kernel page store needs it wherever cmsService loads — bare test
  harnesses and the boot migration included. Its `validate` runs with
  baseLocale `''` (a STRUCTURE check; org-aware locale semantics stay the
  façade's first-line validation).
- **cms→entities is a DECLARED one-directional feature dependency** (the
  façade composes the kernel — the program's architecture); the reverse
  direction is guard-tested (`cms-kernel-pages.test.ts`).
- **The scheduled-publish sweep now reads a tiny `cms:scheduled` MARKER set**
  (self-healing) — cheaper than the pre-kernel cross-tenant page scan, and the
  kernel never needs a cross-tenant list.
- **No mint memo:** the system-type mint is idempotent and runs per ensure —
  a process-level cache outlives storage resets (found by the unmodified-test
  gate).
- Honesty gate held: **all pre-existing cms/publishing/prerender suites pass
  UNMODIFIED** (21 files / 138 tests) over the kernel store; APP_MIGRATION 9
  is idempotent + concurrency-safe with legacy rows read-dark.
**Program:** this is the umbrella ADR for the content-convergence program. ADR 0407
(delivery bridge) is **Phase A**; ADR 0406 (entity localization) is **Phase B**;
this ADR's page re-platform is **Phase C**. All three phases are COMMITTED — the
re-platform is in-program work, not a someday-deferral.
**Maintainer directive (2026-07-17):** "We must have one entity type that is
leveraged by the core CMS and reused by the headless CMS, not two different CMS
solutions." This ADR is the binding architectural answer.
**Depends on / composes:** ADR 0386 (entities engine), ADR 0009 (CMS — becomes the
domain façade), ADR 0257 (custom-field seam — gains the `blocks` kind via a
validator-registry inversion), ADR 0064/0205/0406 (localization), ADR 0391 (blog on
pages — carried through the migration unchanged), ADR 0066 (approval gates),
ADR 0384 (SEO prerender — behavior-pinned across the migration), ADR 0162
(idempotent ids), the APP_MIGRATION pattern (ADR 0383 lineage).
**Surface:** internal storage re-platform + one seam extension. All existing routes
(`/v1/host/openwop-app/cms/*`, public reads, `/v1/content/*`) keep their contracts.
Host-extension, **no new RFC**.

---

## Context — why the two-store split ends

After ADR 0386, the app has **two content stores**: the CMS's `cms:page` (Page +
embedded sanitized `Section[]`, versions, workflow, redirects) and the entities
engine (`entity:type`/`entity:record`, query, taxonomies, relationships,
entityApi). Every content capability now gets built twice or not at all:
localization exists on sections (ADR 0064) and was about to be rebuilt on entity
values (ADR 0406); status/publish exists on pages and was about to be re-minted on
entities (ADR 0407 D2); taxonomies exist in entities while the blog plans
category archives over page tags.

The prior boundary rulings (ADR 0009 §Alt-2, ADR 0386 Alt-2) rejected a *naive*
shared store — untyped generic blobs would have muddied section sanitization and
record query. That objection was about **field vocabulary, not storage**. The
industry-standard headless shape (Contentful / Strapi / Payload) resolves it: a
`Page` is itself a content type whose body is a **blocks field**, the page builder
is a view over entries of that type, and sanitization lives in the block field's
validator. One kernel, many vocabularies.

**Decision in one line:** the entities engine is the app's single content kernel;
`cms` keeps its UX, routes, workflow, and vocabulary but stores pages AS entities
of a system-reserved type; the headless surface and the page builder read and
write the same rows.

## Boundaries after convergence (single-owner declarations)

| Concern | Owner after this ADR |
|---|---|
| Content storage, query, indexes, entityApi, taxonomies, relationships | `features/entities` — the kernel. ONE store for user-defined types AND system content types. |
| Block vocabulary (`hero`/`richText`/`productGrid`/…), per-block sanitization, per-block locale overlays, rendering | `features/cms` — registered INTO the kernel's field-kind registry (D2); the kernel stores blocks blind and never renders. |
| Page domain behavior: review workflow + approval gates, versions, redirects, slugs, publish sweep, experiments, SEO prerender, shared sections, locale grants | `features/cms` — the domain **façade** over kernel rows. Behavior-owned, no longer storage-owned. |
| Locale settings + resolution algorithm | core (`host/contentLocales` + `host/i18n`) per ADR 0406 — unchanged. |
| CRM / KB / media | Unchanged. CRM-onto-kernel remains a separate future ADR (ADR 0386's deferral stands — CRM has identity resolution the kernel does not model). |

## Decision

### D1 — `page` becomes a system-reserved EntityType

The cms feature mints, at init, a **system content type** in the kernel
(deterministic key + CAS-from-null — the ADR 0386 structural-uniqueness pattern):

```
EntityType 'cms.page' (system: true)
  fields: title (text), slug (text), kind ('page'|'post' select), tags (text[]),
          authorUserId (text, posts), blocks (blocks — D2)
  + cms-owned workflow fields: workflowStatus ('draft'|'in_review'|'published'|'archived')
```

- `system: true` types are code-owned: not editable/deletable through the type-admin
  surface (the admin UI shows them read-only); their schema changes ship as code +
  APP_MIGRATION, never as runtime type edits.
- **Namespace reservation:** system types carry a feature-scoped dotted prefix
  (`cms.page`); user-created type names REJECT `.` (closed-world validation gains
  the rule), so no user type can collide with or squat a system name.
- Kernel entry `status` (ADR 0407: absent ⇒ live, `'draft'`) is DERIVED by the
  façade from `workflowStatus` (`published` ⇒ live, else draft) so every kernel
  consumer — query, entityApi, entity-backed sections — sees pages through the
  same publish semantics as any other type, with zero page-specific logic in the
  kernel.

### D2 — The `blocks` field kind: a validator-registry inversion on the seam

`host/customFields` (ADR 0257) gains a **field-kind registry**:
`registerFieldKindValidator(kind, { validate, resolveLocale? })`. Core defines the
registry; features register into it (the submission-sink / configDomain inversion —
features import core, never the reverse):

- `cms` registers `blocks` at feature init: `validate` delegates to the EXISTING
  per-type section builders (`buildSectionData` — sanitization byte-identical);
  `resolveLocale` delegates to the existing per-section overlay resolution
  (ADR 0064). The section vocabulary, its XSS posture, and its locale model move
  nowhere — they gain a second caller.
- The kernel validates a `blocks` value by resolving the registered kind; an
  unregistered kind fails closed at type-save AND at write.
- CRM/commerce keep their pinned narrower vocabularies (the ADR 0386 `media`
  precedent) — `blocks` never leaks into them.
- **One localization model, kind-scoped depth** (closes the 0406 double-build
  risk): scalar fields localize via ADR 0406 overlays; a `blocks` value localizes
  INTERNALLY via its kind's `resolveLocale` (the existing section overlays). ONE
  entry point (`resolveLocalizedValues`) dispatches both. Nothing is built twice.

### D3 — `cmsService` becomes the domain façade

`cmsService` keeps its entire exported API (routes, surface, packs, tests
unchanged) but reads/writes kernel rows instead of `cms:page`:

- Pages are `entity:record` rows of `cms.page`, **id-preserving** (`pageId` =
  `entityId`), so `cms:pageversion`, `cms:redirect`, experiments, approvals, and
  every stored reference keep working unkeyed-changed.
- Slug uniqueness, the review workflow + CAS transitions, versions
  (snapshot/restore), redirects, the publish sweep, experiments, shared-section
  expansion, and locale grants stay exactly where they are — they operate on the
  row content and never depended on the store's name.
- The public reads (`by-slug`, front page, `/v1/content/*`, blog routes, SEO
  prerender) go through the façade as today — their contracts are pinned by the
  existing route tests + the ADR 0384 golden tests, which must pass unmodified
  across the migration (the honesty gate for "UX unchanged").

### D4 — What the kernel's surfaces gain (the payoff)

The moment pages are kernel rows: the query engine, taxonomies (blog categories
via terms — the P1.6 shape, replacing tag-only filtering), relationships
(page↔page, entity↔page), NDJSON export/import, `ctx.features.entities`, the chat
tools, and the ADR 0407 sections all apply to pages **with zero page-specific
code**. `entityList { typeName: 'cms.page', filter: { kind: 'post' } }` is a valid
"recent posts" block on day one of Phase C. The authed entityApi exposes pages
under the same scope grammar; the public read (0407 D2) serves published pages
when the operator flips `publicRead` on `cms.page` — one delivery model, as
directed.

### D5 — Migration (APP_MIGRATION, id-preserving, gated)

One APP_MIGRATION: for each `cms:page` row, write the `cms.page` kernel row (same
id, values mapped 1:1, `Section[]` → `blocks`, section `localizations` carried
inside the blocks value) + seed the `entity:by-type` index; verify counts; the old
collection is left in place read-dark for one release (the rollback window), then
removed by the following release's cleanup migration. The migration-integrity gate
covers it; fixtures use `legacyDbAtVersion()` (never hand-rolled — the mig-35
lesson). Deploy order note: backend first (façade reads kernel), no frontend skew
(routes unchanged).

## Phased plan (the committed program)

- **Phase A — Delivery bridge (ADR 0407 P1–P2).** Public read + entry status +
  `entityList`/`entityDetail` sections. Proves the kernel on public surfaces while
  pages still live in `cms:page`.
- **Phase B — Parity seams.** ADR 0406 (locale-settings promotion + scalar
  overlays) + this ADR's D2 field-kind registry (landable before the migration —
  the `blocks` kind registers and validates even while unused by storage).
- **Phase C — The re-platform (D1/D3/D5).** Mint `cms.page`, switch the façade,
  run the migration, pin behavior with the unmodified route/golden tests, remove
  the dark store next release.
- **Phase D — Convergence dividends.** Blog categories as taxonomy terms;
  `entityList`-of-posts blocks; page relationships. Each is small once C lands.

Phases A and B are independently shippable and both reduce Phase C's risk; C is
committed, not conditional.

## Alternatives weighed

1. **Two stores + bridge forever** (ADR 0407 as originally framed) — rejected by
   the maintainer directive, and rightly: every content capability forks twice
   (localization was already about to).
2. **Re-platform first, bridge after** — viable but strictly riskier: the kernel
   would take the always-on public site as its FIRST production consumer. The
   committed program keeps the same end-state and lets Phase A be the shakedown.
3. **CMS annexes entities** (pages stay canonical; entities re-platform onto
   `cms:page`) — rejected: inverts the generality (records-with-query is the
   kernel shape; a Page is one type of record, not the other way around) and
   couples every future record type to CMS machinery it doesn't want.
4. **Sections become individually addressable kernel rows** (full atomization) —
   rejected for this program: pages are the atomic authored unit (versions,
   whole-page PATCH, ADR 0064 D5 rationale). Blocks-as-a-field preserves that.
   Revisit only if block-level reuse demands it (shared sections already cover
   the known case).

## Open questions & assumptions

- **Versions store migration** — `cms:pageversion` stays as-is in Phase C
  (snapshots embed the page payload; they don't care where the live row lives).
  Folding versioning into a kernel-generic capability is a Phase-D+ question.
- **Query ceiling** — the kernel's bounded query (≤10k rows/type/tenant) is ample
  for site-scale page counts; blog archives ride the term index. Re-check only if
  a tenant approaches the cap.
- **`cms.page` on the entityApi scope grammar** — assumed exposed like any type
  (`entities:cms.page:read|write`), with the type-admin surface read-only on
  system types. If operator feedback wants pages API-invisible, a `system`-type
  exclusion flag is additive.
- **CRM/commerce onto the kernel** — now drafted as **ADR 0409 / ADR 0410**
  (Proposed); the CRM identity-resolution / merge / org-RBAC machinery stays in
  a thick domain façade (the cost that makes both value-gated). Original note
  retained below. — still separate future ADRs (identity
  resolution, org scoping). This program neither assumes nor forecloses them.

## RFC verdict — host-extension, no wire RFC

A storage re-platform + a seam registry behind unchanged route contracts. No wire
shape, capability advertisement, or normative behavior changes; `/v1/content/*`
(RFC 0103) is behavior-pinned across the migration. No new RFC.

# ADR 0485 — Public capability-comparison page (`/p/compare`) + a `comparison` CMS section type

Status: implemented

## Context

We maintain an internal competitive assessment of the workflow-orchestration
landscape (`docs/WORKFLOW-ORCHESTRATION-COMPETITIVE-ASSESSMENT.md`) — a capability
survey across five product families (prosumer automation, durable execution, data
orchestration, AI-agent builders, enterprise BPM). The operator asked for that
comparison to be **publicly available at `app.openwop.dev`** as a capability matrix.

The app already has the exact delivery mechanism for a public, host-global page: the
reserved **system-site** org (a `host:`-prefixed tenant no real principal holds),
whose published CMS pages are served anonymously at `/v1/content/pages/:slug`
(RFC 0103 / ADR 0064 Phase 3) and rendered at `/p/:slug`. The **Features page**
(ADR 0027, `host/featuresPage.ts` → `/p/features`) is the reference pattern: a real
`cmsService` page, seeded idempotently at boot by a deterministic id, refreshed on a
`SEED_VERSION` bump *only while never hand-edited*.

The one gap: a comparison is fundamentally **tabular** (rows = capabilities, columns
= products), and the CMS had no table/matrix section. `richText` renders a limited
inline-markdown subset (no tables); `columns` renders a card grid, not a grid with a
shared column axis.

## Decision

1. **Add a first-class `comparison` CMS section type** (host-additive). RFC 0103
   leaves `sectionType` an **open string** and the section body **host-defined**
   ("this schema closes the envelope, not the body"), so a new section type is **not
   a wire change** and needs **no RFC**. The single validation gate is
   `SECTION_TYPES` in `cmsService.ts`; the new type joins it plus a `buildSectionData`
   case. Body shape:
   - `columns: string[]` — the product/family column headers (bounded `MAX.compareCols` = 8).
   - `rows: { label, cells: string[] }[]` — one capability per row (bounded `MAX.compareRows` = 24); each `cell` is a **short authored status token** (`MAX.cell` = 80), e.g. `✓` / `~` / `✗` / `"Leaders only"`.
   - `highlightColumn?: number` — the column the renderer emphasizes (ours).
   - `legend?`, `note?` — the key + a dated methodology line.
   Cells are treated as **text** by the renderer (no HTML, no links), so there is no
   stored-XSS surface — the same posture as `richText`.

2. **Seed a host-global Comparison page** at `/p/compare` — `host/comparisonPage.ts`
   + `seed-data/comparisonPage.json`, a direct mirror of `featuresPage.ts`
   (deterministic id `page:host-site-comparison`, `SEED_VERSION` refresh-when-unedited,
   `ensureComparisonPage()` at boot in `registerAllRoutes.ts`, plus an
   `ExampleDataSeeders` row). Sections: hero → intro (richText) → the matrix
   (comparison) → a closing through-line (richText) → CTA.

3. **Render** the matrix in `SectionRenderer.tsx` (`PublicSection` + a preview in
   `EditorPreview`) as a real `<table>` inside an `overflow-x` scroll region (the wide
   table scrolls in its own container, never the page body), token-styled for
   light/dark parity, with a discovery link added to the public header nav.

### Content framing (a deliberate, operator-approved choice)

Publishing comparative claims about named third parties is a reputational/legal
artifact. Per an explicit operator decision, the page uses a **named-product table**
(columns = specific products) — but cells state **capability presence**
(`✓`/`~`/`✗`), not pejorative letter grades, and the page carries a dated
"as of mid-2026, from public vendor documentation" methodology note, a
"representative, not exhaustive" caveat, an honest self-caveat (our multiplayer
builder is behind an operator toggle → marked partial), and a "corrections welcome"
line. Presence-not-scores keeps the claims defensible.

## Boundaries audit

- **No new page system.** It is a real `cmsService` page in the existing system-site
  org, created/published through the normal workflow — the `featuresPage.ts`
  precedent, not a parallel store.
- **No route collision.** `/p/compare` is served by the existing `/p/:slug` route +
  `/v1/content/pages/:slug` delivery; no new route module.
- **Single owner.** `cmsService` remains the sole section validator; the new type is
  one entry in its existing switch, not a second content path.
- **Editor picker unchanged.** The `comparison` type is a member of the FE `SectionType`
  union (so the renderer type-checks) but is deliberately **absent from the editor's
  `SECTION_TYPES` add-menu** — the matrix is host-authored (seeded), not built in the
  visual editor, so no half-supported author form ships.

## RFC verdict

**Host-extension — no RFC.** RFC 0103's section envelope is open on `sectionType` and
the body is host-defined; adding a section type honored entirely within this host
touches no wire surface. (`/v1/content/pages/:slug` already serves system-site pages.)

## Alternatives weighed

- **Compose from `columns` cards** — no true shared column axis; a comparison reads as
  disconnected cards, not a matrix. Rejected: the ask was a *matrix*.
- **Render a markdown table inside `richText`** — the inline-markdown subset has no
  table grammar; would ship as a literal pipe-soup paragraph. Rejected.
- **Family-level capability matrix (columns = the 5 families)** — lower dispute risk;
  weighed and offered, but the operator chose the named-product table. The
  presence-not-scores cell model preserves most of the defensibility.

## Open questions

- **Localization.** The matrix seed is English-only; `comparison` supports the same
  per-locale overlay merge as every section (partial-mode `buildSectionData`), so a
  localized column/row set is additive later.
- **Editor authoring.** If operators later want to build comparison sections in the
  visual editor, add a matrix-editor form + the picker row (deferred; host-authored
  suffices for this deliverable).

## Implementation record

| Piece | Location |
|---|---|
| `comparison` section type + validation | `features/cms/cmsService.ts` (`SECTION_TYPES`, `buildSectionData`, `MAX.compare*`) |
| Host-global page + seed | `host/comparisonPage.ts`, `host/seed-data/comparisonPage.json` |
| Boot ensure + seeder | `routes/registerAllRoutes.ts`, `host/exampleDataSeeders.ts` (`comparison-page`) |
| Renderer + preview + a11y | `features/cms/SectionRenderer.tsx`, `styles/global.css` (`.fp-compare*`) |
| Header discovery link | `chrome/PublicShell.tsx` (+ `navCompare` i18n ×4) |
| Tests | `test/comparison-section.test.ts`, `test/comparison-page.test.ts`, `features/cms/__tests__/comparisonSection.test.tsx` |

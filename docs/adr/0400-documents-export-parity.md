# ADR 0400 — Documents export parity (DOCX / EPUB / ODT; LaTeX deferred)

Status: implemented (P1-P4 + export menu, 2026-07-17; LaTeX shipped source-only)

Date: 2026-07-17

Lane: feature-package depth (documents render path) — no toggle change, no wire

RFC verdict: **host work only.** New export formats are additional renderers behind the
existing authed render route + workflow node; they emit host Media artifacts and touch nothing
on the OpenWOP wire. No RFC.

Supersedes/extends: ADR 0053 (documents as the single owner of stored business docs), ADR 0057
(deterministic markdown→PDF/slides/sheet render), ADR 0334 (document editor), ADR 0350
(markdown store + `promote-html`). Composes ADR 0380 (size-retention TTL) and RFC 0055 (Media).

## Context

The MyndHyve gap analysis (`docs/steward/MYNDHYVE-GAP-ANALYSIS.md`, canvas/exports pass, row
"documents PDF/DOCX/EPUB/ODT/LaTeX export (pandoc)") grades documents export **PARTIAL — M**:

> `render.ts` = PDF (pdfkit) + slides/sheet materialize; `RENDER_FORMATS=['pdf','slides','sheet']`.
> DOCX **import** (mammoth) only. **No DOCX/EPUB/ODT/LaTeX export.** No Paged.js.

MyndHyve produced six formats through a **standalone pandoc Cloud Run service**. The gap analysis
explicitly **SKIPped porting standalone services** (§"Deliberate divergences"), so the central
question here is the **conversion engine**, not whether to close the gap. Long-form authors on the
openwop documents/document-editor surface today can only get a read-only PDF; they lose editable
Word output and reflowable e-book output.

The source of truth we convert **FROM** is settled: ADR 0350's markdown store — each document
version holds immutable Markdown (`version.content`), parsed by `markdown-it` into a token stream.
Every existing renderer (`render.ts`) walks that token stream. New formats are new walkers over the
**same** token stream — no new SoT, no new parse.

### Boundaries audit (file:line)

- **`backend/typescript/src/features/documents/render.ts:1-8`** — the render module's charter:
  "Pure-JS: `markdown-it` parses to a token stream, `pdfkit` lays it out — **NO headless Chromium
  (light image, deterministic)**." This is a deliberate posture, not an accident. Any engine choice
  that reintroduces a heavy binary must justify overturning it.
- **`render.ts:39` `renderMarkdownToPdf` / `:200` `renderMarkdownToPptx` / `:177`
  `renderMarkdownToCsv`** — the three existing token-stream walkers. Each is a pure
  `(markdown) → Buffer`. The new DOCX/EPUB/ODT walkers are peers of these, in the same file, sharing
  `inlineText()` (`:16`) and `extractTables()` (`:144`).
- **`documentsService.ts:598-635`** — `RENDER_FORMATS = ['pdf','slides','sheet']` (`:599`),
  `RENDER_SPEC` (contentType + ext per format, `:602`), and `renderDocument()` (`:615`) — the ONE
  entry point both the sync route and the run-scoped node call. `renderDocument` reads the immutable
  current version, dispatches on `format`, `mediaStorage.put`s the bytes, `createAsset`s a library
  row, stamps `version.renderedMediaToken` **only for `pdf`** (the canonical shareable rep), and
  returns `{ versionId, format, renderedMediaToken, url, sizeBytes }`. New formats extend this one
  function's dispatch + `RENDER_FORMATS` + `RENDER_SPEC` — no second render path.
- **`routes.ts:254-264`** — `POST …/documents/:documentId/render`, `authz(req,'workspace:write')`,
  validates `format ∈ RENDER_FORMATS`. Adding formats to the array widens this route for free; the
  auth predicate is unchanged.
- **`surface.ts:105`** — `render: (args) => renderDocument(...)` — the run-scoped surface op the
  workflow node binds to. Same widening for free.
- **`packs/feature.documents.nodes/pack.json:68`** — `feature.documents.nodes.render` node
  ("Documents: Render to PDF"). Already exists. It gains a `format` param; the label/description
  generalize to "Render / Export". **This is the AI win** (see §Decision).
- **Slides export precedent — `features/slides/export/slidesExport.ts`** — the "no new service"
  proof: real `.pptx` (pptxgenjs) + `.pdf` (pdfkit) **in-process**, with a pre-flight byte estimate
  (`:96 estimateExportBytes`), a `MAX_EXPORT_BYTES = 25 MiB` cap (`:329`), a 1-hour scratch TTL
  (`EXPORT_TTL_SECONDS`, `:328`), and `storeMediaAsset` token delivery (`:372`). The documents
  exporters copy this shape.
- **Media delivery — `features/media/mediaStorage.ts:19,37`** — `DURABLE_TTL_SECONDS` (~100 yr) is
  what `renderDocument`'s `mediaStorage.put` uses today: the PDF is a **durable library asset**.
  `slidesExport` instead uses `storeMediaAsset` with a **1-hour scratch TTL**. Two postures exist;
  §Decision picks per-format.
- **Retention seam — `host/retentionPurger.ts:42 registerRetentionPurger` + `host/kvAgeOut.ts`
  (ADR 0380)** — the two lanes. Scratch-TTL Media is already swept by the global size backstop
  (kvAgeOut) with **no new purger needed**; a durable classification purger is the alternative.
- **`Dockerfile`** — Node 22-slim, esbuild bundle, production deps only, `better-sqlite3` prebuilt
  binary. No system binaries beyond the base image. Adding `pandoc` means an `apt-get`/binary COPY
  into the runtime stage (see §Alternatives (b) for the honest cost).
- **DOCX today is IMPORT-only** — `mammoth` converts uploaded `.docx → markdown` on the way IN.
  There is no `.docx` writer anywhere. This ADR adds the writer; import and export stay disjoint
  libraries (mammoth reads OOXML; `docx` writes it).

  > **Correction (implementation, 2026-07-17):** stale — `document-editor/pmToDocx.ts` (ADR 0334
  > 4b-2) already writes DOCX from **ProseMirror JSON** (a different SoT), and the `docx` + `jszip`
  > deps were already in `package.json`. Disjoint inputs, same output format: `pmToDocx` owns
  > PM-JSON→DOCX, this ADR's walker owns markdown→DOCX. No new dep was added (only
  > `markdown-it-footnote`, for real footnote tokens).

## Decision

**Ship DOCX, EPUB, and ODT export as in-process JS renderers — new token-stream walkers in
`render.ts`, dispatched through the existing `renderDocument()` / `RENDER_FORMATS` /
`RENDER_SPEC`.** No pandoc binary, no export service. **LaTeX is deferred** (source-only would be
low-value over the existing PDF, and compile-to-PDF needs a TeX distribution we will not ship — see
§Alternatives and §Open questions).

Engine per format (all pure-JS, deterministic, zero network, zero provider — the render.ts posture):

| Format | Library / mechanism | Why |
|---|---|---|
| **DOCX** | [`docx`](https://www.npmjs.com/package/docx) (dolanmiu) — builds OOXML programmatically from a document model (`Paragraph`/`TextRun`/`Table`/`ImageRun`/`Footnote`). Pure JS, no native deps, actively maintained. | The clear in-process DOCX writer. We translate `markdown-it` tokens → `docx` model elements, mirroring the existing pdfkit token walk. |
| **EPUB** | In-memory EPUB3: reuse `markdownToHtml()` (`render.ts:33`) per chapter, package OPF + nav + XHTML with `jszip` (already transitively present via pptxgenjs; pin it directly). No filesystem, no `sharp`. | EPUB is a zip of XHTML — reflowable, so text fidelity is inherently high, and EPUB3 supports MathML natively (a math advantage, see fidelity matrix). Avoids `epub-gen`'s native/filesystem baggage. |
| **ODT** | Templated OpenDocument: emit `content.xml` (+ `styles.xml`, `META-INF/manifest.xml`, `mimetype`) from the token walk, zip with `jszip`. | No mature maintained pure-JS ODT *writer* exists; a templated writer over the token stream is the honest minimal path (and the reason ODT ships **last** — Phase 3). |

### Design

**Conversion fidelity matrix (honest — what degrades where).** Fidelity is measured against the
Markdown SoT, not against a hand-authored native file. `✓` = faithful, `~` = degraded/approximate,
`✗` = dropped.

| Markdown construct | PDF (today) | DOCX (`docx`) | EPUB3 (XHTML) | ODT (templated) |
|---|---|---|---|---|
| Headings h1–h6 | ✓ (3 sizes) | ✓ (Heading styles) | ✓ | ✓ (Heading para styles) |
| Paragraphs, bold/italic inline | ~ (inline flattened) | ✓ (real runs) | ✓ | ✓ |
| Bullet / ordered lists | ✓ | ✓ (numbering defs) | ✓ | ✓ |
| Tables (GFM) | ~ (monospace text) | ✓ (real `Table`) | ✓ (`<table>`) | ✓ (`table:table`) |
| Images (host Media assets) | n/a in doc render | ✓ (`ImageRun`, embedded) | ✓ (embedded in zip) | ~ (embedded; sizing approximate) |
| Images (external URL) | n/a | ~ (linked-text placeholder, never fetched — SSRF posture) | ~ (same) | ~ (same) |
| Code blocks / inline code | ✓ (Courier) | ✓ (monospace run) | ✓ (`<pre>`) | ✓ (monospace style) |
| Blockquotes | ✓ | ✓ | ✓ | ✓ |
| Footnotes (`[^1]`) | ✗ (flattened) | ✓ (`docx` Footnote) | ~ (endnote-style links) | ~ (note anchors) |
| KaTeX / `$…$` math | ✗ | ~ (fallback: rendered as code/TeX text; OMML conversion out of scope) | ~ (**MathML** when EPUB3 — best of the four) | ✗ (dropped to text) |
| Horizontal rule | ✓ | ✓ | ✓ | ✓ |

The matrix is the deliverable, not an afterthought: it tells an author *before* they export where a
construct will soften. Math is the weakest axis across editable formats; EPUB3's native MathML makes
it the least-degraded, DOCX degrades to TeX-as-text (OMML generation is explicitly out of scope),
ODT drops to text. This is called out in the export UI (§Frontend) and §Open questions.

**Sync vs async.** All four walkers are pure, deterministic, provider-free functions of
`version.content` — the same class as the existing PDF/slides/sheet renders, which are **synchronous
route handlers today**. We keep the render route synchronous, guarded by the slides-export
**pre-flight byte estimate + `MAX_EXPORT_BYTES` cap** pattern (`slidesExport.ts:96,329`). The
**async lane already exists and needs no new infrastructure**: the `feature.documents.nodes.render`
workflow node is run-scoped, replay-safe, and idempotency-keyed — batch/large-report generation
rides the node, not a bespoke export-job queue. A dedicated progress-tracked async job is recorded
as a deferred open question (only justified if real documents routinely exceed the sync budget).

**Artifact retention.** Editable exports are **regenerable** from the immutable version, so they do
not need durable storage. New formats (DOCX/EPUB/ODT) store as **short-TTL scratch Media**
(`storeMediaAsset`, ~1 h, mirroring `slidesExport`'s `EXPORT_TTL_SECONDS`) delivered by a Media serve
token — download-and-go. This composes ADR 0380 for free: scratch Media is already swept by the
global `kvAgeOut` size backstop, so **no new `registerRetentionPurger` lane is required** (calling
one out honestly, rather than inventing a `cleanupExpiredDocumentExports`). The **PDF stays durable**
(it remains the canonical shareable representation stamped onto `version.renderedMediaToken`); the new
formats deliberately do **not** stamp that pointer, exactly as `slides`/`sheet` do not today
(`documentsService.ts:633`).

**Filename + metadata.** Reuse `renderDocument`'s existing safe-name derivation
(`doc.title.replace(/[^\w .-]/g,'_').slice(0,120) || 'document'`, `:628`) + the per-format `ext` from
an extended `RENDER_SPEC`. Document title → the format's title metadata (`docx` core properties,
EPUB OPF `<dc:title>`, ODT `meta:title`). No author PII beyond title is embedded.

**Idempotency / replay.** Export is a pure function of `(immutable version content, format)`. The
version id is already the natural content hash (versions are immutable, `documentsService`). The node
keys its Media write by `(versionId, format)` so a replay/fork re-derives the **same** artifact
rather than accumulating copies — the ADR 0057 determinism guarantee carries to every new format.

### Ten-row feature matrix

| # | Axis | Ruling |
|---|---|---|
| 1 | **Feature-package / toggle** | No new package. Lives in the `documents` feature. **`documents` toggle is stable/unchanged** — export is a capability of an already-shipped feature, not a new gated surface. |
| 2 | **ctx / surface op** | Extend the existing `render` surface op (`surface.ts:105`) — it already takes `format`; widen the accepted set. No new op name. |
| 3 | **Node pack** | Generalize `feature.documents.nodes.render` (pack.json:68) from "Render to PDF" → "Render / Export", add a `format` enum param (`pdf\|slides\|sheet\|docx\|epub\|odt`). **Workflow-driven report generation is the AI win**: an agent/workflow assembles a document from a template (`generate-from-template`) then emits an editable **Word** deliverable in one run — the run-scoped, replay-safe async lane. Bump pack version. |
| 4 | **Envelopes** | **None new.** Export is a tool/route action, not in-run structured intent; no RFC 0021 envelope kind. |
| 5 | **Agent pack** | **None new.** The generalized render node is pack-allowlisted the same way; no new agent persona. |
| 6 | **Public surface** | **None.** Exports are **authed downloads** — creation is `authz`-gated; delivery is a capability-bearing Media serve token. Nothing anonymous. |
| 7 | **RBAC** | **Unchanged.** Export reuses the render route's predicate (`workspace:write` today; parity with `renderDocument`). The node shares the same surface access as the existing render node. No new grant. |
| 8 | **Replay/fork** | **Idempotent by doc-version hash** — pure `(immutable version, format) → bytes`; node keys Media write by `(versionId, format)`; replay re-derives identical bytes. |
| 9 | **Frontend** | Extend the existing document render/download control into an **export menu** (PDF · DOCX · EPUB · ODT), each firing the render route with its `format`. Sync spinner reusing the existing render-in-flight state; a math/footnote **fidelity hint** shown for DOCX/ODT. No new screen. |
| 10 | **Data/migration** | **None.** No schema change — exports are derived Media artifacts, not persisted document fields. |

## Phased implementation plan

| Phase | Scope | Gate |
|---|---|---|
| **P1 — DOCX** | Add `docx` dep; `renderMarkdownToDocx()` token walker in `render.ts` (headings/lists/tables/images/code/blockquote/footnotes); extend `RENDER_FORMATS` + `RENDER_SPEC` + `renderDocument` dispatch; scratch-TTL storage; route validates the wider set; fidelity unit tests (per matrix row). | `npm test`; a golden-file test asserting the `.docx` unzips to expected OOXML for each construct. |
| **P2 — EPUB** | `renderMarkdownToEpub()` — chapter split on h1/h2, `markdownToHtml` per chapter, OPF + nav + XHTML zipped via `jszip`; MathML pass-through for `$…$` when present; EPUB validity test (mimetype-first, container.xml, nav). | `npm test`; epubcheck-shaped structural assertions. |
| **P3 — ODT** | `renderMarkdownToOdt()` — templated `content.xml`/`styles.xml`/`manifest.xml`/`mimetype` from the token walk, zipped; ODF structural test. | `npm test`; unzip-and-assert content.xml structure. |
| **P4 — LaTeX decision** | Revisit: emit `.tex` **source-only** (no compile) as a fourth format, or leave deferred. Recommendation stands: **defer** unless an author demand surfaces (source-only adds little over the existing PDF; compile needs a TeX distro we won't ship). | ADR correction note recording the call. |

> **Resolved (2026-07-17):** LaTeX **source-only** shipped — `renderMarkdownToLatex` (a peer token walker; standalone `article` doc, sections/lists/verbatim/tabular/quote/footnotes/marks). No compile, no TeX distro. Notably it is the **one export with faithful math**: inline `$…$` passes through verbatim (LaTeX is math's native format), so the fidelity matrix's math row is ✓ here while DOCX/EPUB/ODT degrade. Images become labelled placeholders (source carries no bytes). Scratch-TTL like the other editable exports; node manifest → seven formats.

### As-built record (2026-07-17)

| Phase | Landed |
|---|---|
| P1 DOCX | `renderMarkdownToDocx` (real runs/lists/tables/footnotes via `markdown-it-footnote`, tenant-checked image embeds, external→linked text), scratch-TTL storage split, 25 MiB cap, fidelity tests (`documents-export.test.ts`) |
| P2 EPUB | `renderMarkdownToEpub` + `splitMarkdownChapters` (fence-aware), STORED-mimetype-first zip, `dcterms:modified` from the immutable version ⇒ byte-deterministic re-render. **Correction:** own `xhtmlOut` markdown-it instance (the shared `markdownToHtml` emits HTML5 void tags, not XHTML). **MathML RESTORED (2026-07-17):** `$$…$$` math converts to native MathML via **temml** (pure-JS, MIT, deterministic, no DOM/network — the ADR dep concern satisfied); the chapter carries the EPUB3 `mathml` manifest property; single-`$` money is never matched (unambiguous `$$` delimiter, rule-before-escape, never fires in code), and a malformed formula falls back to literal text. DOCX OMML + ODF math stay out of scope (still text-preserve there). |
| P3 ODT | `renderMarkdownToOdt` — templated ODF (content/styles/meta/manifest), footnote splice, sized picture embeds |
| Export menu | `DocumentDetailPage` three ghost buttons → ONE `ui/Menu` (DS-8) with the six formats + the fidelity hint on DOCX/ODT; 4-locale i18n |
| Node pack | `feature.documents.nodes@1.2.0` — render node generalized to "Render / Export" w/ the six-format enum + scratch-vs-durable semantics in the manifest |
| **P4 LaTeX — DEFERRED (decision recorded)** | Source-only `.tex` adds little over the existing PDF; compile-to-PDF needs a TeX distribution we will not ship. Revisit on author demand. |

**Replay correction:** the node-level "(versionId, format) Media-write key" described in §Design is
NOT how replay safety is achieved as-built — an action node's recorded result is read **verbatim**
on replay/`:fork` (the ADR 0083 record-and-read invariant, same as ADR 0399), so a replay never
re-renders at all. The determinism tests pin that a live re-render of the same version is
byte-identical for EPUB (and structurally identical for DOCX/ODT, whose zips carry no clock).

Each phase ships + tests + reverts independently. Node pack version bumps once at P1 (the `format`
enum lands complete-shaped; later phases only widen the accepted values, already validated
server-side).

## Alternatives considered

**(a) In-process JS libraries — CHOSEN.** `docx` + `jszip`-based EPUB/ODT. **Pros:** keeps the
single container and the `render.ts` "light image, deterministic, no heavy binary" posture; zero
network / zero provider (SSRF-free by construction, matching slides' image policy); composes the
existing Media delivery + retention + cap machinery unchanged; each renderer is a peer of the
existing pdfkit walker (one code shape to review). Matches the **slidesExport "no new service"
precedent** directly. **Cons:** fidelity ceiling per the matrix — math is degraded (no OMML for
DOCX; MathML only in EPUB3; dropped in ODT), and ODT has no mature library so we hand-template it.
Accepted: the SoT is Markdown (math is already a minority construct there), and the matrix makes the
degradation honest and visible.

**(b) `pandoc` binary in the existing backend container — REJECTED.** One engine, best-in-class
fidelity across all four formats **and** footnotes/math (pandoc's own readers/writers), and it is
what MyndHyve used. **But:** the pandoc static binary is ~120–170 MB installed — a large addition to
a Node 22-slim image whose whole point (Dockerfile, render.ts) is to stay light; it **inflates Cloud
Run cold-start** image-pull time on a service that scales to zero; every export **shells out to a
subprocess** (new failure/timeout/zombie-process surface + an exec sink to harden) — directly
overturning render.ts's "NO headless binary, deterministic in-process" charter without a fidelity
need that the matrix shows we can't otherwise meet. Rejected: the posture cost is real and the
fidelity delta (chiefly math) does not justify it for a Markdown SoT.

**(c) A new standalone export (pandoc) Cloud Run service — REJECTED.** This is exactly MyndHyve's
architecture and exactly what the gap analysis **SKIPped** ("openwop serves host-side rather than
porting standalone services"). **Pros:** isolates the pandoc image bloat from the main backend;
scales independently. **Cons:** a second deploy target + its own auth + a network hop + artifact
transfer for every export; contradicts the documented SKIP and the in-process slides/render
precedent; operationally heavier for a feature the in-process path covers. Rejected on
architecture-fit and ops cost.

## Open questions

- **Math in DOCX.** OMML (Office MathML) generation from KaTeX/TeX is non-trivial and **out of scope
  for P1** — DOCX degrades math to TeX-as-code text. Revisit only if authors report math-heavy Word
  needs; EPUB3's native MathML is the near-term math-faithful path.
- **RTL / i18n text.** The walkers pass Unicode through faithfully; per-run/paragraph
  **direction attributes** (`bidi` in DOCX, `dir` in XHTML, `style:writing-mode` in ODT) are **not**
  set in P1. Flagged as a follow-up aligned with the app's RTL-locale backlog item; not a blocker for
  LTR content.
- **Pagination fidelity vs Paged.js — out of scope, stated plainly.** MyndHyve's gap note mentions
  "No Paged.js." We are **not** adopting a paginated-HTML engine: DOCX/ODT pagination is owned by the
  consuming word processor (reflow), EPUB is reflowable by definition, and the PDF path stays
  pdfkit. Pixel-exact print pagination is explicitly **not a goal** of this ADR.
- **Async progress job.** Only justified if real documents routinely exceed the sync
  `MAX_EXPORT_BYTES` budget; until then the workflow node is the async lane. Deferred.
- **LaTeX.** See P4 — recommend defer; decision recorded as a correction note when P3 lands.

## RFC verdict

**Host work only — no RFC.** New export formats are additional deterministic renderers behind the
existing authed render route + surface op + workflow node, emitting host Media artifacts under
`/v1/host/openwop-app/*`-shaped delivery. Nothing is advertised on the OpenWOP wire; no run-event
field, capability flag, event type, or endpoint contract changes. This is squarely host-extension
work, like ADR 0057 before it.

## Correction note (2026-09-01) — the replay-determinism row was false, then true-but-unverified

Row 8 of the matrix above claims the render is *"pure `(immutable version, format)
→ bytes`; replay re-derives identical bytes."* For the ZIP-container formats
(EPUB, ODT) that was **false as written**: `render.ts` called `zip.file(...)` with
no `date:`, so JSZip stamped every entry with `new Date()` at write time. Two
generations from identical inputs differed whenever they straddled a second
boundary — surfacing as a full-suite "flake" (`expected -1 to be +0`) that passed
21/21 in isolation. Content-addressed caching, signing and diffing all rested on
the claim.

`pinZipTimestamps` fixed it by sweeping every entry's stamp after the files are
added, rather than threading a `date:` through ~20 call sites — deliberately, so a
missed call site cannot silently reintroduce the defect.

**The part worth recording is what happened next.** The fix shipped with no test
that could detect its removal. MEASURED 2026-09-01: deleting BOTH `pinZipTimestamps`
calls left all 21 `documents-export.test.ts` tests green, *including the two named
"is deterministic (same inputs ⇒ identical bytes)"*. They generate back-to-back, so
both calls land in the same second and the stamps cannot differ — the assertion
holds for the wrong reason. **The defect and the test that was supposed to catch it
shared a single root cause**, which is why the test never caught it and why fixing
the code did not fix the exposure.

`documents-export-determinism.test.ts` closes that: it moves the system clock a day
between the two generations, asserts the entry stamps carry the supplied
`modifiedAt` rather than any constant, and is sabotage-verified per call site.

**A test whose subject is a timestamp must control the clock**, or it measures how
fast the machine ran rather than the property it names.

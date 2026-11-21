# ADR 1129 — Film creative assists

Status: Proposed (2026-11-15). Planning only. Part of ADR 1126, release 1 (user decision).

## Context

DeckTalk's scope-B creative assists (DT-G09–G16, decktalk@8691c224) are merged on its product
branch but **not yet deployed or acceptance-tested** in DeckTalk production. Each has 4–6 node
tests and an independent-review fix commit. G09 and G16 also have graded reviews. DeckTalk's owner
rates them as follows (code-level judgement only):

| Assist | DeckTalk module | Spends money | DeckTalk's readiness rating |
|---|---|---|---|
| G09 brand themes | `film-theme.mjs` (uses upstream Brand + locks) | no | upstream-ready |
| G10 starters | `film-starters.mjs` | no | mechanism ready; content is DeckTalk-specific |
| G11 reusable scenes | `scene-library.mjs` | no | upstream-ready |
| G12 copy rewrite | `copy-rewrite.mjs` | yes (DeckTalk run budgets) | re-home first |
| G13 image generation | `image-generation.mjs` | yes (DeckTalk run budgets) | re-home first |
| G14 image derivatives/repair | `image-derivative.mjs`, `image-dimensions.mjs` | processing | resource bounds review first (dimensions: ready) |
| G15/G16 charts, tables, flows | `film-blocks.mjs`, `film-composition.mjs`, `film-layout.mjs`, `charts.mjs` | no | upstream-ready |

All of them compile into ordinary FilmSpec v1 elements and cues.

**Upstream equivalents that already exist:**
- `campaign-channels` `generate` with `refineOp`/`priorDraft`: brand voice, claim grounding and
  ADR 1020 approval gates.
- `providers/dispatchImages.ts` plus the daily image budget (ADR 0115 P5, OpenAI/Imagen/Replicate).
- Media derivatives that are crop boxes only (`media/mediaService.ts:166-169`).
- The ADR 0946 brand-lock and safe-zone tables.

## Decision

### D1 — Port the pure assists, renamed and test-carried

- **Theme:** `film-theme` reads `brand` (always on) and the ADR 0946 brand locks, and produces a
  FilmSpec theme (type scale, palette tokens, motion defaults).
- **Scene library:** a workspace-scoped `DurableCollection` of saved beats, each a FilmSpec scene
  plus its slot schema, insertable into any production. A saved scene keeps its source production
  id for lineage.
- **Blocks:** `film-blocks`, `film-composition` and `film-layout` provide charts, tables and flows
  as FilmSpec element groups with reveal cues. Chart data is entered or read from a workspace
  dataset. Formats 16:9, 9:16 and 1:1 have fit rules; 4:5 is added later with its own rules.
- **Image dimensions:** ported as is.

Engine ids drop the `decktalk-` prefix. DeckTalk's node tests and parity tests move with the code.

### D2 — Starters with neutral content

The starter mechanism (a template production with beat slots) is ported. DeckTalk's starter content
stays in DeckTalk. Upstream ships neutral marketing starters: product launch, customer proof,
how-it-works, event promo, and "one decision" explainer. Adopters add their own starters as data in
their own repo, without code changes, through a starter-pack seam: a starter is a JSON asset in an
artifact-type pack.

### D3 — Re-home copy rewrite and image generation (no second path)

- **Copy rewrite** (hooks, titles, beat copy) calls `campaign-channels` `generate` with `refineOp`.
  It inherits brand voice, claim grounding against the brief and the existing gates. DeckTalk's
  `copy-rewrite.mjs` is not ported. Its requestId chaining is kept only as the reuse receipt
  (ADR 1128 D5).
- **Image generation** for a beat goes through `dispatchImages` and the daily image budget. A
  missing key fails typed (`image_key_missing`). Generated images become Media assets with lineage
  (`generatedBy:'ai'`, prompt, model). DeckTalk's `image-generation.mjs` contributes only its prompt
  building from beat + theme.
- Neither keeps DeckTalk's `runBudgets.ts`. Spend is capped only by the existing upstream caps plus
  the render meter (ADR 1127 D5).

### D4 — Image derivatives that produce new images

`image-derivative` adds real derivatives (crop to a format, extend background, remove text, repair
artifacts) as new Media assets, beside today's crop-box derivatives. Before it ships, a
resource-bounds review sets maximum input pixels, maximum output pixels, a per-call timeout, and
memory per operation. Every operation runs in the render job, or in the browser for crop and
extend, never in the API process. AI-backed derivatives (extend, remove text) use the image
dispatcher and its budget.

## Phases (pure first; spending after DeckTalk prod evidence)

| Phase | Scope | Gate |
|---|---|---|
| A0 | Theme, scene library, blocks (charts/tables/flows), image-dimensions | parity + node tests carried |
| A1 | Starter mechanism + neutral starters + adopter starter-pack seam | |
| A2 | Copy rewrite re-homed onto `campaign-channels` refine | G12 contract informed by DeckTalk prod acceptance; upstream path passes its own acceptance |
| A3 | Beat image generation through `dispatchImages` | G13 contract informed by DeckTalk prod acceptance; upstream path passes its own acceptance |
| A4 | Image derivatives (non-AI crop/extend first, then AI) | resource-bounds review; G14 acceptance |

DeckTalk's owner will run scope B through DeckTalk production acceptance after its next deploy and
send the results. **Scope of that evidence:** it exercises DeckTalk's code (its prompts, run budgets
and requestId chains), while A2/A3 re-home onto *different* upstream paths. So DeckTalk's
acceptance informs the **behaviour contract**: review gates, refusal and missing-key handling,
edge cases and output quality on real briefs. The re-homed upstream path must pass **its own**
acceptance before A2/A3 close.

## Alternatives weighed

- **Port all of scope B as is.** Rejected: G12 and G13 would duplicate the upstream rewrite and
  image paths, with a second budget system.
- **Defer assists to after release 1.** Rejected by the user, who put assists in release 1.

## RFC verdict

**Host extension, no RFC.** All assists produce FilmSpec v1 (host-local) and Media assets.

## Open questions

1. Chart data sources beyond manual entry (CSV upload, analytics datasets): which are in release 1.
2. Whether the scene library is per workspace or per client org (ADR 0944 memory scoping
   suggests per client org).

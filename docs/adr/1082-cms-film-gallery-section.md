# ADR 1082 — The `films` section: a gallery of N films with filter chips

Status: Accepted (2026-11-10, 1a, on the request David approved through DeckTalk:
"anything that the current CMS cannot support, request openwop-app to implement
upstream"). Implemented in the PR that records it.

Host CMS rendering only. No wire change, so no RFC.

## Context

DeckTalk (dev-c5) needs a page that shows many short films, each tagged by use
case and by shape (16:9, 9:16, 1:1), and lets a visitor narrow them. What the CMS
has today:

- `video` (ADR 0843) plays ONE film, plus an optional second (`film2`, ADR 1032).
  It is click-to-play with the poster first, https-only, and plain text, and it
  emits one VideoObject.
- The columns `tiles` layout (ADR 1064 P3b) filters cards by `badge` with
  aria-pressed chips, but its cards hold no film.

Neither holds N films, so DeckTalk would need a page of separate `video` sections
with no way to filter them.

## Decision

### D1. A new section type, `films`, in the ADR 1080 design-section module

```
films: {
  eyebrow?, heading?, lede?,          // the shared section head
  filter?: 'useCase' | 'shape',       // absent = no chips
  films: [{                           // 1–24 on the base layer
    src, poster, captions?,           // https only (the `video` rule)
    title, description, length,       // required, plain text; length m:ss
    uploadDate?,                      // the `video` rule
    useCase?,                         // ≤ 40 chars, a filter facet ("Onboarding")
    shape?: '16:9' | '9:16' | '1:1',  // the poster frame's aspect; default 16:9
  }]
}
```

- **Validation.** Each film is held to exactly the `video` rules:
  `httpsMediaUrl` for every URL, `VIDEO_LENGTH_RE` for `length`, and the shared
  upload-date check. `cmsService` injects them into `buildDesignSectionData`, the
  same way that module already takes the caller's `safeLink`. So there is ONE
  https-only rule and no import cycle.
- **Overlays.** A locale overlay (`partial`) keeps only the translatable text it
  carries. A bad URL in an overlay is dropped rather than failing it, as for
  `video`.
- **Rendering.** The SPA renders each film with the existing `SectionFilm` /
  `FilmPlayer` (click-to-play, nothing loads until asked, captions track) inside a
  card whose frame takes the film's `shape`. The renderer lives beside
  `VideoSection` in `SectionRenderer.tsx`, because the player lives there:
  `DesignSections.tsx` importing it back would cycle.
- **Filter chips.** With `filter`, a chip row (an "All" chip plus each distinct
  value, in first-seen order) narrows the grid. This is the `tiles` interaction
  (ADR 1064 P3b): aria-pressed toggle buttons in a named group, a live count, and
  hidden cards, not removed ones. With fewer than two distinct values there are no
  chips.
- **Crawlers.** The prerender lists each film as a figure (poster, title, length,
  description) with a link to the file. `jsonLdBlocks` emits one VideoObject per
  film from the same validated data (`videoObject`, unchanged), so a film missing
  a required field emits nothing. Markdown lists the films.
- **Editing.** The section edits as JSON, like every ADR 1080 design section.

### Alternatives

- **`video.films[]`.** Rejected. `video` requires its first film at the top level
  (`src`, `title`, …) and is wired through `film2`. An array beside that would
  give one section two shapes for "a film", and every reader (renderer, prerender,
  JSON-LD, overlay) would need both.
- **A columns layout with a film per card.** Rejected. `columns` validates
  columns, not films, so the https/length/caption rules would be copied into a
  second validator.

## Implementation

| What | Where |
|---|---|
| `films` type, validator (injected media rules), HTML, markdown | `features/cms/designSections.ts`, `cmsService.ts` (one call-site line + the exported helpers) |
| VideoObject per film | `features/publishing/prerenderService.ts` `jsonLdBlocks` |
| Renderer + filter chips | `frontend/.../cms/SectionRenderer.tsx`, `DesignSections.tsx` (type list), `global.css` |
| Editor (JSON) + section label ×4 | `SectionsEditor.tsx`, `cms/i18n/*` |

Tests: `test/adr1082-films-section.test.ts` (validator, prerender, JSON-LD) and
`frontend/react/src/features/cms/__tests__/filmsSection.test.tsx` (render, chips),
both sabotage-witnessed (see the PR).

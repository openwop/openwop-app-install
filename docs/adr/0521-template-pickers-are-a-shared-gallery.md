# ADR 0521 — "Start from a template" is one shared gallery, not an inline strip

Status: implemented

**Date:** 2026-08-03
**Depends on:** ADR 0510 (design system — `<Button>`, the `ui/` cohesion layer),
ADR 0516 (form templates ship as a pack), ADR 0347 5a (canvas-content packs),
ADR 0519 / 0519 (the collection-canon sweep this surfaced during).
**RFC gate:** host UI only — **no RFC**. No wire, endpoint, or capability change.

## Context

Forms rendered its template catalog as an inline strip beside the create field:

```
NEW FORM  [ e.g. Contact us ] [ + New form ]   Or start from a template
                                               [Contact us] [Event RSVP]
                                               [Job application] [Product feedback]
```

Four chips fit. **Template catalogs are pack-sourced** (ADR 0516) — an operator
or a third party ships their own — so the count is not ours to assume. At forty
the strip wraps into a wall with nothing to search, nothing to filter, and no
room to say what any template actually contains. It also left a FAILED catalog
read nowhere honest to go: the strip's failure state was a muted sentence
squeezed into a toolbar.

Three other surfaces already had template pickers, each built separately:
`canvas/TemplateGallery` (a modal grid with live previews, no search),
`documents/NewDocumentModal`'s template step (a `card-grid`, no search), and the
builder's workflow-chain gallery (a full page, which is fine — see below).

## Decision: a dialog, and one component

**A template picker is a `<TemplateGalleryDialog>`** — the shared
`ui/TemplateGallery`.

### Why a dialog rather than a page

Picking a template is a **self-contained detour inside a creation flow**: you are
on the surface you are creating into, you pick, and you come straight back. That
is the case overlays exist for — they preserve the context you are creating in,
where a full page makes you navigate away and back for a five-second decision.
The [Smashing decision tree][smashing] puts a "single, self-contained task the
user jumps into and returns from" on the modal side, and reserves separate pages
for multi-step work needing the user's full attention. Notion, Figma, and Canva
all ship an overlay gallery for exactly this job.

**A full page is right only when the browsing IS the task.** The builder's
workflow-chain gallery is that — you go there to survey what exists — so it stays
a page. That distinction is now written into the rule, so the next person does
not have to re-derive it.

### Why the component is split in two

`documents/NewDocumentModal` reaches its picker as a **step inside a modal it is
already showing**, and a modal inside a modal is never the answer. So:

- **`TemplateGalleryDialog`** = Modal + body. The default.
- **`TemplateGalleryBody`** = the body alone, for an in-modal step.

### What the gallery owns, and what a feature supplies

The gallery owns search, the category facet (both gated on the *unfiltered*
total, per §4.5 rule 13), the card grid, the live result count, the `Use
template` CTA, and the loading / failed / empty / no-match states. A feature
supplies `items` + `onUse` + its own empty-state copy. `renderPreview` is the one
escape hatch — canvas previews each template through the type's real Renderer,
and keeps that without forking the component.

## Alternatives weighed

- **Keep the strip, cap it at N + "see all".** Two code paths for one job, and
  the cap is a guess about a catalog we do not own.
- **A `<select>` of template names.** Cheapest, and the worst: a template is
  chosen on what it *contains*, which an option label cannot carry.
- **A full page per feature (`/forms/templates`).** Loses the creation context
  and needs its own route, back-link, and empty states per feature — for a
  decision measured in seconds.
- **A side drawer.** Reasonable, and the sources note drawers keep background
  data reachable. Rejected here because the background data is a list of things
  you have *already made*, which is not what you consult while choosing a
  template — and the app's one overlay primitive is `ui/Modal`, so a drawer
  would have meant a second primitive for a weaker fit.

## Trade-offs accepted

- **One more click to reach templates.** The strip put four one click away; the
  gallery puts all of them two clicks away, with search. Correct at forty,
  marginally worse at four — and the four-template case is the one that is not
  ours to design for.
- **The CTA wording is now uniform** ("Use template"), so `canvas`'s shorter
  "Use" label is gone. Its `labels.use` prop was REMOVED rather than left to be
  silently ignored — a prop that does nothing is a lie in the API.
- **The canvas gallery's grid is now 880px max**, up from 760px, since it shares
  the generic box. Its per-template preview metrics are unchanged.

## Implementation record

| Phase | What | Where |
| --- | --- | --- |
| 1 | The shared component (Dialog + Body) | `ui/TemplateGallery.tsx` (new) |
| 2 | Generic gallery CSS; `.cv-tpl-gallery*` DELETED (not aliased — a second class family is a second source of truth) | `styles/global.css` |
| 3 | Shared `common` copy ×4 locales | `i18n/locales/*/common.ts` |
| 4 | Forms: strip → one affordance + Dialog | `features/forms/FormsPage.tsx` |
| 5 | Canvas: bespoke modal → thin adapter over the shared Dialog, keeping its Renderer preview | `canvas/TemplateGallery.tsx` |
| 6 | Documents: template step → shared Body (gains search + a kind facet) | `features/documents/NewDocumentModal.tsx` |
| 7 | Dead `canvas:templateUse` key dropped ×4 locales; canvas test updated to the shared accessible name | `canvas/i18n/*`, `canvas/__tests__/` |
| 8 | The rule | `DESIGN.md` §4.5 rule 14 |

Gates: `npm run build` green, `npm run lint` clean, canvas 336/336, forms +
documents suites green.

## Open questions

1. **Preview for non-canvas templates.** `renderPreview` exists but only canvas
   uses it. A form template could render a miniature of its fields; worth doing
   when someone has a second reason to touch that code, not before.
2. **The builder's chain gallery** stays a page by the rule above, but its cards
   are a fourth card shape (`workflow-template-card`). Not folded in here —
   that is a card-chrome question, not a picker-placement one.

[smashing]: https://www.smashingmagazine.com/2026/03/modal-separate-page-ux-decision-tree/

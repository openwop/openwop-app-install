# ADR 1150 — CMS: a split layout, linked gallery tiles and a video hero

Status: Accepted (2026-11-18). Implemented in the PR that carries this ADR.

Presentation-only additions to the public CMS renderer and its validator. No
wire change, no new route, no new permission: section data is already
member-authored through the existing CMS routes and agent tools, so no RFC.

## Context

A white-label adopter (a residential design firm) needed three page shapes the
stock section set did not have, and proposed a patch. Upstream takes them
because each is generic, but not as proposed: the patch styled them only in the
adopter's own brand stylesheet, so every other deployment would have rendered an
unstyled list and a full-size raw `<video>`, and its looping film had no way to
stop it.

## Decision

| # | Decision |
|---|---|
| D1 | A `split` column layout: each item is a row with its picture beside its text, sides alternating down the section, stacked on a phone. Each row may carry a link through the item's existing `ctaLabel` and `ctaUrl` (shown only when both are set). The validator already keeps every item field it needs, so the change is one name in `COLUMN_LAYOUTS` and its renderer branch, editor option and four-locale label. |
| D2 | A `gallery` tile with an `href` renders as a link around its picture (`.fp-gallery__link`). The link is checked twice: at save by `safeLink` (relative paths, fragments, http(s) and mailto; `javascript:` in any case, `data:`, `vbscript:` and protocol-relative are dropped), and again at render (`tileHref`), so a stored or mirrored section that bypassed the validator still renders no unsafe link. |
| D3 | A `video` hero visual: a full-width, muted, looping background film above the copy, with an optional poster. `videoSrc` and `posterSrc` must be paths on the site's own origin (`/media/reel.mp4`); every other origin, https included, is a 400 naming `hero.videoSrc` / `hero.posterSrc`, and the renderer refuses an off-origin src again. A film autoplays on every visit, so a URL from page content would send each visitor to a host the operator never chose. Media-library tokens are deferred: `/assets/:token` serves no Range, which iOS Safari needs to play video (the podcasts precedent). Kept only when `visual` is `video`; always the band placement. The film is decorative (`aria-hidden`) and muted, so it carries a visible Pause / Play button (WCAG 2.2.2). It does not start on its own under reduced motion (the OS setting or the in-app override); the poster shows until the visitor presses Play. A refused autoplay leaves the button on Play. The editor gets the option and both path fields. |
| D4 | Default styles ship upstream in `features/cms/designSections.css`, tokens only, so every deployment gets a working layout; a brand stylesheet may still restyle them. |

## Alternatives

- **Adopter-only styles (the original patch).** Rejected: an upstream layout
  that only one brand can render is a broken option in every other site's
  editor.
- **Reuse `dives` for split rows.** Rejected: `dives` draws built-in
  illustrations from an icon slug, not the author's photo, and its row links
  would change the meaning of an existing layout.
- **Any https URL (the original patch, and how the `video` section works).**
  Rejected for an autoplaying film: it loads on every visit with no click.
- **A media-library video token.** Deferred, not rejected: the library accepts
  MP4 and WebM, but `/assets/:token` serves no Range, so the film would not play
  on iOS Safari. Add it when that route serves Range.
- **An operator-configured allowlist of media origins.** Deferred until an
  adopter needs a CDN; the same-origin rule covers the first one.

## Consequences

- A film must be served from the site's own origin, for example a static file in
  the deployment's hosting. The SPA's `media-src 'self'` then admits it with no
  CSP change.

## Implementation record

| Phase | What | Witness |
|---|---|---|
| D1–D4 | `cmsService.ts` (`split`, `video`, `heroVideoFields`), `SectionRenderer.tsx` (`split` rows, linked tiles, `HeroVideo`), `SectionsEditor.tsx`, `sectionStyles.tsx` mirror, `designSections.css`, four-locale `cms` and `site` labels | `backend/typescript/test/adr1150-split-video-linked-tiles.test.ts`, `frontend/react/src/features/cms/__tests__/splitAndLinkedTiles.test.tsx`, `adr1029-mirror-parity` (both lists and the editor's layout options) |

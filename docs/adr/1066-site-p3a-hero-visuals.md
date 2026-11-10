# ADR 1066 — Site design batch Phase 3a: hero picture placement and body

Status: Accepted (2026-11-07). D1 and D2 are implemented in the PR that records them.

Follows [ADR 1064](1064-site-p3-per-page-visuals.md). This is Phase 3a of
myndhyve-1e's myndhyve.ai design batch (222 gaps; David approved the work).
Phase 2, the shared site defaults, landed in #5654. Phase 3 is the components,
owned by f2 and split into small PRs. It is host CMS rendering only, so no wire
RFC is involved.

## Context

The gap analysis compared the redesign with the live myndhyve.ai pages. Three
heroes put their picture **under** the copy, the full width of the shell:

- **compare:** the versus picture, two equal panes with a "vs" disc between
  (CMP-01);
- **roadmap:** the tally (RDM-01);
- **features:** the flow, as one row of numbered steps on the band itself
  (FEAT-01).

**Pricing** has a second, quieter paragraph under the lede (PRC-02).

What the live renderer did:

- **Versus and tally already stack under the copy** in openwop-app
  (`.fp-hero--versus .fp-hero__grid { grid-template-columns: minmax(0, 1fr) }`).
  On myndhyve.ai they sat beside it because the MyndHyve brand stylesheet's
  generic `.public-shell .fp-hero__grid { 1.05fr .95fr }` has the same
  specificity and loads later. A brand's layout rule silently undid a layout
  the visual depends on.
- **A flow hero could only be a card beside the copy.**
- **A hero had one paragraph.**

## Decision

### D1. `placement: 'below'` on a flow or illustrated hero

- **Field:** a closed enum with one stored value, `below`. Absent means beside
  the copy, so a hero that sets none is byte-identical. It is presentation, so
  the editor shows it on the base layer only, like `tone`.
- **Markup:** the section gains `fp-hero--below`.
- **Grid rule:** the under-the-copy rule is written `.fp-hero.fp-hero--below
  .fp-hero__grid`, one class more specific than a plain hero-grid rule, so a
  brand stylesheet's generic two-column grid cannot pull the picture back beside
  the copy. The two visuals built to sit under the copy, versus and tally, get
  the same two-class rule.
- **Flow:** placed below, the steps run in one row (the columns `flow` row,
  `fp-flow--row`) on the band itself (`fp-flow--open`: no card).

### D2. `body`: a second hero paragraph

- **Content:** cleaned and capped like the subheading (5000).
- **Rendering:** under the lede, 16px muted (`fp-hero__body`).
- **Where it reaches:** the crawler prerender, the markdown export, the share
  export and the reading-time count (`PROSE_KEYS`).

## Alternatives

- **Fix only the brand stylesheet.** Rejected as the whole fix: the next brand
  rule would undo it again. The two-class rule makes the layout a property of
  the visual. The MyndHyve lines are still listed in the PR for the Codex sync,
  because they also colour the tally.
- **A separate columns section under the hero.** This is the stopgap the gap
  analysis named for FEAT-01. Rejected: it breaks the band, and the circle
  numbers differ.

## Deferred / decisions for David

- **AGEN-01:** with reduced motion, the agencies apps picture shows all three
  client cards stacked. That is ADR 1060's deliberate still state ("still,
  they stack"). The design source shows no card at all under reduced motion,
  which is a bug in the design source. Showing only the first card would hide
  content from readers who turned motion off. Left as is unless David decides
  otherwise.

  > **DECIDED 2026-11-07 (David): keep all three, compact the still layout.**
  > Still (reduced motion, motion off, or outside a hero), two or three cards
  > now fan: the first in front, in full, and each later card behind it,
  > raised one bar height (`--space-6` + `--space-3`) so its mark, name and
  > address show above. The stack reserves that room, so the picture is about
  > one card tall plus a bar per extra client, not three cards. Every card
  > stays in the DOM as text. The motion path resets the fan, so the
  > cross-fade is unchanged. This corrects ADR 1060's "still, they stack,
  > every one in full" for the looping case. CSS only, no field. Test:
  > `frontend/react/src/features/cms/__tests__/appsStillAgen01.test.ts`.
  >
  > > **CORRECTED 2026-11-08 (browser check after deploy 419d):** two defects
  > > the stylesheet test could not see. (1) A 44px raise (`--space-6` +
  > > `--space-3`) clipped the back cards' names at the bottom; the raise is now
  > > `--space-6` + `--space-4` (48px). (2) From 900px the chip (absolute,
  > > z-index 2) sat under the front card, which the fan gives z-index `--n`;
  > > in the fan it now takes `--n + 1`. Both are pinned in the same test.
- **Phase 3a2:** the checklist card (HOME-05), the log terminal (CONTACT-02/03)
  and the campaign fan-out (CS-01) follow in the next PR.

## Implementation

| Phase | What | Where |
|---|---|---|
| D1 | `placement` enum; `fp-hero--below`; flow row/open; two-class grid rule; editor select | `cmsService.ts`, `SectionRenderer.tsx`, `sectionStyles.tsx`, `global.css`, `SectionsEditor.tsx`, i18n ×4 |
| D2 | `body` validator, renderer, prerender, markdown, share export, reading time | `cmsService.ts`, `SectionRenderer.tsx`, `sectionHtml.ts`, `sectionMarkdown.ts`, `sharingService.ts`, `publishingService.ts` |

Tests:
- `test/adr1066-hero-placement-body.test.ts`
- `frontend/react/src/features/cms/__tests__/heroPlacementBody.test.tsx`

Both are sabotage-witnessed. Five probes, all red:
- body dropped in the validator;
- the placement enum widened;
- body dropped from `PROSE_KEYS`;
- the grid selector lowered to one class;
- the flow row class dropped.

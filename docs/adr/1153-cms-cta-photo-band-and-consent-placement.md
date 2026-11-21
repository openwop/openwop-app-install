# ADR 1153 — CMS: a photo band on `cta`, picture-only marquee cards, and the consent control's placement

Status: implemented (2026-11-20). Implemented in the PR that carries this ADR.

Issues openwop/openwop-app#6150 and #6155, from a white-label adopter
(CasaVoga). Presentation additions to the public CMS renderer and its
validator, plus two build-time brand options and one exported component for
the ADR 0860 visitor-consent control. No wire change, no new route, no new
permission: section data is already member-authored through the existing CMS
routes and agent tools, and the consent lane is unchanged. No RFC.

## Context

The adopter's homepage design has a call to action over a full-width photo and
the same band with a short status list beside the copy. It built both locally as
an edit to the stock `cta` type and asked upstream to own the shape (#6150). The
same issue asked for picture-only cards in the `marquee` strip, and for the
consent banner to stop growing the page: while the banner shows,
`VisitorConsentBanner` pads `<body>` by its height, and on a site whose footer is
a dark band that padding reads as a blank strip under the footer. #6155 asked to
see and change the analytics choice on the privacy page, to let the footer
control link there instead of reopening the banner, and to place the control
inside the grouped footer's bottom bar rather than on its own line below it.

## Decision

| # | Decision |
|---|---|
| D1 | `cta` gains two optional fields. `imageToken` with a required `alt` (a 400, `cta.alt is required when it has an imageToken`, the same rule as every other picture) is a photo behind the band. `queue` is the hero's queue card (ADR 1080 D7): the same closed shape, validator (`cleanHeroQueue`) and renderer (`HeroQueue`). Unset, a `cta` saves and renders exactly as before. Markup when set: `fp-cta--photo` on the section and `<img class="fp-cta__photo">` as its first child; `fp-cta--queue` on the section and the `fp-queue` figure after `fp-cta__actions` inside `fp-cta__inner`. The no-JavaScript page carries the queue as the hero's `<figure>` list (`heroQueueHtml`) and the photo as a lazy `<img alt>`; the markdown export and the static share carry the queue's title and one line per row (`heroQueueMarkdown`), and the share the photo's alt text. `collectMediaTokens` already reads a top-level `imageToken`, so the media "used by" graph needs no change. |
| D2 | Stock styles (`global.css`, tokens only): the photo band takes the inverse (dark-ground) tokens in both themes, with a shade of the inverse ground over the photo so the copy holds its contrast whatever the photo; with a queue, the copy and button in one column and the card in the other from 900 px, stacked below that. A brand may restyle both classes. |
| D3 | The editor's `cta` case gets the photo picker and its alt field. The queue card has no form, as on the hero; the editor patches by key, so a queue authored by an agent or the API survives other edits. |
| D4 | A `marquee` card is drawn when the item has a title, text, or a picture with its alt text. A picture-only card is named by its alt text. |
| D5 | `VITE_BRAND_CONSENT_CLEARANCE=off`: while the banner shows, `<body>` gets no padding, so the document height does not change and the banner lies over the foot of the page until it is closed. `scroll-padding-bottom` still tracks the banner, so a focused control is never hidden behind it (WCAG 2.2 SC 2.4.11). Unset, the ADR 0860 padding stays: it is the stock behaviour, because it lets the end of the page scroll clear of the banner. |
| D6 | `VisitorConsentChoices` (exported from `features/site/`) is the analytics choice as a page section: the current setting (on, off, or not yet chosen), the banner's equal-weight buttons calling `recordChoice`, the separate unticked recording choice where the site offers it (ADR 0951 D1), the same announcement and error. It renders only where the lane answers or a choice is stored. The built-in `/privacy` page renders it in both its arms; an adopter page renders it itself. Its id is `privacy-choices`. |
| D7 | `VITE_BRAND_CONSENT_FOOTER=link`: the footer control is a plain link to `/privacy#privacy-choices` instead of a button that reopens the banner. The first-visit banner still asks wherever the regime requires. It applies only while the privacy link is the built-in `/privacy` page, the one page known to render D6; with any other privacy page (a CMS page through `VITE_BRAND_PRIVACY_URL`, the site runtime's workspace page) the control stays the button, so withdrawing is never a link to a page that cannot change the choice (GDPR Art. 7(3)). |
| D8 | In the grouped footer (ADR 1049 / 1056) the control's container is an `li` of the bottom bar's utility links (`.app-footer__utility`), else a `div` in `.app-footer__bottom` when the bar has none, in the utility links' style. The plain footer keeps the old container at the end of the footer. `PublicShell` is unchanged: the lazy banner chunk still creates and removes its own container. |
| D9 | Both options are build variables like `VITE_BRAND_PRIVACY_URL`: listed in `BRAND_ENV_KEYS` (BRAND-01), forwarded by the compose pack, documented in `.env.production.example` and `WHITE-LABEL.md`. Anything but `off` / `link` keeps the stock behaviour. |

## Alternatives

- **A separate `photoBand` section type.** The adopter offered to move to one.
  Rejected: the band is a heading, a line, one button and a photo, which is a
  `cta`; a second type would duplicate its validator, renderers, editor and
  drift fixtures for two optional fields.
- **Clearance inside the footer (padding on `.app-footer`).** Proposed in #6150.
  Rejected by the adopter's owner: the page still grows by the banner's height,
  and the requirement is that it does not grow at all. So the stock padding stays
  and a brand option removes it.
- **Zero growth as the stock behaviour.** Rejected: ADR 0860 pads the page so the
  end of every page can scroll clear of a pinned banner; a site that does not
  want that opts out.
- **A CMS `privacyChoices` section** so a CMS policy page can render D6. Deferred:
  a new section type changes the agent-facing section catalog and its parity
  pins, and no adopter needs it yet. D7's built-in-page condition keeps the link
  option safe until it exists.

## Implementation record

| Part | Where | Test |
|---|---|---|
| D1 validator, prerender, markdown, share | `cmsService.ts`, `sectionHtml.ts`, `sectionMarkdown.ts`, `sharingService.ts`, `designSections.ts` | `backend/typescript/test/cms-cta-photo-queue.test.ts` |
| D1/D4 renderer | `SectionRenderer.tsx` | `frontend/react/src/features/cms/__tests__/ctaPhotoBand.test.tsx` |
| D5–D8 | `VisitorConsentBanner.tsx`, `VisitorConsentChoices.tsx`, `brand/consentOptions.ts`, `PrivacyPage.tsx` | `frontend/react/src/features/site/__tests__/consentPlacementAndChoices.test.tsx` |
| D9 | `brand/defaults.ts`, `deploy/compose/*`, `.env.production.example`, `WHITE-LABEL.md` | `brandEnvHandoff.test.ts` (BRAND-01) |

Each new test was sabotage-witnessed: removing the photo, the queue (validator,
prerender, markdown or renderer), the marquee picture filter, the clearance
condition, the bottom-bar placement, the built-in-page condition, the
not-chosen state or the unticked recording box turns a named case red.

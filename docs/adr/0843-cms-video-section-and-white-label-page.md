# ADR 0843 — CMS video section and the white-label page

Status: implemented (`feat/cms-video-white-label`)

Extends ADR 0009 (CMS), ADR 0027 (public site + section renderer), ADR 0064
(localization overlays), ADR 0384 (crawler prerender + JSON-LD), ADR 0762 (the
home hero film) and ADR 0824 (system-site SEO). No new toggle: `cms` is
always-on and the page is an ordinary seeded marketing page.

## Context

openwop.dev now publishes two narrated films about running the reference app
under your own name (the companies film and the install film, both on the
OpenWOP YouTube channel). app.openwop.dev should carry them on a page of its
own, `/p/white-label`.

The CMS cannot say "a film" today. The only video in the app is the home hero's
hard-wired `visual: 'film'` (`HeroFilm` in `SectionRenderer.tsx`): one
code-pinned film, demo-gated, with its copy in the `site` i18n namespace. There
is no `video` entry in `SectionType`, so a page author cannot place a film, and
a crawler sees nothing of one.

## Decision

**D1 — a reusable `video` section type, end to end.** `SectionType` (backend
and SPA) gains `video`. Its data:

| Field | Required | Rule |
|---|---|---|
| `src` | yes | https URL to the video file |
| `poster` | yes | https URL to the poster image |
| `title` | yes | plain text, ≤ 160 |
| `description` | yes | plain text, ≤ 1000; screen-reader description + VideoObject description |
| `length` | yes | `m:ss` (minutes up to three digits) |
| `captions` | no | https URL to an English WebVTT file |
| `youtubeUrl` | no | https URL on `youtube.com` / `www.` / `m.` / `youtu.be` |
| `uploadDate` | no | `YYYY-MM-DD` |
| `eyebrow`, `heading`, `lede` | no | the shared section-head fields |

URL validation (`httpsMediaUrl` in `cmsService.ts`) builds on the shared
`safeUrl` scheme screen, then parses: https only (never http, protocol-relative,
`data:`, `javascript:` or a relative path), no credentials, and an over-long URL
is **rejected**, not truncated (a truncated URL is a different URL). On the base
layer a bad value is a 400 naming the field. On a partial overlay — a stored
localization or an AI translation's output, both through the same builder — a
bad URL is **dropped** instead, so a model echoing a mangled URL cannot fail the
whole overlay; the translate path already logs dropped keys. Text fields
localize through the existing ADR 0064 overlay with no new code.

**D2 — one film player.** `HeroFilm`'s behaviour is extracted into
`FilmPlayer`, and both the hero and the section render through it: click to
play, `preload="none"`, poster, a play button over the poster showing the
length, an English captions `<track>` read with `crossOrigin="anonymous"`, and
native controls only after the film starts. The section's visible caption is
the title (plus a "Watch on YouTube" link when authored); the long description
is a visually hidden element wired as `aria-describedby`. The section reuses
the `.fp-film*` classes; the only new CSS is `.fp-film__title` and the caption
link colour, both on existing tokens. URLs are re-checked at render (the ADR
0836 D7 exit rule): a non-https source renders no player.

**D3 — the crawler sees the film.** `sectionHtml` renders a `<figure>` with the
poster `<img>`, the title, the description and followable links to the file,
YouTube and the captions file. `jsonLdBlocks` emits one schema.org
`VideoObject` per video section (name, description, thumbnailUrl, contentUrl,
duration as ISO 8601 `PT#M#S`, uploadDate when authored; with a `youtubeUrl`,
`url` is the watch page and `embedUrl` its `/embed/` player). A section missing
a required VideoObject field emits nothing. `sectionMarkdown` and the shared
viewer's markdown render title, length, description and links.

**D4 — the white-label page, demo-gated.** `marketingContentPages.ts` seeds
`/p/white-label` (hero, two films, two card rows, a CTA) and bumps
`SEED_VERSION` to 6; `systemSiteSeo.ts` gives it a title and description. The
public menu needs no edit: it lists every published page (ADR 0486).
The hero sets `visual: 'none'`: the default workflow vignette is captioned
"Open standard" (`site:heroVignetteOpen`), a gated claim this page must not
make (pinned in `marketing-white-label-page.test.ts`). That caption still
shows on every other page using the default hero art; it is out of scope here
and left as an open question.

The films are openwop.dev-hosted showcase media, so the page follows the hero
film's ADR 0196 Gate A rule: it is seeded **only when `OPENWOP_DEMO_MODE=true`**.
A clean or white-label install never gets a page that loads media from
openwop.dev, or that advertises re-skinning OpenWOP on someone else's brand.

**D5 — CSP is not widened.** The shipped policy already allows `media-src` and
`img-src` from `https://openwop.dev` (the hero film), which covers the video,
poster and captions track. An operator who hosts films elsewhere adds their own
origin; `frontend/react/WHITE-LABEL.md` says how, and says never to widen it
to `https:`.

### Copy rules

None of the gated claims (`industry standard`, `independently validated`,
`best-in-class`, unqualified `fully conformant`, `open standard`,
`vendor-neutral standard`). `test/marketing-white-label-page.test.ts` now
applies that check, and a lossless-validation check, to **every** built-in
marketing page, not only this one.

> **Correction to ADR 0824 § Copy rules.** ADR 0824 says "the protocol is open
> source; this app is not, and no string here calls it so". This page's hero
> says the app is open source (Apache 2.0). The app ships under the Apache 2.0
> `LICENSE` in this repo, as a downloadable white-label bundle that includes the
> source, and openwop.dev's install and companies pages already describe it
> that way. The source **repository** is private, which is what the ADR 0824
> rule was guarding against implying. The page says "open source (Apache 2.0)"
> and never "public repository". The ADR 0824 SEO table keeps its own rule
> (`public-site-aeo.test.ts` still refuses "open-source app" in those heads),
> and this page's SEO copy does not use the phrase.

## Alternatives weighed

- **A second hard-wired film hero** for the page. Rejected: the next film would
  need a third, and a crawler would still see nothing.
- **A YouTube embed (`<iframe>`).** Rejected: it needs `frame-src` for YouTube
  in the CSP, loads third-party script and cookies before the visitor asks, and
  breaks the click-to-play, no-network-until-asked rule the hero film keeps.
- **Make `length`, `description` optional.** Rejected: the play button shows the
  length, and VideoObject requires a description. Making the author write them
  once is cheaper than a page that silently emits no structured data.
- **Seed the page on every install.** Rejected (D4): Gate A.

## Implementation record

| Area | Files |
|---|---|
| Validation | `backend/typescript/src/features/cms/cmsService.ts` |
| Crawler HTML / JSON-LD / markdown | `features/publishing/sectionHtml.ts`, `prerenderService.ts`, `sectionMarkdown.ts`, `features/sharing/sharingService.ts` |
| Seed + SEO | `host/marketingContentPages.ts`, `host/systemSiteSeo.ts` |
| SPA render + editor | `frontend/react/src/features/cms/SectionRenderer.tsx`, `SectionsEditor.tsx`, `SectionPicker.tsx`, `cmsClient.ts`, `i18n/{en,es,fr,pt-BR}.ts`, `styles/global.css` |
| Tests | `test/cms-video-section.test.ts`, `test/marketing-white-label-page.test.ts`, golden + coverage fixtures in `adr0384-section-html.test.ts` / `section-markdown.test.ts`, `marketing-content-pages.test.ts` (off-demo absence), `__tests__/videoSection.test.tsx` |
| Docs | `frontend/react/WHITE-LABEL.md` (media origin + CSP) |

## Addendum — navigation (2026-10-07)

`/p/white-label` is curated under **Menu → Product**, after Compare, instead of
the dynamic Pages group. It is curated only when the page is published, which
in practice means demo mode, so a white-label install never links to it. It
stays out of the header: Features and Pricing remain the only primary links.

## Open questions

- ~~The default hero vignette's "Open standard" caption~~ — resolved
  2026-10-07: it reads "Open protocol" (all four locales), the seeded launch
  post says "open protocol" (blog SEED_VERSION 2), and
  `public-site-aeo.test.ts` holds the site bundles and that post to the gated
  list.
- Captions are English only (`srclang="en"`). A per-locale captions track would
  need a language field per track; not needed for the current films.
- `uploadDate` is author-entered. If films ever come from the media library,
  derive it from the asset instead.

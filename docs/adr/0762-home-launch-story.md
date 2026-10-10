# ADR 0762 — home launch story: intro film, prompts, deep dives, evidence

Status: Accepted

## Context

The front page (ADR 0027; seed `host/systemSite.ts`, publishable twin
`docs/site/front-page-story.sections.json`, SPA fallback
`features/site/FrontPage.tsx`) told a protocol argument: thesis → why the run
matters → the BPMN/SMTP history → five guarantees → the paper's two-host result
→ four steps → CTA. That is openwop.dev's job. app.openwop.dev is the product,
and its page read as a second copy of the spec site.

openwop.dev was reworked on 2026-09-27 (openwop-site #131, #132) around what a
launch page does: show the thing working, let the reader picture their own use,
demonstrate each capability rather than list it, and put evidence behind the
claims. It gained a 46-second silent intro film. This ADR applies the same
lessons to the app's front page.

## Decision

The story becomes: **hero + intro film → "What will you run first?" (six example
prompts) → four deep dives, each drawn (Build, Run, Decide, Replay) → the app's
own conformance evidence → why the run should be open (the old shift + history,
compressed) → CTA.** `SEED_VERSION` 7 → 8.

To express it, the CMS section model gains three closed values and one
optional field use. No new section type and no new field:

| Change | Where | Notes |
|---|---|---|
| hero `visual: 'film'` | `HERO_VISUALS` (backend), `resolveHeroVisual` (renderer), editor | Centred copy, the film full width beneath. |
| columns `layout: 'prompts'` | `COLUMN_LAYOUTS`, renderer, editor | `title` = short tag, `text` = the prompt (a `<q>`), `href` = where to type it. |
| columns `layout: 'dives'` | `COLUMN_LAYOUTS`, renderer, editor | The column's existing `icon` slug picks a built-in, aria-hidden illustration: `canvas`, `ledger`, `approval`, `fork`. An unknown slug draws nothing. |
| `stats` renders its section head | renderer | `eyebrow`/`heading`/`lede` were already accepted and silently not drawn; a bare stats band renders as before. |

### The film is demo-gated

The film is OpenWOP showcase media hosted by openwop.dev
(`/assets/video/openwop-intro.mp4`, source in openwop-site `video/`). Under ADR
0196 Gate A a white-label install must not load it, so `PublicSection` reads
`useDemoMode()` and renders `visual: 'film'` as `run` (the ledger) when not in
demo mode. The fail-safe direction is the hook's: `false` until resolved, so the
demo site may flash the ledger before the film, never the reverse elsewhere.
The SPA fallback authors `film` only when `demo`, and omits the evidence section
otherwise (those figures describe this deployment's signed bundle).

**The seed is not demo-gated**, as it wasn't before: an install that seeds the
system site gets `film` (rendered as the ledger off-demo) and the evidence
section. `docs/site/README.md` "Demo-only links" now names the evidence section
among what to remove on a white-label publish.

### CSP

`media-src` gains `https://openwop.dev` (already trusted for `img-src` and
`connect-src`). Without it the browser blocks the film. No captions track in the
app: a cross-origin `<track>` needs CORS headers openwop.dev does not send, and
the film is silent with on-screen text; the figcaption describes it.

> **CORRECTION 2026-09-27 — the film is now narrated, and has a captions
> track.** openwop-site #140 added a voice-over (ElevenLabs Eleven v3) and
> `Access-Control-Allow-Origin: *` on `/assets/video/**`. The video is now
> `crossOrigin="anonymous"` with an English `<track kind="captions">` read
> from openwop.dev. `media-src` already covered that origin. The play button
> is "Watch the video", and it fades out while the video plays and back in
> when it ends. The figcaption now says the film is narrated. `FILM`'s `?v=`
> moved to `2026-09-27-vo` with openwop.dev's.

### Click-to-play

`preload="none"`: nothing downloads until asked. A "Watch the film 0:46" button
sits over the poster's empty top-right corner; once pressed, the native controls
appear and focus moves to the video.

## Alternatives weighed

- **Copy the film into this repo.** Rejected: 1.2 MB of OpenWOP-branded media
  in every white-label build, and two copies to re-render. The `?v=` in
  `FILM.src` must track openwop.dev's instead (it serves `/assets/**` immutable).
- **A new `video` section type with author-set URLs.** More general, but it
  opens a media-URL field to CMS authors (CSP, SSRF-adjacent review) for one
  page's need. Deferred until a second use appears.
- **A `visual` field on columns** instead of reusing `icon`. `icon` is already
  an opaque, bounded slug the renderer interprets per layout; a second field
  would mean backend validation, editor UI and a migration for no gain.

## Honesty constraints kept

- Prompts are labelled as examples ("what you get depends on your model and the
  packs you turn on").
- The fork illustration says "Illustrative run."
- Evidence names its suite (2.42.2), that it is self-measured by the steward,
  and that no independent organization has measured a host yet. Figures are
  from the conformance leaderboard (openwop-workflow-engine: 296 pass / 0 fail /
  0 blocked; three certified profiles). They will age as the suite advances;
  refresh them with the seed.
- The seed still passes the gated-claim phrase check in
  `front-page-story-sections.test.ts`.

## Phases

| Phase | What | Status |
|---|---|---|
| 1 | Model values, renderer, editor, CSS, CSP, seed + twin + SPA fallback, tests | this change |
| 2 | Deploy; the seed refreshes the live page if it is still unedited (`updatedBy = system`), else publish the twin per `docs/site/README.md` | operator |

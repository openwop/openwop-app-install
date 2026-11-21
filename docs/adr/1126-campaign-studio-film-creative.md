# ADR 1126 — Campaign Studio film creative

Status: Proposed (2026-11-15). Planning only; no code. Umbrella for ADRs 1127–1131.

Plan source: `openwop-app-qa-state/decktalk-creative-upstream/plan-notes.md` (the split, the
upstream inventory, reviews by the DeckTalk and CasaVoga sessions, and two rounds of user
decisions). Source code being upstreamed: DeckTalk `8691c224`
(`packs/vendor.decktalk.nodes` 1.58.0, adopter `features/decktalk`).

## Context

DeckTalk, a white-label adopter, built a narrated-film pipeline on top of this app: story →
narration → verified voice takes → render, with per-channel cut-downs, hook/title alternatives,
captions and series, plus creative assists (brand themes, reusable scenes, charts/tables/flows,
copy rewrite, image generation and derivatives). Almost all of its mechanism is generic. The
first adopter that needs it in a release is CasaVoga, whose marketers want a short narrated film
per persona from an approved Campaign Studio brief.

### Boundaries audit (origin/main `bff8b2dfd`)

| Existing capability | Where | What it does today | Verdict |
|---|---|---|---|
| `films` (ADR 1075) | `contracts/films.ts`, `features/films/feature.ts:10-12` | `canvas.film`: manual cues, HTML presenter + notes-free audience view. No narration, video file, captions, aspect ratio or AI. Toggle OFF. Not wired into Campaign Studio. | **EXTEND**: storyboard and timeline source of truth |
| `creative-video` (ADR 0404, 1051) | `features/creative-video/*` | HeyGen avatar + Runway t2v/i2v, metered, stored as Media assets. OFF; no agent; not linked from Campaign Studio | **FOUNDATION**: avatar/clip scenes |
| Creative Briefs reel (ADR 0411 P3, 1039) | `features/creative-briefs/reelWorkflow.ts`, chain `openwop-app.creative-briefs-reel` | one unnarrated t2v clip, 9:16/16:9/1:1 | **RETIRE after this ships** (user decision) |
| Ad layout renderer + variant factory (ADR 0399, 0946, 0947) | `features/creative-briefs/render/*` | resvg SVG→PNG/GIF, brand locks, safe zones, per-variant proofing | **FOUNDATION**: title/end cards, posters |
| Image generation (ADR 0115, 0401, 0229) | `providers/dispatchImages.ts`, `media/imageGenRoutes.ts` | real dispatch + daily image budget; derivatives are crop boxes only | **FOUNDATION** (ADR 1129) |
| Copy refine (ADR 1020) | `feature.campaign-channels.nodes.generate` `refineOp` | brand voice, claim grounding, approval gates | **FOUNDATION** for hooks and rewrites (ADR 1129) |
| TTS (ADR 0086) | `providers/dispatchSpeech.ts` | MiniMax T2A; podcasts concatenate bytes, no ffmpeg | **FOUNDATION** for narration (ADR 1128) |
| STT (ADR 0085) | `features/notebooks/transcribeWorkflow.ts` | transcribe-source; deliberately not chat-exposed | **EXTEND** for take verification + caption timing (ADR 1128) |
| Ads video publish | `feature.campaign-channels.nodes.publish-ad-variants` `mediaKind:'video'` | dry run only; live upload fails closed `video_dispatch_live_pending` | Deferred (scope C) |

Nothing upstream covers captions (no VTT/SRT anywhere), rendering a film to a video file,
video cut-downs, a film series, or charts in films. Campaign Studio has no video/film/creative
tab, and none of its nine agents has a film, video or image tool
(`vendor.openwop-app.campaign-studio.agents/pack.json`).

No route collision: `/host/openwop-app/film-creative/*` is unused (`grep -rn "film-creative"
backend/typescript/src` → none).

## Decision

### D1 — A new feature package `film-creative`, on top of `films`

`backend/typescript/src/features/film-creative/` and `frontend/react/src/features/film-creative/`,
appended to `BACKEND_FEATURES` / `FRONTEND_FEATURES`. It owns the *production* of a film from a
brief: the production record, its layers and its exports. `films` keeps owning the `canvas.film`
contract, persistence and the presenter. `film-creative` writes a `canvas.film` through the
existing canvas factory and never forks the contract.

- **Toggle:** `film-creative`, **ON by default** (user decision 2026-11-15), bucketUnit `tenant`,
  category `Marketing`, no variants.
- **`dependsOn: ['films', 'media', 'brand']`**, `recommends: ['campaign-brief', 'campaign-channels']`.
  *Correction (KickTodo review, 2026-11-15): an earlier draft hard-depended on `campaign-brief`. A
  film's source is now an abstraction (D2), and only the brief-sourced chain requires
  `campaign-brief`, declared through ADR 1134's chain `requiresFeatures`.*
  `films` is OFF by default today, so the dependency closure means an install where
  `film-creative` is enabled must also enable `films`. This ADR changes **`films`' default to ON**
  together with `film-creative`, rather than leaving a default-ON feature permanently blocked by a
  default-OFF dependency. An install that has explicitly turned `films` off keeps that override,
  and the admin panel shows `film-creative` as "requires Animated films". **Release note
  requirement:** the white-label "Upgrading from" block must state that this release turns on two
  features by default (Campaign Studio film creative and Animated films).
- **No silent half-on state** (CasaVoga review, 2026-11-15). CasaVoga's toggles were turned on one
  at a time, and a run then failed after a person had approved its drafts (Campaign Studio ledger
  CC-ORCH-2, CC-CHAN-3). So:
  1. **Run preflight:** `film.from-brief` and `film.series-episode` start with a typed preflight that
     refuses **before any provider call or gate** (`feature_required`, naming each disabled toggle)
     when `films`, `media` or `brand` is off for the tenant, or when the chain's own
     `requiresFeatures` are off (`campaign-brief` for `film.from-brief`). This is ADR 1134's run
     admission preflight, not a chain-local node.
  2. **Nodes test enablement:** nodes check that a feature is **enabled for the tenant**, never that
     `ctx.features[...]` merely exists. The host always provides the surface, and a disabled one
     throws `host_capability_disabled` on call.
  3. **Admin toggle:** turning `film-creative` on in the admin panel turns on its `dependsOn` closure
     (the rule bundle enable already follows), or is refused with the list of what must be on first.
     It never leaves the feature on with a dependency off.
- **Import boundary:** `film-creative` may import `films`' contract (`contracts/films.ts`) and call
  the services of `media`, `brand`, `campaign-brief`, `campaign-channels` and `creative-briefs`
  through their existing seams. Core never imports it.

### D2 — The production model

A **FilmProduction** (`DurableCollection`, tenant + org scoped) binds:
`{productionId, orgId, source: FilmSourceRef, briefId?, personaId?, seriesId?, episode?, locales[],
storyHash, status, layers, exports[], approvals[], createdBy, createdAt}`.

**Film sources are an abstraction** (KickTodo review). `FilmSourceRef = {kind, id, version, hash}`
names any stable, versioned, hashed approved text. The feature that owns the text registers a
resolver: `registerFilmSource(kind, {resolve(ref) → {text, hash, title?}})`. The resolver must
refuse a ref whose `hash` no longer matches.
- **Campaign Studio:** registers `campaign-brief.kernel` (brief kernel at a kernel version), plus
  approved persona copy.
- **Adopters:** register their own kinds in their repo. KickTodo registers a published challenge
  version's day activity: `{challengeId, version, contentHash, day}`.

This replaces the earlier `briefId + kernelVersion` binding. `briefId` stays as an optional field
for Campaign Studio's UX.

- `layers` is DeckTalk's versioned derivative manifest, renamed and made host-owned:
  `{story, narration, film, mix, formats, captions}`, each `{version, engine, spec, specHash,
  reference}`. Engine ids lose the `decktalk-` prefix (`film-timeline-v1`, `scene-composition-v1`,
  …). The `film` layer's `reference` is the `canvas.film` canvas id plus version.
- A **beat** replaces DeckTalk's deck slide as the unit of a film. The invariants DeckTalk's code
  assumes are kept as hard rules, validated on write:
  1. Each beat's `sourceQuote` is an exact substring of the text its `FilmSourceRef` resolves to
     (the brief kernel at its version, a KB passage, an adopter's published content). A per-persona
     film quotes the shared kernel or its own approved persona copy.
  2. Beat *i* ↔ narration clip *i*, one to one, everywhere (captions, alignment, reuse, durations).
  3. 1–12 beats, film ≤ 180 s, title ≤ 100 and body ≤ 240 characters, reading floor ≈ words / 3 s.
  4. Identity hashes the story (`storyHash`), so per-persona films are separate productions.
- **No KB and no brand** (CasaVoga today): under the brief's `best-effort` grounding mode, beats
  quote the kernel's own proof points. Only under `strict` grounding does a missing source fail
  typed (`film_source_required`).
- **Links** shown in a film or its post copy carry the brief's UTM schema.

### D3 — The pipeline as chain packs, never hard-coded

- Node pack **`feature.film-creative.nodes`**: generic ports of DeckTalk's story/outline,
  timing/pacing, shots/visuals, evidence, assembly (FilmSpec v1), formats, hooks and captions nodes.
  Narration nodes are ADR 1128, render nodes ADR 1127, assists ADR 1129, series ADR 1130.
- Chain pack **`core.openwop.workflows.film-creative`**: chain `film.from-brief` (brief + kernel
  + persona → story → narration → assemble → review gate → render per format → export), plus
  `film.series-episode` (ADR 1130). Both instantiate through `…/workflows/from-chain` and are
  builder-editable and `/`-runnable.
- The review gate is `core.chat.approvalGate` before anything is rendered for export. It works
  with **named-approver ACLs** (ADR 0899, CasaVoga's named-gate pattern). A sole-admin workspace
  follows ADR 1131.
- Every provider call is BYOK through the existing dispatchers. A missing key or a provider refusal
  is a **typed failure**, never an empty or placeholder creative. A run records each provider
  output and layer `specHash`, so replay and fork reuse recorded outputs (ADR 1128 clip reuse).

### D4 — Surfaces

- **Campaign Studio "Film" tab**: a frontend route with `hub: 'campaigns'`, projected into the hub
  by `visibleHubRoutes` (`CampaignStudioHubPage.tsx:35-39`). No new nav entry (CasaVoga's adopter
  seam cannot move the host Marketing group, CV-0186). Inner views use their **own** query param
  (`view`), never `tab` (the CC-HUB-1 defect).
- **Export without publish is a finished state:** download each format file, its poster/still,
  and its captions (VTT/SRT sidecar, plus burned-in captions as an option, ADR 1127).
- **Shared chat:** a **Film Director** agent added to `vendor.openwop-app.campaign-studio.agents`,
  tool-allowlisted to read the brief/kernel (read before write), start `film.from-brief`, read a
  production, and request alternatives. No tool that exports or publishes. The hub → chat handoff
  deep-links `/?agent=<film-director>&brief=<briefId>` so the agent opens with the brief.
- `ctx.features['film-creative']`: read-only `getProduction`, `listProductions`. Writes go through
  nodes so they stay on the run's replay record.

### D4b — Viewing, delivery and storage (KickTodo review)

- **Viewing:** an exported film is readable by any `workspace:read` member of its workspace. That
  covers adopters whose viewers are Viewers in a shared workspace.
- **Public delivery (opt-in, phase P8):** a production marked `published` can expose its poster,
  MP4 and caption files on a static path for signed-out visitors. It follows the publishing rules:
  published-only, tenant taken from the resource and never from the request, uniform 404, rate
  limits, and `PUBLIC_PATH_PREFIXES`. It reuses the publishing feature's static-delivery seam
  (ADR 0012) rather than a new public route family. Unpublishing removes the files.
- **Storage:** Media's per-org byte cap is a hard constant of 256 MiB (`perOrgBytes`,
  `media/mediaService.ts:232`). A batch catalog (KickTodo: ~177 day-films × 3 formats) exceeds it.
  The cap becomes operator-configurable (`OPENWOP_MEDIA_MAX_BYTES_PER_ORG`, default unchanged), and
  film exports count against it. Large public catalogs use the P8 static path, not Media serve URLs.

### D4c — Languages

English-only is **not** an invariant. That was one adopter's current state, not a design limit.
A production carries `locales[]`:
- **Narration per locale:** a voice per locale through ADR 1128. Each locale is its own narration
  layer and verification.
- **Or one narration with translated captions:** one narration, plus caption tracks keyed by
  locale.
- **Caption storage:** caption assets are keyed by locale (`captions.<locale>.vtt`/`.srt`).

Translation of beat text uses the existing i18n/translation path where one exists, and is always
reviewed. It is never auto-approved.

### D5 — RBAC and isolation

Reads require `workspace:read`; creating, regenerating and exporting require `workspace:write`.
Every route is `featureRoute` with `requireFeatureEnabled('film-creative')`, tenant + org IDOR
guarded, fail-closed. Exports are served through Media assets with the existing access checks; no
public link ships in this ADR.

### D6 — Retire the Creative Briefs reel (user decision)

After phase P4 ships, the `openwop-app.creative-briefs-reel` chain and `generate-reel` node are
deprecated. The Creative Briefs "Reel" entry point opens `film.from-brief` with a one-beat,
no-narration preset. Removal follows the ADR 0194 replay-safe tombstone path. Archived runs stay
replayable.

## Phases

| Phase | Scope | ADR |
|---|---|---|
| P0 | `film-creative` package, toggle (ON) + `films` default ON, FilmProduction store, REST read/create, Film tab shell | 1126 |
| P1 | Story/outline/pacing/evidence nodes + `film.from-brief` up to the review gate (no narration: captions-only draft) | 1126 |
| P2 | Narration, voice verification, clip reuse | 1128 |
| P3 | Render worker (Cloud Run job) + browser export, formats 16:9/9:16/1:1, posters, VTT/SRT + burned-in captions, render meter | 1127 |
| P4 | Export from the Film tab; Film Director agent + chat handoff; reel deprecation | 1126 |
| P5 | Creative assists, pure modules first | 1129 |
| P6 | Series | 1130 |
| P7 (later, not release 1) | Import a finished video (MP4 + captions) as a production for cut-downs and captions | 1126 |
| P8 (later, not release 1) | Opt-in public static delivery for published productions (D4b) | 1126 |

Release 1 = P0–P6 (user decision: film core + assists + series).

## Alternatives weighed

- **Port `vendor.decktalk.nodes` as a vendor pack.** Rejected: it would bring DeckTalk naming, its
  own budget and spend paths, and a second rewrite and image path. The pack imports no upstream
  code, so it would also bypass the dispatchers' BYOK and caps.
- **Extend `films` directly instead of a new package.** Rejected: `films` is the generic,
  provider-free canvas any adopter reuses. Production, spend and exports are a separate authority
  and need their own toggle.
- **Extend `creative-video`.** Rejected: it is a clip-generation service. A film is a composed,
  narrated, multi-scene production that may *use* its clips.

## Corrections to the plan

- The plan listed copy rewrite (DeckTalk G12) and image generation (G13) as ports. They are
  **re-homed** onto `campaign-channels` refine and `dispatchImages` instead (ADR 1129).
- The plan assumed existing caps covered all spend. They do not cover rendering, so ADR 1127 adds a
  render meter.
- The plan treated DeckTalk's renderer as slide-only. It is one frame-stepping core with two input
  paths; only the FilmSpec path comes upstream (ADR 1127).

## RFC verdict

**Host extension, no RFC.** FilmSpec stays host-local (`contracts/films.ts`, ADR 1075: "not an
OpenWOP wire change or a portable canvas claim"). All routes live under `/v1/host/openwop-app/*`.
FilmSpec v2 (per-cue easing, anchors, transitions) is deferred and would be a host-local contract
bump on evidence. An RFC is needed only if a portable `canvas.film` claim is ever wanted.

## Open questions

1. `films` default flip to ON: confirm it is acceptable for every install, not only adopters that
   use film creative. (Assumed yes, from the user's ON-by-default decision.)
2. 4:5 feed format: not in release 1 (CasaVoga tester call); add it with its fit rules later.
3. PDF/PPTX ingestion (DeckTalk DT-V59) as generic brief/KB intake: candidate for a later ADR.
4. Presenter video and footage editing: experimental in DeckTalk, not planned here.
5. Scope C, distributing an approved film as a draft post (DeckTalk DT-G65), is deferred. It will
   use `social-publishing` and the ads video upload, with publishing a separate authority.

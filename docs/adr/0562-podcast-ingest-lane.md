# ADR 0562 — Podcast ingest lane: published transcripts, chapters, and AI audio ingest

Status: Proposed
Date: 2026-08-14
Feature: podcasts (extends ADR 0086 generation + ADR 0390 distribution — toggle id stable, no new toggle)
Origin: UX_UPGRADE-podcasts round-2 deferrals PR2-2 (transcripts), PR2-7 (chapters), PR2-10 (AI ingest), queued explicitly as "the right build is an ingest/authoring lane (agent + node packs on the ONE chat, ADR 0058)".

## Context

Round 2 benchmarked the podcast feature against Buzzsprout, Transistor, Descript,
and Spotify for Creators (catalog + citations in `docs/steward/UX_UPGRADE-podcasts.md`;
research basis bounded — no new WebSearch this round, all evidence is the standing
cited catalog). Three leader-standard capabilities were deferred with reasons:

- **PR2-2 Transcripts** — every leader publishes transcripts (`<podcast:transcript>`
  is table-stakes in Podcasting 2.0 clients; Apple auto-transcribes and lets
  hosts supply their own). We already *have* the text: the generation run writes
  a multi-speaker transcript Document (`PodcastEpisode.transcriptDocRef`,
  `podcastsService.ts:102`; pipeline node `feature.podcasts.nodes.transcript`,
  `generateWorkflow.ts:13`). Nothing projects it publicly.
- **PR2-7 Chapters** — leaders ship chapter markers (`<podcast:chapters>` JSON).
  The outline Document (`outlineDocRef`, `podcastsService.ts:101`) already
  carries the segment structure a chapters file needs.
- **PR2-10 AI ingest** — leaders let a creator hand the tool an existing audio
  file/URL and get a titled, described, transcribed, chaptered episode. Our
  pipeline only *generates* episodes from notebooks; there is no intake door for
  audio produced elsewhere.

## Boundaries audit (pre-existing surface — compose, don't fork)

- **Transcript/outline text**: versioned Documents (ADR 0053) owned by the
  notebook — `outlineDocRef`/`transcriptDocRef` on the episode row. Owner:
  documents service. The public lane must PROJECT these refs, never copy the text
  onto the episode row (copies dodge retention/erasure — the ADR 0560 lesson).
- **Public surface**: `publicRoutes.ts` already owns the published-only, uniform-404,
  tenant-from-resource door (`resolvePublicOrg` → `getPublishedShowBySlug`), and
  `podcastFeed.ts` now declares `xmlns:podcast` (R3 shipped `<podcast:guid>`).
  New feed tags ride the same builder; new public routes ride the same gates.
- **Media intake**: `storeMediaAsset` (host inMemorySurfaces / media feature) is
  the single owner of audio bytes; the ADR 0086 pipeline already records results
  via `recordEpisodeResult`. Ingest reuses both — no second audio store.
- **Agent lane**: `agentTools.ts` already registers podcasts agent tools on the
  ONE chat (`registerFeatureAgentTool`, sharing the routes' access predicate).
  Ingest agents extend this file + the `feature.podcasts.agents` pack — never a
  new chat surface (single-chat rule).
- **Workflow lane**: the generation pipeline is `generateWorkflow.ts` composing
  `feature.podcasts.nodes.*`. Ingest is a SIBLING pipeline in the same node
  pack, run by the one shared executor. Never a hard-coded builtin.
- **No route collisions**: `…/podcasts/episodes/:id/transcript` and
  `…/public/:orgId/podcasts/:showSlug/:episodeSlug/transcript.(vtt|json)` and
  `…/chapters.json` are new literals under existing prefixes (grep clean).

## Decision

Ship one **ingest/authoring lane** in three phases, all under the existing
`podcasts` toggle:

### Phase 1 — Published transcripts (`<podcast:transcript>`)
- Public route `GET …/:episodeSlug/transcript.vtt` (WebVTT with speaker voice
  tags, derived from the transcript Document's turn structure) + `transcript.json`
  (the Podcasting 2.0 JSON format). Published-episode gate + uniform 404 +
  `Cache-Control` mirroring `feed.xml`.
- Feed: `<podcast:transcript url="…" type="text/vtt"/>` (+ `application/json`)
  per item, emitted only when the episode HAS a `transcriptDocRef` — no tag
  without data (the XP-R2-4 honesty rule).
- Episode page projection: a transcript panel on the public episode JSON +
  prerender (readable + SEO; Apple/Descript both surface transcripts inline).
- **Derivation is at read time from the Document** (no copied text on the row);
  a deleted/erased Document drops the tag and the route 404s — erasure reaches
  the public lane by construction.

### Phase 2 — Chapters (`<podcast:chapters>`)
- `GET …/:episodeSlug/chapters.json` (Podcasting 2.0 chapters JSON) derived from
  the outline Document's segments + clip offsets. The mix step already knows
  each clip's duration (`durationSeconds` shipped in R2); cumulative offsets
  give `startTime` per segment without new stored state. Emit the feed tag only
  when derivable.
- If clip offsets prove unavailable for older episodes, the tag is simply
  absent for them — no backfill fabrication.

### Phase 3 — AI ingest (agent + nodes on the ONE chat)
- Node pack additions (`feature.podcasts.nodes.*`): `ingest-audio` (URL/media
  ref → stored Media asset + duration probe), `transcribe` (speech-to-text via
  the provider adapter seam — BYOK, same posture as speech synthesis), and
  reuse of existing summarize/outline nodes to draft title/description/chapters
  from the transcript.
- Chain pack (RFC 0013): `ingest` pipeline — intake → transcribe → draft
  metadata → **human gate** (the episode stays draft; publishing remains the
  operator's explicit act) → `recordEpisodeResult`.
- Agent pack: an "Episode producer" persona whose tools start/steer the ingest
  run through the existing chat (`?agent=` deep-link from the studio), per the
  ADR 0058 agent+nodes pattern. Model output reaches durable state only through
  the run's validated envelopes + the human gate (LLM-EXCHANGE rules; new tools
  get tracker rows in `docs/steward/LLM-EXCHANGE-AUDIT.md`).

## RFC verdict

**Host work only — no OpenWOP RFC.** `<podcast:transcript>`/`<podcast:chapters>`
are Podcasting 2.0 RSS vocabulary (external standard), not OpenWOP wire. The
ingest chain rides RFC 0013 as-is; transcription rides the existing provider
adapter seam (RFC 0105 precedent for synthesis). No capability advertisement
changes.

## Alternatives weighed

- **Copy transcript text onto the episode row** — rejected: dodges Document
  versioning/retention/erasure (ADR 0560's snapshot-copy lesson) and duplicates
  an owner.
- **Auto-publish ingested episodes** — rejected: publishing is the editorial
  gate (ADR 0390); model-drafted metadata must pass a human gate.
- **A bespoke "ingest wizard" UI with its own AI textarea** — rejected by the
  single-chat rule; the chat + agent pack is the drivable surface, the studio
  deep-links to it.
- **Whole-file transcript upload for external audio without transcription** —
  kept in scope as the trivial case of Phase 3 (`transcribe` skipped when the
  operator supplies a VTT); not a separate lane.

## Open questions

1. Transcription provider default: managed key vs BYOK-only (search ADR 0494
   found no defensible zero-config default for search; audio likely lands the
   same way — assume BYOK-only until a managed deal exists).
2. VTT speaker labels: persona names vs voice ids (privacy: persona names are
   operator-authored content, safe; assume persona names).
3. Chapters for generated episodes predating durationSeconds: absent vs
   re-mixable (assume absent; re-mix is operator-triggered).

## Deferred (named)

- PR2-8 embeddable player — separate surface, own ADR if pursued (unchanged
  from R2).
- Soundbites (`<podcast:soundbite>`) / value tags — no catalog evidence they are
  leader-differentiating; out of scope.

## Phased implementation record

| Phase | Status |
|---|---|
| 1 transcripts | not started |
| 2 chapters | not started |
| 3 ingest chain + agent | not started |

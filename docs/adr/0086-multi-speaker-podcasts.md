# ADR 0086 — Multi-speaker AI podcasts (a NotebookLM-style audio-overview studio on our seams)

**Status:** **implemented** (Phase 1 — `src/features/podcasts/` feature-package, toggle `podcasts`/OFF/tenant, `podcastsService` (EpisodeProfile + SpeakerProfile config + the PodcastEpisode tracking record), routes under `/v1/host/openwop-app/podcasts/*` (profiles CRUD + episodes create/list/get/retry/delete; create ENQUEUES a run); Phase 2 — the `ctx.features.podcasts` surface (reads + the `recordEpisodeResult` write-back); Phase 3 — `feature.podcasts.nodes` (select-content / outline / transcript / **synthesize → `ctx.callSpeechSynthesizer`, RFC 0105** / mix) + the `podcasts.generate` built-in workflow; Phase 4 — the optional Podcast Producer agent (`feature.podcasts.agents`, advisory — grounds on the notebook + plans the episode; generation stays the RBAC-gated Studio action, off the chat injection surface); Phase 5 — the `PodcastStudioPage` (cast + show-format profile management with the 1–4-speaker editor, a generate form, an episode list with a sequential clip player + retry), i18n en/es/fr/pt-BR; Phase 6 — `aiProviders.speechSynthesis: supported` already advertised, `test/podcasts.test.ts` covers org-scope/IDOR, 1–4-speaker validation, cross-org reference rejection, status projection, and run enqueue. **The RFC 0105 block below is RESOLVED** — see the unblock note.)
**Date:** 2026-06-20
**Toggle:** `podcasts` · default **OFF** · `bucketUnit: tenant` (a shared B2B audio-generation surface — every user in a workspace gets the same variant, like ADR 0084 notebooks)
**Surface:** host-extension `/v1/host/openwop-app/podcasts/*` (non-normative) + `ctx.features.podcasts` workflow surface + node pack `feature.podcasts.nodes`

> ## ✏️ Surfacing correction (2026-06-22) — podcasts live INSIDE projects
> Like notebooks (ADR 0084), the original standalone `/podcasts` Studio destination
> is replaced by a **"Podcast" tab on `ProjectDetailPage`**: the studio (cast +
> show-format profile management, generate, episode list w/ player + retry) scoped to
> THIS project as the content source (no org/notebook pickers; episodes filtered to
> the project). The `Studio` component takes optional `fixedOrgId`/`fixedNotebookId`
> and is reused via `ProjectPodcastPanel`; the standalone nav is withdrawn. The
> `podcasts` toggle now gates the project Podcast tab's visibility. Backend routes +
> the generation pipeline are unchanged (notebookId = the project id).

> ## ✅ RFC 0105 UNBLOCKED (correction, 2026-06-22)
>
> When authored, this ADR was blocked on RFC 0105 (speech-synthesis adapter). That
> RFC has since reached **`Accepted`** AND the host has WIRED `ctx.callSpeechSynthesizer`
> (`aiProviders/aiProvidersHost.ts`, MiniMax T2A managed path) and advertises
> `aiProviders.speechSynthesis: supported` (`discovery.ts`). The synthesize node ships.
> The original blocked banner is retained below for the reasoning trail.
>
> **§mix correction.** The synth path returns a tenant-scoped asset `audio.url` per
> turn (the bytes are already stored in Media), and this host has no ffmpeg-class
> muxer. The `mix` node always assembles an ORDERED CLIP LIST (the Studio player
> plays them back-to-back — the always-available fallback) AND now also attempts a
> **single-file mux**: `ctx.features.podcasts.mixClips` resolves the clip bytes
> server-side and concatenates them where the codec allows cheaply — MP3 frame
> byte-concat (MiniMax/OpenAI) or WAV header-strip+rewrap (Google PCM). The single
> file lands as `episode.audioMediaRef` and the player prefers it; mixed/unknown
> codecs degrade to the playlist (never corrupt). A true cross-codec transcoded mux
> remains the ffmpeg-class deferral (OQ-1). **Hardening (2026-06-22):** the MP3 path
> strips a leading ID3v2 tag from every clip after the first, so a mid-stream tag
> can't derail a tolerant decoder.
>
> **TTS providers.** Speech synthesis now routes to **MiniMax** (managed),
> **OpenAI** (`/audio/speech`, BYOK) and **Google Gemini TTS** (`generateContent`
> AUDIO → PCM wrapped to WAV, BYOK) — selectable per SpeakerProfile. **Anthropic is
> deliberately absent: Claude has no text-to-speech API**, so advertising it would
> be a dishonest wire claim.
>
> <details><summary>Original blocked banner (historical)</summary>
>
> > ## ⛔ BLOCKED ON RFC 0105 — read this first
> >
> > This ADR generates audio. The OpenWOP wire has image generation (`ctx.callImageGenerator`,
> > advertised via `aiProviders.imageGeneration: supported`) and video generation, and audio
> > _input_ (RFC 0091, Accepted), but **no speech/audio _output_ adapter**. Text→speech is the
> > **one genuine wire gap** in the entire open-notebook port. It is closed by the new
> > **RFC 0105 (speech-synthesis adapter, `ctx.callSpeechSynthesizer`)**, authored in this same pass.
> > **This ADR is BLOCKED on RFC 0105 reaching ≥ `Accepted` before/with the host work.** Phase 3
> > (the node pack's `synthesize` node) cannot ship until the host wires `ctx.callSpeechSynthesizer`.
> > Everything else here — orchestration, profiles, mixing, UI — is host work.
> </details>

**Depends on / composes:**
- ADR 0001 (feature-package architecture)
- **ADR 0084 (Research Notebooks)** — podcast content comes from a notebook's sources + notes; a podcast is an _audio overview_ of a notebook (the NotebookLM lineage). ADR 0084 §"RFC verdict" already names this ADR as blocked on RFC 0105.
- ADR 0053 (Documents & Templates) — the generated outline + transcript are **document artifacts** (versioned, the Documents owner).
- ADR 0007 (Media Library) — the final MP3 is a **Media asset** (the bytes owner).
- ADR 0024 (Connections / credential broker) — TTS provider keys (ElevenLabs / OpenAI / Gemini TTS) resolve via the BYOK connection broker, never a raw key in a node.
- ADR 0014 (`ctx.<feature>` workflow surfaces) · ADR 0025 (schedules — "weekly digest podcast") · ADR 0058 (chat-drivability = agent + nodes) · ADR 0073 (`EmbeddedChatPanel`) · ADR 0006 (RBAC) · ADR 0013 (Sharing — deferred)
- The **executor run model** + **scheduler** + **HITL** — the long async generation job is an executor run, NOT a new job queue.
- **RFC 0105 (speech-synthesis adapter)** — the wire dependency this ADR is blocked on.

**RFC verdict:** **BLOCKED on new RFC 0105 (speech synthesis) reaching ≥ `Accepted`.** Everything except the TTS call is host work composing implemented ADRs + Accepted RFCs. See §"RFC verdict" at the foot.

> **Origin.** Ports the *product design* of [`lfnovo/open-notebook`](https://github.com/lfnovo/open-notebook)'s flagship **multi-speaker podcast / audio-overview** feature — **not its code** (Python / FastAPI / surreal-commands job queue / Podcastfy, non-portable). The capability intent (notebook → episode profile → outline → transcript → multi-speaker TTS → mixed MP3) is re-expressed on this app's seams. Differentiator vs NotebookLM's fixed two-host format: **1–4 configurable speakers** with per-speaker voice + persona.

---

## Context — boundaries audit first (MANDATORY, per the scope rule)

Open-notebook treats *episode profile, speaker profile, podcast episode, the generation job, and the audio file* as bespoke entities run on its own **surreal-commands** background queue. The audit overturns most of that: every cross-cutting concern already has a single owner here, and re-implementing any as a parallel store/queue would violate the `no-parallel-architecture` law (a feature that *is* a primitive MUST instantiate it, not shadow it — the EA-assistant violation).

**Namespace check** — `grep -rniE "podcast|\btts\b|speech.synth|\bepisode\b|speakerprofile|callSpeechSynth" backend/typescript/src frontend/react/src`: **zero** route / feature-id / service collisions. The only hit is an existing deterministic TTS *demo stub* — `backend/typescript/src/routes/mediaAssets.ts` (`POST …/media/synthesize`, returns a silent WAV when no live provider is wired). That stub demonstrates the call shape pre-adapter and is **evidence of the wire gap**, not a competing implementation. `podcasts` is a clean toggle id and route prefix.

**Concept-ownership map (compose these; do NOT fork them):**

| open-notebook concept / capability | Single owner already in repo | How podcasts reuse it |
|---|---|---|
| **Background generation job** (surreal-commands queue) | The **executor run model** + scheduler (ADR 0014/0025) | A podcast generation is **one executor run** of the podcasts workflow. NOT a new job queue. Status, retry, cancellation, HITL all ride the run. |
| **Source content** (what the podcast is about) | **Notebook** = a `project` Subject + its KB collection + notes (ADR 0084) | Episode content = selected notebook sources/notes, retrieved through the notebook's existing KB seam. No new content store. |
| **Outline + transcript** (script artifacts) | **Documents & Templates** (ADR 0053) | The outline and the dialogue transcript are written as **versioned documents** bound to the notebook Subject. Reviewable/editable before TTS. |
| **Final audio file** (the .mp3) | **Media Library** (ADR 0007) | The mixed MP3 is a **Media asset**; its bytes + serving + lifecycle are Media's. The `PodcastEpisode` record holds only a `mediaRef`. |
| **TTS provider key** | **Connections / credential broker** (ADR 0024) → resolved on the wire via BYOK (RFC 0046) | The `synthesize` node calls `ctx.callSpeechSynthesizer` (RFC 0105); the host resolves the provider credential through the broker. No raw key in a node. |
| **AI generation (outline/transcript)** | `ctx.callAI` (already on the wire) inside a run | Outline + transcript nodes are `ctx.callAI` calls — `ctx`-only, hence the workflow-run constraint (same as ADR 0084 §"architecture-imposed correction"). |
| **Speech synthesis (text→audio)** | **NOTHING** — the wire gap | `ctx.callSpeechSynthesizer` does not exist yet → **RFC 0105**. This is the only genuinely-new wire surface. |
| **Chat-driven generation** ("make me a podcast about X") | The one chat primitive + `EmbeddedChatPanel` (ADR 0073) + an agent pack (ADR 0058) | An optional **Podcast Producer** agent drives generation from chat; no second chat panel. |

**The architecture-imposed correction (same one ADR 0084 / 0011 hit).** Provider TTS and LLM generation are `ctx`-only — reachable only inside a workflow run (per-node `AdapterScope`), never from synchronous feature-route code. **Therefore the entire generation pipeline is a workflow run**, surfaced asynchronously (status polling, the episode appearing, HITL approval cards). REST routes orchestrate runs; they never call a model or synthesizer directly.

**Net:** podcasts are ~80% *assembly* of accepted seams (notebook content + Documents + Media + Connections + executor runs + scheduler + chat). The genuinely new code is two config entities + a `PodcastEpisode` tracking record, the `ctx.podcasts` read surface, a four-node pack, an optional agent pack, and a Podcast Studio UI — **plus the one wire dependency, RFC 0105.**

---

## Decision

Ship a **`podcasts` feature-package** (ADR 0001) that turns a notebook's research into a **multi-speaker narrated audio episode** via an executor-run pipeline, composing notebooks, Documents, Media, Connections, the scheduler, and the new RFC 0105 speech-synthesis adapter. **1–4 configurable speakers** (each with its own voice + persona) is the differentiator vs NotebookLM's fixed two-host format.

### Data model — two config entities + one run-tracking record

Modeled as **feature entities, org-scoped, owned by the workspace** (not a Subject — these are reusable generation *config*, not containers with cognition; a Subject would be the wrong owner per the boundaries map):

```
EpisodeProfile                     // reusable "show format" config
  { id, tenantId, orgId, name,
    outlineModel, transcriptModel, // which LLM for each stage (host-routed model ids)
    segmentCount: 3..20,           // number of dialogue segments
    languageCode,                  // BCP-47, forwarded to callSpeechSynthesizer
    defaultBriefing,               // standing instructions ("upbeat, 10-min, exec audience")
    speakerProfileId }             // → references a SpeakerProfile

SpeakerProfile                     // reusable cast config
  { id, tenantId, orgId, name,
    provider, model,               // TTS provider/model (host-routed; key via ADR 0024)
    speakers: [1..4] of {
      name,                        // "Ana", "Marco"
      voiceId,                     // OPAQUE host-resolved voiceId (RFC 0105 — spec does NOT enumerate)
      backstory, personality,      // persona text injected into the transcript prompt
      voiceOverride? }            // optional per-speaker voiceId override
  }

PodcastEpisode                     // tracks ONE generation run (not config)
  { id, tenantId, orgId, notebookId,
    episodeProfileId,
    runId,                         // → the executor run (ADR 0014) — the single source of truth for status
    outlineDocRef, transcriptDocRef, // → Documents (ADR 0053)
    audioMediaRef,                 // → Media asset (ADR 0007) — the final MP3
    status,                        // derived from the run: queued|running|awaiting-approval|done|failed
    error? }
```

- `PodcastEpisode` is a thin tracking record; the **executor run** is the real state machine. The episode never duplicates run state — it links `runId` and projects status.
- `voiceId` is opaque per RFC 0105; the host resolves it to a provider voice. The spec/this ADR do NOT enumerate voices (open question OQ-2 on preview UX).

### The generation pipeline is a WORKFLOW (not sync)

A `feature.podcasts` workflow, run on the executor:

1. **select-content** — gather the chosen notebook sources/notes (via the ADR 0084 notebook KB seam; honors per-source context levels).
2. **outline** (`podcasts.outline` node → `ctx.callAI` with `outlineModel`) → write a **document** (`outlineDocRef`).
3. **transcript** (`podcasts.transcript` node → `ctx.callAI` with `transcriptModel`, injecting each speaker's persona + the segment count) → write a multi-speaker dialogue **document** (`transcriptDocRef`). **Optional HITL approval** here (review the script before spending TTS).
4. **synthesize** (`podcasts.synthesize` node → **`ctx.callSpeechSynthesizer` from RFC 0105, one call per speaker turn**, each turn carrying its `voiceId`) → per-turn audio clips.
5. **mix** (`podcasts.mix` node) → concatenate/crossfade the clips into one track → store as a **Media asset** (`audioMediaRef`, the MP3).

Long-running → executor run + optional HITL approval + **failed-episode retry** (re-run from the failed node). **Schedulable** via ADR 0025 — a "weekly digest podcast" is a near-free win (a scheduled run over a notebook).

### RBAC & isolation

Org-scoped (ADR 0006): every route + the `ctx.podcasts` surface gates on the caller's RBAC scope **in the workspace's org** — `workspace:read` to view profiles/episodes, `workspace:write` to mutate/generate — uniform 404 on insufficient scope (no existence leak). Profiles + episodes never become authenticated principals. Delete cascades the `PodcastEpisode` → releases the Media asset + the Documents (per their owners' cascade rules).

---

## Phased plan

**Phase 1 — Backend feature-package + REST.** `src/features/podcasts/` (`feature.ts` toggle `podcasts`/OFF/`tenant`; `podcastsService.ts`; `routes.ts` under `/v1/host/openwop-app/podcasts/*` via `featureRoute` → `authorizeOrgScope` + `requireFeatureEnabled`). EpisodeProfile + SpeakerProfile CRUD; `…/episodes` create (enqueues a run), list, get, retry, cancel. No model/TTS calls here — generation **enqueues an executor run**.

**Phase 2 — `ctx.podcasts` read surface (ADR 0014).** Typed read surface behind the same toggle + RBAC, advertised at `/.well-known/openwop` only when enabled: `getEpisodeProfile`, `getSpeakerProfile`, `listEpisodes`, `getEpisode`. Write-back (a node recording the episode's doc/media refs) goes through the service. Replay-safe via the observable-result cache, like `ctx.kb` / `ctx.notebooks`.

**Phase 3 — Node pack `feature.podcasts.nodes`** (signed; Ed25519 + SRI; `requiredPacks`). Nodes: `podcasts.outline`, `podcasts.transcript`, `podcasts.synthesize` (**`ctx.callSpeechSynthesizer`, RFC 0105**), `podcasts.mix`. **⛔ This phase CANNOT ship until RFC 0105 is `Accepted` and the host wires `ctx.callSpeechSynthesizer`** with `requiredHostCapabilities` / `peerDependencies: { aiProviders: "supported" }` declaring the `speechSynthesis` sub-capability.

**Phase 4 — Agent pack `feature.podcasts.agents`** (optional; chat-drivability = agent + nodes, ADR 0058). One agent: **Podcast Producer** — persona scoped to a notebook, capabilities = the podcasts nodes; drives "make a podcast about X" from chat. Capability lives at the **core-agent** level, activated per named agent via `agentProfile` (per the `agent-capability-core-not-named` law). Driven through `EmbeddedChatPanel`.

**Phase 5 — Frontend `src/features/podcasts/` (Podcast Studio).** `podcastsClient.ts` + `PodcastStudioPage` (profile management: episode + speaker profiles, with the 1–4-speaker cast editor) + a **generate form** (pick notebook + profile + briefing) + an **episode list** with status, an audio player for `audioMediaRef`, and **retry** on failure. Reuses `EmbeddedChatPanel` (Podcast Producer), `ui/` cohesion (`.surface-card`/`.chip`/`<StateCard>`), Lucide icons, i18n keys (ADR 0065).

**Phase 6 — `/.well-known` advertises `speechSynthesis` + tests.** The host advertises `aiProviders.speechSynthesis: supported` once `ctx.callSpeechSynthesizer` is wired (gated on RFC 0105). Backend `test/podcasts.test.ts` (org-scope/IDOR, run-orchestration, retry, profile validation 1–4 speakers / 3–20 segments) + a frontend smoke + the gated RFC 0105 conformance scenarios pass against this host.

---

## Evaluation matrix

| Row | Disposition |
|---|---|
| **Toggle + admin UI** | `podcasts` toggle, OFF, `tenant` bucket; admin panel via the standard feature-toggle registry. |
| **`ctx.<feature>` surface** | `ctx.podcasts` read surface (Phase 2), advertised only when enabled. |
| **Node pack** | `feature.podcasts.nodes` — outline / transcript / **synthesize (RFC 0105)** / mix (Phase 3, blocked on 0105). |
| **Agent pack** | Optional **Podcast Producer** (Phase 4), core-level capability via `agentProfile`. |
| **Public surface** | Episodes COULD be publicly shareable → rides Sharing (ADR 0013) resolver-registry + capability tokens. **Deferred** (the seam exists; OQ-1). |
| **RBAC** | Org-scoped; `workspace:read` / `workspace:write`; uniform 404. |
| **Replay** | The TTS/generation **run** is the replay subject (the host MAY snapshot `callSpeechSynthesizer` output in the event log per RFC 0105 §Determinism / replay.md). EpisodeProfile + SpeakerProfile are **config, not variants** — not replay-stamped. |
| **Frontend** | Podcast Studio (Phase 5) on `ui/` + `EmbeddedChatPanel`. |

## Alternatives weighed

1. **A new job queue (mirror open-notebook's surreal-commands).** Rejected — the executor run model already provides queued/running/failed status, retry, cancellation, HITL, and scheduling. A parallel queue is the `no-parallel-architecture` violation and loses all of that for free.
2. **TTS via raw HTTP to ElevenLabs (etc.) inside a node, bypassing the adapter.** Rejected — a **dishonest wire claim** (the host would secretly do TTS while advertising none), **not portable** (the pack only runs where that exact HTTP call works), and it **bypasses BYOK / per-provider policy / the media-trust boundary**. TTS MUST go through the **RFC 0105 `ctx.callSpeechSynthesizer` adapter** — which is precisely why this ADR is blocked on that RFC.
3. **Single-speaker (read-aloud) only.** Rejected — **multi-speaker (1–4) is the differentiator** and the open-notebook flagship behavior. (A single speaker falls out for free as `speakers.length === 1`.)
4. **Podcast as its own Subject / a new container entity.** Rejected — the content container is the **notebook** (ADR 0084); profiles are reusable config, not containers. A Subject would be the wrong owner.

## Open questions

1. **OQ-1 — Audio mixing approach.** Does `podcasts.mix` do host-side concatenation/crossfade (a render node), or could a provider return pre-mixed multi-speaker audio (a single `callSpeechSynthesizer` shape — RFC 0105 Unresolved §2)? v1 proposes per-speaker calls + a host-side mix node.
2. **OQ-2 — Voice preview UX.** `voiceId` is opaque (RFC 0105). How does the cast editor let a user audition/pick a voice? Propose: a host-side `…/voices` listing + a short sample synthesis, host-extension only (no wire enumeration).
3. **OQ-3 — Cost ceilings.** TTS is per-character billed; a long transcript × 4 voices is expensive. Propose a per-episode character cap (rides RFC 0105 Unresolved §4 `content_too_long`) + a pre-flight estimate.
4. **OQ-4 — Max episode length.** Cap `segmentCount` (3–20) + per-segment length to bound run time + cost. Propose: declared on EpisodeProfile, validated server-side.
5. **OQ-5 — Public sharing (rides ADR 0013).** Should a finished episode get a public share link (a podcast feed?)? Deferred; the Sharing seam exists.

## RFC verdict

**⛔ BLOCKED on new RFC 0105 (speech-synthesis adapter, `ctx.callSpeechSynthesizer`) reaching ≥ `Accepted` before/with this host work.** Text→speech is the **one genuine wire gap** in the whole open-notebook port — the wire has image + video generation and audio *input* (RFC 0091) but no audio *output*. RFC 0105 was authored in this same `/prd` pass and adds the additive optional `aiProviders.speechSynthesis: supported` flag + the `ctx.callSpeechSynthesizer` method. **Phase 3 (the `synthesize` node) cannot ship until 0105 is Accepted and the host wires the adapter.** Everything else — the executor-run pipeline, the EpisodeProfile/SpeakerProfile config, the outline/transcript Documents, the mix + Media asset, the scheduler hook, the Podcast Producer agent, and the Studio UI — is **host work** composing implemented ADRs (0007/0024/0053/0084) + already-Accepted RFCs (0005 chat, 0091 audio input). The `/v1/host/openwop-app/podcasts/*` routes + `ctx.podcasts` surface + envelopes are non-normative host extensions and need no RFC of their own.

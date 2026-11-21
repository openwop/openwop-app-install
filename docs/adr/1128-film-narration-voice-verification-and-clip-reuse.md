# ADR 1128 — Film narration, voice verification and clip reuse

Status: Proposed (2026-11-15). Planning only. Part of ADR 1126.

## Context

A film creative is narrated, with one narration clip per beat (ADR 1126 D2, invariant 2). The
narration must say what the approved script says. A replay or fork must not pay twice for unchanged
narration, and must not silently re-generate a different voice.

**Upstream today:**
- Text-to-speech through `providers/dispatchSpeech.ts`, using MiniMax T2A on the RFC 0105
  speech-synthesis seam. One call is one whole-file speaker turn. `voiceId` is opaque and resolved
  by the host.
- Speech-to-text through `features/notebooks/transcribeWorkflow.ts`, using an audio-capable model
  through the AI dispatcher. It is deliberately not exposed to chat.
- Audio "mixing" exists only as byte concatenation (`features/podcasts/audioMux.ts:4`).

**DeckTalk** (decktalk@8691c224) has a complete, production-exercised narration stack:
- **Recording and calibration:** recorded narration and PCM handling, recording calibration.
- **Cleanup and selection:** vocal cleanup with a cleanup contract, retake and pause candidates,
  waveform boundaries.
- **Transcripts:** transcript edits, video transcripts, transcribe-source, a verification fallback,
  listening review.
- **Mix:** mixing, music usage, mix identity and evidence, and three synthesized sound-effect cues.
- **Reuse:** `reuse.mjs` and `regeneration.mjs`, plus clip-reuse receipts (`speechHash`,
  `alignmentHash`, `visualHash`; `B/clipReuse*.ts`, `runClipRetention.ts`). This is how DeckTalk
  avoids re-paying for unchanged narration and keeps recovery fork-safe.

## Decision

### D1 — Two narration sources, one clip contract

Each beat's narration clip is either:
- **synthesized**: TTS through `dispatchSpeech` with the workspace's BYOK key. A missing key fails
  typed (`speech_key_missing`) and names the provider; or
- **recorded**: the user uploads or records a take in the Film tab (a browser `MediaRecorder` to a
  Media asset, audio MIME checked by magic bytes).

A clip is `{beatIndex, source, mediaAssetId, durationMs, speechHash, transcript?, alignment?,
verification}`. `speechHash = H(narration text, voiceId, provider, model, settings)` for synthesized
clips. For recorded clips it is the content hash of the audio.

### D2 — Voice verification before acceptance

No clip is accepted into a film unless it is verified:
- **Check:** the clip is transcribed through the notebooks transcription seam, which is extended
  with a node-only `verify-take` operation and stays chat-hidden. The transcript is compared with
  the beat's script using DeckTalk's normalized word-error check, with its thresholds as initial
  values.
- **Pass:** `verification: {status:'verified', wer, transcriptHash}`.
- **Fail:** a typed `take_mismatch`, with the differing words shown so the person can re-record or
  regenerate. A retake is a new clip, and the old one is kept until the production is approved.
- **No STT key:** verification cannot run, and the clip is `unverified`. An unverified clip blocks
  the review gate unless the reviewer explicitly accepts it. That acceptance is recorded on the
  approval; it is never auto-accepted.

Word-level alignment, where the STT model returns timings, is stored as `alignment` and feeds
captions (ADR 1127 D6). Otherwise captions use clip-level timing.

### D3 — Cleanup, retakes, pauses (recorded clips)

DeckTalk's cleanup contract (soft expander, pause trimming, waveform boundaries) and its
retake/pause candidate selection are ported as **pure JS PCM modules** in the node pack. No WASM is
needed. Each module has a fixed input contract:

- **Analysis** (pause candidates, retake candidates, waveform boundaries, recording calibration):
  16 kHz mono Int16.
- **Cleanup** (vocal cleanup + cleanup contract): 48 kHz Int16. The cleanup contract refuses
  anything else.

**Canonicalisation step (new):** every clip, recorded or synthesized, is first decoded and
resampled to canonical PCM. That happens in the render job (ffmpeg) or in the browser
(`decodeAudioData` + `OfflineAudioContext`). Browser resampling is not bit-identical across
engines, so "same input, same output" holds only **after** canonicalisation. The canonical PCM is
hashed, and **that hash is the clip's lineage source**. TTS output (compressed) goes through the
same decode before verification and cleanup.

DeckTalk's strict WAV parser (`recorded-pcm.mjs`, rates 16000/44100/48000) must be fixed before it
is ported: it refuses a Mac-written WAV (DeckTalk QA DTQA-020, likely extra chunks or
`WAVE_FORMAT_EXTENSIBLE`).

Each module produces a new clip with lineage to its source. Nothing is applied without the
person's choice in the Film tab.

### D4 — Mix and sound effects

A mix layer combines the narration clips at their beat offsets, optional music (a Media asset the
workspace owns, with its usage recorded) and up to three synthesized cue sounds. DeckTalk's
harmonic cues are generated from parameters, so no third-party audio is involved. The mix is a
**specification** (`mix.spec` + `specHash`). It is rendered to audio by the same backends as video
(ADR 1127): ffmpeg in the job, `OfflineAudioContext` in the browser. A parity test checks duration,
peak/RMS envelope and **integrated loudness (LUFS)** across the two backends. The browser mix needs
JS sidechain ducking and loudness normalisation (ADR 1127 D3).

### D5 — Clip reuse and regeneration (fork safety)

- **Reuse receipts:** each paid call (TTS, STT, image, render) writes a receipt
  `{kind, inputHash, outputRef, cost, runId, at}`.
- **Same input:** a regeneration with the same `inputHash` within the production **reuses the
  output** and makes no provider call. That covers the case where only the visuals changed.
- **Different input:** a changed script or voice makes a new `inputHash` and a new call.
- **Fork:** a fork of a run reads the parent's receipts, so it replays recorded outputs and never
  re-calls a provider unless an input on the fork actually changed.
- **Retention:** receipts and superseded clips are retained until the production is approved plus
  30 days. Approved clips are retained with the production. The cleanup daemon follows
  `runClipRetention.ts`.
- **Alignment and visuals:** `alignmentHash` and `visualHash` work the same way for alignment and
  image outputs.

### D6 — Locales

A production with several `locales[]` (ADR 1126 D4c) has one narration layer per narrated locale,
each with its own voice (`voiceId` per locale), verification (STT in that language) and receipts. A
caption-only locale reuses the source narration and adds a translated caption track. The STT model
must support the locale; if it does not, the clip is `unverified` and follows the D2 rule.

## Phases

| Phase | Scope |
|---|---|
| N0 | Clip contract + TTS node (`feature.film-creative.nodes.narrate`) through `dispatchSpeech`, typed missing-key |
| N1 | Recorded takes in the Film tab (MediaRecorder → Media) |
| N2 | `verify-take` on the notebooks transcription seam + WER check + review-gate rule for unverified clips |
| N3 | Reuse receipts + regeneration + fork reuse; retention daemon |
| N4 | Canonicalisation (decode + resample, canonical PCM hash) + WAV parser fix (DTQA-020) + cleanup/pause/retake PCM modules |
| N5 | Mix spec + cue sounds; render through ADR 1127 backends + parity test |

## Alternatives weighed

- **Avatar narration through `creative-video` (HeyGen).** Kept as a *scene type* option (a talking
  presenter beat), not as the narration track. The narration must be verifiable per beat and
  reusable.
- **Auto-accept TTS without verification.** Rejected: TTS mispronounces and truncates, and the
  approval should rest on what is actually said.

## RFC verdict

**Rides RFC 0105 (speech synthesis) for TTS; host extension otherwise. No new RFC.** Verification,
reuse receipts and the mix spec are host-internal.

## Open questions

1. WER thresholds: start with DeckTalk's values and re-tune them on English test sets.
2. Voices: the host voice catalog (RFC 0105 opaque `voiceId`) is MiniMax-only today. More providers
   would be added through the same seam.
3. Music licensing beyond the workspace's own assets is not planned.

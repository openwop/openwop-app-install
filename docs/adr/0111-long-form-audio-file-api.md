# ADR 0111 — Long-form audio transcription via the Gemini File API (ADR 0108 OQ-2)

**Status:** implemented (2026-06-23) — all 3 phases (live verification via the gated test when GEMINI_LIVE_KEY is set)
**Date:** 2026-06-23
**Toggle:** none new — rides the existing `OPENWOP_KB_TRANSCRIBE_ENABLED` gate.
**Capability:** none new on the wire. `dispatch`'s `ContentPart` is UNCHANGED — the File API is an internal `dispatchGoogle` mechanism.
**Depends on / composes:** ADR 0108 (`mediaToTextViaLLM`), ADR 0110 (the headless resolver — Gemini is the audio provider), `dispatchGoogle`.
**Surface:** host-internal (`providers/dispatch.ts`, `kbService` cap). No new route.
**NON-NORMATIVE — no OpenWOP RFC.**

## Why this exists

ADR 0108 transcribes audio by sending it **inline** (`{type:'audio', dataBase64}`) in the Gemini request. Inline is bounded by Gemini's ~20 MiB total-request limit and our 32 MiB upload cap — roughly **30–60 minutes** of compressed audio. Multi-hour recordings (lectures, long meetings, podcasts) exceed that (OQ-2).

Gemini's **File API** handles audio up to ~9.5 hours: upload the bytes once → reference them by `fileUri` in `generateContent` via a `fileData` part. This ADR routes large audio through it.

## Decision

**Keep `dispatch`'s `ContentPart` provider-agnostic and unchanged.** The File API is a *Gemini-specific* mechanism, so it lives **inside `dispatchGoogle`**: when an `audio` (or large `file`) part's decoded size exceeds an inline threshold, `dispatchGoogle` transparently

1. **uploads** the bytes to `https://generativelanguage.googleapis.com/upload/v1beta/files` (resumable protocol),
2. **polls** `GET /v1beta/files/{name}` until `state === ACTIVE` (audio is transcoded server-side; bounded poll with a timeout),
3. references the result as `{ fileData: { mimeType, fileUri } }` instead of `inlineData`.

Below the threshold it stays **inline** (unchanged). Callers (`mediaToTextViaLLM`) pass the audio bytes exactly as today — they never know which path ran. This keeps the provider-specificity where provider-specifics belong (the Gemini dispatcher) and changes **no wire shape**. The other providers don't accept audio input at all (the `MEDIA_MODALITY` map gates audio to Google), so there's no cross-provider gap.

### The cap

`kbService` currently caps *every* upload at 32 MiB (`MAX_UPLOAD_DECODED_BYTES`). Add a **separate, larger `MAX_AUDIO_DECODED_BYTES`** (e.g. 200 MiB ≈ several hours of compressed audio) applied only to `audio/*`; documents/images keep the 32 MiB cap. The synced-audio fetch path (`fetchGuardedBytes`) gets the same raised bound for audio. (A hard ceiling remains — we still hold the bytes in memory; 200 MiB bounds that.)

### Thresholds (constants, tunable)
- **Inline ceiling** ≈ 15 MiB decoded → above it, `dispatchGoogle` uses the File API (keeps the inline request comfortably under Gemini's ~20 MiB request limit).
- **File-ACTIVE poll**: bounded (e.g. ≤ 60 s, backoff) — a stuck upload fails the transcription with a clean 422, never hangs.

## Phased plan

| Phase | Scope |
|---|---|
| 1 | **`dispatchGoogle` File API path.** Upload + poll-until-ACTIVE + `fileData` reference for large audio/file parts; inline unchanged below the threshold. Unit-tested with a mocked File API (upload + status + generate). |
| 2 | **Raise the KB audio cap.** `MAX_AUDIO_DECODED_BYTES` (200 MiB) for `audio/*` in `kbService.resolveSource`, so long **manual-upload** audio reaches `dispatchGoogle`. *(Follow-on landed 2026-06-23: the synced-audio download cap is now raised too — `fetchKnowledgeSourceBytes` threads the file's `mimeType` so `audio/*` gets `MAX_AUDIO_FETCH_BYTES` (200 MiB), mirroring manual upload. Both paths now handle long audio.)* |
| 3 | **Verification.** Extend the gated live test (`live-gemini-media.test.ts`) with a large-audio case that exercises the File API when `GEMINI_LIVE_KEY` is set. |

## Alternatives weighed

- **Chunking (split audio into ≤N-min segments, transcribe each, concatenate).** Rejected: splitting a compressed container on time boundaries needs a media library (ffmpeg — a heavy native dep) and stitches transcripts across boundaries (word-cut risk). The File API avoids decoding entirely.
- **Just raise the inline cap.** Rejected: Gemini's ~20 MiB request limit is a hard provider bound; inline can't reach multi-hour audio regardless of our cap.
- **A new `{type:'file-uri'}` ContentPart + a pre-upload step in `kbService`.** Rejected: pushes a Gemini-specific upload into the provider-agnostic ingest layer and changes the wire shape. Keeping it inside `dispatchGoogle` is cleaner.

## Open questions

1. **OQ-A — File cleanup — ADDRESSED (2026-06-23).** `dispatchGoogle` best-effort DELETEs each uploaded File-API file once the transcript is in hand (`deleteGeminiFile`, never throws) — so a heavy tenant doesn't pile up against the File-API storage quota before the 48 h auto-expiry.
2. **OQ-B — Other providers.** Only Gemini does audio; if a future provider adds audio input with its own large-file mechanism, it gets the same in-dispatcher treatment. Out of scope.
3. **OQ-C — Memory — PARTIALLY ADDRESSED (2026-06-23).** The File-API upload now uses the **chunked resumable protocol** (8 MiB `subarray` views, no `new Uint8Array(bytes)` full-body copy) — so the upload adds no full-size duplicate and undici buffers only one chunk at a time. The remaining cost is the **base64 round-trip** (audio reaches `dispatchGoogle` already base64'd in the ContentPart, then re-decoded): eliminating it needs true source→File-API streaming — a binary/multipart upload route + a non-base64 large-media path — a cross-cutting refactor judged disproportionate for a bounded (200 MiB cap), rare path. Deferred unless prod RSS pressure is observed.

## Replay / security

- **Replay-safe by inheritance** — same non-recorded service path as ADR 0108/0110 (`mediaToTextViaLLM`); the File API upload is just more of the same live provider call.
- **SR-1** — the File API upload uses the same `x-goog-api-key` the inline path uses, resolved host-side; the `fileUri` is a transient provider handle (no tenant data), and the key never leaves `dispatchGoogle`.
- **SSRF** — the `fileUri` returned by Gemini is only ever sent back to Gemini (we don't fetch it ourselves), so no new egress surface.

## Review fixes (retrospective /architect, 2026-06-23)

A full-implementation review found the merged feature **uploaded** long audio but couldn't actually **transcribe** it end-to-end — two runtime bugs the mocked unit tests hid:

- **Output truncation.** `mediaToTextViaLLM` requested `maxTokens: 8192` for transcription (an OCR default ≈ ~40 min of speech) — a long transcript was cut off. **Fixed:** audio now requests the model's full output window (`AUDIO_MAX_OUTPUT_TOKENS = 65536`); image OCR keeps 8192.
- **Timeout abort.** The dispatch default deadline is 120 s, but the File-API path (upload + ≤60 s ACTIVE poll + a multi-minute generate) exceeds it, aborting long audio. **Fixed:** the audio path passes a generous deadline (`AUDIO_DISPATCH_TIMEOUT_MS = 10 min`) threaded as an `AbortSignal.timeout` through the headless dispatch closure (`HeadlessDispatch` opts gained `timeoutMs?`).
- **Durable text cap.** `MAX.text` (200k chars) would have sliced a full transcript below the new output budget. **Fixed:** raised to 400k (≈ holds a ~64k-token transcript).

Tests assert the per-modality dispatch budgets (image → 8192/no-deadline; audio → 65536 + a ≥5 min deadline).

## RFC verdict (Step 5)

**Host-internal, no wire change — NO new RFC.** `ContentPart` is unchanged; the File API is an internal `dispatchGoogle` mechanism; the cap is host config. No capability advertised, no endpoint contract touched.

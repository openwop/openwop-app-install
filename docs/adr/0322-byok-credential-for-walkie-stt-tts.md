# ADR 0322 — BYOK credential for walkie/board STT + TTS

Status: implemented

## Context

The walkie/board voice loop (ADR 0138 / ADR 0304) transcribes the user's speech
through `ctx.callTranscriber` and speaks replies through `ctx.callSpeechSynthesizer`.
Both resolve a provider + credential:

- `callTranscriber` → `transcribeManaged` → `callAI({ provider: 'google', model:
  'gemini-2.5-flash', audio })` — i.e. the **managed Google** provider by default.
- `callSpeechSynthesizer` → `dispatchSpeechGoogle` (Gemini TTS) / MiniMax / OpenAI /
  ElevenLabs, selected by the resolved provider.

On this host there is **no managed Google (or OpenAI) key** — only a managed MiniMax
key. And the walkie routes passed **no** `credentialRef`. So `/voice/session/:id/commit`
errored (no key for the Google STT call) and `/voice/session/:id/speak` had nothing
to speak with — the board captured audio (once the frontend capture bugs were fixed:
#1515/#1516/#1517) but **`commit` failed**, so it never transcribed or responded.

Meanwhile the tenant HAS a working voice key: the realtime-voice config
(`getRealtimeConfig`) holds their BYOK `credentialRef` (a Gemini key for
`gemini-live`, an OpenAI key for `openai-realtime`) — the same key those managed
dispatchers accept (a Gemini API key powers Gemini Live **and** generateContent/TTS;
an OpenAI key powers Realtime **and** Whisper/TTS).

## Decision

Reuse the tenant's **realtime-voice BYOK credential** for the walkie/board STT + TTS,
via one mapping helper:

```
walkieProviderCredential(config) =
  config.credentialRef && config.provider === 'gemini-live'   → { provider: 'google', credentialRef }
  config.credentialRef && config.provider === 'openai-realtime' → { provider: 'openai', credentialRef }
  else null
```

- **`/commit` (STT):** pass `{ provider, credentialRef }` to `callTranscriber` so
  `transcribeManaged` runs on the tenant's key instead of the absent managed key.
- **`/speak` (TTS):** when neither the agent's configured voice nor the request names
  a provider/key, fall back to the same `{ provider, credentialRef }`. Google TTS maps
  an unknown `voiceId` to its default voice (`resolveGoogleVoice` → 'Kore'), so the
  existing default voiceId is safe.

Result: a tenant with realtime voice configured gets working board transcription +
spoken replies **on the key they already have**, with no managed STT/TTS key on the
host. When realtime voice is unconfigured, the helper returns null and the paths keep
their honest `transcription_unsupported` / `speech_synthesis_unsupported` behavior
(surfaced to the user by #1513).

## Alternatives considered

- **Add a managed Google API key to the host env** — works for all tenants with no
  per-request wiring, but requires provisioning + rotating a shared key; rejected in
  favor of BYOK (no new secret, consistent with the realtime path).
- **A separate walkie-voice credential config** — more admin surface for no gain; the
  realtime credential already IS the tenant's voice key.

## Scope / non-goals

- No wire change: host-internal credential selection for existing `ctx.callTranscriber`
  / `ctx.callSpeechSynthesizer` methods. No RFC needed.
- Per-agent voice credentials (ADR 0031) remain authoritative when set; this only adds
  a tenant-level fallback.

## Implementation

| Area | Change |
|---|---|
| `realtime/config.ts` | `walkieProviderCredential(config)` maps realtime provider→STT/TTS provider + reuses `credentialRef` |
| `voice/routes.ts` `/commit` | thread the credential into `callTranscriber` |
| `voice/routes.ts` `/speak` | fall back to the credential when agent/request name none |

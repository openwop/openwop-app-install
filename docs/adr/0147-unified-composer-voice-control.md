# ADR 0147 — Unified composer voice control

Status: implemented (Phases 1–4, 2026-06-25; deployed)

Owner: openwop-app frontend (chat composer)

Composes: ADR 0138 (live voice mode), ADR 0141 (realtime provider), RFC 0091
(multimodal `callAI` audio-in). Touches `chat/ChatInput`, `chat/ConversationView`,
`chat/voice/`.

RFC verdict: **none — frontend composer UI only; no wire, no capability change.**

## Context

The chat composer shipped **two** separate voice affordances:

- **Live conversation** — `VoiceModeButton` (a standalone "Voice" pill rendered
  *above* the composer via `ConversationView`'s `leadingControls`), gated on the
  `voice` toggle (ADR 0138). Realtime/walkie turn loop; transcribes to **text**,
  so it is **model-agnostic**. State lives in `useVoiceMode`/`useRealtimeVoice`.
- **Send audio** — the round mic *inside* `ChatInput` (`useAudioRecorder` → an
  audio-clip attachment to a **multimodal** model). Needs `supportsAudioInput`
  (`activeModel.audioInput`). It rendered even when the model can't accept audio,
  then failed on send.

Two problems: (1) the send-audio mic showed for models that don't support audio
input; (2) two voice controls in one composer is confusing — which mic does what?

## Decision

**One mic in the composer button row.** Clicking it:

- **both modes available → a `ui/Menu`** with *Live conversation* and *Send audio*
  (each with a one-line "what it does");
- **one available → the mic does that one directly** (no menu);
- **neither → the mic is not rendered** (this subsumes problem 1).

Availability — single source each: *Send audio* iff
`recorder.isSupported && supportsAudioInput !== false`; *Live conversation* iff
the `voice` feature resolves enabled (+ realtime probe).

**Active state lives on the mic icon itself** (user decision): a **clay** pulse
for an active live conversation, the existing **danger** pulse for clip
recording — the colour plus the placeholder/`aria-label` distinguishes them; no
separate chip or status strip.

### Seam (the architect call — keep `ChatInput` generic)

`ChatInput` is a generic, reused composer (main chat, `EmbeddedConversation`,
builder). It must **not** import the toggle-gated, lazy `chat/voice/` feature.
So:

- **`ChatInput` owns the unified mic + menu + its own `recorder`** (send-audio,
  unchanged) and gains one prop: `liveVoice?: { available; active; phase;
  onToggle }`. It imports no `chat/voice/`.
- **A headless `chat/voice/LiveVoiceController`** owns the realtime probe + the
  chosen variant hook (`useVoiceMode`/`useRealtimeVoice`) — only the selected
  hook mounts — and lifts `{available, active, phase, onToggle}` up via an
  `onState` callback. It renders no button (the old pill is gone); it still hosts
  the first-run realtime onboarding modal.
- **`ConversationView`** renders `LiveVoiceController` (headless, gated on the
  `voice` toggle) and passes the lifted `liveVoice` into `ChatInput`.
  `EmbeddedConversation` has no live voice → passes `liveVoice` undefined (mic =
  send-audio only, gated).

This is cheap because the voice **state already lives in hooks**, not in
`VoiceModeButton` (which was a thin `toggle()` shell, now deleted).

## Alternatives

- **`ChatInput` imports the voice feature** — rejected: couples the generic
  composer to a lazy toggle-gated feature + bundle cost.
- **Keep two controls, only gate the send-audio mic** — rejected: meets problem 1
  but not the "one control" goal.

## Phased plan

1. `LiveVoiceController` (extract probe+variant+state-lift from `VoiceModeButton`;
   delete `VoiceModeButton`).
2. `ChatInput`: `liveVoice` prop; unified mic (Menu / direct / hidden); gate
   send-audio on `supportsAudioInput`; clay `.is-live` pulse on active live.
3. `ConversationView` wiring; `EmbeddedConversation` passes nothing (already
   gated). i18n for the two menu items in en/es/fr/pt-BR.
4. Tests (gating matrix: none/send-only/live-only/both; active-pulse) + `/browser`
   light+dark.

## Open questions

1. **Phase granularity on the icon.** Listening vs Speaking both pulse clay; the
   placeholder carries the word. Finer per-phase icon states are a follow-up.
2. **Walkie vs realtime first-run onboarding** stays in the controller; no change
   to the ADR 0141 flow.

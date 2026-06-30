/**
 * Live voice mode (ADR 0138) — full-duplex spoken conversation on the ONE chat.
 *
 * P1 ships the backend product surface: the `voice` toggle, the `VoiceSession`
 * bootstrap + the host-internal live-audio transport (HTTP-chunked floor), and the
 * live `streamRef` → CORE `callTranscriber` path (which flips ADR 0109's honest
 * `transcription_unsupported` into a real `voice.*` turn for the wired transport).
 *
 * Boundary (ADR 0138 finding #1): the transcription itself lives in CORE
 * `aiProviders` (`callTranscriber` + the `StreamAudioResolver` seam); this feature
 * owns ONLY the product surface (session bootstrap + transport). It composes the
 * ONE chat (RFC 0005 / ADR 0073) — no new panel, no second chat.
 *
 * Tenant-bucketed, OFF by default (a shared B2B real-time-voice surface with a
 * continuous-ingress cost/abuse profile). Wired by appending to BACKEND_FEATURES
 * (features/index.ts) — zero core edits.
 *
 * @see docs/adr/0138-live-voice-mode.md
 */
import type { BackendFeature } from '../types.js';
import { registerVoiceRoutes } from './routes.js';
import { registerRealtimeRoutes } from './realtime/routes.js';
import { presentationEnabled } from '../../host/hostProfile.js';

export const voiceFeature: BackendFeature = {
  id: 'voice',
  // ADR 0168 — voice is the `realtimeVoice` CLIENT-PRESENTATION surface (browser mic
  // capture); its seams are left UNMOUNTED in OPENWOP_PROFILE=headless, co-gated with
  // the discovery advert (discovery.ts realtimeVoice). The `voice` toggle still gates
  // access at request time in `full`; headless removes the surface entirely.
  registerRoutes: (deps) => {
    if (!presentationEnabled('realtimeVoice')) return;
    registerVoiceRoutes(deps);
    registerRealtimeRoutes(deps);
  },
  toggleDefault: {
    id: 'voice',
    label: 'Voice mode',
    description:
      'Talk to the AI in a full-duplex spoken conversation on the existing chat: a live mic stream is transcribed in real time, the committed turn enters the conversation, and the agent speaks back (streaming TTS) with barge-in. Rides the ONE chat — no new panel or mic. OFF by default; tenant-bucketed (a continuous-ingress cost/abuse profile).',
    category: 'Business Tools',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'voice',
  },
  requiredPacks: [
    // The voice-tuned persona (ADR 0058 chat-drivability = agent + nodes). No NODE pack:
    // voice is ctx-method + transport plumbing, not workflow nodes (matrix row 4).
    { name: 'feature.voice.agents', version: '1.0.0' },
  ],
};
